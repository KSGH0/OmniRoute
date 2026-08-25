/**
 * provider_model_speed — per-model provider speed ranking for ranked autobalance (F1).
 * Speed-only: p95_ms + errorRate*1000 rank. Additive, never filters catalog.
 */

import { getDbInstance, rowToCamel } from "./core";
import { invalidateDbCache } from "./readCache";

export type ProviderModelSpeed = {
  modelId: string;
  providerId: string;
  p95Ms: number | null;
  errorRate: number;
  sampleCount: number;
  lastTestedAt: number | null;
  updatedAt: number | null;
};

export function upsertProviderModelSpeed(entry: {
  modelId: string;
  providerId: string;
  p95Ms: number | null;
  errorRate?: number;
  sampleCount?: number;
  lastTestedAt?: number | null;
}): void {
  const db = getDbInstance();
  const now = Date.now();
  db.prepare(
    `INSERT INTO provider_model_speed (model_id, provider_id, p95_ms, error_rate, sample_count, last_tested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_id, provider_id) DO UPDATE SET
       p95_ms=excluded.p95_ms,
       error_rate=excluded.error_rate,
       sample_count=excluded.sample_count,
       last_tested_at=excluded.last_tested_at,
       updated_at=excluded.updated_at`
  ).run(
    entry.modelId,
    entry.providerId,
    entry.p95Ms,
    entry.errorRate ?? 0,
    entry.sampleCount ?? 0,
    entry.lastTestedAt ?? null,
    now
  );
  invalidateDbCache("combos");
}

export function getProviderModelSpeed(
  modelId: string,
  providerId: string
): ProviderModelSpeed | null {
  const db = getDbInstance();
  const row = db
    .prepare(`SELECT * FROM provider_model_speed WHERE model_id=? AND provider_id=?`)
    .get(modelId, providerId) as Record<string, unknown> | undefined;
  return row ? (rowToCamel(row) as ProviderModelSpeed) : null;
}

export function listSpeedsForModel(modelId: string): ProviderModelSpeed[] {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT * FROM provider_model_speed WHERE model_id=? ORDER BY (COALESCE(p95_ms, 999999) + COALESCE(error_rate,0)*1000) ASC, updated_at DESC`
    )
    .all(modelId) as Record<string, unknown>[];
  return rows.map((r) => rowToCamel(r) as ProviderModelSpeed);
}

export function deleteProviderModelSpeed(modelId: string, providerId?: string): void {
  const db = getDbInstance();
  if (providerId) {
    db.prepare(`DELETE FROM provider_model_speed WHERE model_id=? AND provider_id=?`).run(
      modelId,
      providerId
    );
  } else {
    db.prepare(`DELETE FROM provider_model_speed WHERE model_id=?`).run(modelId);
  }
  invalidateDbCache("combos");
}

// Alias for readability: rankings = speed table
export const getRankingForModel = listSpeedsForModel;

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
