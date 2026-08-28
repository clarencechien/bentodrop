// Test helpers: a simulated client device (using the REAL client crypto from
// public/js/crypto.js) and an RFC 8291 receiver so tests can decrypt the
// actual Web Push bodies the Worker sends.

import { SELF } from "cloudflare:test";
// The same module the PWA ships — tests exercise production client crypto.
// @ts-expect-error plain JS module without types
import * as C from "../public/js/crypto.js";

export { C };

export const te = new TextEncoder();
export const td = new TextDecoder();

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  return C.b64u(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
export function unb64u(s: string): Uint8Array {
  return C.unb64u(s);
}

export async function apiFetch(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; raw?: BodyInit } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return SELF.fetch(`https://bentodrop.test${path}`, {
    method: opts.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
  });
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface TestDevice {
  userId: string;
  deviceId: string;
  token: string;
  label: string;
  userName: string;
  entropy: Uint8Array;
  kMaster: CryptoKey;
  // push subscription receiver keys
  push?: {
    endpoint: string;
    p256dh: string;
    auth: string;
    privateKey: CryptoKey;
    publicRaw: Uint8Array;
    authSecret: Uint8Array;
  };
}

/** Register a fresh user + first device through the real API. */
export async function createDevice(label = "Pixel", userName = "clarence"): Promise<TestDevice> {
  const entropy = C.generateEntropy();
  const kMaster = await C.deriveKmaster(entropy, userName);
  const identity = await C.generateEcdhPair();
  const res = await apiFetch("/api/register", { body: { label, pubkey_jwk: identity.publicJwk } });
  if (res.status !== 200) throw new Error(`register failed: ${res.status}`);
  const data = await json(res);
  return {
    userId: data.userId,
    deviceId: data.deviceId,
    token: data.deviceToken,
    label,
    userName,
    entropy,
    kMaster,
  };
}

/** Generate browser-side push subscription keys and register them. */
export async function subscribeDevice(dev: TestDevice, endpointHost = "https://push.test"): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `${endpointHost}/sub/${dev.deviceId}`;
  const res = await apiFetch("/api/subscribe", {
    token: dev.token,
    body: { endpoint, keys: { p256dh: b64u(publicRaw), auth: b64u(authSecret) } },
  });
  if (res.status !== 200) throw new Error(`subscribe failed: ${res.status}`);
  dev.push = {
    endpoint,
    p256dh: b64u(publicRaw),
    auth: b64u(authSecret),
    privateKey: pair.privateKey,
    publicRaw,
    authSecret,
  };
  return dev;
}

/**
 * Add a second device to `owner`'s user by running the REAL pairing flow
 * (§6.6) end to end: create → claim → approve (wrap K_master) → finish →
 * unwrap. Returns the new device with its own working kMaster.
 */
export async function pairNewDevice(owner: TestDevice, label = "MacBook"): Promise<TestDevice> {
  const created = await json(await apiFetch("/api/pair/create", { method: "POST", token: owner.token, body: {} }));
  const newKeys = await C.generateEcdhPair();
  const claim = await apiFetch("/api/pair/claim", {
    body: { pairId: created.pairId, code: created.code, pubkey_jwk: newKeys.publicJwk, label },
  });
  if (claim.status !== 200) throw new Error(`claim failed ${claim.status}`);

  const status = await json(await apiFetch(`/api/pair/${created.pairId}/status`, { token: owner.token }));
  if (!status.claimed) throw new Error("not claimed");
  const oldKeys = await C.generateEcdhPair();
  const wrapped = await C.wrapForPeer(oldKeys.privateKey, status.newPubkey, {
    entropy: C.b64u(owner.entropy),
    userName: owner.userName,
  });
  const approve = await apiFetch(`/api/pair/${created.pairId}/approve`, {
    token: owner.token,
    body: { wrapped_blob: wrapped, old_pubkey: oldKeys.publicJwk },
  });
  if (approve.status !== 200) throw new Error(`approve failed ${approve.status}`);

  const finish = await json(await apiFetch("/api/pair/finish", {
    body: { pairId: created.pairId, code: created.code },
  }));
  const secret = await C.unwrapFromPeer(newKeys.privateKey, finish.oldPubkey, finish.wrappedBlob);
  const entropy = C.unb64u(secret.entropy);
  return {
    userId: finish.userId,
    deviceId: finish.deviceId,
    token: finish.deviceToken,
    label,
    userName: secret.userName,
    entropy,
    kMaster: await C.deriveKmaster(entropy, secret.userName),
  };
}

