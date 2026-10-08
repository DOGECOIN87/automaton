import { BusEvent, byType, fmtTime, truncate } from "../api";
import { RuntimeState } from "./Overview";

export function MemoryView({ events }: { events: BusEvent[] }) {
  const writes = byType(events, "memory.written").slice(-60).reverse();
  if (writes.length === 0) return <div className="empty">No memory writes in this session yet.</div>;
  return (
    <div className="panel">
      <h2>Recent writes <span className="muted">({byType(events, "memory.written").length} this session)</span></h2>
      <table>
        <thead><tr><th>Time</th><th>Session</th><th>Turn</th><th>Classification</th><th>Tool calls</th></tr></thead>
        <tbody>
          {writes.map((e) => (
            <tr key={e.seq}>
              <td className="mono">{fmtTime(e.timestamp)}</td>
              <td className="mono">{truncate(String(e.sessionId), 8)}</td>
              <td className="mono">{String(e.turnId).slice(0, 8)}…</td>
              <td className="mono">{String(e.classification ?? "—")}</td>
              <td className="mono">{String(e.entriesWritten ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReplicationView({ state, events }: { state: RuntimeState | null; events: BusEvent[] }) {
  const spawns = byType(events, "replication.child_spawned").slice(-30).reverse();
  const children = state?.children ?? [];
  return (
    <div>
      <div className="panel">
        <h2>Children <span className="muted">({children.length} known)</span></h2>
        {children.length === 0 ? (
          <div className="note">No children known to the state DB.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Address</th><th>Status</th><th>Sandbox</th><th>Created</th></tr></thead>
            <tbody>
              {children.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.name}</td>
                  <td className="mono">{truncate(c.address, 8)}</td>
                  <td className="mono">{c.status}</td>
                  <td className="mono">{truncate(c.sandboxId, 8)}</td>
                  <td className="mono">{fmtTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Spawn events <span className="muted">(session)</span></h2>
        {spawns.length === 0 ? (
          <div className="note">No spawns in this session.</div>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Child</th><th>Address</th><th>Sandbox</th></tr></thead>
            <tbody>
              {spawns.map((e) => (
                <tr key={e.seq}>
                  <td className="mono">{fmtTime(e.timestamp)}</td>
                  <td className="mono">{String(e.name)}</td>
                  <td className="mono">{truncate(String(e.address), 8)}</td>
                  <td className="mono">{truncate(String(e.sandboxId), 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function PolicyView({ events }: { events: BusEvent[] }) {
  const decisions = byType(events, "policy.decision").slice(-60).reverse();
  if (decisions.length === 0) return <div className="empty">No policy decisions in this session yet.</div>;
  return (
    <div className="panel">
      <h2>Policy decisions <span className="muted">({byType(events, "policy.decision").length} this session)</span></h2>
      <table>
        <thead><tr><th>Time</th><th>Tool</th><th>Action</th><th>Reason</th><th>Rules triggered</th></tr></thead>
        <tbody>
          {decisions.map((e) => (
            <tr key={e.seq}>
              <td className="mono">{fmtTime(e.timestamp)}</td>
              <td className="mono">{String(e.toolName)}</td>
              <td className="mono">{String(e.action)}</td>
              <td className="mono">{String(e.reasonCode)}</td>
              <td className="mono">{((e.rulesTriggered as string[]) ?? []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
