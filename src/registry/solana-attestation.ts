/**
 * Solana-Native Identity Attestation
 *
 * The Solana equivalent of ERC-8004 on-chain agent registration.
 *
 * ERC-8004 is an EVM-only standard (it lives on Base). On Solana there is
 * no agent-registry contract, so identity is attested a different way: the
 * automaton publishes a MEMO TRANSACTION from its own wallet via the
 * Solana Memo program. The memo carries a signed JSON attestation:
 *
 *   {
 *     "type": "conway-agent-attestation",
 *     "name": "<agent name>",
 *     "wallet": "<base58 wallet address>",
 *     "cardHash": "<sha256 hex of the agent card>",
 *     "agentUri": "<agent card URI>",
 *     "timestamp": "<iso8601>",
 *     "signature": "<base58 ed25519 signature over the canonical memo>"
 *   }
 *
 * The memo is embedded in a transaction signed by the wallet key, so the
 * attestation is self-authenticating: anyone can fetch the transaction,
 * read the memo, and verify the signature against the wallet address.
 * Attestations are append-only — an update is a new memo that supersedes
 * older ones (highest timestamp wins).
 *
 * Memo program: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
 *
 * Discovery: recent attestations are found by scanning signatures that
 * reference the Memo program (getSignaturesForAddress on the program id)
 * and filtering for memos of type "conway-agent-attestation".
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { ChainIdentity } from "../identity/chain.js";
import type {
  RegistryEntry,
  DiscoveredAgent,
  AutomatonDatabase,
} from "../types.js";
import { getSolanaRpcUrl } from "../config.js";

const logger = createLogger("registry.attestation");

/** Solana Memo program id. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export const ATTESTATION_MEMO_TYPE = "conway-agent-attestation";
export const FEEDBACK_MEMO_TYPE = "conway-agent-feedback";

export const SOLANA_CHAIN_ID = "solana:mainnet";

// Note: some read methods (getSignaturesForAddress, getParsedTransaction)
// type their commitment as Finality ("confirmed" | "finalized"), so
// "processed" is mapped to "confirmed" here.
function resolveCommitment(): "confirmed" | "finalized" {
  const c = process.env.SOLANA_COMMITMENT;
  return c === "finalized" ? "finalized" : "confirmed";
}

function getConnection(rpcUrl?: string): Connection {
  // All chain traffic routes through Helius when HELIUS_API_KEY is set.
  return new Connection(rpcUrl || getSolanaRpcUrl(), resolveCommitment());
}

// ─── Memo construction / parsing (pure, offline-testable) ───────

export interface AttestationMemo {
  type: typeof ATTESTATION_MEMO_TYPE;
  name: string;
  wallet: string;
  cardHash: string;
  agentUri: string;
  timestamp: string;
  signature: string;
}

export interface FeedbackMemo {
  type: typeof FEEDBACK_MEMO_TYPE;
  fromWallet: string;
  targetAgentId: string;
  score: number;
  comment: string;
  timestamp: string;
  signature: string;
}

/** sha256 hex digest — the Solana-side replacement for keccak256 card hashes. */
export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Canonical bytes that get signed: the memo JSON without the signature field,
 * keys sorted for determinism.
 */
