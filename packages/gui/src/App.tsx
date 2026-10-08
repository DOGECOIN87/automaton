import { useCallback, useEffect, useState } from "react";
import { fetchJson, truncate, useEventStream } from "./api";
import Overview, { RuntimeState } from "./views/Overview";
import LoopView, { LoopCount } from "./views/Loop";
import ToolsView from "./views/Tools";
import HeartbeatView from "./views/Heartbeat";
import { MemoryView, ReplicationView, PolicyView } from "./views/Misc";
import LogsView from "./views/Logs";
import MetricsView from "./views/Metrics";
import "./styles.css";

type Tab = "overview" | "loop" | "tools" | "heartbeat" | "memory" | "replication" | "logs" | "metrics";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "loop", label: "Agent Loop" },
  { id: "tools", label: "Tools" },
  { id: "heartbeat", label: "Heartbeat" },
  { id: "memory", label: "Memory" },
  { id: "replication", label: "Replication" },
  { id: "logs", label: "Logs" },
  { id: "metrics", label: "Metrics" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [state, setState] = useState<RuntimeState | null>(null);
  const { events, connected } = useEventStream();

  const refresh = useCallback(async () => {
    const r = await fetchJson<{ state: RuntimeState }>("/api/state");
    if (r?.state) setState(r.state);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const toolCalls = events.filter((e) => e.type === "tool.called").length;
  const logLines = events.filter((e) => e.type === "log.line").length;

  return (
    <div className="app">
      <div className="topbar">
        <h1><span className="dot">●</span> AUTOMATON</h1>
        <div className={`conn ${connected ? "live" : ""}`}>
          <span className="pulse" />
          {connected ? "live" : "reconnecting…"}
        </div>
        <div className="spacer" />
        <span className="addr">{truncate(state?.address, 10) ?? ""}</span>
      </div>
      <div className="nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "loop" && <span className="badge">{LoopCount({ events })}</span>}
            {t.id === "tools" && toolCalls > 0 && <span className="badge">{toolCalls}</span>}
            {t.id === "logs" && logLines > 0 && <span className="badge">{logLines > 999 ? "999+" : logLines}</span>}
          </button>
        ))}
      </div>
      <div className="main">
        {tab === "overview" && <Overview state={state} events={events} />}
        {tab === "loop" && <LoopView events={events} />}
        {tab === "tools" && (
          <div>
            <ToolsView events={events} />
            <div style={{ marginTop: 16 }}><PolicyView events={events} /></div>
          </div>
        )}
        {tab === "heartbeat" && <HeartbeatView state={state} events={events} />}
        {tab === "memory" && <MemoryView events={events} />}
        {tab === "replication" && <ReplicationView state={state} events={events} />}
        {tab === "logs" && <LogsView events={events} />}
        {tab === "metrics" && <MetricsView events={events} />}
      </div>
    </div>
  );
}
