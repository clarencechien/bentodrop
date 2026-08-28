// E2E: real browser, real PWA, real Worker (wrangler dev + local D1/R2).
// Web Push itself is exercised in the workerd integration suite — headless
// browsers have no push service — everything else here is the real thing.
import { expect, test } from "@playwright/test";
import { newDeviceContext, onboard, qrPngBuffer, refreshInbox, sendText } from "./helpers";

test("onboarding: one field, straight into the inbox", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page, "clarence");
  await expect(page.getByText("還沒有便當")).toBeVisible();

  // Identity survives a reload (IndexedDB, §6.8).
  await page.reload();
  await expect(page.locator(".paste-dock")).toBeVisible();
  await context.close();
});

test("send text to self: encrypt → store → pull → decrypt → copy UI", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);
  const text = "下午三點的會議改到會議室 B,記得帶那份合約。";
  await sendText(page, text);
  await refreshInbox(page);

  const card = page.locator(".mini").first();
  await expect(card).toContainText("下午三點的會議改到會議室 B");
  await card.click();

  // Detail modal: decrypted body + a manual copy button (§7.2: never rely on auto-copy).
  const modal = page.locator(".modal");
  await expect(modal.locator(".detail-body")).toHaveText(text);
  await expect(modal.getByRole("button", { name: "複製" })).toBeVisible();
  await context.close();
});

test("https URL gets an open action; never auto-navigates (§7.2.1)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);
  await sendText(page, "https://example.com/spec");
  await refreshInbox(page);
  await page.locator(".mini").first().click();

  const modal = page.locator(".modal");
  const open = modal.getByRole("link", { name: "開啟連結" });
  await expect(open).toHaveAttribute("href", "https://example.com/spec");
  await expect(open).toHaveAttribute("rel", /noopener/);
  // We are still on the app page — no auto navigation happened.
  expect(new URL(page.url()).pathname).toBe("/");
  await context.close();
});

test("javascript: URL is treated as plain text (whitelist)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);
  await sendText(page, "javascript:alert(1)");
  await refreshInbox(page);
  await page.locator(".mini").first().click();
  const modal = page.locator(".modal");
  await expect(modal.getByRole("link", { name: "開啟連結" })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "複製" })).toBeVisible();
  await context.close();
});

test("delete removes the message everywhere (§10.1)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);
  await sendText(page, "to be deleted");
  await refreshInbox(page);
  await page.locator(".mini").first().click();
  await page.getByRole("button", { name: "刪除(所有裝置)" }).click();
  await expect(page.getByText("還沒有便當")).toBeVisible();
  await context.close();
});

test("file send: encrypt+upload, then download+decrypt (§3.2)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);

  await page.locator("#fileInput").setInputFiles({
    name: "秘密筆記.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("機密內容:momo 是一隻貓。"),
  });
  await expect(page.locator("#sendStatus")).toContainText(/已送達|✓/);
  await refreshInbox(page);

  const card = page.locator(".mini.img").first();
  await expect(card).toContainText("秘密筆記.txt"); // decrypted meta (§5.3)
  await card.click();

  const modal = page.locator(".modal");
  await modal.getByRole("button", { name: "下載並解密" }).click();
  await expect(modal.getByRole("link", { name: "儲存檔案" })).toBeVisible();
  await context.close();
});

