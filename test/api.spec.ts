// Full-system integration tests: real Worker, real D1, real R2 (miniflare),
// real client crypto, and a fake push service capturing real RFC 8291 bodies.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  C, apiFetch, createDevice, drainPushes, json, openPush, pairNewDevice, subscribeDevice, te,
} from "./helpers";

beforeEach(async () => {
  await drainPushes(); // isolate captured pushes between tests
});

describe("auth", () => {
  it("rejects unauthenticated API calls", async () => {
    for (const path of ["/api/me", "/api/messages"]) {
      expect((await apiFetch(path)).status).toBe(401);
    }
    expect((await apiFetch("/api/send", { body: { envelope: {} } })).status).toBe(401);
  });

  it("rejects a bad bearer token", async () => {
    expect((await apiFetch("/api/me", { token: "wrong-token" })).status).toBe(401);
  });
});

describe("register + me", () => {
  it("creates a user and first device", async () => {
    const dev = await createDevice("Pixel");
    const me = await json(await apiFetch("/api/me", { token: dev.token }));
    expect(me.userId).toBe(dev.userId);
    expect(me.retentionDays).toBe(7);
    expect(me.vapidPublicKey).toBe(env.VAPID_PUBLIC_KEY);
    expect(me.devices).toHaveLength(1);
    expect(me.devices[0].label).toBe("Pixel");
    expect(me.devices[0].isSelf).toBe(true);
  });

  it("requires a pubkey", async () => {
    const res = await apiFetch("/api/register", { body: { label: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("text path (§3.1) — full E2E through the push pipe", () => {
  it("delivers an encrypted envelope that only the paired device can decrypt", async () => {
    const a = await createDevice("Pixel");
    const b = await pairNewDevice(a, "MacBook");
    await subscribeDevice(b);

    const text = "下午三點的會議改到會議室 B,記得帶那份合約。";
    const envelope = await C.encryptTextEnvelope(a.kMaster, text);
    const res = await json(await apiFetch("/api/send", { token: a.token, body: { envelope } }));
    expect(res.msgId).toBe(envelope.id);
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].ok).toBe(true);
    expect(res.receipts[0].label).toBe("MacBook");

    const pushes = await drainPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toContain(b.deviceId);
    expect(pushes[0].ttl).toBe("600"); // §8.2
    expect(pushes[0].contentEncoding).toBe("aes128gcm");
    expect(pushes[0].authorization).toMatch(/^vapid t=.+, k=/);

    // The push body itself never contains plaintext.
    expect(atob(pushes[0].body)).not.toContain("會議室");

    // Receiver decrypts the transport layer, then the E2E envelope.
    const payload = await openPush(b, pushes[0]);
    expect(payload.t).toBe("msg");
    expect(payload.from).toBe("Pixel");
    expect(await C.decryptTextEnvelope(b.kMaster, payload.envelope)).toBe(text);
  });

  it("does not push back to the sending device (§6.4)", async () => {
    const a = await createDevice("Pixel");
    const b = await pairNewDevice(a);
    await subscribeDevice(a);
    await subscribeDevice(b);

    const envelope = await C.encryptTextEnvelope(a.kMaster, "hi");
    await apiFetch("/api/send", { token: a.token, body: { envelope } });
    const pushes = await drainPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toContain(b.deviceId);
  });

  it("rejects an envelope that exceeds the push payload budget → use file path", async () => {
    const a = await createDevice();
    const envelope = await C.encryptTextEnvelope(a.kMaster, "x".repeat(4000));
    const res = await apiFetch("/api/send", { token: a.token, body: { envelope } });
    expect(res.status).toBe(413);
  });

  it("rejects malformed and plaintext-marked envelopes", async () => {
    const a = await createDevice();
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope: { v: 2 } } })).status).toBe(400);
    expect((await apiFetch("/api/send", {
      token: a.token,
      body: { envelope: { v: 1, id: "01ABCDEFGHIJK", kind: "text", plain: true, text: "hi", wrap: { mode: "self", iv: "x", cek: "y" }, ct: "z" } },
    })).status).toBe(400);
  });
});

