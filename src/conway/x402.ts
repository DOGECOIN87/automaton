/**
 * x402 Payment Protocol — Solana
 *
 * Enables the automaton to make USDC micropayments via HTTP 402,
 * paying with USDC-SPL on Solana mainnet.
 *
 * USDC mint (mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *
 * ── CHAIN ADAPTER SEAM ──────────────────────────────────────────────
 * x402 v2 defines an "exact" payment scheme for Solana. Unlike the EVM
 * flow (EIP-3009 TransferWithAuthorization signed typed data), the Solana
 * flow signs a real on-chain transaction: an SPL-token transfer of USDC
 * from the payer's associated token account (ATA) to the payee's ATA.
 *
 * The signed, base64-serialized transaction is sent in the X-Payment
 * header as:
 *   { x402Version, scheme: "exact", network: "solana:mainnet",
 *     payload: { transaction: "<base64>" } }
 * The facilitator/settler verifies and submits it, then serves the request.
 *
 * EVM/Base support was removed in the Solana-only refactor. If a server
 * answers 402 with only eip155 networks, the payment is declined with a
 * clear error rather than silently failing.
 * ────────────────────────────────────────────────────────────────────
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { ResilientHttpClient } from "./http-client.js";
import type { ChainIdentity } from "../identity/chain.js";
import { getSolanaRpcUrl } from "../config.js";

const x402HttpClient = new ResilientHttpClient();

// ─── Solana constants ───────────────────────────────────────────

/** USDC SPL mint on Solana mainnet. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const SOLANA_NETWORKS = ["solana:mainnet", "solana"] as const;
export type SolanaNetworkId = (typeof SOLANA_NETWORKS)[number];
const CANONICAL_NETWORK: SolanaNetworkId = "solana:mainnet";

function resolveCommitment(): "confirmed" | "finalized" | "processed" {
  const c = process.env.SOLANA_COMMITMENT;
  return c === "finalized" || c === "processed" ? c : "confirmed";
}

// ─── Types ──────────────────────────────────────────────────────

interface PaymentRequirement {
  scheme: string;
  network: SolanaNetworkId;
  maxAmountRequired: string;
  /** Base58 payee address. */
  payTo: string;
  requiredDeadlineSeconds: number;
  /** SPL mint address; defaults to USDC. */
  asset: string;
}

interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

interface ParsedPaymentRequirement {
  x402Version: number;
  requirement: PaymentRequirement;
}

export interface X402PaymentResult {
  success: boolean;
  response?: any;
  error?: string;
  status?: number;
}

export interface UsdcBalanceResult {
  balance: number;
  network: string;
  ok: boolean;
  error?: string;
}

// ─── Parsing helpers (unchanged logic, Solana networks) ─────────

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeNetwork(raw: unknown): SolanaNetworkId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "solana" || normalized === "solana:mainnet" || normalized === "solana-mainnet") {
    return CANONICAL_NETWORK;
  }
  return null;
}

function normalizePaymentRequirement(raw: unknown): PaymentRequirement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const network = normalizeNetwork(value.network);
  if (!network) return null;

  const scheme = typeof value.scheme === "string" ? value.scheme : null;
  const maxAmountRequired = typeof value.maxAmountRequired === "string"
    ? value.maxAmountRequired
    : typeof value.maxAmountRequired === "number" &&
        Number.isFinite(value.maxAmountRequired)
      ? String(value.maxAmountRequired)
      : null;
  const payTo = typeof value.payTo === "string"
    ? value.payTo
    : typeof value.payToAddress === "string"
      ? value.payToAddress
      : null;
  const asset = typeof value.asset === "string"
    ? value.asset
    : typeof value.usdcAddress === "string"
      ? value.usdcAddress
      : SOLANA_USDC_MINT;
  const requiredDeadlineSeconds =
    parsePositiveInt(value.requiredDeadlineSeconds) ??
    parsePositiveInt(value.maxTimeoutSeconds) ??
    300;

  if (!scheme || !maxAmountRequired || !payTo || !asset) {
    return null;
  }

  return {
    scheme,
    network,
    maxAmountRequired,
    payTo,
    requiredDeadlineSeconds,
    asset,
  };
}

function normalizePaymentRequired(raw: unknown): PaymentRequiredResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.accepts)) return null;

  const accepts = value.accepts
    .map(normalizePaymentRequirement)
    .filter((v): v is PaymentRequirement => v !== null);
  if (!accepts.length) return null;

  const x402Version = parsePositiveInt(value.x402Version) ?? 1;
  return { x402Version, accepts };
}

