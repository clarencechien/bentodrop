// Transport diagnostics: the full suite runs in a real browser against
// wrangler dev — every upload gets a matching delete, and the output leads
// with a verdict, not milliseconds.
import { expect, test } from "@playwright/test";
import { newDeviceContext, onboard } from "./helpers";

test("diagnostics: full run produces verdicts, numbers, a copyable report, and no leftovers", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const { context, page } = await newDeviceContext(browser, baseURL!, ["clipboard-read", "clipboard-write"]);
  await onboard(page, "diag-user");

  let uploads = 0;
  let deletes = 0;
  let deleteFailures = 0;
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.pathname === "/api/diag/upload-url" && res.request().method() === "POST") uploads++;
    if (url.pathname === "/api/diag/object" && res.request().method() === "DELETE") {
      deletes++;
      if (!res.ok()) deleteFailures++;
    }
  });

  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByRole("heading", { name: "診斷" })).toBeVisible();
  await page.getByRole("button", { name: "開始測試" }).click();

  // Per-step checklist, not a spinner.
  await expect(page.locator("#diagProgress li").first()).toBeVisible();

  // Full suite: env + echo + 11 transfer rounds + compression benchmark.
  await expect(page.locator("#diagResult .diag-verdict").first()).toBeVisible({ timeout: 150_000 });

  // Verdict text exists (one of the hard-coded conclusions), then the numbers.
  const verdicts = await page.locator("#diagResult .diag-verdict").allInnerTexts();
  expect(verdicts.join(" ")).toMatch(/P2P|R2|傳輸|壓縮/);
  await expect(page.locator(".diag-table")).toContainText("上傳 1 MB");
  await expect(page.locator(".diag-table")).toContainText("你 → 邊緣節點");
  await expect(page.locator(".diag-table")).toContainText("推送送達");
  await expect(page.locator(".diag-table")).toContainText("未測量");

  // Every checklist step completed.
  const pending = await page.locator("#diagProgress li b", { hasText: "…" }).count();
  expect(pending).toBe(0);

  // Copyable plain-text report with the key fields.
  await page.getByRole("button", { name: "複製報告" }).click();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain("BentoDrop 傳輸診斷報告");
  expect(report).toContain("1 MB: 端到端");
  expect(report).toContain("邊緣節點 → R2");
  expect(report).toContain("推送送達時間: 未測量");

  // No leftovers: every signed upload was deleted, successfully.
  expect(uploads).toBe(11); // 5×1KB + 3×256KB + 3×1MB
  expect(deletes).toBe(uploads);
  expect(deleteFailures).toBe(0);
  await context.close();
});
