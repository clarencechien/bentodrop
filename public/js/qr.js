// QR rendering for the pairing screen (§6.6).
// Encoding by vendored lean-qr (MIT); rendered as crisp inline SVG.
import { generate } from "./vendor/lean-qr.mjs";

/** Returns the QR matrix for `text`: { size, get(x, y) → boolean }. */
export function qrMatrix(text) {
  return generate(text);
}

/** Render `text` as an SVG element string (quiet zone included). */
export function qrSvg(text, { label = "配對 QR 碼" } = {}) {
  const code = generate(text);
  const q = 2; // quiet zone modules
  const dim = code.size + q * 2;
  let d = "";
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.get(x, y)) d += `M${x + q} ${y + q}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${dim}" height="${dim}" fill="#fff"/><path fill="#172A26" d="${d}"/></svg>`;
}
