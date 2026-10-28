# Problem 2 — Trading System Architecture

## What I'm building

Obviously I can't redesign all of Binance in one doc, so I picked the features that matter most for showing how I'd handle scale, availability, and low latency:

1. **Order placement & matching** — buy/sell, limit and market orders
2. **Real-time market data** — live price tickers and order book streamed over WebSocket
3. **Auth & wallet** — user login and balance tracking
4. **Trade history** — recording every completed trade

These hit the critical path of any real trading platform and give me enough surface area to talk about the interesting infrastructure decisions.

---

## Architecture Overview

https://excalidraw.com/#json=l2PO8jOp9aLYwSyXGhGus,fp0v9rGlhoBtl13Am8cIwA
 
---

## How the pieces fit together

### Compute — EKS across 2 AZs

Everything runs on **EKS**. The team's already comfortable with Kubernetes, and honestly the ecosystem is hard to beat — we get KEDA, Argo Rollouts, cert-manager, external-dns all for free.

The services themselves:

- **Auth Service** — login, JWT tokens, account stuff
- **Order Service** — validates incoming orders, hands them to the matching engine, updates balances
- **WebSocket Service** — keeps persistent connections open and pushes price/orderbook updates to clients
- **Trade History Consumer** — pulls matched trades off RabbitMQ and writes them to the database

**Why EKS?** EKS gives us more control over scheduling, health checks, and deployment strategies (canary, blue-green via Argo Rollouts, etc.). We also get a rich ecosystem — KEDA for event-driven autoscaling, cert-manager for TLS, external-dns, and so on. The operational overhead is higher than ECS, but the flexibility pays off as the system grows.

**Node groups:** Using managed node groups with a mix of on-demand (for the order service / matching engine) and spot instances (for less critical workloads like trade history consumers). Karpenter can be added later for smarter node provisioning.

### Autoscaling — KEDA

This is one of my favorite parts of the design. Instead of just scaling on CPU (which is what plain HPA does), **KEDA** lets us scale based on what actually matters — like how many messages are sitting in the RabbitMQ queue.

- Trade History Consumer scales up when messages pile up, and scales back to zero when the queue is empty (saves money overnight or off-peak hours)
- The API-facing services (Auth, Order) still use regular HPA on CPU — that makes sense for request-driven workloads

The key insight: for a consumer, high CPU doesn't necessarily mean you need more pods. An empty queue with high CPU means something's wrong. A full queue with low CPU means you need more pods. KEDA gets this right.

### Load Balancing — ALB

**ALB** via the AWS Load Balancer Controller. It handles both REST and WebSocket natively, and Kubernetes Ingress resources map to target groups automatically — so there's very little glue to maintain.

I considered API Gateway for the built-in throttling and API keys, but the extra 10-30ms of latency is a dealbreaker when our entire p99 budget is 100ms. ALB is more predictable here.

### In-Memory Store — ElastiCache Redis (cluster mode, multi-AZ)

Redis does the heavy lifting for anything latency-sensitive:

- **Order book** — stored as sorted sets. Reads come back in under a millisecond, which is the only way we hit that p99 < 100ms target
- **Session cache** — we cache JWT validation results so we're not hammering Aurora on every single request
- **Rate limiting** — sliding window counters per user, all in-memory

Why not Memcached? We need sorted sets for the order book, and Memcached doesn't have those. Redis also gives us pub/sub, which the WebSocket service subscribes to for pushing live price updates to clients.

### Database — Aurora PostgreSQL

The source of truth lives here:
- User accounts and wallet balances
- Order records
- Trade history

Running Multi-AZ with one read replica. At 500 RPS, most of the hot reads are served by Redis anyway, so Aurora is mainly handling writes and the occasional background query.

**Why Aurora instead of plain RDS?** Faster failover (~30s vs ~60s), automatic storage replication across 3 AZs, and read replicas share the same storage volume — which means zero replication lag on reads. For a trading platform, that matters.

**Why not DynamoDB?** Trading involves multi-table transactions — deducting from the buyer's wallet, crediting the seller, updating the order status, all atomically. PostgreSQL's ACID transactions handle this cleanly. Trying to coordinate this with DynamoDB's conditional writes would be painful and error-prone.

### Message Broker — RabbitMQ (via Amazon MQ)

When a trade gets matched, the Order Service drops an event onto RabbitMQ. From there, consumers pick it up asynchronously to:
- Write the trade to the history table
- Update market data aggregations (OHLCV candles)
- Fire off notifications

