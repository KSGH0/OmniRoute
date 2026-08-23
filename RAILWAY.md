# Railway Deploy — Quick Pointer

> **This repo has 2 branches:** `release/v3.8.49` (clean, mergeable to upstream) and `railway-deploy` (Railway-ready). **Deploy from `railway-deploy` only.**

**Full spec → [`docs/ops/RAILWAY_DEPLOY.md`](docs/ops/RAILWAY_DEPLOY.md)** — Dockerfile without BuildKit cache, `railway.json`, volume `chown`, quality-gate shims, sync procedure, and the **Notification footer** at the end (last sync: `9e5984f85` → `716d2ee20` on 3.8.50 line).

**Railway settings:** Build → Dockerfile Path = `Dockerfile.railway` (already set via `railway.json`), Volume `/app/data`, `PORT` is overridden to `8080` at runtime (default `20128` locally).

See also `Dockerfile.railway` (225 lines) and `railway.json` at repo root.

**2026-08-23 overlay — ranked autobalance + pricing badges (railway-deploy only):**

- Ranked autobalance by speed (`provider_model_speed` table + `open-sse/services/rankedAutobalanceScheduler.ts` + `POST /api/combos/:id/rank`): toggle `Auto-rank by speed` in `Dashboard > Combos > Control Center` (`RankedAutobalanceToggle.tsx`) + global kill-switch in **Configuration → AI Settings** (`settings/ai/page.tsx` → `RankedPricingAiSettingsTab.tsx`), reranks by `p95+error*1000` every 15m + on failure (debounced 30s), splits `Free` vs `Paid` pools via two combos. **API invariant: `GET /v1/models` still lists all providers/models** — ranking only reorders `combo_targets.sort_order`, never filters catalog.
- Pricing badges for all models (`src/shared/components/ModelSelectModal.tsx` + `GET /api/pricing`): `Free • $0.00` vs `$x.xx/$y.yy` per `provider/model`, display-only, gated by `Configuration → AI Settings → Show pricing badges` (`showPricingBadges` default ON), no catalog change.
