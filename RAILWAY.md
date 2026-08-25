# Railway Deploy — Quick Pointer

> **This repo has 2 branches:** `release/v3.8.49` (clean, mergeable to upstream) and `railway-deploy` (Railway-ready). **Deploy from `railway-deploy` only.**

**Full spec → [`docs/ops/RAILWAY_DEPLOY.md`](docs/ops/RAILWAY_DEPLOY.md)** — Dockerfile without BuildKit cache, `railway.json`, volume `chown`, quality-gate shims, sync procedure, and the **Notification footer** at the end (last sync: `9e5984f85` → `716d2ee20` on 3.8.50 line).

**Railway settings:** Build → Dockerfile Path = `Dockerfile.railway` (already set via `railway.json`), Volume `/app/data`, `PORT` is overridden to `8080` at runtime (default `20128` locally).

See also `Dockerfile.railway` (225 lines) and `railway.json` at repo root.

**2026-08-23 overlay — ranked autobalance + price exposure (railway-deploy only, API/backend):**

- Ranked autobalance by speed (`provider_model_speed` table + `open-sse/services/rankedAutobalanceScheduler.ts` + `POST /api/combos/:id/rank`): per-combo opt-in via `PUT /api/combos/:id` with `config.rankedAutobalance: {autoRank:true, sourceModelId}` (no UI). Reranks by `p95+error*1000` every 15m + on failure (debounced 30s); latency samples recorded from real traffic via call-log persistence. **API invariant: `GET /v1/models` still lists all providers/models** — ranking only reorders `combo_targets.sort_order`, never filters catalog.
- Price exposure to end users (`GET /v1/models` pricing field = `{input, output, cached, cache_creation}`): resolution order apiDiscovered (`pricing_api_discovered`, probed from provider `/models` with decrypted key on key-add/retest/autosync) → models.dev → LiteLLM → hardcoded defaults. Also served via `GET /api/pricing` and `GET /api/pricing/models`. No UI surface — API-only by design.
