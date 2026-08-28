// BentoDrop Worker — a router that never sees plaintext (§2).

import type { Env } from "./types";
import { apiError, json } from "./lib/util";
import { authApiToken, authDevice } from "./auth";
import { handleRegister } from "./routes/register";
import { pairApprove, pairClaim, pairCreate, pairFinish, pairStatus } from "./routes/pairing";
import { clearMessages, deleteMessage, handleSend, listMessages, markRead } from "./routes/messages";
import { createDownloadUrl, createUploadIntent, createUploadUrl, handleObject } from "./routes/objects";
import { createToken, handleApiPush, listTokens, pushPubkey, revokeToken, updateSettings } from "./routes/tokens";
import {
  contactApprove, contactClaim, contactInvite, contactInviteStatus,
  deleteContact, getIdentity, listContacts, renameContact, setIdentity,
} from "./routes/contacts";
import { deleteDevice, handleMe, handleSubscribe, handleTestPush, renameDevice } from "./routes/devices";
import { diagDelete, diagEcho, diagEnv, diagProbe, diagProbePong, diagUploadUrl } from "./routes/diag";
import { cleanupExpired } from "./cron";

const DEPLOY_HINT =
  "Deployment is incomplete. Set the Workers Builds deploy command to `npm run deploy` " +
  "(dashboard → this Worker → Settings → Build) and redeploy — it applies D1 migrations " +
  "and generates the VAPID / URL-signing secrets.";

/** Readiness probe: reports exactly which provisioning step is missing. */
async function handleHealth(env: Env): Promise<Response> {
  const checks = {
    d1: false,
    migrated: false,
    vapidKeys: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK),
    urlSigningSecret: Boolean(env.URL_SIGNING_SECRET),
  };
  try {
    checks.d1 = true;
    const t = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    ).first();
    checks.migrated = t !== null;
  } catch {
    checks.d1 = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return json(ok ? { ok, ts: Date.now(), checks } : { ok, ts: Date.now(), checks, hint: DEPLOY_HINT }, ok ? 200 : 503);
}

