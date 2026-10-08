/**
 * GUI Bootstrap
 *
 * Wiring between the automaton runtime CLI (src/index.ts) and the GUI server.
 * - `startGuiFromConfig()`: standalone `automaton --gui` mode — opens the
 *   state DB and serves the dashboard + DB-backed API endpoints.
 * - `createLiveProvider()`: provider for `automaton --run --gui`, serving
 *   live runtime state (identity, balances, tier, tools, heartbeats).
 *
 * Chain-agnostic: only reads address/chainType as opaque strings.
 */

import { startGuiServer, resolveGuiPort, type GuiDataProvider, type GuiServer } from "./server.js";
import { getEventBus, type StoredBusEvent } from "../observability/event-bus.js";
import { createLogger } from "../observability/logger.js";
import type { AutomatonConfig, AutomatonDatabase, AutomatonIdentity, AutomatonTool } from "../types.js";

const logger = createLogger("gui");

function summarizeTool(t: AutomatonTool): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    category: t.category,
    riskLevel: t.riskLevel,
    parameters: t.parameters,
  };
}

/** Live provider used by `automaton --run --gui`. Callers supply tools. */
export function createLiveProvider(opts: {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  tools: AutomatonTool[];
}): GuiDataProvider {
  const { identity, config, db, tools } = opts;

  const getState = async () => {
    const financialStr = db.getKV("financial_state");
    let financial: unknown = null;
    try {
      financial = financialStr ? JSON.parse(financialStr) : null;
    } catch {
      financial = null;
    }
    const byCategory: Record<string, number> = {};
    for (const t of tools) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;

    // Dedicated child-funding wallet (address + live SOL balance, shown prominently in the GUI).
    let fundingWallet: { address: string; childFundSol: number; solBalance: number | null } | null = null;
    try {
      const { loadFundingWallet, getChildFundSol, getFundingWalletBalanceLamports } =
        await import("../solana/funding-wallet.js");
      const { LAMPORTS_PER_SOL } = await import("@solana/web3.js");
      const fw = loadFundingWallet();
      if (fw) {
        let solBalance: number | null = null;
        try {
          solBalance = (await getFundingWalletBalanceLamports(fw.address)) / LAMPORTS_PER_SOL;
        } catch {
          solBalance = null; // RPC unreachable — GUI shows "unknown" instead of failing
        }
        fundingWallet = { address: fw.address, childFundSol: getChildFundSol(), solBalance };
      }
    } catch {
      fundingWallet = null;
    }

    return {
      source: "live",
      name: config.name,
      version: config.version,
      address: identity.address,
      chainType: (identity as { chainType?: string }).chainType ?? config.chainType ?? "solana",
      agentState: db.getAgentState(),
      turnCount: db.getTurnCount(),
      tier: db.getKV("current_tier"),
      financial,
      fundingWallet,
      startedAt: db.getKV("start_time"),
      toolsSummary: { total: tools.length, byCategory },
      heartbeat: {
        entries: db.getHeartbeatEntries().map((h) => ({
          name: h.name,
          schedule: h.schedule,
          enabled: h.enabled,
          task: h.task,
        })),
        lastPing: db.getKV("last_heartbeat_ping"),
      },
      children: db.getChildren().map((c: any) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        status: c.status,
        sandboxId: c.sandboxId,
        createdAt: c.createdAt,
      })),
    };
  };

  const getTools = () => ({ tools: tools.map(summarizeTool) });

  const getTurns = (limit: number) =>
    db.getRecentTurns(Math.min(limit, 500)).map((t: any) => ({
      id: t.id,
      timestamp: t.timestamp,
      state: t.state,
      inputSource: t.inputSource,
      thinking: typeof t.thinking === "string" ? t.thinking.slice(0, 500) : t.thinking,
      toolCalls: (t.toolCalls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        result: typeof tc.result === "string" ? tc.result.slice(0, 500) : tc.result,
        durationMs: tc.durationMs,
        error: tc.error,
      })),
      tokenUsage: t.tokenUsage,
    }));

  const getLogs = (limit: number) =>
    getEventBus()
      .snapshot()
      .filter((e) => e.type === "log.line")
      .slice(-limit)
      .map((e) => {
        const line = e as Extract<StoredBusEvent, { type: "log.line" }>;
        return {
          timestamp: e.timestamp,
          level: line.level,
          module: line.module,
          message: line.message,
          error: line.error,
        };
      });

  return { getState, getTools, getTurns, getLogs };
}

/**
 * Standalone mode: `automaton --gui`. Loads config + opens the DB
 * (read-only usage; no wallet, no network) and serves the dashboard.
 * Resolves once the server is listening; never resolves the process.
 */
export async function startGuiStandalone(args: string[]): Promise<GuiServer> {
  const port = resolveGuiPort(args);
  const { loadConfig, resolvePath } = await import("../config.js");
  const { createDatabase } = await import("../state/database.js");

  const config = loadConfig();
  let provider: GuiDataProvider | undefined;

  if (config) {
    try {
      const db = createDatabase(resolvePath(config.dbPath));
      const { createBuiltinTools, loadInstalledTools } = await import("../agent/tools.js");
      const tools = [
        ...createBuiltinTools(config.sandboxId ?? "local"),
        ...loadInstalledTools(db),
      ];
      provider = createLiveProvider({
        identity: {
          name: config.name,
          address: config.walletAddress ?? "",
          account: {} as never,
          creatorAddress: config.creatorAddress,
          sandboxId: config.sandboxId ?? "",
          apiKey: "",
          createdAt: "",
          chainType: config.chainType as never,
        } as AutomatonIdentity,
        config,
        db,
        tools,
      });
    } catch (err: any) {
      logger.warn(`Standalone GUI: could not open state DB: ${err?.message ?? err}`);
    }
  } else {
    logger.warn("Standalone GUI: no config found — serving bus-only live data.");
  }

  const server = await startGuiServer({ port, provider });
  logger.info(`GUI dashboard: http://127.0.0.1:${port}`);
  return server;
}
