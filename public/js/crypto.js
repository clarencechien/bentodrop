// BentoDrop client-side crypto (§5, §6.2).
// Everything here runs on the device; the Worker only ever sees ciphertext.
// Plain ES module with zero dependencies so it loads in the PWA, the service
// worker (via importScripts-free module SW is not universal, so sw.js inlines
// what it needs), and vitest.

import { WORDLIST } from "./wordlist.js";

const subtle = globalThis.crypto.subtle;
export const te = new TextEncoder();
export const td = new TextDecoder();

// ── base64url ─────────────────────────────────────────────────────────
export function b64u(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── ULID ──────────────────────────────────────────────────────────────
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()) {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ULID_ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let rs = "";
  for (let i = 0; i < 16; i++) rs += ULID_ALPHABET[rand[i] % 32];
  return ts + rs;
}

// ── BIP39 (English wordlist, 128-bit entropy → 12 words) — §6.2 ──────
export function generateEntropy() {
  return crypto.getRandomValues(new Uint8Array(16)); // 128 bits
}

function bytesToBits(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return bits;
}

export async function entropyToMnemonic(entropy) {
  if (entropy.length !== 16) throw new Error("entropy must be 128 bits");
  const digest = new Uint8Array(await subtle.digest("SHA-256", entropy));
  // 128-bit entropy → 4-bit checksum → 132 bits → 12 words of 11 bits.
  const bits = bytesToBits(entropy) + bytesToBits(digest).slice(0, 4);
  const words = [];
  for (let i = 0; i < 12; i++) {
    words.push(WORDLIST[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  }
  return words;
}

/** Returns the entropy bytes, or throws on unknown word / bad checksum. */
export async function mnemonicToEntropy(words) {
  if (words.length !== 12) throw new Error("需要 12 個詞");
  let bits = "";
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    const idx = WORDLIST.indexOf(w);
    if (idx === -1) throw new Error(`不在詞庫中:${w}`);
    bits += idx.toString(2).padStart(11, "0");
  }
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 16; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const digest = new Uint8Array(await subtle.digest("SHA-256", entropy));
  const checksum = bytesToBits(digest).slice(0, 4);
  if (bits.slice(128) !== checksum) throw new Error("檢查碼不符,請確認抄寫是否正確");
  return entropy;
}

/** 4-letter prefixes are unique in BIP39 — used for autocomplete (§6.2). */
export function wordCompletions(prefix) {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  return WORDLIST.filter((w) => w.startsWith(p)).slice(0, 8);
}

// ── Key hierarchy (§5.2): entropy --HKDF--> K_master ─────────────────
export async function deriveKmaster(entropy, userName) {
  const ikm = await subtle.importKey("raw", entropy, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: te.encode(`bentodrop-v1:${userName}`),
      info: te.encode("k-master"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

// ── Envelope (§5.3): random CEK per message, wrapped by K_master ─────
async function aesEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv: b64u(iv), ct: b64u(ct) };
}
async function aesDecrypt(key, ivB64, ctB64) {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64u(ivB64) }, key, unb64u(ctB64)));
}

async function makeWrap(kMaster, cekRaw) {
  const { iv, ct } = await aesEncrypt(kMaster, cekRaw);
  return { mode: "self", iv, cek: ct };
}

