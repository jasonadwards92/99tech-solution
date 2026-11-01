const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

// Also hard-coded in the compose healthcheck and the nginx upstream.
const PORT = 3000;

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "postgres",
  port: 5432,
  max: 10,
  // Fail a request after 2s instead of queueing forever when the pool is empty.
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 10000,
  // Bound a stalled query, below nginx's 10s proxy_read_timeout.
  statement_timeout: 5000,
  query_timeout: 5000,
});

// An idle client dies whenever Postgres restarts. Without a listener, pg
// re-throws that as an unhandled 'error' event and the whole process exits.
pool.on("error", (err) => {
  console.error("postgres idle client error:", err.message);
});

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  connectTimeout: 2000,
  // Fail the request quickly while Redis is down; ioredis keeps reconnecting.
  maxRetriesPerRequest: 1,
});

redis.on("error", (err) => {
  console.error("redis error:", err.message);
});

app.get("/api/users", async (req, res) => {
  try {
    // pool.query checks a client out and always returns it, even on error.
    const result = await pool.query("SELECT NOW()");
    // Bookkeeping only: a Redis outage must not fail a good database read.
    redis.set("last_call", Date.now()).catch((err) => {
      console.error("redis set failed:", err.message);
    });
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

const server = app.listen(PORT, () => console.log(`API running on ${PORT}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
  // Don't hang on keep-alive connections.
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
