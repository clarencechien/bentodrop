// BentoDrop service worker (module).
// Push handling per §5.5 / §7.3:
//  - decrypt the envelope with K_master from IndexedDB to show a preview
//  - the per-device "show notification content" switch (§6.3) downgrades
//    every notification to a generic one
//  - decryption failure still shows a generic notification — iOS revokes
//    push permission if a push produces no notification (§5.5)

import { decryptTextEnvelope, decryptFileMeta, deriveKmaster, detectTextKind } from "./js/crypto.js";
import { K, kvGet } from "./js/store.js";

const SHELL_CACHE = "bentodrop-shell-v1";
const SHELL = ["/", "/styles.css", "/js/app.js", "/js/crypto.js", "/js/api.js", "/js/store.js", "/js/image.js", "/js/wordlist.js", "/manifest.webmanifest"];

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

async function getKmaster() {
  const entropy = await kvGet(K.ENTROPY);
  const userName = await kvGet(K.USER_NAME);
  if (!entropy) return null;
  return deriveKmaster(entropy, userName);
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
          if (e.plain) {
            // §12.4 plaintext mode — show as-is, tagged unencrypted in-app.
            notif = { title: payload.from ?? "BentoDrop", body: String(e.text).slice(0, 80), data: { msgId: payload.msgId, kind: "text" } };
          } else {
            const kMaster = await getKmaster();
            if (kMaster && e.kind === "text") {
              const text = await decryptTextEnvelope(kMaster, e);
              const det = detectTextKind(text);
              notif = {
                title: payload.from ?? "BentoDrop",
                body: text.slice(0, 80), // §7.3: first 80 chars
                data: { msgId: payload.msgId, kind: det.kind },
              };
            } else if (kMaster && e.kind === "file") {
              const meta = await decryptFileMeta(kMaster, e);
              const mb = e.size ? ` · ${(e.size / 1024 / 1024).toFixed(1)} MB` : "";
              notif = { title: payload.from ?? "BentoDrop", body: `${meta.name}${mb}`, data: { msgId: payload.msgId, kind: "file" } };
            }
          }
        }
      }
    } catch (err) {
      // Decryption failure → generic notification, never silent (§5.5).
      console.warn("push decrypt failed", err);
      notif = generic;
    }
    const actions = notif.data?.kind === "url"
      ? [{ action: "open", title: "開啟" }]
      : notif.data?.kind ? [{ action: "copy", title: "複製" }] : [];
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
  const msgId = event.notification.data?.msgId;
  const wantCopy = event.action === "copy";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).origin === location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ t: "open-msg", msgId, copy: wantCopy });
    } else {
      const win = await self.clients.openWindow("/");
      // Give the app a moment to boot before telling it what to open.
      if (win && msgId) setTimeout(() => win.postMessage({ t: "open-msg", msgId, copy: wantCopy }), 1500);
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
