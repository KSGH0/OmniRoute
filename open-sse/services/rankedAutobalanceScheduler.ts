/**
 * Ranked autobalance scheduler — speed-only (p95 + error*1000).
 * F1: ranks providers per model, reranks automatically. Additive only, never hides /v1/models.
 * Trigger: interval (default 15m) + debounced on-failure via triggerRerankForModel().
 */

import { getDbInstance, rowToCamel } from "@/lib/db/core";
import { invalidateDbCache } from "@/lib/db/readCache";

type RankedComboRow = {
  id: string;
  name: string;
  config: string | null;
};

let timer: ReturnType<typeof setInterval> | null = null;
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

function parseRankedConfig(
  configStr: string | null
): { autoRank?: boolean; sourceModelId?: string; intervalMs?: number } | null {
  if (!configStr) return null;
  try {
    const cfg = JSON.parse(configStr) as Record<string, unknown>;
    const ra = cfg.rankedAutobalance as Record<string, unknown> | undefined;
    if (!ra || typeof ra.autoRank !== "boolean") return null;
    return ra as { autoRank?: boolean; sourceModelId?: string; intervalMs?: number };
  } catch {
    return null;
  }
}

function scoreOf(p95: number | null, error: number | null): number {
  const p = p95 ?? 999999;
  const e = error ?? 0;
  return p + e * 1000;
}

export function rankModelBySpeed(modelId: string): { ranked: number; reason: string } {
  const db = getDbInstance();
  const rankedCombos = db.prepare(`SELECT id, name, config FROM combos`).all() as RankedComboRow[];
  let ranked = 0;
  for (const row of rankedCombos) {
    const rc = parseRankedConfig(row.config);
    if (!rc?.autoRank || rc.sourceModelId !== modelId) continue;
    // Load speeds for this model
    const speeds = db
      .prepare(
        `SELECT provider_id as providerId, p95_ms as p95Ms, error_rate as errorRate FROM provider_model_speed WHERE model_id=?`
      )
      .all(modelId) as { providerId: string; p95Ms: number | null; errorRate: number | null }[];
    if (speeds.length === 0) continue;
    const scoreMap = new Map<string, number>();
    for (const s of speeds) scoreMap.set(s.providerId, scoreOf(s.p95Ms, s.errorRate));
    // Current targets order
    const targets = db
      .prepare(
        `SELECT id, provider_id as providerId FROM combo_targets WHERE combo_id=? ORDER BY sort_order ASC, id ASC`
      )
      .all(row.id) as { id: string; providerId: string }[];
    if (targets.length === 0) continue;
    // Sort targets copy by score (providers without speed go last)
    const sorted = [...targets].sort((a, b) => {
      const sa = scoreMap.has(a.providerId) ? scoreMap.get(a.providerId)! : 9999999;
      const sb = scoreMap.has(b.providerId) ? scoreMap.get(b.providerId)! : 9999999;
      return sa - sb;
    });
    // Apply new sort_order if changed
    let changed = false;
    for (let i = 0; i < targets.length; i++)
      if (targets[i].id !== sorted[i].id) {
        changed = true;
        break;
      }
    if (!changed) continue;
    const tx = db.transaction(() => {
      for (let i = 0; i < sorted.length; i++) {
        db.prepare(`UPDATE combo_targets SET sort_order=? WHERE id=?`).run(i, sorted[i].id);
      }
    });
    tx();
    ranked++;
  }
  if (ranked > 0) invalidateDbCache("combos");
  return {
    ranked,
    reason:
      ranked > 0
        ? `ranked ${ranked} combo(s) for ${modelId} by speed`
        : `no ranked combo for ${modelId}`,
  };
}

export function triggerRerankForModel(modelId: string): void {
  const prev = debounceMap.get(modelId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    debounceMap.delete(modelId);
    try {
      rankModelBySpeed(modelId);
    } catch {}
  }, 30_000);
  debounceMap.set(modelId, t);
}

export function startRankedAutobalanceScheduler(): void {
  if (timer) return;
  // Interval from settings, fallback 15m
  const getInterval = (): number => {
    try {
      const db = getDbInstance();
      const row = db
        .prepare(`SELECT value FROM settings WHERE key='rankedAutobalanceIntervalMs'`)
        .get() as { value: string } | undefined;
      if (row) {
        const v = Number(row.value);
        if (Number.isFinite(v) && v >= 60_000) return v;
      }
    } catch {}
    return 15 * 60 * 1000;
  };
  const tick = () => {
    try {
      const db = getDbInstance();
      // Opt-in is per-combo (config.rankedAutobalance.autoRank) — no global gate.
      // Combos without the flag are never touched.
      const rows = db.prepare(`SELECT config FROM combos`).all() as { config: string | null }[];
      const models = new Set<string>();
      for (const r of rows) {
        const rc = parseRankedConfig(r.config);
        if (rc?.autoRank && rc.sourceModelId) models.add(rc.sourceModelId);
      }
      for (const m of models) {
        try {
          rankModelBySpeed(m);
        } catch {}
      }
    } catch {}
  };
  timer = setInterval(tick, getInterval());
  // Allow process to exit if only this timer remains
  if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref!();
  }
}

export function stopRankedAutobalanceSchedulerForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const t of debounceMap.values()) clearTimeout(t);
  debounceMap.clear();
}
