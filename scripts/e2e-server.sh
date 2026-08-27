#!/usr/bin/env bash
# Boot a local BentoDrop (wrangler dev + local D1/R2) for Playwright E2E.
set -euo pipefail
cd "$(dirname "$0")/.."

# Fresh local state per run keeps E2E deterministic.
rm -rf .wrangler/state/e2e

if [ ! -f .dev.vars ]; then
  node - <<'EOF'
const { execSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const out = execSync("node scripts/gen-vapid.mjs", { encoding: "utf8" });
const { publicKey, privateJwk } = JSON.parse(out);
writeFileSync(".dev.vars", [
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_JWK=${privateJwk}`,
  `URL_SIGNING_SECRET=dev-secret-${Date.now()}`,
  "",
].join("\n"));
console.log(".dev.vars written");
EOF
fi

npx wrangler d1 migrations apply bentodrop --local --persist-to .wrangler/state/e2e
exec npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to .wrangler/state/e2e
