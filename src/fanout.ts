import type { Env } from "./types";
import { SUB_FAIL_LIMIT } from "./types";
import { enc } from "./lib/util";
import { sendWebPush } from "./lib/webpush";

export interface DeliveryReceipt {
  deviceId: string;
  label: string | null;
  ok: boolean;
  status: number;
}

/**
 * Fan out a push payload to every subscription of `userId`, excluding
 * `excludeDeviceId` (the sender). Handles §8.3: 404/410 deletes the
 * subscription immediately; other failures bump fail_count and delete at 5.
 */
export async function fanoutPush(
  env: Env,
  userId: string,
  payload: unknown,
  ttlSeconds: number,
  excludeDeviceId?: string,
  onlyDeviceId?: string,
): Promise<DeliveryReceipt[]> {
  const subs = await env.DB.prepare(
    `SELECT s.device_id, s.endpoint, s.p256dh, s.auth, d.label
       FROM subscriptions s JOIN devices d ON d.device_id = s.device_id
      WHERE d.user_id = ?`,
  ).bind(userId).all<{
    device_id: string; endpoint: string; p256dh: string; auth: string; label: string | null;
  }>();

  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    subject: env.VAPID_SUBJECT,
  };
  const bytes = enc.encode(JSON.stringify(payload));

  const receipts: DeliveryReceipt[] = [];
  await Promise.all(
    (subs.results ?? [])
      .filter((s) => s.device_id !== excludeDeviceId)
      .filter((s) => onlyDeviceId === undefined || s.device_id === onlyDeviceId)
      .map(async (s) => {
        const result = await sendWebPush(
          { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, bytes, ttlSeconds, vapid,
        );
        if (result.gone) {
          await env.DB.prepare("DELETE FROM subscriptions WHERE device_id = ?").bind(s.device_id).run();
        } else if (!result.ok) {
          const upd = await env.DB.prepare(
            "UPDATE subscriptions SET fail_count = fail_count + 1 WHERE device_id = ? RETURNING fail_count",
          ).bind(s.device_id).first<{ fail_count: number }>();
          if ((upd?.fail_count ?? 0) >= SUB_FAIL_LIMIT) {
            await env.DB.prepare("DELETE FROM subscriptions WHERE device_id = ?").bind(s.device_id).run();
          }
        } else {
          await env.DB.prepare("UPDATE subscriptions SET fail_count = 0 WHERE device_id = ?")
            .bind(s.device_id).run();
        }
        receipts.push({ deviceId: s.device_id, label: s.label, ok: result.ok, status: result.status });
      }),
  );
  return receipts;
}
