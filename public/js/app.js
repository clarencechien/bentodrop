// BentoDrop PWA — single-page app.
import * as C from "./crypto.js";
import { api, ApiError } from "./api.js";
import { K, kvDelete, kvGet, kvSet } from "./store.js";
import { compressImage, isHeic, isImage, makeThumb } from "./image.js";
import { qrSvg } from "./qr.js";
import { decodeQrFromFile } from "./qr-import.js";
import { formatReport, runDiagnostics } from "./diag.js";

const $app = document.getElementById("app");
const $nav = document.getElementById("topNav");
const $toast = document.getElementById("toast");

const state = {
  kMaster: null,
  userId: null,
  deviceId: null,
  label: null,
  identityPriv: null, // user-level identity key (§5.2), lazily bootstrapped
  contacts: [],
  msgs: [],
  decrypted: new Map(), // msgId → { text | meta }
};

// ── tiny helpers ──────────────────────────────────────────────────────
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg, isErr = false) {
  $toast.textContent = msg;
  $toast.classList.toggle("err", isErr);
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 2600);
}
function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已複製");
    return true;
  } catch {
    toast("無法自動複製,請長按選取", true);
    return false;
  }
}
function modal(contentEl) {
  const back = el(`<div class="modal-back"></div>`);
  const box = el(`<div class="modal" role="dialog" aria-modal="true"></div>`);
  box.append(contentEl);
  back.append(box);
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  document.body.append(back);
  return back;
}

// ── identity ──────────────────────────────────────────────────────────
async function loadIdentity() {
  const [entropy, userName, userId, deviceId, label, token] = await Promise.all([
    kvGet(K.ENTROPY), kvGet(K.USER_NAME), kvGet(K.USER_ID), kvGet(K.DEVICE_ID), kvGet(K.DEVICE_LABEL), kvGet(K.DEVICE_TOKEN),
  ]);
  if (!entropy || !token) return false;
  state.kMaster = await C.deriveKmaster(entropy, userName);
  state.userId = userId;
  state.deviceId = deviceId;
  state.label = label;
  return true;
}

async function saveIdentity({ entropy, userName, userId, deviceId, deviceToken, label, vapidPublicKey }) {
  await Promise.all([
    kvSet(K.ENTROPY, entropy),
    kvSet(K.USER_NAME, userName),
    kvSet(K.USER_ID, userId),
    kvSet(K.DEVICE_ID, deviceId),
    kvSet(K.DEVICE_TOKEN, deviceToken),
    kvSet(K.DEVICE_LABEL, label),
    kvSet(K.VAPID, vapidPublicKey),
  ]);
  navigator.storage?.persist?.().catch(() => {}); // §6.8
}

function guessLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "裝置";
}

// ── push (§8.3) ──────────────────────────────────────────────────────
async function ensurePush({ interactive = false } = {}) {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    if (Notification.permission === "denied") return false;
    if (Notification.permission !== "granted") {
      if (!interactive) return false;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const vapid = await kvGet(K.VAPID);
    if (!vapid) return false;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: C.unb64u(vapid),
      });
    }
    // §8.3 #3: re-sync with the backend on every app start.
    await api.subscribe(sub.toJSON());
    return true;
  } catch (err) {
    console.warn("push subscribe failed", err);
    return false;
  }
}

// ── install-as-PWA guidance ──────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById("installBtn")?.replaceChildren("安裝");
});

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

window.addEventListener("appinstalled", () => kvSet(K.APP_INSTALLED, Date.now()).catch(() => {}));

/**
 * Installed on THIS device, even when currently opened in a browser tab?
 * getInstalledRelatedApps (Android/Chromium) is authoritative when available;
 * otherwise fall back to a flag remembered from standalone opens or the
 * appinstalled event (covers desktop, where the API may be unavailable).
 */
async function isInstalled() {
  if (isStandalone()) {
    kvSet(K.APP_INSTALLED, Date.now()).catch(() => {});
    return true;
  }
  if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      if (apps.length > 0) {
        kvSet(K.APP_INSTALLED, Date.now()).catch(() => {});
        return true;
      }
      // Authoritative "not installed" — clear a stale flag (app uninstalled).
      kvDelete(K.APP_INSTALLED).catch(() => {});
      return false;
    } catch { /* fall through to the flag */ }
  }
  return Boolean(await kvGet(K.APP_INSTALLED));
}

function platformInstallSteps() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) {
    return {
      title: "加入 iPhone / iPad 主畫面",
      steps: [
        "用 Safari 開啟這個網站",
        "按底部中間的「分享」鈕(方框加向上箭頭)",
        "往下捲,點「加入主畫面」→「加入」",
        "之後一律從主畫面圖示開啟,通知才收得到",
      ],
      note: "iOS 一定要加入主畫面才有推送通知,在 Safari 分頁裡開是收不到的。",
    };
  }
  if (/Android/.test(ua)) {
    return {
      title: "安裝到 Android",
      steps: [
        "用 Chrome 開啟這個網站",
        "按右上「⋮」選單 → 「安裝應用程式」",
        "安裝後從主畫面開啟,並在設定按「啟用本機通知」",
        "之後任何 App 按「分享」都能直接選 BentoDrop",
      ],
    };
  }
  return {
    title: "安裝到電腦",
    steps: [
      "用 Chrome 或 Edge 開啟這個網站",
      "點網址列右側的安裝圖示(螢幕加向下箭頭),或「⋮」→「安裝」",
      "安裝後它就是一個獨立視窗的 App",
    ],
  };
}

function showInstallGuide() {
  const guide = platformInstallSteps();
  const box = el(`
    <div>
      <h3>${esc(guide.title)}</h3>
      <ol class="install-steps">${guide.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      ${guide.note ? `<div class="banner">${esc(guide.note)}</div>` : ""}
      <a class="btn ghost" href="/landing#install" style="text-decoration:none;text-align:center">看完整教學</a>
    </div>`);
  modal(box);
}

/** Banner above the inbox — never shown once the app is installed on this device. */
async function installBanner() {
  if (await isInstalled()) return null;
  if (await kvGet(K.INSTALL_DISMISSED)) return null;
  const banner = el(`
    <div class="install-banner" id="installBanner">
      <i class="ib-ico"></i>
      <div class="ib-text">
        <b>把 BentoDrop 裝成 App</b>
        <span>通知更可靠${/Android/.test(navigator.userAgent) ? ",分享面板也能直接選它" : ""}</span>
      </div>
      <button class="btn inline" id="installBtn" type="button">${deferredInstallPrompt ? "安裝" : "怎麼裝?"}</button>
      <button class="ib-close" type="button" aria-label="關閉安裝提示">×</button>
    </div>`);
  banner.querySelector("#installBtn").onclick = async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === "accepted") {
        banner.remove();
        toast("已安裝 ✓ 之後從 App 圖示開啟");
      }
      return;
    }
    showInstallGuide();
  };
  banner.querySelector(".ib-close").onclick = async () => {
    await kvSet(K.INSTALL_DISMISSED, Date.now());
    banner.remove();
  };
  return banner;
}

// ── nav ───────────────────────────────────────────────────────────────
function setNav(loggedIn) {
  $nav.replaceChildren();
  if (!loggedIn) return;
  const add = el(`<button type="button">加裝置</button>`);
  add.onclick = () => renderPairOld();
  const settings = el(`<button type="button">設定</button>`);
  settings.onclick = () => renderSettings();
  $nav.append(add, settings);
}

