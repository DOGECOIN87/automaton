/**
 * Social Signing Module — Solana
 *
 * THE SINGLE canonical signing implementation for both runtime + CLI.
 * Solana-only: Ed25519 via the ChainIdentity (tweetnacl under the hood).
 *
 * Phase 3.2: Social & Registry Hardening (S-P0-1)
 */

import crypto from "crypto";
import type { SignedMessagePayload } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

/** sha256 hex of the message content — the Solana-side content hash. */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Sign a send message payload.
 *
 * Canonical format: Conway:send:{to}:{sha256(content)}:{signed_at_iso}
 *
 * Addresses are base58 and case-sensitive — never lowercased.
 */
export async function signSendPayload(
  signer: ChainIdentity,
  to: string,
  content: string,
  replyTo?: string,
): Promise<SignedMessagePayload> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(
      `Message content too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`,
    );
  }

  const signedAt = new Date().toISOString();
  const contentHash = hashContent(content);

  const canonical = `Conway:send:${to}:${contentHash}:${signedAt}`;

  const signature = await signer.signMessage(canonical);

  return {
    from: signer.address,
    to,
    content,
    signed_at: signedAt,
    signature,
    reply_to: replyTo,
  };
}

/**
 * Sign a poll payload.
 *
 * Canonical format: Conway:poll:{address}:{timestamp_iso}
 */
export async function signPollPayload(
  signer: ChainIdentity,
): Promise<{ address: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();

  const address = signer.address;
  const canonical = `Conway:poll:${address}:${timestamp}`;
  const signature = await signer.signMessage(canonical);

  return {
    address,
    signature,
    timestamp,
  };
}
