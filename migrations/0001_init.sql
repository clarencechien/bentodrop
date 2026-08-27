-- BentoDrop D1 schema (spec §4.2, §6.6, §12.5)

CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,     -- random ULID, not PII
  retention_days INTEGER NOT NULL DEFAULT 7,  -- §10.2: 1 / 7 / 30
  created_at     INTEGER NOT NULL
);

CREATE TABLE devices (
  device_id     TEXT PRIMARY KEY,      -- random ULID
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  label         TEXT,
  pubkey_jwk    TEXT NOT NULL,         -- ECDH P-256 public key (reserved for v2 cross-user)
  token_hash    TEXT NOT NULL,         -- SHA-256 of the device bearer token
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX idx_dev_user ON devices(user_id);

CREATE TABLE subscriptions (
  device_id   TEXT PRIMARY KEY REFERENCES devices(device_id),
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sub_device ON subscriptions(device_id);

CREATE TABLE messages (
  msg_id       TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  from_device  TEXT,
  via_token    TEXT,                   -- api token id when sent through /api/push
  kind         TEXT NOT NULL,          -- 'text' | 'file'
  envelope     TEXT NOT NULL,          -- ciphertext envelope JSON (§5.3); plaintext-mode marks plain:true
  r2_key       TEXT,                   -- kind='file' only
  size_bytes   INTEGER,
  expires_at   INTEGER NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_msg_user_unread ON messages(user_id, read_at);
CREATE INDEX idx_msg_expiry ON messages(expires_at);

-- §6.6 / §6.7 temporary pairing data
CREATE TABLE pairings (
  pair_id       TEXT PRIMARY KEY,      -- appears in URL
  kind          TEXT NOT NULL,         -- 'device' | 'contact'
  owner_user    TEXT NOT NULL REFERENCES users(user_id),
  code_hash     TEXT NOT NULL,         -- hash of the pairing code, never the code itself
  new_pubkey    TEXT,                  -- new device's ephemeral public key
  new_label     TEXT,
  approved_at   INTEGER,               -- old device confirmed the request (§6.6)
  wrapped_blob  TEXT,                  -- K_master wrapped by the old device
  old_pubkey    TEXT,                  -- old device's ephemeral public key
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed_at   INTEGER,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_pair_expiry ON pairings(expires_at);
CREATE INDEX idx_pair_owner ON pairings(owner_user, created_at);

-- §12.5 API tokens (send-only)
CREATE TABLE api_tokens (
  token_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  token_hash   TEXT NOT NULL,          -- hash only; the token itself is shown once
  label        TEXT NOT NULL,
  plaintext_ok INTEGER NOT NULL DEFAULT 0,   -- §12.4 plaintext mode (text-only)
  rate_limit   INTEGER NOT NULL DEFAULT 60,  -- per hour
  last_used_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_tok_user ON api_tokens(user_id);
CREATE INDEX idx_tok_hash ON api_tokens(token_hash);