**Why not SQS?** RabbitMQ's exchange types (direct, topic, fanout) let us route events to different consumers based on type — one trade event can fan out to multiple consumers without duplicating messages. Plus it plays nicely with KEDA for autoscaling.

**Why not Kafka?** At 500 RPS, Kafka is way overkill. We don't need a distributed commit log — we need reliable delivery and flexible routing. MSK's minimum 3-broker setup is also more expensive than we need at this scale. (That said, if we grow to 50k+ RPS, Kafka becomes the right call — more on that in the scaling section.)

**Why managed (Amazon MQ)?** Running RabbitMQ yourself in Kubernetes is totally doable, but you're now on the hook for clustering, storage, and failover. Amazon MQ handles all of that and gives us multi-AZ out of the box.

**Vendor lock-in note:** Amazon MQ ties us to AWS. If cloud portability matters, two alternatives worth considering:

- **CloudAMQP** — a RabbitMQ-specialized PaaS that runs on AWS, GCP, and Azure. Dedicated plans support VPC peering for low-latency access. Maintained by core RabbitMQ contributors, so the operational quality is high. This is the lowest-friction starting point if we want to avoid AWS lock-in.
- **Self-hosted on EKS** — the [RabbitMQ Cluster Operator](https://www.rabbitmq.com/kubernetes/operator/operator-overview) handles peer discovery, rolling upgrades, and TLS. Same Kubernetes manifests work on GKE or AKS if we migrate clouds later.

Since both options use standard AMQP, switching between them is straightforward — update the connection string and credentials, no application code changes. A pragmatic path: start with CloudAMQP to avoid operational overhead early on, then move to self-hosted if we need deeper control or want to cut costs at scale.

### DNS & CDN

- **Route 53** for DNS with health checks and failover routing
- **CloudFront** in front of S3 for serving the frontend SPA and static assets

Nothing fancy here — these are standard picks.

### Monitoring

Two layers:

- **Prometheus + Grafana** inside EKS for pod-level metrics — request latency, error rates, queue depths. This is where we spend most of our time debugging.  

- **CloudWatch** for the managed services (Aurora, ElastiCache, Amazon MQ, ALB) plus alarms → SNS → on-call notifications. 

- For enterprise level, we could also consider about other monitoring solutions like Datadog, Sumologic, New Relic, etc... - These solutions provide more features like APM, log management that can help us more in troubelshooting and debuging. 

KEDA scaling events show up in Grafana alongside queue depth, so we can see exactly why a consumer scaled up and whether it helped.

---

## Keeping things alive

| What can go wrong | How we handle it |
|---|---|
| **An entire AZ goes down** | EKS nodes are spread across 2 AZs with pod anti-affinity rules, so replicas never land on the same node. Aurora and Redis are both Multi-AZ. |
| **A pod crashes** | Kubernetes restarts it. Liveness and readiness probes make sure we don't send traffic to anything unhealthy. |
| **Database fails over** | Aurora switches to standby in ~30s. The app retries with exponential backoff — users might see a brief hiccup but no data loss. |
| **Redis goes down** | ElastiCache Multi-AZ handles failover automatically. The app tolerates short disconnects gracefully. |
| **RabbitMQ fails** | Amazon MQ runs active/standby across AZs. Unacknowledged messages survive the failover. |
| **We're deploying** | Rolling updates with `maxUnavailable: 0, maxSurge: 1`. Pods drain their connections before shutting down — no dropped requests. |

---

## Scaling roadmap

### Today — 500 RPS

This is where we start:

- 2-3 pods per service, HPA on CPU for the API layer
- KEDA handling the trade history consumers based on queue depth
- 1 Aurora writer + 1 read replica
- 3-node Redis cluster
- Single Amazon MQ broker (multi-AZ)

### 10x — 5,000 RPS

Mostly just turning knobs:

- HPA scales pods out automatically, Karpenter provisions new nodes as needed
- Add more Aurora read replicas (up to 15)
- Add Redis shards if memory starts filling up
- Upgrade the Amazon MQ broker size, or migrate to a self-managed RabbitMQ cluster on EKS for finer control
- Probably time to split Order Service into "order validation" and "matching engine" as separate deployments

### 100x — 50,000+ RPS

Now things get interesting:

- Move the matching engine to a dedicated node group on c7g instances — at this scale, you need predictable latency and can't share compute
- Aurora Global Database for multi-region active-active
- ElastiCache Global Datastore for cross-region Redis
- This is where RabbitMQ hits its ceiling — switch to Kafka (MSK) because the event log and replay capabilities actually matter with multiple consumer groups
- Global Accelerator for intelligent multi-region traffic routing
- Dedicated market data service with its own read path, completely separate from the order flow
