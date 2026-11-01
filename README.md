# 99Tech DevOps Challenge

## About me

I'm Thi Dinh, a Senior Platform Engineer with 5+ years in cloud infrastructure and DevOps. Day to day I build and run Kubernetes clusters, CI/CD pipelines and cloud platforms on AWS and Azure.

I'm currently at GFG Group. Before that I was an SRE at GFT Group, running 40+ Kubernetes clusters for a digital bank in Singapore, and before that I held DevOps roles at Manabie and Dai-ichi Life Vietnam.

Work I've done that relates to these challenges:
- Migrated CI/CD setups across different platforms (CircleCI to Harness, legacy Jenkins/scripts to GitHub Actions)
- Rolled out Karpenter on EKS, which trimmed our EC2 bill by about 30%
- Maintained Helm charts and Terraform modules for large microservice environments
- Took part in on-call and incident response under a <4h downtime SLA

Certifications: CKA, CKS, AWS SAA-C03, Terraform Associate

## Solutions

### Problem 1: Building Castle In The Cloud

A highly available, low-latency crypto trading platform on AWS for 500 RPS with p99 under 100 ms.

- Three stateless services on EKS across 3 AZs, Aurora PostgreSQL as the source of truth and sequenced order log, and Valkey for order book snapshots and price fan-out.
- A single-threaded matching engine per trading pair with a hot standby in a second AZ. Leadership uses a Kubernetes Lease, and the database rejects writes from a stale primary.
- About 8-22 ms server-side p99 for placing an order, and roughly $3,900/month at a constant 500 RPS.
- A warm-standby DR region (RPO ~1 s, RTO ~15-30 min), and a roadmap to 10× and 100× that brings in Kafka only when the Postgres design hits its limit.

[Click here for more solution details](problem1/solution.md)

### Problem 2: Diagnose Me Doctor

A runbook for an Ubuntu 24.04 NGINX load balancer whose 64GB disk is at 99%.

- Free a little space first so traffic stops failing, then find the cause with `df`, `du` and `lsof +L1`.
- The five usual causes: unrotated logs, deleted logs NGINX still holds open, an uncapped proxy cache, OS leftovers, and Ubuntu's LVM installer giving root only half the disk. Each comes with a no-downtime fix and a permanent fix.
- Prevention: size-based hourly log rotation, journald and cache caps, and disk alerts at 80% and 90% plus a trend alert.

[Click here for more solution details](problem2/solution.md)

### Problem 3: Stabilize the platform

A Docker Compose stack (NGINX, Node.js API, PostgreSQL, Redis) whose API is "unreliable and sometimes inaccessible".

- Every API call returned 502 because NGINX proxied to port 3001 while the API listens on 3000.
- A Postgres restart crashed the API through an unhandled `pg` pool error, and with no restart policy it stayed down. NGINX also couldn't start, or kept the old IP, whenever the API container was down or recreated.
- Fixed and re-tested by injecting the same faults: error handlers and timeouts in the API, restart policies and healthchecks in Compose, and per-request DNS in NGINX. Includes the monitoring and production guardrails I'd add.

[Click here for more solution details](problem3/solution.md)

### Problem 4: Ship It Twice

GitHub Actions CI/CD for a backend API on EKS (EC2 nodes) and a frontend SPA on S3 + CloudFront.

- Build once, promote the same artifact: CI checks every pull request, and CD deploys to staging, runs a smoke test, waits for a human approval, then releases the same image or bundle to production.
- The backend ships with Helm and rolls back automatically if the smoke test fails. The frontend uploads assets in an order that never serves a broken page, then invalidates CloudFront.
- AWS access through OIDC with no stored keys, actions pinned to commit SHAs, and least-privilege permissions on every job.

[Click here for more solution details](problem4/SOLUTION.md)

### Problem 5: Fortify The Castle

Security hardening for the Problem 1 trading platform.

- A threat model ranked by what an exchange stands to lose, with controls built into each step of the request path.
- Withdrawals are signed in an isolated custody account with velocity caps, and most funds stay in cold storage. The ledger is append-only with a signed hash chain, and nobody has standing write access to production.
- What must be done before launch, what follows in the first 30-90 days, and the risks I accept, while the security work adds under 1 ms to the latency budget.

[Click here for more solution details](problem5/SOLUTION.md)
