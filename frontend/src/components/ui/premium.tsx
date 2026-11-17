/**
 * The premium kit — the pieces the redesigned pages share, so they read as one
 * product: tinted KPI tiles that count up and filter on press, an insight card
 * that says in one sentence what the page shows, a ring that draws itself, a
 * stacked bar that grows in with a pressable legend, and a funnel of steps.
 *
 * Motion is CSS (premium.css) with fill-mode backwards, so nothing is left
 * transformed after it lands, and all of it stops under prefers-reduced-motion.
 * Pointer highlight: these surfaces carry `liquid` (components/ui/liquid.ts).
 */
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { CountUp, prefersReducedMotion } from './motion';
import { cn } from '@/utils/ui';
import { Icon } from '@/config/icons';
import { tMaybe, useT } from '@/i18n';
import './premium.css';

export type PTone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal' | 'slate';

/** gradient pair, readable text shade and a soft tint per tone */
export const PTONE: Record<PTone, { from: string; to: string; ink: string; tint: string }> = {
  blue: { from: '#0a84ff', to: '#5e5ce6', ink: '#0058b0', tint: 'rgba(0,113,227,0.07)' },
  green: { from: '#34c759', to: '#30b0c7', ink: '#1a7434', tint: 'rgba(52,199,89,0.08)' },
  amber: { from: '#ff9f0a', to: '#ff6b00', ink: '#9a5300', tint: 'rgba(255,159,10,0.09)' },
  red: { from: '#ff453a', to: '#ff2d55', ink: '#b42318', tint: 'rgba(255,59,48,0.07)' },
  violet: { from: '#bf5af2', to: '#5e5ce6', ink: '#7e3aa8', tint: 'rgba(175,82,222,0.08)' },
  teal: { from: '#30b0c7', to: '#0a84ff', ink: '#0f6e82', tint: 'rgba(48,176,199,0.09)' },
  slate: { from: '#8e8e93', to: '#636366', ink: '#48484a', tint: 'rgba(120,120,128,0.08)' },
};

/** A value that is drawn rather than set: it starts from 0 on first show, then follows. */
export function useDrawn(target: number) {
  const [v, setV] = useState(() => (prefersReducedMotion() ? target : 0));
  useEffect(() => {
    let b = 0;
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setV(target)); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, [target]);
  return v;
}

/** The icon on a gradient tile, glowing in its own colour. */
export function GlowIcon({ icon: I, tone = 'blue', size = 44 }: { icon: LucideIcon; tone?: PTone; size?: number }) {
  const c = PTONE[tone];
  return (
    <span className="pm-glow grid shrink-0 place-items-center text-white"
          style={{ width: size, height: size, borderRadius: size * 0.32, background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
                   '--pm-glow': `${c.from}66` } as CSSProperties}>
      <I className="pm-glyph" style={{ width: size * 0.46, height: size * 0.46 }} aria-hidden="true" />
    </span>
  );
}

/**
 * One headline figure. Pressing it (when it filters) toggles; the active one
 * wears a ring and a check. `share` (0–1) draws a thin bar under the number.
 */