// ── onboarding (§6.5: one field, no forced backup) ───────────────────
function renderOnboarding(next) {
  setNav(false);
  $app.replaceChildren(el(`
    <div class="compartment" style="max-width:440px;margin:30px auto">
      <p class="eyebrow">開通</p>
      <h1 style="margin-top:10px">你叫什麼名字?</h1>
      <p class="muted small" style="margin-top:8px">只存在你的裝置上,用來加密。隨時可以改,不會有人看到。</p>
      <form id="obForm">
        <div class="field"><label>名字</label><input id="obName" autocomplete="off" maxlength="64" required></div>
        <button class="btn" type="submit">開始</button>
      </form>
      <p class="btn-note">沒有註冊 · 沒有密碼 · 沒有信箱</p>
      <div class="row" style="margin-top:18px;justify-content:center">
        <button class="btn ghost inline" id="obJoin" type="button">已有其他裝置?配對加入</button>
        <button class="btn ghost inline" id="obRestore" type="button">用還原碼還原</button>
      </div>
    </div>`));
  document.getElementById("obForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById("obName").value.trim();
    if (!name) return;
    const btn = e.target.querySelector(".btn");
    btn.disabled = true;
    try {
      await onboardNewUser(name);
      if (next) next();
      else renderInbox();
      ensurePush({ interactive: true });
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };
  document.getElementById("obJoin").onclick = () => renderPairJoin(null);
  document.getElementById("obRestore").onclick = () => renderRestore();
  // First screen a new visitor sees — offer the one-tap install here too.
  installBanner().then((banner) => {
    if (banner) {
      banner.style.maxWidth = "440px";
      banner.style.margin = "14px auto 0";
      $app.append(banner);
    }
  });
}

async function onboardNewUser(userName, entropy = C.generateEntropy()) {
  // §6.5: keys, registration, push — all in the background, one visible field.
  const kMaster = await C.deriveKmaster(entropy, userName);
  const deviceKeys = await C.generateEcdhPair();
  const label = guessLabel();
  const reg = await api.register(label, deviceKeys.publicJwk);
  await saveIdentity({
    entropy, userName,
    userId: reg.userId, deviceId: reg.deviceId, deviceToken: reg.deviceToken,
    label, vapidPublicKey: reg.vapidPublicKey,
  });
  state.kMaster = kMaster;
  state.userId = reg.userId;
  state.deviceId = reg.deviceId;
  state.label = label;
  ensureUserIdentity().catch(() => {}); // §5.2 — background, not blocking
}

/**
 * User-level identity keypair (§5.2 / §11): public JWK lives on the server;
 * the private JWK is wrapped with K_master and synced through the server so
 * every device of the user shares ONE identity. First device to run this
 * creates it; everyone else converges on the stored pair.
 */
async function ensureUserIdentity() {
  if (state.identityPriv) return state.identityPriv;
  let wrapped = await kvGet(K.IDENTITY_WRAPPED);
  if (!wrapped) {
    try {
      wrapped = (await api.getIdentity()).identityPrivWrapped;
    } catch {
      // none yet — create and publish; on a race the server returns the winner
      const pair = await C.generateIdentityPair();
      const res = await api.setIdentity(pair.publicJwk, await C.encryptJson(state.kMaster, pair.privateJwk));
      wrapped = res.identityPrivWrapped;
    }
    await kvSet(K.IDENTITY_WRAPPED, wrapped);
  }
  const jwk = await C.decryptJson(state.kMaster, wrapped);
  state.identityPriv = await C.importIdentityPrivate(jwk);
  return state.identityPriv;
}

/** Keyring for decrypting an envelope, loading the identity key on demand. */
async function keysFor(envelope) {
  if (envelope?.wrap?.mode === "ecdh-p256") {
    return { kMaster: state.kMaster, identityPriv: await ensureUserIdentity() };
  }
  return state.kMaster;
}

// ── inbox ─────────────────────────────────────────────────────────────
async function decryptPreview(m) {
  if (state.decrypted.has(m.msgId)) return state.decrypted.get(m.msgId);
  let out;
  try {
    const keys = await keysFor(m.envelope);
    if (m.kind === "text") {
      out = { text: await C.decryptTextEnvelope(keys, m.envelope) };
    } else {
      out = { meta: await C.decryptFileMeta(keys, m.envelope) };
    }
  } catch {
    out = { error: true };
  }
  state.decrypted.set(m.msgId, out);
  return out;
}

async function refreshMessages() {
  const { messages } = await api.messages();
  state.msgs = messages;
  // First-paint cache (README 優化 #3): envelopes are ciphertext, same
  // at-rest posture as the server's copy.
  kvSet(K.MSG_CACHE, { at: Date.now(), messages }).catch(() => {});
  return messages;
}

// ── file-transfer plumbing (README 優化 #1/#4) ───────────────────────
const PREFETCH_CACHE = "bentodrop-prefetch-v1";
const prefetchPath = (msgId) => `/__prefetch/${msgId}`;

async function dropPrefetch(msgId) {
  try {
    const cache = await caches.open(PREFETCH_CACHE);
    if (msgId) await cache.delete(prefetchPath(msgId));
    else for (const req of await cache.keys()) await cache.delete(req);
  } catch { /* cache is an optimization, never a failure */ }
}

// Compression runs in a dedicated worker so a phone's 300ms of canvas work
// never freezes the UI; any worker hiccup falls back to the inline path.
let imageWorker = null;
async function compressOffThread(file, original) {
  try {
    imageWorker ??= new Worker("/js/image-worker.js", { type: "module" });
    return await new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.data?.id !== id) return;
        imageWorker.removeEventListener("message", onMsg);
        if (e.data.ok) resolve(e.data.prepared);
        else reject(new Error(e.data.error));
      };
      imageWorker.addEventListener("message", onMsg);
      imageWorker.postMessage({ id, file, original });
    });
  } catch {
    return compressImage(file, { original });
  }
}

async function refreshContacts() {
  try {
    state.contacts = (await api.contacts()).contacts;
  } catch {
    state.contacts = state.contacts ?? [];
  }
  return state.contacts;
}