/** ECDH(secret, pub) → HKDF → AES-256-GCM key. Shared by pairing and envelope wrap. */
async function ecdhDeriveKey(privateKey, peerJwk, salt) {
  const peer = await subtle.importKey("jwk", peerJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const shared = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode(salt), info: te.encode("wrap") },
    shared,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** §11 / §12.3: wrap a CEK for a recipient's identity public key. */
export async function wrapCekForPeer(peerPubJwk, cekRaw) {
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const wrapKey = await ecdhDeriveKey(eph.privateKey, peerPubJwk, "bentodrop-ecdh-v1");
  const { iv, ct } = await aesEncrypt(wrapKey, cekRaw);
  return { mode: "ecdh-p256", epk: await subtle.exportKey("jwk", eph.publicKey), iv, cek: ct };
}

/**
 * `keys` is either a bare K_master CryptoKey (legacy) or a keyring
 * { kMaster?, identityPriv? }. self-wraps need kMaster; ecdh-p256 wraps
 * need the identity private key (§5.2).
 */
async function openWrap(keys, wrap) {
  const ring = keys instanceof CryptoKey ? { kMaster: keys } : (keys ?? {});
  let raw;
  if (wrap.mode === "self") {
    if (!ring.kMaster) throw new Error("missing K_master");
    raw = await aesDecrypt(ring.kMaster, wrap.iv, wrap.cek);
  } else if (wrap.mode === "ecdh-p256") {
    if (!ring.identityPriv) throw new Error("missing identity key");
    const wrapKey = await ecdhDeriveKey(ring.identityPriv, wrap.epk, "bentodrop-ecdh-v1");
    raw = await aesDecrypt(wrapKey, wrap.iv, wrap.cek);
  } else {
    throw new Error(`unsupported wrap.mode: ${wrap.mode}`);
  }
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a short text message (§3.1 path). */
export async function encryptTextEnvelope(kMaster, text, now = Date.now()) {
  const cekRaw = crypto.getRandomValues(new Uint8Array(32));
  const cek = await subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const body = await aesEncrypt(cek, te.encode(text));
  return {
    v: 1,
    id: ulid(now),
    kind: "text",
    wrap: await makeWrap(kMaster, cekRaw),
    meta: null,
    iv: body.iv,
    ct: body.ct,
    obj: null,
    size: 0,
    ts: now,
  };
}

/** Encrypt a text message for a CONTACT's identity public key (§11). */
export async function encryptTextEnvelopeFor(peerPubJwk, text, now = Date.now()) {
  const cekRaw = crypto.getRandomValues(new Uint8Array(32));
  const cek = await subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const body = await aesEncrypt(cek, te.encode(text));
  return {
    v: 1,
    id: ulid(now),
    kind: "text",
    wrap: await wrapCekForPeer(peerPubJwk, cekRaw),
    meta: null,
    iv: body.iv,
    ct: body.ct,
    obj: null,
    size: 0,
    ts: now,
  };
}

/** Encrypt a file for a CONTACT (§11). Uploads still go to the SENDER's prefix. */
export async function encryptFileEnvelopeFor(peerPubJwk, senderUserId, bytes, name, mime, now = Date.now()) {
  const cekRaw = crypto.getRandomValues(new Uint8Array(32));
  const cek = await subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const id = ulid(now);
  const body = await aesEncrypt(cek, bytes);
  const meta = await aesEncrypt(cek, te.encode(JSON.stringify({ name, mime })));
  const ciphertext = unb64u(body.ct);
  return {
    envelope: {
      v: 1,
      id,
      kind: "file",
      wrap: await wrapCekForPeer(peerPubJwk, cekRaw),
      meta: { iv: meta.iv, ct: meta.ct },
      iv: body.iv,
      ct: null,
      obj: `u/${senderUserId}/inbox/${id}`,
      size: ciphertext.byteLength,
      ts: now,
    },
    ciphertext,
  };
}

/**
 * Encrypt a file (§3.2 path). Returns { envelope, ciphertext } — the caller
 * uploads `ciphertext` to the signed URL, then POSTs the envelope to /send.
 * File name and MIME type are encrypted into meta (§5.3).
 */
export async function encryptFileEnvelope(kMaster, userId, bytes, name, mime, now = Date.now()) {
  const cekRaw = crypto.getRandomValues(new Uint8Array(32));
  const cek = await subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const id = ulid(now);
  const body = await aesEncrypt(cek, bytes);
  const meta = await aesEncrypt(cek, te.encode(JSON.stringify({ name, mime })));
  const ciphertext = unb64u(body.ct);
  return {
    envelope: {
      v: 1,
      id,
      kind: "file",
      wrap: await makeWrap(kMaster, cekRaw),
      meta: { iv: meta.iv, ct: meta.ct },
      iv: body.iv,
      ct: null,
      obj: `u/${userId}/inbox/${id}`,
      size: ciphertext.byteLength,
      ts: now,
    },
    ciphertext,
  };
}

/** Decrypt a text envelope → string. */
export async function decryptTextEnvelope(kMaster, envelope) {
  if (envelope.plain) return envelope.text; // §12.4 plaintext mode — nothing to decrypt
  const cek = await openWrap(kMaster, envelope.wrap);
  return td.decode(await aesDecrypt(cek, envelope.iv, envelope.ct));
}

/** Decrypt file metadata → { name, mime }. */
export async function decryptFileMeta(kMaster, envelope) {
  const cek = await openWrap(kMaster, envelope.wrap);
  return JSON.parse(td.decode(await aesDecrypt(cek, envelope.meta.iv, envelope.meta.ct)));
}

/** Decrypt downloaded file ciphertext → bytes. */
export async function decryptFileBody(kMaster, envelope, ciphertext) {
  const cek = await openWrap(kMaster, envelope.wrap);
  return aesDecrypt(cek, envelope.iv, b64u(ciphertext));
}

/** Encrypt/decrypt a small JSON object directly with K_master (e.g. the
 *  identity private key at rest in IndexedDB, §6.5). */
export async function encryptJson(kMaster, obj) {
  return aesEncrypt(kMaster, te.encode(JSON.stringify(obj)));
}
export async function decryptJson(kMaster, { iv, ct }) {
  return JSON.parse(td.decode(await aesDecrypt(kMaster, iv, ct)));
}

// ── Pairing handshake (§6.6): ephemeral ECDH P-256 + HKDF ────────────
export async function generateEcdhPair() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  return { privateKey: pair.privateKey, publicJwk: await subtle.exportKey("jwk", pair.publicKey) };
}

/** User-level identity keypair (§5.2) — private JWK is exported so it can be
 *  wrapped with K_master and synced through the server to sibling devices. */
export async function generateIdentityPair() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  return {
    publicJwk: await subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function importIdentityPrivate(jwk) {
  return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]);
}

function pairSharedKey(privateKey, peerJwk) {
  return ecdhDeriveKey(privateKey, peerJwk, "bentodrop-pair-v1");
}

/** Old device: wrap the secret payload (entropy + userName) for the new device. */
export async function wrapForPeer(privateKey, peerJwk, payloadObj) {
  const key = await pairSharedKey(privateKey, peerJwk);
  const { iv, ct } = await aesEncrypt(key, te.encode(JSON.stringify(payloadObj)));
  return JSON.stringify({ iv, ct });
}

/** New device: unwrap the blob from the old device. */
export async function unwrapFromPeer(privateKey, peerJwk, blobJson) {
  const key = await pairSharedKey(privateKey, peerJwk);
  const { iv, ct } = JSON.parse(blobJson);
  return JSON.parse(td.decode(await aesDecrypt(key, iv, ct)));
}

// ── Content-type detection (§7.2.1): https:// whitelist only ─────────
export function detectTextKind(text) {
  const trimmed = text.trim();
  if (/^https:\/\/\S+$/.test(trimmed)) return { kind: "url", url: trimmed };
  const urls = [...text.matchAll(/https:\/\/\S+/g)].map((m) => m[0]);
  if (urls.length) return { kind: "text-with-urls", urls };
  return { kind: "text" };
}