export function KpiTile({ icon, label, value, note, tone = 'blue', share, onClick, active, index = 0 }: {
  icon: LucideIcon; label: string; value: number | string | null | undefined; note?: ReactNode; tone?: PTone;
  share?: number; onClick?: () => void; active?: boolean; index?: number;
}) {
  const c = PTONE[tone];
  const drawn = useDrawn(share ?? 0);
  const body = (
    <>
      <span aria-hidden="true" className="pm-tile-wash" style={{ background: `radial-gradient(120% 90% at 100% 0%, ${c.tint}, transparent 70%)` }} />
      <span className="relative flex items-start justify-between gap-3">
        <GlowIcon icon={icon} tone={tone} size={40} />
        {active && (
          <span key="on" className="pm-pop grid h-6 w-6 place-items-center rounded-full text-white" style={{ background: c.from }}>
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="relative mt-3 block text-[28px] font-semibold leading-none tracking-tight tabular-nums text-ink">
        {value == null ? '—' : typeof value === 'number' ? <CountUp value={value} /> : value}
      </span>
      <span className="relative mt-1.5 block text-[13px] font-medium leading-snug text-ink-2">{label}</span>
      {share != null && (
        <span className="relative mt-3 block h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
          <span className="pm-bar block h-full rounded-full"
                style={{ width: `${Math.max(2, drawn * 100)}%`, background: `linear-gradient(90deg, ${c.from}, ${c.to})` }} />
        </span>
      )}
      {note && <span className="relative mt-2 block truncate text-[12px]" style={{ color: onClick ? c.ink : undefined }}>{note}</span>}
    </>
  );
  const cls = cn('pm-tile liquid card relative flex min-w-0 flex-col overflow-hidden p-4 text-left', active && 'pm-active');
  const style = { '--pm-ring': c.from, animationDelay: `${index * 0.05}s` } as CSSProperties;
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} className={cn(cls, 'card-int')} style={style}>{body}</button>
    : <div className={cls} style={style}>{body}</div>;
}

/**
 * What the page shows, said once in plain words, with the few next steps that
 * matter as pressable chips. The sentence is built from live figures.
 */
export function InsightCard({ icon, tone = 'blue', eyebrow, children, actions }: {
  icon: LucideIcon; tone?: PTone; eyebrow: string; children: ReactNode; actions?: ReactNode;
}) {
  const c = PTONE[tone];
  return (
    <section className="pm-insight card relative overflow-hidden p-5 sm:p-6">
      <span aria-hidden="true" className="pm-blob" style={{ background: c.from, right: -80, top: -120 }} />
      <span aria-hidden="true" className="pm-blob pm-blob-2" style={{ background: c.to, right: 220, bottom: -160 }} />
      <div className="relative flex flex-wrap items-start gap-4">
        <GlowIcon icon={icon} tone={tone} size={48} />
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: c.ink }}>{eyebrow}</div>
          <p className="mt-1 max-w-4xl text-[18px] font-medium leading-snug tracking-tight text-ink sm:text-[20px]">{children}</p>
          {actions && <div className="mt-3.5 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </section>
  );
}

