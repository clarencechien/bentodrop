// Transport diagnostics (settings page). Produces a verdict, not just
// milliseconds: is the R2 bucket on the wrong continent? would P2P even
// help? is the bottleneck this phone's CPU?
//
// Measurement rules (per the handoff doc):
//  - every timing starts and ends on THIS device's clock — one-way cross-
//    device latency is never measured (clock skew makes it garbage)
//  - test payloads are crypto.getRandomValues bytes, so HTTP compression
//    cannot flatter the numbers
//  - per size: drop the first run (TLS/connection warmup), report the
//    MEDIAN of the rest, plus min–max so jitter is visible
//  - push delivery is NOT measured; the report says so explicitly

import { encryptFileEnvelope, decryptFileBody } from "./crypto.js";
import { compressImage } from "./image.js";
import { K, kvGet } from "./store.js";

const SIZES = [
  { label: "1 KB", bytes: 1024, runs: 5 },
  { label: "256 KB", bytes: 256 * 1024, runs: 3 },
  { label: "1 MB", bytes: 1024 * 1024, runs: 3 },
];

/** crypto.getRandomValues caps at 64 KB per call — fill larger buffers in chunks. */
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  }
  return out;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const r = (n) => Math.round(n);

async function authHeaders() {
  return { authorization: `Bearer ${await kvGet(K.DEVICE_TOKEN)}` };
}

async function apiJson(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(await authHeaders()), ...(opts.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/** 你→邊緣 RTT: 5 echo round trips of 1 KB, drop the first, median. */
async function measureEdgeRtt() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const body = randomBytes(1024);
    const t0 = performance.now();
    const res = await fetch("/api/diag/echo", { method: "POST", headers: await authHeaders(), body });
    await res.json();
    samples.push(performance.now() - t0);
  }
  return r(median(samples.slice(1)));
}

/** One full round for `bytes`: encrypt → sign → PUT → GET → decrypt+verify → delete. */
async function measureRound(kMaster, userId, bytes) {
  const data = randomBytes(bytes);
  const seg = {};

  let t = performance.now();
  const { envelope, ciphertext } = await encryptFileEnvelope(kMaster, userId, data, "diag.bin", "application/octet-stream");
  seg.encryptMs = performance.now() - t;

  t = performance.now();
  const urls = await apiJson("/api/diag/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sizeBytes: ciphertext.byteLength }),
  });
  seg.signMs = performance.now() - t;

  t = performance.now();
  const put = await fetch(urls.putUrl, { method: "PUT", body: ciphertext });
  if (!put.ok) throw new Error(`upload → ${put.status}`);
  seg.uploadMs = performance.now() - t;

  t = performance.now();
  const got = await fetch(urls.getUrl);
  if (!got.ok) throw new Error(`download → ${got.status}`);
  const cipherBack = new Uint8Array(await got.arrayBuffer());
  seg.downloadMs = performance.now() - t;

  t = performance.now();
  const plain = await decryptFileBody(kMaster, envelope, cipherBack);
  seg.decryptMs = performance.now() - t;
  // A fast broken pipeline is not a result — verify the bytes round-tripped.
  if (plain.byteLength !== data.byteLength || plain[0] !== data[0] || plain[plain.length - 1] !== data[data.length - 1]) {
    throw new Error("解密內容與原始不一致");
  }

  await apiJson("/api/diag/object", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: urls.key }),
  });

  seg.e2eMs = seg.encryptMs + seg.signMs + seg.uploadMs + seg.downloadMs + seg.decryptMs;
  return seg;
}

