// §12.3 CLI: the exact code in cli/lib.mjs runs against the real Worker.
// Send-only property holds end to end: the token pushes ciphertext it can
// never read back; only the user's identity key opens it.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without types
import { pushEncrypted, pushPlaintext } from "../cli/lib.mjs";
import { C, apiFetch, createDevice, drainPushes, json, openPush, setupIdentity, subscribeDevice } from "./helpers";

const fetchFn = (url: string, init?: RequestInit) => SELF.fetch(url, init);
const BASE = "https://bentodrop.test";

async function makeToken(dev: Awaited<ReturnType<typeof createDevice>>, plaintext = false) {
  return json(await apiFetch("/api/tokens", { token: dev.token, body: { label: "ci-script", plaintext_ok: plaintext } }));
}

beforeEach(async () => {
  await drainPushes();
});

describe("bentodrop-push CLI (§12.3)", () => {
  it("encrypted mode: fetches the pubkey, wraps a CEK, and the user decrypts", async () => {
    const dev = await createDevice();
    const identity = await setupIdentity(dev);
    await subscribeDevice(dev);
    const tok = await makeToken(dev);
    await drainPushes();

    const res = await pushEncrypted({ baseUrl: BASE, token: tok.token, text: "建置完成 ✓", fetchFn });
    expect(res.msgId).toBeTruthy();
    expect(res.receipts).toHaveLength(1);

    // The push payload is ciphertext the token could never produce a reader for.
    const pushes = await drainPushes();
    const payload = await openPush(dev, pushes[0]);
    expect(payload.envelope.wrap.mode).toBe("ecdh-p256");
    expect(JSON.stringify(payload.envelope)).not.toContain("建置完成");
    expect(await C.decryptTextEnvelope({ identityPriv: identity.privateKey }, payload.envelope)).toBe("建置完成 ✓");

    // And it lands in the inbox NOT marked plaintext.
    const list = await json(await apiFetch("/api/messages", { token: dev.token }));
    expect(list.messages[0].envelope.plain).toBeUndefined();
    expect(list.messages[0].viaToken).toBe(true);
  });

  it("fails with guidance when the user has no identity yet", async () => {
    const dev = await createDevice();
    const tok = await makeToken(dev);
    await expect(pushEncrypted({ baseUrl: BASE, token: tok.token, text: "x", fetchFn }))
      .rejects.toThrow(/pubkey.*409/s);
  });

  it("plaintext mode works only on tokens that allow it", async () => {
    const dev = await createDevice();
    const strict = await makeToken(dev, false);
    await expect(pushPlaintext({ baseUrl: BASE, token: strict.token, text: "x", fetchFn }))
      .rejects.toThrow(/403/);
    const loose = await makeToken(dev, true);
    const res = await pushPlaintext({ baseUrl: BASE, token: loose.token, text: "磁碟 85%", fetchFn });
    expect(res.msgId).toBeTruthy();
  });
});
