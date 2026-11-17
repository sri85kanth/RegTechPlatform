import type { ReactNode } from 'react';
import { cn, critClass, toneClass, initials, statusTone, readable, type Tone } from '@/utils/ui';
import { Icon } from '@/config/icons';
import { tMaybe, tx, useT } from '@/i18n';
import { CountUp } from './motion';

/**
 * Status / verification / criticality badge — a filled, tinted pill.
 * One colour per meaning: Met/In place green, Partial amber, Gap red,
 * Not covered orange, N/A slate; Critical red, High orange, Medium amber, Low slate.
 */
export function Badge({ value, kind, size = 'md' }: { value?: string; kind?: 'status' | 'criticality' | 'verification' | 'plain'; size?: 'sm' | 'md' }) {
  const t = useT();
  if (value === undefined || value === '') return <span className="text-muted-2">—</span>;
  const cls = kind === 'criticality' ? critClass(value)
    : kind === 'plain' ? toneClass('gray')
    : toneClass(statusTone(value));
  return (
    <span className={cn('pill', size === 'sm' && 'px-2 py-0.5 text-[11px]', cls)} title={tMaybe(t, statusMeaning(value))}>
      {/* status, criticality and verification values are enums: their readable
          English label is translated here; a plain badge shows the caller's text */}
      {kind === 'plain' ? readable(value) : t(readable(value))}
    </span>
  );
}

/**
 * What a status word means, in plain language — shown on hover wherever the
 * word appears, because "Documented" and "Not covered" are not self-explanatory.
 *
 * "Documented" was "Met". The assessment reads the hospital's documents only;
 * an NABH assessor scores implementation from sampled records, so a duty our
 * documents cover is documented, not yet shown to be met.
 */
const MEANING: Record<string, string> = {
  MET: tx('Documented — our documents fully cover this duty (not yet checked against records)'),
  DOCUMENTED: tx('Documented — our documents fully cover this duty (not yet checked against records)'),
  COMPLIANT: tx('Documented — our documents fully cover this duty (not yet checked against records)'),
  PARTIAL: tx('Partial — covered, but something the duty asks for is missing'),
  PARTIALLY_COMPLIANT: tx('Partially compliant — covered, but something the duty asks for is missing'),
  GAP: tx('Gap — a document exists but does not meet the duty'),
  NON_COMPLIANT: tx('Non-compliant — a document exists but does not meet the duty'),
  NOT_COVERED: tx('Not covered — no hospital document addresses this duty yet'),
  EVIDENCE_MISSING: tx('Evidence missing — no hospital document addresses this duty yet'),
  NOT_APPLICABLE: tx('Not applicable — this duty does not apply to the hospital'),
  NOT_ASSESSED: tx('Not assessed — not yet checked against our documents'),
  CRITICAL: tx('Critical — most serious if not met (e.g. licence or accreditation at risk)'),
  HIGH: tx('High — serious if not met (e.g. significant penalty)'),
  MEDIUM: tx('Medium — moderate consequence if not met'),
  LOW: tx('Low — procedural; minor consequence if not met'),
  CONDITIONAL: tx('Applies · conditional — entity type, jurisdiction and regulator match; thresholds and exemptions not yet confirmed'),
  REVIEW_REQUIRED: tx('Review required — a person must confirm whether this applies'),
  VERIFIED: tx('Verified — a person has confirmed this record'),
  PENDING: tx('Pending — nobody has confirmed this record yet'),
};
export function statusMeaning(value?: string): string | undefined {
  if (!value) return undefined;
  return MEANING[value.trim().replace(/[\s-]+/g, '_').toUpperCase()];
}

