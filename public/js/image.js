// Client-side image compression (§4.4) — canvas-based, no dependency.
// Compression happens BEFORE encryption (ciphertext doesn't compress).
// createImageBitmap(..., { imageOrientation: "from-image" }) bakes EXIF
// orientation into the pixels; the canvas redraw then strips all EXIF,
// GPS included. HEIC / undecodable images fall back to raw upload (§4.4).

const TARGET_BYTES = 1.5 * 1024 * 1024; // maxSizeMB 1.5
const MAX_EDGE = 2048;                  // 長邊 2048
const INITIAL_QUALITY = 0.82;

export function isImage(file) {
  return /^image\//.test(file.type);
}

export function isHeic(file) {
  return /image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * Returns { bytes, name, mime, compressed } — compressed=false means the
 * caller must apply the raw-file EXIF/GPS warning path (§4.4 原檔模式).
 */
export async function compressImage(file, { original = false } = {}) {
  const rawBytes = async () => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
    mime: file.type || "application/octet-stream",
    compressed: false,
  });

  if (original || !isImage(file) || isHeic(file)) return rawBytes();

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Browser can't decode (e.g. HEIC with a lying MIME type) → raw upload.
    return rawBytes();
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const toBlob = (quality) =>
    canvas.convertToBlob
      ? canvas.convertToBlob({ type: "image/webp", quality })
      : new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));

  // Iterate quality down until under the target size.
  let quality = INITIAL_QUALITY;
  let blob = await toBlob(quality);
  while (blob.size > TARGET_BYTES && quality > 0.4) {
    quality -= 0.12;
    blob = await toBlob(quality);
  }

  const name = file.name.replace(/\.[^.]+$/, "") + ".webp";
  return { bytes: new Uint8Array(await blob.arrayBuffer()), name, mime: "image/webp", compressed: true };
}
