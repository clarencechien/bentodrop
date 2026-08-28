# BentoDrop(便當)

跨裝置端到端加密信箱 — 把文字、連結、照片「裝好、送出、拆開」,送到你自己的其他裝置。
Cloudflare Workers + D1 + R2 + Web Push(VAPID),全 PWA,無帳號系統。

對應設計規格 v0.2 與 UI/UX mockup v1。**Worker 是一個看不到內容的路由器**:所有加解密都在裝置上完成,伺服器只經手密文。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/clarencechien/bentodrop)

---

## 架構

```
裝置 A ──① client 端加密──▶ POST /api/send ──▶ Cloudflare Worker ──④ Web Push(密文)──▶ 裝置 B
                                    │                 │
                     ② presigned PUT(大檔直傳)     查 D1(裝置/訂閱)
                                    ▼                 │
                                   R2 ◀── HEAD 驗證大小 ┘
```

- **短文字(≤2KB 明文)**:完全不落地,加密後直接塞進 push payload(§3.1)。密文 envelope 同時存一份在 D1(仍是密文),讓其他裝置開 app 時拉得到收件匣(§10 已讀保留)。
- **檔案/圖片(≤20MB)**:client 加密 → 取得簽名上傳 URL → 直傳 R2 → `/api/send` 回報,Worker `HEAD` 驗證大小(§4.3)→ push 只送指標。
- **加密(§5)**:每則訊息隨機 CEK(AES-256-GCM),CEK 由 `K_master` 包裹(`wrap.mode: "self"`);`K_master` 由 128-bit 隨機值經 HKDF-SHA256 導出;還原碼為 BIP39 12 詞(§6.2);檔名與 MIME 也加密(`meta.ct`)。
- **配對(§6.6)**:URL + 6 位數字碼,三條護欄(TTL 5 分鐘、錯 3 次作廢、用完即焚)+ 每小時 5 次限制;`K_master` 以臨時 ECDH P-256 + HKDF 包裹傳遞,Worker 只見密文。
- **API 推送(§12)**:send-only token;明文模式 per-token 顯式開啟、純文字 ≤2000 bytes、不落 R2,UI 標示「未加密」,保留期上限 24 小時(§14 待決事項已定案)。加密模式(§12.3)由 `cli/bentodrop-push.mjs` 實作:token 只拿身分**公鑰**,外洩也讀不到任何內容。
- **跨使用者(§11 Phase 2)**:身分金鑰為 user 層級(公鑰存伺服器、私鑰以 K_master 包裹後同步,伺服器讀不到);加好友沿用 URL+邀請碼機制(TTL 放寬到 30 分鐘,其餘護欄相同);跨 user envelope 用 `wrap.mode: "ecdh-p256"`(臨時金鑰 + HKDF);授權以**收件人**的好友名單為準 — 解除好友即刻擋下對方來訊。送達回執對寄件者隱藏對方裝置名稱。
- **清理(§10)**:Cron 每 15 分鐘刪過期訊息(D1 列 + R2 物件)與過期配對;R2 lifecycle(7 天)為第二道保險。

### 與規格的兩個實作註記

1. **簽名 URL 由 Worker 簽發(HMAC),不用 S3 presigned URL。** R2 的 presigned URL 需要 S3 API 金鑰,會破壞「連 GitHub 就能部署」的零設定流程。語意不變:短效(10 分鐘)URL、宣告大小、直傳密文;Worker↔R2 流量免費。
2. **文字訊息的密文 envelope 會存進 D1。** 純推送、零儲存(§3.1)與「已讀保留、多裝置取用」(§10)不可兼得;存密文不影響威脅模型,且讓收件匣在所有裝置上一致。

---

## 用 Cloudflare 的 GitHub 整合上架(Workers Builds)

**零設定**:不需要事先開任何資源,連結 repo 就能上線。

1. Cloudflare dashboard → **Workers & Pages → Create → Workers → Import a repository**
2. 選這個 repo / 分支
3. Build command:`npm ci`
4. **Deploy command:`npm run deploy`**(這行很重要,不要用預設的 `npx wrangler deploy`)

`npm run deploy`(`scripts/deploy.mjs`)每次 push 會依序做:

| 步驟 | 說明 |
|---|---|
| `wrangler deploy` | `wrangler.jsonc` 刻意不寫死 D1 `database_id`,首次部署時 Cloudflare 會**自動開通** D1(`bentodrop`)與 R2(`bentodrop-inbox`) |
| 補齊 secrets | 只在缺少時產生:VAPID P-256 金鑰對(`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_JWK`)與 `URL_SIGNING_SECRET`;已存在就完全不動 |
| `wrangler d1 migrations apply --remote` | schema 變更隨 push 自動套用 |
| R2 lifecycle 保險 | `u/` prefix 7 天自動刪(§4.1),冪等 |

