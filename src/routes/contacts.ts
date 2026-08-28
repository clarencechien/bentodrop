// Phase 2 (§11 / §6.7): user-level identity keys and the add-friend flow.
// Same URL+code mechanism as device pairing, with two differences: both
// sides are authenticated users, and what changes hands is identity PUBLIC
// keys — never K_master. TTL is 30 minutes (§6.7); the other guardrails
// (3 attempts, single use, rate limit) are identical.

import type { DeviceCtx, Env } from "../types";
import { CONTACT_TTL_MS, PAIR_MAX_ATTEMPTS, PAIR_RATE_PER_HOUR } from "../types";
import { apiError, json, readJson, sha256hex, timingSafeEqual, ulid } from "../lib/util";

// ── identity (§5.2 user-level keypair) ────────────────────────────────

/**
 * POST /api/identity — publish this user's identity keypair: public JWK in
 * the clear, private JWK wrapped with K_master (opaque to the server).
 * First writer wins; later calls get the stored pair back so every device
 * converges on one identity.
 */
export async function setIdentity(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ identity_pub?: unknown; identity_priv_wrapped?: unknown }>(req);
  if (typeof body?.identity_pub !== "object" || body.identity_pub === null || typeof body.identity_priv_wrapped !== "object") {
    return apiError(400, "bad_request", "identity_pub, identity_priv_wrapped required");
  }
  const claimed = await env.DB.prepare(
    "UPDATE users SET identity_pub = ?, identity_priv_wrapped = ? WHERE user_id = ? AND identity_pub IS NULL RETURNING user_id",
  ).bind(JSON.stringify(body.identity_pub), JSON.stringify(body.identity_priv_wrapped), device.userId).first();

  const row = await env.DB.prepare("SELECT identity_pub, identity_priv_wrapped FROM users WHERE user_id = ?")
    .bind(device.userId).first<{ identity_pub: string; identity_priv_wrapped: string }>();
  return json({
    created: claimed !== null,
    identityPub: JSON.parse(row!.identity_pub),
    identityPrivWrapped: JSON.parse(row!.identity_priv_wrapped),
  });
}

/** GET /api/identity — fetch the stored identity pair (404 until published). */
export async function getIdentity(env: Env, device: DeviceCtx): Promise<Response> {
  const row = await env.DB.prepare("SELECT identity_pub, identity_priv_wrapped FROM users WHERE user_id = ?")
    .bind(device.userId).first<{ identity_pub: string | null; identity_priv_wrapped: string | null }>();
  if (!row?.identity_pub) return apiError(404, "identity_missing");
  return json({
    identityPub: JSON.parse(row.identity_pub),
    identityPrivWrapped: row.identity_priv_wrapped ? JSON.parse(row.identity_priv_wrapped) : null,
  });
}

async function userIdentity(env: Env, userId: string): Promise<{ pub: unknown } | null> {
  const row = await env.DB.prepare("SELECT identity_pub FROM users WHERE user_id = ?")
    .bind(userId).first<{ identity_pub: string | null }>();
  return row?.identity_pub ? { pub: JSON.parse(row.identity_pub) } : null;
}

// ── invite / claim / approve ─────────────────────────────────────────

const codeHash = (pairId: string, code: string) => sha256hex(`${pairId}:${code}`);

interface PairRow {
  pair_id: string;
  kind: string;
  owner_user: string;
  code_hash: string;
  new_pubkey: string | null;
  approved_at: number | null;
  old_pubkey: string | null;
  attempts: number;
  consumed_at: number | null;
  expires_at: number;
}

async function loadContactPairing(env: Env, pairId: string): Promise<PairRow | null> {
  const row = await env.DB.prepare("SELECT * FROM pairings WHERE pair_id = ?").bind(pairId).first<PairRow>();
  return row && row.kind === "contact" ? row : null;
}

async function verifyCode(env: Env, row: PairRow, code: string): Promise<Response | null> {
  if (row.consumed_at !== null) return apiError(410, "invite_consumed", "此邀請已使用過");
  if (Date.now() > row.expires_at) return apiError(410, "invite_expired", "邀請已過期");
  if (row.attempts >= PAIR_MAX_ATTEMPTS) return apiError(410, "invite_locked", "錯誤次數過多,邀請已作廢");
  if (!timingSafeEqual(await codeHash(row.pair_id, code), row.code_hash)) {
    const upd = await env.DB.prepare(
      "UPDATE pairings SET attempts = attempts + 1 WHERE pair_id = ? RETURNING attempts",
    ).bind(row.pair_id).first<{ attempts: number }>();
    if ((upd?.attempts ?? 0) >= PAIR_MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE pairings SET consumed_at = ? WHERE pair_id = ?").bind(Date.now(), row.pair_id).run();
      return apiError(410, "invite_locked", "錯誤次數過多,邀請已作廢");
    }
    return apiError(403, "bad_code", "邀請碼錯誤");
  }
  return null;
}

/** POST /api/contacts/invite (device auth) {myName} */
export async function contactInvite(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const identity = await userIdentity(env, device.userId);
  if (!identity) return apiError(409, "identity_missing", "請先重新整理 App 以建立身分金鑰");
  const body = await readJson<{ myName?: string }>(req);
  const myName = (body?.myName ?? "").trim().slice(0, 64) || "朋友";

  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pairings WHERE owner_user = ? AND created_at > ?",
  ).bind(device.userId, now - 3600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= PAIR_RATE_PER_HOUR) return apiError(429, "rate_limited", "每小時最多建立 5 個邀請");

  const pairId = ulid(now);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.prepare(
    "INSERT INTO pairings (pair_id, kind, owner_user, code_hash, old_pubkey, expires_at, created_at) VALUES (?, 'contact', ?, ?, ?, ?, ?)",
  ).bind(
    pairId, device.userId, await codeHash(pairId, code),
    JSON.stringify({ userId: device.userId, pub: identity.pub, name: myName }),
    now + CONTACT_TTL_MS, now,
  ).run();
  return json({ pairId, code, expiresAt: now + CONTACT_TTL_MS });
}

