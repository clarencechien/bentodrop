// Perf round (README 優化 TODO): merged upload flow, encrypted thumbnails,
// and the push-delivery probe. Everything is additive — the classic
// upload-url → PUT → send flow keeps its own tests untouched in api.spec.ts.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  C, apiFetch, createDevice, drainPushes, json, makeFriends, openPush, pairNewDevice, subscribeDevice,
} from "./helpers";

beforeEach(async () => {
  await drainPushes();
});

async function preparedFile(dev: Awaited<ReturnType<typeof createDevice>>, size = 2048, thumb: Uint8Array | null = null) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return { bytes, ...(await C.encryptFileEnvelope(dev.kMaster, dev.userId, bytes, "photo.webp", "image/webp", thumb)) };
}

describe("merged upload flow (intent → PUT finalizes)", () => {
  it("delivers in two round trips: PUT response carries msgId + receipts, push fired", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    await drainPushes();

    const { bytes, envelope, ciphertext } = await preparedFile(a);
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } }));
    expect(intent.url).toContain(`intent=${intent.intentId}`);

    const put = await apiFetch(intent.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect(put.status).toBe(200);
    const res = await json(put);
    expect(res.msgId).toBe(envelope.id);
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].ok).toBe(true);

    // The push carries the same envelope; recipient decrypts as usual.
    const pushes = await drainPushes();
    expect(pushes).toHaveLength(1);
    const payload = await openPush(b, pushes[0]);
    expect(payload.msgId).toBe(envelope.id);
    expect(await C.decryptFileBody(b.kMaster, payload.envelope,
      new Uint8Array(await (await apiFetch((await json(await apiFetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { token: b.token }))).url)).arrayBuffer()),
    )).toEqual(bytes);

    // Inbox row exists exactly once.
    const list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages.filter((m: any) => m.msgId === envelope.id)).toHaveLength(1);
  });

  it("burns the intent: a second PUT with the same URL cannot double-post", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } }));
    expect((await apiFetch(intent.url, { method: "PUT", raw: ciphertext as unknown as BodyInit })).status).toBe(200);
    const again = await apiFetch(intent.url, { method: "PUT", raw: ciphertext.slice() as unknown as BodyInit });
    expect(again.status).toBe(410);
    const list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages).toHaveLength(1);
  });

  it("expired intent → PUT rejected, object removed, no message", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } }));
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE intent_id = ?")
      .bind(Date.now() - 1000, intent.intentId).run();
    const put = await apiFetch(intent.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect(put.status).toBe(410);
    expect(await env.INBOX.head(envelope.obj)).toBeNull();
    expect((await json(await apiFetch("/api/messages", { token: a.token }))).messages).toHaveLength(0);
  });

  it("intent id is inside the HMAC — stripping it invalidates the signature", async () => {
    const a = await createDevice();
    const { envelope, ciphertext } = await preparedFile(a);
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } }));
    const stripped = intent.url.replace(/&intent=[^&]+/, "");
    expect((await apiFetch(stripped, { method: "PUT", raw: ciphertext as unknown as BodyInit })).status).toBe(403);
  });

  it("cross-user intent respects the block switch at finalize time", async () => {
    const a = await createDevice();
    const b = await createDevice("B", "b");
    const { bIdentity } = await makeFriends(a, b);
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    const { envelope, ciphertext } = await C.encryptFileEnvelopeFor(bIdentity.publicJwk, a.userId, bytes, "x.webp", "image/webp");
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope, to: b.userId } }));
    // b unfriends a between intent and PUT.
    await apiFetch(`/api/contacts/${a.userId}`, { method: "DELETE", token: b.token });
    const put = await apiFetch(intent.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect(put.status).toBe(403);
    expect(await env.INBOX.head(envelope.obj)).toBeNull();
    expect((await json(await apiFetch("/api/messages", { token: b.token }))).messages).toHaveLength(0);
  });

  it("rejects non-contact cross-user intents up front", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    const { envelope } = await preparedFile(a);
    expect((await apiFetch("/api/upload-intent", { token: a.token, body: { envelope, to: stranger.userId } })).status).toBe(400); // self-wrap → must be ecdh
  });
});

describe("encrypted thumbnails (優化 #5)", () => {
  it("rides in the envelope, decrypts with the same CEK, and passes the push pipe", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(b);
    await drainPushes();

    const thumb = crypto.getRandomValues(new Uint8Array(900));
    const { envelope, ciphertext } = await preparedFile(a, 4096, thumb);
    expect(envelope.thumb).toBeTruthy();
    const intent = await json(await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } }));
    expect((await apiFetch(intent.url, { method: "PUT", raw: ciphertext as unknown as BodyInit })).status).toBe(200);

    const pushes = await drainPushes();
    const payload = await openPush(b, pushes[0]);
    expect(await C.decryptThumb(b.kMaster, payload.envelope)).toEqual(thumb);
    // The full-size body still decrypts independently of the thumb.
    expect((await C.decryptFileMeta(b.kMaster, payload.envelope)).name).toBe("photo.webp");
  });

  it("an oversized thumb blows the push budget and is rejected server-side", async () => {
    const a = await createDevice();
    const bigThumb = crypto.getRandomValues(new Uint8Array(4000));
    const { envelope } = await preparedFile(a, 1024, bigThumb);
    expect((await apiFetch("/api/upload-intent", { token: a.token, body: { envelope } })).status).toBe(413);
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope } })).status).toBe(413);
  });
});

describe("push-delivery probe (優化 #6)", () => {
  it("relays probe → target only, and pong → origin only", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a);
    await subscribeDevice(a);
    await subscribeDevice(b);
    await drainPushes();

    const probe = await json(await apiFetch("/api/diag/probe", { token: a.token, body: { targetDeviceId: b.deviceId } }));
    expect(probe.pushed).toBe(true);
    let pushes = await drainPushes();
    expect(pushes).toHaveLength(1); // ONLY the target — no notification spam
    expect(pushes[0].url).toContain(b.deviceId);
    const probePayload = await openPush(b, pushes[0]);
    expect(probePayload.t).toBe("probe");
    expect(probePayload.probeId).toBe(probe.probeId);
    expect(probePayload.originDeviceId).toBe(a.deviceId);

    // Target answers (what its SW does automatically).
    expect((await apiFetch("/api/diag/probe-pong", {
      token: b.token, body: { probeId: probe.probeId, originDeviceId: a.deviceId },
    })).status).toBe(200);
    pushes = await drainPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toContain(a.deviceId);
    const pong = await openPush(a, pushes[0]);
    expect(pong.t).toBe("probe-pong");
    expect(pong.probeId).toBe(probe.probeId);
  });

  it("refuses probing devices you don't own, yourself, or unsubscribed targets", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    const b = await pairNewDevice(a); // no subscription
    expect((await apiFetch("/api/diag/probe", { token: a.token, body: { targetDeviceId: stranger.deviceId } })).status).toBe(400);
    expect((await apiFetch("/api/diag/probe", { token: a.token, body: { targetDeviceId: a.deviceId } })).status).toBe(400);
    expect((await apiFetch("/api/diag/probe", { token: a.token, body: { targetDeviceId: b.deviceId } })).status).toBe(409);
    // Pong can only be aimed at a device of the same user.
    expect((await apiFetch("/api/diag/probe-pong", {
      token: a.token, body: { probeId: "abcdefgh", originDeviceId: stranger.deviceId },
    })).status).toBe(403);
  });
});