> ⚠️ VAPID 金鑰一換,**所有**既有推送訂閱全部失效(§8.5)。deploy script 因此絕不覆蓋已存在的 secrets;不要手動刪除它們。

之後每次 push 就是一次部署。也可以不走 dashboard,在本機 `npx wrangler login` 後直接 `npm run deploy`。上面的 **Deploy to Cloudflare** 按鈕亦可:它會依 `wrangler.jsonc` 開好資源並建立連動 repo,部署指令同樣設成 `npm run deploy` 即可。

### 本機開發

```bash
npm run dev        # wrangler dev(本機 D1/R2);首次先跑:
                   #   npx wrangler d1 migrations apply bentodrop --local
                   #   並建立 .dev.vars(參考 scripts/e2e-server.sh 的產生方式)
```

---

## 自動測試

三層測試,全部無外部依賴、可在 CI 跑:

```bash
npm run typecheck   # tsc
npm test            # 75 項整合/單元測試(真 workerd + 真 D1/R2 模擬)
npm run test:e2e    # 11 項 Playwright E2E(真瀏覽器 + wrangler dev)
npm run test:all    # 以上全部
```

### 整合測試(`test/`,@cloudflare/vitest-pool-workers)

跑在真正的 workerd runtime 裡,D1/R2 由 miniflare 模擬;**推送服務用一個 fake push sink worker 攔截**(`vitest.config.mts` 的 `outboundService`),因此測試可以拿到 Worker 實際送出的 RFC 8291 加密 body,並用訂閱端私鑰解回來驗證 —— 推送管線是真的端到端驗證,不是 mock 回傳值。

| 檔案 | 涵蓋 |
|---|---|
| `crypto.spec.ts` | client 加密:BIP39(與 @scure/bip39 參考實作交叉比對)、checksum 抓錯字、HKDF 導鍵、envelope 往返、每則新 CEK、meta 加密、配對 ECDH 包裹、`https://` 白名單偵測 |
| `webpush.spec.ts` | RFC 8291 aes128gcm 加密往返、header 格式、4KB 預算;RFC 8292 VAPID JWT 簽章驗證 |
| `api.spec.ts` | 註冊/認證、文字路徑全鏈路(加密→送出→攔截推送→解 transport→解 envelope)、發送端排除、收件匣已讀保留、跨 user 隔離、檔案路徑全鏈路(§4.3 大小驗證/物件缺失/謊報大小刪物件/簽名竄改/跨 user key)、410 立即刪訂閱、連續失敗 5 次刪除、測試推送、保留期設定 |
| `pairing.spec.ts` | §6.6 三條護欄各自對抗性測試:錯 3 次作廢(對的碼也救不回)、TTL 過期、單次使用(finish 燒毀)、每小時 5 次;code 只存 hash、wrapped blob 交付後清除、未確認前拿不到秘密 |
| `contacts.spec.ts` | §11:身分金鑰單次建立與收斂、私鑰只以密文存放、加好友全流程與護欄(30 分 TTL)、跨 user ecdh 收發(通知 payload 解密 + 收件匣)、非好友 403、解除好友即封鎖、跨 user 檔案下載授權、明文 24h 保留上限 |
| `cli.spec.ts` | §12.3 CLI 核心對真 Worker 全流程:取公鑰→包裹→推送→只有身分私鑰能解;無身分時的明確錯誤;明文模式權限 |
| `qr.spec.ts` | 配對 QR 以獨立解碼器(jsQR)往返驗證;fragment 不出瀏覽器 |
| `tokens.spec.ts` | token 只顯示一次/只存 hash、撤銷立即生效、send-only(不能讀)、明文模式 opt-in/2000 bytes 上限/拒收檔案/速率限制、§12.3 ecdh-p256 協定通道、拒收 self-wrap |
| `cleanup.spec.ts` | Cron 清理過期訊息(D1+R2)與配對、冪等 |

### E2E 測試(`e2e/`,Playwright)

真 Chromium 開兩個獨立瀏覽器 context 當兩台裝置,跑在 `wrangler dev` 上(`scripts/e2e-server.sh` 自動產生 `.dev.vars`、套本機 migrations、每次重置本機狀態):

onboarding 單欄位開通與 IndexedDB 持久化、送文字給自己(加密→拉取→解密→複製 UI)、`https://` 才有「開啟連結」且永不自動跳轉、`javascript:` 當純文字、全域刪除、檔案加密上傳/下載解密(檔名解密顯示)、**完整雙裝置配對流程**(URL+配對碼→舊裝置確認→K_master 移轉→跨裝置解密→備份提示)、備份抽 3 詞驗證、還原碼還原(含 checksum 抓錯)、設定頁(保留期、API token 建立/未加密標示/實際推送/撤銷)、Service Worker 註冊與 manifest 可安裝。

