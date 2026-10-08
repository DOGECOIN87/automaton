/**
 * Solana Attestation Tests
 *
 * Tests that:
 * 1. buildAttestationMemo produces a signed, well-formed memo
 * 2. parseAttestationMemo validates shape and type
 * 3. verifyAttestationSignature accepts valid memos and rejects tampered ones
 * 4. sha256Hex is deterministic
 * 5. extractMemoFromTransaction pulls the memo out of a parsed transaction
 * 6. parseUsdcAmount handles decimals and raw base units
 * 7. findAssociatedTokenAddress derives deterministic ATAs
 *
 * Network-touching functions (publishAttestation, discoverAttestations,
 * queryAgent, hasRegisteredAgent) are NOT unit-tested here — they need an
 * RPC endpoint and are covered by integration checks instead.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { SolanaChainIdentity } from "../identity/chain.js";
import {
  ATTESTATION_MEMO_TYPE,
  MEMO_PROGRAM_ID,
  buildAttestationMemo,
  parseAttestationMemo,
  verifyAttestationSignature,
  sha256Hex,
  extractMemoFromTransaction,
  buildFeedbackMemo,
} from "../registry/solana-attestation.js";
import {
  parseUsdcAmount,
  findAssociatedTokenAddress,
  SOLANA_USDC_MINT,
} from "../conway/x402.js";

function makeIdentity(): SolanaChainIdentity {
  return new SolanaChainIdentity(nacl.sign.keyPair().secretKey);
}

describe("buildAttestationMemo", () => {
  it("builds a well-formed signed memo", async () => {
    const identity = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    expect(memo.type).toBe(ATTESTATION_MEMO_TYPE);
    expect(memo.name).toBe("test-agent");
    expect(memo.wallet).toBe(identity.address);
    expect(memo.cardHash).toBe("ab".repeat(32));
    expect(memo.agentUri).toBe("https://example.com/agent-card.json");
    expect(memo.timestamp).toBeTruthy();
    expect(bs58.decode(memo.signature).length).toBe(64);
  });
});

describe("parseAttestationMemo", () => {
  it("parses a memo built by buildAttestationMemo", async () => {
    const identity = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    const parsed = parseAttestationMemo(JSON.stringify(memo));
    expect(parsed).not.toBeNull();
    expect(parsed!.wallet).toBe(identity.address);
  });

  it("rejects memos with the wrong type", () => {
    expect(
      parseAttestationMemo(JSON.stringify({ type: "something-else", name: "x" })),
    ).toBeNull();
  });

  it("rejects memos with missing fields", () => {
    expect(
      parseAttestationMemo(
        JSON.stringify({ type: ATTESTATION_MEMO_TYPE, name: "x" }),
      ),
    ).toBeNull();
  });

  it("rejects non-JSON", () => {
    expect(parseAttestationMemo("not json at all")).toBeNull();
  });
});

describe("verifyAttestationSignature", () => {
  it("accepts a genuinely signed memo", async () => {
    const identity = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    expect(verifyAttestationSignature(memo)).toBe(true);
  });

  it("rejects a memo with a tampered wallet", async () => {
    const identity = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    const tampered = {
      ...memo,
      wallet: bs58.encode(nacl.sign.keyPair().publicKey),
    };
    expect(verifyAttestationSignature(tampered)).toBe(false);
  });

  it("rejects a memo with tampered content", async () => {
    const identity = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    const tampered = { ...memo, name: "evil-agent" };
    expect(verifyAttestationSignature(tampered)).toBe(false);
  });

  it("rejects a memo signed by a different key", async () => {
    const identity = makeIdentity();
    const other = makeIdentity();
    const memo = await buildAttestationMemo(identity, {
      name: "test-agent",
      cardHash: "ab".repeat(32),
      agentUri: "https://example.com/agent-card.json",
    });

    // Re-sign nothing — claim the other wallet with the original signature
    const forged = { ...memo, wallet: other.address };
    expect(verifyAttestationSignature(forged)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and 64 hex chars", () => {
    const a = sha256Hex("hello");
    const b = sha256Hex("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("hello")).not.toBe(sha256Hex("world"));
  });
});

describe("extractMemoFromTransaction", () => {
  it("extracts the memo from a memo-program instruction", () => {
    const memoText = JSON.stringify({ type: ATTESTATION_MEMO_TYPE, x: 1 });
    const tx: any = {
      transaction: {
        message: {
          instructions: [
            {
              programId: MEMO_PROGRAM_ID,
              data: Buffer.from(memoText, "utf8").toString("base64"),
            },
          ],
        },
      },
    };
    expect(extractMemoFromTransaction(tx)).toBe(memoText);
  });

  it("returns null when no memo instruction is present", () => {
    const tx: any = {
      transaction: {
        message: {
          instructions: [
            {
              programId: "11111111111111111111111111111111",
              data: Buffer.from("hello", "utf8").toString("base64"),
            },
          ],
        },
      },
    };
    expect(extractMemoFromTransaction(tx)).toBeNull();
    expect(extractMemoFromTransaction(null)).toBeNull();
  });
});

describe("parseUsdcAmount", () => {
  it("parses decimal USDC into 6-decimal base units", () => {
    expect(parseUsdcAmount("5", 1)).toBe(5_000_000n);
    expect(parseUsdcAmount("5.25", 1)).toBe(5_250_000n);
    expect(parseUsdcAmount("0.000001", 2)).toBe(1n);
  });

  it("treats long digit strings as raw base units on x402 v2", () => {
    expect(parseUsdcAmount("5000000", 2)).toBe(5_000_000n);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdcAmount("abc", 1)).toThrow("Invalid maxAmountRequired");
    expect(() => parseUsdcAmount("-5", 1)).toThrow("Invalid maxAmountRequired");
  });
});

describe("findAssociatedTokenAddress", () => {
  it("derives a deterministic ATA", () => {
    const owner = new PublicKey(bs58.encode(nacl.sign.keyPair().publicKey));
    const mint = new PublicKey(SOLANA_USDC_MINT);
    const ata1 = findAssociatedTokenAddress(owner, mint);
    const ata2 = findAssociatedTokenAddress(owner, mint);
    expect(ata1.equals(ata2)).toBe(true);
    expect(ata1.toBase58()).toBeTruthy();
  });

  it("derives different ATAs for different owners", () => {
    const mint = new PublicKey(SOLANA_USDC_MINT);
    const ownerA = new PublicKey(bs58.encode(nacl.sign.keyPair().publicKey));
    const ownerB = new PublicKey(bs58.encode(nacl.sign.keyPair().publicKey));
    expect(
      findAssociatedTokenAddress(ownerA, mint).equals(
        findAssociatedTokenAddress(ownerB, mint),
      ),
    ).toBe(false);
  });
});

describe("buildFeedbackMemo", () => {
  it("builds a feedback memo referencing the target attestation", async () => {
    const identity = makeIdentity();
    const memo = await buildFeedbackMemo(identity, {
      targetAgentId: "somesignature",
      score: 4,
      comment: "solid agent",
    });
    expect(memo.type).toBe("conway-agent-feedback");
    expect(memo.targetAgentId).toBe("somesignature");
    expect(memo.score).toBe(4);
    expect(memo.fromWallet).toBe(identity.address);
  });
});
