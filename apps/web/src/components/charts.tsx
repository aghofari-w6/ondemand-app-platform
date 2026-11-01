import { useId, useMemo, useRef, useState } from 'react';

/**
 * Small, dependency-free charts for dashboards (dataviz skill): one series per chart in
 * the accent, thin marks, recessive hairline grid, values and labels in text tokens,
 * a hover/focus tooltip on every mark, and a data table for every chart, so nothing is
 * conveyed by color or hover alone.
 */

const ACCENT = 'var(--color-accent)';
const GRID = 'var(--color-line)';

export type Unit = 'count' | 'money' | 'number';

export function formatValue(v: number, unit: Unit, compact = false) {
  if (unit === 'money') return new Intl.NumberFormat('en-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0, ...(compact ? { notation: 'compact' } : {}) }).format(v);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: unit === 'count' ? 0 : 2, ...(compact ? { notation: 'compact' } : {}) }).format(v);
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

export function KpiTile(props: { label: string; value: number; previous: number | null; unit: Unit; note?: string }) {
  const delta = props.previous === null ? null : props.previous === 0 ? (props.value === 0 ? 0 : null) : ((props.value - props.previous) / Math.abs(props.previous)) * 100;
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <p className="text-3xl font-semibold tracking-tight text-ink" data-testid="kpi-value">
        {formatValue(props.value, props.unit, props.value >= 100_000)}
      </p>
      <p className="text-sm text-muted">
        {delta === null ? (
          props.previous === null ? (props.note ?? '') : 'No earlier data to compare with'
        ) : (
          <>
            <span className={delta >= 0 ? 'font-medium text-ok' : 'font-medium text-bad'}>
              <span aria-hidden="true">{delta >= 0 ? '▲' : '▼'}</span> {delta >= 0 ? 'up' : 'down'} {Math.abs(delta).toFixed(1)}%
            </span>{' '}
            vs the previous period ({formatValue(props.previous!, props.unit, true)})
          </>
        )}
      </p>
    </div>
  );
}

function DataTable(props: { caption: string; head: [string, string]; rows: [string, string][] }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="min-h-11 cursor-pointer py-2 text-accent">Show as a table</summary>
      <table className="w-full text-left">
        <caption className="sr-only">{props.caption}</caption>
        <thead className="text-muted">
          <tr>
            <th scope="col" className="py-1 font-medium">{props.head[0]}</th>
            <th scope="col" className="py-1 text-right font-medium">{props.head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map(([k, v]) => (
            <tr key={k} className="border-t border-line">
              <td className="py-1">{k}</td>
              <td className="py-1 text-right tabular-nums">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const shortDate = (iso: string, granularity: string | null) => {
  const d = new Date(iso);
  if (granularity === 'hour') return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  if (granularity === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function LineChart(props: { title: string; points: { bucket: string; value: number }[]; unit: Unit; granularity: string | null }) {
  const W = 560;
  const H = 200;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tipId = useId();
  const pts = props.points;
  const max = niceMax(Math.max(0, ...pts.map((p) => p.value)));
  const min = Math.min(0, ...pts.map((p) => p.value));
  const x = (i: number) => pad.l + (pts.length <= 1 ? (W - pad.l - pad.r) / 2 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = pts.length ? `${path} L${x(pts.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z` : '';
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  const xLabels = pts.length ? [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i) : [];
  const total = pts.reduce((s, p) => s + p.value, 0);
  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    setHover(pts.length ? best : null);
  };
  if (!pts.length) return <p className="py-10 text-center text-sm text-muted">No data in this period.</p>;
  const h = hover !== null ? pts[hover] : null;
  return (
    <div>
      <div className="relative">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={`${props.title}: ${pts.length} points from ${shortDate(pts[0]!.bucket, props.granularity)} to ${shortDate(pts.at(-1)!.bucket, props.granularity)}, total ${formatValue(total, props.unit)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted text-[12px]">
                {formatValue(t, props.unit, true)}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'} className="fill-muted text-[12px]">
              {shortDate(pts[i]!.bucket, props.granularity)}
            </text>
          ))}
          <path d={area} fill={ACCENT} fillOpacity={0.1} />
          <path d={path} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(pts.length - 1)} cy={y(pts.at(-1)!.value)} r={4} fill={ACCENT} stroke="white" strokeWidth={2} />
          {h && hover !== null && (
            <g aria-hidden="true">
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--color-muted)" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.value)} r={4} fill={ACCENT} stroke="white" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && hover !== null && (
          <div id={tipId} role="status" className="pointer-events-none absolute top-0 rounded-md border border-line bg-white px-2 py-1 text-xs shadow-sm" style={{ left: `${Math.min(80, (x(hover) / W) * 100)}%` }}>
            <strong className="block text-sm text-ink">{formatValue(h.value, props.unit)}</strong>
            <span className="text-muted">{shortDate(h.bucket, props.granularity)}</span>
          </div>
        )}
      </div>
      <DataTable caption={props.title} head={['Period', 'Value']} rows={pts.map((p) => [shortDate(p.bucket, props.granularity), formatValue(p.value, props.unit)])} />
    </div>
  );
}

export function BarChart(props: { title: string; bars: { key: string; value: number }[]; unit: Unit; dimension: string }) {
  const bars = useMemo(() => [...props.bars].sort((a, b) => b.value - a.value).slice(0, 12), [props.bars]);
  const [hover, setHover] = useState<string | null>(null);
  if (!bars.length) return <p className="py-10 text-center text-sm text-muted">No data in this period.</p>;
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
  return (
    <div>
      <ul className="flex flex-col gap-2" aria-label={props.title}>
        {bars.map((b) => {
          const pct = (Math.abs(b.value) / max) * 100;
          return (
            <li key={b.key} className="grid grid-cols-[minmax(0,7rem)_1fr] items-center gap-3 text-sm" onPointerEnter={() => setHover(b.key)} onPointerLeave={() => setHover(null)}>
              <span className="truncate text-ink" title={b.key}>
                {b.key || '(none)'}
              </span>
              <span className="flex items-center gap-2">
                {/* ≤ 24px thick, 4px rounded data end, square at the baseline */}
                <span aria-hidden="true" className="block h-5 rounded-r" style={{ width: `${Math.max(pct, 1)}%`, background: ACCENT, opacity: hover && hover !== b.key ? 0.55 : 1 }} />
                <span className="shrink-0 tabular-nums text-ink">{formatValue(b.value, props.unit, true)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <DataTable caption={props.title} head={[props.dimension === 'store' ? 'Store' : 'Channel', 'Value']} rows={bars.map((b) => [b.key || '(none)', formatValue(b.value, props.unit)])} />
    </div>
  );
}

export function TopTable(props: { title: string; rows: { key: string; value: number }[]; unit: Unit; dimension: string }) {
  if (!props.rows.length) return <p className="py-10 text-center text-sm text-muted">No data in this period.</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{props.title}</caption>
      <thead className="text-muted">
        <tr>
          <th scope="col" className="py-1 font-medium">#</th>
          <th scope="col" className="py-1 font-medium">{props.dimension === 'store' ? 'Store' : 'Channel'}</th>
          <th scope="col" className="py-1 text-right font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, i) => (
          <tr key={r.key} className="border-t border-line">
            <td className="py-1 text-muted">{i + 1}</td>
            <td className="py-1">{r.key || '(none)'}</td>
            <td className="py-1 text-right tabular-nums">{formatValue(r.value, props.unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