function renderInbox() {
  setNav(true);
  const root = el(`
    <div>
      <div class="paste-dock">
        <div class="row">
          <p class="big" style="flex:none">裝好,送出</p>
          <select id="sendTarget" style="margin-left:auto"><option value="">我的全部裝置</option></select>
        </div>
        <button class="clip-preview" id="clipPreview" type="button" hidden>
          <span class="cp-tag">剪貼簿</span>
          <span class="cp-body" id="clipBody"></span>
          <span class="cp-hint" id="clipHint">點一下改成手動編輯</span>
        </button>
        <textarea id="composeText" placeholder="輸入或貼上文字、連結…" maxlength="100000"></textarea>
        <div class="file-row">
          <button class="btn inline" id="sendBtn" type="button">送出</button>
          <label class="btn ghost inline" style="margin:0">
            選圖片 / 檔案<input id="fileInput" type="file" hidden>
          </label>
          <label class="small muted" style="display:flex;align-items:center;gap:5px">
            <input type="checkbox" id="origMode">原檔(保留 EXIF/GPS)
          </label>
        </div>
        <p class="btn-note" id="composeHint" style="text-align:left;margin-top:6px"></p>
        <div id="sendStatus"></div>
      </div>
      <div class="inbox-head"><b>收件匣</b><span class="cnt" id="unreadCnt" hidden></span>
        <button class="btn ghost inline" id="refreshBtn" type="button" style="margin-left:auto">重新整理</button>
      </div>
      <div id="msgList"></div>
    </div>`);
  $app.replaceChildren(root);

  // 收件匣上方:not running as an installed app → offer to install (§9 教學).
  installBanner().then((banner) => {
    if (banner) root.querySelector(".inbox-head").before(banner);
  });

  // Recipient picker: my own devices (default) or a contact (§11).
  const $target = root.querySelector("#sendTarget");
  refreshContacts().then(() => {
    for (const c of state.contacts) {
      $target.append(el(`<option value="${esc(c.peerUserId)}">給 ${esc(c.label)}</option>`));
    }
  });
  const currentTarget = () => state.contacts.find((c) => c.peerUserId === $target.value) ?? null;

  async function sendTextNow(text) {
    const $status = root.querySelector("#sendStatus");
    $status.replaceChildren(el(`<ul class="receipts"><li><b>…</b> 送出中</li></ul>`));
    try {
      const target = currentTarget();
      const envelope = target
        ? await C.encryptTextEnvelopeFor(target.peerPubkey, text)
        : await C.encryptTextEnvelope(state.kMaster, text);
      const res = await api.send(envelope, target?.peerUserId);
      showReceipts($status, res.receipts, target?.label);
      await refreshMessages().catch(() => {});
      paint();
      return true;
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">送出失敗:${esc(err.message)}</div>`));
      return false;
    }
  }

  async function sendFileNow(file, { original = false } = {}) {
    const $status = root.querySelector("#sendStatus");
    if (original && isImage(file)) {
      toast("原檔模式:EXIF 與 GPS 位置會完整保留", true);
    }
    $status.replaceChildren(el(`<ul class="receipts"><li><b>…</b> 處理中</li></ul>`));
    try {
      const prepared = await compressOffThread(file, original);
      if (!prepared.compressed && isImage(file) && !original) {
        toast(isHeic(file) ? "這張圖無法在瀏覽器中壓縮,將以原檔傳送(含 EXIF)" : "無法壓縮,以原檔傳送(含 EXIF)", true);
      }
      // Encrypted thumbnail for the notification (README 優化 #5) — best
      // effort, and rebuilt without it if the push budget is exceeded.
      let thumbBytes = null;
      if (/^image\//.test(prepared.mime)) {
        thumbBytes = await makeThumb(prepared.bytes, prepared.mime).catch(() => null);
      }
      const target = currentTarget();
      const build = (thumb) => target
        ? C.encryptFileEnvelopeFor(target.peerPubkey, state.userId, prepared.bytes, prepared.name, prepared.mime, thumb)
        : C.encryptFileEnvelope(state.kMaster, state.userId, prepared.bytes, prepared.name, prepared.mime, thumb);
      let { envelope, ciphertext } = await build(thumbBytes);
      if (thumbBytes && JSON.stringify(envelope).length > 3500) {
        ({ envelope, ciphertext } = await build(null));
      }

      // Merged flow (README 優化 #2): intent → PUT finalizes in one go.
      // Any failure falls back to the classic sign → PUT → send flow.
      let res;
      try {
        const intent = await api.uploadIntent(envelope, target?.peerUserId);
        res = await api.putObject(intent.url, ciphertext);
        if (!res.msgId) throw new Error("intent not finalized");
      } catch {
        const up = await api.uploadUrl(envelope.id, ciphertext.byteLength);
        await api.putObject(up.url, ciphertext);
        res = await api.send(envelope, target?.peerUserId);
      }
      showReceipts($status, res.receipts, target?.label);
      await refreshMessages().catch(() => {});
      paint();
      return true;
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">送出失敗:${esc(err.message)}</div>`));
      return false;
    }
  }

  // ── clipboard composer: one primary button whose meaning tracks state ──
  //   ⚡即送   — a clipboard preview is showing; sends exactly that, now
  //   送出     — the user typed something; sends the typed content
  //   ⚡貼上就送 — composer empty, clipboard unknown; reads (may prompt) and sends
  const $text = root.querySelector("#composeText");
  const $sendBtn = root.querySelector("#sendBtn");
  const $preview = root.querySelector("#clipPreview");
  const $clipBody = root.querySelector("#clipBody");
  const $clipHint = root.querySelector("#clipHint");
  const $hint = root.querySelector("#composeHint");
  let clip = null;          // {kind:'text',text} | {kind:'image',type,blob,url}
  let clipReadable = false; // permission granted → allowed to auto-preview
  let lastSentSig = null;   // avoid re-offering content that was just sent
  const clipSig = (c) => (c.kind === "text" ? `t:${c.text}` : `i:${c.type}:${c.blob.size}`);

  async function readClipboard({ interactive = false } = {}) {
    if (!navigator.clipboard) return null;
    try {
      if (!interactive) {
        // Never surprise the user with a permission prompt (§7.2 spirit).
        const perm = await navigator.permissions?.query({ name: "clipboard-read" }).catch(() => null);
        if (perm?.state !== "granted") return null;
      }
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (imgType) return { kind: "image", type: imgType, blob: await item.getType(imgType) };
          if (item.types.includes("text/plain")) {
            const text = (await (await item.getType("text/plain")).text()).trim();
            return text ? { kind: "text", text } : null;
          }
        }
        return null;
      }
      const text = (await navigator.clipboard.readText()).trim();
      return text ? { kind: "text", text } : null;
    } catch {
      if (interactive) throw new Error("無法讀取剪貼簿(權限被拒),請長按貼上");
      return null;
    }
  }

  function updateComposeUI() {
    const typed = $text.value.trim().length > 0;
    const showClip = !typed && clip !== null && clipSig(clip) !== lastSentSig;
    $preview.hidden = !showClip;
    if (showClip) {
      if (clip.kind === "text") {
        $clipBody.textContent = clip.text.slice(0, 120);
        $clipHint.hidden = false;
      } else {
        if (!clip.url) clip.url = URL.createObjectURL(clip.blob);
        $clipBody.replaceChildren(el(`<img alt="剪貼簿圖片" src="${clip.url}">`));
        $clipHint.hidden = true;
      }
      $sendBtn.textContent = "即送";
      $sendBtn.classList.add("zap");
      $hint.textContent = clip.kind === "text"
        ? "即送 = 直接送出上面的剪貼簿內容;想改內容就點預覽"
        : "即送 = 直接送出剪貼簿裡的圖片(會自動壓縮)";
    } else if (typed) {
      $sendBtn.textContent = "送出";
      $sendBtn.classList.remove("zap");
      $hint.textContent = "";
    } else if (navigator.clipboard && !clipReadable) {
      $sendBtn.textContent = "貼上就送";
      $sendBtn.classList.add("zap");
      $hint.textContent = "貼上就送 = 讀取剪貼簿並直接送出(第一次會詢問權限)";
    } else {
      $sendBtn.textContent = "送出";
      $sendBtn.classList.remove("zap");
      $hint.textContent = "";
    }
  }

  async function refreshClipboard() {
    const perm = await navigator.permissions?.query({ name: "clipboard-read" }).catch(() => null);
    clipReadable = perm?.state === "granted";
    if (clipReadable) clip = await readClipboard();
    updateComposeUI();
  }

  $text.addEventListener("input", updateComposeUI);
  $preview.onclick = () => {
    // Escape hatch from 即送: move the text into the composer for editing.
    if (clip?.kind === "text") {
      $text.value = clip.text;
      $text.focus();
      updateComposeUI();
    }
  };

  $sendBtn.onclick = async () => {
    const typed = $text.value.trim();
    if (typed) {
      if (await sendTextNow(typed)) {
        $text.value = "";
        updateComposeUI();
      }
      return;
    }
    let c = clip !== null && clipSig(clip) !== lastSentSig ? clip : null;
    if (!c) {
      try {
        c = await readClipboard({ interactive: true }); // 貼上就送 (may prompt)
      } catch (err) {
        return toast(err.message, true);
      }
      clipReadable = true;
      if (!c) {
        updateComposeUI();
        return toast("剪貼簿是空的,直接輸入內容也可以", true);
      }
    }
    const ok = c.kind === "text"
      ? await sendTextNow(c.text)
      : await sendFileNow(new File([c.blob], `clipboard.${c.type.split("/")[1] ?? "png"}`, { type: c.type }));
    if (ok) {
      lastSentSig = clipSig(c);
      clip = null;
      updateComposeUI();
    }
  };

  refreshClipboard();
  if (state._focusHandler) window.removeEventListener("focus", state._focusHandler);
  state._focusHandler = () => {
    refreshClipboard();
    refreshMessages().then(paint).catch(() => {});
  };
  window.addEventListener("focus", state._focusHandler);

  const $list = root.querySelector("#msgList");
  const $cnt = root.querySelector("#unreadCnt");

  async function paint() {
    const msgs = state.msgs;
    if (!msgs.length) {
      $list.replaceChildren(el(`
        <div class="compartment empty">
          <div class="ph"></div>
          <p style="font-weight:700">還沒有便當</p>
          <p class="small muted">加一台裝置,就可以開始互推東西。<br>或先送一則給自己試試。</p>
          <button class="btn inline" id="emptyPair" type="button">加一台裝置</button>
        </div>`));
      $list.querySelector("#emptyPair").onclick = () => renderPairOld();
      $cnt.hidden = true;
      return;
    }
    const unread = msgs.filter((m) => !m.readAt).length;
    $cnt.textContent = unread;
    $cnt.hidden = unread === 0;
    $list.replaceChildren();
    for (const m of msgs) {
      const cls = m.kind === "file" ? "img" : m.envelope.plain || m.readAt ? "plain" : "";
      const card = el(`
        <button class="mini ${cls}" type="button">
          <div class="mh">
            <span>${esc((m.from ?? "未知裝置").toUpperCase())}</span><span>· ${fmtTime(m.createdAt)}</span>
            ${m.fromContact ? '<span class="tagf">好友</span>' : ""}
            ${m.envelope.plain ? '<span class="tagx">未加密</span>' : ""}
            ${m.readAt ? "" : '<span class="unread"></span>'}
          </div>
          <div class="mt">…</div>
        </button>`);
      const $mt = card.querySelector(".mt");
      decryptPreview(m).then((d) => {
        if (d.error) $mt.textContent = "(無法解密)";
        else if (d.text !== undefined) $mt.textContent = d.text.slice(0, 80);
        else $mt.textContent = `${d.meta.name} · ${fmtSize(m.sizeBytes)}`;
      });
      card.onclick = () => openDetail(m);
      $list.append(card);
    }
  }

  root.querySelector("#refreshBtn").onclick = async () => {
    await refreshMessages().catch(() => toast("連不上伺服器", true));
    paint();
  };

  // send file (§3.2 + §4.4)
  root.querySelector("#fileInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return toast("上限 20 MB", true);
    await sendFileNow(file, { original: root.querySelector("#origMode").checked });
  };

  // Instant first paint from the cached listing, then refresh from the
  // server. A refresh failure keeps the cached view instead of wiping it.
  kvGet(K.MSG_CACHE).then((cached) => {
    if (cached?.messages?.length && !state.msgs.length) {
      state.msgs = cached.messages;
      paint();
    }
  }).catch(() => {}).finally(() => {
    refreshMessages().then(paint).catch(() => {
      if (state.msgs.length) toast("連不上伺服器,顯示上次的收件匣", true);
      else $list.replaceChildren(el(`<div class="banner err">連不上伺服器,稍後再試。</div>`));
    });
  });

  // §6.5: gentle backup nudge after the first file / on multi-device (checked in pairing flow)
}

