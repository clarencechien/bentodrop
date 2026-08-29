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
npm test            # 117 項整合/單元測試(真 workerd + 真 D1/R2 模擬)
npm run test:e2e    # 26 項 Playwright E2E(真瀏覽器 + wrangler dev)
npm run test:all    # 以上全部
```

### 整合測試(`test/`,@cloudflare/vitest-pool-workers)

跑在真正的 workerd runtime 裡,D1/R2 由 miniflare 模擬;**推送服務用一個 fake push sink worker 攔截**(`vitest.config.mts` 的 `outboundService`),因此測試可以拿到 Worker 實際送出的 RFC 8291 加密 body,並用訂閱端私鑰解回來驗證 —— 推送管線是真的端到端驗證,不是 mock 回傳值。

| 檔案 | 涵蓋 |
|---|---|
| `crypto.spec.ts` | client 加密:BIP39(與 @scure/bip39 參考實作交叉比對)、checksum 抓錯字、HKDF 導鍵、envelope 往返、每則新 CEK、meta 加密、配對 ECDH 包裹、`https://` 白名單偵測、Android intent:// 產生(https-only、fragment 排除) |
| `webpush.spec.ts` | RFC 8291 aes128gcm 加密往返、header 格式、4KB 預算;RFC 8292 VAPID JWT 簽章驗證 |
| `api.spec.ts` | 註冊/認證、文字路徑全鏈路(加密→送出→攔截推送→解 transport→解 envelope)、發送端排除、收件匣已讀保留、跨 user 隔離、檔案路徑全鏈路(§4.3 大小驗證/物件缺失/謊報大小刪物件/簽名竄改/跨 user key)、410 立即刪訂閱、連續失敗 5 次刪除、測試推送、保留期設定、推送端點白名單(含子網域偽裝與 `PUSH_ENDPOINT_ALLOW` 逃生口) |
| `pairing.spec.ts` | §6.6 三條護欄各自對抗性測試:錯 3 次作廢(對的碼也救不回)、TTL 過期、單次使用(finish 燒毀)、每小時 5 次;code 只存 hash、wrapped blob 交付後清除、未確認前拿不到秘密 |
| `contacts.spec.ts` | §11:身分金鑰單次建立與收斂、私鑰只以密文存放、加好友全流程與護欄(30 分 TTL)、跨 user ecdh 收發(通知 payload 解密 + 收件匣)、非好友 403、解除好友即封鎖、跨 user 檔案下載授權、明文 24h 保留上限 |
| `cli.spec.ts` | §12.3 CLI 核心對真 Worker 全流程:取公鑰→包裹→推送→只有身分私鑰能解;無身分時的明確錯誤;明文模式權限 |
| `qr.spec.ts` | 配對 QR 以獨立解碼器(jsQR)往返驗證;fragment 不出瀏覽器 |
| `tokens.spec.ts` | token 只顯示一次/只存 hash、撤銷立即生效、send-only(不能讀)、明文模式 opt-in/2000 bytes 上限/拒收檔案/速率限制、§12.3 ecdh-p256 協定通道、拒收 self-wrap |
| `cleanup.spec.ts` | Cron 清理過期訊息(D1+R2)與配對、冪等 |
| `diag.spec.ts` | 診斷端點:`/api/diag/env` 誠實計時(所有 IO 都在 timed 內)、上傳 URL 由伺服器組 key(只落在 `diag/{userId}/`)、只能刪自己的 diag 物件、echo 上限、速率限制、cron 清殘留不動 probe |
| `perf.spec.ts` | 合併上傳(intent 開單→PUT 定案→回執):單次燒毀、過期/大小/好友關係在定案時重查(失敗即刪物件)、HMAC 去 intent 竄改、縮圖 envelope 往返與 413 預算、推送 probe 只送指定裝置 |

### E2E 測試(`e2e/`,Playwright)

真 Chromium 開兩個獨立瀏覽器 context 當兩台裝置,跑在 `wrangler dev` 上(`scripts/e2e-server.sh` 自動產生 `.dev.vars`、套本機 migrations、每次重置本機狀態):

