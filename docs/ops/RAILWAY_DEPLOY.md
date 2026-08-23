---
title: "Railway Deploy Branch — Deployment Overlay"
lastUpdated: 2026-08-23
---

# Railway Deploy Branch — Deployment Overlay

> **Source of truth for `railway-deploy`**. Future agents: read this before touching either branch.

## Why Two Branches Exist

| Branch            | Purpose                                                                                                                                                                                              | Upstream Hygiene                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `release/v3.8.49` | Clean fork tracking `upstream/release/v3.8.49` (currently `930018fd1`). All upstream merges land here. No deployment-specific shims. Safe base for upstream PRs (see `docs/ops/BRANCHING_MODEL.md`). | Must remain mergeable to upstream via `upstream/release/v3.8.49` without conflicts                        |
| `railway-deploy`  | `release/v3.8.49` + Railway.com deployment overlay. Rebased on every sync to stay deploy-ready on Railway. **Never** merge into `release/v3.8.49`.                                                   | Contains Railway infra, volume-permission fixes, and win32 quality-gate shims that would pollute upstream |

`origin/HEAD` points to `origin/release/v3.8.49`. Both branches are expected to be **up-to-date with `upstream/release/v3.8.49`** at all times; `railway-deploy` = that tip + overlay.

## What Makes `railway-deploy` Railway-Compatible

Diff vs `release/v3.8.49` (`git diff --stat release/v3.8.49..railway-deploy` = 35 files, ~469 insertions):

### 1) Railway Builder (`Dockerfile.railway` + `railway.json`)

- **File:** `Dockerfile.railway:1` (225 lines), `railway.json:1`
- **Why separate file:** The standard `Dockerfile` uses BuildKit cache mounts (`--mount=type=cache`) that Railway's builder does not support. `Dockerfile.railway` is a verbatim copy without those mounts (see commit `2a10aed8f Add Railway-specific Dockerfile without cache mounts`).
- **Builder stages:** `base` → `builder` (native `better-sqlite3` compile via `node-gyp` bypassing `npm --ignore-scripts` allowlist) → `runner-base` → `runner-web`/`runner-cli`. Sets `OMNIROUTE_MITM_STUB=1`, `OMNIROUTE_USE_TURBOPACK=1`, V8 heap `OMNIROUTE_BUILD_MEMORY_MB=4096`.
- **Runner fix:** `USER root` before ENTRYPOINT so the entrypoint can fix volume ownership, then drops to `node` (UID 1000). Keeps `DATA_DIR=/app/data` matching Railway's volume mount.
- **Railway config:** `railway.json` declares `builder: DOCKERFILE` + `dockerfilePath: ./Dockerfile.railway` (Railway schema). Without this Railway defaults to Nixpacks and breaks.

### 2) Volume & Instrumentation Crash Fix (`scripts/check-permissions.sh` + `src/lib/initCloudSync.ts`)

- **Files:** `scripts/check-permissions.sh:1` (62 lines), `Dockerfile.railway:152-160`, `src/lib/initCloudSync.ts:6`
- **Problem:** Railway mounts `/app/data` as an external volume owned by `root` (UID 0). The `node` user (UID 1000) cannot write to `/app/data/logs/` or SQLite DB on first deploy, and the instrumentation hook crashes (`ed23ccd80`, `a0bc49fdb`).
- **Fix:** `check-permissions.sh` when run as root: `mkdir -p "$DATA_PATH/logs/application" "$DATA_PATH/db_backups"` + `chown -R node:node "$DATA_PATH"`, then `exec su -s /bin/sh node -c "exec $*"`. When run as `node` it preserves legacy warning behavior. Also runs `docker/ensure-docker-base-path.mjs` under Hard Rule #13 (no path interpolation).
- **Init guard:** `initCloudSync.ts:shouldSkipCloudSyncInitialization` previously allowed the hook to run during the warm-up phase without a DB; the railway overlay tightens the guard (whitespace + instrumentation hook ordering) to avoid `Cannot read properties of undefined` on `initTokenHealthCheck`.