function showReceipts($status, receipts, contactLabel) {
  if (!receipts?.length) {
    $status.replaceChildren(el(`<p class="btn-note">${contactLabel ? `已送給 ${esc(contactLabel)}(對方目前沒有裝置訂閱推送)` : "已送達(目前沒有其他裝置訂閱推送)"}</p>`));
    return;
  }
  const ul = el(`<ul class="receipts"></ul>`);
  receipts.forEach((r, i) => {
    const name = contactLabel ? `${esc(contactLabel)} 的裝置 ${i + 1}` : esc(r.label ?? r.deviceId.slice(0, 6));
    ul.append(el(`<li class="${r.ok ? "" : "fail"}"><b>${r.ok ? "✓" : "✕"}</b> ${name}${r.ok ? "" : ` · 失敗(${r.status})`}</li>`));
  });
  $status.replaceChildren(ul);
}

// ── message detail (§7.2) ────────────────────────────────────────────
async function openDetail(m) {
  const d = await decryptPreview(m);
  const box = el(`<div></div>`);
  const head = `<p class="eyebrow">FROM · ${esc((m.from ?? "?").toUpperCase())}${m.envelope.plain ? ' · <span class="tagx">未加密</span>' : ""}</p>`;

  if (m.kind === "text") {
    const text = d.error ? null : d.text;
    box.append(el(head));
    if (text === null) {
      box.append(el(`<div class="banner err">無法解密這則訊息(金鑰不符或內容損毀)。</div>`));
    } else {
      const det = C.detectTextKind(text);
      box.append(el(`<div class="detail-body">${esc(text)}</div>`));
      const actions = el(`<div class="row" style="margin-top:12px"></div>`);
      if (det.kind === "url") {
        // §7.2.1: https:// only, never auto-navigate, show the full URL.
        const open = el(`<a class="btn inline" style="text-decoration:none" target="_blank" rel="noopener noreferrer" href="${esc(det.url)}">開啟連結</a>`);
        actions.append(open);
      }
      const copy = el(`<button class="btn inline" type="button">複製</button>`);
      copy.onclick = () => copyText(text);
      actions.append(copy);
      box.append(actions);
      if (det.kind === "text-with-urls") {
        const ul = el(`<ul class="url-list"></ul>`);
        for (const u of det.urls) {
          ul.append(el(`<li><a target="_blank" rel="noopener noreferrer" href="${esc(u)}">${esc(u)}</a></li>`));
        }
        box.append(ul);
      }
    }
  } else {
    box.append(el(head));
    if (d.error) {
      box.append(el(`<div class="banner err">無法解密這個檔案。</div>`));
    } else {
      box.append(el(`<h3 style="margin-top:8px">${esc(d.meta.name)}</h3><p class="detail-meta">${esc(d.meta.mime)} · ${fmtSize(m.sizeBytes)}</p>`));
      const slot = el(`<div></div>`);
      const showPlain = (plain) => {
        const blob = new Blob([plain], { type: d.meta.mime });
        const objUrl = URL.createObjectURL(blob);
        slot.replaceChildren();
        if (/^image\//.test(d.meta.mime)) {
          slot.append(el(`<img class="detail-img" alt="${esc(d.meta.name)}" src="${objUrl}">`));
        }
        slot.append(el(`<a class="btn inline" style="text-decoration:none;margin-top:10px" download="${esc(d.meta.name)}" href="${objUrl}">儲存檔案</a>`));
      };

      // Prefetched by the SW when the push arrived? Decrypt and show NOW.
      let instant = false;
      try {
        const cache = await caches.open(PREFETCH_CACHE);
        const hit = await cache.match(prefetchPath(m.msgId));
        if (hit) {
          const cipher = new Uint8Array(await hit.arrayBuffer());
          showPlain(await C.decryptFileBody(await keysFor(m.envelope), m.envelope, cipher));
          instant = true;
        }
      } catch { /* fall through to the live download */ }

      if (!instant) {
        // Encrypted thumbnail (優化 #5): an immediate preview while the
        // real bytes are a tap away.
        if (m.envelope.thumb) {
          C.decryptThumb(await keysFor(m.envelope), m.envelope).then((tb) => {
            if (!tb || slot.querySelector(".detail-img")) return;
            const b64 = C.b64u(tb).replace(/-/g, "+").replace(/_/g, "/");
            slot.prepend(el(`<img class="detail-thumb" alt="預覽" src="data:image/webp;base64,${b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")}">`));
          }).catch(() => {});
        }
        const dl = el(`<button class="btn inline" type="button" style="margin-top:12px">下載並解密</button>`);
        dl.onclick = async () => {
          dl.disabled = true;
          dl.textContent = "下載中…";
          try {
            const { url } = await api.downloadUrl(m.envelope.obj);
            const cipher = await api.getObject(url);
            showPlain(await C.decryptFileBody(await keysFor(m.envelope), m.envelope, cipher));
            dl.remove();
          } catch (err) {
            dl.disabled = false;
            dl.textContent = "下載並解密";
            toast(err.message, true);
          }
        };
        box.append(dl);
      }
      box.append(slot);
    }
  }

  box.append(el(`<p class="detail-meta">#${esc(m.msgId.slice(-6))} · ${fmtTime(m.createdAt)} · ${new Date(m.expiresAt).toLocaleDateString()} 到期</p>`));
  const foot = el(`<div class="row" style="margin-top:14px"></div>`);
  const del = el(`<button class="btn ghost inline" type="button">刪除(所有裝置)</button>`);
  del.onclick = async () => {
    try {
      await api.deleteMessage(m.msgId);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return toast(err.message, true);
      toast("這則訊息已被刪除");
    }
    dropPrefetch(m.msgId);
    back.remove();
    await refreshMessages().catch(() => {});
    renderInbox();
  };
  foot.append(del);
  box.append(foot);
  const back = modal(box);

  if (!m.readAt) {
    api.markRead(m.msgId).then(() => {
      m.readAt = Date.now();
    }).catch(() => {});
  }
}

// ── pairing: old device (§6.6) ───────────────────────────────────────
async function renderPairOld() {
  setNav(true);
  const root = el(`
    <div class="compartment" style="max-width:440px;margin:30px auto">
      <p class="eyebrow">加裝置</p>
      <h2 style="margin-top:8px">在另一台裝置打開這個</h2>
      <div id="pairBody"><p class="muted small" style="margin-top:12px">建立配對中…</p></div>
    </div>`);
  $app.replaceChildren(root);
  const $body = root.querySelector("#pairBody");

  let pair;
  try {
    pair = await api.pairCreate();
  } catch (err) {
    $body.replaceChildren(el(`<div class="banner err">${esc(err.message)}</div>`), backBtn());
    return;
  }
  const joinUrl = `${location.origin}/p/${pair.pairId}`;
  // The code rides in the URL fragment: it reaches the new device's browser
  // but never the server (fragments aren't sent in requests). Scanning the QR
  // proves the same thing typing the code does — you can see this screen.
  const qrUrl = `${joinUrl}#c=${pair.code}`;
  $body.replaceChildren(el(`
    <div>
      <div class="qr">${qrSvg(qrUrl)}</div>
      <p class="pairurl">${esc(joinUrl)}</p>
      <p class="paircode">${esc(pair.code.split("").join(" "))}</p>
      <p class="pairmeta">5 分鐘後失效 · 錯 3 次作廢 · 只能用一次</p>
      <div class="timer"><i id="pairTimer" style="width:100%"></i></div>
      <button class="btn ghost" id="copyJoin" type="button">複製網址</button>
      <div id="pairWait"><p class="btn-note">用手機相機掃描,或在另一台裝置輸入網址與配對碼</p></div>
    </div>`), backBtn());
  $body.querySelector("#copyJoin").onclick = () => copyText(`${joinUrl}  配對碼 ${pair.code}`);

  const $timer = $body.querySelector("#pairTimer");
  const $wait = $body.querySelector("#pairWait");
  let stopped = false;
  const tick = setInterval(() => {
    const left = Math.max(0, pair.expiresAt - Date.now());
    $timer.style.width = `${(left / (5 * 60 * 1000)) * 100}%`;
    if (left === 0) {
      cleanup();
      $wait.replaceChildren(el(`<div class="banner err">配對已過期,請重新建立。</div>`));
    }
  }, 1000);
  const poll = setInterval(async () => {
    if (stopped) return;
    try {
      const st = await api.pairStatus(pair.pairId);
      if (st.consumed) { cleanup(); return; }
      if (st.claimed && !st.approved) {
        cleanup();
        confirmNewDevice(pair, st, $wait);
      }
    } catch { /* keep polling */ }
  }, 2000);
  function cleanup() { stopped = true; clearInterval(tick); clearInterval(poll); }

  function backBtn() {
    const b = el(`<button class="btn ghost" type="button" style="margin-top:16px">回收件匣</button>`);
    b.onclick = () => { cleanup(); renderInbox(); };
    return b;
  }
}

