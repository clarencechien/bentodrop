// Web Push from the Worker, with no third-party dependencies:
//  - RFC 8291 message encryption (aes128gcm)
//  - RFC 8292 VAPID (ES256 JWT)
// The payload we encrypt here is already an E2E-encrypted envelope; this layer
// is the push transport's own encryption, required by the push services.

import { b64urlDecode, b64urlEncode, enc } from "./util";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string; // base64url, uncompressed P-256 point (65 bytes)
  auth: string;   // base64url, 16-byte auth secret
}

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** RFC 8291: encrypt `plaintext` for a push subscription. Returns the aes128gcm body. */
export async function encryptPushPayload(
  plaintext: Uint8Array, p256dh: string, auth: string,
): Promise<Uint8Array> {
  const uaPublicBytes = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);

  const asKeys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  )) as CryptoKeyPair;
  const asPublicBytes = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublicBytes as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ecdhSecret = new Uint8Array(
    // workers-types spells the standard `public` param as `$public`; the runtime uses `public`.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asKeys.privateKey,
      256,
    ),
  );

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const cek = await crypto.subtle.importKey("raw", cekBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the final (only) record.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, cek, record as BufferSource),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublicBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // rs
  header[20] = asPublicBytes.length;               // idlen
  header.set(asPublicBytes, 21);
  return concat(header, ciphertext);
}

/** RFC 8292: build the `Authorization: vapid ...` header for an endpoint origin. */
export async function vapidAuthHeader(
  endpoint: string, publicKeyB64url: string, privateJwkJson: string, subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk", JSON.parse(privateJwkJson), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(signingInput),
  ));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${publicKeyB64url}`;
}

export interface PushSendResult {
  ok: boolean;
  status: number;
  gone: boolean; // 404/410 — the subscription is dead (§8.3)
}

export async function sendWebPush(
  sub: PushSubscriptionRow,
  payload: Uint8Array,
  ttlSeconds: number,
  vapid: { publicKey: string; privateJwk: string; subject: string },
): Promise<PushSendResult> {
  const body = await encryptPushPayload(payload, sub.p256dh, sub.auth);
  const auth = await vapidAuthHeader(sub.endpoint, vapid.publicKey, vapid.privateJwk, vapid.subject);
  let res: Response;
  try {
    res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: auth,
        TTL: String(ttlSeconds),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Urgency: "high",
      },
      body: body as unknown as BodyInit,
    });
  } catch {
    return { ok: false, status: 0, gone: false };
  }
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
