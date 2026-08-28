// BentoDrop push CLI core (§12.3 public-key mode + §12.4 plaintext mode).
// Reuses the PWA's own crypto module, so the envelope a script produces is
// byte-for-byte the format the app decrypts. Zero dependencies; needs
// Node 18+ (global fetch + WebCrypto) or any WebCrypto runtime.

import { encryptTextEnvelopeFor } from "../public/js/crypto.js";

async function readJsonOrThrow(res, what) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status}): ${data.message ?? data.error ?? "unknown error"}`);
  }
  return data;
}

/**
 * §12.3: encrypt `text` against the user's identity PUBLIC key and push it.
 * The token can only send; even the sender cannot read the result back.
 */
export async function pushEncrypted({ baseUrl, token, text, fetchFn = fetch }) {
  const headers = { authorization: `Bearer ${token}` };
  const pk = await readJsonOrThrow(
    await fetchFn(`${baseUrl}/api/push/pubkey`, { headers }), "fetch pubkey",
  );
  const envelope = await encryptTextEnvelopeFor(pk.identityPub, text);
  return readJsonOrThrow(
    await fetchFn(`${baseUrl}/api/push`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    }),
    "push",
  );
}

/** §12.4: plaintext mode — only works on tokens created with it enabled. */
export async function pushPlaintext({ baseUrl, token, text, fetchFn = fetch }) {
  return readJsonOrThrow(
    await fetchFn(`${baseUrl}/api/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
    "push",
  );
}