export interface UserIdentity {
  publicJwk: any;
  privateKey: CryptoKey;
}

/** Publish a user-level identity (§5.2) the way the app's bootstrap does. */
export async function setupIdentity(dev: TestDevice): Promise<UserIdentity> {
  const pair = await C.generateIdentityPair();
  const wrapped = await C.encryptJson(dev.kMaster, pair.privateJwk);
  const res = await apiFetch("/api/identity", {
    token: dev.token,
    body: { identity_pub: pair.publicJwk, identity_priv_wrapped: wrapped },
  });
  if (res.status !== 200) throw new Error(`setIdentity failed ${res.status}`);
  const stored = await json(res);
  // On a race another device may have won — always use the stored pair.
  const privJwk = await C.decryptJson(dev.kMaster, stored.identityPrivWrapped);
  return {
    publicJwk: stored.identityPub,
    privateKey: await C.importIdentityPrivate(privJwk),
  };
}

/** Run the full §6.7 add-friend flow between two users via the real API. */
export async function makeFriends(
  a: TestDevice, b: TestDevice, aName = "阿明", bName = "小美",
): Promise<{ aIdentity: UserIdentity; bIdentity: UserIdentity }> {
  const aIdentity = await setupIdentity(a);
  const bIdentity = await setupIdentity(b);
  const inv = await json(await apiFetch("/api/contacts/invite", { token: a.token, body: { myName: aName } }));
  const claim = await apiFetch("/api/contacts/claim", {
    token: b.token, body: { pairId: inv.pairId, code: inv.code, myName: bName },
  });
  if (claim.status !== 200) throw new Error(`contact claim failed ${claim.status}`);
  const approve = await apiFetch(`/api/contacts/invite/${inv.pairId}/approve`, { token: a.token, body: {} });
  if (approve.status !== 200) throw new Error(`contact approve failed ${approve.status}`);
  return { aIdentity, bIdentity };
}

export interface CapturedPush {
  url: string;
  ttl: string | null;
  authorization: string | null;
  contentEncoding: string | null;
  body: string; // base64 of the aes128gcm body
}

/** Drain the push requests captured by the fake push service (vitest.config.mts). */
export async function drainPushes(): Promise<CapturedPush[]> {
  const res = await fetch("https://push-sink.test/__captured");
  return (await res.json()) as CapturedPush[];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decrypt a captured push for `dev` and parse the JSON payload. */
export async function openPush(dev: TestDevice, captured: CapturedPush): Promise<any> {
  return JSON.parse(await decryptPushBody(dev, b64ToBytes(captured.body)));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  ));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** RFC 8291 receiver: decrypt an aes128gcm push body with the UA keys. */
export async function decryptPushBody(dev: TestDevice, body: Uint8Array): Promise<string> {
  if (!dev.push) throw new Error("device has no push keys");
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const asKey = await crypto.subtle.importKey(
    "raw", asPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    dev.push.privateKey,
    256,
  ));
  const keyInfo = concat(te.encode("WebPush: info\0"), dev.push.publicRaw, asPublic);
  const ikm = await hkdf(dev.push.authSecret, ecdhSecret, keyInfo, 32);
  const cekBytes = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const cek = await crypto.subtle.importKey("raw", cekBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource }, cek, ciphertext as BufferSource,
  ));
  // Strip the padding delimiter (0x02 for the last record) and trailing zeros.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 2) throw new Error("bad padding delimiter");
  return td.decode(record.slice(0, end));
}
