// §10 cleanup: the cron deletes expired message rows + R2 objects and stale
// pairings. (The R2 lifecycle rule is the second line of defense in prod.)
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanupExpired } from "../src/cron";
import { C, apiFetch, createDevice, json } from "./helpers";

describe("cron cleanup (§10)", () => {
  it("removes expired messages and their R2 objects, keeps live ones", async () => {
    const a = await createDevice();

    // Live text message
    const live = await C.encryptTextEnvelope(a.kMaster, "still fresh");
    await apiFetch("/api/send", { token: a.token, body: { envelope: live } });

    // Expired file message (upload through the real path, then age it)
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    const { envelope, ciphertext } = await C.encryptFileEnvelope(a.kMaster, a.userId, bytes, "old.bin", "application/octet-stream");
    const up = await json(await apiFetch("/api/upload-url", { token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength } }));
    await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    await apiFetch("/api/send", { token: a.token, body: { envelope } });
    await env.DB.prepare("UPDATE messages SET expires_at = ? WHERE msg_id = ?").bind(Date.now() - 1, envelope.id).run();

    const result = await cleanupExpired(env);
    expect(result.messages).toBe(1);

    expect(await env.INBOX.head(envelope.obj)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE msg_id = ?").bind(envelope.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE msg_id = ?").bind(live.id).first()).not.toBeNull();
  });

  it("removes expired pairings", async () => {
    const a = await createDevice();
    const created = await json(await apiFetch("/api/pair/create", { method: "POST", token: a.token, body: {} }));
    await env.DB.prepare("UPDATE pairings SET expires_at = ? WHERE pair_id = ?").bind(Date.now() - 1, created.pairId).run();
    const result = await cleanupExpired(env);
    expect(result.pairings).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT 1 FROM pairings WHERE pair_id = ?").bind(created.pairId).first()).toBeNull();
  });

  it("is idempotent", async () => {
    const first = await cleanupExpired(env);
    const second = await cleanupExpired(env);
    expect(second.messages).toBe(0);
    expect(second.pairings).toBe(0);
    void first;
  });
});

describe("worker surface", () => {
  it("serves health and the public VAPID key", async () => {
    const health = await json(await apiFetch("/api/health"));
    expect(health.ok).toBe(true);
    const vapid = await json(await apiFetch("/api/vapid"));
    expect(vapid.vapidPublicKey).toBe(env.VAPID_PUBLIC_KEY);
  });

  it("404s unknown API routes", async () => {
    const a = await createDevice();
    expect((await apiFetch("/api/nope", { token: a.token })).status).toBe(404);
  });
});
