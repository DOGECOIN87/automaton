import { BusEvent, byType, fmtTime } from "../api";

function FeedItem({ e }: { e: BusEvent }) {
  const t = e.type;
  if (t === "loop.turn.started") {
    return (
      <div className="feed-item">
        <div className="head"><span className="tag">turn.started</span><span className="time">{fmtTime(e.timestamp)}</span></div>
        <div className="body mono">turn {String(e.turnId).slice(0, 8)}… · input: {String(e.inputSource ?? "—")} · state: {String(e.agentState ?? "—")}</div>
      </div>
    );
  }
  if (t === "loop.turn.thinking") {
    return (
      <div className="feed-item">
        <div className="head"><span className="tag">turn.thinking</span><span className="time">{fmtTime(e.timestamp)}</span></div>
        <div className="body">
          <div className="note">{String(e.model ?? "")} · {String(e.promptTokens ?? 0)} in / {String(e.completionTokens ?? 0)} out tokens</div>
          <pre>{String(e.thinkingSummary ?? "")}</pre>
        </div>
      </div>
    );
  }
  if (t === "loop.turn.acting") {
    return (
      <div className="feed-item">
        <div className="head"><span className="tag">turn.acting</span><span className="time">{fmtTime(e.timestamp)}</span></div>
        <div className="body mono">{String(e.toolCallCount)} tool call(s): {((e.toolNames as string[]) ?? []).join(", ")}</div>
      </div>
    );
  }
  if (t === "loop.turn.observed") {
    return (
      <div className="feed-item">
        <div className="head"><span className="tag">turn.observed</span><span className="time">{fmtTime(e.timestamp)}</span></div>
        <div className="body mono">
          turn {String(e.turnId).slice(0, 8)}… · {String(e.toolCallCount)} calls · {String(e.errors)} errors · {String(e.tokenUsage ?? 0)} tokens · state {String(e.agentState ?? "—")}
        </div>
      </div>
    );
  }
  if (t === "tool.called") {
    return (
      <div className="feed-item tool-called">
        <div className="head"><span className="tag">tool.called</span><span className="time">{fmtTime(e.timestamp)}</span></div>
        <div className="body mono">{String(e.toolName)}</div>
        <div className="body"><pre>{String(e.argsSummary ?? "")}</pre></div>
      </div>
    );
  }
  if (t === "tool.succeeded" || t === "tool.failed") {
    return (
      <div className={`feed-item ${t === "tool.succeeded" ? "tool-succeeded" : "tool-failed"}`}>
        <div className="head">
          <span className="tag">{t}</span>
          <span className="mono">{String(e.toolName)} · {String(e.latencyMs)}ms</span>
          <span className="time">{fmtTime(e.timestamp)}</span>
        </div>
        <div className="body"><pre>{t === "tool.succeeded" ? String(e.resultSummary ?? "") : `ERROR: ${String(e.error ?? "")}`}</pre></div>
      </div>
    );
  }
  return null;
}

const LOOP_TYPES = new Set([
  "loop.turn.started",
  "loop.turn.thinking",
  "loop.turn.acting",
  "loop.turn.observed",
  "tool.called",
  "tool.succeeded",
  "tool.failed",
]);

export default function LoopView({ events }: { events: BusEvent[] }) {
  const feed = events.filter((e) => LOOP_TYPES.has(e.type)).slice(-150).reverse();
  if (feed.length === 0) return <div className="empty">No loop activity yet. Start the agent to see think → act → observe events.</div>;
  return (
    <div className="feed">
      {feed.map((e) => (
        <FeedItem key={e.seq} e={e} />
      ))}
    </div>
  );
}

export function LoopCount({ events }: { events: BusEvent[] }) {
  return byType(events, "loop.turn.observed").length;
}
