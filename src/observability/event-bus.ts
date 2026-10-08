/**
 * Typed In-Process Event Bus
 *
 * Chain-agnostic pub/sub for observability. Zero dependencies.
 * Used by the runtime to emit lifecycle events and by the GUI server
 * to stream them over SSE.
 *
 * Design:
 * - `emit(event)`: publish a typed event; handler errors are swallowed so a
 *   throwing listener can never break the runtime.
 * - `subscribe(type | '*', handler)`: subscribe to one event type or all.
 * - `snapshot(limit?)`: recent events from a ring buffer (default cap 500).
 *
 * Single global singleton via `getEventBus()`; a fresh bus can be constructed
 * directly for tests.
 */

export interface BusEventBase {
  /** Event discriminator, e.g. "loop.turn.started" */
  type: string;
  /** ISO timestamp, set by the bus if omitted */
  timestamp?: string;
}

/** Agent Think→Act→Observe loop events */
export interface LoopTurnStartedEvent extends BusEventBase {
  type: "loop.turn.started";
  turnId: string;
  inputSource?: string;
  agentState?: string;
}
export interface LoopTurnThinkingEvent extends BusEventBase {
  type: "loop.turn.thinking";
  turnId: string;
  thinkingSummary: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}
export interface LoopTurnActingEvent extends BusEventBase {
  type: "loop.turn.acting";
  turnId: string;
  toolCallCount: number;
  toolNames: string[];
}
export interface LoopTurnObservedEvent extends BusEventBase {
  type: "loop.turn.observed";
  turnId: string;
  toolCallCount: number;
  errors: number;
  tokenUsage?: number;
  agentState?: string;
}

/** Tool execution events */
export interface ToolCalledEvent extends BusEventBase {
  type: "tool.called";
  toolName: string;
  argsSummary: string;
  turnId?: string;
}
export interface ToolSucceededEvent extends BusEventBase {
  type: "tool.succeeded";
  toolName: string;
  argsSummary: string;
  resultSummary: string;
  latencyMs: number;
  turnId?: string;
}
export interface ToolFailedEvent extends BusEventBase {
  type: "tool.failed";
  toolName: string;
  argsSummary: string;
  error: string;
  latencyMs: number;
  turnId?: string;
}

/** Heartbeat daemon events */
export interface HeartbeatTickEvent extends BusEventBase {
  type: "heartbeat.tick";
  tickIntervalMs: number;
  tasksRun?: number;
}

/** Survival / resource events */
export interface SurvivalTierChangedEvent extends BusEventBase {
  type: "survival.tier_changed";
  previousTier: string | null;
  tier: string;
  creditsCents: number;
}
export interface WalletBalanceEvent extends BusEventBase {
  type: "wallet.balance";
  address: string;
  creditsCents: number;
  usdcBalance: number;
  /** Chain label, e.g. "evm" | "solana" — informational only, never chain-specific logic */
  chainType?: string;
}

/** Funding events */
export interface FundingTopupEvent extends BusEventBase {
  type: "funding.topup";
  strategy: string;
  success: boolean;
  details: string;
}

/** Memory events */
export interface MemoryWrittenEvent extends BusEventBase {
  type: "memory.written";
  sessionId: string;
  turnId: string;
  classification?: string;
  entriesWritten: number;
}

/** Replication events */
export interface ReplicationChildSpawnedEvent extends BusEventBase {
  type: "replication.child_spawned";
  childId: string;
  name: string;
  address: string;
  sandboxId: string;
}

/** Emitted when a spawn is refused (e.g. funding wallet missing/insufficient). */
export interface ReplicationSpawnRefusedEvent extends BusEventBase {
  type: "replication.spawn_refused";
  childName: string;
  reason: string;
  fundingWalletAddress?: string | null;
  fundingWalletBalanceSol?: number;
}