function isMissingSchema(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message + ((err.cause as Error | undefined)?.message ?? ""));
}

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  // ── Public endpoints ────────────────────────────────────────────────
  if (path === "/api/health" && method === "GET") return handleHealth(env);
  if (path === "/api/vapid" && method === "GET") return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });
  if (path === "/api/register" && method === "POST") return handleRegister(req, env);
  if (path === "/api/pair/claim" && method === "POST") return pairClaim(req, env);
  if (path === "/api/pair/finish" && method === "POST") return pairFinish(req, env);

  // Signed-URL object access authenticates via HMAC, not bearer token.
  if (path.startsWith("/api/object/")) return handleObject(req, env, path.slice("/api/object/".length));

  // ── Script push (API-token auth, send-only — §12) ───────────────────
  if (path === "/api/push" && method === "POST") {
    const token = await authApiToken(req, env);
    if (!token) return apiError(401, "unauthorized");
    return handleApiPush(req, env, token);
  }
  if (path === "/api/push/pubkey" && method === "GET") {
    const token = await authApiToken(req, env);
    if (!token) return apiError(401, "unauthorized");
    return pushPubkey(env, token);
  }

  // ── Device-authenticated endpoints ──────────────────────────────────
  const device = await authDevice(req, env);
  if (!device) return apiError(401, "unauthorized");

  if (path === "/api/me" && method === "GET") return handleMe(env, device);
  if (path === "/api/subscribe" && method === "POST") return handleSubscribe(req, env, device);
  if (path === "/api/send" && method === "POST") return handleSend(req, env, device);
  if (path === "/api/messages" && method === "GET") return listMessages(env, device);
  if (path === "/api/messages" && method === "DELETE") return clearMessages(env, device);
  if (path === "/api/upload-url" && method === "POST") return createUploadUrl(req, env, device);
  if (path === "/api/upload-intent" && method === "POST") return createUploadIntent(req, env, device);
  if (path === "/api/download-url" && method === "GET") return createDownloadUrl(req, env, device);
  if (path === "/api/pair/create" && method === "POST") return pairCreate(env, device);
  if (path === "/api/tokens" && method === "POST") return createToken(req, env, device);
  if (path === "/api/tokens" && method === "GET") return listTokens(env, device);
  if (path === "/api/settings" && method === "POST") return updateSettings(req, env, device);
  if (path === "/api/test-push" && method === "POST") return handleTestPush(req, env, device);
  if (path === "/api/identity" && method === "POST") return setIdentity(req, env, device);
  if (path === "/api/identity" && method === "GET") return getIdentity(env, device);
  if (path === "/api/contacts" && method === "GET") return listContacts(env, device);
  if (path === "/api/contacts/invite" && method === "POST") return contactInvite(req, env, device);
  if (path === "/api/contacts/claim" && method === "POST") return contactClaim(req, env, device);
  if (path === "/api/diag/env" && method === "GET") return diagEnv(req, env, device);
  if (path === "/api/diag/upload-url" && method === "POST") return diagUploadUrl(req, env, device);
  if (path === "/api/diag/object" && method === "DELETE") return diagDelete(req, env, device);
  if (path === "/api/diag/echo" && method === "POST") return diagEcho(req, env, device);
  if (path === "/api/diag/probe" && method === "POST") return diagProbe(req, env, device);
  if (path === "/api/diag/probe-pong" && method === "POST") return diagProbePong(req, env, device);

  let m: RegExpExecArray | null;
  if ((m = /^\/api\/messages\/([A-Za-z0-9_-]+)\/read$/.exec(path)) && method === "POST") {
    return markRead(env, device, m[1]);
  }
  if ((m = /^\/api\/messages\/([A-Za-z0-9_-]+)$/.exec(path)) && method === "DELETE") {
    return deleteMessage(env, device, m[1]);
  }
  if ((m = /^\/api\/pair\/([A-Za-z0-9_-]+)\/status$/.exec(path)) && method === "GET") {
    return pairStatus(env, device, m[1]);
  }
  if ((m = /^\/api\/pair\/([A-Za-z0-9_-]+)\/approve$/.exec(path)) && method === "POST") {
    return pairApprove(req, env, device, m[1]);
  }
  if ((m = /^\/api\/tokens\/([A-Za-z0-9_-]+)\/revoke$/.exec(path)) && method === "POST") {
    return revokeToken(env, device, m[1]);
  }
  if ((m = /^\/api\/devices\/([A-Za-z0-9_-]+)$/.exec(path)) && method === "DELETE") {
    return deleteDevice(env, device, m[1]);
  }
  if ((m = /^\/api\/devices\/([A-Za-z0-9_-]+)\/label$/.exec(path)) && method === "POST") {
    return renameDevice(req, env, device, m[1]);
  }
  if ((m = /^\/api\/contacts\/invite\/([A-Za-z0-9_-]+)\/status$/.exec(path)) && method === "GET") {
    return contactInviteStatus(env, device, m[1]);
  }
  if ((m = /^\/api\/contacts\/invite\/([A-Za-z0-9_-]+)\/approve$/.exec(path)) && method === "POST") {
    return contactApprove(req, env, device, m[1]);
  }
  if ((m = /^\/api\/contacts\/([A-Za-z0-9_-]+)\/label$/.exec(path)) && method === "POST") {
    return renameContact(req, env, device, m[1]);
  }
  if ((m = /^\/api\/contacts\/([A-Za-z0-9_-]+)$/.exec(path)) && method === "DELETE") {
    return deleteContact(env, device, m[1]);
  }

  return apiError(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (err) {
        console.error("api error", url.pathname, err);
        if (isMissingSchema(err)) return apiError(503, "not_migrated", DEPLOY_HINT);
        return apiError(500, "internal_error");
      }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpired(env).then((r) => {
      console.log(`cleanup: ${r.messages} messages, ${r.pairings} pairings`);
    }));
  },
} satisfies ExportedHandler<Env>;

export { cleanupExpired };
