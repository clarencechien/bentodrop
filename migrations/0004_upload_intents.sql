-- Merged upload flow (README 優化 TODO #2): the envelope travels with the
-- sign request; PUT completion finalizes the message and fans out push,
-- turning sign→PUT→send (3 RTTs) into intent→PUT (2 RTTs).
CREATE TABLE upload_intents (
  intent_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,          -- sender
  device_id   TEXT NOT NULL,
  to_user     TEXT NOT NULL,          -- recipient (same as user_id for self)
  from_user   TEXT,                   -- NULL for self sends
  from_label  TEXT,
  envelope    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_intent_expiry ON upload_intents(expires_at);
