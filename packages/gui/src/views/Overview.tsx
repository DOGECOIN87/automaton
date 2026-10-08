import { BusEvent, byType, fmtTime, timeAgo, truncate } from "../api";

export interface RuntimeState {
  source?: string;
  name?: string;
  version?: string;
  address?: string;
  chainType?: string;
  agentState?: string;
  turnCount?: number;
  tier?: string | null;
  financial?: { creditsCents?: number; usdcBalance?: number; lastChecked?: string } | null;
  startedAt?: string;
  toolsSummary?: { total?: number; byCategory?: Record<string, number> };
  heartbeat?: { entries?: Array<{ name: string; schedule: string; enabled: boolean; task: string }>; lastPing?: string };
  children?: Array<{ id: string; name: string; address: string; status: string; sandboxId: string; createdAt: string }>;
}

const TIER_PILLS: Record<string, string> = {
  healthy: "running",
  low_compute: "low_compute",
  critical: "critical",
  dead: "dead",
};

export default function Overview({ state, events }: { state: RuntimeState | null; events: BusEvent[] }) {
  const fin = state?.financial;
  const credits = typeof fin?.creditsCents === "number" ? fin.creditsCents / 100 : null;
  const tierChanges = byType(events, "survival.tier_changed").slice(-5).reverse();
  const lastTick = byType(events, "heartbeat.tick").slice(-1)[0];
  const topups = byType(events, "funding.topup").slice(-5).reverse();
  const aliveChildren = (state?.children ?? []).filter((c) => !["dead", "cleaned_up", "failed"].includes(c.status));

  return (
    <div>
      <div className="grid">
        <div className="card">
          <h3>Agent state</h3>
          <div>
            <span className={`pill ${state?.agentState ?? "unknown"}`}>{state?.agentState ?? "unknown"}</span>
          </div>
          <div className="sub">{state?.name ?? "—"} · v{state?.version ?? "—"}</div>
        </div>
        <div className="card">
          <h3>Survival tier</h3>
          <div>
            <span className={`pill ${TIER_PILLS[state?.tier ?? ""] ?? "unknown"}`}>{state?.tier ?? "unknown"}</span>
          </div>
          <div className="sub">Credits: {credits === null ? "—" : `$${credits.toFixed(2)}`}</div>
        </div>
        <div className="card">
          <h3>Credits</h3>
          <div className="big">{credits === null ? "—" : `$${credits.toFixed(2)}`}</div>
          <div className="sub">USDC: {typeof fin?.usdcBalance === "number" ? fin.usdcBalance.toFixed(4) : "—"}</div>
        </div>
        <div className="card">
          <h3>Wallet</h3>
          <div className="mono">{truncate(state?.address, 12)}</div>
          <div className="sub">chain: {state?.chainType ?? "—"}</div>
        </div>
        <div className="card">
          <h3>Turns</h3>
          <div className="big">{state?.turnCount ?? "—"}</div>
          <div className="sub">started {timeAgo(state?.startedAt)}</div>
        </div>
        <div className="card">
          <h3>Heartbeat</h3>
          <div className="big">{state?.heartbeat?.entries?.filter((e) => e.enabled).length ?? 0}</div>
          <div className="sub">last tick {timeAgo(lastTick?.timestamp)}</div>
        </div>
        <div className="card">
          <h3>Tools</h3>
          <div className="big">{state?.toolsSummary?.total ?? "—"}</div>
          <div className="sub">{aliveChildren.length} live children</div>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Tier history <span className="muted">(session)</span></h2>
          {tierChanges.length === 0 ? (
            <div className="note">No tier changes observed in this session.</div>
          ) : (
            <table>
              <thead><tr><th>Time</th><th>From</th><th>To</th><th>Credits</th></tr></thead>
              <tbody>
                {tierChanges.map((e) => (
                  <tr key={e.seq}>
                    <td className="mono">{fmtTime(e.timestamp)}</td>
                    <td>{String(e.previousTier ?? "—")}</td>
                    <td>{String(e.tier)}</td>
                    <td className="mono">${(Number(e.creditsCents) / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel">
          <h2>Funding attempts <span className="muted">(session)</span></h2>
          {topups.length === 0 ? (
            <div className="note">No funding attempts in this session.</div>
          ) : (
            <table>
              <thead><tr><th>Time</th><th>Strategy</th><th>Success</th></tr></thead>
              <tbody>
                {topups.map((e) => (
                  <tr key={e.seq}>
                    <td className="mono">{fmtTime(e.timestamp)}</td>
                    <td className="mono">{String(e.strategy)}</td>
                    <td>{e.success ? "✓" : "✗"}</td>
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
