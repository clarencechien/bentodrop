import type { DeviceCtx, Env } from "../types";
import { PUSH_TTL_TEXT_S } from "../types";
import { apiError, json, readJson } from "../lib/util";
import { fanoutPush } from "../fanout";

// The Worker POSTs (VAPID-signed, encrypted) to whatever endpoint a device
// registers — an SSRF surface if left open to arbitrary hosts. Every browser
// push service lives on one of these; self-hosted distributors (UnifiedPush,
// ntfy) can be admitted via the PUSH_ENDPOINT_ALLOW env var.
const PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",                  // Chrome / Edge / Brave / Opera / Samsung
  "updates.push.services.mozilla.com",   // Firefox
  "web.push.apple.com",                  // Safari
  "notify.windows.net",                  // WNS (per-tenant subdomains)
];

function pushEndpointAllowed(hostname: string, env: Env): boolean {
  const extra = (env.PUSH_ENDPOINT_ALLOW ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...PUSH_ENDPOINT_HOSTS, ...extra].some(
    (h) => hostname === h || hostname.endsWith("." + h),
  );
}

/** POST /api/subscribe (device auth) — upsert this device's push subscription (§8.3 #3). */
export async function handleSubscribe(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(req);
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return apiError(400, "bad_subscription");
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return apiError(400, "bad_subscription", "endpoint must be a URL");
  }
  if (u.protocol !== "https:") return apiError(400, "bad_subscription", "endpoint must be https");
  if (!pushEndpointAllowed(u.hostname.toLowerCase(), env)) {
    return apiError(400, "bad_subscription",
      "unknown push service — self-hosted push needs its host added to PUSH_ENDPOINT_ALLOW");
  }

  await env.DB.prepare(
    `INSERT INTO subscriptions (device_id, endpoint, p256dh, auth, updated_at, fail_count)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
       auth = excluded.auth, updated_at = excluded.updated_at, fail_count = 0`,
  ).bind(device.deviceId, endpoint, p256dh, auth, Date.now()).run();
  return json({ ok: true });
}

/** GET /api/me (device auth) — devices, subscription health (§8.4), settings. */
export async function handleMe(env: Env, device: DeviceCtx): Promise<Response> {
  const user = await env.DB.prepare("SELECT retention_days, created_at FROM users WHERE user_id = ?")
    .bind(device.userId).first<{ retention_days: number; created_at: number }>();
  const devices = await env.DB.prepare(
    `SELECT d.device_id, d.label, d.created_at, d.last_seen_at,
            s.updated_at AS sub_updated_at, s.fail_count
       FROM devices d LEFT JOIN subscriptions s ON s.device_id = d.device_id
      WHERE d.user_id = ? ORDER BY d.created_at`,
  ).bind(device.userId).all();
  const staleCutoff = Date.now() - 14 * 24 * 3600 * 1000; // §8.4
  return json({
    userId: device.userId,
    deviceId: device.deviceId,
    retentionDays: user?.retention_days ?? 7,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    devices: (devices.results ?? []).map((d: any) => ({
      deviceId: d.device_id,
      label: d.label,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      subscribed: d.sub_updated_at !== null,
      failCount: d.fail_count ?? 0,
      maybeDead: d.sub_updated_at === null || (d.last_seen_at !== null && d.last_seen_at < staleCutoff),
      isSelf: d.device_id === device.deviceId,
    })),
  });
}

/** POST /api/devices/:id/label (device auth) — rename any device of the same user, self included. */
export async function renameDevice(req: Request, env: Env, device: DeviceCtx, targetId: string): Promise<Response> {
  const body = await readJson<{ label?: string }>(req);
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 64) : "";
  if (!label) return apiError(400, "bad_label", "別名不可為空");
  const row = await env.DB.prepare(
    "UPDATE devices SET label = ? WHERE device_id = ? AND user_id = ? RETURNING device_id",
  ).bind(label, targetId, device.userId).first();
  if (!row) return apiError(404, "not_found");
  return json({ ok: true, label });
}

/** DELETE /api/devices/:id (device auth) — remove a device of the same user. */
export async function deleteDevice(env: Env, device: DeviceCtx, targetId: string): Promise<Response> {
  const exists = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?",
  ).bind(targetId, device.userId).first();
  if (!exists) return apiError(404, "not_found");
  // Subscription first — it has a foreign key onto devices.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subscriptions WHERE device_id = ?").bind(targetId),
    env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(targetId),
  ]);
  return json({ ok: true });
}

/** POST /api/test-push (device auth) — §8.4 silent-failure probe. */
export async function handleTestPush(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ deviceId?: string }>(req);
  const receipts = await fanoutPush(
    env, device.userId,
    { t: "test", from: device.label, ts: Date.now() },
    PUSH_TTL_TEXT_S,
  );
  const filtered = body?.deviceId ? receipts.filter((r) => r.deviceId === body.deviceId) : receipts;
  return json({ receipts: filtered });
}
