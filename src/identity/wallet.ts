/**
 * Automaton Wallet Management — Solana Only
 *
 * Creates and manages the automaton's Solana wallet (Ed25519 keypair).
 * The private key is the automaton's sovereign identity.
 *
 * Wallet file (~/.automaton/wallet.json):
 *   { chainType: "solana", secretKey: "<base58 64-byte secret>", createdAt }
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import type { ChainIdentity, ChainType } from "./chain.js";
import { SolanaChainIdentity } from "./chain.js";

const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Generate a Solana Ed25519 keypair.
 * Returns the 64-byte secret key (first 32 = private, last 32 = public).
 */
export function generateSolanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    address: bs58.encode(keypair.publicKey),
  };
}

/**
 * Get or create the automaton's wallet.
 *
 * The returned `account` IS the `chainIdentity` (a SolanaChainIdentity):
 * it signs messages with Ed25519 and is passed directly to payment,
 * social, and registry code. There is no EVM account object anymore.
 */
export async function getWallet(_chainType?: ChainType): Promise<{
  account: ChainIdentity;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );

    if (walletData.secretKey) {
      const secretKey = bs58.decode(walletData.secretKey);
      const solanaIdentity = new SolanaChainIdentity(secretKey);
      return { account: solanaIdentity, chainIdentity: solanaIdentity, chainType: "solana", isNew: false };
    }

    // Legacy EVM wallet files (privateKey) cannot be used: this runtime is
    // Solana-only and secp256k1 keys are not valid ed25519 keys.
    if ((walletData as { privateKey?: string }).privateKey) {
      throw new Error(
        "Found a legacy EVM wallet file at ~/.automaton/wallet.json. " +
        "This runtime is Solana-only and cannot use secp256k1 keys. " +
        "Back up the old file, delete it, and re-run setup to generate a Solana wallet.",
      );
    }

    throw new Error(
      "Wallet file at ~/.automaton/wallet.json is corrupt (no secretKey). " +
      "Delete it and re-run setup to generate a fresh Solana wallet.",
    );
  }

  // Create new Solana wallet
  const { secretKey } = generateSolanaKeypair();
  const solanaIdentity = new SolanaChainIdentity(secretKey);

  const walletData: WalletData = {
    chainType: "solana",
    secretKey: bs58.encode(secretKey),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
    mode: 0o600,
  });

  return { account: solanaIdentity, chainIdentity: solanaIdentity, chainType: "solana", isNew: true };
}

/**
 * Get the wallet address without loading the full account.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (walletData.secretKey) {
    const secretKey = bs58.decode(walletData.secretKey);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    return bs58.encode(keypair.publicKey);
  }

  return null;
}

/**
 * Load the full wallet identity (needed for signing).
 */
export function loadWalletAccount(): ChainIdentity | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (!walletData.secretKey) {
    return null;
  }

  const secretKey = bs58.decode(walletData.secretKey);
  return new SolanaChainIdentity(secretKey);
}

/**
 * Get the chain type from the wallet file. Always "solana".
 */
export function getWalletChainType(): ChainType {
  return "solana";
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}
