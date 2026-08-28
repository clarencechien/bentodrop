import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { generate } from "lean-qr";

/** Fresh context (own IndexedDB) with notification permission granted. */
export async function newDeviceContext(
  browser: Browser, baseURL: string, extraPermissions: string[] = [],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, permissions: ["notifications", ...extraPermissions] });
  const page = await context.newPage();
  return { context, page };
}

// ── minimal PNG writer (same approach as scripts/gen-icons.mjs) ──────
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Render `text` as a QR PNG buffer — simulates a saved recovery-QR photo. */
export function qrPngBuffer(text: string, scale = 8, quiet = 4): Buffer {
  const code = generate(text);
  const dim = (code.size + quiet * 2) * scale;
  const rgba = Buffer.alloc(dim * dim * 4, 255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          rgba[px] = 0;
          rgba[px + 1] = 0;
          rgba[px + 2] = 0;
        }
      }
    }
  }
  const raw = Buffer.alloc((dim * 4 + 1) * dim);
  for (let y = 0; y < dim; y++) {
    raw[y * (dim * 4 + 1)] = 0;
    rgba.copy(raw, y * (dim * 4 + 1) + 1, y * dim * 4, (y + 1) * dim * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Run the one-field onboarding (§6.5) and land in the inbox. */
export async function onboard(page: Page, name = "clarence"): Promise<void> {
  await page.goto("/");
  await page.getByRole("heading", { name: "你叫什麼名字?" }).waitFor();
  await page.locator("#obName").fill(name);
  await page.getByRole("button", { name: "開始" }).click();
  await expect(page.locator(".paste-dock")).toBeVisible();
}

export async function sendText(page: Page, text: string): Promise<void> {
  await page.locator("#composeText").fill(text);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(page.locator("#sendStatus")).toContainText(/已送達|已送給|✓/);
}

export async function refreshInbox(page: Page): Promise<void> {
  await page.getByRole("button", { name: "重新整理" }).click();
}
