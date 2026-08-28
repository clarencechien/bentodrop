// Transport diagnostics (settings page). Answers, with real numbers:
// how long does a 1 MB photo take end to end, where does the time go,
// and — most importantly — is the R2 bucket even on the right continent.
//
// Design rules from the handoff doc:
//  - every timing starts and ends on ONE clock (client times client+network;
//    this file times only Worker↔R2/D1 on the Worker's own clock)
//  - diag traffic never creates messages rows and never triggers pushes
//  - the Worker composes object keys; the client can never choose one

import type { DeviceCtx, Env } from "../types";
import { apiError, hmacSign, json, readJson, randomToken } from "../lib/util";
import { fanoutPush } from "../fanout";

const PROBE_KEY = "diag/_probe";
const PROBE_BYTES = 1024;
export const DIAG_MAX_BYTES = 5 * 1024 * 1024;   // diagnostics never needs 20 MB
const ECHO_MAX_BYTES = 64 * 1024;
const RUNS_PER_HOUR = 20;                        // full diagnostics per device
const UPLOADS_PER_HOUR = RUNS_PER_HOUR * 12;     // ~11 signed URLs per full run
const URL_TTL_S = 300;
export const DIAG_OBJECT_MAX_AGE_MS = 3600 * 1000;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function rateLimit(env: Env, device: DeviceCtx, kind: string, limit: number): Promise<Response | null> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM diag_runs WHERE device_id = ? AND kind = ? AND created_at > ?",
  ).bind(device.deviceId, kind, now - 3600_000).first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) return apiError(429, "rate_limited", "診斷每小時最多 20 次,稍後再試");
  await env.DB.prepare("INSERT INTO diag_runs (device_id, kind, created_at) VALUES (?, ?, ?)")
    .bind(device.deviceId, kind, now).run();
  return null;
}

/**
 * GET /api/diag/env — server-side facts: which colo served this request,
 * and how far the Worker is from R2/D1 (medians of 3; the first attempt can
 * include connection setup, which is why we don't take a single sample).
 */
export async function diagEnv(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const t0 = performance.now();
  let ioMs = 0;
  const timed = async <T>(fn: () => Promise<T>): Promise<number> => {
    const s = performance.now();
    await fn();
    const ms = performance.now() - s;
    ioMs += ms;
    return ms;
  };

  // Every await must run inside timed() — anything untimed would get
  // misattributed to workerTimeMs and quietly lie about CPU cost.
  let limited: Response | null = null;
  await timed(async () => {
    limited = await rateLimit(env, device, "env", RUNS_PER_HOUR);
  });
  if (limited) return limited;

  // Probe object for HEAD/GET timing; (re)create if missing.
  await timed(async () => {
    if (!(await env.INBOX.head(PROBE_KEY))) {
      await env.INBOX.put(PROBE_KEY, crypto.getRandomValues(new Uint8Array(PROBE_BYTES)) as unknown as ArrayBuffer);
    }
  });

  const headSamples: number[] = [];
  const getSamples: number[] = [];
  const putSamples: number[] = [];
  const d1Samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    headSamples.push(await timed(() => env.INBOX.head(PROBE_KEY)));
    getSamples.push(await timed(async () => {
      const obj = await env.INBOX.get(PROBE_KEY);
      await obj?.arrayBuffer();
    }));
    const putKey = `diag/_probe_put_${randomToken(6)}`;
    putSamples.push(await timed(() =>
      env.INBOX.put(putKey, crypto.getRandomValues(new Uint8Array(PROBE_BYTES)) as unknown as ArrayBuffer),
    ));
    await timed(() => env.INBOX.delete(putKey));
    d1Samples.push(await timed(() => env.DB.prepare("SELECT 1").first()));
  }

  const cf = (req as { cf?: { colo?: string; country?: string } }).cf;
  return json({
    colo: cf?.colo ?? null,
    country: cf?.country ?? null,
    r2: {
      headMs: Math.round(median(headSamples)),
      getMs: Math.round(median(getSamples)),
      putMs: Math.round(median(putSamples)),
    },
    d1Ms: Math.round(median(d1Samples)),
    workerTimeMs: Math.max(0, Math.round(performance.now() - t0 - ioMs)),
  });
}

/**
 * POST /api/diag/upload-url {sizeBytes} — like the real upload-url, except:
 * the Worker composes the key under diag/{userId}/ (client input is ignored),
 * 5 MB cap, 5-minute TTL, and NOTHING touches messages or push.
 */
