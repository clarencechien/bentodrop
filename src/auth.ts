import type { DeviceCtx, Env } from "./types";
import { sha256hex } from "./lib/util";

/** Resolve the device bearer token from the Authorization header. */
export async function authDevice(req: Request, env: Env): Promise<DeviceCtx | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const hash = await sha256hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT device_id, user_id, label FROM devices WHERE token_hash = ?",
  ).bind(hash).first<{ device_id: string; user_id: string; label: string | null }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
    .bind(Date.now(), row.device_id).run();
  return { deviceId: row.device_id, userId: row.user_id, label: row.label };
}

export interface ApiTokenCtx {
  tokenId: string;
  userId: string;
  label: string;
  plaintextOk: boolean;
  rateLimit: number;
}

/** Resolve an API token (`bd_...`) — send-only credentials (§12.5). */
export async function authApiToken(req: Request, env: Env): Promise<ApiTokenCtx | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(bd_[A-Za-z0-9_-]+)$/i.exec(header);
  if (!m) return null;
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    "SELECT token_id, user_id, label, plaintext_ok, rate_limit FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(hash).first<{
    token_id: string; user_id: string; label: string; plaintext_ok: number; rate_limit: number;
  }>();
  if (!row) return null;
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    label: row.label,
    plaintextOk: row.plaintext_ok === 1,
    rateLimit: row.rate_limit,
  };
}
