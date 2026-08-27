#!/usr/bin/env node
// One-time Cloudflare resource setup for BentoDrop.
// Requires a logged-in wrangler (`npx wrangler login`) or CLOUDFLARE_API_TOKEN.
//
//   npm run setup
//
// Creates the D1 database + R2 bucket, patches wrangler.jsonc with the real
// database_id + VAPID public key, applies migrations, sets secrets, and
// configures the R2 lifecycle backstop (§4.1: delete under u/ after 7 days).

import { execSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", ...opts });
};
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 1. D1 database
let dbId;
try {
  const out = run("npx wrangler d1 create bentodrop");
  dbId = /database_id\s*=?\s*"?([0-9a-f-]{36})/i.exec(out)?.[1];
  console.log(out);
} catch {
  console.log("d1 create failed (maybe it exists) — looking it up…");
  const list = JSON.parse(run("npx wrangler d1 list --json"));
  dbId = list.find((d) => d.name === "bentodrop")?.uuid;
}
if (!dbId) {
  console.error("Could not determine D1 database_id. Create it manually and edit wrangler.jsonc.");
  process.exit(1);
}
console.log(`D1 database_id: ${dbId}`);

// 2. R2 bucket (+ lifecycle backstop)
try {
  run("npx wrangler r2 bucket create bentodrop-inbox");
} catch {
  console.log("bucket exists, continuing");
}
try {
  run('npx wrangler r2 bucket lifecycle add bentodrop-inbox --name expire-inbox --prefix "u/" --expire-days 7 --force');
} catch {
  console.log("lifecycle rule not added (may already exist) — verify in dashboard: u/ prefix, expire after 7 days");
}

// 3. VAPID keys
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPublic = b64url(await crypto.subtle.exportKey("raw", keys.publicKey));
const vapidPrivateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey));

// 4. Patch wrangler.jsonc
let cfg = readFileSync("wrangler.jsonc", "utf8");
cfg = cfg.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${dbId}"`);
cfg = cfg.replace(/"VAPID_PUBLIC_KEY":\s*"[^"]*"/, `"VAPID_PUBLIC_KEY": "${vapidPublic}"`);
writeFileSync("wrangler.jsonc", cfg);
console.log("wrangler.jsonc updated (commit this change so GitHub deploys use it)");

// 5. Secrets
run("npx wrangler secret put VAPID_PRIVATE_JWK", { input: vapidPrivateJwk });
run("npx wrangler secret put URL_SIGNING_SECRET", { input: b64url(crypto.getRandomValues(new Uint8Array(32))) });

// 6. Migrations
run("npx wrangler d1 migrations apply bentodrop --remote");

console.log(`
✔ Setup complete.

⚠ Changing VAPID keys later invalidates every push subscription (§8.5).
  Treat this keypair as permanent. Next steps:
  1. git add wrangler.jsonc && git commit && git push
  2. Connect the repo in the Cloudflare dashboard (Workers → create → import repository)
     Build command:  npm ci
     Deploy command: npm run deploy
`);
