# BentoDrop 金鑰儲存與還原路徑 — 程式碼查核紀錄

日期:2026-09-09 · 範圍:`main` @ 3f8d44e · 方法:逐項對照實際程式碼,不採信 README 與對話推論

原始提問是一份「全部來自 README 與推論、沒看過程式碼」的主張清單。以下是逐項查核結果,
以及據此做掉的最小修補。**三項提案在查核後撤案**(前提本身就不成立),**一項核心推論被修正**。

---

## 結論摘要

| 區塊 | 結果 |
|---|---|
| A 金鑰儲存層 | A1 ✅ A2 ✅ **A3 ✅(原本以為沒做,其實早就做了)** A4 ⚠️(改不了,撤案) |
| B K_master 導出鏈 | B1 ✅ B2 ✅ **B3 ⚠️(「還原」的語意比想像中窄)** B4 ✅ |
| C 身分私鑰 | C1 ✅ C2 ✅ C3 ✅ **核心推論 ⚠️ 一半不成立** C4 ⚠️(真正的風險在別處) |
| D 護欄 | D1 ✅ **D2 ⚠️(說法全庫寫錯)** D3 ✅ D4 ✅ D5 ✅ |
| E iOS/Safari | E1 ❌ E2 ❌(建議不做) E3 ✅ 仍在 backlog |

---

## A. 金鑰儲存層

**A1 ✅ 金鑰只存在 IndexedDB。**
`public/js/store.js:4-53`(DB `bentodrop` / store `kv`)、`store.js:57` `K.ENTROPY`、
`app.js:89-99` `saveIdentity()`。entropy、deviceToken、identityWrapped 全走 `kvSet`。

**A2 ✅ 全 codebase 沒有任何 `localStorage` 寫入。**
全庫 grep,`localStorage` 唯一命中是註解 `store.js:1`;`sessionStorage` 零命中。

**A3 ✅ `navigator.storage.persist()` 早就在呼叫了 —— 這項的前提是錯的。**
`app.js:99`,位於 `saveIdentity()` 內。呼叫時機正好就是原文要求的位置:`saveIdentity` 只有兩個
caller —— `onboardNewUser()`(`app.js:339`)與配對完成(`app.js:1157`),都在「開通或配對之後」,
不在 page load;失敗靜默吞掉,不影響既有行為。**「唯一還沒做的低成本項目」這個結論不成立。**

**A4 ⚠️ K_master 本身是 non-extractable,但持久化的是原始 entropy bytes。**
`crypto.js:93-107` `deriveKey(..., extractable=false, [encrypt,decrypt,wrapKey,unwrapKey])`;
`store.js:57` + `app.js:81` 每次冷啟動用 IndexedDB 裡的 entropy 重新導出。
所以 in-memory 的 CryptoKey 匯不出來,但這對 at-rest 沒有意義 —— 讀得到 IndexedDB 的人直接拿到
entropy,等同拿到 12 個詞。

**改成只存 non-extractable K_master 這條路走不通,撤案。** 原文擔心的 `wrapKey`/`unwrapKey` 衝突
不存在(K_master 已經帶這兩個用途,身分私鑰走的是 `encryptJson`,`crypto.js:292`),真正的阻擋是
另外兩處:配對要把 entropy 原文交給新裝置(`app.js:1072-1077`)、備份頁要把 entropy 轉成助記詞
(`app.js:1336-1338`)。改掉會同時廢掉配對與備份。

---

## B. K_master 導出鏈

**B1 ✅** `crypto.js:45-47` 128-bit `getRandomValues`;`crypto.js:93-107` HKDF-SHA256,
salt = `` `bentodrop-v1:${userName}` ``,info = `k-master` → AES-GCM-256。
**注意 salt 含 userName** —— 還原需要 12 詞**加上**當初的名字,見 C4。

**B2 ✅** `crypto.js:55-83`,`entropyToMnemonic` / `mnemonicToEntropy` 純粹是 16 bytes +
SHA-256 前 4 bit checksum ↔ 12×11 bit 的雙向編碼,沒有第二條導出路徑。

**B3 ⚠️ 「零 API 呼叫」屬實,但「還原」的語意比原文寫的窄很多。**
`app.js:1464-1472`:還原 = `mnemonicToEntropy` → `onboardNewUser(name, entropy)` →
`api.register`(`src/routes/register.ts:18`)→ **開一個新的 userId**。整個 API 面
(`public/js/api.js:29-65`、`src/index.ts:53-101`)沒有任何帳號還原端點。

也就是說:還原確實沒有任何「取回金鑰材料」的網路呼叫 ✅,但還原出來的是**新的伺服器帳號** ——
舊 userId、舊訊息、舊 contacts、舊身分金鑰全部拿不回來。還原頁本來就講對了
(`app.js:1426`),但設定頁的重設警語當時暗示有還原碼就解得開,兩處互相矛盾。**已修**。

