# Problem 4: Ship it twice

This is a production-grade CI/CD design in GitHub Actions for two services: a backend API deployed to EC2-backed Kubernetes (EKS) and a frontend single-page app (SPA) hosted on S3 + CloudFront. The workflows and the Helm chart are validated with `actionlint` and `helm lint`.

The main rule is **build once, promote the exact same artifact.** CI checks every pull request. When a PR merges to `main`, CD builds the artifact once, deploys it to staging, runs a smoke test, pauses for a human approval in GitHub, and then rolls that same artifact out to production.

I kept the deployment commands in the workflow YAML files instead of wrapper bash scripts. When a deployment fails, you can read the exact command and flags in the GitHub Actions log without jumping between files.

```text
.github/
├── workflows/
│   ├── ci-backend.yml     PR checks: lint, unit tests, pnpm audit, Docker build test, Helm lint
│   ├── ci-frontend.yml    PR checks: lint, unit tests, pnpm audit, production build check
│   ├── cd-backend.yml     Main branch: build & push to ECR → deploy staging → [approval] → deploy prod
│   └── cd-frontend.yml    Main branch: build SPA once → sync staging S3/CF → [approval] → sync prod S3/CF
└── CODEOWNERS
backend/
├── Dockerfile             Multi-stage Node 24 Alpine build, runs as non-root user
└── chart/                 Helm chart: Deployment, Service, ALB Ingress, PDB, ServiceAccount (IRSA)
    ├── values.yaml
    ├── values-staging.yaml
    └── values-production.yaml
frontend/
└── README.md              The contract the frontend workflows expect from the SPA
```

GitHub only loads `.github/` from the root of a repository, so these workflows and `CODEOWNERS` do not run from inside `problem4/`. To use them, copy the contents of `problem4/` to the root of a repo. The app source is out of scope, so CI only goes green once `backend/` and `frontend/` each contain the app's `package.json` and `pnpm-lock.yaml`.

## Assumptions and architectural choices

I wrote the pipelines without a live AWS environment, so these are the assumptions I made and the reasons for them:

- **"Deployed to EC2" means EKS on EC2 worker nodes:** The prompt mentions deploying the backend to EC2. I targeted Amazon EKS backed by EC2 nodes so it matches the platform I designed in Problem 1 and gives native rolling updates, readiness gates, PodDisruptionBudgets, and `helm upgrade --atomic` auto-rollbacks. On plain EC2 without Kubernetes, only the `deploy-*` jobs would change (to CodeDeploy on an Auto Scaling Group).
- **Standard Node/pnpm scripts:** Both `backend/` and `frontend/` are assumed to use `pnpm` with standard `lint`, `test`, and `build` scripts in `package.json`, and a committed `pnpm-lock.yaml`. The backend `Dockerfile` expects `pnpm run build` to produce `dist/server.js`, and the server to listen on port 3000 (`PORT` is set to 3000 in the image). The frontend contract is in [`frontend/README.md`](frontend/README.md).
- **Versioned `/healthz` endpoint on the backend:** The Helm chart injects the Docker image tag (the Git commit SHA) into the pod as `APP_VERSION`. The backend exposes `GET /healthz` returning `{"version":"<commit-sha>"}`. The post-deploy smoke test uses it to check that the new commit is the one answering live traffic through the ALB.
- **Runtime config for the frontend (`/config.json`):** Baking `VITE_API_URL` into the bundle at build time would mean rebuilding the app separately for staging and production, which breaks the "build once, promote everywhere" rule. Instead, the SPA loads `/config.json` on startup. The `build` job builds the static bundle once, and each environment's deploy job writes a small `config.json` (`{"apiUrl": "...", "version": "<sha>"}`) to S3 right before updating `index.html`.
- **Three-account AWS setup with GitHub OIDC:** I assumed the standard multi-account layout: a tooling account (which hosts the shared ECR repository), a staging account, and a production account. There are **zero static AWS access keys** in GitHub Secrets. Every job uses GitHub's OIDC provider (`aws-actions/configure-aws-credentials`) to assume a short-lived IAM role. The deploy jobs run in a GitHub Environment, so each deploy role's trust policy matches `environment:staging` or `environment:production`. The backend `build` job has no environment, so the build role's trust policy matches `ref:refs/heads/main` instead.
- **Least-privilege cluster access:** The CI/CD deploy roles use EKS Access Entries scoped to the `backend` namespace, so the pipeline can deploy the app but can't touch cluster-wide resources. The backend pods use IRSA (IAM Roles for Service Accounts), defined per environment in `values-<env>.yaml`, to read their own secrets.
- **ALB rollouts with no dropped requests:** I assumed the `backend` namespace has the AWS Load Balancer Controller label `elbv2.k8s.aws/pod-readiness-gate-inject: enabled`. That injects a readiness gate into every pod, so Kubernetes won't terminate old pods during a deploy until the ALB has registered the new pods and marked them healthy. On the way out, ALB deregistration and the pod's SIGTERM happen at the same time, so the chart adds a 15 second `preStop` sleep (with a 45 second termination grace period and a 30 second ALB deregistration delay) to let the ALB stop routing to the pod before the app shuts down.

