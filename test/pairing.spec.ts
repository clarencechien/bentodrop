// §6.6 pairing guardrails — "護欄失效則此方案失效", so each guardrail gets
// its own adversarial test: TTL 5 min, 3 attempts, single use, rate limit.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { C, apiFetch, createDevice, json, pairNewDevice } from "./helpers";
import { PAIR_MAX_ATTEMPTS as C_MAX_ATTEMPTS } from "../src/types";

async function createPair(owner: Awaited<ReturnType<typeof createDevice>>) {
  return json(await apiFetch("/api/pair/create", { method: "POST", token: owner.token, body: {} }));
}
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

describe("happy path", () => {
  it("hands K_master to the new device; the new device can decrypt", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a, "MacBook");
    expect(b.userId).toBe(a.userId);
    expect(b.deviceId).not.toBe(a.deviceId);
    // Both derive the same K_master — cross-decrypt proves it.
    const envl = await C.encryptTextEnvelope(a.kMaster, "shared secret");
    expect(await C.decryptTextEnvelope(b.kMaster, envl)).toBe("shared secret");

    const me = await json(await apiFetch("/api/me", { token: a.token }));
    expect(me.devices).toHaveLength(2);
  });

  it("never stores the pairing code or K_master in the clear", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const row = await env.DB.prepare("SELECT * FROM pairings WHERE pair_id = ?")
      .bind(created.pairId).first<any>();
    expect(row.code_hash).not.toContain(created.code);
    expect(JSON.stringify(row)).not.toContain(created.code);
  });

  it("clears the wrapped blob after delivery", async () => {
    const a = await createDevice();
    await pairNewDevice(a);
    const rows = await env.DB.prepare("SELECT wrapped_blob FROM pairings WHERE owner_user = ?")
      .bind(a.userId).all<any>();
    for (const r of rows.results ?? []) expect(r.wrapped_blob).toBeNull();
  });
});

describe("guardrail: 3 attempts", () => {
  it("voids the pairing after 3 wrong codes — even with the right code afterwards", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const keys = await C.generateEcdhPair();
    const claim = (code: string) =>
      apiFetch("/api/pair/claim", { body: { pairId: created.pairId, code, pubkey_jwk: keys.publicJwk, label: "X" } });

    expect((await claim(wrongCode(created.code))).status).toBe(403);
    expect((await claim(wrongCode(created.code))).status).toBe(403);
    expect((await claim(wrongCode(created.code))).status).toBe(410); // third strike voids it
    expect((await claim(created.code)).status).toBe(410);            // correct code no longer helps
  });

  it("counts wrong attempts across claim and finish", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const keys = await C.generateEcdhPair();
    await apiFetch("/api/pair/claim", { body: { pairId: created.pairId, code: created.code, pubkey_jwk: keys.publicJwk, label: "X" } });
    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: wrongCode(created.code) } })).status).toBe(403);
    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: wrongCode(created.code) } })).status).toBe(403);
    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: wrongCode(created.code) } })).status).toBe(410);
    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: created.code } })).status).toBe(410);
  });
});

describe("guardrail: TTL 5 minutes", () => {
  it("advertises a 5-minute expiry", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    expect(created.expiresAt - Date.now()).toBeGreaterThan(4.9 * 60 * 1000);
    expect(created.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("refuses claim and finish after expiry", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    await env.DB.prepare("UPDATE pairings SET expires_at = ? WHERE pair_id = ?")
      .bind(Date.now() - 1000, created.pairId).run();
    const keys = await C.generateEcdhPair();
    expect((await apiFetch("/api/pair/claim", {
      body: { pairId: created.pairId, code: created.code, pubkey_jwk: keys.publicJwk, label: "X" },
    })).status).toBe(410);
    expect((await apiFetch("/api/pair/finish", {
      body: { pairId: created.pairId, code: created.code },
    })).status).toBe(410);
  });
});

describe("guardrail: single use", () => {
  it("burns the pairing on finish — the second finish fails", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const keys = await C.generateEcdhPair();
    await apiFetch("/api/pair/claim", { body: { pairId: created.pairId, code: created.code, pubkey_jwk: keys.publicJwk, label: "X" } });
    const oldKeys = await C.generateEcdhPair();
    const status = await json(await apiFetch(`/api/pair/${created.pairId}/status`, { token: a.token }));
    const wrapped = await C.wrapForPeer(oldKeys.privateKey, status.newPubkey, { entropy: C.b64u(a.entropy), userName: a.userName });
    await apiFetch(`/api/pair/${created.pairId}/approve`, { token: a.token, body: { wrapped_blob: wrapped, old_pubkey: oldKeys.publicJwk } });

    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: created.code } })).status).toBe(200);
    expect((await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: created.code } })).status).toBe(410);
  });
});