onboarding 單欄位開通與 IndexedDB 持久化、送文字給自己(加密→拉取→解密→複製 UI)、`https://` 才有「開啟連結」且永不自動跳轉、`javascript:` 當純文字、全域刪除、檔案加密上傳/下載解密(檔名解密顯示,走合併上傳流程)、**完整雙裝置配對流程**(QR 連結+配對碼→別名→舊裝置確認→K_master 移轉→跨裝置解密→備份提示)、**加好友流程**(兩個瀏覽器 context 當兩個 user:邀請→輸碼→確認→ecdh 跨 user 收發)、**邀請先於開通**(3 個 context:沒帳號的瀏覽器開邀請→選「配對加入」併入既有帳號→邀請自動續接,全程單一帳號;並驗證邀請碼不會漏進配對表單)、剪貼簿 composer(文字/圖片預覽、即送/送出切換、點預覽編輯)、**share-target**(對真 SW 發文字/圖片/空分享)、通知「複製」與「開啟」action 的 app 端處理(SW `copy-msg`/`open-url` 訊息→複製、開啟連結)、**預取快取**(檔案通知到手即背景抓好:點開即現;快取未命中則縮圖預覽+下載按鈕)、收件匣離線首繪(API 掛掉仍先畫上次快取)、備份抽 3 詞驗證、還原碼還原(含 checksum 抓錯 + QR 照片匯入)、裝置改名、landing 頁與安裝橫幅(含 iOS UA:說明 Apple 限制、引導加入主畫面)、設定頁(保留期、API token 建立/未加密標示/實際推送/撤銷、撤銷後從列表消失)、傳輸診斷完整跑一輪(上傳=刪除、報告產出)、Service Worker 註冊與 manifest 可安裝。

Web Push 本身(瀏覽器端訂閱與通知顯示)無法在 headless 環境完整重現,推送管線改由整合測試以真加密驗證;`sw.js` 的解密/通知邏輯與 §6.3 通知隱私開關依 §5.5 設計(解密失敗仍顯示通用通知)。

CI(`.github/workflows/ci.yml`)每次 push / PR 全部跑一遍。

---

## 專案結構

```
wrangler.jsonc          Worker 設定(assets + D1 + R2 + cron;workers.dev 關閉)
migrations/             0001 核心 schema(§4.2 + pairings + api_tokens)
                        0002 Phase 2(user 身分金鑰欄位 + contacts + from_user)
                        0003 診斷(diag_runs 速率限制)
                        0004 合併上傳(upload_intents)
src/                    Worker(TypeScript)
  index.ts              路由器 + /api/health readiness 檢查
  routes/               register / pairing / contacts / messages / objects / tokens / devices / diag
  lib/webpush.ts        RFC 8291 + RFC 8292,零依賴
  fanout.ts             推送 fan-out 與 §8.3 失效處理
  cron.ts               §10 清理(訊息/配對/diag 殘留)
public/                 PWA(vanilla ES modules,無建置步驟)
  index.html            App 殼(字型非阻塞載入)
  landing.html          使用手冊 / 教學頁(/landing,一鍵安裝)
  js/crypto.js          client 加密(BIP39 / HKDF / envelope / ECDH 配對與 ecdh-p256)
  js/app.js             SPA:收件匣、剪貼簿 composer、配對、好友、備份、設定、安裝引導
  js/qr.js              QR 產生(vendor/lean-qr.mjs,MIT)
  js/qr-import.js       QR 照片解碼(BarcodeDetector → vendor/jsQR.js,Apache-2.0)
  js/diag.js            傳輸診斷(測量、結論規則、報告)
  js/api.js store.js image.js   fetch 包裝 / IndexedDB / canvas 壓縮 + 縮圖
  js/image-worker.js    背景執行緒圖片壓縮(module worker)
  sw.js                 push 解密與通知 action、檔案預取、share-target(含 CSRF 防護)、shell cache
cli/                    bentodrop-push.mjs + lib.mjs(§12.3,零依賴)
test/                   workerd 整合測試(117)
e2e/                    Playwright E2E(26)
scripts/                deploy(零設定部署)/ gen-vapid / gen-icons / e2e-server
```

