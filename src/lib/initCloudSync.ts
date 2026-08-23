import initializeCloudSync from "@/shared/services/initializeCloudSync";
import { startModelSyncScheduler } from "@/shared/services/modelSyncScheduler";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";
import { getJobRegistry } from "@/lib/jobRegistry";
import { registerBudgetResetJob } from "@/lib/jobs/budgetResetJob";
import { registerTokenHealthCheck } from "@/lib/jobs/tokenHealthCheckJob";
import { getRuntimePorts } from "@/lib/runtime/ports";

// Initialize runtime background sync services once per server process.
let initialized = false;

export function shouldSkipCloudSyncInitialization(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  if (env.NEXT_PHASE === "phase-production-build") {
    return true;
  }

  const raw = env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES;
  if (raw && new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())) {
    return true;
  }

  return isAutomatedTestProcess(argv, env) && env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1";
}

function fixStaleLocalProxyPort(): void {
  // Railway sets PORT=8080 at runtime, but a proxy seeded at 127.0.0.1:20128
  // (the default) becomes unreachable and floods CredentialHealth with
  // PROXY_UNREACHABLE ECONNREFUSED ::1:20128 every 5 min.
  // On Railway there is no forward proxy at localhost at all — the stale
  // entry must be removed, not just port-migrated (migrating 20128→8080
  // would still be a dead localhost:8080). Remove the stale proxy and its
  // assignments so health checks go direct.
  try {
    const { port } = getRuntimePorts();
    const isOverridden = !!process.env.PORT || !!process.env.OMNIROUTE_PORT;
    console.log(
      `[ServerInit] fixStaleLocalProxyPort: check PORT=${port} isOverridden=${isOverridden} (process.env.PORT=${process.env.PORT || "unset"})`
    );
    // Only act when PORT is overridden to something other than the default.
    // If port === 20128 but overridden (e.g. OMNIROUTE_PORT=20128) it's still
    // the default, no drift — skip.
    if (!isOverridden || port === 20128) {
      console.log("[ServerInit] fixStaleLocalProxyPort: skipped (no drift)");
      return;
    }

    // Require DB ready — caller ensures initializeCloudSync() already ran.

    const { getDbInstance } = require("@/lib/db/core");
    const db = getDbInstance();
    const staleHosts = ["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"];
    let removedProxies = 0;
    let removedAssignments = 0;
    let fixedLegacy = 0;

    // 1) proxy_registry — delete stale localhost:20128 proxies entirely
    // Broadened: any proxy with port 20128 that is a local/private address is stale on Railway (PORT=8080).
    // Check both exact host match and any 20128 port with local host.
    const localHostPattern = (h: string) =>
      staleHosts.includes(h.trim().toLowerCase()) ||
      h.trim().toLowerCase().startsWith("127.") ||
      h.trim().toLowerCase() === "localhost" ||
      h.trim().toLowerCase().includes("::1");
    const allPort20128 = db
      .prepare("SELECT id, host FROM proxy_registry WHERE port = 20128")
      .all() as Array<{ id: string; host: string }>;
    for (const { id, host } of allPort20128) {
      const h = (host || "").trim().toLowerCase();
      // On Railway, any 20128 proxy is stale if current port != 20128, but be conservative: only delete if host is local/private or if no other 20128 proxies should exist.
      // For now, delete all 20128 when isOverridden — they were seeded at default and never valid on Railway.
      const isLocal = localHostPattern(h) || h === "" || h === "0.0.0.0";
      // Be aggressive on Railway: delete all 20128 proxies when PORT is overridden, they are from default seed.
      // If you have a legitimate external proxy at 20128, set OMNIROUTE_PORT=20128 to skip this fix.
      const shouldDelete = isLocal || isOverridden; // on Railway, delete all 20128
      if (!shouldDelete) continue;
      const delAssign = db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(id);
      removedAssignments += delAssign.changes;
      db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(id);
      removedProxies++;
    }

    // 2) Legacy key_value proxyConfig (pre-registry) — may store
    //    {"global": {"host":"127.0.0.1","port":20128}} or provider/combo maps,
    //    or even a raw URL string like "http://127.0.0.1:20128".
    //    If any host:20128 entry is found, null it out so it doesn't shadow direct.
    try {
      const kvRows = db
        .prepare("SELECT key, value FROM key_value WHERE namespace = 'proxyConfig'")
        .all() as Array<{ key: string; value: string }>;
      for (const { key, value } of kvRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          // Value may be a raw URL string, not JSON — check for :20128
          if (typeof value === "string" && value.includes(":20128")) {
            // If it's a localhost:20128 URL, null it
            if (
              value.toLowerCase().includes("127.0.0.1") ||
              value.toLowerCase().includes("localhost") ||
              value.toLowerCase().includes("::1")
            ) {
              db.prepare(
                "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
              ).run(key, JSON.stringify(null));
              fixedLegacy++;
            }
          }
          continue;
        }
        if (!parsed || typeof parsed !== "object") {
          // Check raw string again
          if (typeof value === "string" && value.includes(":20128")) {
            if (
              value.toLowerCase().includes("127.0.0.1") ||
              value.toLowerCase().includes("localhost") ||
              value.toLowerCase().includes("::1")
            ) {
              db.prepare(
                "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
              ).run(key, JSON.stringify(null));
              fixedLegacy++;
            }
          }
          continue;
        }
        // Global is a single object; providers/combos/keys are maps.
        const maybeFix = (obj: unknown): boolean => {
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
          const o = obj as Record<string, unknown>;
          const host = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
          const p = Number(o.port);
          // Also handle URL strings
          if (typeof o.url === "string" && o.url.includes(":20128")) return true;
          if (typeof o.proxyUrl === "string" && o.proxyUrl.includes(":20128")) return true;
          return (
            (staleHosts.includes(host) || host.includes("127.") || host.includes("::1")) &&
            p === 20128
          );
        };
        // Also handle case where parsed itself is a URL string (not object)
        if (typeof parsed === "string" && (parsed as string).includes(":20128")) {
          const s = (parsed as string).toLowerCase();
          if (s.includes("127.0.0.1") || s.includes("localhost") || s.includes("::1")) {
            db.prepare(
              "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
            ).run(key, JSON.stringify(null));
            fixedLegacy++;
            continue;
          }
        }
        let mutated = false;
        let newVal: unknown = parsed;
        if (key === "global" && maybeFix(parsed)) {
          newVal = null;
          mutated = true;
        } else if (key === "providers" || key === "combos" || key === "keys") {
          const map = parsed as Record<string, unknown>;
          for (const [scopeId, pv] of Object.entries(map)) {
            if (maybeFix(pv)) {
              delete map[scopeId];
              mutated = true;
            } else if (typeof pv === "string" && (pv as string).includes(":20128")) {
              const s = (pv as string).toLowerCase();
              if (s.includes("127.0.0.1") || s.includes("localhost") || s.includes("::1")) {
                delete map[scopeId];
                mutated = true;
              }
            }
          }
          newVal = map;
        } else if (maybeFix(parsed)) {
          // Fallback: parsed is a proxy object itself under unknown key
          db.prepare(
            "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
          ).run(key, JSON.stringify(null));
          fixedLegacy++;
          continue;
        }
        if (mutated) {
          db.prepare(
            "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
          ).run(key, JSON.stringify(newVal));
          fixedLegacy++;
        }
      }
    } catch {
      // key_value may not exist on fresh installs — ignore
    }

    if (removedProxies > 0 || fixedLegacy > 0) {
      console.log(
        `[ServerInit] Removed ${removedProxies} stale local proxy(ies) at :20128 (hosts ${staleHosts.join(",")}) and ${fixedLegacy} legacy proxyConfig entries — PORT is ${port}, localhost:20128 is not a valid forward proxy on Railway. Health checks will now go direct.`
      );
      try {
        const { bumpProxyRegistryGeneration } = require("@/lib/db/proxies/registryGeneration");
        bumpProxyRegistryGeneration();
      } catch {}
      try {
        const { bumpProxyConfigGeneration } = require("@/lib/db/settings");
        bumpProxyConfigGeneration();
      } catch {}
    } else if (removedAssignments > 0) {
      console.log(`[ServerInit] Cleaned ${removedAssignments} stale proxy assignment(s) at :20128`);
    } else {
      console.log("[ServerInit] fixStaleLocalProxyPort: no stale proxies at :20128 found — clean");
    }
  } catch (err) {
    console.warn("[ServerInit] fixStaleLocalProxyPort skipped:", (err as Error)?.message);
  }
}

export async function ensureCloudSyncInitialized() {
  if (shouldSkipCloudSyncInitialization()) {
    return false;
  }
  if (!initialized) {
    try {
      await initializeCloudSync();
      // Must run after DB migrations — proxy_registry may not exist before.
      fixStaleLocalProxyPort();
      startModelSyncScheduler();

      // startAll() runs each interval job's first tick synchronously, so it has to
      // come after initializeCloudSync(). The old wiring got that ordering two
      // different ways: the budget reset was started right here, and the health
      // check's first sweep sat behind a 10s timer. Awaiting the init is a firmer
      // guarantee than the timer was.
      const registry = getJobRegistry();
      registerBudgetResetJob(registry);
      registerTokenHealthCheck(registry);
      await registry.startAll();

      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing background sync services:", error);
    }
  }
  return initialized;
}

export default ensureCloudSyncInitialized;
