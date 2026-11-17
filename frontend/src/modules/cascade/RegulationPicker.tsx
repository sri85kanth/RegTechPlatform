import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Icon } from '@/config/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { CountUp } from '@/components/ui/motion';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import type { CascadeRegulation, RegulationSummary } from './cascadeTypes';
import './regPicker.css';
import '@/components/ui/premium.css';

export type Tab = 'info' | 'change';
type Quick = 'all' | 'gaps' | 'critical' | 'documented';

const unmetOf = (i: RegulationSummary) => i.partial + i.gap + i.not_covered;
const QUICK: { key: Quick; label: string; test: (i: RegulationSummary) => boolean }[] = [
  { key: 'all', label: tx('All'), test: () => true },
  { key: 'gaps', label: tx('With gaps'), test: (i) => unmetOf(i) > 0 },
  { key: 'critical', label: tx('Critical'), test: (i) => i.critical > 0 },
  { key: 'documented', label: tx('Documented'), test: (i) => i.applicable > 0 && unmetOf(i) === 0 },
];
/** status colours, in the order a bar draws them */
const SEG: { key: keyof RegulationSummary; color: string; label: string }[] = [
  { key: 'met', color: '#34C759', label: tx('Documented') },
  { key: 'partial', color: '#FF9F0A', label: tx('Partial') },
  { key: 'gap', color: '#FF3B30', label: tx('Gap') },
  { key: 'not_covered', color: '#FF6A00', label: tx('Not covered') },
];

/**
 * The regulation in view, as a card; "Change regulation" (or the card itself)
 * opens a sheet with two tabs — what this regulation is, and every other
 * regulation as cards to switch to, with search and filters.
 */