/** Category chip. Without a tone it picks a stable colour from the text, so "Policy" is always the same chip. */
const TAG_TONES: Tone[] = ['blue', 'purple', 'teal', 'amber', 'orange', 'green', 'red'];
export function Tag({ children, tone, className, title }: { children: ReactNode; tone?: Tone | 'auto'; className?: string; title?: string }) {
  const t: Tone = tone && tone !== 'auto' ? tone
    : tone === 'auto' && typeof children === 'string' ? TAG_TONES[hash(children) % TAG_TONES.length]
    : 'gray';
  return <span className={cn('pill', toneClass(t), className)} title={title}>{children}</span>;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Initials avatar — each person keeps one colour everywhere. */
const AVATAR = [
  'bg-blue-100 text-blue-700', 'bg-violet-100 text-violet-700', 'bg-teal-100 text-teal-700', 'bg-amber-100 text-amber-700',
  'bg-pink-100 text-pink-700', 'bg-sky-100 text-sky-700', 'bg-emerald-100 text-emerald-700', 'bg-orange-100 text-orange-700',
  'bg-indigo-100 text-indigo-700', 'bg-rose-100 text-rose-700',
];
export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center rounded-full font-bold', AVATAR[hash(name || '?') % AVATAR.length])}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

export type MetricTone = 'neutral' | 'brand' | 'green' | 'amber' | 'orange' | 'red' | 'purple' | 'teal' | 'gray';

/** Icon tile used by metric cards, list rows and section headers. */
export const TILE: Record<MetricTone, string> = {
  neutral: 'bg-brand-50 text-brand-600',
  brand: 'bg-brand-50 text-brand-600',
  green: 'bg-success-50 text-success-500',
  amber: 'bg-warning-50 text-warning-500',
  orange: 'bg-notcov-50 text-notcov-500',
  red: 'bg-critical-50 text-critical-500',
  purple: 'bg-violet-50 text-violet-600',
  teal: 'bg-teal-50 text-teal-600',
  gray: 'bg-slate-100 text-slate-500',
};
const TONE_FG: Record<MetricTone, string> = {
  neutral: 'text-brand-600', brand: 'text-brand-600', green: 'text-success-600', amber: 'text-warning-600',
  orange: 'text-notcov-600', red: 'text-critical-600', purple: 'text-violet-600', teal: 'text-teal-600', gray: 'text-slate-500',
};

export function IconTile({ icon, tone = 'brand', size = 'md', className }: { icon: string; tone?: MetricTone; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = { sm: 'h-8 w-8 rounded-lg', md: 'h-10 w-10 rounded-xl', lg: 'h-12 w-12 rounded-xl' }[size];
  const ic = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size];
  return (
    <span className={cn('grid shrink-0 place-items-center', box, TILE[tone], className)}>
      <Icon name={icon} className={ic} />
    </span>
  );
}

/** Default KPI icon per tone, so every KPI card carries one consistent icon. */
const TONE_ICON: Record<MetricTone, string> = {
  neutral: 'BarChart3', brand: 'BarChart3', green: 'CheckCircle2', amber: 'AlertTriangle', orange: 'FileWarning',
  red: 'XCircle', purple: 'Layers', teal: 'Activity', gray: 'MinusCircle',
};

/**
 * KPI card — big coloured icon tile, the figure, its label, and an optional
 * coloured share ("67 %") or footnote beneath.
 */
export function MetricCard({
  label,
  value,
  foot,
  tone = 'neutral',
  icon,
  pct,
  onClick,
  active,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  tone?: MetricTone;
  /** lucide icon name from the shared icon registry */
  icon?: string;
  /** share of a whole, 0–100 — shown in the card's colour */
  pct?: number;
  onClick?: () => void;
  /** the card is the current filter */
  active?: boolean;
}) {
  const t = useT();
  // A zero is not a success or an alarm: it reads neutral whatever the tone.
  const isZero = value === 0 || value === '0' || value === '0%';
  const effTone: MetricTone = isZero && tone !== 'gray' ? 'gray' : tone;

  const body = (
    <div className="flex items-center gap-3.5">
      <IconTile icon={icon ?? TONE_ICON[effTone]} tone={effTone} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="num whitespace-nowrap text-[24px] font-semibold leading-tight text-ink">{typeof value === 'number' ? <CountUp value={value} /> : value}</div>
        <div className="line-clamp-2 text-[13px] leading-4 text-ink-2">{t(label)}</div>
        {pct !== undefined && <div className={cn('mt-0.5 text-xs font-semibold tabular-nums', TONE_FG[effTone])}>{pct}%</div>}
        {foot && <div className="mt-0.5 truncate text-xs leading-tight text-muted">{tMaybe(t, foot)}</div>}
      </div>
    </div>
  );

  const cls = cn('card relative flex min-h-[92px] flex-col justify-center overflow-hidden px-4 py-3 text-left',
    active && 'ring-2 ring-brand-500/60');
  if (onClick) {
    return (
      <button onClick={onClick} className={cn(cls, 'card-int group')}>
        {body}
        <span className="pointer-events-none absolute right-3 top-3 -translate-x-1 text-muted-2 opacity-0 transition-all duration-300 ease-spring group-hover:translate-x-0 group-hover:opacity-100">
          <Icon name="ArrowRight" className="h-4 w-4" />
        </span>
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

export function EmptyState({ title, hint, icon = 'Inbox' }: { title: string; hint?: string; icon?: string }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <IconTile icon={icon} tone="gray" size="lg" />
      <div className="mt-1 text-sm font-semibold text-ink">{t(title)}</div>
      {hint && <div className="max-w-md text-xs text-muted">{t(hint)}</div>}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

/** A titled card. `link` renders the blue "View all →" at the right. */
export function Section({
  title, action, children, icon, tone = 'brand', link, className, bodyClassName,
}: {
  title: string; action?: ReactNode; children: ReactNode; icon?: string; tone?: MetricTone;
  link?: { label?: string; onClick: () => void }; className?: string; bodyClassName?: string;
}) {
  const t = useT();
  return (
    <div className={cn('card p-5', className)}>
      <div className="mb-4 flex items-center gap-2.5">
        {icon && <IconTile icon={icon} tone={tone} size="sm" />}
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{t(title)}</h3>
        {action}
        {link && (
          <button onClick={link.onClick} className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700">
            {t(link.label ?? 'View all')} <Icon name="ArrowRight" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

/** A labelled value in a detail panel. */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const t = useT();
  return (
    // min-w-0 + anywhere-wrap: a long unbroken value (a file name, an id, a URL) wraps
    // inside its own cell instead of running over the next column
    <div className={cn('min-w-0', className)}>
      <div className="text-xs text-muted">{t(label)}</div>
      <div className="mt-0.5 text-sm font-medium text-ink [overflow-wrap:anywhere]">{children ?? '—'}</div>
    </div>
  );
}

/** Coloured message box — a gap, a warning, a success. */
export function Callout({ tone = 'red', icon, title, children }: { tone?: 'red' | 'amber' | 'green' | 'blue' | 'purple'; icon?: string; title: ReactNode; children?: ReactNode }) {
  const t = useT();
  const box = {
    red: 'border-critical-100/70 bg-gradient-to-br from-critical-50 to-white text-critical-700', amber: 'border-warning-100/70 bg-gradient-to-br from-warning-50 to-white text-warning-700',
    green: 'border-success-100/70 bg-gradient-to-br from-success-50 to-white text-success-700', blue: 'border-brand-100/70 bg-gradient-to-br from-brand-50 to-white text-brand-700',
    purple: 'border-violet-100/70 bg-gradient-to-br from-violet-50 to-white text-violet-700',
  }[tone];
  const ic = icon ?? { red: 'CircleAlert', amber: 'AlertTriangle', green: 'CircleCheck', blue: 'Info', purple: 'Sparkles' }[tone];
  return (
    <div className={cn('flex gap-3 rounded-[18px] border p-4', box)}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/80 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"><Icon name={ic} className="h-[18px] w-[18px]" /></span>
      <div className="min-w-0">
        <div className="pt-1 text-sm font-semibold">{tMaybe(t, title)}</div>
        {children && <div className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{tMaybe(t, children)}</div>}
      </div>
    </div>
  );
}

/** Numbered pager — "Showing 1–10 of 320", ‹ 1 2 3 … 32 ›. */
export function Pager({ page, pages, total, size, onPage }: { page: number; pages: number; total: number; size: number; onPage: (p: number) => void }) {
  const t = useT();
  if (pages <= 1) return null;
  const nums: (number | '…')[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-[13px] text-muted">
      <span>{t('Showing {from}–{to} of {total}', { from: from.toLocaleString(), to: to.toLocaleString(), total: total.toLocaleString() })}</span>
      <div className="flex items-center gap-1">
        <button className="btn btn-sm h-8 w-8 px-0" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('Previous page')}>‹</button>
        {nums.map((n, i) => n === '…'
          ? <span key={`e${i}`} className="px-1">…</span>
          : <button key={n} onClick={() => onPage(n)}
                    className={cn('h-8 min-w-8 rounded-lg px-2 text-[13px] font-medium tabular-nums',
                      n === page ? 'border border-brand-500 bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-100')}>{n}</button>)}
        <button className="btn btn-sm h-8 w-8 px-0" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('Next page')}>›</button>
      </div>
    </div>
  );
}
