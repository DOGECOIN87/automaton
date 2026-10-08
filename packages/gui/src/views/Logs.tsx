import { useEffect, useRef, useState } from "react";
import { BusEvent, byType } from "../api";

export default function LogsView({ events }: { events: BusEvent[] }) {
  const [level, setLevel] = useState("all");
  const [moduleFilter, setModuleFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  const lines = byType(events, "log.line").filter((e) => {
    if (level !== "all" && String(e.level) !== level) return false;
    if (moduleFilter && !String(e.module).toLowerCase().includes(moduleFilter.toLowerCase())) return false;
    return true;
  });

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  const shown = lines.slice(-500);

  return (
    <div>
      <div className="filters">
        <label>
          Level
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
            <option value="fatal">fatal</option>
          </select>
        </label>
        <label>
          Module
          <input value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} placeholder="filter…" />
        </label>
        <label>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          auto-scroll
        </label>
        <span className="note">{shown.length} lines</span>
      </div>
      <div className="logs" ref={ref}>
        {shown.length === 0 ? (
          <div className="empty">No log lines yet.</div>
        ) : (
          shown.map((e: BusEvent) => (
            <div className="log-row" key={e.seq}>
              <span className="lt">{new Date(e.timestamp).toLocaleTimeString()}</span>
              <span className={`lv ${String(e.level)}`}>{String(e.level).padEnd(5)}</span>
              <span className="lm">{String(e.module)}</span>
              <span>{String(e.message)}{e.error ? ` — ${String(e.error)}` : ""}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
