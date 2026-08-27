// QR pairing display: encode with the shipped module, decode with an
// independent decoder (jsQR) to prove a phone camera can actually read it.
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
// @ts-expect-error plain JS module without types
import { qrMatrix, qrSvg } from "../public/js/qr.js";

/** Rasterize a QR matrix to RGBA pixels the way a camera would see it. */
function rasterize(code: { size: number; get(x: number, y: number): boolean }, scale = 8, quiet = 4) {
  const dim = (code.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx;
          rgba[px * 4] = 0;
          rgba[px * 4 + 1] = 0;
          rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { rgba, dim };
}

describe("pairing QR (§6.6)", () => {
  it("round-trips the join URL + fragment code through an independent decoder", () => {
    const url = "https://bentodrop.ai-apps.work/p/01K3MA6X9Q2Z8R4T7V1W5Y3B2C#c=472916";
    const { rgba, dim } = rasterize(qrMatrix(url));
    const decoded = jsQR(rgba, dim, dim);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(url);
  });

  it("the fragment code never reaches the server (URL anatomy)", () => {
    const u = new URL("https://x.test/p/PAIRID#c=123456");
    // Fragments are stripped by the browser before the request is sent —
    // `pathname + search` is all a server ever sees.
    expect(u.pathname + u.search).toBe("/p/PAIRID");
    expect(u.hash).toBe("#c=123456");
  });

  it("renders crisp SVG with a quiet zone", () => {
    const svg = qrSvg("https://example.com/p/x#c=000000");
    expect(svg).toContain("<svg");
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#172A26"');
    const dim = Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
    expect(dim).toBeGreaterThan(21); // matrix + quiet zone
  });
});
