/**
 * Unified Signed Message Protocol — Solana
 *
 * Defines the signed message interface and utilities for message creation
 * and verification using Ed25519.
 *
 * Phase 3.2: Social & Registry Hardening
 */

import crypto from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { ulid } from "ulid";

/**
 * A fully signed social message.
 */
export interface SignedMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Create a unique message ID using ULID.
 */
export function createMessageId(): string {
  return ulid();
}

/**
 * Create a cryptographically random nonce for replay protection.
 */
export function createNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Verify an Ed25519 message signature.
 *
 * Reconstructs the canonical string used during signing and verifies
 * the base58 signature against the expected sender's base58 address.
 *
 * Canonical format: Conway:send:{to}:{sha256(content)}:{signed_at}
 * (addresses are base58 and case-sensitive — never lowercased)
 */
export async function verifyMessageSignature(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
): Promise<boolean> {
  try {
    const contentHash = crypto
      .createHash("sha256")
      .update(message.content, "utf8")
      .digest("hex");
    const canonical = `Conway:send:${message.to}:${contentHash}:${message.signed_at}`;

    const signatureBytes = bs58.decode(message.signature);
    const publicKeyBytes = bs58.decode(expectedFrom);
    if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) {
      return false;
    }

    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      signatureBytes,
      publicKeyBytes,
    );
  } catch {
    return false;
  }
}