Web Push 本身(瀏覽器端訂閱與通知顯示)無法在 headless 環境完整重現,推送管線改由整合測試以真加密驗證;`sw.js` 的解密/通知邏輯與 §6.3 通知隱私開關依 §5.5 設計(解密失敗仍顯示通用通知)。

CI(`.github/workflows/ci.yml`)每次 push / PR 全部跑一遍。

---

## 專案結構

```
wrangler.jsonc          Worker 設定(assets + D1 + R2 + cron)
migrations/             D1 schema(§4.2 + pairings + api_tokens)
src/                    Worker(TypeScript)
  index.ts              路由器
  routes/               register / pairing / messages / objects / tokens / devices
  lib/webpush.ts        RFC 8291 + RFC 8292,零依賴
  fanout.ts             推送 fan-out 與 §8.3 失效處理
  cron.ts               §10 清理
public/                 PWA(vanilla ES modules,無建置步驟)
  js/crypto.js          client 加密(BIP39 / HKDF / envelope / ECDH 配對)
  js/qr.js              配對 QR(vendor/lean-qr.mjs,MIT;測試以 jsQR 解碼驗證)
  js/app.js             SPA:收件匣、送出、配對、備份、設定
  sw.js                 push 解密顯示通知(§5.5/§6.3/§7.3)、shell cache
test/                   workerd 整合測試(75)
e2e/                    Playwright E2E(11)
scripts/                setup / gen-vapid / gen-icons / e2e-server
```

## CLI:腳本推送(§12.3)

零依賴(Node 18+),重用 PWA 的加密模組,不需安裝任何套件:

```bash
export BENTODROP_URL=https://bentodrop.ai-apps.work
export BENTODROP_TOKEN=bd_xxx        # 設定 → API Tokens 建立

node cli/bentodrop-push.mjs "建置完成"          # 加密模式(預設):token 只拿公鑰
echo "備份完成" | node cli/bentodrop-push.mjs   # 也吃 stdin
node cli/bentodrop-push.mjs --plain "磁碟 85%"  # 明文模式(token 需開啟)
```

加密模式流程:`GET /api/push/pubkey` 取身分公鑰 → 臨時 ECDH 包裹隨機 CEK → `ecdh-p256` envelope → `POST /api/push`。token 外洩的後果只有「能發垃圾訊息」,讀不到任何內容,包括它自己發的。

## 里程碑對應(§13)

- **M1 骨架** ✅ Worker + D1 + VAPID,註冊與推送鏈路
- **M2 加密** ✅ K_master/HKDF、envelope、短文字 E2E、備份(顯示+複製+抽 3 詞)
- **M3 多裝置** ✅ URL+配對碼、三護欄、舊裝置確認、fan-out、410 清理、測試推送
- **M4 檔案** ✅ 簽名直傳、20MB 上限、client 壓縮(canvas,EXIF 剝除+方向烘焙、HEIC 原檔 fallback)、meta 加密、清理
- **M5 打磨** ✅ 通知隱私開關、通知「複製/開啟」action(§7.2:app 聚焦後嘗試寫剪貼簿,失敗退回詳情頁按鈕;「開啟」僅限 https)、備份取出:複製/QR/下載/列印、還原碼 QR 照片匯入(原生 BarcodeDetector,fallback jsQR)、配對與邀請 QR、裝置與好友別名、貼上就送(預設直送,可勾掉)、失效偵測 UI
- **M6 API** ✅ token 管理、明文模式端點(24h 保留上限)、**CLI 公鑰加密模式**(`cli/bentodrop-push.mjs`)
- **Phase 2(§11)** ✅ user 層級身分金鑰、加好友(§6.7 機制)、跨 user 加密收發(文字+檔案)、解除好友即封鎖、改名

## Backlog(刻意延後)

- 原檔模式的中間選項「原檔但移除 GPS」(§4.4,piexifjs 剝 GPS IFD)
- 辨認式還原網格(§6.2 選配;現有輸入 + 4 字母前綴自動完成)
- in-app 相機即時掃描(現為原生相機掃 QR + 照片匯入)
- iOS 實機驗證(§9 全部項目)

## 已知限制

- iOS 為 experimental(§9):需手動加入主畫面,未在實機驗證。
- 還原碼在「所有裝置皆遺失」時只能救回金鑰身分,舊訊息過保留期即消失(無帳號系統,§6.8)。
- 通知上的「複製」在部分平台仍可能失敗(§7.2 本質限制)— 失敗時會自動開啟訊息詳情,那裡永遠有手動複製按鈕。
