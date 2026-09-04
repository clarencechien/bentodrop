#!/usr/bin/env node
// Zero-setup deploy for BentoDrop — safe to run as the Workers Builds deploy
// command (`npm run deploy`) or locally with a logged-in wrangler.
//
//   1. `wrangler deploy`         — Cloudflare auto-provisions D1 + R2 on the
//                                  first run (no ids pinned in wrangler.jsonc)
//   2. ensure secrets            — generate VAPID keypair + URL signing secret
//                                  once, only if missing (secret bulk = one
//                                  extra version). VAPID keys are NEVER
//                                  regenerated: rotating them kills every
//                                  push subscription (§8.5).
//   3. apply D1 migrations       — after deploy so the database exists
//   4. R2 lifecycle backstop     — u/ prefix expires after 7 days (§4.1)

import { execSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sh = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
};
const capture = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── 1. deploy (provisions D1/R2 on first run) ─────────────────────────
sh("npx wrangler deploy");

// ── 2. secrets ────────────────────────────────────────────────────────
// ⚠️ 2026-09-04 修正:這裡原本 catch 之後只印一句警告、讓 secretList 維持空字串,
// 於是下面的 missing 判斷會認為三把 secret 全都缺,把它們**全部重新生成並覆蓋**,
// 包含 VAPID 私鑰 —— 與 README 的「絕不覆蓋已存在的 secrets」完全相反。
// 後果:任何一次 push 遇到暫時性的 API 錯誤,就會讓所有既有推送訂閱與所有
// 未過期的簽章 URL 一起失效,而且沒有任何跡象。
// 列不出來就是「不知道」,不是「沒有」——直接中止,讓人來看。
let secretList = "";
try {
  secretList = capture("npx wrangler secret list");
} catch (e) {
  console.error("could not list secrets — aborting rather than assuming none exist.");
  console.error("re-running with existing secrets absent would regenerate the VAPID keypair");
  console.error("and kill every push subscription. check `npx wrangler whoami` and retry.");
  console.error(String(e?.message ?? e));
  process.exit(1);
}
// `wrangler secret list` output is JSON-ish; a plain substring check on the
// exact secret name is format-agnostic and safe (names don't overlap).
const missing = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_JWK", "URL_SIGNING_SECRET"]
  .filter((name) => !secretList.includes(name));

if (missing.length > 0) {
  const bulk = {};
  if (missing.includes("VAPID_PUBLIC_KEY") || missing.includes("VAPID_PRIVATE_JWK")) {
    console.log("generating VAPID keypair (one-time — rotating later would kill all subscriptions)");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    bulk.VAPID_PUBLIC_KEY = b64url(await crypto.subtle.exportKey("raw", keys.publicKey));
    bulk.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey));
  }
  if (missing.includes("URL_SIGNING_SECRET")) {
    bulk.URL_SIGNING_SECRET = b64url(crypto.getRandomValues(new Uint8Array(32)));
  }
  const dir = mkdtempSync(path.join(tmpdir(), "bentodrop-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(bulk));
    sh(`npx wrangler secret bulk ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log("secrets already set — leaving them untouched");
}

// ── 3. migrations ─────────────────────────────────────────────────────
sh("npx wrangler d1 migrations apply bentodrop --remote");

// ── 4. R2 lifecycle backstop (best effort, idempotent) ────────────────
try {
  const rules = capture("npx wrangler r2 bucket lifecycle list bentodrop-inbox");
  if (!rules.includes("expire-inbox")) {
    sh('npx wrangler r2 bucket lifecycle add bentodrop-inbox --name expire-inbox --prefix "u/" --expire-days 7 --force');
  } else {
    console.log("R2 lifecycle rule already present");
  }
  if (!rules.includes("expire-diag")) {
    sh('npx wrangler r2 bucket lifecycle add bentodrop-inbox --name expire-diag --prefix "diag/" --expire-days 1 --force');
  }
} catch (err) {
  console.warn("⚠ could not verify the R2 lifecycle rule — add it in the dashboard if missing:");
  console.warn("  bucket bentodrop-inbox, prefix u/, delete after 7 days (§4.1)");
}

console.log("\n✔ deploy complete");