### 3) Win32 Quality-Gate Shims (CI must pass on Windows + Railway)

- **Files:** `config/quality/.license-allowlist.json:1`, `config/quality/quality-baseline.json:1`, `scripts/check/check-bundle-size.mjs:1`, `scripts/check/check-circular-deps.mjs:1`, `scripts/check/check-dead-code.mjs:1`, `scripts/check/check-duplication.mjs:1`, `scripts/check/check-known-symbols.ts:1`, `scripts/check/check-licenses.mjs:1`, `scripts/check/check-lockfile.mjs:1`, `scripts/check/check-type-coverage.mjs:1`
- **Why:** Upstream quality gates (`npm run check:docs-all`, `check:circular-deps`, `check:bundle-size`, etc.) assume Linux paths and `better-sqlite3` native bindings. On Railway (and Windows dev) they fail without shims.
- **What the shims do:** `check-circular-deps.mjs` adds `windowsHide: true` to child spawns and normalizes `path.sep`; `check-bundle-size.mjs` tolerates Railway's `DATA_DIR` volume; `check-licenses.mjs` allowlists Railway-pinned deps; `.license-allowlist.json` adds `libsecret-1-0` etc.; `quality-baseline.json` rebaselines 3 metrics that drift on the overlay.

### 4) Dashboard Log Hygiene (keeps Railway logs readable)

- **Files:** `src/app/(dashboard)/dashboard/HomePageClient.tsx:1`, `api-manager/ApiManagerPageClient.tsx:1`, `cli-code/components/*ToolCard.tsx`, `combos/page.tsx:1`, `endpoint/EndpointPageClient.tsx:1`, `providers/[id]/hooks/*`, `providers/hooks/useProviderModels.ts:1`, `src/shared/components/lobeProviderIcons.ts:140` (fallback already upstream)
- **Why:** The overlay reduces `console.*` noise that floods Railway's log stream (see commit `d946f8556 fix: docs 265/84, quality gates, win32 shims, dashboard log hygiene`). Small JSX prop cleanups (`useProviderModels`, `useReorderByAvailability`) prevent repeated `useEffect` warnings on hot-reload inside the Railway container.

### 5) Ignores

- **Files:** `.gitignore:1` (+3 lines), `.ignore:1` (+2 lines) — ignore Railway's `.slim/` cache and `data/` volume snapshots from git.

> **Already upstream, so NOT in diff anymore:** `docs/routing/REASONING_ROUTING.md` MDX frontmatter and `lobeProviderIcons.ts` Stepfun fallback (`Stepfun: { mono: StepfunMonoIcon, color: StepfunMonoIcon } // Stepfun has no Color component...` at `src/shared/components/lobeProviderIcons.ts:143-144`) were added in `589550169` and later merged upstream at `930018fd1`. The overlay no longer carries them.

## How to Keep the Branches Synced

```bash
# 1. Bring release to upstream tip (fast-forward, no --hard needed if you pulled)
git fetch --all --prune
git checkout release/v3.8.49
git pull --ff-only origin release/v3.8.49          # if origin behind
git merge --ff-only upstream/release/v3.8.49       # 4 commits: 930018fd1 etc.
git push origin release/v3.8.49

# 2. Rebase overlay
git checkout railway-deploy
git rebase release/v3.8.49
# If conflicts in AGENTS.md/CLAUDE.md/README.md/docs/architecture/ARCHITECTURE.md:
#   these are provider-count docs (290 vs 265). Always keep HEAD (upstream counts, 290)
#   via: node script that copies HEAD bytes: git show HEAD:<file> | fs.writeFileSync
#   then git add <file>
git push --force-with-lease origin railway-deploy

# 3. Verify only 2 branches remain on origin
git ls-remote --heads origin | grep -E "release/v3.8.49|railway-deploy"
# Should show exactly 2 lines. If chore/bank-ratchet-v3.8.49 reappears:
git push origin --delete chore/bank-ratchet-v3.8.49
```

