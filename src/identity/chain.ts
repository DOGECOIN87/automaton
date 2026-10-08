/**
 * Chain Abstraction Layer — Solana Only
 *
 * This automaton is Solana-only: the wallet is an Ed25519 keypair,
 * the address is the base58-encoded public key, and all signing is
 * Ed25519 via tweetnacl. There are no EVM code paths.
 *
 * The wallet IS the sovereign identity.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";

// ─── Chain Type ──────────────────────────────────────────────

/**
 * The only supported chain. Kept as a type alias so config files,
 * the database, and downstream code can keep a `chainType` field
 * without carrying dead EVM branches.
 */
export type ChainType = "solana";

// ─── Address Validation ──────────────────────────────────────

/** A valid Solana address is a base58-encoded 32-byte public key. */
export function isValidSolanaAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

/**
 * Validate an address. Solana-only: accepts base58 ed25519 addresses.
 * The optional `chainType` parameter is kept for call-site compatibility;
 * the only accepted value is "solana".
 */
export function isValidAddress(address: string, chainType?: ChainType): boolean {
  if (chainType !== undefined && chainType !== "solana") return false;
  return isValidSolanaAddress(address);
}

/** Detect the chain of an address. Returns "solana" or null. */
export function detectChainType(address: string): ChainType | null {
  if (isValidSolanaAddress(address)) return "solana";
  return null;
}

/**
 * Normalize an address for canonical message formats.
 * Solana addresses are base58 and case-sensitive — never lowercased.
 */
export function normalizeAddress(address: string, _chain?: ChainType): string {
  return address;
}

// ─── Chain Identity Interface ────────────────────────────────

/**
 * Chain identity interface.
 * Wraps the automaton's Ed25519 keypair (Solana).
 * This is also the signer passed to payment, social, and registry code —
 * it replaces viem's PrivateKeyAccount everywhere.
 */
export interface ChainIdentity {
  readonly chainType: ChainType;
  readonly address: string;
  signMessage(message: string): Promise<string>;
  /**
   * Sign raw bytes and return the raw 64-byte Ed25519 signature.
   * Used for Solana transaction messages (which are binary, not text).
   */
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * Solana chain identity wrapping a tweetnacl Ed25519 keypair.
 */
export class SolanaChainIdentity implements ChainIdentity {
  readonly chainType: ChainType = "solana";
  readonly address: string;
  private readonly keypair: nacl.SignKeyPair;

  constructor(secretKey: Uint8Array) {
    this.keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    this.address = bs58.encode(this.keypair.publicKey);
  }

  async signMessage(message: string): Promise<string> {
    const messageBytes = new TextEncoder().encode(message);
    const signature = await this.signBytes(messageBytes);
    return bs58.encode(signature);
  }

  async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(bytes, this.keypair.secretKey);
  }

  /** Get the raw 64-byte secret key for serialization. */
  getSecretKey(): Uint8Array {
    return this.keypair.secretKey;
  }

  /** Get the raw 32-byte public key. */
  getPublicKey(): Uint8Array {
    return this.keypair.publicKey;
  }
}
