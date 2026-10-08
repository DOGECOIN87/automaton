/**
 * Spawn
 *
 * Spawn child automatons in new Conway sandboxes.
 * Uses the lifecycle state machine for tracked transitions.
 * Cleans up sandbox on ANY failure after creation.
 */

import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  GenesisConfig,
  ChildAutomaton,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { ulid } from "ulid";
import { propagateConstitution } from "./constitution.js";

/** Valid Conway sandbox pricing tiers. */
const SANDBOX_TIERS = [
  { memoryMb: 512,  vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
];

/** Find the smallest valid tier that has at least the requested memory. */
function selectSandboxTier(requestedMemoryMb: number) {
  return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
}

import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { getWallet } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";
import { safeEmit } from "../observability/event-bus.js";
import {
  checkFundingWalletSufficient,
  fundChildFromFundingWallet,
  getChildFundSol,
  loadFundingWallet,
} from "../solana/funding-wallet.js";

const logger = createLogger("replication.spawn");

/** USDC SPL mint on Solana mainnet (used for child funding). */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function resolveRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

function resolveCommitment(): "confirmed" | "finalized" | "processed" {
  const c = process.env.SOLANA_COMMITMENT;
  return c === "finalized" || c === "processed" ? c : "confirmed";
}

/**
 * Validate that an address is a well-formed Solana wallet address.
 * Solana-only: base58-encoded 32-byte public key.
 */
export function isValidWalletAddress(address: string, _chainType?: ChainType): boolean {
  return isValidAddress(address, "solana");
}

/** Optional on-chain funding for a newly spawned child wallet. */
export interface ChildFunding {
  /** Lamports of SOL to send (1 SOL = 1_000_000_000 lamports). */
  solLamports?: number;
  /** Base units of USDC-SPL to send (6 decimals). */
  usdcBaseUnits?: number;
}

/**
 * Funding gate: refuse to spawn when the dedicated funding wallet is missing
 * or cannot cover one child's SOL allocation (CHILD_FUND_SOL) plus the fee
 * buffer. Logs clearly, emits a GUI-visible event, and throws.
 *
 * Runs BEFORE any sandbox is created so a refusal never spends Conway
 * resources.
 */
export async function assertSpawnFunded(childName: string): Promise<void> {
  const check = await checkFundingWalletSufficient(1);
  if (!check.ok) {
    const fundingWallet = loadFundingWallet();
    logger.error(`SPAWN REFUSED for child "${childName}": ${check.message}`);
    safeEmit({
      type: "replication.spawn_refused",
      childName,
      reason: check.message,
      fundingWalletAddress: fundingWallet?.address ?? null,
      fundingWalletBalanceSol: check.balanceLamports / LAMPORTS_PER_SOL,
    });
    throw new Error(`Cannot spawn child "${childName}": ${check.message}`);
  }
  logger.info(
    `Funding gate passed for child "${childName}": ${check.childFundSol} SOL per child from funding wallet.`,
  );
}

function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Fund a child wallet on Solana from the parent's wallet.
 *
 * Sends SOL via SystemProgram.transfer and/or USDC-SPL via a Tokenkeg
 * transfer instruction. Signs with the parent's Ed25519 key (loaded from
 * the local wallet file — never leaves this process).
 *
 * Only runs when explicitly requested via the `funding` option; spawn
 * itself does not move funds.
 */
