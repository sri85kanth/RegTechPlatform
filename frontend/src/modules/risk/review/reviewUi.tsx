/**
 * The marks of the Risk review screens: verdict and band chips, the
 * inherent → residual → target journey (compact for a row, large for a risk),
 * confidence, and the posture tiles that summarise the register. Their words
 * and colours are in reviewLabels.ts.
 */
import { ArrowRight } from 'lucide-react';
import type { Band } from '@/services/riskApi';
import type { Verdict } from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import { Pill } from '../riskUi';
import { BAND_LABEL, BAND_TONE } from '../labels';
import { BAND_HEX, VERDICT_HEX, VERDICT_LABEL, VERDICT_ORDER, VERDICT_TONE } from './reviewLabels';

export function VerdictChip({ verdict, className }: { verdict: Verdict | null | undefined; className?: string }) {
  const t = useT();
  if (!verdict) return null;
  return (
    <Pill className={cn(VERDICT_TONE[verdict], className)}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: VERDICT_HEX[verdict] }} aria-hidden="true" />
      {t(VERDICT_LABEL[verdict])}
    </Pill>
  );
}

export function BandChip({ band, muted, title }: { band: Band | null | undefined; muted?: boolean; title?: string }) {
  const t = useT();
  if (!band) return <span className="text-[12px] text-muted">—</span>;
  return <Pill title={title} className={cn(BAND_TONE[band], muted && 'opacity-60')}>{t(BAND_LABEL[band])}</Pill>;
}

/** inherent → residual → target as pills, where a sentence-sized mark fits better than blocks */
export function BandPath({ inherent, residual, target, provisional }: {
  inherent: Band | null; residual: Band | null; target: Band | null; provisional?: boolean;
}) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1" title={provisional ? t('Provisional: the worst case until the missing inputs are in') : undefined}>
      <BandChip band={inherent} muted title={t('Inherent: before controls')} />
      <ArrowRight className="h-3 w-3 text-muted" aria-hidden="true" />
      <BandChip band={residual} muted={provisional} title={t('Residual: with the controls in place')} />
      <ArrowRight className="h-3 w-3 text-muted" aria-hidden="true" />
      <BandChip band={target} muted title={t('Target: after the planned actions')} />
    </span>
  );
}

/** a hatched fill for a provisional (worst-case) value */
const hatch = (hex: string) => `repeating-linear-gradient(135deg, ${hex} 0 5px, color-mix(in srgb, ${hex} 70%, white) 5px 9px)`;

/** inherent → residual → target as three joined blocks, for a row. Residual is the one that decides. */
export function BandJourney({ inherent, residual, target, provisional }: {
  inherent: Band | null; residual: Band | null; target: Band | null; provisional?: boolean;
}) {
  const t = useT();
  const steps: [Band | null, string, boolean][] = [
    [inherent, t('Inherent: before controls'), false],
    [residual, t('Residual: with the controls in place'), true],
    [target, t('Target: after the planned actions'), false],
  ];
  return (
    <span className="inline-flex items-center" title={provisional ? t('Provisional: the worst case until the missing inputs are in') : undefined}>
      {steps.map(([band, label, main], i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="h-[2px] w-2.5 bg-slate-200" aria-hidden="true" />}
          {band ? (
            <span title={`${label}: ${t(BAND_LABEL[band])}`}
                  className={cn('inline-grid h-6 place-items-center rounded-md px-1.5 text-[11px] font-semibold',
                    main ? 'min-w-[66px] text-white shadow-sm' : 'min-w-[54px] border')}
                  style={main
                    ? { background: provisional ? hatch(BAND_HEX[band]) : BAND_HEX[band] }
                    : { background: `color-mix(in srgb, ${BAND_HEX[band]} 10%, white)`, color: BAND_HEX[band], borderColor: `color-mix(in srgb, ${BAND_HEX[band]} 35%, white)` }}>
              {t(BAND_LABEL[band])}
            </span>
          ) : <span className="inline-grid h-6 min-w-[54px] place-items-center rounded-md border border-dashed border-slate-300 text-[11px] text-muted">—</span>}
        </span>
      ))}
    </span>
  );
}