## 安裝與教學

- **Landing page / 使用手冊**:`/landing`(沿用 mockup 視覺,只介紹已實作的功能;「開始使用」導回 `/`)。含 Android / iOS / 桌面三平台的安裝步驟,iOS 特別強調必須「加入主畫面」才有推送(§9)。瀏覽器提供安裝提示時,hero 按鈕與安裝區的「一鍵安裝」直接觸發原生安裝(`beforeinstallprompt`)。
- **App 內安裝引導**:非 PWA 模式開啟時,開通頁與收件匣上方顯示安裝橫幅 — 支援 `beforeinstallprompt` 的環境一鍵安裝;其他(含 iOS)按「怎麼裝?」彈出對應平台的簡化步驟。橫幅可關閉(每台裝置記住);**設定頁的「安裝成 App」永遠找得到**,不受關閉影響。
- **已安裝偵測**:透過 `getInstalledRelatedApps()`(Android/Chromium,manifest 有對應宣告)加上 standalone 開啟/`appinstalled` 事件記住的旗標,判定這台裝置已裝過 → 安裝橫幅、設定頁「安裝成 App」、landing 的安裝 CTA **全部不再顯示**;偵測到已解除安裝(API 回空)會自動恢復顯示。`beforeinstallprompt` 在已安裝的裝置上本來就不會再觸發(Chrome 行為)。
- Google Fonts 以非阻塞方式載入(`media="print"` onload 切換):字型 CDN 慢或不可達時,App 照常啟動、以系統字型顯示。

## 傳輸診斷(設定頁)

回答「檔案繞 Cloudflare 是不是很慢?要不要做 WebRTC?」— 用數字,不用猜。設定 → 診斷 → 開始測試:

- **三組測量,時鐘絕不跨裝置**:客戶端(加密/解密/圖片壓縮)、網路(echo RTT、1KB/256KB/1MB 各跑多次的上傳與下載)、伺服器自報(`GET /api/diag/env`:colo、Worker↔R2 HEAD/GET/PUT、D1,各取 3 次中位數)— **R2 的 GET 延遲是最關鍵的數字**,>100ms 代表 bucket 不在亞太,該先搬 bucket 而不是談協定
- 每個大小丟掉第一次(連線暖機),回報**中位數**與 min–max;測試資料是隨機位元組(HTTP 壓縮無法灌水);每輪解密後驗證內容一致
- **先給結論再給數字**(寫死的判斷規則):1MB 端到端 <1.5s → 「不值得做 P2P」;R2 GET >100ms → 「先搬 bucket」;壓縮 >300ms → 「瓶頸是 CPU 不是網路」;下載 ≫ 上傳 → 「做預取比換協定有效」。推送送達明確標「未測量」
- 「複製報告」產出純文字(含原始數據、UA、colo),可直接貼 issue
- 隔離與安全:全端點裝置認證;key 由 Worker 組在 `diag/{userId}/` 下(不收客戶端 key);上限 5MB/echo 64KB;每裝置每小時 20 次;**不建 messages 列、不觸發推送**;測完客戶端即刪,cron 每 15 分鐘掃掉 >1 小時的殘留,R2 lifecycle(diag/ 1 天)為第三道保險

### 實測結果(2026-08-28,對 spec §3.3「為什麼不做 WebRTC」的裁決)

台灣使用者、Pixel(行動網路)與 Chromebook(WiFi)實機各一輪:

| | Chromebook | Pixel |
|---|---|---|
| 邊緣節點 | **SJC(聖荷西,非 TPE)** | SJC |
| 你→邊緣 RTT | 205 ms | 196 ms |
| 邊緣→R2 GET | 45 ms ✓ | 68 ms ✓ |
| 1 MB 端到端 | 1533 ms | 2517 ms(上傳 1861) |
| 圖片壓縮 | 295 ms | 315 ms ⚠ CPU |
| 推送單程(FCM 投遞) | **~681 ms**(→Pixel,3/3) | —(對測時目標 SW 尚為舊版) |