describe("inbox (§10)", () => {
  it("lists, marks read (keeps content), deletes globally", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);

    const envelope = await C.encryptTextEnvelope(a.kMaster, "秘密");
    await apiFetch("/api/send", { token: a.token, body: { envelope } });

    // The other device pulls the inbox and decrypts.
    let list = await json(await apiFetch("/api/messages", { token: b.token }));
    expect(list.messages).toHaveLength(1);
    const m = list.messages[0];
    expect(m.readAt).toBeNull();
    expect(m.from).toBe("Pixel");
    expect(await C.decryptTextEnvelope(b.kMaster, m.envelope)).toBe("秘密");

    // Read marks but does not delete (§10: no read-once).
    await apiFetch(`/api/messages/${m.msgId}/read`, { method: "POST", token: b.token, body: {} });
    list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages[0].readAt).not.toBeNull();
    expect(list.messages[0].envelope).toBeTruthy();

    // Global delete: gone for every device; re-delete → 404 (§10.1).
    expect((await apiFetch(`/api/messages/${m.msgId}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await apiFetch(`/api/messages/${m.msgId}`, { method: "DELETE", token: b.token })).status).toBe(404);
    list = await json(await apiFetch("/api/messages", { token: b.token }));
    expect(list.messages).toHaveLength(0);
  });

  it("hides expired messages from the list", async () => {
    const a = await createDevice();
    const envelope = await C.encryptTextEnvelope(a.kMaster, "old");
    await apiFetch("/api/send", { token: a.token, body: { envelope } });
    await env.DB.prepare("UPDATE messages SET expires_at = ? WHERE msg_id = ?")
      .bind(Date.now() - 1000, envelope.id).run();
    const list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages).toHaveLength(0);
  });

  it("does not leak messages across users", async () => {
    const a = await createDevice();
    const stranger = await createDevice("Attacker", "someone");
    const envelope = await C.encryptTextEnvelope(a.kMaster, "private");
    await apiFetch("/api/send", { token: a.token, body: { envelope } });
    const list = await json(await apiFetch("/api/messages", { token: stranger.token }));
    expect(list.messages).toHaveLength(0);
    expect((await apiFetch(`/api/messages/${envelope.id}`, { method: "DELETE", token: stranger.token })).status).toBe(404);
  });
});

describe("file path (§3.2, §4.3)", () => {
  async function preparedFile(dev: Awaited<ReturnType<typeof createDevice>>, size = 2048) {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    return { bytes, ...(await C.encryptFileEnvelope(dev.kMaster, dev.userId, bytes, "photo.webp", "image/webp")) };
  }

  it("upload → send → notify → download → decrypt, end to end", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    const { bytes, envelope, ciphertext } = await preparedFile(a);

    const up = await json(await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength },
    }));
    expect(up.key).toBe(envelope.obj);
    const put = await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect(put.status).toBe(200);

    const sent = await json(await apiFetch("/api/send", { token: a.token, body: { envelope } }));
    expect(sent.receipts[0].ok).toBe(true);
    const pushes = await drainPushes();
    expect(pushes[0].ttl).toBe("86400"); // §8.2 file TTL

    // Receiver: push carries only the pointer; content comes from R2.
    const payload = await openPush(b, pushes[0]);
    expect(payload.envelope.ct).toBeNull();
    expect(payload.envelope.obj).toBe(envelope.obj);
    const meta = await C.decryptFileMeta(b.kMaster, payload.envelope);
    expect(meta.name).toBe("photo.webp");

    const dl = await json(await apiFetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { token: b.token }));
    const got = await apiFetch(dl.url);
    expect(got.status).toBe(200);
    const cipher = new Uint8Array(await got.arrayBuffer());
    expect(await C.decryptFileBody(b.kMaster, payload.envelope, cipher)).toEqual(bytes);
  });

  it("rejects uploads over 20 MB at declaration time", async () => {
    const a = await createDevice();
    const res = await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: "01ABCDEFGHIJK", size: 21 * 1024 * 1024 },
    });
    expect(res.status).toBe(413);
  });

  it("rejects a PUT whose actual size differs from the declared size", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const up = await json(await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength + 10 },
    }));
    const put = await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect(put.status).toBe(409);
  });

  it("rejects send when the object is missing (§3.2 step 5)", async () => {
    const a = await createDevice();
    const { envelope } = await preparedFile(a);
    const res = await apiFetch("/api/send", { token: a.token, body: { envelope } });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("object_missing");
  });

  it("deletes the object and rejects when declared size lies (§4.3)", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const up = await json(await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength },
    }));
    await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    envelope.size = ciphertext.byteLength - 5; // lie in the envelope
    const res = await apiFetch("/api/send", { token: a.token, body: { envelope } });
    expect(res.status).toBe(409);
    expect(await env.INBOX.head(envelope.obj)).toBeNull(); // evidence destroyed
  });

  it("blocks foreign keys and tampered signatures", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    // Can't mint an upload URL into someone else's prefix via envelope.obj on send.
    const { envelope } = await preparedFile(a);
    const foreign = { ...envelope, obj: `u/${stranger.userId}/inbox/${envelope.id}` };
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope: foreign } })).status).toBe(403);
    // Download URL for another user's key is refused.
    expect((await apiFetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { token: stranger.token })).status).toBe(403);
    // Tampered signature is refused.
    const up = await json(await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: envelope.id, size: 10 },
    }));
    const bad = up.url.replace(/sig=[^&]+/, "sig=AAAA");
    expect((await apiFetch(bad, { method: "PUT", raw: new Uint8Array(10) as unknown as BodyInit })).status).toBe(403);
  });

  it("clear-all removes rows and R2 objects", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const up = await json(await apiFetch("/api/upload-url", {
      token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength },
    }));
    await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    await apiFetch("/api/send", { token: a.token, body: { envelope } });
    expect(await env.INBOX.head(envelope.obj)).not.toBeNull();

    const res = await json(await apiFetch("/api/messages", { method: "DELETE", token: a.token }));
    expect(res.deleted).toBe(1);
    expect(await env.INBOX.head(envelope.obj)).toBeNull();
  });
});

describe("subscription lifecycle (§8.3)", () => {
  it("deletes the subscription immediately on 410 Gone", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    // The sink replies 410 to any path containing "gone" — simulate a dead endpoint.
    await env.DB.prepare("UPDATE subscriptions SET endpoint = ? WHERE device_id = ?")
      .bind(`https://push.test/gone/${b.deviceId}`, b.deviceId).run();

    const envelope = await C.encryptTextEnvelope(a.kMaster, "hi");
    const res = await json(await apiFetch("/api/send", { token: a.token, body: { envelope } }));
    expect(res.receipts[0].ok).toBe(false);
    const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE device_id = ?").bind(b.deviceId).first();
    expect(sub).toBeNull();
  });

  it("increments fail_count on other errors and deletes after 5", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    await env.DB.prepare("UPDATE subscriptions SET endpoint = ? WHERE device_id = ?")
      .bind(`https://push.test/fail/${b.deviceId}`, b.deviceId).run();

    for (let i = 1; i <= 5; i++) {
      const envelope = await C.encryptTextEnvelope(a.kMaster, `try ${i}`);
      await apiFetch("/api/send", { token: a.token, body: { envelope } });
      const sub = await env.DB.prepare("SELECT fail_count FROM subscriptions WHERE device_id = ?")
        .bind(b.deviceId).first<{ fail_count: number }>();
      if (i < 5) expect(sub?.fail_count).toBe(i);
      else expect(sub).toBeNull(); // §8.3: gone after 5 consecutive failures
    }
  });

  it("re-subscribing resets fail_count (app relaunch re-sync)", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    await env.DB.prepare("UPDATE subscriptions SET fail_count = 3 WHERE device_id = ?").bind(b.deviceId).run();
    await subscribeDevice(b);
    const sub = await env.DB.prepare("SELECT fail_count FROM subscriptions WHERE device_id = ?")
      .bind(b.deviceId).first<{ fail_count: number }>();
    expect(sub?.fail_count).toBe(0);
  });

  it("test push reaches every subscribed device including the sender (§8.4)", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(a);
    await subscribeDevice(b);
    const res = await json(await apiFetch("/api/test-push", { method: "POST", token: a.token, body: {} }));
    expect(res.receipts).toHaveLength(2);
    const pushes = await drainPushes();
    expect(pushes).toHaveLength(2);
    const payload = await openPush(a, pushes.find((p) => p.url.includes(a.deviceId))!);
    expect(payload.t).toBe("test");
  });
});