/** §6.6: the old device must show an explicit confirmation. */
function confirmNewDevice(pair, st, $slot) {
  const box = el(`
    <div>
      <div class="banner">有一台裝置「<b>${esc(st.newLabel ?? "未知")}</b>」要求配對。確認是你自己的裝置嗎?</div>
      <div class="row" style="margin-top:12px">
        <button class="btn inline" id="okBtn" type="button">確認配對</button>
        <button class="btn ghost inline" id="noBtn" type="button">拒絕</button>
      </div>
    </div>`);
  $slot.replaceChildren(box);
  box.querySelector("#noBtn").onclick = () => renderInbox();
  box.querySelector("#okBtn").onclick = async () => {
    box.querySelector("#okBtn").disabled = true;
    try {
      const mine = await C.generateEcdhPair();
      const entropy = await kvGet(K.ENTROPY);
      const userName = await kvGet(K.USER_NAME);
      const wrapped = await C.wrapForPeer(mine.privateKey, st.newPubkey, {
        entropy: C.b64u(entropy),
        userName,
      });
      await api.pairApprove(pair.pairId, wrapped, mine.publicJwk);
      $slot.replaceChildren(el(`<p class="btn-note">✓ 已確認,新裝置正在完成設定</p>`));
      // §6.5: after gaining a second device, nudge (never force) a backup.
      const backedUp = await kvGet(K.BACKED_UP);
      if (!backedUp) {
        setTimeout(() => {
          const b = el(`
            <div>
              <h3>你現在有兩台裝置了</h3>
              <p class="small muted" style="margin-top:6px">要不要備份還原碼,以免兩台都遺失?兩台都遺失時,只有還原碼能救回來。</p>
              <div class="row" style="margin-top:12px">
                <button class="btn inline" id="bkGo" type="button">備份還原碼</button>
                <button class="btn ghost inline" id="bkLater" type="button">之後再說</button>
              </div>
            </div>`);
          const back = modal(b);
          b.querySelector("#bkGo").onclick = () => { back.remove(); renderBackup(); };
          b.querySelector("#bkLater").onclick = () => { back.remove(); renderInbox(); };
          kvSet(K.BACKUP_PROMPTED, Date.now());
        }, 800);
      }
    } catch (err) {
      toast(err.message, true);
      box.querySelector("#okBtn").disabled = false;
    }
  };
}

// ── pairing: new device ──────────────────────────────────────────────
function renderPairJoin(pairIdFromUrl) {
  setNav(false);
  const root = el(`
    <div class="compartment" style="max-width:440px;margin:30px auto">
      <p class="eyebrow">配對加入</p>
      <h2 style="margin-top:8px">輸入舊裝置畫面上的資訊</h2>
      <form id="joinForm">
        ${pairIdFromUrl ? "" : `<div class="field"><label>配對網址或代碼</label><input id="jnPairId" autocomplete="off" placeholder="bento.example/p/…" required></div>`}
        <div class="field"><label>6 位配對碼</label><input id="jnCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>
        <div class="field"><label>這台裝置的別名</label><input id="jnLabel" autocomplete="off" maxlength="64" placeholder="例:工作筆電"></div>
        <button class="btn" type="submit">加入</button>
      </form>
      <div id="joinStatus"></div>
      <button class="btn ghost" id="jnBack" type="button">返回</button>
    </div>`);
  $app.replaceChildren(root);
  root.querySelector("#jnBack").onclick = () => location.assign("/");
  root.querySelector("#jnLabel").value = guessLabel();
  // Scanned via QR? The code rides in the fragment (#c=123456) — pre-fill it.
  const fragCode = /[#&]c=(\d{6})/.exec(location.hash)?.[1];
  if (fragCode) root.querySelector("#jnCode").value = fragCode;

  root.querySelector("#joinForm").onsubmit = async (e) => {
    e.preventDefault();
    const $status = root.querySelector("#joinStatus");
    const code = root.querySelector("#jnCode").value.trim();
    let pairId = pairIdFromUrl;
    if (!pairId) {
      const raw = root.querySelector("#jnPairId").value.trim();
      pairId = raw.includes("/p/") ? raw.split("/p/")[1].replace(/[^A-Za-z0-9_-]/g, "") : raw;
    }
    const btn = e.target.querySelector(".btn");
    btn.disabled = true;
    try {
      const mine = await C.generateEcdhPair();
      const label = root.querySelector("#jnLabel").value.trim() || guessLabel();
      await api.pairClaim(pairId, code, mine.publicJwk, label);
      $status.replaceChildren(el(`<p class="btn-note">已送出,等待舊裝置確認…</p>`));
      const finish = async () => {
        let res;
        try {
          res = await api.pairFinish(pairId, code);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) return setTimeout(finish, 2000);
          throw err;
        }
        const secret = await C.unwrapFromPeer(mine.privateKey, res.oldPubkey, res.wrappedBlob);
        const entropy = C.unb64u(secret.entropy);
        await saveIdentity({
          entropy, userName: secret.userName,
          userId: res.userId, deviceId: res.deviceId, deviceToken: res.deviceToken,
          label, vapidPublicKey: res.vapidPublicKey,
        });
        state.kMaster = await C.deriveKmaster(entropy, secret.userName);
        state.userId = res.userId;
        state.deviceId = res.deviceId;
        state.label = label;
        history.replaceState(null, "", "/");
        toast("配對完成");
        renderInbox();
        ensurePush({ interactive: true });
      };
      finish();
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">${esc(err.message)}</div>`));
      btn.disabled = false;
    }
  };
}

// ── friends (§11 / §6.7): same URL+code mechanism, 30-minute TTL ─────
async function renderFriendInvite() {
  setNav(true);
  const userName = (await kvGet(K.USER_NAME)) ?? "";
  const root = el(`
    <div class="compartment" style="max-width:460px;margin:30px auto">
      <p class="eyebrow">加好友</p>
      <h2 style="margin-top:8px">邀請對方掃描或開啟連結</h2>
      <form id="fiForm">
        <div class="field"><label>我顯示給對方的名字</label><input id="fiName" maxlength="64" value="${esc(userName)}" required></div>
        <button class="btn" type="submit">建立邀請</button>
      </form>
      <div id="fiBody"></div>
      <button class="btn ghost" id="fiBack" type="button">回設定</button>
    </div>`);
  $app.replaceChildren(root);
  root.querySelector("#fiBack").onclick = () => renderSettings();

  root.querySelector("#fiForm").onsubmit = async (e) => {
    e.preventDefault();
    const myName = root.querySelector("#fiName").value.trim();
    const $body = root.querySelector("#fiBody");
    try {
      await ensureUserIdentity();
      const inv = await api.contactInvite(myName);
      root.querySelector("#fiForm").hidden = true;
      const joinUrl = `${location.origin}/f/${inv.pairId}`;
      $body.replaceChildren(el(`
        <div>
          <div class="qr">${qrSvg(`${joinUrl}#c=${inv.code}`, { label: "加好友 QR 碼" })}</div>
          <p class="pairurl">${esc(joinUrl)}</p>
          <p class="paircode">${esc(inv.code.split("").join(" "))}</p>
          <p class="pairmeta">30 分鐘後失效 · 錯 3 次作廢 · 只能用一次</p>
          <button class="btn ghost" id="fiCopy" type="button">複製網址與邀請碼</button>
          <div id="fiWait"><p class="btn-note">等待對方加入…</p></div>
        </div>`));
      $body.querySelector("#fiCopy").onclick = () => copyText(`${joinUrl}  邀請碼 ${inv.code}`);

      const $wait = $body.querySelector("#fiWait");
      const poll = setInterval(async () => {
        try {
          const st = await api.contactInviteStatus(inv.pairId);
          if (Date.now() > st.expiresAt) {
            clearInterval(poll);
            $wait.replaceChildren(el(`<div class="banner err">邀請已過期,請重新建立。</div>`));
            return;
          }
          if (st.claimed && !st.completed) {
            clearInterval(poll);
            const box = el(`
              <div>
                <div class="banner">「<b>${esc(st.claimerName ?? "?")}</b>」要求成為好友。確認嗎?</div>
                <div class="field"><label>你想怎麼稱呼對方</label><input id="fiLabel" maxlength="64" value="${esc(st.claimerName ?? "")}"></div>
                <div class="row" style="margin-top:12px">
                  <button class="btn inline" id="fiOk" type="button">確認加好友</button>
                  <button class="btn ghost inline" id="fiNo" type="button">拒絕</button>
                </div>
              </div>`);
            $wait.replaceChildren(box);
            box.querySelector("#fiNo").onclick = () => renderSettings();
            box.querySelector("#fiOk").onclick = async () => {
              try {
                const res = await api.contactApprove(inv.pairId, box.querySelector("#fiLabel").value.trim());
                toast(`已加入好友:${res.contact.label}`);
                await refreshContacts();
                renderSettings();
              } catch (err) {
                toast(err.message, true);
              }
            };
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (err) {
      $body.replaceChildren(el(`<div class="banner err">${esc(err.message)}</div>`));
    }
  };
}

function renderFriendJoin(pairId) {
  setNav(true);
  const root = el(`
    <div class="compartment" style="max-width:460px;margin:30px auto">
      <p class="eyebrow">成為好友</p>
      <h2 style="margin-top:8px">輸入邀請碼</h2>
      <form id="fjForm">
        <div class="field"><label>6 位邀請碼</label><input id="fjCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>
        <div class="field"><label>我顯示給對方的名字</label><input id="fjName" maxlength="64" required></div>
        <button class="btn" type="submit">加入</button>
      </form>
      <div id="fjStatus"></div>
      <button class="btn ghost" id="fjBack" type="button">回收件匣</button>
    </div>`);
  $app.replaceChildren(root);
  kvGet(K.USER_NAME).then((n) => { root.querySelector("#fjName").value = n ?? ""; });
  const fragCode = /[#&]c=(\d{6})/.exec(location.hash)?.[1];
  if (fragCode) root.querySelector("#fjCode").value = fragCode;
  root.querySelector("#fjBack").onclick = () => { history.replaceState(null, "", "/"); renderInbox(); };

  root.querySelector("#fjForm").onsubmit = async (e) => {
    e.preventDefault();
    const $status = root.querySelector("#fjStatus");
    const btn = e.target.querySelector(".btn");
    btn.disabled = true;
    try {
      await ensureUserIdentity();
      const before = (await refreshContacts()).length;
      const res = await api.contactClaim(pairId, root.querySelector("#fjCode").value.trim(), root.querySelector("#fjName").value.trim());
      $status.replaceChildren(el(`<p class="btn-note">已送出,等待 ${esc(res.inviterName ?? "對方")} 確認…</p>`));
      const poll = setInterval(async () => {
        const contacts = await refreshContacts();
        if (contacts.length > before) {
          clearInterval(poll);
          toast(`已成為好友:${contacts[contacts.length - 1].label}`);
          history.replaceState(null, "", "/");
          renderInbox();
        }
      }, 2000);
      setTimeout(() => clearInterval(poll), 30 * 60 * 1000);
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">${esc(err.message)}</div>`));
      btn.disabled = false;
    }
  };
}