**B4 ✅** `crypto.js:169/189/208/239` 每則訊息 32-byte 隨機 CEK;`crypto.js:119-122`
`makeWrap` → `{mode:"self"}`,K_master 自包裹。

---

## C. 身分私鑰與 blast radius

**C1 ✅** `app.js:356-371` `ensureUserIdentity()` → `encryptJson(kMaster, privateJwk)` →
`api.setIdentity`;`src/routes/contacts.ts:19-35` 存進 `users.identity_priv_wrapped`;
`migrations/0002_contacts.sql:7`。

**C2 ✅ 而且有測試釘住。** `contacts.ts:24-34` 整包當 opaque JSON 存;
`test/contacts.spec.ts:30-38` 直接斷言 `identity_priv_wrapped` 不含 `"d"`(JWK 私鑰參數)。

**C3 ✅ 確實沒有輪替路徑。** `contacts.ts:25` `WHERE identity_pub IS NULL` —— first writer wins,
寫死之後 API 無法覆寫;全庫 grep `rotate` / 輪替零命中。唯一出路是設定頁「重設」
(`app.js:1770-1775`)→ 重新開通 → 換成新 userId 的新身分。

### 核心推論 ⚠️ 一半不成立

原文的推論是:

> 12 詞外洩 = K_master 外洩 = 歷史訊息(保留期內)加上永久身分私鑰。攻擊者可長期冒充此 user 收發跨 user 訊息。

**單靠 12 詞做不到這件事。** 伺服器的認證憑證是 device token,不是 K_master:

- 所有讀寫端點都要 device auth(`src/index.ts:78-101`,全部帶 `device: DeviceCtx`)
- 拿 12 詞去 `/api/register` 只會開一個**新的** userId(`register.ts:18-28`),碰不到受害者的資料
- 因此攻擊者既拉不到 `/api/messages` 的密文,也拉不到 `/api/identity` 的 wrapped 私鑰

12 詞真正給出的是**解密能力,不是存取能力**。它只在攻擊者「另外」拿到密文時才變現:伺服器被
打穿(D1 + R2 dump)、或裝置的 IndexedDB 被複製。後一種情況下 deviceToken 本來就一起外洩了,
12 詞不是關鍵路徑。

「無法輪替,只能整組重建身分」這半句 ✅ 成立:身分私鑰一旦外洩(例如裝置被 dump),受害者沒有
輪替 API,只能重設 → 新 userId → 所有好友重加。

**C4 ⚠️ 四種取出方式的警語其實已經寫得夠好,真正的漏洞在別的欄位。**
`app.js:1353` 逐一標了風險(剪貼簿要清空 / QR 相簿會雲端同步 / 下載留在下載資料夾 /
印表機有快取),`app.js:1369` 下載後還 toast「記得移出下載資料夾」。照上面對 C 的修正,
12 詞的實際 blast radius 沒有大到需要升級成「等同完整身分」的措辭。

真正的問題是:**備份出去的內容只有 12 個詞,沒有名字**。K_master 的 HKDF salt 含 userName
(`crypto.js:99`),還原頁強制要求「名字(當初輸入的)」(`app.js:1428`),但下載檔
(`app.js:1363-1366`)與 QR(`app.js:1374-1378`)都只帶 12 個詞。名字打錯不會報錯 —— checksum 只驗
entropy 不驗名字 —— 會靜默導出一把錯的 K_master。**已修**。

---

## D. 已聲稱的護欄

**D1 ✅** `src/types.ts:20,23,24`;`pairing.ts:92-94`(TTL)、`49`+`62-64`(3 次)、
`175`(用完即焚)、`84`(每小時 5 次)。`test/pairing.spec.ts:45-118` 四條護欄各有對抗性測試,
含併發那次修正(`pairing.ts:36-45` 註解)。

**D2 ⚠️ 機制對,但「包裹 K_master」的說法全庫都寫錯了。**
`app.js:1071-1078` 舊裝置 `wrapForPeer`(臨時 ECDH P-256 → HKDF → AES-GCM,
`crypto.js:124-136,319-328`)傳的 payload 是 `{ entropy: b64u(entropy), userName }`,
**不是 K_master**;新裝置 `app.js:1155-1159` unwrap 後自己 `deriveKmaster`。
Worker 只見密文 ✅(`pairing.ts:151-152` 存 opaque string,`186` 交付後清空)。
但註解、README、測試名稱一律寫「hands K_master」。**已修**。

**D3 ✅** `types.ts:21` `CONTACT_TTL_MS`;`contacts.ts:81-109` 與 pairing 同一套併發修正、
`119-122` 每小時 5 次、`179-182` 單次燒毀。

