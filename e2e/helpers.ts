import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/** Fresh context (own IndexedDB) with notification permission granted. */
export async function newDeviceContext(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, permissions: ["notifications"] });
  const page = await context.newPage();
  return { context, page };
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
  await page.getByRole("button", { name: "送到我的全部裝置" }).click();
  await expect(page.locator("#sendStatus")).toContainText(/已送達|✓/);
}

export async function refreshInbox(page: Page): Promise<void> {
  await page.getByRole("button", { name: "重新整理" }).click();
}
