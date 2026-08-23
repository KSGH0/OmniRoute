# Railway Deploy — Quick Pointer

> **This repo has 2 branches:** `release/v3.8.49` (clean, mergeable to upstream) and `railway-deploy` (Railway-ready). **Deploy from `railway-deploy` only.**

**Full spec → [`docs/ops/RAILWAY_DEPLOY.md`](docs/ops/RAILWAY_DEPLOY.md)** — Dockerfile without BuildKit cache, `railway.json`, volume `chown`, quality-gate shims, sync procedure, and the **Notification footer** at the end (last sync: `9e5984f85` → `716d2ee20` on 3.8.50 line).

**Railway settings:** Build → Dockerfile Path = `Dockerfile.railway` (already set via `railway.json`), Volume `/app/data`, `PORT` is overridden to `8080` at runtime (default `20128` locally).

See also `Dockerfile.railway` (225 lines) and `railway.json` at repo root.