/** the three assessment points, large, with what each one means and its impact × likelihood */
export function BandBlocks({ points, provisional }: {
  points: { band: Band | null; impact?: number; likelihood?: number }[]; provisional?: boolean;
}) {
  const t = useT();
  const caption = [t('Inherent'), t('Residual'), t('Target')];
  const sub = [t('before controls'), t('with the controls in place'), t('after the planned actions')];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)_auto_minmax(0,1fr)] items-stretch gap-1.5">
      {points.map((p, i) => (
        <div key={i} className="contents">
          {i > 0 && <span className="grid place-items-center text-muted" aria-hidden="true"><ArrowRight className="h-4 w-4" /></span>}
          <div className={cn('min-w-0 rounded-xl border p-2.5', i === 1 ? 'border-transparent text-white shadow-md' : 'border-line bg-white')}
               style={i === 1 && p.band ? { background: provisional ? hatch(BAND_HEX[p.band]) : BAND_HEX[p.band] } : undefined}>
            <p className={cn('text-[10.5px] font-semibold uppercase tracking-wide', i === 1 ? 'text-white/85' : 'text-muted')}>{caption[i]}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[17px] font-bold leading-tight">
              {i !== 1 && p.band && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: BAND_HEX[p.band] }} aria-hidden="true" />}
              <span className={cn('truncate', i !== 1 && 'text-ink')}>{p.band ? t(BAND_LABEL[p.band]) : '—'}</span>
            </p>
            <p className={cn('mt-0.5 truncate text-[11px]', i === 1 ? 'text-white/85' : 'text-muted')}>
              {p.impact != null && p.likelihood != null ? `${p.impact} × ${p.likelihood} · ` : ''}{sub[i]}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** confidence 0–100 as a short bar and the number */
export function ConfidenceMeter({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-[12px] text-muted">—</span>;
  const tone = value >= 75 ? '#059669' : value >= 50 ? '#d97706' : '#94a3b8';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, value)}%`, background: tone }} />
      </span>
      <span className="w-6 text-right text-[12px] font-semibold tabular-nums text-ink-2">{value}</span>
    </span>
  );
}

/** confidence as a ring, for the risk panel */
export function ConfidenceRing({ value }: { value: number }) {
  const t = useT();
  const r = 19, len = 2 * Math.PI * r;
  const tone = value >= 75 ? '#059669' : value >= 50 ? '#d97706' : '#94a3b8';
  return (
    <span className="inline-flex items-center gap-2" title={t('Confidence {n}', { n: value })}>
      <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90" aria-hidden="true">
        <circle cx="24" cy="24" r={r} fill="none" stroke="#eef1f5" strokeWidth="5" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(value / 100) * len} ${len}`} />
      </svg>
      <span className="leading-tight">
        <span className="block text-[17px] font-bold tabular-nums text-ink">{value}</span>
        <span className="block text-[11px] text-muted">{t('Confidence')}</span>
      </span>
    </span>
  );
}

/** how the register stands, one tile per verdict; a tile is also the filter for it */
export function PostureTiles({ counts, total, active, onSelect }: {
  counts: Partial<Record<Verdict, number>>; total: number; active: Verdict | null; onSelect: (v: Verdict | null) => void;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
      {VERDICT_ORDER.map((v) => {
        const n = counts[v] ?? 0;
        const on = active === v;
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onSelect(on ? null : v)}
                  className={cn('group relative overflow-hidden rounded-card border bg-surface p-3.5 text-left shadow-card transition hover:-translate-y-px hover:shadow-md',
                    on ? 'border-transparent ring-2' : 'border-line')}
                  style={on ? { boxShadow: `0 0 0 2px ${VERDICT_HEX[v]}` } : undefined}>
            <span className="absolute inset-y-0 left-0 w-1" style={{ background: VERDICT_HEX[v] }} aria-hidden="true" />
            <span className="block text-[12px] font-semibold text-ink-2">{t(VERDICT_LABEL[v])}</span>
            <span className="mt-1 block text-[26px] font-bold tabular-nums leading-none text-ink">{n.toLocaleString()}</span>
            <span className="mt-2.5 block h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
              <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${total ? (n / total) * 100 : 0}%`, background: VERDICT_HEX[v] }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
