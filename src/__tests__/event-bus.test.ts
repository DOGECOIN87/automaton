/**
 * Event Bus Tests
 *
 * Covers the typed in-process event bus used by the GUI + hooks:
 * pub/sub, wildcard subscription, ring-buffer snapshot/replay,
 * timestamp+seq assignment, and the never-throw guarantees.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EventBus,
  getEventBus,
  safeEmit,
  type BusEvent,
} from "../observability/event-bus.js";

function turnEvent(): BusEvent {
  return { type: "loop.turn.started", turnId: "t1" };
}

describe("EventBus", () => {
  it("delivers events to type-specific subscribers", () => {
    const bus = new EventBus();
    const seen: BusEvent[] = [];
    bus.subscribe("loop.turn.started", (e) => seen.push(e));
    bus.emit(turnEvent());
    bus.emit({ type: "heartbeat.tick", tickIntervalMs: 1000 });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("loop.turn.started");
  });

  it("supports wildcard subscriptions", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("*", (e) => seen.push(e.type));
    bus.emit(turnEvent());
    bus.emit({ type: "heartbeat.tick", tickIntervalMs: 1000 });
    expect(seen).toEqual(["loop.turn.started", "heartbeat.tick"]);
  });

  it("assigns timestamps and monotonic sequence numbers", () => {
    const bus = new EventBus();
    bus.emit(turnEvent());
    bus.emit(turnEvent());
    const snap = bus.snapshot();
    expect(snap).toHaveLength(2);
    expect(typeof snap[0].timestamp).toBe("string");
    expect(snap[1].seq).toBe(snap[0].seq + 1);
  });

  it("keeps a bounded ring buffer", () => {
    const bus = new EventBus(10);
    for (let i = 0; i < 25; i++) bus.emit(turnEvent());
    expect(bus.size()).toBe(10);
    expect(bus.snapshot()).toHaveLength(10);
  });

  it("replays events after a sequence number", () => {
    const bus = new EventBus();
    bus.emit(turnEvent());
    bus.emit(turnEvent());
    bus.emit(turnEvent());
    const snap = bus.snapshot();
    const after = bus.after(snap[0].seq);
    expect(after).toHaveLength(2);
    expect(after[0].seq).toBeGreaterThan(snap[0].seq);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe("loop.turn.started", handler);
    bus.emit(turnEvent());
    unsub();
    bus.emit(turnEvent());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("swallows throwing handlers so the runtime never breaks", () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe("loop.turn.started", () => {
      throw new Error("listener blew up");
    });
    bus.subscribe("loop.turn.started", good);
    expect(() => bus.emit(turnEvent())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    // The event still landed in the buffer
    expect(bus.size()).toBe(1);
  });

  it("safeEmit never throws", () => {
    expect(() => safeEmit(turnEvent())).not.toThrow();
  });

  it("getEventBus returns a process-wide singleton", () => {
    expect(getEventBus()).toBe(getEventBus());
  });
});
