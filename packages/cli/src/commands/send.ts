/**
 * automaton-cli send <to-address> "message text"
 *
 * Send a message to an automaton or address via the social relay.
 *
 * Phase 3.2: CRITICAL FIX (S-P0-1) — All outbound messages are now signed
 * using the same canonical format as the runtime client.
 *
 * Solana-only: signs with the automaton's Ed25519 wallet.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { SolanaChainIdentity, isValidSolanaAddress } from "@conway/automaton/identity/chain.js";
import { signSendPayload } from "@conway/automaton/social/signing.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";

const args = process.argv.slice(3);
const toAddress = args[0];
const messageText = args.slice(1).join(" ");

if (!toAddress || !messageText) {
  console.log("Usage: automaton-cli send <to-address> <message>");
  console.log("Examples:");
  console.log('  automaton-cli send DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy "Hello, fellow automaton!"');
  process.exit(1);
}

if (!isValidSolanaAddress(toAddress)) {
  console.log("Invalid recipient address: must be a base58 Solana address.");
  process.exit(1);
}

// Load wallet
const walletPath = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "wallet.json",
);

if (!fs.existsSync(walletPath)) {
  console.log("No wallet found at ~/.automaton/wallet.json");
  console.log("Run: automaton --init");
  process.exit(1);
}

const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
if (!walletData.secretKey) {
  console.log("Wallet file has no Solana secretKey. Re-run: automaton --init");
  process.exit(1);
}
const identity = new SolanaChainIdentity(bs58.decode(walletData.secretKey));

// Load config for relay URL
const config = loadConfig();
const relayUrl =
  config?.socialRelayUrl ||
  process.env.SOCIAL_RELAY_URL ||
  "https://social.conway.tech";

try {
  // Phase 3.2: Sign the message using the same canonical format as runtime
  // Canonical: Conway:send:{to}:{sha256(content)}:{signed_at_iso}
  const payload = await signSendPayload(identity, toAddress, messageText);

  const resp = await fetch(`${relayUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Relay returned ${resp.status}: ${await resp.text()}`);
  }

  const result = (await resp.json()) as { id?: string };
  console.log(`Message sent (signed).`);
  console.log(`  ID:   ${result.id || "n/a"}`);
  console.log(`  From: ${identity.address}`);
  console.log(`  To:   ${toAddress}`);
  console.log(`  Relay: ${relayUrl}`);
} catch (err: any) {
  console.error(`Failed to send message: ${err.message}`);
  process.exit(1);
}
