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
  // PROXY_UNREACHABLE ECONNREFUSED ::1:20128 every 5 min. Auto-migrate it to
  // the current runtime port so health checks use the actual listen port.
  try {
    const { port } = getRuntimePorts();
    if (port === 20128) return; // default, no drift
    // Only run when PORT is explicitly overridden (Railway, custom deploy)
    const isOverridden = !!process.env.PORT || !!process.env.OMNIROUTE_PORT;
    if (!isOverridden) return;
     
    const { getDbInstance } = require("@/lib/db/core");
    const db = getDbInstance();
    const staleHosts = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
    let fixed = 0;
    for (const host of staleHosts) {
      const rows = db
        .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = 20128")
        .all(host) as Array<{ id: string }>;
      for (const { id } of rows) {
        db.prepare("UPDATE proxy_registry SET port = ?, updated_at = ? WHERE id = ?").run(
          port,
          new Date().toISOString(),
          id
        );
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(
        `[ServerInit] Fixed ${fixed} stale local proxy port(s) 20128 → ${port} for current PORT`
      );
      // Bump generation so rotation/proxy caches reload
      try {
        const { bumpProxyRegistryGeneration } = require("@/lib/db/proxies/registryGeneration");
        bumpProxyRegistryGeneration();
      } catch {}
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
      fixStaleLocalProxyPort();
      await initializeCloudSync();
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
