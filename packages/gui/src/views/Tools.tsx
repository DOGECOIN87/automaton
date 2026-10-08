import { useEffect, useState } from "react";
import { BusEvent, byType, fetchJson, fmtTime } from "../api";

export interface ToolDef {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  parameters: unknown;
}

const RISK_COLOR: Record<string, string> = { safe: "#3ddc84", caution: "#ffcf4d", dangerous: "#ff5d5d" };

export default function ToolsView({ events }: { events: BusEvent[] }) {
  const [registry, setRegistry] = useState<ToolDef[]>([]);

  useEffect(() => {
    fetchJson<{ tools: ToolDef[] }>("/api/tools").then((r) => {
      if (r?.tools) setRegistry(r.tools);
    });
  }, []);

  const calls = events
    .filter((e) => e.type === "tool.called" || e.type === "tool.succeeded" || e.type === "tool.failed")
    .slice(-60)
    .reverse();

  const counts = new Map<string, number>();
  for (const e of byType(events, "tool.succeeded")) counts.set(String(e.toolName), (counts.get(String(e.toolName)) ?? 0) + 1);
  for (const e of byType(events, "tool.failed")) counts.set(String(e.toolName), (counts.get(String(e.toolName)) ?? 0) + 1);

  return (
    <div>
      <div className="panel">
        <h2>Registry <span className="muted">({registry.length} tools)</span></h2>
        {registry.length === 0 ? (
          <div className="note">Registry unavailable — connect the GUI to a running runtime for the full listing.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Risk</th><th>Calls (session)</th><th>Description</th></tr></thead>
            <tbody>
              {registry.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="mono">{t.category}</td>
                  <td><span style={{ color: RISK_COLOR[t.riskLevel] ?? "#8b96a8" }}>{t.riskLevel}</span></td>
                  <td className="mono">{counts.get(t.name) ?? 0}</td>
                  <td className="note">{t.description.slice(0, 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Live call feed <span className="muted">(args · results · latency)</span></h2>
        {calls.length === 0 ? (
          <div className="note">No tool calls in this session yet.</div>
        ) : (
          <div className="feed" style={{ maxHeight: "50vh" }}>
            {calls.map((e: BusEvent) => (
              <div key={e.seq} className={`feed-item ${e.type === "tool.succeeded" ? "tool-succeeded" : e.type === "tool.failed" ? "tool-failed" : "tool-called"}`}>
                <div className="head">
                  <span className="tag">{e.type}</span>
                  <span className="mono">{String(e.toolName)}{e.latencyMs !== undefined ? ` · ${String(e.latencyMs)}ms` : ""}</span>
                  <span className="time">{fmtTime(e.timestamp)}</span>
                </div>
                <div className="body">
                  <pre>args: {String(e.argsSummary ?? "")}</pre>
                  {(e.resultSummary !== undefined || e.error !== undefined) && (
                    <pre>{e.error !== undefined ? `error: ${String(e.error)}` : `result: ${String(e.resultSummary)}`}</pre>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