test("pairing (§6.6): QR-less URL+code flow moves K_master to a second device", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const a = await newDeviceContext(browser, baseURL!);
  await onboard(a.page, "clarence");

  // Old device creates the pairing: QR + URL + code all shown.
  await a.page.getByRole("button", { name: "加裝置" }).click();
  await expect(a.page.locator(".paircode")).toBeVisible();
  await expect(a.page.locator(".qr svg")).toBeVisible();
  const joinUrl = (await a.page.locator(".pairurl").innerText()).trim();
  const code = (await a.page.locator(".paircode").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);
  await expect(a.page.getByText("5 分鐘後失效 · 錯 3 次作廢 · 只能用一次")).toBeVisible();

  // New device arrives via the QR URL — the fragment pre-fills the code,
  // and the device alias is editable before joining.
  const b = await newDeviceContext(browser, baseURL!);
  await b.page.goto(`${joinUrl}#c=${code}`);
  await expect(b.page.locator("#jnCode")).toHaveValue(code);
  await b.page.locator("#jnLabel").fill("工作筆電");
  await b.page.getByRole("button", { name: "加入" }).click();

  // Old device must explicitly confirm, and sees the chosen alias (§6.6).
  await expect(a.page.getByText("要求配對")).toBeVisible({ timeout: 20_000 });
  await expect(a.page.getByText("工作筆電")).toBeVisible();
  await a.page.getByRole("button", { name: "確認配對" }).click();

  // New device lands in the inbox with a working K_master.
  await expect(b.page.locator(".paste-dock")).toBeVisible({ timeout: 20_000 });

  // §6.5: after the second device, the old device gets a backup nudge.
  await expect(a.page.getByText("你現在有兩台裝置了")).toBeVisible({ timeout: 10_000 });
  await a.page.getByRole("button", { name: "備份還原碼" }).click();
  await expect(a.page.locator(".word")).toHaveCount(12);

  // Cross-device decryption: B sends, A pulls and reads plaintext — the
  // sender shows up under its chosen alias.
  const secret = `配對後的悄悄話 ${Date.now()}`;
  await sendText(b.page, secret);
  await a.page.goto("/");
  await refreshInbox(a.page);
  const received = a.page.locator(".mini").first();
  await expect(received).toContainText("配對後的悄悄話");
  await expect(received).toContainText("工作筆電");

  await a.context.close();
  await b.context.close();
});

test("friends (§11): invite → claim → approve → cross-user encrypted send", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const a = await newDeviceContext(browser, baseURL!);
  await onboard(a.page, "ming");
  const b = await newDeviceContext(browser, baseURL!);
  await onboard(b.page, "mei");

  // A invites.
  await a.page.getByRole("button", { name: "設定" }).click();
  await a.page.getByRole("button", { name: "邀請好友" }).click();
  await a.page.getByRole("button", { name: "建立邀請" }).click();
  await expect(a.page.locator(".paircode")).toBeVisible();
  await expect(a.page.locator(".qr svg")).toBeVisible();
  const joinUrl = (await a.page.locator(".pairurl").innerText()).trim();
  const code = (await a.page.locator(".paircode").innerText()).replace(/\s/g, "");

  // B opens the QR link — logged in, so it goes straight to the claim form.
  await b.page.goto(`${joinUrl}#c=${code}`);
  await expect(b.page.locator("#fjCode")).toHaveValue(code);
  await b.page.locator("#fjName").fill("小美");
  await b.page.getByRole("button", { name: "加入" }).click();

  // A must explicitly approve, and can pick a label.
  await expect(a.page.getByText("要求成為好友")).toBeVisible({ timeout: 20_000 });
  await expect(a.page.locator("#fiLabel")).toHaveValue("小美");
  await a.page.getByRole("button", { name: "確認加好友" }).click();
  await expect(a.page.locator(".dev-row", { hasText: "小美" })).toBeVisible({ timeout: 10_000 });

  // B lands back in the inbox once the friendship exists.
  await expect(b.page.locator(".paste-dock")).toBeVisible({ timeout: 20_000 });

  // B sends to the friend — encrypted against A's identity key.
  const secret = `給朋友的悄悄話 ${Date.now()}`;
  await b.page.locator("#sendTarget").selectOption({ label: "給 ming" });
  await b.page.locator("#composeText").fill(secret);
  await b.page.getByRole("button", { name: "送出" }).click();
  await expect(b.page.locator("#sendStatus")).toContainText(/已送給|✓/);

  // A receives it under the 好友 tag with the chosen label, decrypted.
  await a.page.goto("/");
  await refreshInbox(a.page);
  const card = a.page.locator(".mini", { hasText: "給朋友的悄悄話" });
  await expect(card).toBeVisible();
  await expect(card.locator(".tagf")).toHaveText("好友");
  await expect(card).toContainText("小美");
  await card.click();
  await expect(a.page.locator(".modal .detail-body")).toHaveText(secret);

  await a.context.close();
  await b.context.close();
});