GitHub repo settings these workflows rely on:
- **GitHub Environments (`staging` and `production`):** Both allow deployments only from the `main` branch, and `production` has required reviewers enabled. That is what pauses `cd-backend.yml` and `cd-frontend.yml` between staging and prod.
- **Branch protection on `main`:** Requires PR reviews (enforced via `CODEOWNERS`), requires the branch to be up to date before merging, and requires the `ci-backend` and `ci-frontend` status checks to pass. Those are aggregator jobs, one at the end of each CI workflow, that fail unless every other job in that workflow succeeded. A required check matches a job name, and both workflows have a job called `test`, so one uniquely named aggregator per workflow gives branch protection a single stable check per service that doesn't change when jobs are added.
- **GitHub variables (not secrets, none of these are sensitive):**

  | Variable | Scope | Used for |
  |---|---|---|
  | `AWS_REGION` | Repository | Region for every AWS call |
  | `AWS_BUILD_ROLE_ARN` | Repository | Build role in the tooling account (backend `build` job) |
  | `ECR_REPOSITORY` | Repository | ECR repository URI the image is pushed to and deployed from |
  | `AWS_DEPLOY_ROLE_ARN` | Per environment | Deploy role in the staging or production account, used by both CD workflows |
  | `EKS_CLUSTER` | Per environment | EKS cluster name for `aws eks update-kubeconfig` |
  | `API_URL` | Per environment | Backend URL for the `/healthz` smoke test and the frontend's `config.json` |
  | `SITE_BUCKET` | Per environment | S3 bucket that hosts the SPA |
  | `DISTRIBUTION_ID` | Per environment | CloudFront distribution to invalidate |
  | `SITE_URL` | Per environment | Public SPA URL for the frontend smoke test |

## How the pipelines work

### 1. Pull request CI ([`ci-backend.yml`](.github/workflows/ci-backend.yml) & [`ci-frontend.yml`](.github/workflows/ci-frontend.yml))
These run on every PR targeting `main`.
- **No path filters.** Adding `paths: ['backend/**']` to `ci-backend.yml` looks reasonable, but it hits a known GitHub Actions trap. If a job is a required status check in branch protection and a frontend-only PR skips the backend workflow, GitHub leaves the backend check pending with "Waiting for status to be reported" forever, and the PR can't merge. Running these fast, cached checks on every PR avoids that.
- Backend CI runs three jobs in parallel, then the `ci-backend` aggregator:
  1. `test`: Runs `pnpm run lint`, `pnpm test`, and `pnpm audit --prod --audit-level high`, which audits only the dependencies that ship in the image.
  2. `image`: Builds the production Docker image (using GitHub Actions cache `type=gha`) without pushing it, which proves the `Dockerfile` works before merge.
  3. `chart`: Runs `helm lint --strict` against both `values-staging.yaml` and `values-production.yaml`. Lint renders the templates, so it catches template and values typos early.
- Frontend CI runs `pnpm run lint`, `pnpm test`, `pnpm audit --prod --audit-level high` (again only the shipped dependencies), and `pnpm run build`, then the `ci-frontend` aggregator.
- Both workflows use `concurrency` with `cancel-in-progress: true`, so pushing a new commit to a PR cancels the outdated CI run.

### 2. Backend CD ([`cd-backend.yml`](.github/workflows/cd-backend.yml))

```text
push to main
   │
   ▼
build ──────────── Assumes tooling role via OIDC
   │               Builds Docker image & pushes to ECR tagged with :<git-sha>
   ▼
deploy-staging ─── Assumes staging role via OIDC
   │               Runs `helm upgrade --install --atomic --wait` with values-staging.yaml
   │               Hits https://<staging-url>/healthz and verifies version == <git-sha>
   ▼
[ GitHub Environment Approval Gate ]
   ▼
deploy-production ─ Assumes production role via OIDC
                    Runs the exact same Helm rollout & smoke test against production
```

Two things keep production deploys safe:
- **Automatic rollback on bad deploys:** `helm upgrade --atomic --wait --timeout 10m` watches the rollout. If the new pods crash-loop or fail their readiness probes, Helm rolls back to the previous working release. If the pods start healthy, the workflow then curls `/healthz` with several retries, and if the smoke test doesn't return the new commit SHA, the next step runs `helm rollback backend --namespace backend --wait` automatically.
- **Safe pod replacement:** [`deployment.yaml`](backend/chart/templates/deployment.yaml) sets `maxUnavailable: 0` and `maxSurge: 1`, with topology spread constraints across AZs and a `preStop` sleep. Together with the readiness gate from the namespace label, Kubernetes never terminates an old pod until the new pod is registered and healthy in the ALB target group.

### 3. Frontend CD ([`cd-frontend.yml`](.github/workflows/cd-frontend.yml))