export async function fundChildWallet(
  childAddress: string,
  funding: ChildFunding,
  rpcUrl?: string,
): Promise<{ solTx?: string; usdcTx?: string }> {
  if (!isValidWalletAddress(childAddress)) {
    throw new Error(`Invalid child wallet address: ${childAddress}`);
  }
  const { solLamports, usdcBaseUnits } = funding;
  if (!solLamports && !usdcBaseUnits) {
    throw new Error("fundChildWallet requires solLamports and/or usdcBaseUnits");
  }

  const { chainIdentity } = await getWallet();
  const connection = new Connection(rpcUrl || resolveRpcUrl(), resolveCommitment());
  const payer = new PublicKey(chainIdentity.address);
  const child = new PublicKey(childAddress);
  const result: { solTx?: string; usdcTx?: string } = {};

  async function signAndSend(tx: Transaction): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      resolveCommitment(),
    );
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const sig = await chainIdentity.signBytes(tx.compileMessage().serialize());
    tx.addSignature(payer, Buffer.from(sig));
    return connection.sendRawTransaction(tx.serialize({ requireAllSignatures: false }), {
      skipPreflight: false,
      preflightCommitment: resolveCommitment(),
    });
  }

  if (solLamports && solLamports > 0) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: child,
        lamports: solLamports,
      }),
    );
    result.solTx = await signAndSend(tx);
    logger.info(`Funded child ${childAddress} with ${solLamports} lamports: ${result.solTx}`);
  }

  if (usdcBaseUnits && usdcBaseUnits > 0) {
    const mint = new PublicKey(USDC_MINT);
    const sourceAta = findAssociatedTokenAddress(payer, mint);
    const destAta = findAssociatedTokenAddress(child, mint);

    const instructions: TransactionInstruction[] = [];
    const destInfo = await connection.getAccountInfo(destAta, resolveCommitment());
    if (!destInfo) {
      instructions.push(
        new TransactionInstruction({
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: child, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.alloc(0),
        }),
      );
    }

    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0); // SPL Token `transfer` instruction index
    data.writeBigUInt64LE(BigInt(usdcBaseUnits), 1);
    instructions.push(
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: payer, isSigner: true, isWritable: false },
        ],
        data,
      }),
    );

    const tx = new Transaction().add(...instructions);
    result.usdcTx = await signAndSend(tx);
    logger.info(`Funded child ${childAddress} with ${usdcBaseUnits} USDC base units: ${result.usdcTx}`);
  }

  return result;
}

/**
 * Spawn a child automaton in a new Conway sandbox using lifecycle state machine.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
  options?: { funding?: ChildFunding },
): Promise<ChildAutomaton> {
  // Check child limit from config
  const existing = db
    .getChildren()
    .filter(
      (c) =>
        c.status !== "dead" &&
        c.status !== "cleaned_up" &&
        c.status !== "failed",
    );
  const maxChildren = (db as any).config?.maxChildren ?? 3;
  if (existing.length >= maxChildren) {
    throw new Error(
      `Cannot spawn: already at max children (${maxChildren}). Kill or wait for existing children to die.`,
    );
  }

  // Funding gate: the dedicated funding wallet must cover one child's SOL
  // allocation before we spend anything on a sandbox. Refuses loudly.
  await assertSpawnFunded(genesis.name);

  const childId = ulid();
  let sandboxId: string | undefined;
  let reusedSandbox: { id: string } | null = null;

  // If no lifecycle provided, use legacy path
  if (!lifecycle) {
    return spawnChildLegacy(conway, identity, db, genesis, childId);
  }

  try {
    // State: requested (Solana-only)
    const childChainType = genesis.chainType || (identity as any).chainType || "solana";
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt, childChainType);

    // Get child sandbox memory from config (default 1024MB)
    const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

    // Try to reuse an existing sandbox whose DB record is 'failed' but
    // is still running remotely, before creating a new one.
    reusedSandbox = await findReusableSandbox(conway, db);

    const tier = selectSandboxTier(childMemoryMb);

    let sandbox: { id: string };
    if (reusedSandbox) {
      sandbox = reusedSandbox;
    } else {
      sandbox = await conway.createSandbox({
        name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        vcpu: tier.vcpu,
        memoryMb: tier.memoryMb,
        diskGb: tier.diskGb,
      });
    }
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    // Update sandbox ID in children table
    db.raw
      .prepare("UPDATE children SET sandbox_id = ? WHERE id = ?")
      .run(sandbox.id, childId);

    // State: sandbox_created
    lifecycle.transition(
      childId,
      "sandbox_created",
      `sandbox ${sandbox.id} created`,
    );

    // Install runtime (on the CHILD sandbox)
    await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await childConway.exec(
      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
      180_000,
    );

    // Write genesis configuration (on the CHILD sandbox)
    await childConway.exec("mkdir -p /root/.automaton", 10_000);
    const genesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "solana",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution with hash verification
    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    // State: runtime_ready
    lifecycle.transition(childId, "runtime_ready", "runtime installed");

    // Initialize child wallet (on the CHILD sandbox) — Solana base58 address
    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const stdout = initResult.stdout || "";
    const solanaMatch = stdout.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const childWallet = solanaMatch ? solanaMatch[0] : "";

    if (!isValidWalletAddress(childWallet, "solana")) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Update address in children table
    db.raw
      .prepare("UPDATE children SET address = ? WHERE id = ?")
      .run(childWallet, childId);

    // State: wallet_verified
    lifecycle.transition(
      childId,
      "wallet_verified",
      `wallet ${childWallet} verified`,
    );

    // Mandatory on-chain funding: each child gets CHILD_FUND_SOL (default
    // 0.05) SOL from Matt's dedicated funding wallet — never from the
    // agent's own wallet. The funding gate above already verified sufficiency.
    const fundTx = await fundChildFromFundingWallet(childWallet);
    lifecycle.transition(
      childId,
      "funded",
      `child wallet funded ${getChildFundSol()} SOL from funding wallet: ${fundTx}`,
    );

    // Legacy explicit funding option (parent wallet) — kept for compat.
    if (options?.funding) {
      const fundingTxs = await fundChildWallet(childWallet, options.funding);
      lifecycle.transition(
        childId,
        "funded",
        `child wallet funded ${JSON.stringify(fundingTxs)}`,
      );
    }

    // Record spawn modification
    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}${reusedSandbox ? " (reused)" : ""}`,
      reversible: false,
    });
    safeEmit({ type: "replication.child_spawned", childId, name: genesis.name, address: childWallet, sandboxId: sandbox.id });

    // If we reused a sandbox, update the old children record to 'cleaned_up'
    // so it doesn't get reused again.
    if (reusedSandbox) {
      db.raw.prepare(
        "UPDATE children SET status = 'cleaned_up' WHERE sandbox_id = ? AND status = 'failed'",
      ).run(sandbox.id);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
    };

    return child;
  } catch (error) {
    // Note: sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Failed sandboxes are left running and may be reused by findReusableSandbox().

    // Transition to failed if lifecycle has been initialized
    try {
      lifecycle.transition(
        childId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // May fail if child doesn't exist yet
    }

    throw error;
  }
}

/**
 * Legacy spawn path for backward compatibility when no lifecycle is provided.
 */