test("clipboard composer: grayed preview + 即送; typing flips to 送出; preview click edits", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!, ["clipboard-read", "clipboard-write"]);
  await onboard(page, "paster");

  // Clipboard has text → preview shows it grayed, the single button is 即送.
  await page.evaluate(() => navigator.clipboard.writeText("剪貼簿直送測試"));
  await page.reload();
  await expect(page.locator("#clipPreview")).toBeVisible();
  await expect(page.locator("#clipPreview")).toContainText("剪貼簿直送測試");
  await expect(page.locator("#sendBtn")).toContainText("即送");
  await page.locator("#sendBtn").click();
  await expect(page.locator("#sendStatus")).toContainText(/已送達|✓/);
  await expect(page.locator("#clipPreview")).toBeHidden(); // just-sent content isn't re-offered
  await refreshInbox(page);
  await expect(page.locator(".mini", { hasText: "剪貼簿直送測試" })).toBeVisible();

  // Typing overrides the clipboard state — the button becomes 送出.
  await page.locator("#composeText").fill("手動輸入的內容");
  await expect(page.locator("#sendBtn")).toHaveText("送出");
  await page.locator("#sendBtn").click();
  await expect(page.locator("#sendStatus")).toContainText(/已送達|✓/);

  // Clicking the preview moves the text into the composer for editing.
  await page.evaluate(() => navigator.clipboard.writeText("先別送出這段"));
  await page.reload();
  await expect(page.locator("#clipPreview")).toBeVisible();
  await page.locator("#clipPreview").click();
  await expect(page.locator("#composeText")).toHaveValue("先別送出這段");
  await expect(page.locator("#sendBtn")).toHaveText("送出");
  await context.close();
});

test("clipboard composer: image clipboard shows a thumbnail and 即送 sends it as a file", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!, ["clipboard-read", "clipboard-write"]);
  await onboard(page, "imgpaster");

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#00C2A8";
    ctx.fillRect(0, 0, 48, 48);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.reload();
  await expect(page.locator("#clipPreview img")).toBeVisible();
  await expect(page.locator("#sendBtn")).toContainText("即送");
  await page.locator("#sendBtn").click();
  await expect(page.locator("#sendStatus")).toContainText(/已送達|✓/);
  await refreshInbox(page);
  await expect(page.locator(".mini.img", { hasText: "clipboard" })).toBeVisible();
  await context.close();
});

test("recovery QR: export from backup, import a photo on restore (§6.5.1)", async ({ browser, baseURL }) => {
  // Device 1: back up and read the words + open the QR view.
  const a = await newDeviceContext(browser, baseURL!);
  await onboard(a.page, "qruser");
  await a.page.getByRole("button", { name: "設定" }).click();
  await a.page.getByRole("button", { name: "備份還原碼" }).click();
  const words = (await a.page.locator(".word").allInnerTexts()).map((w) => w.replace(/^\d+/, "").trim());
  await a.page.getByRole("button", { name: "QR", exact: true }).click();
  await expect(a.page.locator(".modal .qr svg")).toBeVisible();
  await a.context.close();

  // Device 2: restore by "photographing" that QR (same payload, rendered to PNG).
  const b = await newDeviceContext(browser, baseURL!);
  await b.page.goto("/");
  await b.page.getByRole("button", { name: "用還原碼還原" }).click();
  await b.page.locator("#rsName").fill("qruser");
  await b.page.locator("#rsQrFile").setInputFiles({
    name: "recovery-qr.png",
    mimeType: "image/png",
    buffer: qrPngBuffer(words.join(" ")),
  });
  const inputs = b.page.locator("#rsGrid input");
  await expect(inputs.first()).toHaveValue(words[0]);
  await expect(inputs.last()).toHaveValue(words[11]);
  await b.page.getByRole("button", { name: "還原" }).click();
  await expect(b.page.locator(".paste-dock")).toBeVisible();
  await b.context.close();
});