describe("settings (§10.2)", () => {
  it("accepts only 1 / 7 / 30 days and applies to new messages", async () => {
    const a = await createDevice();
    expect((await apiFetch("/api/settings", { token: a.token, body: { retention_days: 3 } })).status).toBe(400);
    expect((await apiFetch("/api/settings", { token: a.token, body: { retention_days: 1 } })).status).toBe(200);

    const envelope = await C.encryptTextEnvelope(a.kMaster, "short-lived");
    const res = await json(await apiFetch("/api/send", { token: a.token, body: { envelope } }));
    const days = (res.expiresAt - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(0.9);
    expect(days).toBeLessThan(1.1);
  });
});

describe("devices", () => {
  it("removes a device and its subscription", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    const res = await apiFetch(`/api/devices/${b.deviceId}`, { method: "DELETE", token: a.token });
    expect(res.status).toBe(200);
    expect((await apiFetch("/api/me", { token: b.token })).status).toBe(401);
    expect(await env.DB.prepare("SELECT * FROM subscriptions WHERE device_id = ?").bind(b.deviceId).first()).toBeNull();
  });

  it("renames devices — the current one included — visible to the whole user", async () => {
    const a = await createDevice("Pixel");
    const b = await pairNewDevice(a, "MacBook");

    // Rename the OTHER device and the CURRENT device.
    expect((await apiFetch(`/api/devices/${b.deviceId}/label`, { token: a.token, body: { label: "工作筆電" } })).status).toBe(200);
    expect((await apiFetch(`/api/devices/${a.deviceId}/label`, { token: a.token, body: { label: "我的手機" } })).status).toBe(200);

    const me = await json(await apiFetch("/api/me", { token: b.token }));
    const labels = Object.fromEntries(me.devices.map((d: any) => [d.deviceId, d.label]));
    expect(labels[a.deviceId]).toBe("我的手機");
    expect(labels[b.deviceId]).toBe("工作筆電");

    // The new label rides along in push receipts / from fields.
    await subscribeDevice(b);
    const envelope = await C.encryptTextEnvelope(a.kMaster, "hello");
    const res = await json(await apiFetch("/api/send", { token: a.token, body: { envelope } }));
    expect(res.receipts[0].label).toBe("工作筆電");
  });

  it("rejects empty labels and other users' devices", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    expect((await apiFetch(`/api/devices/${a.deviceId}/label`, { token: a.token, body: { label: "   " } })).status).toBe(400);
    expect((await apiFetch(`/api/devices/${a.deviceId}/label`, { token: stranger.token, body: { label: "hijack" } })).status).toBe(404);
    const me = await json(await apiFetch("/api/me", { token: a.token }));
    expect(me.devices[0].label).toBe("Pixel");
  });

  it("cannot remove another user's device", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    const res = await apiFetch(`/api/devices/${a.deviceId}`, { method: "DELETE", token: stranger.token });
    expect(res.status).toBe(404);
  });
});
