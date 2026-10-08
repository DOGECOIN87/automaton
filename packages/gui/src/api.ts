import { useEffect, useRef, useState } from "react";

/** Mirror of the bus event union (snake_case JSON from the server). */
export interface BusEvent {
  type: string;
  timestamp: string;
  seq: number;
  [key: string]: unknown;
}

export const EVENT_TYPES = [
  "loop.turn.started",
  "loop.turn.thinking",
  "loop.turn.acting",
  "loop.turn.observed",
  "tool.called",
  "tool.succeeded",
  "tool.failed",
  "heartbeat.tick",
  "survival.tier_changed",
  "wallet.balance",
  "funding.topup",
  "memory.written",
  "replication.child_spawned",
  "policy.decision",
  "log.line",
  "metrics.sample",
] as const;

const MAX_EVENTS = 2000;

export interface StreamState {
  events: BusEvent[];
  connected: boolean;
}

/**
 * SSE client with auto-reconnect + exponential backoff.
 * Replays missed events via ?after=<last seq> on reconnect.
 */
export function useEventStream(): StreamState {
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef<number | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let backoffMs = 1000;

    const onMessage = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as BusEvent;
        const seq = e.lastEventId ? parseInt(e.lastEventId, 10) : ev.seq;
        if (Number.isFinite(seq) && (lastSeq.current === null || seq > lastSeq.current)) {
          lastSeq.current = seq;
        }
        setEvents((prev) => {
          // Deduplicate on reconnect replays
          if (prev.some((p) => p.seq === ev.seq)) return prev;
          const next = [...prev, ev];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
      } catch {
        // ignore malformed frames
      }
    };

    const connect = () => {
      if (closed) return;
      const url =
        lastSeq.current !== null ? `/api/events?after=${lastSeq.current}` : "/api/events";
      es = new EventSource(url);
      es.onopen = () => {
        setConnected(true);
        backoffMs = 1000;
      };
      for (const t of EVENT_TYPES) {
        es.addEventListener(t, onMessage as EventListener);
      }
      es.onerror = () => {
        setConnected(false);
        try {
          es?.close();
        } catch {
          // ignore
        }
        if (!closed) {
          const delay = backoffMs;
          backoffMs = Math.min(backoffMs * 2, 30000);
          setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      try {
        es?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  return { events, connected };
}

export async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

export function truncate(addr?: string, n = 10): string {
  if (!addr) return "—";
  if (addr.length <= n * 2 + 3) return addr;
  return `${addr.slice(0, n)}…${addr.slice(-n)}`;
}

export function byType(events: BusEvent[], type: string): BusEvent[] {
  return events.filter((e) => e.type === type);
}
