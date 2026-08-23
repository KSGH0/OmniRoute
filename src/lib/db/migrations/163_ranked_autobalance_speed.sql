-- Ranked autobalance (speed-only) — F1
-- Stores per-model provider speed ranking for auto-rerank. No catalog filtering, just ordering.
-- Additive only; does not hide any provider/model from /v1/models.

CREATE TABLE IF NOT EXISTS provider_model_speed (
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  p95_ms INTEGER,
  error_rate REAL DEFAULT 0,
  sample_count INTEGER DEFAULT 0,
  last_tested_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (model_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_model_speed_model ON provider_model_speed(model_id);
CREATE INDEX IF NOT EXISTS idx_provider_model_speed_updated ON provider_model_speed(updated_at);
