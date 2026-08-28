// §3.2 file path. R2 presigned URLs need S3 credentials, which would break
// the zero-config GitHub-integration deploy, so the Worker signs its own
// short-lived URLs (HMAC) and streams the ciphertext through the free
// Worker↔R2 path instead. Semantics match the spec: the client PUTs the
// ciphertext to a URL with a 10-minute TTL and a declared size that is
// enforced server-side (§4.3).

import type { DeviceCtx, Env } from "../types";
import { DOWNLOAD_URL_TTL_S, FILE_MAX_BYTES, PUSH_ENVELOPE_MAX, PUSH_TTL_FILE_S, UPLOAD_URL_TTL_S } from "../types";
import { apiError, hmacSign, json, readJson, timingSafeEqual, ulid } from "../lib/util";
import { fanoutPush } from "../fanout";
import { retentionMs, validEnvelopeShape } from "./messages";

function objectKey(userId: string, msgId: string): string {
  return `u/${userId}/inbox/${msgId}`;
}

/** POST /api/upload-url (device auth) {msgId, size} */
export async function createUploadUrl(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ msgId?: string; size?: number }>(req);
  if (!body?.msgId || !/^[A-Za-z0-9_-]{10,64}$/.test(body.msgId)) return apiError(400, "bad_request");
  if (typeof body.size !== "number" || body.size <= 0) return apiError(400, "bad_size");
  if (body.size > FILE_MAX_BYTES) return apiError(413, "too_large", "上限 20 MB");

  const key = objectKey(device.userId, body.msgId);
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_S;
  const sig = await hmacSign(env.URL_SIGNING_SECRET, `PUT|${key}|${exp}|${body.size}`);
  return json({
    key,
    url: `/api/object/${key}?exp=${exp}&size=${body.size}&sig=${sig}`,
    expiresAt: exp * 1000,
  });
}

/**
 * POST /api/upload-intent (device auth) {envelope, to?} — merged upload flow.
 * The file envelope is validated and parked NOW; the returned PUT URL carries
 * the intent id inside its HMAC, and completing that PUT finalizes the
 * message (row + push fan-out) in the same round trip. The classic
 * upload-url → PUT → send flow stays fully supported for older clients.
 */