export async function diagUploadUrl(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const limited = await rateLimit(env, device, "upload", UPLOADS_PER_HOUR);
  if (limited) return limited;

  const body = await readJson<{ sizeBytes?: number }>(req);
  const size = Number(body?.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return apiError(400, "bad_size");
  if (size > DIAG_MAX_BYTES) return apiError(400, "too_large", "診斷上限 5 MB");

  // Timestamp in the key lets the cron age diag objects without extra state.
  const key = `diag/${device.userId}/${Date.now()}-${randomToken(8)}`;
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
  const putSig = await hmacSign(env.URL_SIGNING_SECRET, `PUT|${key}|${exp}|${size}`);
  const getSig = await hmacSign(env.URL_SIGNING_SECRET, `GET|${key}|${exp}`);
  return json({
    key,
    putUrl: `/api/object/${key}?exp=${exp}&size=${size}&sig=${putSig}`,
    getUrl: `/api/object/${key}?exp=${exp}&sig=${getSig}`,
    expiresAt: exp * 1000,
  });
}

/** DELETE /api/diag/object {key} — only ever inside your own diag prefix. */
export async function diagDelete(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ key?: string }>(req);
  const key = body?.key ?? "";
  // Own diag prefix only — u/ keys (even your own) are message data, not diag.
  if (!key.startsWith(`diag/${device.userId}/`)) return apiError(403, "forbidden_key");
  await env.INBOX.delete(key);
  return json({ ok: true });
}

/** POST /api/diag/echo — pure client↔Worker RTT; touches neither R2 nor D1. */
export async function diagEcho(req: Request, _env: Env, _device: DeviceCtx): Promise<Response> {
  const t0 = performance.now();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > ECHO_MAX_BYTES) return apiError(400, "too_large", "echo 上限 64 KB");
  return json({ bytes: bytes.byteLength, workerMs: Math.round(performance.now() - t0) });
}

// ── push-delivery probe (handoff §2.3, NTP-style) ────────────────────
// A → push → B's SW → pong request → push → A, timed entirely on A's
// clock; one-way ≈ RTT/2. The server is a stateless relay between the
// user's OWN devices — payloads carry no content, only ids.

/** POST /api/diag/probe {targetDeviceId} — push a probe to a sibling device. */
export async function diagProbe(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const limited = await rateLimit(env, device, "probe", UPLOADS_PER_HOUR);
  if (limited) return limited;
  const body = await readJson<{ targetDeviceId?: string }>(req);
  const target = body?.targetDeviceId ?? "";
  const owned = await env.DB.prepare(
    "SELECT 1 FROM devices WHERE device_id = ? AND user_id = ?",
  ).bind(target, device.userId).first();
  if (!owned || target === device.deviceId) return apiError(400, "bad_target", "選擇同帳號的另一台裝置");

  const probeId = randomToken(9);
  const receipts = await fanoutPush(
    env, device.userId,
    { t: "probe", probeId, originDeviceId: device.deviceId },
    60, undefined, target,
  );
  const hit = receipts.find((r) => r.deviceId === target);
  if (!hit) return apiError(409, "target_unsubscribed", "對方裝置沒有推送訂閱");
  return json({ probeId, pushed: hit.ok });
}

/** POST /api/diag/probe-pong {probeId, originDeviceId} — the target's SW answers. */
export async function diagProbePong(req: Request, env: Env, device: DeviceCtx): Promise<Response> {
  const body = await readJson<{ probeId?: string; originDeviceId?: string }>(req);
  const probeId = body?.probeId ?? "";
  const origin = body?.originDeviceId ?? "";
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(probeId)) return apiError(400, "bad_probe");
  const owned = await env.DB.prepare(
    "SELECT 1 FROM devices WHERE device_id = ? AND user_id = ?",
  ).bind(origin, device.userId).first();
  if (!owned) return apiError(403, "forbidden", "探針只能回給同帳號的裝置");

  await fanoutPush(
    env, device.userId,
    { t: "probe-pong", probeId },
    60, undefined, origin,
  );
  return json({ ok: true });
}

/** Cron helper: delete diag objects older than an hour (client delete is the
 *  happy path; this is the backstop). The `_probe` object has no timestamp
 *  and is deliberately left alone. */
export async function cleanupDiagObjects(env: Env, now = Date.now()): Promise<number> {
  const list = await env.INBOX.list({ prefix: "diag/", limit: 1000 });
  const stale = list.objects
    .filter((o) => {
      const m = /^diag\/[^/]+\/(\d+)-/.exec(o.key);
      return m !== null && now - Number(m[1]) > DIAG_OBJECT_MAX_AGE_MS;
    })
    .map((o) => o.key);
  if (stale.length) await env.INBOX.delete(stale);
  await env.DB.prepare("DELETE FROM diag_runs WHERE created_at < ?").bind(now - 2 * 3600_000).run();
  return stale.length;
}