export function RegulationPicker({ items, active, reg, onPick, compact, sheet: openTab, onSheet, noButton }: {
  items: RegulationSummary[]; active: string; reg?: CascadeRegulation; onPick: (id: string) => void;
  /** one small button (for the page header) instead of the full card */
  compact?: boolean;
  /** controlled: which tab of the sheet is open, so something else on the page can open it */
  sheet?: Tab | null; onSheet?: (tab: Tab | null) => void;
  /** compact only: render the sheet but not the button */
  noButton?: boolean;
}) {
  const t = useT();
  const [own, setOwn] = useState<Tab | null>(null);
  const open = onSheet ? (openTab ?? null) : own;
  const setOpen = onSheet ?? setOwn;
  const cur = items.find((i) => i.id === active);
  const title = cur ? (cur.short_title || cur.title) : (reg?.short || reg?.title || '');
  const sheet = open && (
    <Sheet tab={open} onTab={setOpen} onClose={() => setOpen(null)}
           items={items} active={active} cur={cur} reg={reg}
           onPick={(id) => { onPick(id); }} />
  );
  if (compact) {
    return (
      <>
        {!noButton && (
          <button type="button" onClick={() => setOpen('change')} title={t('Change regulation')}
                  className="btn btn-outline max-w-[min(420px,80vw)] gap-2">
            <Icon name="Landmark" className="h-4 w-4 shrink-0 text-brand-600" />
            <span className="min-w-0 truncate">{title || t('Choose a regulation')}</span>
            <Icon name="ChevronDown" className="h-4 w-4 shrink-0 text-muted" />
          </button>
        )}
        {sheet}
      </>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <button type="button" onClick={() => setOpen('info')}
                className="group flex min-w-0 flex-[1_1_420px] items-center gap-3.5 rounded-2xl p-1 text-left transition-colors duration-200 hover:bg-black/[0.03]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-[#2b8cff] to-[#0071e3] text-white shadow-[0_4px_14px_rgba(0,113,227,0.35)] transition-transform duration-300 ease-spring group-hover:scale-105 group-hover:-rotate-3">
            <Icon name="Landmark" className="h-6 w-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="field-label mb-0.5">{t('Regulation')}</span>
            <span className="block truncate text-[17px] font-semibold tracking-tight text-ink">{title}</span>
            {cur && (
              <span className="mt-0.5 block truncate text-xs text-muted">
                {t('{n} unmet of {total}', { n: unmetOf(cur).toLocaleString(), total: cur.applicable.toLocaleString() })}
                {cur.critical ? ` · ${t('{n} critical', { n: cur.critical.toLocaleString() })}` : ''}
              </span>
            )}
          </span>
          <Icon name="Info" className="h-4 w-4 shrink-0 text-muted-2 opacity-0 transition-all duration-300 ease-spring group-hover:opacity-100" />
        </button>
        {cur && <StatusBar r={cur} className="hidden w-48 lg:block" />}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => setOpen('change')}>
            <Icon name="ArrowLeftRight" className="h-4 w-4" /> {t('Change regulation')}
          </button>
          {active && (
            <Link to={`/regulation/${encodeURIComponent(active)}`} className="btn btn-outline">
              {t('Open regulation')} <Icon name="ArrowRight" className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>
      {sheet}
    </>
  );
}

/* ============================================================ the sheet */

function Sheet({ tab, onTab, onClose, items, active, cur, reg, onPick }: {
  tab: Tab; onTab: (t: Tab) => void; onClose: () => void;
  items: RegulationSummary[]; active: string; cur?: RegulationSummary; reg?: CascadeRegulation; onPick: (id: string) => void;
}) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  const [dir, setDir] = useState<'left' | 'right'>('right');
  const closeBtn = useRef<HTMLButtonElement>(null);
  // close with a short exit animation, then unmount
  const close = () => { setLeaving(true); window.setTimeout(onClose, 200); };
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', k);
    if (tab === 'info') closeBtn.current?.focus();
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', k); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const switchTab = (next: Tab) => { setDir(next === 'change' ? 'right' : 'left'); onTab(next); };

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center p-3 sm:p-6">
      <div className={cn('rp-backdrop absolute inset-0 bg-black/25 backdrop-blur-[6px]', leaving && 'out')} onMouseDown={close} aria-hidden="true" />
      <section role="dialog" aria-modal="true" aria-label={tab === 'info' ? t('Regulation info') : t('Change regulation')}
               className={cn('rp-panel relative flex max-h-[88vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[26px] bg-white/[0.92] shadow-float backdrop-blur-2xl', leaving && 'out')}>
        <header className="flex items-center gap-3 px-5 pb-3 pt-4 shadow-[inset_0_-0.5px_0_rgba(0,0,0,0.08)]">
          <SegmentedControl<Tab>
            ariaLabel="Regulation"
            value={tab}
            onChange={switchTab}
            options={[{ key: 'info', label: 'Regulation info' }, { key: 'change', label: 'Change regulation' }]}
          />
          <button ref={closeBtn} type="button" onClick={close} aria-label={t('Close')}
                  className="ml-auto grid h-9 w-9 place-items-center rounded-full bg-black/[0.05] text-ink-2 transition-all duration-300 ease-spring hover:rotate-90 hover:bg-black/[0.08] active:scale-90">
            <Icon name="X" className="h-4 w-4" />
          </button>
        </header>
        <div key={tab} className={cn('rp-tab min-h-0 flex-1 overflow-y-auto', dir === 'left' && 'from-left')}>
          {tab === 'info'
            ? <InfoTab cur={cur} reg={reg} onChange={() => switchTab('change')} />
            : <ChangeTab items={items} active={active} onPick={(id) => { onPick(id); close(); }} />}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/* ============================================================ regulation info */

function InfoTab({ cur, reg, onChange }: { cur?: RegulationSummary; reg?: CascadeRegulation; onChange: () => void }) {
  const t = useT();
  const verdict = reg?.applicability ?? '';
  const verdictWord = verdict === 'APPLICABLE' ? 'Applies to us'
    : verdict ? verdict.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '';
  const verdictTone = verdict === 'APPLICABLE' ? 'bg-success-50 text-success-700' : verdict === 'CONDITIONAL' ? 'bg-warning-50 text-warning-700' : 'bg-black/[0.05] text-ink-2';
  const stats: { label: string; value: number; color: string; icon: string }[] = cur ? [
    { label: 'Obligations', value: cur.applicable, color: '#0071E3', icon: 'ListChecks' },
    { label: 'Documented', value: cur.met, color: '#34C759', icon: 'CheckCircle2' },
    { label: 'Partial', value: cur.partial, color: '#FF9F0A', icon: 'AlertTriangle' },
    { label: 'Gap', value: cur.gap, color: '#FF3B30', icon: 'XCircle' },
    { label: 'Not covered', value: cur.not_covered, color: '#FF6A00', icon: 'FileWarning' },
    { label: 'Critical priority', value: cur.critical, color: '#D70015', icon: 'Flame' },
  ] : [];
  // what the old side panel showed: duties on the hospital, unmet duties by priority, the worst of them
  const items = (reg?.units ?? []).flatMap((u) => u.items);
  const na = reg?.not_applicable ?? 0;
  const unmet = items.filter((x) => x.st === 'PARTIAL' || x.st === 'GAP' || x.st === 'NOT_COVERED');
  const byRisk = RISKS.map((k) => ({ k, n: unmet.filter((x) => x.rk === k).length })).filter((r) => r.n > 0);
  const worst = [...unmet].sort((a, b) => RISKS.indexOf(a.rk) - RISKS.indexOf(b.rk) || ST_ORDER.indexOf(a.st) - ST_ORDER.indexOf(b.st)).slice(0, 6);
  return (
    <div className="pm-stagger space-y-5 p-5 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {reg?.regulator && <span className="pill bg-brand-50 text-brand-700"><Icon name="Landmark" className="h-3.5 w-3.5" />{reg.regulator}</span>}
          {verdictWord && <span className={cn('pill', verdictTone)}>{t(verdictWord)}</span>}
          {reg?.regulation_type && <span className="pill bg-black/[0.05] text-ink-2">{reg.regulation_type}</span>}
        </div>
        <h2 className="mt-3 text-[24px] font-semibold leading-tight text-ink">{reg?.title ?? cur?.title}</h2>
        {reg?.regulator_full && <p className="mt-1 text-[13.5px] text-muted">{reg.regulator_full}</p>}
      </div>

      {/* the regulation in numbers */}
      {cur && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((s, i) => (
            <div key={s.label} className="card rounded-[16px] p-3.5" style={{ animationDelay: `${0.05 + i * 0.04}s` }}>
              <span style={{ color: s.color }}><Icon name={s.icon} className="h-4 w-4" /></span>
              <CountUp value={s.value} className="num mt-2 block text-[24px] font-semibold leading-none text-ink" />
              <div className="mt-1 truncate text-[12px] text-muted">{t(s.label)}</div>
            </div>
          ))}
        </div>
      )}
      {cur && <StatusBar r={cur} big />}

      {/* facts */}
      <dl className="grid gap-3 rounded-[18px] bg-black/[0.03] p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={t('Regulator')} value={reg?.regulator_full || reg?.regulator} icon="Landmark" />
        <Fact label={t('Type')} value={reg?.regulation_type} icon="FileText" />
        <Fact label={t('Jurisdiction')} value={reg?.jurisdiction} icon="MapPin" />
        <Fact label={t('In force from')} value={reg?.effective_from} icon="Calendar" />
        <Fact label={t('Impact score')} value={reg?.impact_score != null ? `${Math.round(reg.impact_score)} / 100${reg.impact_level ? ` · ${t(reg.impact_level)}` : ''}` : undefined} icon="Activity" />
        <Fact label={t('Duties on the hospital')} value={reg ? t('{n} of {total} provisions', { n: items.length.toLocaleString(), total: (items.length + na).toLocaleString() }) : undefined} icon="ListChecks" />
      </dl>

      {byRisk.length > 0 && (
        <div>
          <div className="sec-eyebrow mb-2">{t('Priority of the unmet duties')}</div>
          <div className="flex flex-wrap gap-2">
            {byRisk.map((r, i) => <span key={r.k} className={cn('pm-pop pill', RISK_PILL[r.k])} style={{ animationDelay: `${0.25 + i * 0.06}s` }}>{t(RISK_N[r.k], { n: r.n.toLocaleString() })}</span>)}
          </div>
        </div>
      )}

      {worst.length > 0 && (
        <div>
          <div className="sec-eyebrow mb-2">{t('Most serious gaps')}</div>
          <ul className="pm-stagger divide-y divide-line overflow-hidden rounded-[16px] border border-line bg-white">
            {worst.map((x) => (
              <li key={x.c} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="h-7 w-1 shrink-0 rounded-full" style={{ background: ST_COLOR[x.st] }} />
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">
                  <span className="mr-1.5 font-semibold text-brand-600">{x.c}</span>
                  <span className="line-clamp-2 inline">{(x.ob || x.t).replace(/^The hospital shall /i, '')}</span>
                </span>
                <span className="pill shrink-0" style={{ background: `${ST_COLOR[x.st]}1a`, color: ST_COLOR[x.st] }}>{t(ST_WORD[x.st])}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reg?.applicability_reason && (
        <div className="rounded-[18px] bg-gradient-to-br from-[#eef6ff] to-[#f7fbff] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-brand-700"><Icon name="BadgeCheck" className="h-4 w-4" />{t('Why it applies')}</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{reg.applicability_reason}</p>
          {(reg.not_applicable ?? 0) > 0 && (
            <p className="mt-2 text-xs text-muted">
              {reg.not_applicable === 1 ? t('1 provision binds someone else') : t('{n} provisions bind someone else', { n: (reg.not_applicable ?? 0).toLocaleString() })}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className="btn btn-primary" onClick={onChange}><Icon name="ArrowLeftRight" className="h-4 w-4" /> {t('Change regulation')}</button>
        {reg?.url && (
          <a href={reg.url} target="_blank" rel="noopener noreferrer" className="btn">
            {t('Source document')} <Icon name="ArrowUpRight" className="h-4 w-4" />
          </a>
        )}
        {reg && <Link to={`/regulation/${encodeURIComponent(reg.id)}`} className="btn btn-outline">{t('Open regulation')} <Icon name="ArrowRight" className="h-4 w-4" /></Link>}
        {reg && <Link to={`/compliance?regulation=${encodeURIComponent(reg.id)}`} className="btn btn-outline">{t('Open in Requirements')}</Link>}
      </div>
    </div>
  );
}

const RISKS: readonly string[] = ['Critical', 'High', 'Medium', 'Low'];
const ST_ORDER = ['GAP', 'NOT_COVERED', 'PARTIAL'];
const RISK_PILL: Record<string, string> = {
  Critical: 'bg-critical-500 text-white', High: 'bg-notcov-50 text-notcov-600', Medium: 'bg-warning-50 text-warning-700', Low: 'bg-slate-100 text-slate-600',
};
const RISK_N: Record<string, string> = { Critical: tx('{n} Critical'), High: tx('{n} High'), Medium: tx('{n} Medium'), Low: tx('{n} Low') };
const ST_COLOR: Record<string, string> = { PARTIAL: '#FF9F0A', GAP: '#FF3B30', NOT_COVERED: '#FF6A00', MET: '#34C759' };
const ST_WORD: Record<string, string> = { PARTIAL: tx('Partial'), GAP: tx('Gap'), NOT_COVERED: tx('Not covered'), MET: tx('Documented') };

function Fact({ label, value, icon }: { label: string; value?: string | null; icon: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white text-muted shadow-[0_0_0_0.5px_rgba(0,0,0,0.06)]"><Icon name={icon} className="h-4 w-4" /></span>
      <div className="min-w-0">
        <dt className="text-[11.5px] text-muted">{label}</dt>
        <dd className="truncate text-[13.5px] font-medium text-ink">{value || '—'}</dd>
      </div>
    </div>
  );
}

/* ============================================================ change regulation */

function ChangeTab({ items, active, onPick }: { items: RegulationSummary[]; active: string; onPick: (id: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<Quick>('all');
  const [regulator, setRegulator] = useState<string>('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  // regulators, most regulations first
  const regulators = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => { const r = (i.regulator ?? '').trim(); if (r) m.set(r, (m.get(r) ?? 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => (!regulator || (i.regulator ?? '').trim() === regulator)
      && (!s || `${i.title} ${i.short_title ?? ''} ${i.regulator ?? ''}`.toLowerCase().includes(s)));
  }, [items, q, regulator]);
  const shown = base.filter(QUICK.find((x) => x.key === quick)!.test);

  return (
    <div className="space-y-4 p-5 sm:p-6">
      <label className="flex h-11 items-center gap-2.5 rounded-full bg-black/[0.05] px-4 text-muted transition-all duration-300 ease-spring focus-within:bg-white focus-within:shadow-glow">
        <Icon name="Search" className="h-[18px] w-[18px] shrink-0" />
        <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search regulations')}
               aria-label={t('Search regulations')} className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted" />
        <span className="shrink-0 text-xs tabular-nums">{t('{n} regulations', { n: shown.length.toLocaleString() })}</span>
      </label>

      {/* quick filters, each with how many it keeps */}
      <div className="flex flex-wrap gap-2">
        {QUICK.map((f) => {
          const n = base.filter(f.test).length;
          const on = quick === f.key;
          return (
            <button key={f.key} type="button" onClick={() => setQuick(f.key)} aria-pressed={on}
                    className={cn('inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-300 ease-spring active:scale-95',
                      on ? 'bg-ink text-white shadow-[0_4px_12px_rgba(0,0,0,0.18)]' : 'bg-black/[0.05] text-ink-2 hover:bg-black/[0.08]')}>
              {t(f.label)}
              <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', on ? 'bg-white/20' : 'bg-white')}>{n}</span>
            </button>
          );
        })}
      </div>
      {/* regulators, scrolling sideways */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[['', items.length] as [string, number], ...regulators].map(([r, n]) => {
          const on = regulator === r;
          return (
            <button key={r || 'all'} type="button" onClick={() => setRegulator(r)} aria-pressed={on}
                    className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-300 ease-spring active:scale-95',
                      on ? 'bg-brand-600 text-white shadow-[0_4px_12px_rgba(0,113,227,0.3)]' : 'bg-white text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.06)]')}>
              {r || t('All regulators')}
              <span className={cn('tabular-nums', on ? 'text-white/80' : 'text-muted')}>{n}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div className="grid place-items-center gap-2 py-14 text-center text-[13px] text-muted">
          <Icon name="SearchX" className="h-8 w-8 text-muted-2" />
          {t('No regulations match these filters.')}
        </div>
      ) : (
        <div key={`${quick}|${regulator}|${q}`} className="rp-grid grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((i) => <RegCard key={i.id} r={i} current={i.id === active} onPick={() => onPick(i.id)} />)}
        </div>
      )}
    </div>
  );
}

function RegCard({ r, current, onPick }: { r: RegulationSummary; current: boolean; onPick: () => void }) {
  const t = useT();
  const unmet = unmetOf(r);
  return (
    <button type="button" onClick={onPick} aria-current={current ? 'true' : undefined}
            className={cn('card card-int group flex min-h-[148px] flex-col p-4 text-left',
              current && 'shadow-[0_0_0_2px_#0071e3,0_10px_28px_rgba(0,113,227,0.18)]')}>
      <div className="flex w-full items-center gap-2">
        <span className="truncate rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">{r.regulator?.trim() || '—'}</span>
        {current && <span className="pill ml-auto bg-brand-600 py-0.5 text-white"><Icon name="Check" className="h-3 w-3" />{t('Current')}</span>}
        {!current && r.critical > 0 && <span className="pill ml-auto bg-critical-50 py-0.5 text-critical-600">{t('{n} critical', { n: r.critical.toLocaleString() })}</span>}
      </div>
      <div className="mt-2.5 line-clamp-2 text-[14px] font-semibold leading-snug text-ink group-hover:text-brand-700">{r.short_title || r.title}</div>
      <div className="mt-auto pt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px] text-muted">
          <span>{t('{n} unmet of {total}', { n: unmet.toLocaleString(), total: r.applicable.toLocaleString() })}</span>
          <span className="font-semibold tabular-nums text-ink-2">{r.applicable ? Math.round((r.met / r.applicable) * 100) : 0}%</span>
        </div>
        <StatusBar r={r} />
      </div>
    </button>
  );
}

/** Met / partial / gap / not covered, as one bar. */
function StatusBar({ r, big = false, className }: { r: RegulationSummary; big?: boolean; className?: string }) {
  const t = useT();
  const total = SEG.reduce((a, s) => a + Number(r[s.key] ?? 0), 0);
  return (
    <div className={className}>
      <div className={cn('flex overflow-hidden rounded-full bg-black/[0.05]', big ? 'h-3' : 'h-1.5')}>
        {total > 0 && SEG.map((s) => {
          const v = Number(r[s.key] ?? 0);
          return v > 0 ? <div key={String(s.key)} className="rp-fill h-full" title={`${t(s.label)}: ${v.toLocaleString()}`} style={{ width: `${(v / total) * 100}%`, background: s.color }} /> : null;
        })}
      </div>
      {big && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {SEG.map((s) => (
            <span key={String(s.key)} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{t(s.label)}
              <b className="font-semibold tabular-nums text-ink-2">{Number(r[s.key] ?? 0).toLocaleString()}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
