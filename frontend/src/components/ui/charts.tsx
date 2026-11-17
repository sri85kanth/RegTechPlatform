/**
 * Chart kit — small, dependency-free SVG charts in the product palette.
 *
 * Every chart takes plain numbers that a page already holds; none of them
 * fetches. Status colours keep their one meaning (Met green, Partial amber,
 * Gap red, Not covered orange, N/A slate); categorical series use CHART.
 */
import type { ReactNode } from 'react';
import { cn } from '@/utils/ui';
import { Icon } from '@/config/icons';
import { statusMeaning } from '@/components/ui/primitives';
import { tMaybe, useT } from '@/i18n';
import './premium.css';

/** Categorical series colours — distinct, readable on white. */
export const CHART = ['#2563eb', '#8b5cf6', '#14b8a6', '#f59e0b', '#ec4899', '#0ea5e9', '#22c55e', '#f97316', '#6366f1', '#ef4444'];

/** Fixed meanings, for any chart that shows a status or a risk band. */
export const STATUS_HEX: Record<string, string> = {
  met: '#16a34a', compliant: '#16a34a', 'in place': '#16a34a', verified: '#16a34a', active: '#16a34a', effective: '#16a34a',
  partial: '#f59e0b', partially_compliant: '#f59e0b', pending: '#f59e0b', medium: '#f59e0b',
  gap: '#dc2626', non_compliant: '#dc2626', critical: '#dc2626', expired: '#dc2626', overdue: '#dc2626',
  not_covered: '#f97316', 'not covered': '#f97316', evidence_missing: '#f97316', high: '#f97316',
  not_applicable: '#94a3b8', 'not applicable': '#94a3b8', low: '#94a3b8', draft: '#94a3b8', none: '#cbd5e1',
};
export function hexFor(label: string, i = 0): string {
  return STATUS_HEX[label.trim().toLowerCase()] ?? STATUS_HEX[label.trim().toLowerCase().replace(/\s+/g, '_')] ?? CHART[i % CHART.length];
}

export interface Slice { label: string; value: number; color?: string; onClick?: () => void }

const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 100) : 0);

