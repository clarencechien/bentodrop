// RFC 8291 / RFC 8292 unit tests for the Worker's Web Push layer.
import { describe, expect, it } from "vitest";
import { encryptPushPayload, vapidAuthHeader } from "../src/lib/webpush";
import { b64u, decryptPushBody, td, te, unb64u, type TestDevice } from "./helpers";

async function makeReceiver(): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    push: {
      endpoint: "https://push.example/x",
      p256dh: b64u(publicRaw),
      auth: b64u(authSecret),
      privateKey: pair.privateKey,
      publicRaw,
      authSecret,
    },
  } as TestDevice;
}

describe("RFC 8291 aes128gcm", () => {
  it("round-trips a payload through encrypt → receiver decrypt", async () => {
    const dev = await makeReceiver();
    const payload = JSON.stringify({ t: "msg", body: "跨裝置剪貼簿 📋" });
    const body = await encryptPushPayload(te.encode(payload), dev.push!.p256dh, dev.push!.auth);
    expect(await decryptPushBody(dev, body)).toBe(payload);
  });

  it("has a well-formed aes128gcm header", async () => {
    const dev = await makeReceiver();
    const body = await encryptPushPayload(te.encode("x"), dev.push!.p256dh, dev.push!.auth);
    const view = new DataView(body.buffer, body.byteOffset);
    expect(view.getUint32(16)).toBe(4096); // rs
    expect(body[20]).toBe(65);             // idlen = uncompressed P-256 point
    expect(body[21]).toBe(0x04);           // uncompressed point marker
  });

  it("stays under the ~4KB push budget for a max-size envelope", async () => {
    const dev = await makeReceiver();
    const payload = "x".repeat(3800); // PUSH_ENVELOPE_MAX
    const body = await encryptPushPayload(te.encode(payload), dev.push!.p256dh, dev.push!.auth);
    expect(body.byteLength).toBeLessThanOrEqual(4096);
  });

  it("cannot be decrypted by a different receiver", async () => {
    const a = await makeReceiver();
    const b = await makeReceiver();
    const body = await encryptPushPayload(te.encode("secret"), a.push!.p256dh, a.push!.auth);
    await expect(decryptPushBody(b, body)).rejects.toThrow();
  });
});

describe("RFC 8292 VAPID", () => {
  it("produces a valid ES256 JWT bound to the endpoint origin", async () => {
    const keys = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicRaw = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer));
    const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey));

    const header = await vapidAuthHeader(
      "https://fcm.googleapis.com/fcm/send/abc123", publicRaw, privateJwk, "mailto:me@example.com",
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();
    expect(m[2]).toBe(publicRaw);

    const [h, p, s] = m[1].split(".");
    const claims = JSON.parse(td.decode(unb64u(p)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:me@example.com");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600); // spec: ≤24h

    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      unb64u(s) as BufferSource,
      te.encode(`${h}.${p}`) as BufferSource,
    );
    expect(ok).toBe(true);
  });
});
