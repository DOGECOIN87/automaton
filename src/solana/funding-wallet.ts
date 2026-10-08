/**
 * Funding Wallet — Solana-Only
 *
 * Matt personally funds ONE dedicated funding wallet. Every spawned child
 * agent receives a small amount of SOL from it (CHILD_FUND_SOL, default 0.005).
 * Spawn REFUSES to proceed when the funding wallet is missing or its balance
 * cannot cover the child's allocation plus a fee buffer.
 *
 * Loading (in order):
 *   1. FUNDING_WALLET_SECRET env — secret-key bytes as a JSON array
 *      ("[1,2,3,...]") or a base58-encoded string. Preferred in hosted envs.
 *   2. FUNDING_WALLET_PATH env, default "<repo-root>/deploy/funding-wallet.json"
 *      — the file generated during deploy prep (0600, gitignored, never committed).
 *
 * The secret key is used ONLY to sign the child-funding transfer and is never
 * logged, persisted, or sent anywhere.
 */

import fs from "fs";
import path from "path";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getSolanaRpcUrl, getSolanaCommitment } from "../config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("solana.funding-wallet");

/** Default per-child SOL allocation when CHILD_FUND_SOL is unset/invalid. */
export const DEFAULT_CHILD_FUND_SOL = 0.005;

/** Lamports reserved for the funding transaction fee on top of the allocation. */
export const FUNDING_FEE_BUFFER_LAMPORTS = 10_000; // 0.00001 SOL — generous for one transfer

export interface FundingWallet {
  keypair: Keypair;
  address: string;
}

function resolveDefaultPath(): string {
  // src/solana/funding-wallet.ts compiled to dist/solana/funding-wallet.js —
  // walk up to the repo root in both layouts.
  const here = new URL(import.meta.url).pathname;
  const distLayout = path.resolve(path.dirname(here), "..", "..", "deploy", "funding-wallet.json");
  if (fs.existsSync(distLayout)) return distLayout;
  return path.resolve(process.cwd(), "deploy", "funding-wallet.json");
}

/**
 * Load the funding wallet. Returns null when not configured — callers must
 * treat that as "cannot spawn children" and say so clearly.
 */
export function loadFundingWallet(): FundingWallet | null {
  try {
    const envSecret = process.env.FUNDING_WALLET_SECRET;
    if (envSecret && envSecret.trim()) {
      const secret = parseSecret(envSecret.trim());
      const keypair = Keypair.fromSecretKey(secret);
      return { keypair, address: keypair.publicKey.toBase58() };
    }

    const filePath = process.env.FUNDING_WALLET_PATH || resolveDefaultPath();
    if (fs.existsSync(filePath)) {
      const secret = parseSecret(fs.readFileSync(filePath, "utf-8").trim());
      const keypair = Keypair.fromSecretKey(secret);
      return { keypair, address: keypair.publicKey.toBase58() };
    }
  } catch (err: any) {
    logger.error(`Failed to load funding wallet: ${err?.message ?? err}`);
    return null;
  }
  return null;
}

function parseSecret(raw: string): Uint8Array {
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("FUNDING_WALLET secret is not a JSON array");
    return Uint8Array.from(arr);
  }
  // base58-encoded secret key
  return bs58.decode(raw);
}

/** Per-child SOL allocation from CHILD_FUND_SOL env (default 0.005). */
export function getChildFundSol(): number {
  const raw = process.env.CHILD_FUND_SOL;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 10) return n;
    logger.warn(`Invalid CHILD_FUND_SOL=${JSON.stringify(raw)} — using default ${DEFAULT_CHILD_FUND_SOL}`);
  }
  return DEFAULT_CHILD_FUND_SOL;
}

/** Lamports for one child allocation. */
export function getChildFundLamports(): number {
  return Math.round(getChildFundSol() * LAMPORTS_PER_SOL);
}

/** Live SOL balance of the funding wallet. */
export async function getFundingWalletBalanceLamports(
  address: string,
  rpcUrl?: string,
): Promise<number> {
  const connection = new Connection(rpcUrl || getSolanaRpcUrl(), getSolanaCommitment());
  return connection.getBalance(new PublicKey(address), getSolanaCommitment());
}

export interface FundingSufficiency {
  ok: boolean;
  balanceLamports: number;
  requiredLamports: number;
  childFundSol: number;
  message: string;
}

/**
 * Check the funding wallet can cover `childCount` child allocations plus fees.
 * Never throws on RPC failure — reports not-ok so the caller refuses safely.
 */
export async function checkFundingWalletSufficient(
  childCount = 1,
): Promise<FundingSufficiency> {
  const wallet = loadFundingWallet();
  const childFundLamports = getChildFundLamports();
  const requiredLamports = childFundLamports * childCount + FUNDING_FEE_BUFFER_LAMPORTS;

  if (!wallet) {
    return {
      ok: false,
      balanceLamports: 0,
      requiredLamports,
      childFundSol: getChildFundSol(),
      message:
        "Funding wallet is not configured (no FUNDING_WALLET_SECRET and no deploy/funding-wallet.json). " +
        "See DEPLOY.md — fund the funding wallet before spawning children.",
    };
  }

  let balanceLamports = 0;
  try {
    balanceLamports = await getFundingWalletBalanceLamports(wallet.address);
  } catch (err: any) {
    return {
      ok: false,
      balanceLamports: 0,
      requiredLamports,
      childFundSol: getChildFundSol(),
      message: `Could not read funding wallet balance (${wallet.address}): ${err?.message ?? err}. Refusing to spawn.`,
    };
  }

  if (balanceLamports < requiredLamports) {
    const have = (balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
    const need = (requiredLamports / LAMPORTS_PER_SOL).toFixed(6);
    return {
      ok: false,
      balanceLamports,
      requiredLamports,
      childFundSol: getChildFundSol(),
      message:
        `Funding wallet ${wallet.address} holds ${have} SOL — needs ${need} SOL ` +
        `(${getChildFundSol()} SOL per child x ${childCount} + fee buffer). ` +
        "Send SOL to the funding wallet (see DEPLOY.md step 'Fund the funding wallet') before spawning.",
    };
  }

  return {
    ok: true,
    balanceLamports,
    requiredLamports,
    childFundSol: getChildFundSol(),
    message: `Funding wallet ${wallet.address}: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL — sufficient.`,
  };
}

/**
 * Transfer the per-child SOL allocation from the funding wallet to a child
 * address. Signs with the funding keypair (never leaves this process).
 * Returns the transaction signature.
 */
export async function fundChildFromFundingWallet(
  childAddress: string,
  rpcUrl?: string,
): Promise<string> {
  const wallet = loadFundingWallet();
  if (!wallet) {
    throw new Error("Funding wallet is not configured — cannot fund child. See DEPLOY.md.");
  }
  const lamports = getChildFundLamports();
  const connection = new Connection(rpcUrl || getSolanaRpcUrl(), getSolanaCommitment());
  const commitment = getSolanaCommitment();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const tx = new Transaction({
    feePayer: wallet.keypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(
    SystemProgram.transfer({
      fromPubkey: wallet.keypair.publicKey,
      toPubkey: new PublicKey(childAddress),
      lamports,
    }),
  );
  tx.sign(wallet.keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: commitment,
  });
  logger.info(
    `Funded child ${childAddress} with ${getChildFundSol()} SOL from funding wallet ${wallet.address}: ${sig}`,
  );
  return sig;
}
