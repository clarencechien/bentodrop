// Transport diagnostics (handoff doc §5): the value is in trustworthy
// numbers, so the tests focus on isolation — diag traffic must never touch
// messages, push, or anyone else's objects.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupExpired } from "../src/cron";
import { apiFetch, createDevice, drainPushes, json, subscribeDevice } from "./helpers";

beforeEach(async () => {
  await drainPushes();
});

describe("auth", () => {
  it("rejects every diag endpoint without a device token", async () => {
    expect((await apiFetch("/api/diag/env")).status).toBe(401);
    expect((await apiFetch("/api/diag/upload-url", { body: { sizeBytes: 100 } })).status).toBe(401);
    expect((await apiFetch("/api/diag/echo", { method: "POST", raw: new Uint8Array(8) as unknown as BodyInit })).status).toBe(401);
    expect((await apiFetch("/api/diag/object", { method: "DELETE", body: { key: "diag/x/1-y" } })).status).toBe(401);
  });
});

describe("GET /api/diag/env", () => {
  it("returns complete, typed measurements", async () => {
    const a = await createDevice();
    const res = await json(await apiFetch("/api/diag/env", { token: a.token }));
    expect(typeof res.r2.headMs).toBe("number");
    expect(typeof res.r2.getMs).toBe("number");
    expect(typeof res.r2.putMs).toBe("number");
    expect(typeof res.d1Ms).toBe("number");
    expect(typeof res.workerTimeMs).toBe("number");
    expect("colo" in res && "country" in res).toBe(true); // null outside real CF
    for (const v of [res.r2.headMs, res.r2.getMs, res.r2.putMs, res.d1Ms, res.workerTimeMs]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("rate limits: the 21st full run in an hour gets 429", async () => {
    const a = await createDevice();
    for (let i = 0; i < 20; i++) {
      expect((await apiFetch("/api/diag/env", { token: a.token })).status).toBe(200);
    }
    expect((await apiFetch("/api/diag/env", { token: a.token })).status).toBe(429);
  });
});

describe("POST /api/diag/upload-url", () => {
  it("always keys under diag/{own userId}/ — client-supplied keys are ignored", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    const res = await json(await apiFetch("/api/diag/upload-url", {
      token: a.token,
      // Hostile extra field: must be ignored, never signed.
      body: { sizeBytes: 1024, key: `u/${stranger.userId}/inbox/HIJACK` } as any,
    }));
    expect(res.key.startsWith(`diag/${a.userId}/`)).toBe(true);
    expect(res.putUrl).toContain(`/api/object/diag/${a.userId}/`);
    expect(res.getUrl).toContain(`/api/object/diag/${a.userId}/`);
  });

  it("caps declared size at 5 MB", async () => {
    const a = await createDevice();
    expect((await apiFetch("/api/diag/upload-url", { token: a.token, body: { sizeBytes: 5 * 1024 * 1024 + 1 } })).status).toBe(400);
    expect((await apiFetch("/api/diag/upload-url", { token: a.token, body: { sizeBytes: 0 } })).status).toBe(400);
  });

  it("round-trips bytes through the signed URLs, and creates NO message and NO push", async () => {
    const a = await createDevice();
    await subscribeDevice(a);
    await drainPushes();

    const data = crypto.getRandomValues(new Uint8Array(2048));
    const urls = await json(await apiFetch("/api/diag/upload-url", { token: a.token, body: { sizeBytes: data.byteLength } }));
    expect((await apiFetch(urls.putUrl, { method: "PUT", raw: data as unknown as BodyInit })).status).toBe(200);
    const got = await apiFetch(urls.getUrl);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(data);

    expect((await apiFetch("/api/diag/object", { method: "DELETE", token: a.token, body: { key: urls.key } })).status).toBe(200);
    expect(await env.INBOX.head(urls.key)).toBeNull();

    // Isolation: the messages table and the push pipe never saw any of it.
    const list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages).toHaveLength(0);
    expect(await drainPushes()).toHaveLength(0);
  });
});

describe("DELETE /api/diag/object", () => {
  it("refuses other users' diag keys and ALL u/ keys — even your own", async () => {
    const a = await createDevice();
    const b = await createDevice("B", "b");
    expect((await apiFetch("/api/diag/object", { method: "DELETE", token: a.token, body: { key: `diag/${b.userId}/1-x` } })).status).toBe(403);
    expect((await apiFetch("/api/diag/object", { method: "DELETE", token: a.token, body: { key: `u/${a.userId}/inbox/x` } })).status).toBe(403);
    expect((await apiFetch("/api/diag/object", { method: "DELETE", token: a.token, body: { key: "diag/_probe" } })).status).toBe(403);
  });
});

describe("POST /api/diag/echo", () => {
  it("echoes byte counts up to 64 KB, rejects beyond", async () => {
    const a = await createDevice();
    const ok = await json(await apiFetch("/api/diag/echo", {
      method: "POST", token: a.token, raw: new Uint8Array(64 * 1024) as unknown as BodyInit,
    }));
    expect(ok.bytes).toBe(64 * 1024);
    expect(typeof ok.workerMs).toBe("number");
    expect((await apiFetch("/api/diag/echo", {
      method: "POST", token: a.token, raw: new Uint8Array(64 * 1024 + 1) as unknown as BodyInit,
    })).status).toBe(400);
  });
});

describe("cron cleanup of diag objects", () => {
  it("deletes >1h-old diag objects; leaves fresh ones, the probe, and u/ alone", async () => {
    const a = await createDevice();
    const now = Date.now();
    const oldKey = `diag/${a.userId}/${now - 2 * 3600_000}-old`;
    const freshKey = `diag/${a.userId}/${now}-fresh`;
    const msgKey = `u/${a.userId}/inbox/somemsg`;
    await env.INBOX.put(oldKey, new Uint8Array(16) as unknown as ArrayBuffer);
    await env.INBOX.put(freshKey, new Uint8Array(16) as unknown as ArrayBuffer);
    await env.INBOX.put("diag/_probe", new Uint8Array(16) as unknown as ArrayBuffer);
    await env.INBOX.put(msgKey, new Uint8Array(16) as unknown as ArrayBuffer);

    const result = await cleanupExpired(env, now);
    expect(result.diag).toBeGreaterThanOrEqual(1);
    expect(await env.INBOX.head(oldKey)).toBeNull();
    expect(await env.INBOX.head(freshKey)).not.toBeNull();
    expect(await env.INBOX.head("diag/_probe")).not.toBeNull();
    expect(await env.INBOX.head(msgKey)).not.toBeNull();
  });
});
