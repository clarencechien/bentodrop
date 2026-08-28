import type { DeviceCtx, Env } from "../types";
import { FILE_MAX_BYTES, PUSH_ENVELOPE_MAX, PUSH_TTL_FILE_S, PUSH_TTL_TEXT_S } from "../types";
import { apiError, json, readJson } from "../lib/util";
import { fanoutPush } from "../fanout";

export interface Envelope {
  v: number;
  id: string;
  kind: "text" | "file";
  wrap?: { mode: string; iv: string; cek: string };
  meta?: { iv: string; ct: string } | null;
  iv?: string | null;
  ct?: string | null;
  obj?: string | null;
  size?: number;
  ts?: number;
  plain?: boolean; // §12.4 plaintext mode marker
  text?: string;   // plaintext mode only
}

export function validEnvelopeShape(e: unknown): e is Envelope {
  if (typeof e !== "object" || e === null) return false;
  const env = e as Envelope;
  if (env.v !== 1) return false;
  if (typeof env.id !== "string" || env.id.length < 10 || env.id.length > 64) return false;
  if (env.kind !== "text" && env.kind !== "file") return false;
  return true;
}

export async function retentionMs(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT retention_days FROM users WHERE user_id = ?")
    .bind(userId).first<{ retention_days: number }>();
  return (row?.retention_days ?? 7) * 24 * 3600 * 1000;
}

/**
 * POST /api/send (device auth) — §3.1 text path and §3.2 file completion.
 * With `to` set, delivers to a CONTACT instead of the sender's own devices
 * (§11): the envelope must be ecdh-p256-wrapped, and the RECIPIENT must
 * still list the sender as a contact (that's the block switch).
 */