describe("guardrail: rate limit", () => {
  it("allows 5 pairings per user per hour, refuses the 6th", async () => {
    const a = await createDevice();
    for (let i = 0; i < 5; i++) {
      expect((await apiFetch("/api/pair/create", { method: "POST", token: a.token, body: {} })).status).toBe(200);
    }
    expect((await apiFetch("/api/pair/create", { method: "POST", token: a.token, body: {} })).status).toBe(429);
  });
});

describe("flow integrity", () => {
  it("finish before the old device approves → 409, not a secret leak", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const keys = await C.generateEcdhPair();
    await apiFetch("/api/pair/claim", { body: { pairId: created.pairId, code: created.code, pubkey_jwk: keys.publicJwk, label: "X" } });
    const res = await apiFetch("/api/pair/finish", { body: { pairId: created.pairId, code: created.code } });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(JSON.stringify(body)).not.toContain("wrappedBlob");
  });

  it("approve requires a claim first, and only from the owner", async () => {
    const a = await createDevice();
    const stranger = await createDevice("S", "s");
    const created = await createPair(a);
    const oldKeys = await C.generateEcdhPair();
    expect((await apiFetch(`/api/pair/${created.pairId}/approve`, {
      token: a.token, body: { wrapped_blob: "x", old_pubkey: oldKeys.publicJwk },
    })).status).toBe(409); // not claimed yet
    expect((await apiFetch(`/api/pair/${created.pairId}/status`, { token: stranger.token })).status).toBe(404);
    expect((await apiFetch(`/api/pair/${created.pairId}/approve`, {
      token: stranger.token, body: { wrapped_blob: "x", old_pubkey: oldKeys.publicJwk },
    })).status).toBe(404);
  });

  it("unknown pairId → 404", async () => {
    const keys = await C.generateEcdhPair();
    expect((await apiFetch("/api/pair/claim", {
      body: { pairId: "01UNKNOWNPAIRID", code: "123456", pubkey_jwk: keys.publicJwk, label: "X" },
    })).status).toBe(404);
  });
});

// ── 護欄的不變量(2026-09-04 安全檢視)──────────────────────────────────
// 原本 verifyCode 是 read → compare → increment 三步分開,而且**猜對那次完全不寫入**,
// 所以 N 個並行猜測全都讀到 attempts = 0 —— 三次上限對併發等於不存在,而那三次正是
// 這個 6 位數碼唯一的保護。
//
// ⚠️ 老實說:下面第一條**在修好之前也是綠的**。vitest-pool-workers 的 D1 會把這批
// 請求序列化,所以這個 harness 重現不了那個競態。真正的保證來自程式改成「單一句
// 條件式 UPDATE 先原子地加次數並取回 code_hash」—— D1 的單一 statement 是原子的。
// 這條測試釘的是**不變量**(最多 3 個被當成「碼錯了」、撞頂就作廢),不是競態本身;
// 留著是為了擋住有人把它改回讀寫分離的版本。
// 第三條(claim after approve)才是真正的回歸測試:它在修好之前是紅的。
describe("3 次上限與單次使用的不變量", () => {
  it("同時送 10 個錯誤碼,不會全部都被受理(注意:harness 會序列化,見上方說明)", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const bad = wrongCode(created.code);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        apiFetch("/api/pair/claim", {
          method: "POST",
          body: { pairId: created.pairId, code: bad, pubkey_jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } },
        }),
      ),
    );
    // 每一個都必須被拒絕,而且最多 3 個是「碼錯了」,其餘一定是「已作廢」
    expect(results.every((r) => r.status === 403 || r.status === 410)).toBe(true);
    expect(results.filter((r) => r.status === 403).length).toBeLessThanOrEqual(C_MAX_ATTEMPTS);

    const row = await env.DB.prepare("SELECT * FROM pairings WHERE pair_id = ?")
      .bind(created.pairId).first<any>();
    expect(row.consumed_at).not.toBeNull(); // 撞到上限就作廢
  });

  it("正確的碼用兩次(claim + finish)不會吃光三次額度", async () => {
    const a = await createDevice();
    const b = await pairNewDevice(a, "Phone"); // 內部就是 claim → approve → finish
    expect(b.userId).toBe(a.userId);
  });

  it("已經有裝置加入之後,第二個人不能再 claim", async () => {
    const a = await createDevice();
    const created = await createPair(a);
    const kp = { kty: "EC", crv: "P-256", x: "x", y: "y" };
    const first = await apiFetch("/api/pair/claim", {
      method: "POST",
      body: { pairId: created.pairId, code: created.code, pubkey_jwk: kp },
    });
    expect(first.status).toBe(200);
    const second = await apiFetch("/api/pair/claim", {
      method: "POST",
      body: { pairId: created.pairId, code: created.code, pubkey_jwk: { ...kp, x: "attacker" } },
    });
    expect(second.status).toBe(409); // 覆寫 new_pubkey 就能換到有效的裝置 token
  });
});
