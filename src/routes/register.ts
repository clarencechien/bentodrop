import type { Env } from "../types";
import { apiError, json, randomToken, readJson, sha256hex, ulid } from "../lib/util";

/**
 * POST /api/register — first-run onboarding (§6.5).
 * Creates a brand-new user plus its first device and returns the device
 * bearer token. Joining an EXISTING user goes through pairing (§6.6), never
 * through this endpoint.
 */
export async function handleRegister(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ label?: string; pubkey_jwk?: unknown }>(req);
  if (!body || typeof body.pubkey_jwk !== "object" || body.pubkey_jwk === null) {
    return apiError(400, "bad_request", "pubkey_jwk (ECDH P-256 public JWK) is required");
  }
  const label = typeof body.label === "string" ? body.label.slice(0, 64) : null;

  const now = Date.now();
  const userId = ulid(now);
  const deviceId = ulid(now);
  const deviceToken = randomToken();
  const tokenHash = await sha256hex(deviceToken);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_id, created_at) VALUES (?, ?)").bind(userId, now),
    env.DB.prepare(
      "INSERT INTO devices (device_id, user_id, label, pubkey_jwk, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, userId, label, JSON.stringify(body.pubkey_jwk), tokenHash, now, now),
  ]);

  return json({ userId, deviceId, deviceToken, vapidPublicKey: env.VAPID_PUBLIC_KEY });
}
