/**
 * Social & Registry Hardening Tests (Phase 3.2) — Solana
 *
 * Tests for Ed25519 signing, validation, social client, agent card,
 * attestation memos, discovery caching, and schema migration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import { MIGRATION_V7 } from "../state/schema.js";
import { SolanaChainIdentity } from "../identity/chain.js";

// ─── Test helpers ───────────────────────────────────────────────

function createTestDb(): import("better-sqlite3").Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create base tables needed for tests
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS heartbeat_dedup (
      dedup_key TEXT PRIMARY KEY,
      task_name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dedup_expires ON heartbeat_dedup(expires_at);
  `);

  // Apply V7 migration (Phase 3 tables)
  db.exec(MIGRATION_V7);
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(7);

  return db;
}

function makeIdentity(): SolanaChainIdentity {
  return new SolanaChainIdentity(nacl.sign.keyPair().secretKey);
}

function randomAddress(): string {
  return bs58.encode(nacl.sign.keyPair().publicKey);
}

// ─── 1. Signing Tests ───────────────────────────────────────────

describe("Signing", () => {
  it("signSendPayload produces valid payload with signature", async () => {
    const { signSendPayload } = await import("../social/signing.js");

    const identity = makeIdentity();
    const to = randomAddress();
    const payload = await signSendPayload(identity, to, "Hello, world!");

    expect(payload.from).toBe(identity.address);
    expect(payload.to).toBe(to);
    expect(payload.content).toBe("Hello, world!");
    expect(payload.signature).toBeTruthy();
    // Ed25519 signatures are base58, not 0x hex
    expect(payload.signature).not.toMatch(/^0x/);
    expect(bs58.decode(payload.signature).length).toBe(64);
    expect(payload.signed_at).toBeTruthy();
  });

  it("signSendPayload preserves address case (no lowercasing)", async () => {
    const { signSendPayload } = await import("../social/signing.js");

    const identity = makeIdentity();
    const to = "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
    const payload = await signSendPayload(identity, to, "Hi");

    expect(payload.to).toBe(to);
    expect(payload.from).toBe(identity.address);
  });

  it("signSendPayload enforces content size limit", async () => {
    const { signSendPayload } = await import("../social/signing.js");

    const identity = makeIdentity();
    const longContent = "x".repeat(65_000);
    await expect(
      signSendPayload(identity, randomAddress(), longContent),
    ).rejects.toThrow("Message content too long");
  });

  it("signPollPayload produces valid payload", async () => {
    const { signPollPayload } = await import("../social/signing.js");

    const identity = makeIdentity();
    const result = await signPollPayload(identity);

    expect(result.address).toBe(identity.address);
    expect(bs58.decode(result.signature).length).toBe(64);
    expect(result.timestamp).toBeTruthy();
  });

  it("signSendPayload canonical format verifies with Ed25519", async () => {
    const { signSendPayload } = await import("../social/signing.js");

    const identity = makeIdentity();
    const to = randomAddress();
    const content = "Test message";
    const payload = await signSendPayload(identity, to, content);

    // Reconstruct canonical and verify with nacl directly
    const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const canonical = `Conway:send:${to}:${contentHash}:${payload.signed_at}`;

    const valid = nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      bs58.decode(payload.signature),
      bs58.decode(identity.address),
    );

    expect(valid).toBe(true);
  });
});

// ─── 2. Message Validation Tests ────────────────────────────────

describe("Message Validation", () => {
  it("valid message passes validation", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "Hello!",
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("message exceeding total size limit fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "x".repeat(129_000),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total size limit"))).toBe(true);
  });

  it("content exceeding content size limit fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "x".repeat(65_000),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Content exceeds size limit"))).toBe(true);
  });

  it("message too old (>5 min) fails replay check", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const oldTimestamp = new Date(Date.now() - 6 * 60_000).toISOString();
    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "Hello!",
      signed_at: oldTimestamp,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too old"))).toBe(true);
  });

  it("message from future fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const futureTimestamp = new Date(Date.now() + 2 * 60_000).toISOString();
    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "Hello!",
      signed_at: futureTimestamp,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("future"))).toBe(true);
  });

  it("invalid timestamp string is rejected", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: randomAddress(),
      to: randomAddress(),
      content: "Hello!",
      signed_at: "not-a-valid-date",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid timestamp"))).toBe(true);
  });

  it("invalid from address fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: "not-an-address",
      to: randomAddress(),
      content: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid sender address"))).toBe(true);
  });

  it("EVM-style 0x address is not a valid Solana address", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      to: randomAddress(),
      content: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid sender address"))).toBe(true);
  });

  it("invalid to address fails", async () => {
    const { validateMessage } = await import("../social/validation.js");

    const result = validateMessage({
      from: randomAddress(),
      to: "bad",
      content: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid recipient address"))).toBe(true);
  });
});

// ─── 3. Relay URL Validation Tests ──────────────────────────────

describe("Relay URL Validation", () => {
  it("HTTPS URL accepted", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("https://social.conway.tech")).not.toThrow();
  });

  it("HTTP URL rejected", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("http://social.conway.tech")).toThrow(
      "Relay URL must use HTTPS",
    );
  });

  it("Non-URL rejected", async () => {
    const { validateRelayUrl } = await import("../social/validation.js");
    expect(() => validateRelayUrl("not a url")).toThrow("Invalid relay URL");
  });
});

// ─── 4. Social Client Tests ────────────────────────────────────

describe("Social Client", () => {
  it("createSocialClient throws on HTTP relay URL", async () => {
    const { createSocialClient } = await import("../social/client.js");

    expect(() => createSocialClient("http://relay.example.com", makeIdentity())).toThrow(
      "Relay URL must use HTTPS",
    );
  });

  it("send() calls signing module and validates message", async () => {
    const { createSocialClient } = await import("../social/client.js");

    // Mock fetch to capture the request body
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "msg-123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const identity = makeIdentity();
    const client = createSocialClient("https://relay.example.com", identity);
    const to = randomAddress();
    const result = await client.send(to, "Test message");

    expect(result.id).toBe("msg-123");
    // Verify the request was made with a signature
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs?.[1]?.body as string);
    expect(body.signature).toBeTruthy();
    expect(body.signed_at).toBeTruthy();
    expect(body.from).toBe(identity.address);
    expect(body.to).toBe(to);

    vi.unstubAllGlobals();
  });

  it("unreadCount() throws on HTTP error (not returns 0)", async () => {
    const { createSocialClient } = await import("../social/client.js");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ error: "server error" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", makeIdentity());
    await expect(client.unreadCount()).rejects.toThrow("Unread count failed");

    vi.unstubAllGlobals();
  });

  it("rate limiting: 101st message in hour is rejected", async () => {
    const { createSocialClient } = await import("../social/client.js");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "msg-xxx" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", makeIdentity());
    const to = randomAddress();

    // Send 100 messages successfully
    for (let i = 0; i < 100; i++) {
      await client.send(to, `message ${i}`);
    }

    // 101st should be rejected
    await expect(client.send(to, "message 100")).rejects.toThrow(
      "Rate limit exceeded",
    );

    vi.unstubAllGlobals();
  });

  it("rate limiting: failed sends count toward the hourly limit", async () => {
    const { createSocialClient } = await import("../social/client.js");

    // Server returns 500 for every request
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ error: "server error" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createSocialClient("https://relay.example.com", makeIdentity());
    const to = randomAddress();

    // Send 100 messages that all fail with 500
    for (let i = 0; i < 100; i++) {
      await client.send(to, `msg ${i}`).catch(() => {}); // ignore the send failure
    }

    // 101st should be rate-limited even though all previous sends failed
    await expect(client.send(to, "msg 100")).rejects.toThrow(
      "Rate limit exceeded",
    );

    vi.unstubAllGlobals();
  });
});

// ─── 5. Agent Card Tests ────────────────────────────────────────

describe("Agent Card", () => {
  function makeCardFixtures() {
    const identity = {
      name: "test-agent",
      address: randomAddress(),
      account: {} as any,
      creatorAddress: randomAddress(),
      sandboxId: "sandbox-123",
      apiKey: "key-123",
      createdAt: new Date().toISOString(),
    };

    const config = {
      name: "TestBot",
      conwayApiUrl: "https://api.conway.tech",
      creatorAddress: identity.creatorAddress,
    } as any;

    const db = {
      getChildren: () => [],
      getSkills: () => [],
    } as any;

    return { identity, config, db };
  }

  it("generateAgentCard does NOT include sandbox ID", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");
    const { identity, config, db } = makeCardFixtures();

    const card = generateAgentCard(identity, config, db);
    expect(JSON.stringify(card)).not.toContain("sandbox-123");
  });

  it("generateAgentCard does NOT include Conway API URL", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");
    const { identity, config, db } = makeCardFixtures();

    const card = generateAgentCard(identity, config, db);
    expect(JSON.stringify(card)).not.toContain("api.conway.tech");
  });

  it("generateAgentCard does NOT include creator address", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");
    const { identity, config, db } = makeCardFixtures();

    const card = generateAgentCard(identity, config, db);
    expect(JSON.stringify(card)).not.toContain(identity.creatorAddress);
  });

  it("generateAgentCard uses a solana:mainnet wallet endpoint", async () => {
    const { generateAgentCard } = await import("../registry/agent-card.js");
    const { identity, config, db } = makeCardFixtures();

    const card = generateAgentCard(identity, config, db);
    expect(card.services[0].endpoint).toBe(`solana:mainnet:${identity.address}`);
  });

  it("hostAgentCard writes card as separate JSON file", async () => {
    const { hostAgentCard } = await import("../registry/agent-card.js");

    const writtenFiles: Record<string, string> = {};
    const mockConway = {
      writeFile: vi.fn(async (path: string, content: string) => {
        writtenFiles[path] = content;
      }),
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      exposePort: vi.fn(async () => ({ port: 8004, publicUrl: "https://test.example.com", sandboxId: "sb-1" })),
    } as any;

    const card = {
      type: "test",
      name: "TestBot",
      description: "Test",
      services: [],
      x402Support: true,
      active: true,
    };

    await hostAgentCard(card, mockConway);

    // Card should be written as separate JSON file
    expect(writtenFiles["/tmp/agent-card.json"]).toBeTruthy();
    const writtenCard = JSON.parse(writtenFiles["/tmp/agent-card.json"]!);
    expect(writtenCard.name).toBe("TestBot");

    // Server script should NOT contain the card JSON interpolated
    const serverScript = writtenFiles["/tmp/agent-card-server.js"]!;
    expect(serverScript).not.toContain('"TestBot"');
    expect(serverScript).toContain("fs.readFileSync");
  });
});

// ─── 6. Attestation Feedback Tests ──────────────────────────────

describe("Attestation feedback validation", () => {
  it("buildFeedbackMemo rejects score 0", async () => {
    const { buildFeedbackMemo } = await import("../registry/solana-attestation.js");

    await expect(
      buildFeedbackMemo(makeIdentity(), { targetAgentId: "att1", score: 0, comment: "bad" }),
    ).rejects.toThrow("Invalid score: 0");
  });

  it("buildFeedbackMemo rejects score 6", async () => {
    const { buildFeedbackMemo } = await import("../registry/solana-attestation.js");

    await expect(
      buildFeedbackMemo(makeIdentity(), { targetAgentId: "att1", score: 6, comment: "too high" }),
    ).rejects.toThrow("Invalid score: 6");
  });

  it("buildFeedbackMemo rejects comment over 500 chars", async () => {
    const { buildFeedbackMemo } = await import("../registry/solana-attestation.js");

    const longComment = "x".repeat(501);
    await expect(
      buildFeedbackMemo(makeIdentity(), { targetAgentId: "att1", score: 3, comment: longComment }),
    ).rejects.toThrow("Comment too long");
  });

  it("buildFeedbackMemo produces a verifiable memo", async () => {
    const { buildFeedbackMemo } = await import("../registry/solana-attestation.js");

    const identity = makeIdentity();
    const memo = await buildFeedbackMemo(identity, {
      targetAgentId: "att1",
      score: 5,
      comment: "great agent",
    });

    expect(memo.type).toBe("conway-agent-feedback");
    expect(memo.fromWallet).toBe(identity.address);
    expect(bs58.decode(memo.signature).length).toBe(64);
  });
});

// ─── 7. Discovery Tests ────────────────────────────────────────

describe("Discovery", () => {
  it("validateAgentCard rejects cards with missing name", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({ type: "test" });
    expect(result).toBeNull();
  });

  it("validateAgentCard rejects cards with oversized name", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "x".repeat(200),
      type: "test",
    });
    expect(result).toBeNull();
  });

  it("validateAgentCard rejects cards with oversized description", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "TestAgent",
      type: "test",
      description: "x".repeat(2100),
    });
    expect(result).toBeNull();
  });

  it("validateAgentCard accepts valid card with Solana endpoint", async () => {
    const { validateAgentCard } = await import("../registry/discovery.js");

    const result = validateAgentCard({
      name: "TestAgent",
      type: "test",
      description: "A test agent",
      services: [{ name: "wallet", endpoint: `solana:mainnet:${randomAddress()}` }],
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("TestAgent");
  });

  it("isAllowedUri blocks HTTP", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("http://example.com/card.json")).toBe(false);
  });

  it("isAllowedUri allows HTTPS", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("https://example.com/card.json")).toBe(true);
  });

  it("isAllowedUri blocks localhost", async () => {
    const { isAllowedUri } = await import("../registry/discovery.js");
    expect(isAllowedUri("https://localhost/card.json")).toBe(false);
  });
});

// ─── 8. Schema Tests ───────────────────────────────────────────

describe("Schema", () => {
  it("MIGRATION_V7 creates discovered_agents_cache table", () => {
    const db = createTestDb();

    // Table should exist - try inserting
    const stmt = db.prepare(
      `INSERT INTO discovered_agents_cache
       (agent_address, agent_card, fetched_from, card_hash, valid_until, fetch_count, last_fetched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run(
        "testagent1",
        '{"name":"test"}',
        "https://example.com",
        "deadbeef",
        null,
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    ).not.toThrow();

    // Verify we can read it back
    const row = db
      .prepare("SELECT * FROM discovered_agents_cache WHERE agent_address = ?")
      .get("testagent1") as any;
    expect(row).toBeTruthy();
    expect(row.agent_card).toBe('{"name":"test"}');

    db.close();
  });

  it("MIGRATION_V7 creates onchain_transactions table", () => {
    const db = createTestDb();

    const stmt = db.prepare(
      `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, gas_used, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("id1", "txhash1", "solana:mainnet", "attest", "pending", null, "{}"),
    ).not.toThrow();

    const row = db
      .prepare("SELECT * FROM onchain_transactions WHERE tx_hash = ?")
      .get("txhash1") as any;
    expect(row).toBeTruthy();
    expect(row.operation).toBe("attest");
    expect(row.status).toBe("pending");

    db.close();
  });

  it("MIGRATION_V7 creates child_lifecycle_events table", () => {
    const db = createTestDb();

    const stmt = db.prepare(
      `INSERT INTO child_lifecycle_events (id, child_id, from_state, to_state, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("ev1", "child1", "requested", "sandbox_created", "test", "{}"),
    ).not.toThrow();

    db.close();
  });

  it("onchain_transactions status CHECK constraint works", () => {
    const db = createTestDb();

    const stmt = db.prepare(
      `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("id2", "txhash2", "solana:mainnet", "attest", "invalid_status"),
    ).toThrow();

    db.close();
  });
});

// ─── 9. DB Helpers Tests ────────────────────────────────────────

describe("DB Helpers", () => {
  it("agentCacheUpsert and agentCacheGet work", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCacheGet } = await import("../state/database.js");

    agentCacheUpsert(db, {
      agentAddress: "testagent1",
      agentCard: '{"name":"TestAgent"}',
      fetchedFrom: "https://example.com/card",
      cardHash: "deadbeef",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const row = agentCacheGet(db, "testagent1");
    expect(row).toBeTruthy();
    expect(row!.agentCard).toBe('{"name":"TestAgent"}');
    expect(row!.fetchCount).toBe(1);

    db.close();
  });

  it("agentCacheGetValid returns only valid entries", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCacheGetValid } = await import("../state/database.js");

    // Valid entry
    agentCacheUpsert(db, {
      agentAddress: "validagent",
      agentCard: '{"name":"Valid"}',
      fetchedFrom: "https://example.com",
      cardHash: "aa",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Expired entry
    agentCacheUpsert(db, {
      agentAddress: "expiredagent",
      agentCard: '{"name":"Expired"}',
      fetchedFrom: "https://example.com",
      cardHash: "bb",
      validUntil: "2020-01-01T00:00:00Z",
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const valid = agentCacheGetValid(db);
    expect(valid.length).toBe(1);
    expect(valid[0]!.agentAddress).toBe("validagent");

    db.close();
  });

  it("agentCachePrune removes expired entries", async () => {
    const db = createTestDb();
    const { agentCacheUpsert, agentCachePrune, agentCacheGet } = await import("../state/database.js");

    agentCacheUpsert(db, {
      agentAddress: "expiredagent",
      agentCard: '{"name":"Expired"}',
      fetchedFrom: "https://example.com",
      cardHash: "aa",
      validUntil: "2020-01-01T00:00:00Z",
      fetchCount: 1,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const pruned = agentCachePrune(db);
    expect(pruned).toBe(1);
    expect(agentCacheGet(db, "expiredagent")).toBeUndefined();

    db.close();
  });

  it("onchainTxInsert and onchainTxGetByHash work", async () => {
    const db = createTestDb();
    const { onchainTxInsert, onchainTxGetByHash } = await import("../state/database.js");

    onchainTxInsert(db, {
      id: "tx1",
      txHash: "sigabc",
      chain: "solana:mainnet",
      operation: "attest",
      status: "pending",
      gasUsed: null,
      metadata: "{}",
      createdAt: new Date().toISOString(),
    });

    const row = onchainTxGetByHash(db, "sigabc");
    expect(row).toBeTruthy();
    expect(row!.operation).toBe("attest");
    expect(row!.status).toBe("pending");

    db.close();
  });

  it("onchainTxGetAll with status filter works", async () => {
    const db = createTestDb();
    const { onchainTxInsert, onchainTxGetAll } = await import("../state/database.js");

    onchainTxInsert(db, {
      id: "tx1",
      txHash: "sig1",
      chain: "solana:mainnet",
      operation: "attest",
      status: "pending",
      gasUsed: null,
      metadata: "{}",
      createdAt: new Date().toISOString(),
    });

    onchainTxInsert(db, {
      id: "tx2",
      txHash: "sig2",
      chain: "solana:mainnet",
      operation: "feedback",
      status: "confirmed",
      gasUsed: 50000,
      metadata: "{}",
      createdAt: new Date().toISOString(),
    });

    const pending = onchainTxGetAll(db, { status: "pending" });
    expect(pending.length).toBe(1);

    const all = onchainTxGetAll(db);
    expect(all.length).toBe(2);

    db.close();
  });

  it("onchainTxUpdateStatus works", async () => {
    const db = createTestDb();
    const { onchainTxInsert, onchainTxUpdateStatus, onchainTxGetByHash } = await import("../state/database.js");

    onchainTxInsert(db, {
      id: "tx1",
      txHash: "sigupdate",
      chain: "solana:mainnet",
      operation: "attest",
      status: "pending",
      gasUsed: null,
      metadata: "{}",
      createdAt: new Date().toISOString(),
    });

    onchainTxUpdateStatus(db, "sigupdate", "confirmed", 75000);

    const row = onchainTxGetByHash(db, "sigupdate");
    expect(row!.status).toBe("confirmed");
    expect(row!.gasUsed).toBe(75000);

    db.close();
  });
});

// ─── 10. Protocol Tests ─────────────────────────────────────────

describe("Protocol", () => {
  it("createMessageId returns ULID", async () => {
    const { createMessageId } = await import("../social/protocol.js");
    const id = createMessageId();
    expect(id).toBeTruthy();
    expect(id.length).toBe(26); // ULID length
  });

  it("createNonce returns hex string", async () => {
    const { createNonce } = await import("../social/protocol.js");
    const nonce = createNonce();
    expect(nonce).toBeTruthy();
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(nonce.length).toBe(32); // 16 bytes = 32 hex chars
  });

  it("verifyMessageSignature validates correct signature", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyMessageSignature } = await import("../social/protocol.js");

    const identity = makeIdentity();
    const payload = await signSendPayload(identity, randomAddress(), "Test content");

    const valid = await verifyMessageSignature(payload, identity.address);
    expect(valid).toBe(true);
  });

  it("verifyMessageSignature rejects wrong signer", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyMessageSignature } = await import("../social/protocol.js");

    const identity = makeIdentity();
    const payload = await signSendPayload(identity, randomAddress(), "Test content");

    // Different address
    const valid = await verifyMessageSignature(payload, randomAddress());
    expect(valid).toBe(false);
  });

  it("verifyMessageSignature rejects tampered content", async () => {
    const { signSendPayload } = await import("../social/signing.js");
    const { verifyMessageSignature } = await import("../social/protocol.js");

    const identity = makeIdentity();
    const payload = await signSendPayload(identity, randomAddress(), "Test content");

    const valid = await verifyMessageSignature(
      { ...payload, content: "Tampered content" },
      identity.address,
    );
    expect(valid).toBe(false);
  });
});

// ─── 11. Address Validation Tests ───────────────────────────────

describe("Address Validation", () => {
  it("isValidAddress accepts a valid Solana address", async () => {
    const { isValidAddress } = await import("../social/validation.js");
    expect(isValidAddress(randomAddress())).toBe(true);
  });

  it("isValidAddress rejects short address", async () => {
    const { isValidAddress } = await import("../social/validation.js");
    expect(isValidAddress("short")).toBe(false);
  });

  it("isValidAddress rejects EVM-style 0x addresses", async () => {
    const { isValidAddress } = await import("../social/validation.js");
    expect(isValidAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe(false);
  });

  it("isValidAddress rejects garbage", async () => {
    const { isValidAddress } = await import("../social/validation.js");
    expect(isValidAddress("not-an-address!!!")).toBe(false);
  });
});