**D4 ✅** `wrangler.jsonc:38` `*/15 * * * *`;`src/cron.ts:5-19`;
`scripts/deploy.mjs:85` `--expire-days 7`(另有 `diag/` prefix 1 天,`deploy.mjs:90`);
`types.ts:22` + `tokens.ts:90-91` 明文 24h 上限。

**D5 ✅** `src/routes/tokens.ts:110-121` `pushPubkey` 只 `SELECT identity_pub`;
`index.ts:63-68` token 路徑只開 `/api/push` 與 `/api/push/pubkey`,沒有任何讀取端點;
`cli/lib.mjs:23-25` 走公鑰 + `ecdh-p256`。token 外洩者寫得進去、讀不出來,連自己剛送的也讀不到
(`crypto.js:157-160`)。

---

## E. iOS / Safari 儲存風險

**E1 ❌ 完全沒有偵測,冷啟動就是空白開通頁。**
`app.js:1880` `loadIdentity()` 只回 true/false(`app.js:77-86`),false → `renderOnboarding()`
(`app.js:1911-1914`),文案是「你叫什麼名字?」+「沒有註冊 · 沒有密碼 · 沒有信箱」。

**偵測本身做不乾淨:** IndexedDB、Cache Storage、SW 註冊都算 script-writable storage,ITP 是整組
一起清,沒有可靠的「你來過」殘留物。所以不做偵測,改成把開通頁的提示同時涵蓋兩種情況 ——
這是唯一有把握不會誤判的版本。**已修**(`app.js:301`)。

**E2 ❌ 沒有任何 telemetry,而且建議不要加。**
全庫 grep `analytics` / `telemetry` / `gtag` / `sendBeacon` / `plausible` 零命中;
`src/routes/diag.ts` 是使用者自己按的傳輸診斷,不是埋點。

最小形狀會是「`loadIdentity()` 回 false 且 SW 註冊還在 → 回報一筆匿名計數」,但 SW 註冊跟
IndexedDB 是一起被清的,這個訊號在真正的 ITP 清除情境是 false negative,埋了也量不到想量的東西。
要代理指標的話,量 landing / 開通頁「配對加入」與「用還原碼還原」的點擊率更實在。**不做。**

**E3 ✅ 仍在 backlog,沒有動過。** `README.md:229`「iOS 實機驗證(§9 全部項目)」;
`README.md:288` 也重申「iOS 為 experimental(§9):需手動加入主畫面,未在實機驗證」。

---

## README 與實作漂移之處(查核當下)

1. `pairing.ts:137,158` / `README:25,89,102` / `test/pairing.spec.ts:14,27` —— 都說配對交付的是
   `K_master`,實際交付的是 `entropy + userName`。
2. 設定頁重設警語(`app.js:1767`)暗示還原碼能救回訊息,但還原頁(`app.js:1422`)已經正確說明
   還原 = 新帳號、舊訊息拿不回來。同一支 app 兩處矛盾。
3. `app.js:1769` `kvDelete("identityPrivWrapped")` 是死碼 —— IndexedDB 的鍵是
   `"identityWrapped"`(`store.js:68`),`identityPrivWrapped` 是 API 回應的欄位名
   (`contacts.ts:33`)。上一行 `Object.values(K)` 已經刪掉真正的鍵,所以沒有實際 bug,
   但這行永遠刪不到東西。

以上三項本輪全部修掉。

---

## 本輪實際做掉的修補

| # | 動作 | 檔案 | 行數 |
|---|---|---|---|
| 1 | 刪掉刪不到東西的 `kvDelete("identityPrivWrapped")` | `public/js/app.js` | −1 |
| 2 | 重設警語不再暗示還原碼救得回舊訊息 | `public/js/app.js` | 1 |
| 3 | 開通頁提示涵蓋「本機資料被系統清除」(E1 的最小可行解) | `public/js/app.js` | 1 |
| 4 | 備份頁顯示名字、下載檔帶上名字、QR 說明補上名字(C4 的實質風險) | `public/js/app.js` | +6 |
| 5 | 「wrap K_master」改成「wrap entropy + userName」 | `pairing.ts` / `README.md` / `pairing.spec.ts` | ~8 |

QR 的 payload 刻意維持只有 12 個字 —— 還原頁的照片匯入只認 12 個字(`app.js:1454`),
改動會讓既有的備份 QR 失效。名字寫在 QR 說明文字裡。

**撤案三項**:A3(已實作)、A4 改 non-extractable(會廢掉配對與備份)、E2 埋點(訊號不可靠)。
**修正一項**:C 的核心推論 —— 12 詞單獨外洩不構成冒充,伺服器認證走 device token。

驗證:`npm run typecheck` 乾淨、`npm test` 120/120 通過、e2e 中觸及改動文案的 4 個測試
(backup verify、recovery QR、restore from the 12 words、friend invite before onboarding)全過。
