// BentoDrop service worker (module).
// Push handling per §5.5 / §7.3:
//  - decrypt the envelope with K_master from IndexedDB to show a preview
//  - the per-device "show notification content" switch (§6.3) downgrades
//    every notification to a generic one
//  - decryption failure still shows a generic notification — iOS revokes
//    push permission if a push produces no notification (§5.5)

import { decryptTextEnvelope, decryptFileMeta, decryptJson, deriveKmaster, detectTextKind, importIdentityPrivate } from "./js/crypto.js";
import { K, kvGet } from "./js/store.js";

const SHELL_CACHE = "bentodrop-shell-v3";
const SHELL = ["/", "/styles.css", "/js/app.js", "/js/crypto.js", "/js/api.js", "/js/store.js", "/js/image.js", "/js/wordlist.js", "/js/qr.js", "/js/qr-import.js", "/js/vendor/lean-qr.mjs", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network-first for the shell; cache fallback for offline opens.
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      const cache = await caches.open(SHELL_CACHE);
      cache.put(event.request, res.clone()).catch(() => {});
      return res;
    } catch {
      const cached = await caches.match(event.request, { ignoreSearch: url.pathname === "/" });
      return cached ?? caches.match("/");
    }
  })());
});

/** Keyring for decrypting push payloads: K_master plus (when available) the
 *  user identity key for ecdh-p256 envelopes from contacts (§11). */
async function getKeys() {
  const entropy = await kvGet(K.ENTROPY);
  const userName = await kvGet(K.USER_NAME);
  if (!entropy) return null;
  const kMaster = await deriveKmaster(entropy, userName);
  const ring = { kMaster, identityPriv: null };
  try {
    const wrapped = await kvGet(K.IDENTITY_WRAPPED);
    if (wrapped) ring.identityPriv = await importIdentityPrivate(await decryptJson(kMaster, wrapped));
  } catch { /* generic notification fallback covers it */ }
  return ring;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const generic = { title: "BentoDrop", body: "收到一則新訊息", data: {} };
    let notif = generic;
    try {
      const payload = event.data?.json();
      const previewOn = (await kvGet(K.NOTIFY_PREVIEW)) !== false; // §6.3, default on
      if (payload?.t === "test") {
        notif = { title: "BentoDrop", body: previewOn ? `測試推送 ✓(來自 ${payload.from ?? "?"})` : "收到一則新訊息", data: {} };
      } else if (payload?.t === "msg" && payload.envelope) {
        const e = payload.envelope;
        notif.data = { msgId: payload.msgId };
        if (previewOn) {
          const textData = (text) => {
            // §7.2.1: the whitelist decides the actions — 開啟 only for https.
            const det = detectTextKind(text);
            return {
              msgId: payload.msgId,
              text,
              url: det.kind === "url" ? det.url : null,
            };
          };
          if (e.plain) {
            // §12.4 plaintext mode — show as-is, tagged unencrypted in-app.
            notif = { title: payload.from ?? "BentoDrop", body: String(e.text).slice(0, 80), data: textData(String(e.text)) };
          } else {
            const keys = await getKeys();
            if (keys && e.kind === "text") {
              const text = await decryptTextEnvelope(keys, e);
              notif = {
                title: payload.from ?? "BentoDrop",
                body: text.slice(0, 80), // §7.3: first 80 chars
                data: textData(text),
              };
            } else if (keys && e.kind === "file") {
              const meta = await decryptFileMeta(keys, e);
              const mb = e.size ? ` · ${(e.size / 1024 / 1024).toFixed(1)} MB` : "";
              notif = { title: payload.from ?? "BentoDrop", body: `${meta.name}${mb}`, data: { msgId: payload.msgId } };
            }
          }
        }
      }
    } catch (err) {
      // Decryption failure → generic notification, never silent (§5.5).
      console.warn("push decrypt failed", err);
      notif = generic;
    }
    // §7.2: action buttons on the notification — 複製 for text (the app,
    // once focused, attempts the clipboard write; failure falls back to the
    // detail view's copy button), 開啟 only for whitelisted https URLs.
    const actions = [];
    if (notif.data?.url) actions.push({ action: "open-url", title: "開啟" });
    if (notif.data?.text) actions.push({ action: "copy", title: "複製" });
    await self.registration.showNotification(notif.title, {
      body: notif.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: notif.data?.msgId ?? undefined,
      data: notif.data,
      actions,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const action = event.action;
  event.waitUntil((async () => {
    // 開啟 action: the user explicitly tapped it, so navigating to the
    // (https-only, §7.2.1) URL is their click — not auto-navigation.
    if (action === "open-url" && data.url && data.url.startsWith("https://")) {
      await self.clients.openWindow(data.url);
      return;
    }
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).origin === location.origin);
    const msg = action === "copy"
      ? { t: "copy-msg", msgId: data.msgId, text: data.text }
      : { t: "open-msg", msgId: data.msgId };
    if (client) {
      await client.focus();
      client.postMessage(msg);
    } else {
      const win = await self.clients.openWindow("/");
      // Give the app a moment to boot before telling it what to do.
      if (win && data.msgId) setTimeout(() => win.postMessage(msg), 1500);
    }
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Chrome support is spotty (§8.3 #4) — the app re-syncs on every launch too.
  event.waitUntil((async () => {
    try {
      const reg = await self.registration.pushManager.subscribe(event.oldSubscription?.options ?? { userVisibleOnly: true });
      const token = await kvGet(K.DEVICE_TOKEN);
      if (!token) return;
      await fetch("/api/subscribe", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(reg.toJSON()),
      });
    } catch {}
  })());
});
