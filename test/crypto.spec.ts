// Client crypto (§5, §6.2) — exercises the exact module the PWA ships.
import { describe, expect, it } from "vitest";
import * as bip39 from "@scure/bip39";
import { wordlist as scureWordlist } from "@scure/bip39/wordlists/english.js";
import { C, td } from "./helpers";

describe("BIP39 recovery code (§6.2)", () => {
  it("uses the standard 2048-word English wordlist", async () => {
    const { WORDLIST } = await import("../public/js/wordlist.js");
    expect(WORDLIST).toHaveLength(2048);
    expect(WORDLIST).toEqual([...scureWordlist]);
  });

  it("derives 12 words from 128-bit entropy, matching the BIP39 reference", async () => {
    const entropy = C.generateEntropy();
    const words = await C.entropyToMnemonic(entropy);
    expect(words).toHaveLength(12);
    // Cross-check against the audited reference implementation.
    expect(words.join(" ")).toBe(bip39.entropyToMnemonic(entropy, scureWordlist));
  });

  it("round-trips mnemonic → entropy", async () => {
    const entropy = C.generateEntropy();
    const words = await C.entropyToMnemonic(entropy);
    expect(await C.mnemonicToEntropy(words)).toEqual(entropy);
  });

  it("accepts messy casing and whitespace", async () => {
    const entropy = C.generateEntropy();
    const words = await C.entropyToMnemonic(entropy);
    const messy = words.map((w: string, i: number) => (i % 2 ? ` ${w.toUpperCase()} ` : w));
    expect(await C.mnemonicToEntropy(messy)).toEqual(entropy);
  });

  it("detects a wrong word via checksum (§6.2: catch typos immediately)", async () => {
    const words = await C.entropyToMnemonic(C.generateEntropy());
    const tampered = [...words];
    tampered[3] = tampered[3] === "abandon" ? "zoo" : "abandon";
    await expect(C.mnemonicToEntropy(tampered)).rejects.toThrow();
  });

  it("rejects words outside the wordlist", async () => {
    const words = await C.entropyToMnemonic(C.generateEntropy());
    words[0] = "notaword";
    await expect(C.mnemonicToEntropy(words)).rejects.toThrow(/詞庫/);
  });

  it("autocompletes 4-letter prefixes uniquely", () => {
    // BIP39 guarantees 4-letter prefixes identify at most one word... per word.
    expect(C.wordCompletions("aban")).toEqual(["abandon"]);
    expect(C.wordCompletions("zo")).toContain("zoo");
    expect(C.wordCompletions("")).toEqual([]);
  });
});

describe("key derivation (§5.2)", () => {
  it("same entropy + name → same key; different name → different key", async () => {
    const entropy = C.generateEntropy();
    const k1 = await C.deriveKmaster(entropy, "clarence");
    const k2 = await C.deriveKmaster(entropy, "clarence");
    const k3 = await C.deriveKmaster(entropy, "someone-else");
    const env1 = await C.encryptTextEnvelope(k1, "hello");
    // k2 (same inputs) can decrypt; k3 (different salt) cannot.
    expect(await C.decryptTextEnvelope(k2, env1)).toBe("hello");
    await expect(C.decryptTextEnvelope(k3, env1)).rejects.toThrow();
  });
});

describe("envelope (§5.3)", () => {
  it("text envelope round-trips and has the spec shape", async () => {
    const k = await C.deriveKmaster(C.generateEntropy(), "u");
    const envl = await C.encryptTextEnvelope(k, "下午三點的會議改到會議室 B");
    expect(envl.v).toBe(1);
    expect(envl.kind).toBe("text");
    expect(envl.wrap.mode).toBe("self");
    expect(envl.obj).toBeNull();
    expect(envl.ct).toBeTypeOf("string");
    // Ciphertext must not contain the plaintext.
    expect(envl.ct).not.toContain("會議室");
    expect(await C.decryptTextEnvelope(k, envl)).toBe("下午三點的會議改到會議室 B");
  });

  it("every message gets a fresh CEK", async () => {
    const k = await C.deriveKmaster(C.generateEntropy(), "u");
    const a = await C.encryptTextEnvelope(k, "same text");
    const b = await C.encryptTextEnvelope(k, "same text");
    expect(a.wrap.cek).not.toBe(b.wrap.cek);
    expect(a.ct).not.toBe(b.ct);
  });

  it("file envelope encrypts body AND meta (name/mime are never plaintext)", async () => {
    const k = await C.deriveKmaster(C.generateEntropy(), "u");
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    const { envelope, ciphertext } = await C.encryptFileEnvelope(k, "USER1", bytes, "秘密文件.pdf", "application/pdf");
    expect(envelope.kind).toBe("file");
    expect(envelope.obj).toBe(`u/USER1/inbox/${envelope.id}`);
    expect(envelope.size).toBe(ciphertext.byteLength);
    expect(JSON.stringify(envelope)).not.toContain("秘密文件");
    expect(JSON.stringify(envelope)).not.toContain("pdf");
    const meta = await C.decryptFileMeta(k, envelope);
    expect(meta).toEqual({ name: "秘密文件.pdf", mime: "application/pdf" });
    expect(await C.decryptFileBody(k, envelope, ciphertext)).toEqual(bytes);
  });

  it("wrong key fails, never returns garbage", async () => {
    const k1 = await C.deriveKmaster(C.generateEntropy(), "u");
    const k2 = await C.deriveKmaster(C.generateEntropy(), "u");
    const envl = await C.encryptTextEnvelope(k1, "secret");
    await expect(C.decryptTextEnvelope(k2, envl)).rejects.toThrow();
  });
});

describe("pairing handshake crypto (§6.6)", () => {
  it("transfers a secret between two ephemeral ECDH pairs", async () => {
    const oldDev = await C.generateEcdhPair();
    const newDev = await C.generateEcdhPair();
    const secret = { entropy: C.b64u(C.generateEntropy()), userName: "clarence" };
    const blob = await C.wrapForPeer(oldDev.privateKey, newDev.publicJwk, secret);
    expect(blob).not.toContain(secret.entropy);
    const opened = await C.unwrapFromPeer(newDev.privateKey, oldDev.publicJwk, blob);
    expect(opened).toEqual(secret);
  });

  it("a third party cannot unwrap", async () => {
    const oldDev = await C.generateEcdhPair();
    const newDev = await C.generateEcdhPair();
    const attacker = await C.generateEcdhPair();
    const blob = await C.wrapForPeer(oldDev.privateKey, newDev.publicJwk, { s: 1 });
    await expect(C.unwrapFromPeer(attacker.privateKey, oldDev.publicJwk, blob)).rejects.toThrow();
  });
});

describe("text kind detection (§7.2.1: https:// whitelist)", () => {
  it("single https URL → open action", () => {
    expect(C.detectTextKind("  https://example.com/spec  ")).toEqual({ kind: "url", url: "https://example.com/spec" });
  });
  it("http, javascript:, data: are plain text — whitelist, not blacklist", () => {
    expect(C.detectTextKind("http://example.com").kind).toBe("text");
    expect(C.detectTextKind("javascript:alert(1)").kind).toBe("text");
    expect(C.detectTextKind("data:text/html,hi").kind).toBe("text");
  });
  it("text containing URLs lists them", () => {
    const d = C.detectTextKind("看這兩個 https://a.example/1 和 https://b.example/2");
    expect(d.kind).toBe("text-with-urls");
    expect(d.urls).toEqual(["https://a.example/1", "https://b.example/2"]);
  });
  it("plain text stays plain", () => {
    expect(C.detectTextKind("買牛奶")).toEqual({ kind: "text" });
  });
});
