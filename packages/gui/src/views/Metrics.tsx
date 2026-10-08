import { BusEvent, byType } from "../api";

interface Series { label: string; points: number[]; }

function LineChart({ series, color }: { series: Series; color: string }) {
  const W = 560, H = 140, P = 28;
  const pts = series.points.slice(-60);
  if (pts.length === 0) return <div className="note">no data</div>;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const x = (i: number) => P + (i / Math.max(pts.length - 1, 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: 140 }}>
      <path d={d} fill="none" stroke={color} strokeWidth="2" />
      {pts.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r="2" fill={color} opacity={0.6} />
      ))}
      <text x={P} y={14} fill="#8b96a8" fontSize="10">{max.toFixed(2)}</text>
      <text x={P} y={H - 8} fill="#8b96a8" fontSize="10">{min.toFixed(2)}</text>
    </svg>
  );
}

function BarChart({ series, color }: { series: Series; color: string }) {
  const items = Object.entries(series as unknown as Record<string, number>).slice(0, 12);
  if (items.length === 0) return <div className="note">no data</div>;
  const max = Math.max(...items.map(([, v]) => v), 1);
  return (
    <div>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div className="mono" style={{ width: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={k}>{k}</div>
          <div style={{ flex: 1, background: "#0b0e14", borderRadius: 4, height: 14 }}>
            <div style={{ width: `${(v / max) * 100}%`, background: color, height: "100%", borderRadius: 4 }} />
          </div>
          <div className="mono" style={{ width: 60, textAlign: "right" }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

export default function MetricsView({ events }: { events: BusEvent[] }) {
  const samples = byType(events, "metrics.sample").slice(-60);

  // Aggregate gauge series over time: gauge name -> values
  const gaugeNames = new Set<string>();
  for (const s of samples) {
    const g = (s.gauges ?? {}) as Record<string, number>;
    for (const k of Object.keys(g)) gaugeNames.add(k);
  }
  const gaugeCharts: Series[] = [...gaugeNames].slice(0, 8).map((name) => ({
    label: name,
    points: samples.map((s) => Number(((s.gauges ?? {}) as Record<string, number>)[name] ?? 0)),
  }));

  // Latest counters as bars
  const latest = samples[samples.length - 1];
  const counters = ((latest?.counters ?? {}) as Record<string, number>);

  // Tool latency histogram: latest tool.* latency values from events
  const latencies = events
    .filter((e) => e.type === "tool.succeeded" || e.type === "tool.failed")
    .slice(-40)
    .map((e) => ({ name: `${String(e.toolName)}`, latency: Number(e.latencyMs) || 0 }));

  if (samples.length === 0 && latencies.length === 0) {
    return <div className="empty">No metrics samples in this session yet.</div>;
  }

  return (
    <div>
      {gaugeCharts.length > 0 && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
          {gaugeCharts.map((s) => (
            <div className="chart" key={s.label}>
              <h3>{s.label}<span className="muted">gauge · last {s.points.length}</span></h3>
              <LineChart series={s} color="#4cc2ff" />
            </div>
          ))}
        </div>
      )}
      <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
        <div className="chart">
          <h3>Counters<span className="muted">latest sample</span></h3>
          <BarChart series={counters as unknown as Series} color="#3ddc84" />
        </div>
        <div className="chart">
          <h3>Tool latency<span className="muted">ms · last {latencies.length} calls</span></h3>
          <BarChart
            series={Object.fromEntries(latencies.map((l, i) => [`${l.name} #${i}`, l.latency])) as unknown as Series}
            color="#ffcf4d"
          />
        </div>
      </div>
    </div>
  );
}
