# Railway Deploy — Quick Pointer

> **This repo has 2 branches:** `release/v3.8.49` (clean, mergeable to upstream) and `railway-deploy` (Railway-ready). **Deploy from `railway-deploy` only.**

**Full spec → [`docs/ops/RAILWAY_DEPLOY.md`](docs/ops/RAILWAY_DEPLOY.md)** — Dockerfile without BuildKit cache, `railway.json`, volume `chown`, quality-gate shims, sync procedure, and the **Notification footer** at the end (last sync: `9e5984f85` → `716d2ee20` on 3.8.50 line).

**Railway settings:** Build → Dockerfile Path = `Dockerfile.railway` (already set via `railway.json`), Volume `/app/data`, `PORT` is overridden to `8080` at runtime (default `20128` locally).

See also `Dockerfile.railway` (225 lines) and `railway.json` at repo root.

**2026-08-23 overlay — price exposure via API (railway-deploy only):**

- End users calling `GET /v1/models` receive `pricing: {input, output, cached, cache_creation}` per model. Resolution order (`modelMetadataRegistry.resolveCatalogPricing`): `pricing_api_discovered` (legacy rows, namespace no longer written) → models.dev → LiteLLM → hardcoded defaults. Also served via `GET /api/pricing` and `GET /api/pricing/models`. **API invariant: all providers/models remain listed** — pricing is additive metadata only, never filters the catalog.