test("share target: the SW encrypts and sends shared text and images headlessly", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page, "sharer");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // ensure the page is SW-controlled so fetch() hits the handler

  // Text + URL share (what Android posts to /share-target).
  const textResult = await page.evaluate(async () => {
    const fd = new FormData();
    fd.set("title", "");
    fd.set("text", "分享來的文章");
    fd.set("url", "https://example.com/shared-article");
    const res = await fetch("/share-target", { method: "POST", body: fd });
    return res.url;
  });
  expect(textResult).toContain("shared=sent");

  // Image share.
  const imgResult = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#E0483A";
    ctx.fillRect(0, 0, 32, 32);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
    const fd = new FormData();
    fd.append("media", new File([blob], "shared-photo.png", { type: "image/png" }));
    const res = await fetch("/share-target", { method: "POST", body: fd });
    return res.url;
  });
  expect(imgResult).toContain("shared=sent");

  await refreshInbox(page);
  const textCard = page.locator(".mini", { hasText: "分享來的文章" });
  await expect(textCard).toBeVisible();
  await expect(textCard).toContainText("example.com/shared-article");
  await expect(page.locator(".mini.img", { hasText: "shared-photo" })).toBeVisible();

  // An empty share fails gracefully.
  const emptyResult = await page.evaluate(async () => {
    const res = await fetch("/share-target", { method: "POST", body: new FormData() });
    return res.url;
  });
  expect(emptyResult).toContain("shared=fail");
  await context.close();
});

test("device rename: current device and peers, from settings", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page, "renamer");
  await page.getByRole("button", { name: "設定" }).click();

  page.once("dialog", (d) => d.accept("我的桌機"));
  await page.locator(".dev-row").first().getByRole("button", { name: "改名" }).click();
  await expect(page.locator(".dev-row").first()).toContainText("我的桌機(這台)");
  await context.close();
});

test("backup verify: 3 sampled words gate the done state (§6.5.1)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page);
  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("button", { name: "備份還原碼" }).click();
  await expect(page.locator(".word")).toHaveCount(12);
  const words = await page.locator(".word").allInnerTexts();
  const cleaned = words.map((w) => w.replace(/^\d+/, "").trim());

  await page.getByRole("button", { name: "存好了,抽 3 個字驗證" }).click();
  const inputs = page.locator(".modal input");
  await expect(inputs).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const idx = Number(await inputs.nth(i).getAttribute("data-idx"));
    await inputs.nth(i).fill(cleaned[idx]);
  }
  await page.locator(".modal").getByRole("button", { name: "驗證" }).click();
  await expect(page.locator(".paste-dock")).toBeVisible();

  // Settings no longer nags about backup.
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByRole("button", { name: "重新顯示還原碼" })).toBeVisible();
  await context.close();
});

test("restore from the 12 words re-derives the same key material", async ({ browser, baseURL }) => {
  // Device 1: onboard, read the words.
  const a = await newDeviceContext(browser, baseURL!);
  await onboard(a.page, "restorer");
  await a.page.getByRole("button", { name: "設定" }).click();
  await a.page.getByRole("button", { name: "備份還原碼" }).click();
  const words = (await a.page.locator(".word").allInnerTexts()).map((w) => w.replace(/^\d+/, "").trim());
  await a.context.close();

  // Device 2: restore with the words — a wrong word is rejected by checksum.
  const b = await newDeviceContext(browser, baseURL!);
  await b.page.goto("/");
  await b.page.getByRole("button", { name: "用還原碼還原" }).click();
  await b.page.locator("#rsName").fill("restorer");
  const inputs = b.page.locator("#rsGrid input");
  for (let i = 0; i < 12; i++) await inputs.nth(i).fill(words[i]);
  // Sabotage one word first → checksum error toast.
  await inputs.nth(4).fill(words[4] === "abandon" ? "zoo" : "abandon");
  await b.page.getByRole("button", { name: "還原" }).click();
  await expect(b.page.locator("#toast")).toBeVisible();
  // Fix it → restore succeeds into the inbox.
  await inputs.nth(4).fill(words[4]);
  await b.page.getByRole("button", { name: "還原" }).click();
  await expect(b.page.locator(".paste-dock")).toBeVisible();
  await b.context.close();
});