async function spawnChildLegacy(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  childId: string,
): Promise<ChildAutomaton> {
  let sandboxId: string | undefined;

  // Get child sandbox memory from config (default 1024MB)
  const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

  const legacyTier = selectSandboxTier(childMemoryMb);

  // Funding gate (same as the lifecycle path): refuse before spending anything.
  await assertSpawnFunded(genesis.name);

  try {
    const sandbox = await conway.createSandbox({
      name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      vcpu: legacyTier.vcpu,
      memoryMb: legacyTier.memoryMb,
      diskGb: legacyTier.diskGb,
    });
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    await childConway.exec(
      "apt-get update -qq && apt-get install -y -qq nodejs npm git curl",
      120_000,
    );
    await childConway.exec(
      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
      180_000,
    );
    await childConway.exec("mkdir -p /root/.automaton", 10_000);

    const legacyGenesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "solana",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", legacyGenesisJson);

    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found
    }

    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const legacySolMatch = (initResult.stdout || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    const childWallet = legacySolMatch ? legacySolMatch[0] : "";

    if (!isValidWalletAddress(childWallet, "solana")) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Mandatory funding from the dedicated funding wallet (CHILD_FUND_SOL).
    const legacyFundTx = await fundChildFromFundingWallet(childWallet);
    logger.info(
      `Legacy spawn: child ${genesis.name} funded ${getChildFundSol()} SOL from funding wallet: ${legacyFundTx}`,
    );

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
      chainType: "solana" as any,
    };

    db.insertChild(child);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
      reversible: false,
    });
    safeEmit({ type: "replication.child_spawned", childId, name: genesis.name, address: childWallet, sandboxId: sandbox.id });

    return child;
  } catch (error) {
    // Sandbox deletion disabled — failed sandboxes left for potential reuse.
    throw error;
  }
}

/**
 * Find a reusable sandbox: one that is marked 'failed' in the local DB
 * but is still running remotely. Returns the first match or null.
 */
async function findReusableSandbox(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<{ id: string } | null> {
  try {
    const failedChildren = db.getChildren().filter((c) => c.status === "failed" && c.sandboxId);
    if (failedChildren.length === 0) return null;

    const remoteSandboxes = await conway.listSandboxes();
    const runningIds = new Set(
      remoteSandboxes
        .filter((s) => s.status === "running")
        .map((s) => s.id),
    );

    for (const child of failedChildren) {
      if (runningIds.has(child.sandboxId)) {
        return { id: child.sandboxId };
      }
    }
  } catch {
    // If listing fails, just create a new sandbox
  }
  return null;
}
