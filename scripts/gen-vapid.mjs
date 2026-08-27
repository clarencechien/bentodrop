// Generate a VAPID P-256 keypair.
// Prints JSON: { publicKey (base64url raw point), privateJwk (JSON string) }
import { webcrypto as crypto } from "node:crypto";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const publicRaw = await crypto.subtle.exportKey("raw", keys.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);

process.stdout.write(
  JSON.stringify({ publicKey: b64url(publicRaw), privateJwk: JSON.stringify(privateJwk) }, null, 2) + "\n",
);
