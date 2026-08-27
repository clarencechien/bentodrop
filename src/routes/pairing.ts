// §6.6 device pairing: URL + 6-digit code.
// The three guardrails ARE the security model — TTL 5 min, 3 attempts,
// single use — plus a rate limit of 5 pairings per user per hour.

import type { DeviceCtx, Env } from "../types";
import { PAIR_MAX_ATTEMPTS, PAIR_RATE_PER_HOUR, PAIR_TTL_MS } from "../types";
import { apiError, json, randomToken, readJson, sha256hex, timingSafeEqual, ulid } from "../lib/util";

function pairCodeHash(pairId: string, code: string): Promise<string> {
  // Bind the hash to the pairId so a code can't be replayed across pairings.
  return sha256hex(`${pairId}:${code}`);
}

interface PairRow {
  pair_id: string;
  owner_user: string;
  code_hash: string;
  new_pubkey: string | null;
  new_label: string | null;
  approved_at: number | null;
  wrapped_blob: string | null;
  old_pubkey: string | null;
  attempts: number;
  consumed_at: number | null;
  expires_at: number;
}

async function loadPairing(env: Env, pairId: string): Promise<PairRow | null> {
  return env.DB.prepare("SELECT * FROM pairings WHERE pair_id = ?").bind(pairId).first<PairRow>();
}

/** Shared guardrail check + code verification with attempt counting. */
async function verifyCode(env: Env, row: PairRow, code: string): Promise<Response | null> {
  const now = Date.now();
  if (row.consumed_at !== null) return apiError(410, "pairing_consumed", "此配對已使用過");
  if (now > row.expires_at) return apiError(410, "pairing_expired", "配對已過期");
  if (row.attempts >= PAIR_MAX_ATTEMPTS) return apiError(410, "pairing_locked", "錯誤次數過多,配對已作廢");
  const expected = await pairCodeHash(row.pair_id, code);
  if (!timingSafeEqual(expected, row.code_hash)) {
    const upd = await env.DB.prepare(
      "UPDATE pairings SET attempts = attempts + 1 WHERE pair_id = ? RETURNING attempts",
    ).bind(row.pair_id).first<{ attempts: number }>();
    if ((upd?.attempts ?? 0) >= PAIR_MAX_ATTEMPTS) {
      // Void the whole pairing after the third wrong try (§6.6).
      await env.DB.prepare("UPDATE pairings SET consumed_at = ? WHERE pair_id = ?").bind(Date.now(), row.pair_id).run();
      return apiError(410, "pairing_locked", "錯誤次數過多,配對已作廢");
    }
    return apiError(403, "bad_code", "配對碼錯誤");
  }
  return null;
}

/** POST /api/pair/create (device auth) */
export async function pairCreate(env: Env, device: DeviceCtx): Promise<Response> {
  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pairings WHERE owner_user = ? AND created_at > ?",
  ).bind(device.userId, now - 3600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= PAIR_RATE_PER_HOUR) {
    return apiError(429, "rate_limited", "每小時最多建立 5 個配對");
  }

  const pairId = ulid(now);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.prepare(
    "INSERT INTO pairings (pair_id, kind, owner_user, code_hash, expires_at, created_at) VALUES (?, 'device', ?, ?, ?, ?)",
  ).bind(pairId, device.userId, await pairCodeHash(pairId, code), now + PAIR_TTL_MS, now).run();

  return json({ pairId, code, expiresAt: now + PAIR_TTL_MS });
}

/** POST /api/pair/claim (no auth — the new device) */
export async function pairClaim(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ pairId?: string; code?: string; pubkey_jwk?: unknown; label?: string }>(req);
  if (!body?.pairId || typeof body.code !== "string" || typeof body.pubkey_jwk !== "object" || body.pubkey_jwk === null) {
    return apiError(400, "bad_request", "pairId, code, pubkey_jwk required");
  }
  const row = await loadPairing(env, body.pairId);
  if (!row) return apiError(404, "not_found", "配對不存在");
  const guard = await verifyCode(env, row, body.code);
  if (guard) return guard;

  await env.DB.prepare(
    "UPDATE pairings SET new_pubkey = ?, new_label = ? WHERE pair_id = ?",
  ).bind(JSON.stringify(body.pubkey_jwk), (body.label ?? "新裝置").slice(0, 64), body.pairId).run();
  return json({ ok: true });
}