/** POST /api/contacts/claim (device auth — the invited person) {pairId, code, myName} */
export async function contactClaim(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ pairId?: string; code?: string; myName?: string }>(req);
  if (!body?.pairId || typeof body.code !== "string") return apiError(400, "bad_request");
  const row = await loadContactPairing(env, body.pairId);
  if (!row) return apiError(404, "not_found", "邀請不存在");
  if (row.owner_user === device.userId) return apiError(400, "self_invite", "不能加自己為好友");
  const guard = await verifyCode(env, row, body.code);
  if (guard) return guard;
  const identity = await userIdentity(env, device.userId);
  if (!identity) return apiError(409, "identity_missing", "請先重新整理 App 以建立身分金鑰");

  const myName = (body.myName ?? "").trim().slice(0, 64) || "朋友";
  await env.DB.prepare("UPDATE pairings SET new_pubkey = ?, new_label = ? WHERE pair_id = ?")
    .bind(JSON.stringify({ userId: device.userId, pub: identity.pub, name: myName }), myName, body.pairId).run();
  const inviter = JSON.parse(row.old_pubkey!);
  return json({ ok: true, inviterName: inviter.name });
}

/** GET /api/contacts/invite/:id/status (device auth — inviter polls) */
export async function contactInviteStatus(env: Env, device: DeviceCtx, pairId: string): Promise<Response> {
  const row = await loadContactPairing(env, pairId);
  if (!row || row.owner_user !== device.userId) return apiError(404, "not_found");
  const claimer = row.new_pubkey ? JSON.parse(row.new_pubkey) : null;
  return json({
    claimed: claimer !== null,
    claimerName: claimer?.name ?? null,
    completed: row.consumed_at !== null && row.approved_at !== null,
    expiresAt: row.expires_at,
  });
}

/**
 * POST /api/contacts/invite/:id/approve (device auth — inviter confirms) {label?}
 * Writes BOTH contact rows and burns the invite (single use).
 */
export async function contactApprove(req: Request, env: Env, device: DeviceCtx, pairId: string): Promise<Response> {
  const body = await readJson<{ label?: string }>(req);
  const row = await loadContactPairing(env, pairId);
  if (!row || row.owner_user !== device.userId) return apiError(404, "not_found");
  if (Date.now() > row.expires_at) return apiError(410, "invite_expired");
  if (!row.new_pubkey) return apiError(409, "not_claimed", "對方尚未加入");

  const burned = await env.DB.prepare(
    "UPDATE pairings SET consumed_at = ?, approved_at = ? WHERE pair_id = ? AND consumed_at IS NULL RETURNING pair_id",
  ).bind(Date.now(), Date.now(), pairId).first();
  if (!burned) return apiError(410, "invite_consumed");

  const inviter = JSON.parse(row.old_pubkey!);
  const claimer = JSON.parse(row.new_pubkey);
  const now = Date.now();
  const myLabelForThem = (body?.label ?? "").trim().slice(0, 64) || claimer.name;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO contacts (user_id, peer_user_id, peer_pubkey, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(device.userId, claimer.userId, JSON.stringify(claimer.pub), myLabelForThem, now),
    env.DB.prepare(
      "INSERT OR REPLACE INTO contacts (user_id, peer_user_id, peer_pubkey, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(claimer.userId, device.userId, JSON.stringify(inviter.pub), inviter.name, now),
  ]);
  return json({ ok: true, contact: { peerUserId: claimer.userId, label: myLabelForThem } });
}

// ── contact management ───────────────────────────────────────────────

/** GET /api/contacts (device auth) */
export async function listContacts(env: Env, device: DeviceCtx): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT peer_user_id, peer_pubkey, label, created_at FROM contacts WHERE user_id = ? ORDER BY created_at",
  ).bind(device.userId).all();
  return json({
    contacts: (rows.results ?? []).map((r: any) => ({
      peerUserId: r.peer_user_id,
      peerPubkey: JSON.parse(r.peer_pubkey),
      label: r.label,
      createdAt: r.created_at,
    })),
  });
}

/** POST /api/contacts/:peer/label (device auth) {label} */
export async function renameContact(req: Request, env: Env, device: DeviceCtx, peer: string): Promise<Response> {
  const body = await readJson<{ label?: string }>(req);
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 64) : "";
  if (!label) return apiError(400, "bad_label", "別名不可為空");
  const row = await env.DB.prepare(
    "UPDATE contacts SET label = ? WHERE user_id = ? AND peer_user_id = ? RETURNING peer_user_id",
  ).bind(label, device.userId, peer).first();
  if (!row) return apiError(404, "not_found");
  return json({ ok: true, label });
}

/**
 * DELETE /api/contacts/:peer (device auth) — unfriend. Removes only MY row;
 * incoming sends are authorized against the RECIPIENT's contact list, so
 * this immediately stops them from reaching me (§11: block).
 */
export async function deleteContact(env: Env, device: DeviceCtx, peer: string): Promise<Response> {
  const row = await env.DB.prepare(
    "DELETE FROM contacts WHERE user_id = ? AND peer_user_id = ? RETURNING peer_user_id",
  ).bind(device.userId, peer).first();
  if (!row) return apiError(404, "not_found");
  return json({ ok: true });
}
