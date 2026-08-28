#!/usr/bin/env node
// Push a message to your BentoDrop devices from a script (§12).
//
//   export BENTODROP_URL=https://bentodrop.example
//   export BENTODROP_TOKEN=bd_xxx           # create one in 設定 → API Tokens
//
//   bentodrop-push "建置完成"               # encrypted (§12.3, default)
//   echo "備份完成" | bentodrop-push
//   bentodrop-push --plain "磁碟 85%"       # plaintext mode (§12.4, token must allow it)
//
// Encrypted mode wraps a fresh CEK against your identity PUBLIC key — the
// server, and even this token, can never read what was sent.

import { pushEncrypted, pushPlaintext } from "./lib.mjs";

const args = process.argv.slice(2);
const plain = args.includes("--plain");
const words = args.filter((a) => a !== "--plain" && a !== "--help" && a !== "-h");

if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: bentodrop-push [--plain] <message>   (or pipe the message via stdin)");
  process.exit(0);
}

const baseUrl = (process.env.BENTODROP_URL ?? "").replace(/\/+$/, "");
const token = process.env.BENTODROP_TOKEN ?? "";
if (!baseUrl || !token) {
  console.error("Set BENTODROP_URL and BENTODROP_TOKEN environment variables.");
  process.exit(2);
}

let text = words.join(" ").trim();
if (!text && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  text = Buffer.concat(chunks).toString("utf8").trim();
}
if (!text) {
  console.error("Nothing to send. Pass a message or pipe one via stdin.");
  process.exit(2);
}

try {
  const send = plain ? pushPlaintext : pushEncrypted;
  const res = await send({ baseUrl, token, text });
  const delivered = (res.receipts ?? []).filter((r) => r.ok).length;
  console.log(`sent ${plain ? "(plaintext)" : "(encrypted)"} · msg ${res.msgId} · pushed to ${delivered} device(s)`);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