/** Image-compression cost: 4000×3000 canvas → long edge 2048 WebP. */
async function measureCompression() {
  const w = 4000;
  const h = 3000;
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // Noisy-enough content that WebP has real work to do.
  ctx.fillStyle = "#7a9c8f";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 71) % 256},${(i * 13) % 256})`;
    ctx.fillRect((i * 997) % w, (i * 641) % h, 120, 90);
  }
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise((res) => canvas.toBlob(res, "image/png"));
  const file = new File([blob], "probe.png", { type: "image/png" });

  const t0 = performance.now();
  await compressImage(file, {});
  return r(performance.now() - t0);
}

/**
 * Push-delivery probe (handoff §2.3, README 優化 #6): this device → push →
 * target device's SW → pong → push → back here. The whole loop is timed on
 * THIS device's clock; one-way delivery ≈ RTT / 2. Needs a second
 * subscribed device, and pops a couple of probe notifications on it.
 */
async function measurePushProbe(targetDeviceId, runs = 3) {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return { error: "此頁面尚未由 Service Worker 控制,重新整理後再試" };
  }
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const rtt = await new Promise((resolve) => {
      let probeId = null;
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", onMsg);
        resolve(v);
      };
      const onMsg = (ev) => {
        if (ev.data?.t === "probe-pong" && ev.data.probeId === probeId) finish(performance.now() - t0);
      };
      const timer = setTimeout(() => finish(null), 15000);
      navigator.serviceWorker.addEventListener("message", onMsg);
      const t0 = performance.now();
      apiJson("/api/diag/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetDeviceId }),
      }).then((res) => { probeId = res.probeId; }).catch(() => finish(null));
    });
    samples.push(rtt);
  }
  const ok = samples.filter((x) => x !== null);
  if (!ok.length) return { error: "探針逾時 — 對方裝置可能離線、通知被關閉,或它的 App 尚未重開到最新版(兩台都重開一次再試)" };
  return { rttMs: r(median(ok)), oneWayMs: r(median(ok) / 2), runs: ok.length, total: runs };
}

/**
 * Run the whole suite. onStep(label) is called as each stage starts;
 * onStepDone(label) when it finishes — the UI renders them as a checklist.
 */
export async function runDiagnostics(kMaster, userId, { onStep = () => {}, onStepDone = () => {}, probeTargetId = null } = {}) {
  const result = { startedAt: new Date().toISOString(), ua: navigator.userAgent, sizes: [] };

  onStep("伺服器環境(colo / R2 / D1)");
  result.env = await apiJson("/api/diag/env");
  onStepDone("伺服器環境(colo / R2 / D1)");

  onStep("你 → 邊緣節點 RTT");
  result.edgeRttMs = await measureEdgeRtt();
  onStepDone("你 → 邊緣節點 RTT");

  for (const size of SIZES) {
    const label = `傳輸 ${size.label}(${size.runs} 次)`;
    onStep(label);
    const rounds = [];
    for (let i = 0; i < size.runs; i++) {
      rounds.push(await measureRound(kMaster, userId, size.bytes));
    }
    const kept = rounds.slice(1); // drop warmup
    const med = (k) => r(median(kept.map((x) => x[k])));
    result.sizes.push({
      label: size.label,
      bytes: size.bytes,
      runs: size.runs,
      encryptMs: med("encryptMs"),
      signMs: med("signMs"),
      uploadMs: med("uploadMs"),
      downloadMs: med("downloadMs"),
      decryptMs: med("decryptMs"),
      e2eMs: med("e2eMs"),
      e2eMinMs: r(Math.min(...kept.map((x) => x.e2eMs))),
      e2eMaxMs: r(Math.max(...kept.map((x) => x.e2eMs))),
    });
    onStepDone(label);
  }

  onStep("圖片壓縮(4000×3000 → 2048 WebP)");
  try {
    result.compressMs = await measureCompression();
  } catch {
    result.compressMs = null; // 標「未測量」,不要補一個看起來合理的數字
  }
  onStepDone("圖片壓縮(4000×3000 → 2048 WebP)");

  if (probeTargetId) {
    onStep("推送探針(3 次往返,對方會跳通知)");
    result.pushProbe = await measurePushProbe(probeTargetId);
    onStepDone("推送探針(3 次往返,對方會跳通知)");
  }

  result.conclusions = buildConclusions(result);
  return result;
}

/** Hard-coded judgment rules from the handoff doc — verdicts, not vibes. */
export function buildConclusions(result) {
  const out = [];
  const mb = result.sizes.find((s) => s.label === "1 MB");

  if (result.env.r2.getMs > 100) {
    out.push({ level: "warn", text: "R2 bucket 可能不在亞太。這是最該先處理的事 — 換 bucket 位置比任何傳輸最佳化都有效。" });
  } else {
    out.push({ level: "ok", text: `邊緣節點 → R2 只要 ${result.env.r2.getMs} ms,bucket 位置沒問題。` });
  }

  if (mb) {
    const sec = (mb.e2eMs / 1000).toFixed(1);
    if (mb.e2eMs < 1500) {
      out.push({ level: "ok", text: `1 MB 照片端到端約 ${sec} 秒。同網段直傳最多再省不到 0.5 秒,不值得為此做 P2P。` });
    } else if (mb.e2eMs > 4000) {
      out.push({ level: "warn", text: `1 MB 端到端要 ${sec} 秒,值得進一步查。先確認 R2 位置與上傳頻寬,再考慮傳輸協定。` });
    } else {
      out.push({ level: "info", text: `1 MB 照片端到端約 ${sec} 秒 — 可用,但還有優化空間。先看 R2 與頻寬,再談協定。` });
    }
    if (mb.downloadMs > mb.uploadMs * 2) {
      out.push({ level: "info", text: "下載明顯比上傳慢,預取(推送一到就在背景抓)會比改傳輸協定有效。" });
    }
  }

  if (result.compressMs !== null && result.compressMs > 300) {
    out.push({ level: "warn", text: `圖片壓縮要 ${result.compressMs} ms,比傳輸還慢。瓶頸在這台裝置的 CPU,不在網路 — 換傳輸協定不會有幫助。` });
  }

  return out;
}

/** Plain-text report for pasting into an issue. */
export function formatReport(result) {
  const lines = [
    "BentoDrop 傳輸診斷報告",
    `時間: ${result.startedAt}`,
    `UA: ${result.ua}`,
    `邊緣節點: ${result.env.colo ?? "未知"}(${result.env.country ?? "?"})`,
    "",
    "結論:",
    ...result.conclusions.map((c) => `${c.level === "warn" ? "⚠" : c.level === "ok" ? "✓" : "·"} ${c.text}`),
    "",
    "數據(中位數,首次連線暖機已剔除):",
    `你 → 邊緣節點 RTT: ${result.edgeRttMs} ms`,
    `邊緣節點 → R2: HEAD ${result.env.r2.headMs} ms / GET ${result.env.r2.getMs} ms / PUT ${result.env.r2.putMs} ms`,
    `D1: ${result.env.d1Ms} ms · Worker 內部: ${result.env.workerTimeMs} ms`,
  ];
  for (const s of result.sizes) {
    lines.push(
      `${s.label}: 端到端 ${s.e2eMs} ms(${s.e2eMinMs}–${s.e2eMaxMs})` +
      ` = 加密 ${s.encryptMs} + 簽名 ${s.signMs} + 上傳 ${s.uploadMs} + 下載 ${s.downloadMs} + 解密 ${s.decryptMs}`,
    );
  }
  lines.push(`圖片壓縮(4000×3000 → 2048 WebP): ${result.compressMs === null ? "未測量" : `${result.compressMs} ms`}`);
  if (result.pushProbe && !result.pushProbe.error) {
    lines.push(`推送往返(本機→對方→本機): ${result.pushProbe.rttMs} ms → 單程送達估計 ~${result.pushProbe.oneWayMs} ms(${result.pushProbe.runs}/${result.pushProbe.total} 次成功,中位數)`);
  } else if (result.pushProbe?.error) {
    lines.push(`推送送達時間: 測量失敗 — ${result.pushProbe.error}`);
  } else {
    lines.push("推送送達時間: 未測量(需第二台已訂閱推送的裝置)");
  }
  return lines.join("\n");
}
