// BentoDrop Worker — a router that never sees plaintext (§2).

import type { Env } from "./types";
import { apiError, json } from "./lib/util";
import { authApiToken, authDevice } from "./auth";
import { handleRegister } from "./routes/register";
import { pairApprove, pairClaim, pairCreate, pairFinish, pairStatus } from "./routes/pairing";
import { clearMessages, deleteMessage, handleSend, listMessages, markRead } from "./routes/messages";
import { createDownloadUrl, createUploadUrl, handleObject } from "./routes/objects";
import { createToken, handleApiPush, listTokens, revokeToken, updateSettings } from "./routes/tokens";
import { deleteDevice, handleMe, handleSubscribe, handleTestPush } from "./routes/devices";
import { cleanupExpired } from "./cron";

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  // ── Public endpoints ────────────────────────────────────────────────
  if (path === "/api/health" && method === "GET") return json({ ok: true, ts: Date.now() });
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

  // ── Device-authenticated endpoints ──────────────────────────────────
  const device = await authDevice(req, env);
  if (!device) return apiError(401, "unauthorized");

  if (path === "/api/me" && method === "GET") return handleMe(env, device);
  if (path === "/api/subscribe" && method === "POST") return handleSubscribe(req, env, device);
  if (path === "/api/send" && method === "POST") return handleSend(req, env, device);
  if (path === "/api/messages" && method === "GET") return listMessages(env, device);
  if (path === "/api/messages" && method === "DELETE") return clearMessages(env, device);
  if (path === "/api/upload-url" && method === "POST") return createUploadUrl(req, env, device);
  if (path === "/api/download-url" && method === "GET") return createDownloadUrl(req, env, device);
  if (path === "/api/pair/create" && method === "POST") return pairCreate(env, device);
  if (path === "/api/tokens" && method === "POST") return createToken(req, env, device);
  if (path === "/api/tokens" && method === "GET") return listTokens(env, device);
  if (path === "/api/settings" && method === "POST") return updateSettings(req, env, device);
  if (path === "/api/test-push" && method === "POST") return handleTestPush(req, env, device);

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