// ── backup (§6.5.1) ──────────────────────────────────────────────────
async function renderBackup() {
  setNav(true);
  const entropy = await kvGet(K.ENTROPY);
  const words = await C.entropyToMnemonic(entropy);
  const root = el(`
    <div class="compartment" style="max-width:480px;margin:30px auto">
      <p class="eyebrow">備份還原碼</p>
      <h2 style="margin-top:8px">抄下這 12 個字</h2>
      <p class="small muted" style="margin-top:6px">兩台裝置都遺失時,只有這個能救回來。我們沒有備份,也救不了你。</p>
      <div class="words" id="wordGrid"></div>
      <div class="save-opts" style="grid-template-columns:repeat(5,1fr)">
        <button class="save-opt pri" id="svCopy" type="button">複製</button>
        <button class="save-opt" id="svQr" type="button">QR</button>
        <button class="save-opt" id="svDl" type="button">下載</button>
        <button class="save-opt" id="svPrint" type="button">列印</button>
        <button class="save-opt" id="svHand" type="button">已手抄</button>
      </div>
      <p class="btn-note">複製:貼進密碼管理器,貼完清空剪貼簿 · QR:相簿可能自動同步到雲端 · 下載:檔案會留在下載資料夾 · 列印:印表機可能有快取</p>
      <button class="btn" id="svVerify" type="button">存好了,抽 3 個字驗證</button>
      <button class="btn ghost" id="svBack" type="button">回收件匣</button>
    </div>`);
  $app.replaceChildren(root);
  const grid = root.querySelector("#wordGrid");
  words.forEach((w, i) => grid.append(el(`<div class="word"><b>${i + 1}</b>${esc(w)}</div>`)));
  const phrase = words.join(" ");
  root.querySelector("#svCopy").onclick = () => copyText(phrase);
  root.querySelector("#svDl").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`BentoDrop 還原碼\n\n${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}\n`], { type: "text/plain" }));
    a.download = "bentodrop-recovery.txt";
    a.click();
    toast("已下載,記得移出下載資料夾");
  };
  root.querySelector("#svQr").onclick = () => {
    const box = el(`
      <div>
        <h3>還原碼 QR</h3>
        <p class="small muted" style="margin-top:6px">用另一台裝置拍下或截圖保存。⚠ 存進相簿的話,相簿可能會自動同步到雲端。</p>
        <div class="qr" style="width:220px;height:220px">${qrSvg(phrase, { label: "還原碼 QR" })}</div>
        <p class="btn-note">還原時在「用還原碼還原」頁選這張圖即可</p>
      </div>`);
    modal(box);
  };
  root.querySelector("#svPrint").onclick = () => window.print();
  root.querySelector("#svHand").onclick = () => toast("記得放在安全的地方");
  root.querySelector("#svBack").onclick = () => renderInbox();
  root.querySelector("#svVerify").onclick = () => verifyBackup(words);
}

/** §6.5.1: sample 3 of the 12 words; re-viewing is always allowed. */
function verifyBackup(words) {
  const picks = [];
  while (picks.length < 3) {
    const i = Math.floor(Math.random() * 12);
    if (!picks.includes(i)) picks.push(i);
  }
  picks.sort((a, b) => a - b);
  const box = el(`
    <div>
      <h3>第 ${picks.map((i) => i + 1).join("、")} 個字是?</h3>
      <form id="vfForm">
        ${picks.map((i) => `<div class="field"><label>第 ${i + 1} 個字</label><input data-idx="${i}" autocomplete="off" autocapitalize="off" required></div>`).join("")}
        <button class="btn" type="submit">驗證</button>
      </form>
      <button class="btn ghost" id="vfAgain" type="button">回去再看一次</button>
    </div>`);
  const back = modal(box);
  box.querySelector("#vfAgain").onclick = () => back.remove();
  box.querySelector("#vfForm").onsubmit = async (e) => {
    e.preventDefault();
    const ok = [...box.querySelectorAll("input")].every(
      (inp) => inp.value.trim().toLowerCase() === words[Number(inp.dataset.idx)],
    );
    if (!ok) return toast("有字不對,回去再核對一次", true);
    await kvSet(K.BACKED_UP, Date.now());
    back.remove();
    toast("備份完成 ✓");
    renderInbox();
  };
}

