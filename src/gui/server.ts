/**
 * GUI Server
 *
 * HTTP + SSE server (Node http only, no extra deps) serving the React
 * dashboard build at packages/gui/dist and streaming EventBus events.
 *
 * Endpoints:
 *   GET /api/events  SSE stream of bus events, with replay of recent buffer on connect
 *   GET /api/state   snapshot: latest loop status, balances, tier, tools summary, heartbeat info
 *   GET /api/tools   full tool registry listing
 *   GET /api/turns   recent turn history
 *   GET /api/logs    recent log lines
 *   GET /health      liveness probe
 *   GET /            static dashboard (index.html)
 *
 * Chain-agnostic: all chain data arrives as plain fields via the data
 * provider or bus events; this server contains no chain logic.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEventBus, type StoredBusEvent, type BusEvent } from "../observability/event-bus.js";

/** Optional hooks the runtime can supply; the server works without them. */
export interface GuiDataProvider {
  /** Latest loop status, balances, tier, tools registry summary, heartbeat info. */
  getState?: () => unknown | Promise<unknown>;
  /** Full tool registry listing. */
  getTools?: () => unknown | Promise<unknown>;
  /** Recent turn history. */
  getTurns?: (limit: number) => unknown | Promise<unknown>;
  /** Recent log lines. */
  getLogs?: (limit: number) => unknown | Promise<unknown>;
}

export interface GuiServerOptions {
  port: number;
  host?: string;
  /** Directory of the built dashboard. Defaults to ../../packages/gui/dist. */
  staticDir?: string;
  provider?: GuiDataProvider;
}

export interface GuiServer {
  port: number;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function defaultStaticDir(): string {
  // src/gui/server.ts compiles to dist/gui/server.js → ../../packages/gui/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "packages", "gui", "dist");
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseLimit(url: URL, def: number, max: number): number {
  const raw = url.searchParams.get("limit");
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, n));
}

/** Derive log lines from the bus buffer when no provider supplies them. */
function busLogLines(limit: number): unknown[] {
  const events = getEventBus()
    .snapshot()
    .filter((e) => e.type === "log.line")
    .slice(-limit);
  return events.map((e) => {
    const line = e as Extract<StoredBusEvent, { type: "log.line" }>;
    return {
      timestamp: e.timestamp,
      level: line.level,
      module: line.module,
      message: line.message,
      error: line.error,
    };
  });
}

/** Derive turn history from the bus buffer when no provider supplies it. */
function busTurnHistory(limit: number): unknown[] {
  const events = getEventBus()
    .snapshot()
    .filter((e) => e.type === "loop.turn.observed")
    .slice(-limit);
  return events.map((e) => {
    const t = e as Extract<StoredBusEvent, { type: "loop.turn.observed" }>;
    return {
      turnId: t.turnId,
      timestamp: e.timestamp,
      toolCallCount: t.toolCallCount,
      errors: t.errors,
      tokenUsage: t.tokenUsage,
      agentState: t.agentState,
    };
  });
}

/** Derive a minimal state from the bus buffer when no provider supplies it. */
function busDerivedState(): Record<string, unknown> {
  const snapshot = getEventBus().snapshot();
  const pick = <T extends StoredBusEvent["type"]>(type: T) => {
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (snapshot[i].type === type) return snapshot[i];
    }
    return null;
  };
  const lastTurn = pick("loop.turn.observed");
  const lastTier = pick("survival.tier_changed");
  const lastBalance = pick("wallet.balance");
  const lastHeartbeat = pick("heartbeat.tick");
  return {
    source: "bus",
    loop: lastTurn
      ? {
          lastTurnId: (lastTurn as Extract<StoredBusEvent, { type: "loop.turn.observed" }>).turnId,
          timestamp: lastTurn.timestamp,
        }
      : null,
    survival: lastTier
      ? {
          tier: (lastTier as Extract<StoredBusEvent, { type: "survival.tier_changed" }>).tier,
          creditsCents: (lastTier as Extract<StoredBusEvent, { type: "survival.tier_changed" }>).creditsCents,
        }
      : null,
    wallet: lastBalance
      ? {
          address: (lastBalance as Extract<StoredBusEvent, { type: "wallet.balance" }>).address,
          creditsCents: (lastBalance as Extract<StoredBusEvent, { type: "wallet.balance" }>).creditsCents,
          usdcBalance: (lastBalance as Extract<StoredBusEvent, { type: "wallet.balance" }>).usdcBalance,
        }
      : null,
    heartbeat: lastHeartbeat ? { lastTick: lastHeartbeat.timestamp } : null,
  };
}