export async function createUploadIntent(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ envelope?: unknown; to?: string }>(req);
  const envelope = body?.envelope;
  if (!validEnvelopeShape(envelope)) return apiError(400, "bad_envelope");
  if (envelope.kind !== "file") return apiError(400, "bad_envelope", "upload-intent is for files");
  if (envelope.plain) return apiError(400, "bad_envelope");
  if (!envelope.wrap || typeof envelope.wrap.cek !== "string") return apiError(400, "bad_envelope", "missing wrap");
  if (typeof envelope.obj !== "string" || envelope.ct) return apiError(400, "bad_envelope", "file needs obj, no ct");
  if (!envelope.obj.startsWith(`u/${device.userId}/inbox/`)) return apiError(403, "forbidden_key");
  if (typeof envelope.size !== "number" || envelope.size <= 0 || envelope.size > FILE_MAX_BYTES) {
    return apiError(400, "bad_size");
  }
  if (JSON.stringify(envelope).length > PUSH_ENVELOPE_MAX) {
    return apiError(413, "too_large", "envelope exceeds push payload budget");
  }

  let toUser = device.userId;
  let fromUser: string | null = null;
  let fromLabel: string | null = device.label;
  if (typeof body?.to === "string" && body.to !== device.userId) {
    if (envelope.wrap.mode !== "ecdh-p256") {
      return apiError(400, "bad_envelope", "cross-user envelopes must use wrap.mode ecdh-p256");
    }
    const rel = await env.DB.prepare(
      "SELECT label FROM contacts WHERE user_id = ? AND peer_user_id = ?",
    ).bind(body.to, device.userId).first<{ label: string }>();
    if (!rel) return apiError(403, "not_contact", "對方尚未加你為好友,或已解除");
    toUser = body.to;
    fromUser = device.userId;
    fromLabel = rel.label;
  }

  const now = Date.now();
  const intentId = ulid(now);
  await env.DB.prepare(
    `INSERT INTO upload_intents (intent_id, user_id, device_id, to_user, from_user, from_label, envelope, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(intentId, device.userId, device.deviceId, toUser, fromUser, fromLabel,
    JSON.stringify(envelope), now, now + UPLOAD_URL_TTL_S * 1000).run();

  const key = envelope.obj;
  const exp = Math.floor(now / 1000) + UPLOAD_URL_TTL_S;
  const sig = await hmacSign(env.URL_SIGNING_SECRET, `PUT|${key}|${exp}|${envelope.size}|${intentId}`);
  return json({
    intentId,
    key,
    url: `/api/object/${key}?exp=${exp}&size=${envelope.size}&intent=${intentId}&sig=${sig}`,
    expiresAt: exp * 1000,
  });
}

/** Finalize a merged upload after its bytes landed: insert + fan out. */
async function finalizeIntent(env: Env, intentId: string, key: string, actualSize: number): Promise<Response> {
  const now = Date.now();
  // Single-use burn — only one PUT can win.
  const intent = await env.DB.prepare(
    "UPDATE upload_intents SET consumed_at = ? WHERE intent_id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *",
  ).bind(now, intentId, now).first<{
    user_id: string; device_id: string; to_user: string; from_user: string | null;
    from_label: string | null; envelope: string;
  }>();
  if (!intent) {
    await env.INBOX.delete(key);
    return apiError(410, "intent_expired", "上傳單已過期,請重試");
  }
  const envelope = JSON.parse(intent.envelope);
  if (envelope.obj !== key || envelope.size !== actualSize) {
    await env.INBOX.delete(key);
    return apiError(409, "size_mismatch", "實際大小與宣告不符,物件已刪除");
  }
  if (intent.from_user !== null) {
    // Cross-user: the recipient may have unfriended between intent and PUT.
    const rel = await env.DB.prepare(
      "SELECT 1 FROM contacts WHERE user_id = ? AND peer_user_id = ?",
    ).bind(intent.to_user, intent.from_user).first();
    if (!rel) {
      await env.INBOX.delete(key);
      return apiError(403, "not_contact");
    }
  }

  const expiresAt = now + (await retentionMs(env, intent.to_user));
  await env.DB.prepare(
    `INSERT INTO messages (msg_id, user_id, from_device, from_user, kind, envelope, r2_key, size_bytes, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`,
  ).bind(envelope.id, intent.to_user, intent.device_id, intent.from_user, intent.envelope, key, actualSize, expiresAt, now).run();

  const receipts = await fanoutPush(
    env, intent.to_user,
    { t: "msg", from: intent.from_label, msgId: envelope.id, envelope, contact: intent.from_user !== null },
    PUSH_TTL_FILE_S, intent.from_user === null ? intent.device_id : undefined,
  );
  const visible = intent.from_user === null
    ? receipts
    : receipts.map((r, i) => ({ deviceId: `peer-${i + 1}`, label: null, ok: r.ok, status: r.status }));
  return json({ ok: true, size: actualSize, msgId: envelope.id, expiresAt, receipts: visible });
}

/** GET /api/download-url?key=... (device auth) */
export async function createDownloadUrl(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key.startsWith(`u/${device.userId}/inbox/`)) {
    // §11: a file from a contact lives under the SENDER's prefix — allow it
    // only when it backs a message actually addressed to me.
    const mine = await env.DB.prepare(
      "SELECT 1 FROM messages WHERE user_id = ? AND r2_key = ?",
    ).bind(device.userId, key).first();
    if (!mine) return apiError(403, "forbidden_key");
  }
  const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_S;
  const sig = await hmacSign(env.URL_SIGNING_SECRET, `GET|${key}|${exp}`);
  return json({ url: `/api/object/${key}?exp=${exp}&sig=${sig}`, expiresAt: exp * 1000 });
}

/** PUT|GET /api/object/u/... — signed-URL object access. */
export async function handleObject(req: Request, env: Env, key: string): Promise<Response> {
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp") ?? 0);
  const sig = url.searchParams.get("sig") ?? "";
  if (!exp || Math.floor(Date.now() / 1000) > exp) return apiError(403, "url_expired", "連結已過期");

  if (req.method === "PUT") {
    const size = Number(url.searchParams.get("size") ?? -1);
    const intentId = url.searchParams.get("intent");
    // The intent id (when present) is part of the signed message, so a
    // classic URL can't be replayed as a merged-flow one or vice versa.
    const message = intentId ? `PUT|${key}|${exp}|${size}|${intentId}` : `PUT|${key}|${exp}|${size}`;
    const expected = await hmacSign(env.URL_SIGNING_SECRET, message);
    if (!timingSafeEqual(expected, sig)) return apiError(403, "bad_signature");
    if (size <= 0 || size > FILE_MAX_BYTES) return apiError(400, "bad_size");
    const bytes = new Uint8Array(await req.arrayBuffer());
    // §4.3: the actual upload must match the declared size exactly.
    if (bytes.byteLength !== size) return apiError(409, "size_mismatch", "上傳大小與宣告不符");
    await env.INBOX.put(key, bytes as unknown as ArrayBuffer);
    if (intentId) return finalizeIntent(env, intentId, key, bytes.byteLength);
    return json({ ok: true, size: bytes.byteLength });
  }

  if (req.method === "GET") {
    const expected = await hmacSign(env.URL_SIGNING_SECRET, `GET|${key}|${exp}`);
    if (!timingSafeEqual(expected, sig)) return apiError(403, "bad_signature");
    const obj = await env.INBOX.get(key);
    if (!obj) return apiError(404, "not_found", "這則訊息已被刪除");
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(obj.size),
        "cache-control": "private, no-store",
      },
    });
  }

  return apiError(405, "method_not_allowed");
}