/** Donut with a centre figure and an optional legend beside it. */
export function Donut({
  data, size = 168, thickness = 22, center, sub, legend = true, className,
}: {
  data: Slice[]; size?: number; thickness?: number; center?: ReactNode; sub?: ReactNode; legend?: boolean; className?: string;
}) {
  // labels double as colour keys (hexFor), so they arrive in English and are translated here
  const t = useT();
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className={cn('flex flex-wrap items-center gap-6', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
          {total > 0 && data.map((d, i) => {
            const len = (Math.max(0, d.value) / total) * c;
            const el = (
              <circle key={`${d.label}-${i}`} cx={size / 2} cy={size / 2} r={r} fill="none"
                      stroke={d.color ?? hexFor(d.label, i)} strokeWidth={thickness}
                      strokeDasharray={`${Math.max(0, len - (data.length > 1 ? 2 : 0))} ${c}`} strokeDashoffset={-off}
                      className={cn('transition-[stroke-dasharray] duration-700', d.onClick && 'cursor-pointer hover:opacity-80')}
                      onClick={d.onClick}>
                <title>{`${t(d.label)}: ${d.value.toLocaleString()} (${pct(d.value, total)}%)`}</title>
              </circle>
            );
            off += len;
            return el;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-2xl font-bold tabular-nums tracking-tight text-ink">{center ?? total.toLocaleString()}</div>
            {sub && <div className="text-xs text-muted">{tMaybe(t, sub)}</div>}
          </div>
        </div>
      </div>
      {legend && (
        <ul className="min-w-[170px] flex-1 space-y-2">
          {data.map((d, i) => (
            <li key={`${d.label}-${i}`}>
              <button type="button" onClick={d.onClick} disabled={!d.onClick}
                      className="flex w-full items-start gap-2 text-left text-sm disabled:cursor-default">
                <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color ?? hexFor(d.label, i) }} />
                <span className="min-w-0 flex-1 break-words leading-snug text-ink-2" title={tMaybe(t, statusMeaning(d.label)) ?? t(d.label)}>{t(d.label)}</span>
                <span className="font-semibold tabular-nums text-ink">{d.value.toLocaleString()}</span>
                <span className="w-11 text-right text-xs tabular-nums text-muted">({pct(d.value, total)}%)</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A score ring (0–max) drawn red → amber → green or the reverse; for impact, 0–10 or 0–100. */
export function ScoreRing({
  value, max = 100, size = 150, thickness = 14, label, sub, invert = false,
}: {
  value: number; max?: number; size?: number; thickness?: number; label?: ReactNode; sub?: ReactNode;
  /** true when high is bad (impact, risk): the arc runs amber → red */
  invert?: boolean;
}) {
  const t = useT();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, value / max));
  const id = `ring-${invert ? 'i' : 'n'}-${size}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            {invert
              ? (<><stop offset="0%" stopColor="#facc15" /><stop offset="55%" stopColor="#f97316" /><stop offset="100%" stopColor="#ef4444" /></>)
              : (<><stop offset="0%" stopColor="#22c55e" /><stop offset="100%" stopColor="#14b8a6" /></>)}
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={thickness}
                strokeLinecap="round" strokeDasharray={`${frac * c} ${c}`} className="pm-ring-in transition-[stroke-dasharray] duration-700"
                style={{ '--c': c } as React.CSSProperties} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[28px] font-bold leading-none tabular-nums tracking-tight text-ink">{label ?? value}</div>
          {sub && <div className="mt-1 text-xs font-medium text-muted">{tMaybe(t, sub)}</div>}
        </div>
      </div>
    </div>
  );
}

/** Horizontal labelled bars — "Departments affected", "Gaps by owner". */
export function BarList({
  data, max, valueSuffix = '', className, showValue = true,
}: {
  data: Slice[]; max?: number; valueSuffix?: string; className?: string; showValue?: boolean;
}) {
  const t = useT();
  const top = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className={cn('space-y-2.5', className)}>
      {data.map((d, i) => (
        <li key={`${d.label}-${i}`}>
          <button type="button" onClick={d.onClick} disabled={!d.onClick}
                  className="group grid w-full grid-cols-[minmax(90px,38%)_1fr_auto] items-center gap-3 text-left text-sm disabled:cursor-default">
            <span className="truncate text-ink-2 group-enabled:group-hover:text-brand-600">{t(d.label)}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <span className="pm-bar-in block h-full rounded-full transition-[width] duration-700"
                    style={{ width: `${Math.max(2, (d.value / top) * 100)}%`, background: d.color ?? CHART[i % CHART.length], '--d': `${i * 60}ms` } as React.CSSProperties} />
            </span>
            {showValue && <span className="min-w-[2.5rem] text-right font-semibold tabular-nums text-ink">{d.value.toLocaleString()}{valueSuffix}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One 100 % bar split into parts, with an optional legend underneath. */
export function StackedBar({
  data, height = 10, legend = true, className,
}: { data: Slice[]; height?: number; legend?: boolean; className?: string }) {
  const t = useT();
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  return (
    <div className={className}>
      <div className="flex w-full overflow-hidden rounded-full bg-slate-100" style={{ height }}>
        {total > 0 && data.map((d, i) => d.value > 0 && (
          <span key={`${d.label}-${i}`} title={`${t(d.label)}: ${d.value.toLocaleString()} (${pct(d.value, total)}%)`}
                className="h-full transition-[width] duration-700 first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(d.value / total) * 100}%`, background: d.color ?? hexFor(d.label, i) }} />
        ))}
      </div>
      {legend && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {data.map((d, i) => (
            <span key={`${d.label}-${i}`} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: d.color ?? hexFor(d.label, i) }} />
              {t(d.label)} <b className="font-semibold tabular-nums text-ink">{d.value.toLocaleString()}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Vertical columns — counts over a short series (months, sections). */
export function ColumnChart({
  data, height = 140, className,
}: { data: Slice[]; height?: number; className?: string }) {
  const t = useT();
  const top = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn('flex items-end gap-2', className)} style={{ height }}>
      {data.map((d, i) => (
        <button key={`${d.label}-${i}`} type="button" onClick={d.onClick} disabled={!d.onClick}
                className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 disabled:cursor-default"
                title={`${t(d.label)}: ${d.value.toLocaleString()}`}>
          <span className="text-[11px] font-semibold tabular-nums text-ink-2">{d.value ? d.value.toLocaleString() : ''}</span>
          <span className="w-full max-w-[38px] rounded-t-md transition-[height] duration-700 group-enabled:group-hover:opacity-80"
                style={{ height: `${Math.max(2, (d.value / top) * (height - 34))}px`, background: d.color ?? CHART[i % CHART.length] }} />
          <span className="w-full truncate text-center text-[11px] text-muted">{t(d.label)}</span>
        </button>
      ))}
    </div>
  );
}

/** Tiny trend line. */
export function Sparkline({ values, color = '#2563eb', width = 96, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** A slim progress bar with a percentage — "Covering 67 %". */
export function Progress({ value, total, color, className }: { value: number; total: number; color?: string; className?: string }) {
  const p = pct(value, total);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${p}%`, background: color ?? '#2563eb' }} />
      </span>
      <span className="w-9 text-right text-xs font-semibold tabular-nums text-ink-2">{p}%</span>
    </div>
  );
}

/** Relationship chain: Obligation → Requirements → Control → Evidence → Owner. */
export function FlowSteps({ steps }: { steps: { icon: string; label: ReactNode; sub?: ReactNode; tone?: keyof typeof FLOW_TONE; onClick?: () => void }[] }) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-1">
      {steps.map((s, i) => (
        <div key={i} className="flex min-w-0 flex-1 items-start">
          <button type="button" onClick={s.onClick} disabled={!s.onClick}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center disabled:cursor-default">
            <span className={cn('grid h-9 w-9 place-items-center rounded-lg', FLOW_TONE[s.tone ?? 'blue'])}>
              <Icon name={s.icon} className="h-[18px] w-[18px]" />
            </span>
            <span className="w-full truncate text-[11px] font-medium text-ink-2">{tMaybe(t, s.label)}</span>
            {s.sub && <span className="line-clamp-2 w-full break-words text-[11px] leading-snug text-muted">{tMaybe(t, s.sub)}</span>}
          </button>
          {i < steps.length - 1 && <Icon name="ArrowRight" className="mt-2.5 h-4 w-4 shrink-0 text-slate-300" />}
        </div>
      ))}
    </div>
  );
}
const FLOW_TONE = {
  blue: 'bg-brand-50 text-brand-600', red: 'bg-critical-50 text-critical-600', green: 'bg-success-50 text-success-600',
  amber: 'bg-warning-50 text-warning-600', orange: 'bg-notcov-50 text-notcov-600', purple: 'bg-violet-50 text-violet-600',
  teal: 'bg-teal-50 text-teal-600', gray: 'bg-slate-100 text-slate-500',
};

/** Risk heat grid: rows × columns of counts, darker = more. */
export function HeatGrid({
  rows, cols, value, onCell,
}: {
  rows: string[]; cols: string[]; value: (r: string, c: string) => number; onCell?: (r: string, c: string) => void;
}) {
  const t = useT();
  const all = rows.flatMap((r) => cols.map((c) => value(r, c)));
  const top = Math.max(1, ...all);
  const shade = (v: number) => {
    if (!v) return 'bg-slate-50 text-muted-2';
    const f = v / top;
    return f > 0.66 ? 'bg-critical-500 text-white' : f > 0.33 ? 'bg-notcov-500 text-white' : f > 0.1 ? 'bg-warning-200 text-warning-700' : 'bg-warning-50 text-warning-700';
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr><th />{cols.map((c) => <th key={c} className="px-1 pb-1 text-center font-medium text-muted">{t(c)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th className="whitespace-nowrap pr-2 text-left font-medium text-ink-2">{t(r)}</th>
              {cols.map((c) => {
                const v = value(r, c);
                return (
                  <td key={c} className="p-0">
                    <button type="button" disabled={!onCell || !v} onClick={() => onCell?.(r, c)}
                            className={cn('h-9 w-full min-w-[44px] rounded-md font-semibold tabular-nums transition hover:opacity-85 disabled:cursor-default', shade(v))}>
                      {v || ''}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