// ── restore (§6.8: last lifeline) ────────────────────────────────────
function renderRestore() {
  setNav(false);
  const root = el(`
    <div class="compartment" style="max-width:480px;margin:30px auto">
      <p class="eyebrow">還原</p>
      <h2 style="margin-top:8px">輸入名字與 12 個還原字</h2>
      <div class="banner">還原碼能找回你的金鑰。沒有伺服器帳號,舊訊息(預設 7 天)過期即消失;還原後這台會成為新的第一台裝置。</div>
      <form id="rsForm">
        <div class="field"><label>名字(當初輸入的)</label><input id="rsName" required></div>
        <label class="btn ghost" style="margin-top:12px">用 QR 照片匯入 12 個字<input id="rsQrFile" type="file" accept="image/*" hidden></label>
        <div class="words" id="rsGrid"></div>
        <button class="btn" type="submit">還原</button>
      </form>
      <button class="btn ghost" id="rsBack" type="button">返回</button>
    </div>`);
  $app.replaceChildren(root);
  const grid = root.querySelector("#rsGrid");
  for (let i = 0; i < 12; i++) {
    grid.append(el(`<div class="word"><b>${i + 1}</b><input data-i="${i}" autocomplete="off" autocapitalize="off" spellcheck="false" list="bipWords"></div>`));
  }
  // 4-letter prefix autocomplete (§6.2)
  const dl = el(`<datalist id="bipWords"></datalist>`);
  root.append(dl);
  grid.addEventListener("input", (e) => {
    if (e.target.tagName !== "INPUT") return;
    dl.replaceChildren(...C.wordCompletions(e.target.value).map((w) => el(`<option value="${w}"></option>`)));
  });
  root.querySelector("#rsQrFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await decodeQrFromFile(file);
      const words = text.trim().toLowerCase().split(/\s+/);
      if (words.length !== 12) throw new Error("這個 QR 不是 12 字還原碼");
      const inputs = grid.querySelectorAll("input");
      words.forEach((w, i) => { inputs[i].value = w; });
      toast("已匯入 12 個字,確認後按還原");
    } catch (err) {
      toast(err.message, true);
    }
  };
  root.querySelector("#rsBack").onclick = () => renderOnboarding();
  root.querySelector("#rsForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = root.querySelector("#rsName").value.trim();
    const words = [...grid.querySelectorAll("input")].map((i) => i.value);
    try {
      const entropy = await C.mnemonicToEntropy(words);
      await onboardNewUser(name, entropy);
      await kvSet(K.BACKED_UP, Date.now());
      toast("已還原金鑰");
      renderInbox();
      ensurePush({ interactive: true });
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ── settings ─────────────────────────────────────────────────────────
async function renderSettings() {
  setNav(true);
  let me;
  try {
    me = await api.me();
  } catch (err) {
    $app.replaceChildren(el(`<div class="banner err">${esc(err.message)}</div>`));
    return;
  }
  const notifyPreview = (await kvGet(K.NOTIFY_PREVIEW)) !== false; // default on
  const backedUp = await kvGet(K.BACKED_UP);
  const installed = await isInstalled();
  const root = el(`
    <div>
      <h2>設定</h2>

      <div class="compartment" style="margin-top:16px">
        <h3>裝置</h3>
        <div id="devList"></div>
        <div class="row" style="margin-top:10px">
          <button class="btn inline" id="stPair" type="button">加一台裝置</button>
          <button class="btn ghost inline" id="stTestPush" type="button">測試推送</button>
          <button class="btn ghost inline" id="stEnablePush" type="button">啟用本機通知</button>
          ${installed ? "" : '<button class="btn ghost inline" id="stInstall" type="button">安裝成 App</button>'}
        </div>
        <div id="pushResult"></div>
      </div>

      <div class="compartment">
        <h3>好友</h3>
        <p class="small muted">加了好友就能互送。對方看不到你的裝置名稱,只看到你取的名字。</p>
        <div id="friendList"></div>
        <button class="btn inline" id="stFriendInvite" type="button" style="margin-top:10px">邀請好友</button>
      </div>

      <div class="compartment">
        <h3>通知</h3>
        <label class="switch">
          <input type="checkbox" id="stPreview" ${notifyPreview ? "checked" : ""}>
          <span>顯示通知內容<br><span class="small muted">關閉時,所有通知一律顯示「收到一則新訊息」。只影響這台裝置。</span></span>
        </label>
      </div>

      <div class="compartment">
        <h3>保留期</h3>
        <p class="small muted">到期自動刪除,所有裝置同步消失。</p>
        <select id="stRetention">
          ${[1, 7, 30].map((d) => `<option value="${d}" ${me.retentionDays === d ? "selected" : ""}>${d} 天</option>`).join("")}
        </select>
      </div>

      <div class="compartment">
        <h3>還原碼 ${backedUp ? "" : '<span class="tagx">尚未備份</span>'}</h3>
        <p class="small muted">兩台裝置都遺失時的最後救生索。</p>
        <button class="btn ghost inline" id="stBackup" type="button" style="margin-top:8px">${backedUp ? "重新顯示還原碼" : "備份還原碼"}</button>
      </div>

      <div class="compartment">
        <h3>API Tokens</h3>
        <p class="small muted">給腳本用的推送權杖,只能發、不能讀。</p>
        <div id="tokList"></div>
        <form id="tokForm" class="row" style="margin-top:10px">
          <input id="tokLabel" placeholder="用途,例:NAS 備份腳本" required style="flex:1;border:2px solid var(--nori);border-radius:8px;padding:8px;font:inherit">
          <label class="small"><input type="checkbox" id="tokPlain"> 明文模式</label>
          <button class="btn inline" type="submit">建立</button>
        </form>
        <p class="small muted" id="tokPlainWarn" hidden>⚠ 明文模式:內容不加密經過伺服器,只適合不敏感的通知(建置完成、備份成功)。收件匣會標示「未加密」。</p>
        <div id="tokReveal"></div>
      </div>

      <div class="compartment">
        <h3>診斷</h3>
        <p class="small muted">測量這台裝置到伺服器的實際速度:加密、上傳、下載各花多久,R2 離邊緣節點多遠。會上傳約 4 MB 的測試資料,測完立即刪除。</p>
        <div class="row" id="probeRow" style="margin-top:8px" hidden>
          <label class="small muted" for="probeTarget">推送探針對象:</label>
          <select id="probeTarget"><option value="">不測推送送達</option></select>
        </div>
        <p class="small muted" id="probeNote" hidden>測推送送達會在對方裝置跳出幾則探針通知。</p>
        <button class="btn inline" id="diagStart" type="button" style="margin-top:8px">開始測試</button>
        <ul class="receipts" id="diagProgress" style="margin-top:10px"></ul>
        <div id="diagResult"></div>
      </div>

      <div class="compartment">
        <h3>清空與重設</h3>
        <div class="row">
          <button class="btn ghost inline" id="stClearMsgs" type="button">清空收件匣(所有裝置)</button>
          <button class="btn danger inline" id="stReset" type="button">重設這台裝置</button>
        </div>
      </div>

      <button class="btn ghost" id="stBack" type="button" style="margin-bottom:56px">回收件匣</button>
    </div>`);
  $app.replaceChildren(root);

  // devices (§8.4)
  const $dev = root.querySelector("#devList");
  for (const d of me.devices) {
    const row = el(`
      <div class="dev-row">
        <div class="dev-info">
          <span class="lab">${esc(d.label ?? "裝置")}${d.isSelf ? "(這台)" : ""}</span>
          <span class="meta">${d.lastSeenAt ? "最近活動 " + fmtTime(d.lastSeenAt) : "未曾連線"}${d.subscribed ? "" : " · 未訂閱推送"}</span>
          ${d.maybeDead ? '<span class="dead">可能已失效</span>' : ""}
        </div>
        <div class="dev-actions"></div>
      </div>`);
    const $actions = row.querySelector(".dev-actions");
    const rename = el(`<button class="btn ghost inline" type="button">改名</button>`);
    rename.onclick = async () => {
      const label = prompt("裝置別名", d.label ?? "")?.trim();
      if (!label || label === d.label) return;
      try {
        await api.renameDevice(d.deviceId, label);
        if (d.isSelf) {
          await kvSet(K.DEVICE_LABEL, label);
          state.label = label;
        }
        toast("已改名");
        renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    };
    $actions.append(rename);
    if (!d.isSelf) {
      const rm = el(`<button class="btn ghost inline" type="button">移除</button>`);
      rm.onclick = async () => {
        if (!confirm(`移除「${d.label ?? d.deviceId}」?它將無法再收發。`)) return;
        await api.deleteDevice(d.deviceId).catch((err) => toast(err.message, true));
        renderSettings();
      };
      $actions.append(rm);
    }
    $dev.append(row);
  }

  // friends (§11)
  const $friends = root.querySelector("#friendList");
  refreshContacts().then(() => {
    $friends.replaceChildren();
    if (!state.contacts.length) {
      $friends.append(el(`<p class="small muted">還沒有好友。</p>`));
      return;
    }
    for (const c of state.contacts) {
      const row = el(`
        <div class="dev-row">
          <div class="dev-info">
            <span class="lab">${esc(c.label)}</span>
            <span class="meta">${new Date(c.createdAt).toLocaleDateString()} 加入</span>
          </div>
          <div class="dev-actions"></div>
        </div>`);
      const rn = el(`<button class="btn ghost inline" type="button">改名</button>`);
      rn.onclick = async () => {
        const label = prompt("好友稱呼", c.label)?.trim();
        if (!label || label === c.label) return;
        await api.renameContact(c.peerUserId, label).catch((err) => toast(err.message, true));
        renderSettings();
      };
      const rm = el(`<button class="btn ghost inline" type="button">解除</button>`);
      rm.onclick = async () => {
        if (!confirm(`解除好友「${c.label}」?對方將無法再傳東西給你。`)) return;
        await api.deleteContact(c.peerUserId).catch((err) => toast(err.message, true));
        renderSettings();
      };
      row.querySelector(".dev-actions").append(rn, rm);
      $friends.append(row);
    }
  });
  root.querySelector("#stFriendInvite").onclick = () => renderFriendInvite();

  root.querySelector("#stPair").onclick = () => renderPairOld();
  root.querySelector("#stTestPush").onclick = async () => {
    const $r = root.querySelector("#pushResult");
    try {
      const { receipts } = await api.testPush();
      showReceipts($r, receipts);
    } catch (err) {
      toast(err.message, true);
    }
  };
  root.querySelector("#stEnablePush").onclick = async () => {
    const ok = await ensurePush({ interactive: true });
    toast(ok ? "推送已啟用 ✓" : "無法啟用推送(權限被拒或瀏覽器不支援)", !ok);
  };
  // Always-reachable install entry — survives a dismissed banner, and on a
  // device where the app is already installed (no beforeinstallprompt) it
  // still opens the how-to guide.
  const $install = root.querySelector("#stInstall");
  if ($install) {
    $install.onclick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (outcome === "accepted") toast("已安裝 ✓ 之後從 App 圖示開啟");
        return;
      }
      showInstallGuide();
    };
  }
  root.querySelector("#stPreview").onchange = async (e) => {
    await kvSet(K.NOTIFY_PREVIEW, e.target.checked); // read by sw.js (§6.3)
  };
  root.querySelector("#stRetention").onchange = async (e) => {
    await api.settings(Number(e.target.value)).catch((err) => toast(err.message, true));
    toast("已更新保留期");
  };
  root.querySelector("#stBackup").onclick = () => renderBackup();

  // Push-probe target: another device of this user with a live subscription.
  const probeCandidates = me.devices.filter((d) => !d.isSelf && d.subscribed);
  if (probeCandidates.length) {
    const $probeRow = root.querySelector("#probeRow");
    const $probeSel = root.querySelector("#probeTarget");
    $probeRow.hidden = false;
    root.querySelector("#probeNote").hidden = false;
    for (const d of probeCandidates) {
      $probeSel.append(el(`<option value="${esc(d.deviceId)}">${esc(d.label ?? d.deviceId.slice(0, 8))}</option>`));
    }
    $probeSel.value = probeCandidates[0].deviceId;
  }

  // Transport diagnostics — per-step checklist (no spinners), verdict first.
  root.querySelector("#diagStart").onclick = async () => {
    const $btn = root.querySelector("#diagStart");
    const $prog = root.querySelector("#diagProgress");
    const $res = root.querySelector("#diagResult");
    $btn.disabled = true;
    $btn.textContent = "測試中…";
    $prog.replaceChildren();
    $res.replaceChildren();
    const items = new Map();
    try {
      const result = await runDiagnostics(state.kMaster, state.userId, {
        probeTargetId: root.querySelector("#probeTarget")?.value || null,
        onStep: (label) => {
          const li = el(`<li><b>…</b> <span>${esc(label)}</span></li>`);
          items.set(label, li);
          $prog.append(li);
        },
        onStepDone: (label) => {
          const li = items.get(label);
          if (li) li.querySelector("b").textContent = "✓";
        },
      });

      const box = el(`<div style="margin-top:12px"></div>`);
      for (const c of result.conclusions) {
        box.append(el(`<div class="diag-verdict ${c.level}">${c.level === "warn" ? "⚠" : c.level === "ok" ? "✓" : "·"} ${esc(c.text)}</div>`));
      }
      const mb = result.sizes.find((s) => s.label === "1 MB");
      const table = el(`<div class="diag-table"></div>`);
      const row = (k, v, flag = "") => table.append(el(`<div><span>${esc(k)}</span><span>${esc(v)}${flag}</span></div>`));
      row("你 → 邊緣節點" + (result.env.colo ? `(${result.env.colo})` : ""), `${result.edgeRttMs} ms`);
      row("邊緣節點 → R2(GET)", `${result.env.r2.getMs} ms`, result.env.r2.getMs > 100 ? " ⚠" : " ✓");
      if (mb) {
        row("上傳 1 MB", `${mb.uploadMs} ms`);
        row("下載 1 MB", `${mb.downloadMs} ms`);
        row("加密 1 MB", `${mb.encryptMs} ms`);
        row("1 MB 端到端", `${mb.e2eMs} ms(${mb.e2eMinMs}–${mb.e2eMaxMs})`);
      }
      for (const s of result.sizes.filter((x) => x.label !== "1 MB")) {
        row(`${s.label} 端到端`, `${s.e2eMs} ms(${s.e2eMinMs}–${s.e2eMaxMs})`);
      }
      row("圖片壓縮", result.compressMs === null ? "未測量" : `${result.compressMs} ms`, result.compressMs > 300 ? " ⚠" : "");
      if (result.pushProbe && !result.pushProbe.error) {
        row("推送往返(→對方→回)", `${result.pushProbe.rttMs} ms`, "");
        row("推送單程估計", `~${result.pushProbe.oneWayMs} ms`);
      } else {
        row("推送送達", result.pushProbe?.error ? "測量失敗" : "未測量");
      }
      const copy = el(`<button class="btn ghost inline" type="button" style="margin-top:10px">複製報告</button>`);
      copy.onclick = () => copyText(formatReport(result));
      $res.append(box, table, copy);
    } catch (err) {
      $res.replaceChildren(el(`<div class="banner err">診斷失敗:${esc(err.message)}</div>`));
    }
    $btn.disabled = false;
    $btn.textContent = "再測一次";
  };
  root.querySelector("#stClearMsgs").onclick = async () => {
    if (!confirm("清空所有訊息?所有裝置都會消失,已下載到本機的副本不受影響。")) return;
    await api.clearMessages().catch((err) => toast(err.message, true));
    dropPrefetch();
    toast("已清空");
  };
  root.querySelector("#stReset").onclick = async () => {
    if (!confirm("重設會刪除這台裝置上的金鑰與登入。未備份還原碼且沒有其他裝置的話,資料將永遠無法解密。確定?")) return;
    for (const key of Object.values(K)) await kvDelete(key);
    await kvDelete("identityPrivWrapped");
    location.assign("/");
  };
  root.querySelector("#stBack").onclick = () => renderInbox();

  // tokens (§12)
  const $tok = root.querySelector("#tokList");
  async function paintTokens() {
    const { tokens } = await api.listTokens();
    $tok.replaceChildren();
    // Revoked tokens are dead — don't let them take up space.
    const active = tokens.filter((t) => !t.revokedAt);
    const revokedCount = tokens.length - active.length;
    if (!active.length) $tok.append(el(`<p class="small muted">還沒有${revokedCount ? "有效的 " : " "}token。</p>`));
    for (const t of active) {
      const row = el(`
        <div class="tok-row">
          <b>${esc(t.label)}</b>
          ${t.plaintextOk ? '<span class="tagx">未加密</span>' : ""}
          <span class="small muted mono">${t.rateLimit}/hr${t.lastUsedAt ? " · 上次 " + fmtTime(t.lastUsedAt) : ""}</span>
        </div>`);
      const rv = el(`<button class="btn ghost inline" type="button" style="margin-left:auto">撤銷</button>`);
      rv.onclick = async () => {
        await api.revokeToken(t.tokenId).catch((err) => toast(err.message, true));
        paintTokens();
      };
      row.append(rv);
      $tok.append(row);
    }
    if (revokedCount) {
      $tok.append(el(`<p class="small muted" style="margin-top:6px">已撤銷 ${revokedCount} 個 token,不再顯示。</p>`));
    }
  }
  paintTokens().catch(() => {});
  root.querySelector("#tokPlain").onchange = (e) => {
    root.querySelector("#tokPlainWarn").hidden = !e.target.checked;
  };
  root.querySelector("#tokForm").onsubmit = async (e) => {
    e.preventDefault();
    const label = root.querySelector("#tokLabel").value.trim();
    const plain = root.querySelector("#tokPlain").checked;
    try {
      const res = await api.createToken(label, plain, 60);
      const usage = plain
        ? `curl -X POST ${esc(location.origin)}/api/push -H "Authorization: Bearer ${esc(res.token)}" -H "content-type: application/json" -d '{"text":"建置完成"}'`
        : `BENTODROP_URL=${esc(location.origin)} BENTODROP_TOKEN=${esc(res.token)} node cli/bentodrop-push.mjs "建置完成"(加密模式,見 repo 的 cli/)`;
      root.querySelector("#tokReveal").replaceChildren(el(`
        <div class="token-reveal">
          <b>只顯示這一次,現在就複製:</b><br>${esc(res.token)}<br>
          <span class="small muted">${usage}</span>
        </div>`));
      root.querySelector("#tokLabel").value = "";
      paintTokens();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ── boot ─────────────────────────────────────────────────────────────
async function boot() {
  // Landed here after a share-sheet send handled by the service worker.
  const shared = new URLSearchParams(location.search).get("shared");
  if (shared) {
    history.replaceState(null, "", "/");
    setTimeout(() => {
      toast(shared === "sent" ? "分享內容已加密送達 ✓" : "分享送出失敗,請直接在這裡送", shared !== "sent");
    }, 400);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { type: "module" }).catch((err) => {
      console.warn("SW registration failed", err);
    });
    navigator.serviceWorker.addEventListener("message", async (e) => {
      // notificationclick → open the message; the detail view carries the
      // real copy button (§7.2 — auto-copy without user activation is a lie)
      if (e.data?.t === "open-msg") {
        await refreshMessages().catch(() => {});
        renderInbox();
        const m = state.msgs.find((x) => x.msgId === e.data.msgId);
        if (m) openDetail(m);
      }
    });
  }

  const loggedIn = await loadIdentity();
  const pairMatch = /^\/p\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  const friendMatch = /^\/f\/([A-Za-z0-9_-]+)$/.exec(location.pathname);

  if (pairMatch) {
    // Joining is for NEW devices; an already-set-up device landing here is
    // probably a mis-tap — send it home.
    if (loggedIn) {
      history.replaceState(null, "", "/");
      renderInbox();
    } else {
      renderPairJoin(pairMatch[1]);
    }
    return;
  }
  if (friendMatch) {
    // Both sides of a friend link are real users — someone without an
    // account onboards first, then lands back in the claim flow (§6.7).
    if (loggedIn) renderFriendJoin(friendMatch[1]);
    else renderOnboarding(() => renderFriendJoin(friendMatch[1]));
    return;
  }
  if (!loggedIn) {
    renderOnboarding();
    return;
  }
  renderInbox();
  ensurePush(); // silent re-sync (§8.3 #3)
  ensureUserIdentity().catch(() => {}); // §5.2 — keeps CLI pubkey + friend flow ready
  window.addEventListener("focus", async () => {
    await refreshMessages().catch(() => {});
  });
}

boot();