function canonicalAttestationBytes(memo: Omit<AttestationMemo, "signature">): Uint8Array {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(memo).sort()) {
    ordered[k] = (memo as Record<string, string>)[k];
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Build a signed attestation memo for the given agent card.
 * Pure except for the ed25519 signature from the identity.
 */
export async function buildAttestationMemo(
  identity: ChainIdentity,
  params: { name: string; cardHash: string; agentUri: string; timestamp?: string },
): Promise<AttestationMemo> {
  const unsigned: Omit<AttestationMemo, "signature"> = {
    type: ATTESTATION_MEMO_TYPE,
    name: params.name,
    wallet: identity.address,
    cardHash: params.cardHash,
    agentUri: params.agentUri,
    timestamp: params.timestamp || new Date().toISOString(),
  };
  const sigBytes = await identity.signBytes(canonicalAttestationBytes(unsigned));
  return { ...unsigned, signature: bs58.encode(sigBytes) };
}

/**
 * Parse and validate an attestation memo string. Returns null when the
 * memo is not a well-formed attestation (wrong type, missing fields).
 * Signature validity is checked separately by verifyAttestationSignature.
 */
export function parseAttestationMemo(memo: string): AttestationMemo | null {
  let data: unknown;
  try {
    data = JSON.parse(memo);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== ATTESTATION_MEMO_TYPE) return null;
  for (const f of ["name", "wallet", "cardHash", "agentUri", "timestamp", "signature"]) {
    if (typeof m[f] !== "string" || !(m[f] as string)) return null;
  }
  return m as unknown as AttestationMemo;
}

/**
 * Verify the ed25519 signature inside an attestation memo against the
 * wallet address it claims. Offline.
 */
export function verifyAttestationSignature(memo: AttestationMemo): boolean {
  try {
    const { signature, ...unsigned } = memo;
    const sigBytes = bs58.decode(signature);
    const walletBytes = bs58.decode(memo.wallet);
    if (sigBytes.length !== 64 || walletBytes.length !== 32) return false;
    return nacl.sign.detached.verify(
      canonicalAttestationBytes(unsigned as Omit<AttestationMemo, "signature">),
      sigBytes,
      walletBytes,
    );
  } catch {
    return false;
  }
}

/**
 * Build a signed feedback memo (Solana-native replacement for
 * ERC-8004 leaveFeedback). References the target attestation id.
 */
export async function buildFeedbackMemo(
  identity: ChainIdentity,
  params: { targetAgentId: string; score: number; comment: string; timestamp?: string },
): Promise<FeedbackMemo> {
  if (!Number.isInteger(params.score) || params.score < 1 || params.score > 5) {
    throw new Error(`Invalid score: ${params.score}. Must be an integer between 1 and 5.`);
  }
  if (params.comment.length > 500) {
    throw new Error(`Comment too long: ${params.comment.length} chars (max 500).`);
  }
  const unsigned: Omit<FeedbackMemo, "signature"> = {
    type: FEEDBACK_MEMO_TYPE,
    fromWallet: identity.address,
    targetAgentId: params.targetAgentId,
    score: params.score,
    comment: params.comment,
    timestamp: params.timestamp || new Date().toISOString(),
  };
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(unsigned).sort()) {
    ordered[k] = (unsigned as Record<string, unknown>)[k];
  }
  const sigBytes = await identity.signBytes(
    new TextEncoder().encode(JSON.stringify(ordered)),
  );
  return { ...unsigned, signature: bs58.encode(sigBytes) };
}

// ─── Transaction logging ────────────────────────────────────────