/** A pressable chip for the insight card. */
export function InsightChip({ children, onClick, tone = 'blue' }: { children: ReactNode; onClick?: () => void; tone?: PTone }) {
  const c = PTONE[tone];
  return (
    <button type="button" onClick={onClick}
            className="pm-chip group inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3.5 py-1.5 text-[13px] font-medium shadow-sm ring-1 ring-black/5 backdrop-blur"
            style={{ color: c.ink }}>
      {children}
      <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

/** A number in the insight sentence: counts up, tinted. */
export function Em({ n, tone = 'blue', suffix = '' }: { n: number | null | undefined; tone?: PTone; suffix?: string }) {
  return <b className="font-semibold tabular-nums" style={{ color: PTONE[tone].ink }}>{n == null ? '—' : <CountUp value={n} />}{suffix}</b>;
}

/** A ring that draws itself to value/max, its figure counting up in the middle. */
export function RingGauge({ value, max, size = 132, stroke = 14, tone = 'blue', label, sub, segments }: {
  value: number; max: number; size?: number; stroke?: number; tone?: PTone; label?: ReactNode; sub?: ReactNode;
  /** draw these shares instead of one arc: each its own colour, in order, with a small gap */
  segments?: { value: number; color: string }[];
}) {
  const c = PTONE[tone];
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const drawn = useDrawn(frac);
  const id = `pm-ring-${tone}-${size}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={c.from} /><stop offset="100%" stopColor={c.to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(120,120,128,0.13)" strokeWidth={stroke} />
        {segments ? (() => {
          const sum = segments.reduce((a, g) => a + g.value, 0) || 1;
          const gap = segments.filter((g) => g.value > 0).length > 1 ? Math.min(6, C * 0.012) : 0;
          let at = 0;
          return segments.filter((g) => g.value > 0).map((g, i) => {
            const len = Math.max(0, (g.value / sum) * C - gap);
            const el = (
              <circle key={i} className="pm-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={g.color} strokeWidth={stroke}
                      strokeDasharray={`${len * drawn} ${C}`} strokeDashoffset={-at * drawn}
                      style={{ opacity: drawn > 0 ? 1 : 0, transitionDelay: `${i * 0.06}s` }} />
            );
            at += len + gap;
            return el;
          });
        })() : (
          <circle className="pm-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={stroke}
                  strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - drawn)} style={{ opacity: drawn > 0 ? 1 : 0 }} />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-ink">{label ?? <CountUp value={value} />}</div>
          {sub && <div className="mt-1 text-[11.5px] font-medium text-muted">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export interface Seg { key: string; label: string; value: number; color: string; onClick?: () => void; active?: boolean }

/** A stacked bar whose segments grow in one after another, and a legend you can press. */
export function SegmentBar({ segs, height = 12, legend = true, cols = 4 }: { segs: Seg[]; height?: number; legend?: boolean; cols?: 2 | 4 }) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  return (
    <div>
      <div className="flex w-full gap-[3px] overflow-hidden rounded-full" style={{ height }}>
        {total === 0 ? <span className="h-full w-full rounded-full bg-black/[0.06]" /> : segs.filter((s) => s.value > 0).map((s, i) => (
          <span key={s.key} className="pm-grow h-full first:rounded-l-full last:rounded-r-full"
                title={`${s.label}: ${s.value.toLocaleString()}`}
                style={{ flex: s.value, background: s.color, animationDelay: `${0.12 + i * 0.08}s` }} />
        ))}
      </div>
      {legend && (
        <div className={cn('mt-3 grid grid-cols-2 gap-1.5', cols === 4 && 'sm:grid-cols-4')}>
          {segs.map((s) => (
            <button key={s.key} type="button" onClick={s.onClick} disabled={!s.onClick || (s.value === 0 && !s.active)} aria-pressed={s.active}
                    className={cn('pm-legend flex items-center gap-2 rounded-xl px-2.5 py-2 text-left ring-1 ring-black/5 transition disabled:cursor-default disabled:opacity-50',
                      s.active ? 'bg-white shadow-sm ring-2' : 'bg-black/[0.02] hover:bg-white hover:shadow-sm')}
                    style={s.active ? ({ '--tw-ring-color': s.color } as CSSProperties) : undefined}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold leading-tight tabular-nums text-ink"><CountUp value={s.value} /></span>
                <span className="block truncate text-[11.5px] text-muted">{s.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Steps that narrow — library → applies → urgent — each bar sized to its share of the first. */
export function Funnel({ steps }: { steps: { label: string; value: number; tone: PTone; onClick?: () => void; active?: boolean }[] }) {
  const top = Math.max(1, steps[0]?.value ?? 1);
  return (
    <ol className="pm-stagger space-y-2">
      {steps.map((s, i) => {
        const c = PTONE[s.tone];
        const w = Math.max(4, (s.value / top) * 100);
        const inner = (
          <>
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-medium text-ink-2">{s.label}</span>
              <span className="text-[15px] font-semibold tabular-nums text-ink"><CountUp value={s.value} /></span>
            </span>
            <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-black/[0.05]">
              <span className="pm-grow block h-full rounded-full" style={{ width: `${w}%`, background: `linear-gradient(90deg, ${c.from}, ${c.to})`, animationDelay: `${0.15 + i * 0.12}s` }} />
            </span>
          </>
        );
        return (
          <li key={s.label}>
            {s.onClick
              ? <button type="button" onClick={s.onClick} aria-pressed={s.active}
                        className={cn('block w-full rounded-xl px-3 py-2 text-left transition hover:bg-black/[0.03]', s.active && 'bg-black/[0.04]')}>{inner}</button>
              : <div className="px-3 py-2">{inner}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** A segmented capsule (iOS style) for a small set of mutually exclusive choices. */
export function Capsule<K extends string>({ options, value, onChange, ariaLabel }: {
  options: { key: K; label: ReactNode }[]; value: K; onChange: (k: K) => void; ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="pm-capsule inline-flex rounded-full bg-black/[0.05] p-1">
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)}
                className={cn('rounded-full px-3 py-1 text-[12.5px] font-medium transition',
                  value === o.key ? 'bg-white text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** How something works, as steps joined by a flowing pipe — the explainer strip. */
export function FlowStrip({ steps }: { steps: { icon: LucideIcon; title: string; sub: string; tone: PTone }[] }) {
  return (
    <ol className="pm-flow card flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:gap-0">
      {steps.map((s, i) => (
        <li key={s.title} className="contents">
          <div className="pm-flow-step flex min-w-0 flex-1 items-center gap-3" style={{ animationDelay: `${i * 0.08}s` }}>
            <span className="relative">
              <GlowIcon icon={s.icon} tone={s.tone} size={42} />
              <span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white text-[10.5px] font-bold shadow-sm ring-1 ring-black/5"
                    style={{ color: PTONE[s.tone].ink }}>{i + 1}</span>
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-ink">{s.title}</span>
              <span className="block text-[12px] leading-snug text-muted">{s.sub}</span>
            </span>
          </div>
          {i < steps.length - 1 && <span aria-hidden="true" className="pm-pipe mx-3 hidden h-1.5 w-14 shrink-0 lg:block" />}
        </li>
      ))}
    </ol>
  );
}

const FROM_METRIC: Record<string, PTone> = {
  brand: 'blue', green: 'green', amber: 'amber', orange: 'amber', red: 'red', purple: 'violet', teal: 'teal', gray: 'slate', neutral: 'slate',
};

/**
 * MetricCard's props on the premium tile — a drop-in where a page should take
 * the new look without rewriting each figure. `icon` is a registry name.
 */
export function MetricTile({ label, value, foot, tone = 'neutral', icon, pct, onClick, active, index = 0 }: {
  label: string; value: ReactNode; foot?: ReactNode; tone?: string; icon?: string; pct?: number;
  onClick?: () => void; active?: boolean; index?: number;
}) {
  const t = useT();
  const zero = value === 0 || value === '0' || value === '0%';
  const pt = zero ? 'slate' : FROM_METRIC[tone] ?? 'slate';
  const Named = ((p: { className?: string; style?: CSSProperties }) => <span style={p.style} className="grid place-items-center"><Icon name={icon ?? 'BarChart3'} className="h-full w-full" /></span>) as unknown as LucideIcon;
  return (
    <KpiTile index={index} icon={Named} tone={pt} label={t(label)}
      value={typeof value === 'number' || typeof value === 'string' ? value : null}
      share={pct != null ? pct / 100 : undefined}
      note={foot != null ? <>{pct != null ? `${pct}% · ` : ''}{tMaybe(t, foot)}</> : pct != null ? `${pct}%` : undefined}
      onClick={onClick} active={active} />
  );
}

/**
 * A translated sentence with live figures in it: `text` keeps its {placeholders}
 * (call t() without vars), and each one is replaced by its node — so every
 * language can put the numbers wherever its word order needs them.
 */
export function Fill({ text, vars }: { text: string; vars: Record<string, ReactNode> }) {
  return (
    <>
      {text.split(/(\{\w+\})/).map((part, i) => {
        const m = /^\{(\w+)\}$/.exec(part);
        return <Fragment key={i}>{m && m[1] in vars ? vars[m[1]] : part}</Fragment>;
      })}
    </>
  );
}