/** Policy events */
export interface PolicyDecisionEvent extends BusEventBase {
  type: "policy.decision";
  toolName: string;
  action: string;
  reasonCode: string;
  humanMessage: string;
  rulesTriggered: string[];
}

/** Log events */
export interface LogLineEvent extends BusEventBase {
  type: "log.line";
  level: string;
  module: string;
  message: string;
  error?: string;
}

/** Metrics events */
export interface MetricsSampleEvent extends BusEventBase {
  type: "metrics.sample";
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, number[]>;
}

/** Union of every event the bus can carry. */
export type BusEvent =
  | LoopTurnStartedEvent
  | LoopTurnThinkingEvent
  | LoopTurnActingEvent
  | LoopTurnObservedEvent
  | ToolCalledEvent
  | ToolSucceededEvent
  | ToolFailedEvent
  | HeartbeatTickEvent
  | SurvivalTierChangedEvent
  | WalletBalanceEvent
  | FundingTopupEvent
  | MemoryWrittenEvent
  | ReplicationChildSpawnedEvent
  | ReplicationSpawnRefusedEvent
  | PolicyDecisionEvent
  | LogLineEvent
  | MetricsSampleEvent;

export type BusEventType = BusEvent["type"];

export type BusHandler = (event: BusEvent) => void;

/**
 * A bus event with bus-assigned metadata. Distributes over the union so
 * type narrowing on `type` still works.
 */
export type StoredBusEvent = BusEvent & {
  timestamp: string;
  /** Monotonic sequence number for replay ordering */
  seq: number;
};

const DEFAULT_RING_CAPACITY = 500;

export class EventBus {
  private handlers = new Map<string, Set<BusHandler>>();
  private wildcards = new Set<BusHandler>();
  private ring: StoredBusEvent[] = [];
  private seq = 0;
  private capacity: number;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Publish an event. Timestamps and sequences it, appends to the ring
   * buffer, then notifies handlers. Handler errors are swallowed — a
   * throwing listener must never break the runtime.
   */
  emit(event: BusEvent): void {
    const stored: StoredBusEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
      seq: this.seq++,
    };

    this.ring.push(stored);
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity);
    }

    const notify = (handler: BusHandler): void => {
      try {
        handler(stored);
      } catch {
        // Swallow: listener failure must never break the runtime.
      }
    };

    const specific = this.handlers.get(stored.type);
    if (specific) {
      for (const handler of specific) notify(handler);
    }
    for (const handler of this.wildcards) notify(handler);
  }

  /** Subscribe to one event type, or '*' for all events. Returns an unsubscribe fn. */
  subscribe(type: BusEventType | "*", handler: BusHandler): () => void {
    if (type === "*") {
      this.wildcards.add(handler);
      return () => {
        this.wildcards.delete(handler);
      };
    }
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Recent events from the ring buffer, oldest first. */
  snapshot(limit?: number): StoredBusEvent[] {
    const events = this.ring.slice();
    return limit === undefined ? events : events.slice(-limit);
  }

  /** Events after a given sequence number (for SSE replay), oldest first. */
  after(seq: number, limit?: number): StoredBusEvent[] {
    const events = this.ring.filter((e) => e.seq > seq);
    return limit === undefined ? events : events.slice(-limit);
  }

  size(): number {
    return this.ring.length;
  }

  clear(): void {
    this.ring = [];
  }
}

let singleton: EventBus | null = null;

/** Global process-wide event bus singleton. */
export function getEventBus(): EventBus {
  if (!singleton) {
    singleton = new EventBus(DEFAULT_RING_CAPACITY);
  }
  return singleton;
}

/** Replace the global singleton (tests). */
export function setEventBus(bus: EventBus): void {
  singleton = bus;
}

/**
 * Small helper so hook sites stay 1–5 lines: emits without ever throwing,
 * even if the bus itself were somehow broken.
 */
export function safeEmit(event: BusEvent): void {
  try {
    getEventBus().emit(event);
  } catch {
    // Never break the runtime for observability.
  }
}
