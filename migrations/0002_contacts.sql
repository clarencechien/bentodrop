-- Phase 2 (§11): cross-user contacts + user-level identity keys (§5.2).
-- identity_priv_wrapped is the identity PRIVATE key encrypted with K_master
-- on a device — the server stores it but can never read it. Any device of
-- the same user can fetch and unwrap it, which is how all devices share one
-- identity without re-running pairing.

ALTER TABLE users ADD COLUMN identity_pub TEXT;
ALTER TABLE users ADD COLUMN identity_priv_wrapped TEXT;

CREATE TABLE contacts (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  peer_user_id  TEXT NOT NULL,
  peer_pubkey   TEXT NOT NULL,          -- peer's identity public JWK
  label         TEXT NOT NULL,          -- what I call them; editable
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_user_id)
);

-- Cross-user messages record the sending user (NULL = my own device).
ALTER TABLE messages ADD COLUMN from_user TEXT;

-- Contact invites piggyback on pairings (kind='contact'); the JSON payloads
-- in new_pubkey / old_pubkey carry {userId, pub, name}.
