/**
 * Tests for the dedicated funding wallet module.
 *
 * The funding wallet is the ONLY source of per-child SOL. These tests cover
 * the offline parts: CHILD_FUND_SOL parsing, secret parsing, and loading
 * from env. RPC-touching functions (balance checks, transfers) are not
 * unit-tested — they need a live RPC.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getChildFundSol,
  getChildFundLamports,
  loadFundingWallet,
  DEFAULT_CHILD_FUND_SOL,
} from "../solana/funding-wallet.js";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CHILD_FUND_SOL;
  delete process.env.FUNDING_WALLET_SECRET;
  delete process.env.FUNDING_WALLET_PATH;
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("getChildFundSol", () => {
  it("defaults to 0.05 SOL", () => {
    expect(getChildFundSol()).toBe(DEFAULT_CHILD_FUND_SOL);
    expect(DEFAULT_CHILD_FUND_SOL).toBe(0.05);
  });

  it("reads CHILD_FUND_SOL from env", () => {
    process.env.CHILD_FUND_SOL = "0.1";
    expect(getChildFundSol()).toBe(0.1);
  });

  it("falls back to default on invalid values", () => {
    for (const bad of ["abc", "-1", "0", "999", ""]) {
      process.env.CHILD_FUND_SOL = bad;
      expect(getChildFundSol()).toBe(DEFAULT_CHILD_FUND_SOL);
    }
  });
});

describe("getChildFundLamports", () => {
  it("converts the default to 50,000,000 lamports", () => {
    expect(getChildFundLamports()).toBe(50_000_000);
  });
});

describe("loadFundingWallet", () => {
  it("returns null when nothing is configured", () => {
    // Point the file path at nothing — the repo's own deploy/ dir must not leak in.
    process.env.FUNDING_WALLET_PATH = "/nonexistent-dir/funding-wallet.json";
    expect(loadFundingWallet()).toBeNull();
  });

  it("loads a JSON-array secret from FUNDING_WALLET_SECRET", () => {
    const kp = Keypair.generate();
    process.env.FUNDING_WALLET_SECRET = JSON.stringify(Array.from(kp.secretKey));
    const wallet = loadFundingWallet();
    expect(wallet).not.toBeNull();
    expect(wallet!.address).toBe(kp.publicKey.toBase58());
  });

  it("loads a base58 secret from FUNDING_WALLET_SECRET", () => {
    const kp = Keypair.generate();
    process.env.FUNDING_WALLET_SECRET = bs58.encode(kp.secretKey);
    const wallet = loadFundingWallet();
    expect(wallet).not.toBeNull();
    expect(wallet!.address).toBe(kp.publicKey.toBase58());
  });

  it("returns null on a malformed secret instead of throwing", () => {
    process.env.FUNDING_WALLET_SECRET = "not-valid-base58!!!";
    expect(loadFundingWallet()).toBeNull();
  });
});