function logTransaction(
  rawDb: import("better-sqlite3").Database | undefined,
  txHash: string,
  chain: string,
  operation: string,
  status: "pending" | "confirmed" | "failed",
  metadata?: Record<string, unknown>,
): void {
  if (!rawDb) return;
  try {
    rawDb
      .prepare(
        `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, gas_used, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        txHash,
        chain,
        operation,
        status,
        null,
        JSON.stringify(metadata ?? {}),
      );
  } catch (error) {
    logger.error(
      "Transaction log failed:",
      error instanceof Error ? error : undefined,
    );
  }
}

// ─── Publishing ─────────────────────────────────────────────────

/**
 * Publish an attestation memo transaction from the agent's wallet.
 * Returns the transaction signature (= the attestation id).
 */
export async function publishAttestation(
  identity: ChainIdentity,
  params: { name: string; cardHash: string; agentUri: string },
  db?: AutomatonDatabase,
  rpcUrl?: string,
  connection?: Connection,
): Promise<{ signature: string; memo: AttestationMemo }> {
  const conn = connection ?? getConnection(rpcUrl);
  const memo = await buildAttestationMemo(identity, params);
  const memoString = JSON.stringify(memo);

  const payer = new PublicKey(identity.address);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    resolveCommitment(),
  );

  const tx = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from(memoString, "utf8"),
    }),
  );

  const signatureBytes = await identity.signBytes(tx.compileMessage().serialize());
  tx.addSignature(payer, Buffer.from(signatureBytes));
  const rawTx = tx.serialize({ requireAllSignatures: false });

  const signature = await conn.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: resolveCommitment(),
  });

  logTransaction(db?.raw, signature, SOLANA_CHAIN_ID, "attest", "pending", {
    agentUri: params.agentUri,
    cardHash: params.cardHash,
  });

  return { signature, memo };
}

/**
 * Register the automaton on-chain via a Solana attestation memo.
 * Returns a RegistryEntry (agentId = attestation transaction signature).
 */
export async function registerAgent(
  identity: ChainIdentity,
  agentURI: string,
  db: AutomatonDatabase,
  params?: { name?: string; rpcUrl?: string },
): Promise<RegistryEntry> {
  const name = params?.name || "automaton";
  const cardHash = sha256Hex(agentURI);

  const { signature } = await publishAttestation(
    identity,
    { name, cardHash, agentUri: agentURI },
    db,
    params?.rpcUrl,
  );

  const entry: RegistryEntry = {
    agentId: signature,
    agentURI,
    chain: SOLANA_CHAIN_ID,
    contractAddress: MEMO_PROGRAM_ID,
    txHash: signature,
    registeredAt: new Date().toISOString(),
  };

  db.setRegistryEntry(entry);
  return entry;
}

/**
 * Update the agent's URI on-chain. Attestations are append-only, so an
 * update publishes a new memo that supersedes the old one.
 * Returns the new attestation transaction signature.
 */
export async function updateAgentURI(
  identity: ChainIdentity,
  newAgentURI: string,
  db: AutomatonDatabase,
  params?: { name?: string; rpcUrl?: string },
): Promise<string> {
  const name = params?.name || "automaton";
  const cardHash = sha256Hex(newAgentURI);

  const { signature } = await publishAttestation(
    identity,
    { name, cardHash, agentUri: newAgentURI },
    db,
    params?.rpcUrl,
  );

  logTransaction(db?.raw, signature, SOLANA_CHAIN_ID, "updateAgentURI", "pending", {
    newAgentURI,
  });

  const entry = db.getRegistryEntry();
  if (entry) {
    entry.agentId = signature;
    entry.agentURI = newAgentURI;
    entry.txHash = signature;
    db.setRegistryEntry(entry);
  }

  return signature;
}

/**
 * Leave reputation feedback for another agent as a signed memo.
 * Solana-native replacement for ERC-8004 leaveFeedback.
 */
export async function leaveFeedback(
  identity: ChainIdentity,
  targetAgentId: string,
  score: number,
  comment: string,
  db?: AutomatonDatabase,
  rpcUrl?: string,
  connection?: Connection,
): Promise<string> {
  const conn = connection ?? getConnection(rpcUrl);
  const memo = await buildFeedbackMemo(identity, { targetAgentId, score, comment });
  const memoString = JSON.stringify(memo);

  const payer = new PublicKey(identity.address);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    resolveCommitment(),
  );

  const tx = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from(memoString, "utf8"),
    }),
  );

  const signatureBytes = await identity.signBytes(tx.compileMessage().serialize());
  tx.addSignature(payer, Buffer.from(signatureBytes));

  const signature = await conn.sendRawTransaction(
    tx.serialize({ requireAllSignatures: false }),
    { skipPreflight: false, preflightCommitment: resolveCommitment() },
  );

  logTransaction(db?.raw, signature, SOLANA_CHAIN_ID, "leaveFeedback", "pending", {
    targetAgentId,
    score,
  });

  return signature;
}

// ─── Reading ────────────────────────────────────────────────────

/**
 * Extract the memo string from a parsed transaction, if it contains a
 * Memo-program instruction.
 */
export function extractMemoFromTransaction(
  tx: { transaction?: { message?: { instructions?: { programId?: unknown; data?: string }[] } } } | null | undefined,
): string | null {
  try {
    const instructions = tx?.transaction?.message?.instructions;
    if (!instructions) return null;
    for (const ix of instructions) {
      const programId = typeof ix.programId === "string"
        ? ix.programId
        : (ix.programId as { toBase58?: () => string })?.toBase58?.();
      if (programId === MEMO_PROGRAM_ID && typeof ix.data === "string") {
        return Buffer.from(ix.data, "base64").toString("utf8");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query a single attestation by its transaction signature.
 */
export async function queryAgent(
  agentId: string,
  rpcUrl?: string,
  connection?: Connection,
): Promise<DiscoveredAgent | null> {
  const conn = connection ?? getConnection(rpcUrl);
  try {
    const tx = await conn.getParsedTransaction(agentId, {
      commitment: resolveCommitment(),
      maxSupportedTransactionVersion: 0,
    });
    const memoString = extractMemoFromTransaction(tx as never);
    if (!memoString) return null;
    const memo = parseAttestationMemo(memoString);
    if (!memo || !verifyAttestationSignature(memo)) return null;

    return {
      agentId,
      owner: memo.wallet,
      agentURI: memo.agentUri,
    };
  } catch {
    return null;
  }
}

/**
 * Discover recent agent attestations by scanning signatures that reference
 * the Memo program, newest first, filtering for attestation memos.
 */
export async function discoverAttestations(
  limit: number = 20,
  rpcUrl?: string,
  connection?: Connection,
): Promise<DiscoveredAgent[]> {
  const conn = connection ?? getConnection(rpcUrl);
  const agents: DiscoveredAgent[] = [];
  const seen = new Set<string>();

  let before: string | undefined;
  const overallStart = Date.now();
  const TIMEOUT_MS = 60_000;

  while (agents.length < limit && Date.now() - overallStart < TIMEOUT_MS) {
    const sigs = await conn.getSignaturesForAddress(
      new PublicKey(MEMO_PROGRAM_ID),
      { limit: Math.min(100, limit * 2), before },
      resolveCommitment(),
    );
    if (sigs.length === 0) break;
    before = sigs[sigs.length - 1].signature;

    for (const s of sigs) {
      if (agents.length >= limit) break;
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      try {
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: resolveCommitment(),
          maxSupportedTransactionVersion: 0,
        });
        const memoString = extractMemoFromTransaction(tx as never);
        if (!memoString) continue;
        const memo = parseAttestationMemo(memoString);
        if (!memo || !verifyAttestationSignature(memo)) continue;
        agents.push({
          agentId: s.signature,
          owner: memo.wallet,
          agentURI: memo.agentUri,
        });
      } catch {
        // Skip unreadable transactions
      }
    }

    if (sigs.length < 100) break;
  }

  return agents;
}

/**
 * Check if a wallet has published an attestation memo.
 */
export async function hasRegisteredAgent(
  walletAddress: string,
  rpcUrl?: string,
  connection?: Connection,
  limit: number = 50,
): Promise<boolean> {
  const conn = connection ?? getConnection(rpcUrl);
  try {
    const sigs = await conn.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit },
      resolveCommitment(),
    );
    for (const s of sigs) {
      try {
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: resolveCommitment(),
          maxSupportedTransactionVersion: 0,
        });
        const memoString = extractMemoFromTransaction(tx as never);
        if (memoString && parseAttestationMemo(memoString)) return true;
      } catch {
        // Skip
      }
    }
    return false;
  } catch {
    return false;
  }
}
