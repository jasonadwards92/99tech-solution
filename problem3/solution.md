# Problem 3: Stabilize the platform

## What's going on

A Docker Compose stack runs NGINX in front of a Node.js API, which talks to PostgreSQL and Redis. Users say the API is "unreliable and sometimes inaccessible."

The upstream README calls this "Problem 4", but it sits in `src/problem3` of the challenge repo, so I've named it Problem 3.

I read the complaint as two separate problems. "Inaccessible" means one bug that fails every API call. "Sometimes" points to failures that only appear when something restarts. I reproduced each failure on the original code before fixing it, then ran the same tests against the fixed stack, on Docker 27.4 (Colima) with Compose 5.1. Where a result comes from reading code rather than a run, I say so.

## How I diagnosed it

1. Ran the stack unchanged with `docker compose up --build` and probed it with `curl`.
2. Read every file. The stack is small enough that reading it is faster than guessing.
3. Injected the faults a real host sees: restarting Postgres, stopping Redis, restarting NGINX while the API is down, and recreating the API container so it gets a new IP.

What the original stack returned:

| Probe | Result |
|---|---|
| `GET /` | `200 Welcome to the platform` |
| `GET /api/users` | `502 Bad Gateway`, every time |
| `GET /api/users` from inside the API container (port 3000) | `200`, so the API itself works |

## What I found

### 1. NGINX proxies to the wrong port

`nginx/conf.d/default.conf` has `proxy_pass http://api:3001;`, but `api/src/index.js` listens on `3000`. Nothing listens on 3001, so every `/api/` request gets a `502`. This is the "inaccessible" part, and on its own it makes the API unusable from outside.

### 2. A Postgres restart kills the API, and nothing brings it back

This is the main cause of "sometimes". `pg.Pool` keeps idle connections open for 10 seconds after each request. When Postgres restarts for any reason (a crash, an upgrade, a host reboot), it terminates those connections and the pool emits an `error` event. The code has no listener for it, so Node treats it as an unhandled `error` event and the process exits:

```
error: terminating connection due to administrator command
Emitted 'error' event on BoundPool instance at:
```

I sent one request, then ran `docker restart postgres`. Four seconds later the API container was `Exited (1)`.

No service has a `restart:` policy, so the API stays down until someone notices. Users see exactly the pattern they describe: it works for a while, then it's gone.

### 3. NGINX can't start while the API is down

NGINX resolves `api` once, at startup. If the API container is stopped (after bug 2, for example), any NGINX restart fails:

```
nginx: [emerg] host not found in upstream "api" in /etc/nginx/conf.d/default.conf:9
```

One crashed backend therefore takes down the whole front door, including `/`, which never touches the API.

### 4. NGINX keeps sending traffic to the API's old IP

A running NGINX also keeps the IP it resolved at startup. When the API container is recreated, by `docker compose up --build` or a deploy, it can come back on a new address and NGINX keeps sending traffic to the old one. I tested this with a control container using the original static `proxy_pass`. After the API moved from `172.20.0.6` to `172.20.0.8`, the static config returned `502 (Connection refused)` and the fixed config returned `200`.

### 5. A failed query leaks a database connection

```js
const db = await pool.connect();
const result = await db.query("SELECT NOW()");
db.release();
```