export async function handleSend(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ envelope?: unknown; to?: string }>(req);
  const envelope = body?.envelope;
  if (!validEnvelopeShape(envelope)) return apiError(400, "bad_envelope");
  if (envelope.plain) return apiError(400, "bad_envelope", "plaintext mode is API-token only");
  if (!envelope.wrap || typeof envelope.wrap.cek !== "string") return apiError(400, "bad_envelope", "missing wrap");

  let toUser = device.userId;
  let fromUser: string | null = null;
  let fromLabel: string | null = device.label;
  if (typeof body?.to === "string" && body.to !== device.userId) {
    if (envelope.wrap.mode !== "ecdh-p256") {
      return apiError(400, "bad_envelope", "cross-user envelopes must use wrap.mode ecdh-p256");
    }
    // Authorization runs against the RECIPIENT's contact list (§11).
    const rel = await env.DB.prepare(
      "SELECT label FROM contacts WHERE user_id = ? AND peer_user_id = ?",
    ).bind(body.to, device.userId).first<{ label: string }>();
    if (!rel) return apiError(403, "not_contact", "對方尚未加你為好友,或已解除");
    toUser = body.to;
    fromUser = device.userId;
    fromLabel = rel.label; // how the recipient names the sender
  }

  const now = Date.now();
  const encoded = JSON.stringify(envelope);
  let sizeBytes: number | null = null;
  let r2Key: string | null = null;
  let ttl = PUSH_TTL_TEXT_S;

  if (envelope.kind === "text") {
    if (typeof envelope.ct !== "string" || envelope.obj) return apiError(400, "bad_envelope", "text needs ct, no obj");
    // §3.1: the whole envelope must fit in a ~4KB push payload.
    if (encoded.length > PUSH_ENVELOPE_MAX) {
      return apiError(413, "too_large", "text envelope exceeds push payload budget — use the file path");
    }
  } else {
    // §3.2 / §4.3: verify the object really exists and matches the declared size.
    // File envelopes also ride in push payloads (pointer + optional encrypted
    // thumbnail), so they share the ~4KB budget.
    if (encoded.length > PUSH_ENVELOPE_MAX) return apiError(413, "too_large", "envelope exceeds push payload budget");
    if (typeof envelope.obj !== "string" || envelope.ct) return apiError(400, "bad_envelope", "file needs obj, no ct");
    const expectedPrefix = `u/${device.userId}/inbox/`;
    if (!envelope.obj.startsWith(expectedPrefix)) return apiError(403, "forbidden_key");
    if (typeof envelope.size !== "number" || envelope.size <= 0 || envelope.size > FILE_MAX_BYTES) {
      return apiError(400, "bad_size");
    }
    const head = await env.INBOX.head(envelope.obj);
    if (!head) return apiError(409, "object_missing", "上傳尚未完成");
    if (head.size !== envelope.size) {
      await env.INBOX.delete(envelope.obj);
      return apiError(409, "size_mismatch", "實際大小與宣告不符,物件已刪除");
    }
    sizeBytes = head.size;
    r2Key = envelope.obj;
    ttl = PUSH_TTL_FILE_S;
  }

  // Retention follows the RECIPIENT's setting (§10.2).
  const expiresAt = now + (await retentionMs(env, toUser));
  await env.DB.prepare(
    `INSERT INTO messages (msg_id, user_id, from_device, from_user, kind, envelope, r2_key, size_bytes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(envelope.id, toUser, device.deviceId, fromUser, envelope.kind, encoded, r2Key, sizeBytes, expiresAt, now).run();

  const receipts = await fanoutPush(
    env, toUser,
    { t: "msg", from: fromLabel, msgId: envelope.id, envelope, contact: fromUser !== null },
    ttl, fromUser === null ? device.deviceId : undefined,
  );
  // Don't leak a contact's device ids/names back to the sender.
  const visible = fromUser === null
    ? receipts
    : receipts.map((r, i) => ({ deviceId: `peer-${i + 1}`, label: null, ok: r.ok, status: r.status }));
  return json({ msgId: envelope.id, expiresAt, receipts: visible });
}

/** GET /api/messages (device auth) — inbox pull (§10.1: open-time refresh, no tombstones). */
export async function listMessages(env: Env, device: DeviceCtx): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.msg_id, m.from_device, m.from_user, m.via_token, m.kind, m.envelope, m.size_bytes, m.expires_at, m.read_at, m.created_at,
            d.label AS from_label, t.label AS token_label, c.label AS contact_label
       FROM messages m
       LEFT JOIN devices d ON d.device_id = m.from_device
       LEFT JOIN api_tokens t ON t.token_id = m.via_token
       LEFT JOIN contacts c ON c.user_id = m.user_id AND c.peer_user_id = m.from_user
      WHERE m.user_id = ? AND m.expires_at > ?
      ORDER BY m.created_at DESC LIMIT 200`,
  ).bind(device.userId, Date.now()).all();
  return json({
    messages: (rows.results ?? []).map((r: any) => ({
      msgId: r.msg_id,
      kind: r.kind,
      envelope: JSON.parse(r.envelope),
      // Cross-user messages show under MY label for the sender, never the
      // sender's own device names.
      from: r.from_user !== null ? (r.contact_label ?? "已解除的好友") : (r.from_label ?? r.token_label ?? null),
      fromContact: r.from_user !== null,
      viaToken: r.via_token !== null,
      sizeBytes: r.size_bytes,
      expiresAt: r.expires_at,
      readAt: r.read_at,
      createdAt: r.created_at,
    })),
  });
}

/** POST /api/messages/:id/read — §10: read marks, never deletes. */
export async function markRead(env: Env, device: DeviceCtx, msgId: string): Promise<Response> {
  const res = await env.DB.prepare(
    "UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE msg_id = ? AND user_id = ? RETURNING read_at",
  ).bind(Date.now(), msgId, device.userId).first<{ read_at: number }>();
  if (!res) return apiError(404, "not_found", "這則訊息已被刪除");
  return json({ readAt: res.read_at });
}

/** DELETE /api/messages/:id — §10.1 global delete (row + R2 object). */
export async function deleteMessage(env: Env, device: DeviceCtx, msgId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "DELETE FROM messages WHERE msg_id = ? AND user_id = ? RETURNING r2_key",
  ).bind(msgId, device.userId).first<{ r2_key: string | null }>();
  if (!row) return apiError(404, "not_found", "這則訊息已被刪除");
  if (row.r2_key) await env.INBOX.delete(row.r2_key);
  return json({ ok: true });
}

/** DELETE /api/messages — clear everything for this user. */
export async function clearMessages(env: Env, device: DeviceCtx): Promise<Response> {
  const rows = await env.DB.prepare(
    "DELETE FROM messages WHERE user_id = ? RETURNING r2_key",
  ).bind(device.userId).all<{ r2_key: string | null }>();
  const keys = (rows.results ?? []).map((r) => r.r2_key).filter((k): k is string => !!k);
  if (keys.length) await env.INBOX.delete(keys);
  return json({ deleted: rows.results?.length ?? 0 });
}
