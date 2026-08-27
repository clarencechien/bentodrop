// BentoDrop PWA — single-page app.
import * as C from "./crypto.js";
import { api, ApiError } from "./api.js";
import { K, kvDelete, kvGet, kvSet } from "./store.js";
import { compressImage, isHeic, isImage } from "./image.js";

const $app = document.getElementById("app");
const $nav = document.getElementById("topNav");
const $toast = document.getElementById("toast");

const state = {
  kMaster: null,
  userId: null,
  deviceId: null,
  label: null,
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
function renderOnboarding() {
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
      renderInbox();
      ensurePush({ interactive: true });
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };
  document.getElementById("obJoin").onclick = () => renderPairJoin(null);
  document.getElementById("obRestore").onclick = () => renderRestore();
}

async function onboardNewUser(userName, entropy = C.generateEntropy()) {
  // §6.5: keys, registration, push — all in the background, one visible field.
  const kMaster = await C.deriveKmaster(entropy, userName);
  const identity = await C.generateEcdhPair();
  const label = guessLabel();
  const reg = await api.register(label, identity.publicJwk);
  await saveIdentity({
    entropy, userName,
    userId: reg.userId, deviceId: reg.deviceId, deviceToken: reg.deviceToken,
    label, vapidPublicKey: reg.vapidPublicKey,
  });
  // Identity private key at rest is wrapped by K_master (§5.2).
  const priv = await crypto.subtle.exportKey("jwk", identity.privateKey).catch(() => null);
  if (priv) await kvSet("identityPrivWrapped", await C.encryptJson(kMaster, priv));
  state.kMaster = kMaster;
  state.userId = reg.userId;
  state.deviceId = reg.deviceId;
  state.label = label;
}

