// §12 API tokens: send-only, plaintext mode opt-in and tightly fenced.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { C, apiFetch, createDevice, drainPushes, json, openPush, pairNewDevice, subscribeDevice } from "./helpers";

async function makeToken(dev: Awaited<ReturnType<typeof createDevice>>, opts: { plaintext?: boolean; rate?: number } = {}) {
  return json(await apiFetch("/api/tokens", {
    token: dev.token,
    body: { label: "NAS 備份腳本", plaintext_ok: opts.plaintext ?? false, rate_limit: opts.rate ?? 60 },
  }));
}

describe("token management (§12.5)", () => {
  it("shows the token exactly once and stores only a hash", async () => {
    const a = await createDevice();
    const created = await makeToken(a);
    expect(created.token).toMatch(/^bd_/);
    const row = await env.DB.prepare("SELECT * FROM api_tokens WHERE token_id = ?").bind(created.tokenId).first<any>();
    expect(JSON.stringify(row)).not.toContain(created.token);
    const list = await json(await apiFetch("/api/tokens", { token: a.token }));
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(list.tokens[0].label).toBe("NAS 備份腳本");
  });

  it("revocation is immediate", async () => {
    const a = await createDevice();
    const created = await makeToken(a, { plaintext: true });
    expect((await apiFetch("/api/push", { token: created.token, body: { text: "ok" } })).status).toBe(200);
    await apiFetch(`/api/tokens/${created.tokenId}/revoke`, { method: "POST", token: a.token, body: {} });
    expect((await apiFetch("/api/push", { token: created.token, body: { text: "after revoke" } })).status).toBe(401);
  });

  it("device bearer tokens cannot call /api/push and API tokens cannot read", async () => {
    const a = await createDevice();
    const created = await makeToken(a, { plaintext: true });
    expect((await apiFetch("/api/push", { token: a.token, body: { text: "x" } })).status).toBe(401);
    // send-only: every read/other endpoint refuses the API token
    expect((await apiFetch("/api/messages", { token: created.token })).status).toBe(401);
    expect((await apiFetch("/api/me", { token: created.token })).status).toBe(401);
  });
});

describe("plaintext mode (§12.4)", () => {
  it("is opt-in per token", async () => {
    const a = await createDevice();
    const noPlain = await makeToken(a, { plaintext: false });
    const res = await apiFetch("/api/push", { token: noPlain.token, body: { text: "建置完成" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("plaintext_disabled");
  });

  it("delivers plaintext pushes tagged plain, visible in the inbox with 未加密 semantics", async () => {
    const a = await createDevice();
    await subscribeDevice(a);
    const tok = await makeToken(a, { plaintext: true });
    await drainPushes();

    const res = await json(await apiFetch("/api/push", { token: tok.token, body: { text: "每日備份完成,共 42 GB" } }));
    expect(res.receipts).toHaveLength(1);

    // Push payload is plaintext-marked; no decryption needed by the SW.
    const pushes = await drainPushes();
    const payload = await openPush(a, pushes[0]);
    expect(payload.envelope.plain).toBe(true);
    expect(payload.envelope.text).toBe("每日備份完成,共 42 GB");
    expect(payload.from).toBe("NAS 備份腳本");

    // Inbox shows it flagged as via-token (UI renders the 未加密 tag from plain).
    const list = await json(await apiFetch("/api/messages", { token: a.token }));
    expect(list.messages[0].viaToken).toBe(true);
    expect(list.messages[0].envelope.plain).toBe(true);
    expect(list.messages[0].from).toBe("NAS 備份腳本");
  });

  it("rejects text over 2000 bytes (§12.4: no R2, push payload only)", async () => {
    const a = await createDevice();
    const tok = await makeToken(a, { plaintext: true });
    expect((await apiFetch("/api/push", { token: tok.token, body: { text: "字".repeat(700) } })).status).toBe(413);
  });

  it("never accepts files — plaintext is text-only", async () => {
    const a = await createDevice();
    const tok = await makeToken(a, { plaintext: true });
    const fileEnvelope = {
      v: 1, id: "01ABCDEFGHIJK", kind: "text", wrap: { mode: "ecdh-p256", iv: "aa", cek: "bb" },
      obj: `u/${a.userId}/inbox/01ABCDEFGHIJK`, ct: null,
    };
    const res = await apiFetch("/api/push", { token: tok.token, body: { envelope: fileEnvelope } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("no_files");
  });

  it("enforces the per-token hourly rate limit", async () => {
    const a = await createDevice();
    const tok = await makeToken(a, { plaintext: true, rate: 2 });
    expect((await apiFetch("/api/push", { token: tok.token, body: { text: "1" } })).status).toBe(200);
    expect((await apiFetch("/api/push", { token: tok.token, body: { text: "2" } })).status).toBe(200);
    expect((await apiFetch("/api/push", { token: tok.token, body: { text: "3" } })).status).toBe(429);
  });
});

describe("public-key mode (§12.3 — protocol live, no CLI yet)", () => {
  it("accepts an ecdh-p256 text envelope without ever seeing plaintext", async () => {
    const a = await createDevice();
    await subscribeDevice(a);
    const tok = await makeToken(a); // plaintext NOT enabled — e2e mode works anyway
    await drainPushes();

    // Simulate what the future CLI does: wrap a CEK via ECDH against the
    // user's identity public key. For the transport test the wrap contents
    // just need to be well-formed base64url.
    const envelope = {
      v: 1, id: C.ulid(), kind: "text",
      wrap: { mode: "ecdh-p256", iv: C.b64u(crypto.getRandomValues(new Uint8Array(12))), cek: C.b64u(crypto.getRandomValues(new Uint8Array(48))) },
      iv: C.b64u(crypto.getRandomValues(new Uint8Array(12))),
      ct: C.b64u(new TextEncoder().encode("ciphertext-bytes")),
      obj: null, size: 0, ts: Date.now(),
    };
    const res = await apiFetch("/api/push", { token: tok.token, body: { envelope } });
    expect(res.status).toBe(200);
    const pushes = await drainPushes();
    const payload = await openPush(a, pushes[0]);
    expect(payload.envelope.wrap.mode).toBe("ecdh-p256");
  });

  it("refuses self-wrapped envelopes from API tokens (they must not know K_master)", async () => {
    const a = await createDevice();
    const tok = await makeToken(a);
    const envelope = await C.encryptTextEnvelope(a.kMaster, "should not pass");
    expect((await apiFetch("/api/push", { token: tok.token, body: { envelope } })).status).toBe(400);
  });
});
