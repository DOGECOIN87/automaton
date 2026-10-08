import { BusEvent, byType, fmtTime, timeAgo } from "../api";
import { RuntimeState } from "./Overview";

export default function HeartbeatView({ state, events }: { state: RuntimeState | null; events: BusEvent[] }) {
  const ticks = byType(events, "heartbeat.tick").slice(-40).reverse();
  const entries = state?.heartbeat?.entries ?? [];

  return (
    <div>
      <div className="grid">
        <div className="card">
          <h3>Tick interval</h3>
          <div className="big">{ticks.length > 0 ? `${(Number(ticks[0].tickIntervalMs) / 1000).toFixed(0)}s` : "—"}</div>
          <div className="sub">last tick {timeAgo(ticks[0]?.timestamp)}</div>
        </div>
        <div className="card">
          <h3>Ticks (session)</h3>
          <div className="big">{byType(events, "heartbeat.tick").length}</div>
          <div className="sub">last ping {timeAgo(state?.heartbeat?.lastPing)}</div>
        </div>
        <div className="card">
          <h3>Entries</h3>
          <div className="big">{entries.length}</div>
          <div className="sub">{entries.filter((e) => e.enabled).length} enabled</div>
        </div>
      </div>
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Schedule</h2>
          {entries.length === 0 ? (
            <div className="note">No heartbeat entries (needs a running runtime).</div>
          ) : (
            <table>
              <thead><tr><th>Name</th><th>Schedule</th><th>Task</th><th>Enabled</th></tr></thead>
              <tbody>
                {entries.map((h) => (
                  <tr key={h.name}>
                    <td className="mono">{h.name}</td>
                    <td className="mono">{h.schedule}</td>
                    <td className="mono">{h.task}</td>
                    <td>{h.enabled ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel">
          <h2>Tick history <span className="muted">(session)</span></h2>
          {ticks.length === 0 ? (
            <div className="note">No ticks observed yet.</div>
          ) : (
            <table>
              <thead><tr><th>Time</th><th>Interval</th></tr></thead>
              <tbody>
                {ticks.map((e) => (
                  <tr key={e.seq}>
                    <td className="mono">{fmtTime(e.timestamp)}</td>
                    <td className="mono">{(Number(e.tickIntervalMs) / 1000).toFixed(0)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
