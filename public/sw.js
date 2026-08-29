// BentoDrop service worker (module).
// Push handling per §5.5 / §7.3:
//  - decrypt the envelope with K_master from IndexedDB to show a preview
//  - the per-device "show notification content" switch (§6.3) downgrades
//    every notification to a generic one
//  - decryption failure still shows a generic notification — iOS revokes
//    push permission if a push produces no notification (§5.5)

import {
  b64u, decryptTextEnvelope, decryptFileMeta, decryptJson, decryptThumb, deriveKmaster, detectTextKind,
  encryptFileEnvelope, encryptTextEnvelope, importIdentityPrivate,
} from "./js/crypto.js";
import { compressImage } from "./js/image.js";
import { K, kvGet } from "./js/store.js";

const SHELL_CACHE = "bentodrop-shell-v7";
const PREFETCH_CACHE = "bentodrop-prefetch-v1";
const PREFETCH_MAX_BYTES = 5 * 1024 * 1024;
const PREFETCH_CELLULAR_MAX_BYTES = 1.5 * 1024 * 1024; // respect mobile data
const PREFETCH_MAX_ENTRIES = 20;
export const prefetchUrl = (msgId) => `/__prefetch/${msgId}`;
const SHELL = ["/", "/styles.css", "/js/app.js", "/js/crypto.js", "/js/api.js", "/js/store.js", "/js/image.js", "/js/image-worker.js", "/js/diag.js", "/js/wordlist.js", "/js/qr.js", "/js/qr-import.js", "/js/vendor/lean-qr.mjs", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      // Prefetched ciphertext survives SW updates — only stale shells go.
      if (key !== SHELL_CACHE && key !== PREFETCH_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/**
 * Android share sheet → BentoDrop (Web Share Target). The whole pipeline —
 * compress, encrypt, upload, send — runs here in the service worker, so the
 * app only flashes open on "/" with an 已送達 toast. Nothing plaintext ever
 * leaves the device.
 */
async function shareTargetSend(form) {
  const [token, entropy, userName, userId] = await Promise.all([
    kvGet(K.DEVICE_TOKEN), kvGet(K.ENTROPY), kvGet(K.USER_NAME), kvGet(K.USER_ID),
  ]);
  if (!token || !entropy) throw new Error("not onboarded");
  const kMaster = await deriveKmaster(entropy, userName);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const res = await fetch(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };

  let sentAny = false;
  for (const file of form.getAll("media")) {
    if (!file || typeof file === "string" || file.size === 0) continue;
    const prepared = await compressImage(file, {}); // OffscreenCanvas path works in SW
    const { envelope, ciphertext } = await encryptFileEnvelope(
      kMaster, userId, prepared.bytes, prepared.name, prepared.mime,
    );
    const up = await post("/api/upload-url", { msgId: envelope.id, size: ciphertext.byteLength });
    const put = await fetch(up.url, { method: "PUT", body: ciphertext });
    if (!put.ok) throw new Error(`upload → ${put.status}`);
    await post("/api/send", { envelope });
    sentAny = true;
  }

  const title = String(form.get("title") ?? "").trim();
  const text = String(form.get("text") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  let combined = text;
  if (url && !combined.includes(url)) combined = combined ? `${combined}\n${url}` : url;
  if (title && !combined.includes(title)) combined = combined ? `${title}\n${combined}` : title;
  if (combined) {
    await post("/api/send", { envelope: await encryptTextEnvelope(kMaster, combined) });
    sentAny = true;
  }
  if (!sentAny) throw new Error("empty share");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === location.origin && url.pathname === "/share-target" && event.request.method === "POST") {
    event.respondWith((async () => {
      // CSRF guard: a genuine share-sheet launch navigates with
      // Sec-Fetch-Site "none" (browser/OS initiated); in-app calls are
      // "same-origin". A cross-site page auto-submitting a form here
      // arrives as "cross-site" — refuse it before touching the token.
      // The header is browser-set and cannot be forged from a web page.
      const site = event.request.headers.get("sec-fetch-site");
      if (site && site !== "none" && site !== "same-origin") {
        return Response.redirect("/?shared=fail", 303);
      }
      try {
        await shareTargetSend(await event.request.formData());
        return Response.redirect("/?shared=sent", 303);
      } catch (err) {
        console.warn("share-target failed", err);
        return Response.redirect("/?shared=fail", 303);
      }
    })());
    return;
  }
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

/**
 * Background prefetch (README 優化 #1): pull the ciphertext into the cache
 * the moment the push arrives, so opening the message decrypts instantly.
 * Plaintext never touches the cache — only the already-encrypted object.
 */
async function prefetchFile(payload) {
  const envelope = payload?.envelope;
  if (!envelope?.obj || typeof envelope.size !== "number") return;
  const cellular = self.navigator.connection?.type === "cellular";
  const cap = cellular ? PREFETCH_CELLULAR_MAX_BYTES : PREFETCH_MAX_BYTES;
  if (envelope.size > cap) return;
  const token = await kvGet(K.DEVICE_TOKEN);
  if (!token) return;
  const auth = { authorization: `Bearer ${token}` };
  const dl = await fetch(`/api/download-url?key=${encodeURIComponent(envelope.obj)}`, { headers: auth });
  if (!dl.ok) return;
  const { url } = await dl.json();
  const obj = await fetch(url);
  if (!obj.ok) return;
  const bytes = await obj.arrayBuffer();
  const cache = await caches.open(PREFETCH_CACHE);
  await cache.put(prefetchUrl(payload.msgId), new Response(bytes, {
    headers: { "content-type": "application/octet-stream", "x-fetched-at": String(Date.now()) },
  }));
  // Bounded cache: evict the oldest entries beyond the cap.
  const keys = await cache.keys();
  if (keys.length > PREFETCH_MAX_ENTRIES) {
    const dated = await Promise.all(keys.map(async (req) => {
      const res = await cache.match(req);
      return { req, at: Number(res?.headers.get("x-fetched-at") ?? 0) };
    }));
    dated.sort((a, b) => a.at - b.at);
    for (const { req } of dated.slice(0, keys.length - PREFETCH_MAX_ENTRIES)) await cache.delete(req);
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const generic = { title: "BentoDrop", body: "收到一則新訊息", data: {} };
    let notif = generic;
    let fileToPrefetch = null;
    let thumbDataUrl = null;
    try {
      const payload = event.data?.json();
      const previewOn = (await kvGet(K.NOTIFY_PREVIEW)) !== false; // §6.3, default on

      // 診斷探針(README 優化 #6):自動回 pong;每個 push 都必須顯示通知
      // (§5.5),探針用同一個 tag 讓通知彼此覆蓋,不洗版。
      if (payload?.t === "probe") {
        try {
          const token = await kvGet(K.DEVICE_TOKEN);
          if (token) {
            await fetch("/api/diag/probe-pong", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ probeId: payload.probeId, originDeviceId: payload.originDeviceId }),
            });
          }
        } catch { /* the probe run just times out on the origin device */ }
        await self.registration.showNotification("BentoDrop 診斷", {
          body: "收到測速探針,已自動回應", tag: "diag-probe", icon: "/icons/icon-192.png",
        });
        return;
      }
      if (payload?.t === "probe-pong") {
        for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
          client.postMessage({ t: "probe-pong", probeId: payload.probeId });
        }
        await self.registration.showNotification("BentoDrop 診斷", {
          body: "探針往返完成", tag: "diag-probe", icon: "/icons/icon-192.png",
        });
        return;
      }

      if (payload?.t === "test") {
        notif = { title: "BentoDrop", body: previewOn ? `測試推送 ✓(來自 ${payload.from ?? "?"})` : "收到一則新訊息", data: {} };
      } else if (payload?.t === "msg" && payload.envelope) {
        const e = payload.envelope;
        notif.data = { msgId: payload.msgId };
        if (e.kind === "file") fileToPrefetch = payload;
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
              // Encrypted thumbnail (README 優化 #5) → notification image.
              try {
                const thumbBytes = await decryptThumb(keys, e);
                if (thumbBytes) {
                  const b64 = b64u(thumbBytes).replace(/-/g, "+").replace(/_/g, "/");
                  thumbDataUrl = `data:image/webp;base64,${b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")}`;
                }
              } catch { /* preview only — never block the notification */ }
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
      ...(thumbDataUrl ? { image: thumbDataUrl } : {}),
      tag: notif.data?.msgId ?? undefined,
      data: notif.data,
      actions,
    });
    // Prefetch AFTER the notification is visible — never delay the buzz.
    if (fileToPrefetch) {
      try {
        await prefetchFile(fileToPrefetch);
      } catch (err) {
        console.warn("prefetch failed", err); // opening falls back to a live download
      }
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const action = event.action;
  event.waitUntil((async () => {
    const isUrlAction = action === "open-url" && data.url && data.url.startsWith("https://");
    // 開啟 action off Android: openWindow(url) opens a real browser tab
    // directly — the user explicitly tapped it, so navigating to the
    // (https-only, §7.2.1) URL is their click, not auto-navigation.
    // On Android, openWindow is the wrong tool either way: a plain URL
    // lands in the Custom-Tab overlay and the intent:// form is silently
    // ignored (measured on Pixel). Page NAVIGATION to intent:// works, so
    // Android relays through the app below, which launches full Chrome.
    if (isUrlAction && !/Android/.test(navigator.userAgent)) {
      await self.clients.openWindow(data.url);
      return;
    }
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).origin === location.origin);
    const msg = isUrlAction
      ? { t: "open-url", msgId: data.msgId, url: data.url }
      : action === "copy"
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
