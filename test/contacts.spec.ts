// Phase 2 (§11 / §6.7): identity keys, add-friend flow, cross-user sends.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  C, apiFetch, createDevice, drainPushes, json, makeFriends, openPush, setupIdentity, subscribeDevice,
} from "./helpers";

beforeEach(async () => {
  await drainPushes();
});

describe("user identity (§5.2)", () => {
  it("is created once; later devices converge on the stored pair", async () => {
    const a = await createDevice();
    expect((await apiFetch("/api/identity", { token: a.token })).status).toBe(404);

    const first = await setupIdentity(a);
    // A second setIdentity (e.g. a sibling device racing) gets the FIRST pair back.
    const pair2 = await C.generateIdentityPair();
    const res = await json(await apiFetch("/api/identity", {
      token: a.token,
      body: { identity_pub: pair2.publicJwk, identity_priv_wrapped: await C.encryptJson(a.kMaster, pair2.privateJwk) },
    }));
    expect(res.created).toBe(false);
    expect(res.identityPub).toEqual(first.publicJwk);
  });

  it("stores the private key only as K_master ciphertext", async () => {
    const a = await createDevice();
    const identity = await setupIdentity(a);
    const row = await env.DB.prepare("SELECT identity_priv_wrapped FROM users WHERE user_id = ?")
      .bind(a.userId).first<{ identity_priv_wrapped: string }>();
    // The private scalar (JWK "d") must not appear in what the server stores.
    const privJwk = await crypto.subtle.exportKey("jwk", await crypto.subtle.importKey(
      "jwk", identity.publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, [],
    ));
    void privJwk;
    expect(row!.identity_priv_wrapped).not.toContain('"d"');
  });
});

