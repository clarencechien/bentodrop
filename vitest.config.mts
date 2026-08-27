import path from "node:path";
import { webcrypto } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const b64url = (buf: ArrayBuffer) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// Fresh VAPID keypair per test run.
const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const vapidPublic = b64url(await webcrypto.subtle.exportKey("raw", keys.publicKey));
const vapidPrivateJwk = JSON.stringify(await webcrypto.subtle.exportKey("jwk", keys.privateKey));

// A fake push service: every outbound fetch from the Worker under test lands
// here. It records push POSTs (so tests can decrypt the real RFC 8291 bodies)
// and simulates dead endpoints (410) and flaky ones (500) by path.
const PUSH_SINK_SCRIPT = /* js */ `
const captured = [];
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__captured") {
      return Response.json(captured.splice(0));
    }
    if (req.method === "POST") {
      const body = new Uint8Array(await req.arrayBuffer());
      let b64 = "";
      for (let i = 0; i < body.length; i++) b64 += String.fromCharCode(body[i]);
      captured.push({
        url: req.url,
        ttl: req.headers.get("ttl"),
        authorization: req.headers.get("authorization"),
        contentEncoding: req.headers.get("content-encoding"),
        body: btoa(b64),
      });
      if (url.pathname.includes("gone")) return new Response("", { status: 410 });
      if (url.pathname.includes("fail")) return new Response("", { status: 500 });
      return new Response("", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: "push-sink",
        bindings: {
          TEST_MIGRATIONS: migrations,
          VAPID_PUBLIC_KEY: vapidPublic,
          VAPID_PRIVATE_JWK: vapidPrivateJwk,
          VAPID_SUBJECT: "mailto:test@example.com",
          URL_SIGNING_SECRET: "test-url-signing-secret",
        },
        workers: [
          {
            name: "push-sink",
            modules: [{ type: "ESModule", path: "push-sink.mjs", contents: PUSH_SINK_SCRIPT }],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
