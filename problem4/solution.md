# Problem 4 — Fix the Broken Platform

## The setup

Docker Compose stack: NGINX → Node.js API → PostgreSQL + Redis. Users are complaining the API is "unreliable and sometimes inaccessible." Let's look at the code and figure out what's wrong.

---

## What I found

### 1. NGINX is pointing at the wrong port

In `nginx/conf.d/default.conf`: line 9

```nginx
proxy_pass http://api:3001;
```

But the API actually listens on 3000 in file `api/src/index.js:35` 

```js
app.listen(3000, () => console.log("API running on 3000"));
```

So every API request hits port 3001 where nothing is listening → 502 Bad Gateway. This is the main reason the API is "inaccessible."

Fix: change to `proxy_pass http://api:3000;`

---

### 2. No restart policy

None of the services have `restart:` set. If anything crashes — OOM, unhandled exception, whatever — the container just stays dead. Nobody's bringing it back unless someone SSH's in and manually restarts it.

This is probably the "sometimes" part of "sometimes inaccessible." It works fine until something crashes, then it's gone.

From my experience writing K8s manifests, restart policies are one of the first things I check — Kubernetes handles this by default with `restartPolicy: Always` on pods, so you kind of take it for granted. But in Docker Compose there's no default, and I've been bitten by this more than once when troubleshooting local dev environments where a service just silently died and nobody noticed.

Fix: add `restart: unless-stopped` to all services.

---

### 3. `depends_on` without health checks

```yaml
api:
  depends_on:
    - postgres
    - redis
```

`depends_on` only waits for the container to *start*, not for the service to be *ready*. Postgres needs a few seconds to initialize before it accepts connections. Node.js boots in under a second. So the API comes up first, tries to connect to Postgres, and gets connection refused.

Fix: add health checks to Postgres and Redis, then use `condition: service_healthy`:

```yaml
postgres:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U postgres"]
    interval: 5s
    timeout: 3s
    retries: 5

api:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
```

---

### 4. Empty `nginx.conf`

The file `nginx/nginx.conf` is 0 bytes. It's not actively breaking anything because docker-compose only mounts the `conf.d/` directory, not the root config — so the default NGINX config from the image still works. But it's confusing. If someone later mounts this file thinking it has a real config, everything breaks silently.

Fix: either delete it or put a real config in it.

---

### 5. `init.sql` is never used

There's a `postgres/init.sql` with `ALTER SYSTEM SET max_connections = 20;` but it's never mounted into the container. Dead code.

Even if it were mounted, `ALTER SYSTEM SET` needs a Postgres restart to take effect — it wouldn't work as an init script. And 20 connections is way too low: the Node.js `pg` pool defaults to 10 connections, so one API instance grabs half the total.

If you want to tune this, pass it as a flag instead:

```yaml
postgres:
  command: ["postgres", "-c", "max_connections=100"]
```

---

### 6. Empty `.env`, hardcoded credentials

The `.env` file is empty. Credentials are hardcoded in docker-compose.yml and in the API code. Not a runtime issue, but not great either — should be using `.env` and keeping it out of git.

---

## Fixed files

### docker-compose.yml

```yaml
services:
  nginx:
    image: nginx:1.25
    ports:
      - "8080:80"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped

  api:
    build: ./api
    environment:
      - DB_HOST=postgres
      - REDIS_HOST=redis
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/status || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 3
    restart: unless-stopped

  postgres:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: postgres
    command: ["postgres", "-c", "max_connections=100"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
```

### NGINX config

```nginx
server {
    listen 80;

    location = / {
        return 200 "Welcome to the platform\n";
    }

    location /api/ {
        proxy_pass http://api:3000;
    }
}
```

---

## How I'd monitor this going forward

- Watch container restart counts — repeated restarts mean something's crashing
- Track NGINX 5xx rate — a spike means the upstream is down
- Keep an eye on Postgres connection usage — running out of connections is a common failure mode
- Set up a basic smoke test in CI/CD — a `curl` to the health endpoint after deploy would have caught the port mismatch on day one

## Time to handle this
`30-40 mins`
