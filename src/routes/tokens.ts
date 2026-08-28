// §12 API tokens + the script push endpoint.
// Phase 1: tokens are send-only; the plaintext mode (§12.4) is text-only,
// ≤2000 bytes, never touches R2, and must be explicitly enabled per token.

import type { DeviceCtx, Env } from "../types";
import { PLAINTEXT_RETENTION_CAP_MS, PUSH_ENVELOPE_MAX, PUSH_TTL_TEXT_S, TEXT_PLAINTEXT_MAX, RETENTION_ALLOWED } from "../types";
import { apiError, enc, json, randomToken, readJson, sha256hex, ulid } from "../lib/util";
import type { ApiTokenCtx } from "../auth";
import { fanoutPush } from "../fanout";
import { validEnvelopeShape } from "./messages";

/** POST /api/tokens (device auth) */
export async function createToken(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ label?: string; plaintext_ok?: boolean; rate_limit?: number }>(req);
  if (!body?.label || typeof body.label !== "string") return apiError(400, "bad_request", "label required");
  const now = Date.now();
  const tokenId = ulid(now);
  const token = `bd_${randomToken(24)}`;
  const rate = Math.min(Math.max(Number(body.rate_limit ?? 60) || 60, 1), 600);
  await env.DB.prepare(
    "INSERT INTO api_tokens (token_id, user_id, token_hash, label, plaintext_ok, rate_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(tokenId, device.userId, await sha256hex(token), body.label.slice(0, 64), body.plaintext_ok ? 1 : 0, rate, now).run();
  // The token itself is shown exactly once (§12.5).
  return json({ tokenId, token, label: body.label, plaintextOk: !!body.plaintext_ok, rateLimit: rate });
}

/** GET /api/tokens (device auth) — audit list (§12.4). */
export async function listTokens(env: Env, device: DeviceCtx): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT token_id, label, plaintext_ok, rate_limit, last_used_at, revoked_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
  ).bind(device.userId).all();
  return json({
    tokens: (rows.results ?? []).map((r: any) => ({
      tokenId: r.token_id,
      label: r.label,
      plaintextOk: r.plaintext_ok === 1,
      rateLimit: r.rate_limit,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
    })),
  });
}

/** POST /api/tokens/:id/revoke (device auth) — immediate (§12.5). */
export async function revokeToken(env: Env, device: DeviceCtx, tokenId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ? AND user_id = ? RETURNING token_id",
  ).bind(Date.now(), tokenId, device.userId).first();
  if (!row) return apiError(404, "not_found");
  return json({ ok: true });
}

/** POST /api/push (API-token auth) — the Pushbullet-shaped endpoint (§12). */
export async function handleApiPush(req: Request, env: Env, token: ApiTokenCtx): Promise<Response> {
  const now = Date.now();

  // Per-token hourly rate limit (§12.5).
  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE via_token = ? AND created_at > ?",
  ).bind(token.tokenId, now - 3600_000).first<{ n: number }>();
  if ((used?.n ?? 0) >= token.rateLimit) return apiError(429, "rate_limited");

  const body = await readJson<{ text?: string; envelope?: unknown }>(req);
  if (!body) return apiError(400, "bad_request");

  let envelope: any;
  let kind: "text" = "text";
  if (typeof body.text === "string") {
    // Plaintext mode (§12.4): opt-in per token, text only, ≤2000 bytes, no R2.
    if (!token.plaintextOk) return apiError(403, "plaintext_disabled", "此 token 未啟用明文模式");
    if (enc.encode(body.text).byteLength > TEXT_PLAINTEXT_MAX) return apiError(413, "too_large", "上限 2000 bytes");
    envelope = { v: 1, id: ulid(now), kind, plain: true, text: body.text, ts: now };
  } else if (body.envelope !== undefined) {
    // Public-key mode (§12.3): protocol is live even though Phase 1 ships no CLI.
    const e = body.envelope;
    if (!validEnvelopeShape(e) || e.kind !== "text") return apiError(400, "bad_envelope");
    if (e.plain) return apiError(400, "bad_envelope", "use `text` for plaintext mode");
    if (e.obj) return apiError(403, "no_files", "API tokens 不可上傳檔案");
    if (e.wrap?.mode !== "ecdh-p256") return apiError(400, "bad_envelope", "API envelopes must use wrap.mode ecdh-p256");
    if (JSON.stringify(e).length > PUSH_ENVELOPE_MAX) return apiError(413, "too_large");
    envelope = e;
  } else {
    return apiError(400, "bad_request", "text or envelope required");
  }

  const retention = await env.DB.prepare("SELECT retention_days FROM users WHERE user_id = ?")
    .bind(token.userId).first<{ retention_days: number }>();
  let retentionMs = (retention?.retention_days ?? 7) * 24 * 3600 * 1000;
  // §14: plaintext messages sit unencrypted in D1, so they live at most 24h.
  if (envelope.plain) retentionMs = Math.min(retentionMs, PLAINTEXT_RETENTION_CAP_MS);
  const expiresAt = now + retentionMs;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (msg_id, user_id, via_token, kind, envelope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(envelope.id, token.userId, token.tokenId, kind, JSON.stringify(envelope), expiresAt, now),
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_id = ?").bind(now, token.tokenId),
  ]);

  const receipts = await fanoutPush(
    env, token.userId,
    { t: "msg", from: token.label, msgId: envelope.id, envelope },
    PUSH_TTL_TEXT_S,
  );
  return json({ msgId: envelope.id, receipts });
}

/**
 * GET /api/push/pubkey (API-token auth) — the user's identity PUBLIC key,
 * everything a script needs for §12.3 public-key mode. Send-only stays
 * send-only: a public key reads nothing.
 */
export async function pushPubkey(env: Env, token: ApiTokenCtx): Promise<Response> {
  const row = await env.DB.prepare("SELECT identity_pub FROM users WHERE user_id = ?")
    .bind(token.userId).first<{ identity_pub: string | null }>();
  if (!row?.identity_pub) {
    return apiError(409, "identity_missing", "開啟一次 BentoDrop App 以建立身分金鑰,再重試");
  }
  return json({ identityPub: JSON.parse(row.identity_pub) });
}

/** POST /api/settings (device auth) — retention (§10.2). */
export async function updateSettings(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ retention_days?: number }>(req);
  const days = Number(body?.retention_days);
  if (!RETENTION_ALLOWED.includes(days)) return apiError(400, "bad_retention", "允許 1 / 7 / 30 天");
  await env.DB.prepare("UPDATE users SET retention_days = ? WHERE user_id = ?").bind(days, device.userId).run();
  return json({ retentionDays: days });
}