```text
push to main → build SPA once (upload artifact) → deploy-staging → [approval] → deploy-production
```

To deploy the SPA to S3 + CloudFront without briefly broken pages for active users, the files go up in this order:

1. **Upload hashed assets (`dist/assets/`) first, without `--delete`.** Vite/Webpack outputs JS and CSS files with content hashes in their filenames (e.g., `main.8f3a1c.js`). We sync these to `s3://<bucket>/assets/` with `Cache-Control: public, max-age=31536000, immutable` and leave old asset files in place. If a user already has the site open and clicks a lazy-loaded route right as we deploy, their browser still asks for the old chunk, and keeping old chunks in S3 prevents `404` errors during deploys.
2. **Upload unhashed root static files** (`favicon.ico`, `robots.txt`, etc.) with `Cache-Control: no-cache`.
3. **Generate and upload `/config.json`** containing that environment's `API_URL` and the new commit SHA, with `Cache-Control: no-cache`.
4. **Upload `index.html` last**, also with `Cache-Control: no-cache`. The new JS/CSS assets and `config.json` are already in S3, so the release goes live atomically the moment `index.html` lands. `no-cache` makes browsers revalidate with the ETag on every load (a cheap `304` when nothing changed), and the CloudFront invalidation below drops the old edge copy, so users get the new release without a hard refresh.
5. **Invalidate CloudFront** on `/index.html` and `/config.json` and wait for the invalidation to complete. The smoke test then checks that `/` returns `200` and that `/config.json` reports the new commit SHA.

### 4. How rollbacks work
- **Automatic (backend):** Handled in the pipeline by `helm --atomic` and the `helm rollback` step after the post-deploy smoke test.
- **Fast manual rollback (within 30 days):** Open the Actions tab, click an earlier green workflow run, and click **Re-run job** on just the `deploy-production` job. Don't click "Re-run all jobs": ECR tags are immutable, so rebuilding the same commit SHA would fail on push. Because the ECR image is immutable and the frontend build artifact is retained for 30 days, re-running `deploy-production` re-promotes that exact build.
- **Standard Git rollback (anytime):** Run `git revert <bad-sha>` and merge to `main`. It flows through the normal build → staging → prod pipeline.

### 5. Pipeline security and concurrency
- **Hardened GitHub Actions:** Every workflow starts with top-level `permissions: {}` (a read-nothing default) and grants `id-token: write` and `contents: read` only on the jobs that need them. Every third-party action (`actions/checkout`, `aws-actions/configure-aws-credentials`, `docker/build-push-action`, etc.) is pinned to a full 40-character commit SHA rather than a mutable tag like `@v4`, which protects against supply-chain tag hijacking such as the `tj-actions` incident. `actions/checkout` also sets `persist-credentials: false`.
- **Per-environment concurrency groups:** In the CD workflows, each environment has its own concurrency group (`cd-backend-staging` vs `cd-backend-production`) with `cancel-in-progress: false`. A Helm upgrade or S3 sync should never be cancelled halfway through, and scoping the lock per environment means a production deploy waiting for manager approval won't block a newer commit from deploying to staging. If a newer production deployment is already waiting, the approver should reject the older pending one rather than ship a stale build.

## What I left out on purpose

To keep the scope focused, I skipped a few things that belong in surrounding repos or later maturity stages:

- **Application source code and Terraform infra code:** The prompt is about the CI/CD pipelines, so I wrote the workflows, `Dockerfile`, `CODEOWNERS`, and Helm chart, and assumed the app code and Terraform-managed AWS resources (VPC, EKS, ECR, S3, CloudFront, OIDC roles) already exist.
- **GitOps (Argo CD):** In Problem 1 I used Argo CD for the multi-service EKS platform. Here I used direct `helm upgrade --atomic` inside GitHub Actions, so deployment, health check, and rollback are all visible in one self-contained workflow with no second GitOps manifest repo.
- **Image signing (`cosign`) and E2E browser tests (Playwright):** These slot in after the `build` and `deploy-staging` jobs once a team is ready for them.
- **S3 old-asset garbage collection:** Old hashed JS/CSS chunks stay in S3 so open browser tabs don't break, but a naive S3 lifecycle rule could delete chunks that the currently live `index.html` still references (for example, if nobody deploys for 60 days). Cleaning them up safely needs a small script that parses the active `index.html` manifests first.

## Validating the code

Without a live AWS account, I validated all the YAML, expressions, and Helm templates locally with `actionlint` and `helm lint --strict`:

```bash
# 1. Lint all four GitHub Actions workflows for syntax, expression types, and runner rules
actionlint .github/workflows/*.yml

# 2. Strictly lint the Helm chart (which renders it) against both staging and production values,
#    with the same command ci-backend.yml runs
for env in staging production; do
  helm lint backend/chart --strict \
    --values "backend/chart/values-${env}.yaml" \
    --set image.repository=example/backend --set image.tag=ci
done
```

Both pass with zero warnings or errors. I also checked every pinned action SHA against its upstream release tag.