describe("add-friend flow (§6.7)", () => {
  it("writes both contact rows after explicit approval", async () => {
    const a = await createDevice("Pixel", "ming");
    const b = await createDevice("iPhone", "mei");
    await makeFriends(a, b, "阿明", "小美");

    const aList = await json(await apiFetch("/api/contacts", { token: a.token }));
    const bList = await json(await apiFetch("/api/contacts", { token: b.token }));
    expect(aList.contacts).toHaveLength(1);
    expect(aList.contacts[0].peerUserId).toBe(b.userId);
    expect(aList.contacts[0].label).toBe("小美");
    expect(bList.contacts[0].peerUserId).toBe(a.userId);
    expect(bList.contacts[0].label).toBe("阿明");
  });

  it("keeps the guardrails: 3 wrong codes void the invite, single use, 30-min TTL", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    await setupIdentity(a);
    await setupIdentity(b);
    const inv = await json(await apiFetch("/api/contacts/invite", { token: a.token, body: { myName: "A" } }));
    expect(inv.expiresAt - Date.now()).toBeGreaterThan(29 * 60 * 1000); // §6.7: 30 min

    const wrong = inv.code === "000000" ? "111111" : "000000";
    const claim = (code: string) =>
      apiFetch("/api/contacts/claim", { token: b.token, body: { pairId: inv.pairId, code, myName: "B" } });
    expect((await claim(wrong)).status).toBe(403);
    expect((await claim(wrong)).status).toBe(403);
    expect((await claim(wrong)).status).toBe(410);
    expect((await claim(inv.code)).status).toBe(410);
  });

  it("rejects self-invites and double approval", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    await setupIdentity(a);
    await setupIdentity(b);
    const inv = await json(await apiFetch("/api/contacts/invite", { token: a.token, body: { myName: "A" } }));
    expect((await apiFetch("/api/contacts/claim", {
      token: a.token, body: { pairId: inv.pairId, code: inv.code, myName: "A" },
    })).status).toBe(400); // self
    await apiFetch("/api/contacts/claim", { token: b.token, body: { pairId: inv.pairId, code: inv.code, myName: "B" } });
    expect((await apiFetch(`/api/contacts/invite/${inv.pairId}/approve`, { token: a.token, body: {} })).status).toBe(200);
    expect((await apiFetch(`/api/contacts/invite/${inv.pairId}/approve`, { token: a.token, body: {} })).status).toBe(410);
  });

  it("supports rename and unfriend", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    await makeFriends(a, b);
    expect((await apiFetch(`/api/contacts/${b.userId}/label`, { token: a.token, body: { label: "家人" } })).status).toBe(200);
    const list = await json(await apiFetch("/api/contacts", { token: a.token }));
    expect(list.contacts[0].label).toBe("家人");
    expect((await apiFetch(`/api/contacts/${b.userId}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await json(await apiFetch("/api/contacts", { token: a.token }))).contacts).toHaveLength(0);
  });
});

describe("cross-user send (§11)", () => {
  it("delivers an ecdh-p256 envelope only the recipient's identity key can open", async () => {
    const a = await createDevice("Pixel", "ming");
    const b = await createDevice("iPhone", "mei");
    const { bIdentity } = await makeFriends(a, b, "阿明", "小美");
    await subscribeDevice(b);
    await drainPushes();

    const text = "晚餐吃什麼?";
    const envelope = await C.encryptTextEnvelopeFor(bIdentity.publicJwk, text);
    const res = await json(await apiFetch("/api/send", { token: a.token, body: { envelope, to: b.userId } }));
    // Receipts are masked — no peer device ids or labels leak to the sender.
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].label).toBeNull();
    expect(res.receipts[0].deviceId).toBe("peer-1");

    const pushes = await drainPushes();
    const payload = await openPush(b, pushes[0]);
    expect(payload.from).toBe("阿明"); // the RECIPIENT's name for the sender
    expect(payload.contact).toBe(true);
    expect(await C.decryptTextEnvelope({ identityPriv: bIdentity.privateKey }, payload.envelope)).toBe(text);

    // Recipient's inbox shows it under their contact label.
    const list = await json(await apiFetch("/api/messages", { token: b.token }));
    expect(list.messages[0].from).toBe("阿明");
    expect(list.messages[0].fromContact).toBe(true);
    // Sender's own inbox does NOT contain it.
    expect((await json(await apiFetch("/api/messages", { token: a.token }))).messages).toHaveLength(0);
  });

  it("requires ecdh-p256 wrapping for cross-user envelopes", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    await makeFriends(a, b);
    const selfWrapped = await C.encryptTextEnvelope(a.kMaster, "nope");
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope: selfWrapped, to: b.userId } })).status).toBe(400);
  });

  it("refuses non-contacts, and unfriending blocks immediately (§11 授權)", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    const stranger = await createDevice("S", "s");
    const { bIdentity } = await makeFriends(a, b);
    await setupIdentity(stranger);

    // A stranger can't send to b.
    const e1 = await C.encryptTextEnvelopeFor(bIdentity.publicJwk, "spam");
    expect((await apiFetch("/api/send", { token: stranger.token, body: { envelope: e1, to: b.userId } })).status).toBe(403);

    // b unfriends a → a's next send bounces.
    await apiFetch(`/api/contacts/${a.userId}`, { method: "DELETE", token: b.token });
    const e2 = await C.encryptTextEnvelopeFor(bIdentity.publicJwk, "hello?");
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope: e2, to: b.userId } })).status).toBe(403);
  });

  it("moves files across users: sender uploads, recipient downloads and decrypts", async () => {
    const a = await createDevice();
    const b = await createDevice("X", "x");
    const c = await createDevice("C", "c");
    const { bIdentity } = await makeFriends(a, b);

    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const { envelope, ciphertext } = await C.encryptFileEnvelopeFor(
      bIdentity.publicJwk, a.userId, bytes, "全家福.webp", "image/webp",
    );
    const up = await json(await apiFetch("/api/upload-url", { token: a.token, body: { msgId: envelope.id, size: ciphertext.byteLength } }));
    await apiFetch(up.url, { method: "PUT", raw: ciphertext as unknown as BodyInit });
    expect((await apiFetch("/api/send", { token: a.token, body: { envelope, to: b.userId } })).status).toBe(200);

    // Recipient may fetch the object even though it sits under the sender's prefix.
    const dl = await json(await apiFetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { token: b.token }));
    const got = await apiFetch(dl.url);
    expect(got.status).toBe(200);
    const cipher = new Uint8Array(await got.arrayBuffer());
    const keys = { identityPriv: bIdentity.privateKey };
    expect(await C.decryptFileBody(keys, envelope, cipher)).toEqual(bytes);
    expect((await C.decryptFileMeta(keys, envelope)).name).toBe("全家福.webp");

    // An unrelated user still can't touch the key.
    expect((await apiFetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { token: c.token })).status).toBe(403);
  });
});

describe("plaintext retention cap (§14)", () => {
  it("caps plaintext messages at 24h even with 7-day retention", async () => {
    const a = await createDevice();
    const tok = await json(await apiFetch("/api/tokens", {
      token: a.token, body: { label: "cron", plaintext_ok: true },
    }));
    const res = await json(await apiFetch("/api/push", { token: tok.token, body: { text: "plain" } }));
    const row = await env.DB.prepare("SELECT expires_at, created_at FROM messages WHERE msg_id = ?")
      .bind(res.msgId).first<{ expires_at: number; created_at: number }>();
    expect(row!.expires_at - row!.created_at).toBeLessThanOrEqual(24 * 3600 * 1000);

    // Encrypted API pushes keep the full user retention.
    const identity = await setupIdentity(a);
    const envelope = await C.encryptTextEnvelopeFor(identity.publicJwk, "enc");
    const res2 = await json(await apiFetch("/api/push", { token: tok.token, body: { envelope } }));
    const row2 = await env.DB.prepare("SELECT expires_at, created_at FROM messages WHERE msg_id = ?")
      .bind(res2.msgId).first<{ expires_at: number; created_at: number }>();
    expect(row2!.expires_at - row2!.created_at).toBeGreaterThan(6 * 24 * 3600 * 1000);
  });
});