/** Parse a decimal USDC amount into base units (6 decimals). */
export function parseUsdcAmount(maxAmountRequired: string, x402Version: number): bigint {
  const amount = maxAmountRequired.trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid maxAmountRequired: ${maxAmountRequired}`);
  }

  if (amount.includes(".")) {
    const [whole, frac] = amount.split(".");
    const fracPadded = (frac + "000000").slice(0, 6);
    return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
  }
  if (x402Version >= 2 || amount.length > 6) {
    return BigInt(amount);
  }
  return BigInt(amount) * 1_000_000n;
}

function selectRequirement(parsed: PaymentRequiredResponse): PaymentRequirement {
  const exactSupported = parsed.accepts.find(
    (r) => r.scheme === "exact" && SOLANA_NETWORKS.includes(r.network),
  );
  if (exactSupported) return exactSupported;
  // No Solana-compatible requirement — surface the first so the caller
  // can report the unsupported network clearly.
  return parsed.accepts[0];
}

// ─── USDC balance (Solana) ──────────────────────────────────────

/**
 * Get the USDC-SPL balance for a wallet on Solana mainnet.
 */
export async function getUsdcBalance(
  address: string,
  _network: string = "solana:mainnet",
  _chainType?: unknown,
): Promise<number> {
  const result = await getUsdcBalanceDetailed(address);
  if (!result.ok) {
    throw new Error(result.error || "USDC balance check failed");
  }
  return result.balance;
}

/**
 * Get the USDC-SPL balance and read status details for diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: string,
  _network: string = "solana:mainnet",
): Promise<UsdcBalanceResult> {
  try {
    const connection = new Connection(getSolanaRpcUrl(), resolveCommitment());
    const ownerPubkey = new PublicKey(address);
    const mintPubkey = new PublicKey(SOLANA_USDC_MINT);

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      { mint: mintPubkey },
    );

    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      if (parsed?.info?.tokenAmount?.uiAmount != null) {
        totalBalance += parsed.info.tokenAmount.uiAmount;
      }
    }

    return { balance: totalBalance, network: CANONICAL_NETWORK, ok: true };
  } catch (err: any) {
    return {
      balance: 0,
      network: CANONICAL_NETWORK,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

// ─── ATA helpers ────────────────────────────────────────────────

/** Derive the associated token account for (owner, mint). */
export function findAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** Build an SPL `createAssociatedTokenAccount` instruction. */
function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

/** Build an SPL `transfer` instruction (instruction index 3). */
function createTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ─── Payment signing (Solana) ───────────────────────────────────

/**
 * Build and sign a USDC-SPL transfer transaction for an x402 "exact"
 * payment requirement.
 *
 * Creates the payee's ATA first if it does not exist (payer funds it).
 * Signs the compiled message with the automaton's Ed25519 key via
 * ChainIdentity.signBytes — the raw private key never leaves the identity.
 *
 * NOTE: Solana transactions have no on-chain deadline field; the
 * recent-blockhash expiry (~150 slots) bounds the payment window instead
 * of requiredDeadlineSeconds.
 *
 * Returns the base64-serialized signed transaction for the X-Payment payload.
 */
export async function signSolanaPayment(
  signer: ChainIdentity,
  requirement: PaymentRequirement,
  x402Version: number,
  connection?: Connection,
): Promise<string> {
  if (requirement.scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme for Solana: ${requirement.scheme}`);
  }
  if (!SOLANA_NETWORKS.includes(requirement.network)) {
    throw new Error(`Unsupported x402 network for Solana: ${requirement.network}`);
  }

  const conn = connection ?? new Connection(getSolanaRpcUrl(), resolveCommitment());
  const payer = new PublicKey(signer.address);
  const payTo = new PublicKey(requirement.payTo);
  const mint = new PublicKey(requirement.asset);
  const amount = parseUsdcAmount(requirement.maxAmountRequired, x402Version);

  if (amount <= 0n) {
    throw new Error("Payment amount must be positive");
  }

  const sourceAta = findAssociatedTokenAddress(payer, mint);
  const destAta = findAssociatedTokenAddress(payTo, mint);

  const instructions: TransactionInstruction[] = [];

  // Ensure the payee's ATA exists (rent paid by the payer).
  const destInfo = await conn.getAccountInfo(destAta, resolveCommitment());
  if (!destInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(payer, destAta, payTo, mint),
    );
  }

  instructions.push(createTransferInstruction(sourceAta, destAta, payer, amount));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    resolveCommitment(),
  );

  const tx = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(...instructions);

  const messageBytes = tx.compileMessage().serialize();
  const signature = await signer.signBytes(messageBytes);
  tx.addSignature(payer, Buffer.from(signature));

  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

