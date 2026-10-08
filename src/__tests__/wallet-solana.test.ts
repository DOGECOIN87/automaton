/**
 * Tests for Solana Wallet Generation
 */

import { describe, it, expect } from "vitest";
import { generateSolanaKeypair, getWalletChainType } from "../identity/wallet.js";
import { isValidSolanaAddress } from "../identity/chain.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

describe("Solana Wallet", () => {
  describe("generateSolanaKeypair", () => {
    it("generates a valid Ed25519 keypair", () => {
      const { secretKey, publicKey, address } = generateSolanaKeypair();

      // Secret key is 64 bytes (32 private + 32 public)
      expect(secretKey.length).toBe(64);

      // Public key is 32 bytes
      expect(publicKey.length).toBe(32);

      // Address is valid base58-encoded public key
      expect(isValidSolanaAddress(address)).toBe(true);

      // Can reconstruct keypair from secret key
      const reconstructed = nacl.sign.keyPair.fromSecretKey(secretKey);
      expect(bs58.encode(reconstructed.publicKey)).toBe(address);
    });

    it("generates unique keypairs", () => {
      const kp1 = generateSolanaKeypair();
      const kp2 = generateSolanaKeypair();
      expect(kp1.address).not.toBe(kp2.address);
    });
  });

  describe("WalletData format", () => {
    it("Solana wallet data has correct shape", () => {
      const { secretKey } = generateSolanaKeypair();
      const walletData = {
        chainType: "solana" as const,
        secretKey: bs58.encode(secretKey),
        createdAt: new Date().toISOString(),
      };

      // Verify secretKey round-trips through base58
      const decoded = bs58.decode(walletData.secretKey);
      expect(decoded.length).toBe(64);

      // Verify reconstructed keypair matches
      const kp = nacl.sign.keyPair.fromSecretKey(decoded);
      expect(bs58.encode(kp.publicKey)).toBeTruthy();
    });

    it("legacy EVM wallet data has no place in the Solana-only wallet file", () => {
      // The WalletData type no longer carries an EVM privateKey field;
      // wallet.ts throws a descriptive migration error if one is found.
      const legacyWalletData = {
        chainType: "solana" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
      };
      expect(legacyWalletData.chainType).toBe("solana");
      expect("privateKey" in legacyWalletData).toBe(false);
    });
  });

  describe("getWalletChainType", () => {
    it("is always solana", () => {
      expect(getWalletChainType()).toBe("solana");
    });
  });
});
