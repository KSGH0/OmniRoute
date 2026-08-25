/**
 * provider_model_speed — per-model provider speed ranking for ranked autobalance (F1).
 * Speed-only: p95_ms + errorRate*1000 rank. Additive, never filters catalog.
 *
 * Write path: recordRequestSample() (EWMA from real requests, via call-log persistence).
 * Read path: rankedAutobalanceScheduler.rankModelBySpeed() (direct SQL, no cache).
 */

import { getDbInstance } from "./core";

/**
 * Record one real-request latency sample (EWMA) into provider_model_speed.
 * Called fire-and-forget from the call-log persistence path — deliberately
 * does NOT bump readCache (per-request writes must not thrash combos cache);
 * the ranking scheduler reads this table directly.
 */
export function recordRequestSample(
  modelId: string,
  providerId: string,
  durationMs: number,
  isError: boolean
): void {
  if (!modelId || !providerId) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  try {
    const db = getDbInstance();
    const prev = db
      .prepare(
        `SELECT p95_ms, error_rate, sample_count FROM provider_model_speed WHERE model_id=? AND provider_id=?`
      )
      .get(modelId, providerId) as
      { p95_ms: number | null; error_rate: number | null; sample_count: number | null } | undefined;
    const prevP95 = prev?.p95_ms ?? null;
    const p95 =
      prevP95 == null ? Math.round(durationMs) : Math.round(prevP95 * 0.7 + durationMs * 0.3);
    const prevErr = prev?.error_rate ?? 0;
    const errorRate = Math.min(1, prevErr * 0.8 + (isError ? 1 : 0) * 0.2);
    const samples = (prev?.sample_count ?? 0) + 1;
    db.prepare(
      `INSERT INTO provider_model_speed (model_id, provider_id, p95_ms, error_rate, sample_count, last_tested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id, provider_id) DO UPDATE SET
         p95_ms=excluded.p95_ms,
         error_rate=excluded.error_rate,
         sample_count=excluded.sample_count,
         last_tested_at=excluded.last_tested_at,
         updated_at=excluded.updated_at`
    ).run(modelId, providerId, p95, errorRate, samples, Date.now(), Date.now());
  } catch {
    // telemetry must never break request persistence
  }
}
