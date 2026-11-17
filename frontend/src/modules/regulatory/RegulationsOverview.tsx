/**
 * What the list on screen is made of — read from the same facets the filter
 * rail counts, so every number here is a COUNT(*) under the current filters.
 *
 *   Impact mix      a ring cut by impact level (Critical · High · Medium · Low · not scored)
 *   Who issues them the regulators with the most regulations in the list
 *
 * Each slice and each bar is also a filter: pressing one narrows the list to it,
 * pressing it again lifts the filter.
 */
import type { CSSProperties } from 'react';
import { Scale, Landmark } from 'lucide-react';
import type { RegulationFacets, RegulationFilters } from '@/services/regulationsApi';
import { CardHead } from '@/modules/onboarding/AddDataUi';
import { IMPORTANCE, IMPORTANCE_HEX, regulatorColor } from './RegulationFilters';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

const NOT_SCORED_HEX = '#e5e7eb';
const TOP = 6;

export function RegulationsOverview({ facets, total, filters, apply, compact = false }: {
  facets: RegulationFacets | undefined; total: number; filters: RegulationFilters; apply: (f: RegulationFilters) => void;
  /** one column, for the filter rail: the ring and its legend, then the regulators beneath */
  compact?: boolean;
}) {
  const t = useT();
  if (!facets || total === 0) return null;

  const count = (k: string) => facets.importance.find((f) => f.value === k)?.count ?? 0;
  const scored = IMPORTANCE.reduce((a, k) => a + count(k), 0);
  const segs = [
    ...IMPORTANCE.map((k) => ({ key: k, label: k, n: count(k), hex: IMPORTANCE_HEX[k] })),
    { key: '', label: 'Not scored', n: Math.max(0, total - scored), hex: NOT_SCORED_HEX },
  ];
  const regs = facets.regulators.filter((r) => r.count > 0);
  const top = regs.slice(0, TOP);
  const maxReg = Math.max(1, ...top.map((r) => r.count));

  const toggle = (key: 'importance' | 'regulator', v: string) => {
    const cur = filters[key];
    apply({ ...filters, [key]: cur.length === 1 && cur[0] === v ? [] : [v] });
  };

  // the ring: one arc per level, laid end to end
  const size = compact ? 92 : 112, stroke = compact ? 11 : 13, r = (size - stroke) / 2, len = 2 * Math.PI * r;
  let at = 0;
  const arcs = segs.filter((s) => s.n > 0).map((s, i) => {
    const part = (s.n / total) * len;
    const arc = { ...s, part, offset: -at, i };
    at += part;
    return arc;
  });

  return (
    <section className={cn('rg-rise card', compact ? 'p-3.5' : 'mb-3 p-4')}>
      <CardHead icon={Scale} hex="#4f46e5" title={t('What is in this list')}
                note={compact ? (
                  // the narrow rail cannot hold it on one line: one fact per line
                  <>
                    <span className="block truncate">{t('{n} regulators', { n: regs.length.toLocaleString() })}</span>
                    <span className="block truncate">{t('{s} of {n} scored for impact', { s: scored.toLocaleString(), n: total.toLocaleString() })}</span>
                  </>
                ) : t('{r} regulators · {s} of {n} scored for impact', { r: regs.length.toLocaleString(), s: scored.toLocaleString(), n: total.toLocaleString() })} />
      <div className={cn('grid', compact ? 'gap-3' : 'gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]')}>
        {/* impact mix */}
        <div className={cn('flex min-w-0 items-center', compact ? 'gap-2.5' : 'gap-4')}>
          <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
            <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
              <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f2f2f7" strokeWidth={stroke} />
              {arcs.map((a) => (
                <circle key={a.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={a.hex} strokeWidth={stroke}
                        strokeDasharray={`${a.part} ${len}`} strokeDashoffset={a.offset}
                        className="rg-seg" style={{ '--len': len, '--d': `${a.i * 90}ms` } as CSSProperties} />
              ))}
            </svg>
            <span className="relative text-center leading-none">
              <b className={cn('block font-semibold tabular-nums tracking-tight text-ink', compact ? 'text-[17px]' : 'text-[22px]')}>{total.toLocaleString()}</b>
              <span className="mt-1 block text-[10.5px] text-muted">{t('in this list')}</span>
            </span>
          </span>
          <ul className="min-w-0 flex-1 space-y-0.5">
            {segs.map((s, i) => {
              const on = !!s.key && filters.importance.length === 1 && filters.importance[0] === s.key;
              const Tag = s.key ? 'button' : 'div';
              return (
                <li key={s.label} className="rg-rise" style={{ '--d': `${120 + i * 50}ms` } as CSSProperties}>
                  <Tag {...(s.key ? { type: 'button' as const, onClick: () => toggle('importance', s.key), 'aria-pressed': on } : {})}
                       className={cn('flex w-full items-center rounded-lg text-left transition-colors',
                         compact ? 'gap-1.5 px-1.5 py-0.5 text-[12px]' : 'gap-2 px-2 py-1 text-[12.5px]',
                         s.key && 'hover:bg-slate-50', on && 'bg-slate-100')}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.hex }} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{t(s.label)}</span>
                    <span className="font-semibold tabular-nums text-ink">{s.n.toLocaleString()}</span>
                  </Tag>
                </li>
              );
            })}
          </ul>
        </div>

        {/* who issues them */}
        <div className={cn('min-w-0 border-line', compact ? 'border-t pt-3' : 'md:border-l md:pl-5')}>
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
            <Landmark className="h-3.5 w-3.5 text-muted" />{t('Who issues them')}
          </p>
          <ul className="space-y-1">
            {top.map((g, i) => {
              const c = regulatorColor(g.value);
              const on = filters.regulator.length === 1 && filters.regulator[0] === g.value;
              return (
                <li key={g.value} className="rg-rise" style={{ '--d': `${150 + i * 55}ms` } as CSSProperties}>
                  <button type="button" onClick={() => toggle('regulator', g.value)} aria-pressed={on}
                          title={on ? t('Show every regulator again') : t('Show only {name}', { name: g.value })}
                          className={cn('group grid w-full items-center rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-slate-50',
                            compact ? 'grid-cols-[minmax(0,64px)_minmax(0,1fr)_auto] gap-2' : 'grid-cols-[minmax(0,92px)_minmax(0,1fr)_auto] gap-2.5',
                            on && 'bg-slate-100')}>
                    <span className="truncate text-[12px] font-semibold" style={{ color: c.ink }}>{g.value}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <span className="rg-grow block h-full rounded-full" style={{ width: `${(g.count / maxReg) * 100}%`, background: c.ink, '--d': `${200 + i * 60}ms` } as CSSProperties} />
                    </span>
                    <span className="min-w-8 text-right text-[12px] font-semibold tabular-nums text-ink">{g.count.toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {regs.length > TOP && (
            <p className="mt-1.5 px-1.5 text-[11.5px] text-muted">{t('+{n} more regulators — use the Regulator filter', { n: (regs.length - TOP).toLocaleString() })}</p>
          )}
        </div>
      </div>
    </section>
  );
}
