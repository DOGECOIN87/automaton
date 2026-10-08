/**
 * Tests for Chain Abstraction Layer — Solana Only
 */

import { describe, it, expect } from "vitest";
import {
  detectChainType,
  isValidSolanaAddress,
  isValidAddress,
  normalizeAddress,
  SolanaChainIdentity,
} from "../identity/chain.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

function randomSolanaAddress(): string {
  return bs58.encode(nacl.sign.keyPair().publicKey);
}

describe("Chain Abstraction (Solana-only)", () => {
  describe("isValidSolanaAddress", () => {
    it("accepts valid Solana addresses", () => {
      expect(isValidSolanaAddress(randomSolanaAddress())).toBe(true);
      // Well-known program addresses are valid too
      expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
    });

    it("rejects invalid addresses", () => {
      expect(isValidSolanaAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(false);
      expect(isValidSolanaAddress("")).toBe(false);
      expect(isValidSolanaAddress("short")).toBe(false);
      // base58 excludes 0, O, I, l
      expect(isValidSolanaAddress("0".repeat(44))).toBe(false);
    });
  });

  describe("isValidAddress", () => {
    it("validates Solana addresses", () => {
      const addr = randomSolanaAddress();
      expect(isValidAddress(addr)).toBe(true);
      expect(isValidAddress(addr, "solana")).toBe(true);
      expect(isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28", "solana")).toBe(false);
      expect(isValidAddress("not-an-address")).toBe(false);
    });
  });

  describe("detectChainType", () => {
    it("detects Solana addresses", () => {
      expect(detectChainType(randomSolanaAddress())).toBe("solana");
    });

    it("returns null for invalid addresses (including EVM-style)", () => {
      expect(detectChainType("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(null);
      expect(detectChainType("invalid")).toBe(null);
      expect(detectChainType("")).toBe(null);
    });
  });

  describe("normalizeAddress", () => {
    it("preserves Solana addresses exactly (case-sensitive, no lowercasing)", () => {
      const addr = "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
      expect(normalizeAddress(addr, "solana")).toBe(addr);
      expect(normalizeAddress(addr)).toBe(addr);
      // Mixed case must NOT be lowercased
      const mixed = "4uQeVj5tqViQh7yA8kLXx1cJ9mZ2nB3vC4dE5fG6hJ7";
      expect(normalizeAddress(mixed)).toBe(mixed);
    });
  });

  describe("SolanaChainIdentity", () => {
    it("wraps a tweetnacl keypair", async () => {
      const keypair = nacl.sign.keyPair();
      const identity = new SolanaChainIdentity(keypair.secretKey);

      expect(identity.chainType).toBe("solana");
      expect(identity.address).toBe(bs58.encode(keypair.publicKey));

      const sig = await identity.signMessage("test");
      // Verify the signature is valid base58
      const sigBytes = bs58.decode(sig);
      expect(sigBytes.length).toBe(64);

      // Verify the signature
      const msgBytes = new TextEncoder().encode("test");
      const valid = nacl.sign.detached.verify(msgBytes, sigBytes, keypair.publicKey);
      expect(valid).toBe(true);
    });

    it("signBytes returns a raw 64-byte signature over raw bytes", async () => {
      const keypair = nacl.sign.keyPair();
      const identity = new SolanaChainIdentity(keypair.secretKey);

      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const sig = await identity.signBytes(bytes);
      expect(sig.length).toBe(64);
      expect(nacl.sign.detached.verify(bytes, sig, keypair.publicKey)).toBe(true);
    });
  });
});
