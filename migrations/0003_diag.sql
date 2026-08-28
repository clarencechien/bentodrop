-- Transport diagnostics (settings page): per-device rate limiting.
CREATE TABLE diag_runs (
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'env' (one per full run) | 'upload'
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_diag_dev ON diag_runs(device_id, kind, created_at);
