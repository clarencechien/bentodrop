// §3.2 file path. R2 presigned URLs need S3 credentials, which would break
// the zero-config GitHub-integration deploy, so the Worker signs its own
// short-lived URLs (HMAC) and streams the ciphertext through the free
// Worker↔R2 path instead. Semantics match the spec: the client PUTs the
// ciphertext to a URL with a 10-minute TTL and a declared size that is
// enforced server-side (§4.3).

import type { DeviceCtx, Env } from "../types";
import { DOWNLOAD_URL_TTL_S, FILE_MAX_BYTES, UPLOAD_URL_TTL_S } from "../types";
import { apiError, hmacSign, json, readJson, timingSafeEqual } from "../lib/util";

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
    const expected = await hmacSign(env.URL_SIGNING_SECRET, `PUT|${key}|${exp}|${size}`);
    if (!timingSafeEqual(expected, sig)) return apiError(403, "bad_signature");
    if (size <= 0 || size > FILE_MAX_BYTES) return apiError(400, "bad_size");
    const bytes = new Uint8Array(await req.arrayBuffer());
    // §4.3: the actual upload must match the declared size exactly.
    if (bytes.byteLength !== size) return apiError(409, "size_mismatch", "上傳大小與宣告不符");
    await env.INBOX.put(key, bytes as unknown as ArrayBuffer);
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
