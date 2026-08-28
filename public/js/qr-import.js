// Decode a QR code from a photo/screenshot (recovery-code import, §6.5.1).
// Native BarcodeDetector first; lazy-loaded jsQR (vendored, Apache-2.0) as
// the fallback so the 250KB decoder is only fetched when actually needed.

let jsqrLoading = null;
function loadJsQr() {
  if (globalThis.jsQR) return Promise.resolve();
  jsqrLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/js/vendor/jsQR.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("無法載入 QR 解碼器"));
    document.head.append(s);
  });
  return jsqrLoading;
}

async function bitmapToImageData(bitmap, maxEdge = 1600) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Returns the decoded string, or throws with a user-facing message. */
export async function decodeQrFromFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("無法讀取這張圖片");
  }
  try {
    if ("BarcodeDetector" in globalThis) {
      try {
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const codes = await detector.detect(bitmap);
        if (codes.length) return codes[0].rawValue;
      } catch {
        // fall through to jsQR
      }
    }
    await loadJsQr();
    const img = await bitmapToImageData(bitmap);
    const result = globalThis.jsQR(img.data, img.width, img.height);
    if (result?.data) return result.data;
    throw new Error("找不到 QR 碼,換一張更清晰的照片試試");
  } finally {
    bitmap.close?.();
  }
}
