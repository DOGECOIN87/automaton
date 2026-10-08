/**
 * Helius Surfaces — Solana-Only
 *
 * ALL Solana chain traffic in this runtime goes through Matt's Helius API.
 * The RPC endpoint is resolved centrally (getSolanaRpcUrl in config.ts):
 * HELIUS_API_KEY set -> https://mainnet.helius-rpc.com/?api-key=<key>.
 *
 * This module exposes Helius's richer surfaces for code that needs more
 * than standard RPC:
 *  - heliusRpcRequest(): standard + DAS/enhanced RPC methods
 *    (getAsset, getAssetsByOwner, getSignaturesForAsset, getPriorityFeeEstimate,
 *    ...) via mainnet.helius-rpc.com
 *  - heliusApiGet(): api.helius.xyz REST endpoints (token metadata, etc.)
 *
 * The key is read EXCLUSIVELY from the HELIUS_API_KEY environment variable.
 * It is never hardcoded, never logged, and never persisted. Every function
 * here throws a clear error when the key is absent instead of silently
 * falling back to public endpoints.
 */

import { getHeliusApiKey } from "../config.js";

export { getHeliusApiKey };

const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com";
const HELIUS_API_BASE = "https://api.helius.xyz";

function requireKey(): string {
  const key = getHeliusApiKey();
  if (!key) {
    throw new Error(
      "HELIUS_API_KEY is not set. Set it in the environment (see .env.example) — " +
        "Helius surfaces require Matt's API key and never fall back to public endpoints.",
    );
  }
  return key;
}

/**
 * Call a Helius JSON-RPC method (standard Solana RPC + DAS/enhanced methods
 * like getAsset, getAssetsByOwner, searchAssets) on mainnet.helius-rpc.com.
 */
export async function heliusRpcRequest<T>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const key = requireKey();
  const resp = await fetch(`${HELIUS_RPC_BASE}/?api-key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "automaton", method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`Helius RPC ${method} failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { result?: T; error?: { message?: string } };
  if (data.error) {
    throw new Error(`Helius RPC ${method} error: ${data.error.message || "unknown"}`);
  }
  return data.result as T;
}

/** Minimal DAS asset shape (token metadata). */
export interface HeliusDasAsset {
  id: string;
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string };
  };
  token_info?: {
    symbol?: string;
    decimals?: number;
    supply?: string;
  };
}

/**
 * Fetch token metadata for an SPL mint via the DAS getAsset method.
 * Prefer this over scraping explorers for on-chain token metadata.
 */
export async function getAssetByMint(mintAddress: string): Promise<HeliusDasAsset | null> {
  try {
    const result = await heliusRpcRequest<{ content?: unknown } | null>("getAsset", [
      { id: mintAddress },
    ]);
    return (result as HeliusDasAsset | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * GET a api.helius.xyz REST endpoint (path must start with "/").
 * The key is sent as the x-api-key header, never in logs.
 */
export async function heliusApiGet<T>(path: string): Promise<T> {
  const key = requireKey();
  if (!path.startsWith("/")) {
    throw new Error(`heliusApiGet path must start with "/": ${path}`);
  }
  const resp = await fetch(`${HELIUS_API_BASE}${path}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`Helius API GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}