補測(優化 #6 探針):文字訊息「按下→對方震動」完整拆解 ≈ 送出 0.3s(一次台美 RTT)+ FCM 投遞 ~0.68s ≈ **1 秒** — 瓶頸大頭是 FCM 投遞,屬 Google 基礎設施,無法再優化;這也給了檔案預取 ~0.7s 的先發時間。

**結論:**
1. **繞路存在,但不在 R2** — 台灣流量被路由到美西 SJC(ISP 與 Cloudflare 免費方案的 peering 現實,非程式可修);R2/D1 與 edge 同區,搬 bucket 目前沒有意義,除非流量改從 TPE 進
2. 每次 API 呼叫付 ~200ms 台美 RTT;小訊息的耗時幾乎全是 round trip 疊加
3. **WebRTC 暫不做**:1.5–2.5s 屬可用範圍;更便宜的優化排在前面(見下方 TODO)。若日後 ISP 路由改善或做了預取仍嫌慢,再重開此題

### 優化(依實測數據排序 — 前七項已完成)

文字路徑已是架構最優(內容在推送封包內,接收端零下載、無可省往返),以下全部針對**檔案路徑**與**首屏**:

- [x] **檔案背景預取**(體感 −0.8s):push 到達時 SW 抓密文進 Cache API(≤5MB;行動網路 ≤1.5MB),點開即解密顯示;刪除訊息同步清快取,快取上限 20 筆 LRU
- [x] **合併上傳流程省一次 RTT**(−230ms):`POST /api/upload-intent` 先收 envelope,PUT 完成即自動入列+推送並回傳回執(3 RTT → 2);intent id 簽進 HMAC、單次使用;**舊 upload-url→PUT→send 流程完整保留**,client 失敗時自動退回
- [x] **收件匣首屏快取**(首屏 −230ms):清單(密文)存 IndexedDB,開 app 先渲染再背景刷新;伺服器連不上時保留快取畫面
- [x] **圖片壓縮移到 Web Worker**:`image-worker.js` 模組 worker,失敗自動退回主執行緒
- [x] **檔案通知附加密縮圖**:96px WebP(≤1.2KB)用同一 CEK 加密進 `envelope.thumb`;通知顯示縮圖(data URL),詳情頁未下載前即有預覽;超出 push 預算自動棄縮圖,伺服器亦強制 4KB 上限
- [x] **推送送達時間探針**:診斷頁可選另一台已訂閱裝置,NTP 式往返(A→push→B 的 SW 自動 pong→push→A,單一時鐘)3 次取中位數,單程 ≈ RTT/2;會在對方裝置跳探針通知(UI 有標示)
- [x] **剪貼簿圖片 intent 預熱**(按下→送出 2 RTT → 1 RTT,再省 ~230ms + 壓縮 ~300ms):圖片預覽掛在「⚡即送」下方閒置時,背景先完成壓縮、加密、開單;按下即送只剩一次 PUT。換收件人或剪貼簿內容改變即作廢重建;過期/失敗自動退回完整流程(浪費的 intent 單次使用、10 分鐘過期、定案時重查,無濫用面)
- [ ] *(非程式)* SJC 繞路是 ISP↔Cloudflare peering 層問題:Argo Smart Routing / 付費方案可能把台灣流量收回 TPE — 屆時再重測,若 edge 移到 TPE 則同步評估搬 R2 bucket 到 APAC

## 分享捷徑(Android)

安裝 PWA 後,BentoDrop 會出現在 Android 的系統分享面板(Web Share Target)。從任何 App 分享文字、連結或圖片 → 選 BentoDrop → **Service Worker 直接在背景完成壓縮、加密、上傳、送出**,畫面只會閃一下「分享內容已加密送達 ✓」,不需要在 App 裡再操作。

`/share-target` 有 CSRF 防護:SW 以瀏覽器控制、網頁無法偽造的 `Sec-Fetch-Site` header 驗證來源(真實分享是 `none`、App 內是 `same-origin`),跨站網頁自動送出的表單(`cross-site`)一律拒絕,不會動用裝置憑證。

iOS 的 PWA 不支援 share target(Safari 限制)。替代方案:用「捷徑」App 建一個分享表單捷徑,對 `/api/push` 發 POST(需 API token;捷徑做不了 ECDH,只能走明文模式,內容會標示「未加密」且 24 小時後刪除)。

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
- **M5 打磨** ✅ 通知隱私開關、通知「複製/開啟」action(§7.2:app 聚焦後嘗試寫剪貼簿,失敗退回詳情頁按鈕;「開啟」僅限 https)、備份取出:複製/QR/下載/列印、還原碼 QR 照片匯入(原生 BarcodeDetector,fallback jsQR)、配對與邀請 QR、裝置與好友別名、剪貼簿 composer(權限授予後自動顯示反灰預覽 — 文字或圖片縮圖 — 單一主鍵「⚡即送」;開始打字即切換為「送出」;點預覽可改為手動編輯)、失效偵測 UI
- **M6 API** ✅ token 管理、明文模式端點(24h 保留上限)、**CLI 公鑰加密模式**(`cli/bentodrop-push.mjs`)
- **Phase 2(§11)** ✅ user 層級身分金鑰、加好友(§6.7 機制)、跨 user 加密收發(文字+檔案)、解除好友即封鎖、改名

## Backlog(刻意延後)

- 原檔模式的中間選項「原檔但移除 GPS」(§4.4,piexifjs 剝 GPS IFD)
- 辨認式還原網格(§6.2 選配;現有輸入 + 4 字母前綴自動完成)
- in-app 相機即時掃描(現為原生相機掃 QR + 照片匯入)
- iOS 實機驗證(§9 全部項目)

## 資安掃描紀錄

兩輪由 Claude Code `security-review` 對整個 branch diff 的掃描(找到的每個候選都經獨立誤報過濾):

- **第一輪(2026-08-28,Phase 2 完成後)**:發現並修復 share-target CSRF(上方 `Sec-Fetch-Site` 防護);同輪驗證 SQL 參數化、逐路由授權、HMAC 簽名 URL、XSS 轉義與加密衛生(IV/CEK 新鮮度、無偏隨機、timing-safe 比對)無問題。
- **第二輪(2026-08-28,診斷 + 效能優化上線後)**:針對新增攻擊面 — `/api/diag/*`、合併上傳 intent 流程(含 HMAC 分隔符注入的具體分析)、SW 預取與通知 action、`copy-msg` handler — **零發現**。重點驗證:intent 定案時重查好友關係且失敗即刪物件、diag 刪除鎖在 `diag/{userId}/` 前綴、通知「開啟」雙重 `https://` 把關、預取走同一套下載授權。

第二輪備註提到的 `/api/subscribe` blind-SSRF 面已於後續加固:endpoint 主機名限縮為已知推送服務白名單(FCM / Mozilla / Apple / WNS,防子網域偽裝);自架推送(UnifiedPush / ntfy)可用 `PUSH_ENDPOINT_ALLOW` 環境變數(逗號分隔主機名)加入,不影響任何正常瀏覽器。

## 已知限制

- iOS 為 experimental(§9):需手動加入主畫面,未在實機驗證。
- 還原碼在「所有裝置皆遺失」時只能救回金鑰身分,舊訊息過保留期即消失(無帳號系統,§6.8)。
- 通知上的「複製」在部分平台仍可能失敗(§7.2 本質限制)— 失敗時會自動開啟訊息詳情,那裡永遠有手動複製按鈕。
- 瀏覽器與裝好的 PWA 可能是**兩個獨立的儲存空間**(iOS 必然;Android 用不同瀏覽器或 in-app browser 開啟也是)— 在第二個空間重新開通會變成另一個帳號。開通畫面有明確提示改走「配對加入」;好友邀請在沒帳號的瀏覽器打開時會先暫存,開通**或配對**完成後自動續接,不會綁到用完即丟的帳號上。
