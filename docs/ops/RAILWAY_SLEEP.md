# Railway Sleep (Serverless) — Keep-Alive Audit & Recipe

> Scope: the `railway-deploy` branch running on Railway as a single service with
> the `/app/data` volume. Last audited 2026-09-09 against the on-disk
> `railway-deploy` tip (post-3.8.50 train).

## How Railway decides to sleep

Railway Serverless (formerly App-Sleeping, per-service toggle, off by default)
sleeps a service after **5–10 minutes of zero outbound packets** (sampled).
Any outbound resets the timer: upstream provider API calls, OAuth refreshes,
quota RPCs, proxy probes, private-network traffic (invisible in the metrics
graph), framework telemetry, NTP/OS chatter. **Inbound — including
healthchecks — does not count.** The first request to a slept service wakes it
and may 502 (cold boot). Volumes do not block sleep: local SQLite/file I/O
emits no packets.

Rule of thumb for this codebase: **only schedulers that emit upstream traffic
more often than every ~10 minutes prevent sleep.** Hourly/daily syncs merely
delay it. Pure-local timers (DB sweeps, cache eviction, file polls) are
irrelevant to sleep.

## What keeps this service awake (verified, with kill-switches)

| #   | Source                                                                                                                                                                             | Cadence (default)                                                      | Blocks sleep?                                                                                                                                                                   | Switch                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Credential-health sweep (`src/lib/credentialHealth/scheduler.ts:88-95`, started `src/instrumentation-node.ts:472-483`) — real upstream `testSingleConnection` per connection       | 5 min, on by default                                                   | **Yes, if any connection configured**                                                                                                                                           | `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1`                                                        |
| 2   | Quota-cache background refresh (`src/domain/quotaCache.ts:727-755`, started `src/instrumentation-node.ts:365`) — upstream `getUsageForProvider` per cached entry older than ~5 min | 60s tick / 5 min refetch, always on                                    | **Yes, after any OAuth usage**                                                                                                                                                  | `OMNIROUTE_DISABLE_QUOTA_BACKGROUND_REFRESH=1` (added for this; request-path quota reads unaffected) |
| 3   | Proxy-health sweep (`src/lib/proxyHealth/scheduler.ts:190-207,290-299`) — external probe per proxy                                                                                 | 60s boot sweep, then 10 min, on by default                             | Borderline (exactly at the sleep boundary) **only if proxies configured**; zero outbound with an empty registry                                                                 | `PROXY_HEALTH_ENABLED=false`                                                                         |
| 4   | Quota-monitor sessions (`open-sse/services/quotaMonitor.ts:190-275`) — upstream quota poll per session                                                                             | 60s (15s when critical), per-connection opt-in (`quotaMonitorEnabled`) | Tails ~15 min past last traffic: sessions are session-bound and self-stop when the session record expires (`SESSION_TTL_MS` = 15 min, `open-sse/services/sessionManager.ts:45`) | Leave opt-in off unless needed                                                                       |
| 5   | Token-health job (`src/lib/jobs/tokenHealthCheckJob.ts:16-25`) — per-OAuth refresh on 60-min interval/expiry                                                                       | 60s tick, hourly bursts per connection                                 | No (sleep fits between bursts)                                                                                                                                                  | `OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK=1`                                                              |
| 6   | Provider-limits sync (`src/shared/services/providerLimitsSyncScheduler.ts`) — upstream sync per connection                                                                         | 70 min default                                                         | No                                                                                                                                                                              | `OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1` (master switch, see below)                                 |

## Dormant unless you use the feature (verified off/absent by default)

- Warmup scheduler (`src/lib/warmupScheduler.ts`) — **no production callers**; dormant even when enabled.
- Quota auto-ping (60s tick, skips with nothing opted in), free-proxy sync (opt-in),
  pricing/models.dev syncs (opt-in, 24h), arena/OpenRouter stats (24h — sleep fits
  between), memory decay (opt-in), tunnels (on-demand), OTel (endpoint unset),
  Redis (`QUOTA_STORE_REDIS_URL`/`REDIS_URL` unset — **if you attach Railway
  Redis and set these, the persistent connection keeps the service awake**),
  embedded-service model sync (5 min, only for installed/running services —
  default `auto_start=0`), backup schedule (no schedule file → no-op).
- Auto-refresh daemon (boot + 15 min) no-ops with zero registered web-cookie
  credentials. LiveWS daemon (default on, port 20132) is listener-only — an
  **open dashboard tab** holds the WS and its traffic keeps the service awake
  (expected); set `OMNIROUTE_ENABLE_LIVE_WS=0` if live dashboard isn't needed.
- Local-only timers (no packets, never block sleep): connection-recovery ticks,
  batch poller (DB-only when idle), 6h retention cleanup, vacuum, WAL/DB-health
  timers, log rotation, spend writer, session/affinity/idempotency cleanups,
  quota-fetcher cache sweeps, MCP stdio heartbeat, hot-reload file poll,
  per-request SSE/stream heartbeats, Docker + Railway healthchecks.

## Recommended Railway variables for a sleeping service

```bash
OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1
OMNIROUTE_DISABLE_QUOTA_BACKGROUND_REFRESH=1
OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK=1
PROXY_HEALTH_ENABLED=false          # only if no proxies are configured
OMNIROUTE_ENABLE_LIVE_WS=0          # only if live dashboard isn't needed
```

`OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1` is the heavier alternative: it also
stops quota-cache refresh, provider-limits sync, arena/radar/stats/models.dev
syncs, connection recovery, auto-refresh, auto-ping, batch processing, the
LiveWS daemon, and embedded-service bootstrap — but it does **not** cover the
credential-health scheduler, the token-health job, or proxy health (separate
flags above), and it disables batch processing entirely.

`NEXT_TELEMETRY_DISABLED=1` is baked into the `Dockerfile.railway` runner image
(boot-time framework phone-home silenced).

## Dashboard-side checklist (not visible from the repo)

- Serverless toggle ON for the service (off by default).
- No `REDIS_URL` / `QUOTA_STORE_REDIS_URL` pointing at a Railway Redis (or
  accept always-awake).
- No tunnel autostart, no running embedded services, no connections with
  `quotaMonitorEnabled`, no proxies unless `PROXY_HEALTH_ENABLED=false` is set.
- A restart clears any in-flight quota-monitor sessions and quota-cache entries.
- Expect the first request after sleep to be slow or 502 once (cold boot:
  Next standalone + SQLite migrations + one upstream quota/health burst).