If `db.query` throws, `release()` never runs and the pool loses that connection for good. After 10 such errors (the pool's default `max`) the pool is empty, and because `connectionTimeoutMillis` defaults to waiting forever, every later request hangs. I found this by reading the code and didn't reproduce it, since `SELECT NOW()` rarely fails by itself. Any query error under load would trigger it.

### 6. Redis is a hard dependency for a bookkeeping write

The endpoint awaits `redis.set("last_call", ...)`, which only records when the API was last called. If Redis is down, a database read that worked still comes back as a 500. That write shouldn't decide whether the request succeeds.

### 7. Startup ordering is unchecked

`depends_on` without a condition waits for a container to start, not for Postgres or Redis to accept connections. The API mostly gets away with it, because `pg` connects lazily and `ioredis` retries, but early requests can fail. With no healthchecks, neither Compose nor a person can tell whether a service is actually working.

### 8. Smaller problems

- `postgres/init.sql` (`ALTER SYSTEM SET max_connections = 20`) is never mounted, so it does nothing. If someone did mount it, it would take effect. I tested this: `SHOW max_connections` returned `20`, because the image's entrypoint restarts Postgres after running init scripts. Twenty is too low once two or three API instances each hold a pool of 10. I removed the file and set `max_connections=100` on the command line, where it's visible.
- `nginx/nginx.conf` is an empty file that's never mounted. It's harmless now, but whoever mounts it later gets a broken NGINX. Removed.
- Postgres has no volume, so `docker compose down` wipes the database.
- The API image runs as root and installs with `npm install` without a lockfile, so two builds can resolve different versions.
- `node` runs as PID 1. With no `SIGTERM` handler it ignores the signal, so every `docker stop` waits the full 10 seconds and ends in `SIGKILL`.
- Database credentials are hardcoded in both `docker-compose.yml` and `index.js`, and `.env` is empty.
- `version: "3.9"` is obsolete, and Compose warns about it.

## The fixes

| File | Change | Fixes |
|---|---|---|
| `nginx/conf.d/default.conf` | `proxy_pass` points at port `3000` | 1 |
| `nginx/conf.d/default.conf` | `resolver 127.0.0.11 valid=10s` with `proxy_pass $api_upstream`, so `api` is resolved per request | 3, 4 |
| `api/src/index.js` | `pool.on("error")` and `redis.on("error")` listeners | 2 |
| `api/src/index.js` | `pool.query()` replaces manual `connect`/`release` and returns the client even on error | 5 |
| `api/src/index.js` | `connectionTimeoutMillis: 2000` for the pool wait, and `statement_timeout`/`query_timeout` of 5s, under NGINX's 10s read timeout | 5 |
| `api/src/index.js` | The Redis write is fire-and-forget with its own error log, and Redis uses `maxRetriesPerRequest: 1` | 6 |
| `docker-compose.yml` | `restart: unless-stopped` on every service | 2 |
| `docker-compose.yml` | Healthchecks (`pg_isready -h 127.0.0.1`, `redis-cli ping`, `/status`, `/healthz`) and `depends_on: condition: service_healthy` for the API | 7 |
| `docker-compose.yml` | `init: true` on the API, a `pgdata` volume, `max_connections=100`, password from `${POSTGRES_PASSWORD}`, no `version:` | 8 |
| `api/src/index.js` | `SIGTERM`/`SIGINT` handler that drains the HTTP server and closes both clients; credentials come from env | 8 |
| `api/Dockerfile` | Pinned pnpm, `pnpm-lock.yaml` with `--frozen-lockfile --prod`, the pnpm store in a build cache mount, `NODE_ENV=production`, `USER node`, and a `.dockerignore` | 8 |
| `nginx/conf.d/default.conf` | Hardening: forwarding headers, `X-Request-ID` passed to the API and written to the access log, 2s connect and 10s read timeouts, and a `/healthz` route that doesn't touch the API | general |
| removed | `nginx/nginx.conf`, `postgres/init.sql`, and the empty `.env` (replaced by `.env.example`; `.env` is gitignored) | 8 |

Some notes on the choices:

- NGINX keeps a plain `depends_on: api` for start order and doesn't wait for the API to be healthy. With per-request DNS it can start on its own, so `/` stays up while the API is down and `/api/` returns `502` until the API is back. After the API moves to a new IP, there can be up to 10 seconds of 502s while the cached address expires (`valid=10s`).
- `pg_isready` checks `127.0.0.1` on purpose. On first boot the image runs a temporary server that only listens on the Unix socket, and a socket check would mark Postgres healthy before the API can reach it over TCP.
- `init: true` puts tini in front of `node` to forward signals and reap zombies. The graceful drain itself is the handler in `index.js`.
- The port is hard-coded as `3000` in `index.js`, the healthcheck and the NGINX upstream. I kept it as one constant and didn't add a `PORT` variable that would only change one of the three.
- The password falls back to `postgres` when `.env` is missing, so `docker compose up --build` from the README works with no setup. That default is for local use only. Postgres reads `POSTGRES_PASSWORD` only when the `pgdata` volume is first created. If you set or change it afterwards, the API gets the new password and Postgres keeps the old one, so `/api/users` fails with `password authentication failed`. Run `docker compose down -v` to reinitialise (this deletes the data) or change it with `ALTER USER`. `.env.example` says the same.

## Verification

Results from the same fault injection on both stacks:

| Test | Original | Fixed |
|---|---|---|
| `GET /api/users` | `502` | `200` |
| Restart Postgres with an idle pooled client | API exits with `Exited (1)` and stays down | API stays up (`restarts=0`), next request `200` |
| Stop Redis, then call the API | not reachable (502) | `200` in 0.06s, the failed Redis write only logged |
| Stop the API, then restart NGINX | NGINX exits with `[emerg] host not found` | NGINX up, `/` = `200`, `/api/users` = `502`, then `200` once the API starts |
| Recreate the API on a new IP | static `proxy_pass`: `502` | `200` |
| API process dies (`pkill -9 node` inside the container) | not run; after the crash in row 2 it stayed down because there is no restart policy | restarted automatically (`restarts=1`), `200` |
| `docker stop api` | about 10s, ends in `SIGKILL` (by design of PID 1, not timed) | 0.1s, logs `SIGTERM received, shutting down` |
| Query that runs past 5s (`SELECT pg_sleep(7)` with the API's pool settings) | no timeout in the original | `canceling statement due to statement timeout` |

On the original, `pkill -9 node` would not have worked as a test: node is PID 1 there, and the kernel ignores signals sent to a namespace's PID 1 from inside that namespace. Row 2 already shows the original API dying and staying dead.

`docker compose up -d --build --wait` reports all four services `Healthy`, `docker compose config -q` passes with no warnings, and the NGINX access log carries a request ID (`rid=387bc033...`) on each line.

## Monitoring and alerts I'd add

| Signal | Alert when | Why |
|---|---|---|
| Container restart count and health status (cAdvisor or Docker events) | More than 3 restarts in 10 minutes, or any service `unhealthy` for 2 minutes | `restart:` hides crash loops. Bug 2 would loop silently |
| NGINX 5xx rate and upstream response time (from the access log, which now includes `urt=`) | 5xx above 1% for 5 minutes, or p95 upstream time above 1s | Bug 1 is a 100% 502 rate, so this pages within minutes |
| External synthetic check on `/api/users` every 30s | 2 failures in a row | Measures what users see, including NGINX and DNS |
| API process: event-loop lag, uncaught errors, pool `waitingCount` | Pool waiting above 0 for 1 minute | A leak like bug 5 shows up here long before requests hang |
| Postgres: `numbackends` against `max_connections`, and restarts | Connections above 80% of max | Catches pool exhaustion and the `max_connections=20` trap |
| Redis: up, memory, rejected connections | Down for 1 minute | The endpoint survives a Redis outage now, so nobody would notice it otherwise |

Logs from all four containers go to one place (Loki or CloudWatch). The request ID is in NGINX's access log and passed to the API as `X-Request-ID`, so a 502 can be traced to the API log line behind it.

## Preventing this in production

- Run a smoke test after every deploy. A `curl -f` on `/api/users` through NGINX, run in CI against the composed stack, would have caught bug 1 before it shipped. Bugs 2 to 4 fit in a short chaos step in the same job: restart Postgres, recreate the API, and check that the endpoint still returns `200`.
- Add review rules for every new service: a healthcheck, a restart policy, a `depends_on` condition, and an error listener on every client that emits `error`. They take a minute to check in review and hours to find in an outage.
- Check code that holds resources. Use `pool.query` or `try/finally` around `release()`, and set timeouts on every client. A lint rule or a short code-owner checklist covers most of it.
- Keep secrets in a secret store (Docker secrets, SSM or Vault). The local `postgres` default never reaches a shared environment, and `.env` stays out of git.
- Move off single-host Compose. In production I'd run at least two API replicas behind a load balancer that health-checks them (ECS, or Kubernetes with readiness probes), use managed Postgres and Redis with automatic failover, and size `max_connections` as replicas × pool size plus headroom, or put PgBouncer in front.
- Pin images by digest and rebuild on a schedule, so a patched base image arrives as a deliberate change.
