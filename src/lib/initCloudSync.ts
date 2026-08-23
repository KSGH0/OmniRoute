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
    // Only act when PORT is overridden to something other than the default.
    // If port === 20128 but overridden (e.g. OMNIROUTE_PORT=20128) it's still
    // the default, no drift — skip.
    if (!isOverridden || port === 20128) return;

    // Require DB ready — caller ensures initializeCloudSync() already ran.
     
    const { getDbInstance } = require("@/lib/db/core");
    const db = getDbInstance();
    const staleHosts = ["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"];
    let removedProxies = 0;
    let removedAssignments = 0;
    let fixedLegacy = 0;

    // 1) proxy_registry — delete stale localhost:20128 proxies entirely
    for (const host of staleHosts) {
      const rows = db
        .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = 20128")
        .all(host) as Array<{ id: string }>;
      for (const { id } of rows) {
        const delAssign = db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(id);
        removedAssignments += delAssign.changes;
        db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(id);
        removedProxies++;
      }
    }

    // 2) Legacy key_value proxyConfig (pre-registry) — may store
    //    {"global": {"host":"127.0.0.1","port":20128}} or provider/combo maps.
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
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        // Global is a single object; providers/combos/keys are maps.
        const maybeFix = (obj: unknown): boolean => {
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
          const o = obj as Record<string, unknown>;
          const host = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
          const p = Number(o.port);
          return staleHosts.includes(host) && p === 20128;
        };
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
            }
          }
          newVal = map;
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