function serveStatic(staticDir: string, urlPath: string, res: http.ServerResponse): void {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Prevent path traversal
  const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(staticDir, safeRel);
  if (!filePath.startsWith(staticDir)) filePath = path.join(staticDir, "index.html");

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: unknown paths serve index.html so client routes work
      if (filePath !== path.join(staticDir, "index.html")) {
        serveStatic(staticDir, "/index.html", res);
        return;
      }
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Dashboard build not found. Run `pnpm --filter @conway/automaton-gui build` first.");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    setCors(res);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
  const bus = getEventBus();
  const url = new URL(req.url ?? "/api/events", "http://localhost");
  const afterParam = url.searchParams.get("after");
  const lastEventId = req.headers["last-event-id"];
  const afterSeq =
    afterParam !== null ? parseInt(afterParam, 10)
    : typeof lastEventId === "string" ? parseInt(lastEventId, 10)
    : NaN;

  setCors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const replay = Number.isFinite(afterSeq)
    ? bus.after(afterSeq as number, 500)
    : bus.snapshot(200);
  for (const event of replay) {
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const handler = (event: BusEvent): void => {
    const e = event as StoredBusEvent;
    try {
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    } catch {
      // Client likely gone; the 'close' handler cleans up.
    }
  };
  const unsubscribe = bus.subscribe("*", handler);

  // Heartbeat comment so proxies / clients don't time out idle streams
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, 25_000);
  keepAlive.unref();

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

export function startGuiServer(options: GuiServerOptions): Promise<GuiServer> {
  const { port, host = "127.0.0.1", provider } = options;
  const staticDir = options.staticDir ?? defaultStaticDir();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        setCors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/health") {
        sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
        return;
      }

      if (pathname === "/api/events" && req.method === "GET") {
        handleSse(req, res);
        return;
      }

      if (pathname === "/api/state" && req.method === "GET") {
        try {
          const state = provider?.getState ? await provider.getState() : busDerivedState();
          sendJson(res, 200, { state });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? "getState failed" });
        }
        return;
      }

      if (pathname === "/api/tools" && req.method === "GET") {
        try {
          const tools = provider?.getTools ? await provider.getTools() : { tools: [] };
          sendJson(res, 200, tools);
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? "getTools failed" });
        }
        return;
      }

      if (pathname === "/api/turns" && req.method === "GET") {
        const limit = parseLimit(url, 50, 500);
        try {
          const turns = provider?.getTurns ? await provider.getTurns(limit) : busTurnHistory(limit);
          sendJson(res, 200, { turns });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? "getTurns failed" });
        }
        return;
      }

      if (pathname === "/api/logs" && req.method === "GET") {
        const limit = parseLimit(url, 200, 1000);
        try {
          const logs = provider?.getLogs ? await provider.getLogs(limit) : busLogLines(limit);
          sendJson(res, 200, { logs });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? "getLogs failed" });
        }
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "unknown endpoint" });
        return;
      }

      if (req.method === "GET") {
        serveStatic(staticDir, pathname, res);
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    } catch (err: any) {
      try {
        sendJson(res, 500, { error: err?.message ?? "internal error" });
      } catch {
        // ignore
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      resolve({
        port,
        close: () =>
          new Promise<void>((resClose) => server.close(() => resClose())),
      });
    });
  });
}

/** Resolve the port from --gui-port=<n> or --gui-port <n>, defaulting when absent. */
export function resolveGuiPort(args: string[], defaultPort = 3417): number {
  const eq = args.find((a) => a.startsWith("--gui-port="));
  if (eq) {
    const n = parseInt(eq.split("=")[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const idx = args.indexOf("--gui-port");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return defaultPort;
}