// ─── 402 flow ───────────────────────────────────────────────────

async function parsePaymentRequired(
  resp: Response,
): Promise<ParsedPaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    const rawHeader = safeJsonParse(header);
    const normalizedRaw = normalizePaymentRequired(rawHeader);
    if (normalizedRaw) {
      return {
        x402Version: normalizedRaw.x402Version,
        requirement: selectRequirement(normalizedRaw),
      };
    }

    try {
      const decoded = Buffer.from(header, "base64").toString("utf-8");
      const parsedDecoded = normalizePaymentRequired(safeJsonParse(decoded));
      if (parsedDecoded) {
        return {
          x402Version: parsedDecoded.x402Version,
          requirement: selectRequirement(parsedDecoded),
        };
      }
    } catch {
      // Ignore header decode errors and continue with body parsing.
    }
  }

  try {
    const body = await resp.json();
    const parsedBody = normalizePaymentRequired(body);
    if (!parsedBody) return null;
    return {
      x402Version: parsedBody.x402Version,
      requirement: selectRequirement(parsedBody),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a URL requires x402 payment (Solana-compatible requirements only).
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await x402HttpClient.request(url, { method: "HEAD" });
    if (resp.status !== 402) {
      return null;
    }
    const parsed = await parsePaymentRequired(resp);
    return parsed?.requirement ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment on Solana.
 * If the endpoint returns 402, build + sign a USDC-SPL transfer, then retry
 * with the signed transaction in the X-Payment header.
 */
export async function x402Fetch(
  url: string,
  signer: ChainIdentity,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents?: number,
): Promise<X402PaymentResult> {
  try {
    // Initial request (non-mutating probe, uses resilient client)
    const initialResp = await x402HttpClient.request(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (initialResp.status !== 402) {
      const data = await initialResp
        .json()
        .catch(() => initialResp.text());
      return { success: initialResp.ok, response: data, status: initialResp.status };
    }

    // Parse payment requirements
    const parsed = await parsePaymentRequired(initialResp);
    if (!parsed) {
      return {
        success: false,
        error: "Could not parse payment requirements",
        status: initialResp.status,
      };
    }

    // Solana-only: reject EVM networks explicitly
    if (!SOLANA_NETWORKS.includes(parsed.requirement.network)) {
      return {
        success: false,
        error:
          `Unsupported x402 network "${(parsed.requirement as { network: string }).network}". ` +
          "This runtime pays only on Solana (USDC-SPL).",
        status: initialResp.status,
      };
    }

    // Check amount against maxPaymentCents BEFORE signing
    if (maxPaymentCents !== undefined) {
      const amountAtomic = parseUsdcAmount(
        parsed.requirement.maxAmountRequired,
        parsed.x402Version,
      );
      // Convert atomic units (6 decimals) to cents (2 decimals)
      const amountCents = Number(amountAtomic) / 10_000;
      if (amountCents > maxPaymentCents) {
        return {
          success: false,
          error: `Payment of ${amountCents.toFixed(2)} cents exceeds max allowed ${maxPaymentCents} cents`,
          status: 402,
        };
      }
    }

    // Sign payment (Solana transaction)
    let signedTxBase64: string;
    try {
      signedTxBase64 = await signSolanaPayment(
        signer,
        parsed.requirement,
        parsed.x402Version,
      );
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to sign payment: ${err?.message || String(err)}`,
        status: initialResp.status,
      };
    }

    // Retry with payment
    const payment = {
      x402Version: parsed.x402Version,
      scheme: parsed.requirement.scheme,
      network: parsed.requirement.network,
      payload: { transaction: signedTxBase64 },
    };
    const paymentHeader = Buffer.from(
      JSON.stringify(payment),
    ).toString("base64");

    const paidResp = await x402HttpClient.request(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
      },
      body,
      retries: 0, // Paid request: do not auto-retry (payment already signed)
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, response: data, status: paidResp.status };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