/** GET /api/pair/:id/status (device auth — the old device polls) */
export async function pairStatus(env: Env, device: DeviceCtx, pairId: string): Promise<Response> {
  const row = await loadPairing(env, pairId);
  if (!row || row.owner_user !== device.userId) return apiError(404, "not_found");
  return json({
    claimed: row.new_pubkey !== null,
    newLabel: row.new_label,
    newPubkey: row.new_pubkey ? JSON.parse(row.new_pubkey) : null,
    approved: row.approved_at !== null,
    consumed: row.consumed_at !== null,
    expiresAt: row.expires_at,
  });
}

/**
 * POST /api/pair/:id/approve (device auth — the old device).
 * §6.6: the OLD device must show a confirmation and the user must actively
 * approve; the wrapped K_master is only uploaded here.
 */
export async function pairApprove(req: Request, env: Env, device: DeviceCtx, pairId: string): Promise<Response> {
  const body = await readJson<{ wrapped_blob?: string; old_pubkey?: unknown }>(req);
  if (!body?.wrapped_blob || typeof body.old_pubkey !== "object" || body.old_pubkey === null) {
    return apiError(400, "bad_request", "wrapped_blob, old_pubkey required");
  }
  const row = await loadPairing(env, pairId);
  if (!row || row.owner_user !== device.userId) return apiError(404, "not_found");
  if (row.consumed_at !== null) return apiError(410, "pairing_consumed");
  if (Date.now() > row.expires_at) return apiError(410, "pairing_expired");
  if (!row.new_pubkey) return apiError(409, "not_claimed", "新裝置尚未加入");

  await env.DB.prepare(
    "UPDATE pairings SET wrapped_blob = ?, old_pubkey = ?, approved_at = ? WHERE pair_id = ?",
  ).bind(body.wrapped_blob, JSON.stringify(body.old_pubkey), Date.now(), pairId).run();
  return json({ ok: true });
}

/**
 * POST /api/pair/finish (no auth — the new device, with the code again).
 * Single-use: hands over the wrapped K_master, creates the device row and
 * its bearer token, then burns the pairing.
 */
export async function pairFinish(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ pairId?: string; code?: string }>(req);
  if (!body?.pairId || typeof body.code !== "string") return apiError(400, "bad_request");
  const row = await loadPairing(env, body.pairId);
  if (!row) return apiError(404, "not_found");
  const guard = await verifyCode(env, row, body.code);
  if (guard) return guard;
  if (!row.approved_at || !row.wrapped_blob || !row.new_pubkey) {
    return apiError(409, "not_approved", "等待舊裝置確認");
  }

  const now = Date.now();
  // Burn first (single use) — only one caller can win this UPDATE.
  const burned = await env.DB.prepare(
    "UPDATE pairings SET consumed_at = ? WHERE pair_id = ? AND consumed_at IS NULL RETURNING pair_id",
  ).bind(now, row.pair_id).first();
  if (!burned) return apiError(410, "pairing_consumed");

  const deviceId = ulid(now);
  const deviceToken = randomToken();
  await env.DB.prepare(
    "INSERT INTO devices (device_id, user_id, label, pubkey_jwk, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(deviceId, row.owner_user, row.new_label, row.new_pubkey, await sha256hex(deviceToken), now, now).run();

  // Clear the secret material from the pairing row now that it is delivered.
  await env.DB.prepare("UPDATE pairings SET wrapped_blob = NULL WHERE pair_id = ?").bind(row.pair_id).run();

  return json({
    userId: row.owner_user,
    deviceId,
    deviceToken,
    wrappedBlob: row.wrapped_blob,
    oldPubkey: row.old_pubkey ? JSON.parse(row.old_pubkey) : null,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
  });
}