// ── inbox ─────────────────────────────────────────────────────────────
async function decryptPreview(m) {
  if (state.decrypted.has(m.msgId)) return state.decrypted.get(m.msgId);
  let out;
  try {
    if (m.kind === "text") {
      out = { text: await C.decryptTextEnvelope(state.kMaster, m.envelope) };
    } else {
      out = { meta: await C.decryptFileMeta(state.kMaster, m.envelope) };
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
  return messages;
}

function renderInbox() {
  setNav(true);
  const root = el(`
    <div>
      <div class="paste-dock">
        <p class="big">貼上就送</p>
        <p class="small muted">送到你的全部裝置,內容在這台裝置上加密後才出門。</p>
        <textarea id="composeText" placeholder="輸入或貼上文字、連結…" maxlength="100000"></textarea>
        <div class="file-row">
          <button class="btn inline" id="sendBtn" type="button">送到我的全部裝置</button>
          <label class="btn ghost inline" style="margin:0">
            選圖片 / 檔案<input id="fileInput" type="file" hidden>
          </label>
          <label class="small muted" style="display:flex;align-items:center;gap:5px">
            <input type="checkbox" id="origMode">原檔(保留 EXIF/GPS)
          </label>
        </div>
        <div id="sendStatus"></div>
      </div>
      <div class="inbox-head"><b>收件匣</b><span class="cnt" id="unreadCnt" hidden></span>
        <button class="btn ghost inline" id="refreshBtn" type="button" style="margin-left:auto">重新整理</button>
      </div>
      <div id="msgList"></div>
    </div>`);
  $app.replaceChildren(root);

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

  // send text
  root.querySelector("#sendBtn").onclick = async () => {
    const $t = root.querySelector("#composeText");
    const text = $t.value.trim();
    if (!text) return toast("先輸入一點內容", true);
    const $status = root.querySelector("#sendStatus");
    $status.replaceChildren(el(`<ul class="receipts"><li><b>…</b> 送出中</li></ul>`));
    try {
      const envelope = await C.encryptTextEnvelope(state.kMaster, text);
      const res = await api.send(envelope);
      $t.value = "";
      showReceipts($status, res.receipts);
      await refreshMessages().catch(() => {});
      paint();
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">送出失敗:${esc(err.message)}</div>`));
    }
  };

  // send file (§3.2 + §4.4)
  root.querySelector("#fileInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return toast("上限 20 MB", true);
    const original = root.querySelector("#origMode").checked;
    const $status = root.querySelector("#sendStatus");
    if (original && isImage(file)) {
      toast("原檔模式:EXIF 與 GPS 位置會完整保留", true);
    }
    $status.replaceChildren(el(`<ul class="receipts"><li><b>…</b> 處理中</li></ul>`));
    try {
      const prepared = await compressImage(file, { original });
      if (!prepared.compressed && isImage(file) && !original) {
        toast(isHeic(file) ? "這張圖無法在瀏覽器中壓縮,將以原檔傳送(含 EXIF)" : "無法壓縮,以原檔傳送(含 EXIF)", true);
      }
      const { envelope, ciphertext } = await C.encryptFileEnvelope(
        state.kMaster, state.userId, prepared.bytes, prepared.name, prepared.mime,
      );
      const up = await api.uploadUrl(envelope.id, ciphertext.byteLength);
      await api.putObject(up.url, ciphertext);
      const res = await api.send(envelope);
      showReceipts($status, res.receipts);
      await refreshMessages().catch(() => {});
      paint();
    } catch (err) {
      $status.replaceChildren(el(`<div class="banner err">送出失敗:${esc(err.message)}</div>`));
    }
  };

  refreshMessages().then(paint).catch(() => {
    $list.replaceChildren(el(`<div class="banner err">連不上伺服器,稍後再試。</div>`));
  });

  // §6.5: gentle backup nudge after the first file / on multi-device (checked in pairing flow)
}

function showReceipts($status, receipts) {
  if (!receipts?.length) {
    $status.replaceChildren(el(`<p class="btn-note">已送達(目前沒有其他裝置訂閱推送)</p>`));
    return;
  }
  const ul = el(`<ul class="receipts"></ul>`);
  for (const r of receipts) {
    ul.append(el(`<li class="${r.ok ? "" : "fail"}"><b>${r.ok ? "✓" : "✕"}</b> ${esc(r.label ?? r.deviceId.slice(0, 6))}${r.ok ? "" : ` · 失敗(${r.status})`}</li>`));
  }
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
      const dl = el(`<button class="btn inline" type="button" style="margin-top:12px">下載並解密</button>`);
      const slot = el(`<div></div>`);
      dl.onclick = async () => {
        dl.disabled = true;
        dl.textContent = "下載中…";
        try {
          const { url } = await api.downloadUrl(m.envelope.obj);
          const cipher = await api.getObject(url);
          const plain = await C.decryptFileBody(state.kMaster, m.envelope, cipher);
          const blob = new Blob([plain], { type: d.meta.mime });
          const objUrl = URL.createObjectURL(blob);
          if (/^image\//.test(d.meta.mime)) {
            slot.append(el(`<img class="detail-img" alt="${esc(d.meta.name)}" src="${objUrl}">`));
          }
          const a = el(`<a class="btn inline" style="text-decoration:none;margin-top:10px" download="${esc(d.meta.name)}" href="${objUrl}">儲存檔案</a>`);
          slot.append(a);
          dl.remove();
        } catch (err) {
          dl.disabled = false;
          dl.textContent = "下載並解密";
          toast(err.message, true);
        }
      };
      box.append(dl, slot);
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
  $body.replaceChildren(el(`
    <div>
      <p class="pairurl">${esc(joinUrl)}</p>
      <p class="paircode">${esc(pair.code.split("").join(" "))}</p>
      <p class="pairmeta">5 分鐘後失效 · 錯 3 次作廢 · 只能用一次</p>
      <div class="timer"><i id="pairTimer" style="width:100%"></i></div>
      <button class="btn ghost" id="copyJoin" type="button">複製網址</button>
      <div id="pairWait"><p class="btn-note">等待另一台裝置加入…</p></div>
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
        <button class="btn" type="submit">加入</button>
      </form>
      <div id="joinStatus"></div>
      <button class="btn ghost" id="jnBack" type="button">返回</button>
    </div>`);
  $app.replaceChildren(root);
  root.querySelector("#jnBack").onclick = () => location.assign("/");

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
      const label = guessLabel();
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
      <div class="save-opts">
        <button class="save-opt pri" id="svCopy" type="button">複製</button>
        <button class="save-opt" id="svDl" type="button">下載</button>
        <button class="save-opt" id="svPrint" type="button">列印</button>
        <button class="save-opt" id="svHand" type="button">已手抄</button>
      </div>
      <p class="btn-note">複製:貼進密碼管理器,貼完清空剪貼簿 · 下載:檔案會留在下載資料夾 · 列印:印表機可能有快取</p>
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
        </div>
        <div id="pushResult"></div>
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
        <h3>清空與重設</h3>
        <div class="row">
          <button class="btn ghost inline" id="stClearMsgs" type="button">清空收件匣(所有裝置)</button>
          <button class="btn danger inline" id="stReset" type="button">重設這台裝置</button>
        </div>
      </div>

      <button class="btn ghost" id="stBack" type="button">回收件匣</button>
    </div>`);
  $app.replaceChildren(root);

  // devices (§8.4)
  const $dev = root.querySelector("#devList");
  for (const d of me.devices) {
    const row = el(`
      <div class="dev-row">
        <span class="lab">${esc(d.label ?? "裝置")}${d.isSelf ? "(這台)" : ""}</span>
        <span class="meta">${d.lastSeenAt ? "最近活動 " + fmtTime(d.lastSeenAt) : "未曾連線"}${d.subscribed ? "" : " · 未訂閱推送"}</span>
        ${d.maybeDead ? '<span class="dead">可能已失效</span>' : ""}
        <span class="spacer"></span>
      </div>`);
    if (!d.isSelf) {
      const rm = el(`<button class="btn ghost inline" type="button">移除</button>`);
      rm.onclick = async () => {
        if (!confirm(`移除「${d.label ?? d.deviceId}」?它將無法再收發。`)) return;
        await api.deleteDevice(d.deviceId).catch((err) => toast(err.message, true));
        renderSettings();
      };
      row.append(rm);
    }
    $dev.append(row);
  }

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
  root.querySelector("#stPreview").onchange = async (e) => {
    await kvSet(K.NOTIFY_PREVIEW, e.target.checked); // read by sw.js (§6.3)
  };
  root.querySelector("#stRetention").onchange = async (e) => {
    await api.settings(Number(e.target.value)).catch((err) => toast(err.message, true));
    toast("已更新保留期");
  };
  root.querySelector("#stBackup").onclick = () => renderBackup();
  root.querySelector("#stClearMsgs").onclick = async () => {
    if (!confirm("清空所有訊息?所有裝置都會消失,已下載到本機的副本不受影響。")) return;
    await api.clearMessages().catch((err) => toast(err.message, true));
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
    if (!tokens.length) $tok.append(el(`<p class="small muted">還沒有 token。</p>`));
    for (const t of tokens) {
      const row = el(`
        <div class="tok-row">
          <b>${esc(t.label)}</b>
          ${t.plaintextOk ? '<span class="tagx">未加密</span>' : ""}
          <span class="small muted mono">${t.rateLimit}/hr${t.lastUsedAt ? " · 上次 " + fmtTime(t.lastUsedAt) : ""}</span>
          ${t.revokedAt ? '<span class="small muted">已撤銷</span>' : ""}
        </div>`);
      if (!t.revokedAt) {
        const rv = el(`<button class="btn ghost inline" type="button" style="margin-left:auto">撤銷</button>`);
        rv.onclick = async () => {
          await api.revokeToken(t.tokenId).catch((err) => toast(err.message, true));
          paintTokens();
        };
        row.append(rv);
      }
      $tok.append(row);
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
      root.querySelector("#tokReveal").replaceChildren(el(`
        <div class="token-reveal">
          <b>只顯示這一次,現在就複製:</b><br>${esc(res.token)}<br>
          <span class="small muted">curl -X POST ${esc(location.origin)}/api/push -H "Authorization: Bearer ${esc(res.token)}" -H "content-type: application/json" -d '{"text":"建置完成"}'</span>
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { type: "module" }).catch((err) => {
      console.warn("SW registration failed", err);
    });
    navigator.serviceWorker.addEventListener("message", async (e) => {
      // notificationclick → open the message; attempt clipboard, always show UI (§7.2)
      if (e.data?.t === "open-msg") {
        await refreshMessages().catch(() => {});
        renderInbox();
        const m = state.msgs.find((x) => x.msgId === e.data.msgId);
        if (m) {
          openDetail(m);
          if (e.data.copy && m.kind === "text") {
            const d = await decryptPreview(m);
            if (d.text !== undefined) copyText(d.text);
          }
        }
      }
    });
  }

  const loggedIn = await loadIdentity();
  const pairMatch = /^\/p\/([A-Za-z0-9_-]+)$/.exec(location.pathname);

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
  if (!loggedIn) {
    renderOnboarding();
    return;
  }
  renderInbox();
  ensurePush(); // silent re-sync (§8.3 #3)
  window.addEventListener("focus", async () => {
    await refreshMessages().catch(() => {});
  });
}

boot();