test("settings: retention, API token lifecycle with 未加密 marking (§12)", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page, "settings-user");
  await page.getByRole("button", { name: "設定" }).click();

  // 保留期選項 (§10.2)
  await page.locator("#stRetention").selectOption("30");
  await expect(page.locator("#toast")).toContainText("已更新保留期");

  // Create a plaintext token — warning must be visible before creation (§12.4).
  await page.locator("#tokLabel").fill("NAS 備份腳本");
  await page.locator("#tokPlain").check();
  await expect(page.locator("#tokPlainWarn")).toBeVisible();
  await page.getByRole("button", { name: "建立" }).click();
  await expect(page.locator(".token-reveal")).toContainText("bd_");
  const revealText = await page.locator(".token-reveal").innerText();
  const token = revealText.match(/bd_[A-Za-z0-9_-]+/)![0];

  // Token list shows the 未加密 tag; the raw token is not in the list.
  const row = page.locator(".tok-row", { hasText: "NAS 備份腳本" });
  await expect(row.locator(".tagx")).toHaveText("未加密");

  // The token actually pushes (server side) and lands in the inbox tagged.
  const res = await page.request.post("/api/push", {
    headers: { authorization: `Bearer ${token}` },
    data: { text: "每日備份完成,共 42 GB" },
  });
  expect(res.status()).toBe(200);
  await page.getByRole("button", { name: "回收件匣" }).click();
  await refreshInbox(page);
  const card = page.locator(".mini", { hasText: "每日備份完成" });
  await expect(card.locator(".tagx")).toHaveText("未加密");
  await expect(card).toContainText("NAS 備份腳本");

  // Revoke → the row disappears (dead tokens don't take up space) and the
  // token stops working immediately.
  await page.getByRole("button", { name: "設定" }).click();
  await page.locator(".tok-row", { hasText: "NAS 備份腳本" }).getByRole("button", { name: "撤銷" }).click();
  await expect(page.locator(".tok-row", { hasText: "NAS 備份腳本" })).toHaveCount(0);
  await expect(page.locator("#tokList")).toContainText("已撤銷 1 個 token");
  const res2 = await page.request.post("/api/push", {
    headers: { authorization: `Bearer ${token}` },
    data: { text: "should fail" },
  });
  expect(res2.status()).toBe(401);
  await context.close();
});

test("landing page: manual at /landing, 開始使用 leads back to the app", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await page.goto("/landing");
  await expect(page).toHaveTitle(/BentoDrop/);
  await expect(page.getByRole("heading", { name: "已經可以這樣用" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "裝成 App,通知才可靠" })).toBeVisible();
  await expect(page.getByText("加入主畫面", { exact: false }).first()).toBeVisible(); // iOS steps present

  // One-click install row exists but stays hidden until the browser offers
  // a real install prompt; the hero button falls back to the manual anchor.
  await expect(page.locator("#oneClickRow")).toBeHidden();
  await expect(page.locator(".hero-cta a.js-install")).toHaveAttribute("href", "#install");

  // 開始使用 → the app itself (onboarding for a fresh browser).
  await page.getByRole("link", { name: "開始使用 →" }).first().click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByRole("heading", { name: "你叫什麼名字?" })).toBeVisible();
  await context.close();
});

test("install banner: shows in a browser tab, opens platform steps, dismiss persists", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);

  // Visible on the very first screen (onboarding), before any account exists.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你叫什麼名字?" })).toBeVisible();
  await expect(page.locator("#installBanner")).toBeVisible();

  await onboard(page, "installer");

  // Not standalone → the banner sits above the inbox.
  const banner = page.locator("#installBanner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("裝成 App");

  // No beforeinstallprompt in headless → the button opens the how-to guide.
  await banner.getByRole("button", { name: "怎麼裝?" }).click();
  await expect(page.locator(".modal")).toContainText(/安裝到|加入.*主畫面/);
  await expect(page.locator(".modal .install-steps li").first()).toBeVisible();
  await page.locator(".modal-back").click({ position: { x: 5, y: 5 } });

  // Dismiss is remembered per device.
  await banner.getByRole("button", { name: "關閉安裝提示" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.locator(".paste-dock")).toBeVisible();
  await expect(page.locator("#installBanner")).toHaveCount(0);

  // …but the settings entry is always reachable, even after dismissal.
  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("button", { name: "安裝成 App" }).click();
  await expect(page.locator(".modal .install-steps li").first()).toBeVisible();
  await context.close();
});

test("service worker registers and the manifest is installable", async ({ browser, baseURL }) => {
  const { context, page } = await newDeviceContext(browser, baseURL!);
  await onboard(page, "sw-user");
  const swReady = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then(() => "ready"),
      new Promise((r) => setTimeout(() => r("timeout"), 15000)),
    ]);
    return reg;
  });
  expect(swReady).toBe("ready");

  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  const m = await manifest.json();
  expect(m.display).toBe("standalone");
  expect(m.icons.length).toBeGreaterThanOrEqual(2);
  await context.close();
});
