// Thin fetch wrapper for the BentoDrop Worker API.
import { K, kvGet } from "./store.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (!opts.noAuth) {
    const token = await kvGet(K.DEVICE_TOKEN);
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message);
  return data;
}

export const api = {
  register: (label, pubkeyJwk) => call("POST", "/api/register", { label, pubkey_jwk: pubkeyJwk }, { noAuth: true }),
  me: () => call("GET", "/api/me"),
  subscribe: (sub) => call("POST", "/api/subscribe", sub),
  send: (envelope, to) => call("POST", "/api/send", to ? { envelope, to } : { envelope }),
  messages: () => call("GET", "/api/messages"),
  markRead: (id) => call("POST", `/api/messages/${id}/read`),
  deleteMessage: (id) => call("DELETE", `/api/messages/${id}`),
  clearMessages: () => call("DELETE", "/api/messages"),
  uploadUrl: (msgId, size) => call("POST", "/api/upload-url", { msgId, size }),
  downloadUrl: (key) => call("GET", `/api/download-url?key=${encodeURIComponent(key)}`),
  pairCreate: () => call("POST", "/api/pair/create"),
  pairClaim: (pairId, code, pubkeyJwk, label) =>
    call("POST", "/api/pair/claim", { pairId, code, pubkey_jwk: pubkeyJwk, label }, { noAuth: true }),
  pairStatus: (pairId) => call("GET", `/api/pair/${pairId}/status`),
  pairApprove: (pairId, wrappedBlob, oldPubkey) =>
    call("POST", `/api/pair/${pairId}/approve`, { wrapped_blob: wrappedBlob, old_pubkey: oldPubkey }),
  pairFinish: (pairId, code) => call("POST", "/api/pair/finish", { pairId, code }, { noAuth: true }),
  settings: (retentionDays) => call("POST", "/api/settings", { retention_days: retentionDays }),
  testPush: (deviceId) => call("POST", "/api/test-push", deviceId ? { deviceId } : {}),
  deleteDevice: (id) => call("DELETE", `/api/devices/${id}`),
  renameDevice: (id, label) => call("POST", `/api/devices/${id}/label`, { label }),
  getIdentity: () => call("GET", "/api/identity"),
  setIdentity: (pub, wrapped) => call("POST", "/api/identity", { identity_pub: pub, identity_priv_wrapped: wrapped }),
  contacts: () => call("GET", "/api/contacts"),
  contactInvite: (myName) => call("POST", "/api/contacts/invite", { myName }),
  contactClaim: (pairId, code, myName) => call("POST", "/api/contacts/claim", { pairId, code, myName }),
  contactInviteStatus: (pairId) => call("GET", `/api/contacts/invite/${pairId}/status`),
  contactApprove: (pairId, label) => call("POST", `/api/contacts/invite/${pairId}/approve`, { label }),
  renameContact: (peer, label) => call("POST", `/api/contacts/${peer}/label`, { label }),
  deleteContact: (peer) => call("DELETE", `/api/contacts/${peer}`),
  createToken: (label, plaintextOk, rateLimit) =>
    call("POST", "/api/tokens", { label, plaintext_ok: plaintextOk, rate_limit: rateLimit }),
  listTokens: () => call("GET", "/api/tokens"),
  revokeToken: (id) => call("POST", `/api/tokens/${id}/revoke`),
  putObject: async (url, bytes) => {
    const res = await fetch(url, { method: "PUT", body: bytes });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error ?? "upload_failed", data.message);
    }
    return res.json();
  },
  getObject: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new ApiError(res.status, "download_failed", "這則訊息已被刪除");
    return new Uint8Array(await res.arrayBuffer());
  },
};