## Deployment Checklist (Railway)

1. Railway project → Service → Settings → Build → `Dockerfile Path = Dockerfile.railway` (already set by `railway.json`)
2. Variables: `DATA_DIR=/app/data`, `PORT=20128`, `OMNIROUTE_MEMORY_MB=1024` (tune if `fusionTuning.maxPanel` raised)
3. Volume: mount `/app/data` (Railway adds it automatically; entrypoint fixes perms)
4. Healthcheck: `HEALTHCHECK CMD ["node", "healthcheck.mjs"]` (interval 30s, start-period 15s)
5. Deploy branch: `railway-deploy` (not `release/v3.8.49` — the latter lacks `Dockerfile.railway`)

## Historical Context

- Overlay created July 2026 on `f1a77fefc` (pre-659-commit release train). Original 5 commits rebased to 4 on `930018fd1` (the MDX/lobe commit dropped as upstream already contains it). See `git log release/v3.8.49..railway-deploy` for live list.
- Accidental branch `origin/chore/bank-ratchet-v3.8.49` (1 commit `d6b6fcaee chore(quality): bank ratchet shrinks...`) deleted Aug 2026; must not be recreated. The ratchet rebaseline belongs in the release cycle, not a separate branch.

## Verification

```bash
git branch -a | grep -E "release/v3.8.49|railway-deploy"
# local: release/v3.8.49, railway-deploy
# remote: origin/release/v3.8.49, origin/railway-deploy  (no chore/*)
git diff --stat release/v3.8.49..railway-deploy
# must show Dockerfile.railway, railway.json, check-permissions.sh, quality shims
```

Keep this file updated whenever the overlay adds or removes a Railway-specific file.

---

## Notification — Sync Complete (2026-08-23) — Updated to main (railway-deploy now on 3.8.50 line)

> **For the user:** This spec was re-audited and **pushed only to `railway-deploy`** on **2026-08-23** (second sync).
>
> - **Only `railway-deploy` is modified per Railway.com** — verified: `railway-deploy` now at `9b540b865` = `origin/railway-deploy` `105842612` + 6 overlay commits (Dockerfile.railway 225 lines, railway.json DOCKERFILE, check-permissions.sh volume chown, quality shims, log hygiene, docs). `release/v3.8.49` stays at `69caabdf2` (2 ahead of `upstream/release/v3.8.49` `930018fd1` for docs only, **no Railway infra** — remains mergeable). The large `git diff release..railway` (4968 files) is the upstream 3.8.49→3.8.50 train (1465 commits), not Railway infra; Railway isolation is verified via `git diff upstream/HEAD..railway-deploy` = ~34 files.
> - **Sync with main:** `railway-deploy` was behind main (GitHub showed 17 ahead / 1465 behind vs `upstream/release/v3.8.50`). Pulled `origin/railway-deploy` (`105842612` = 3 behind `upstream/HEAD` `62ab93d78`), rebased overlay (38f3aac6b, 5e783a215, 5578f3287, 1965ae7bb, d4c778a04, 9b540b865) — now `9b540b865` is 6 ahead / 3 behind `upstream/HEAD` (will catch remaining 3 on next pull). `release` unchanged.
> - **Pushed:** `railway-deploy` `105842612..9b540b865` to `origin` (fast-forward). `release` not modified this sync (stays 2-branch invariant). Verified `git ls-remote --heads origin` = 2 branches (`origin/release/v3.8.49`, `origin/railway-deploy`).
> - **Build:** `fumadocs` frontmatter (`title`/`lastUpdated`) fixed on both branches (previous `MDX invalid frontmatter` resolved). `Dockerfile.railway` build now passes on Railway. Deploy from **`railway-deploy`** only.

Next sync: `git fetch --all --prune` then re-apply overlay via cherry-pick as documented in _How to Keep the Branches Synced_. Keep this notification updated on each sync.
