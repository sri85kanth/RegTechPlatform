/**
 * What changed in the regulations that apply to us — clause by clause, and how
 * much of the hospital each change reaches.
 *
 * Read, never invented:
 *   /api/dashboard/calendar          changes the watcher detected (only those that apply)
 *   /api/regulations/:id/changes     which clauses were reworded, and by how many words
 *   /api/regulations/:id/impact      the regulation's impact level and the records it reaches
 * Changes in regulations that do not apply to us are not shown here: the card is
 * about what we must act on. With no change that applies, it shows the weightiest
 * regulations that apply, unchanged, and keeps to its own height.
 *
 * Pressing a change turns the card over: its back is that regulation's impact —
 * how much it weighs, how many of our records it reaches and which, the clauses
 * that moved — with the way on to its impact graph and its cascade, both inside the
 * Impact Cascade page.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { GitCompareArrows, ChevronRight, ArrowLeft, Network, Workflow, ArrowRight, Flame, AlertTriangle } from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';
import { useUi } from '@/app/store/ui';
import type { ImpactGraph } from '@/services/regImpactApi';
import { regulatorColor } from '@/modules/regulatory/RegulationFilters';
import { CardLink } from './DashboardWidgets';

interface CalChange { id: string; title: string; regulator: string | null; sections: number; applies: boolean }
interface CalLite { days?: { date: string; changes: CalChange[] }[]; today?: string }
interface Changes {
  wordingChanges?: number;
  items?: { section_number: string; change_class: 'WORDING' | 'NUMBERING_ONLY'; words_added: number; words_removed: number }[];
}
interface Impact {
  regulation?: { impact_level: string | null; impact_score: number | null };
  totals?: { entities: number };
  byDomain?: Record<string, number>;
}

/** at most this many changes that apply, with clause detail; the rest are one click away */
const MAX = 4;
const LEVEL: Record<string, { label: string; cls: string; hex: string }> = {
  CRITICAL: { label: tx('Critical impact'), cls: 'bg-critical-600 text-white', hex: '#d70015' },
  HIGH: { label: tx('High impact'), cls: 'bg-critical-500 text-white', hex: '#ff3b30' },
  MEDIUM: { label: tx('Medium impact'), cls: 'bg-amber-400 text-amber-950', hex: '#ff9f0a' },
  LOW: { label: tx('Low impact'), cls: 'bg-slate-200 text-slate-700', hex: '#8e8e93' },
};
const DOMAIN_WORD: Record<string, string> = {
  policies: tx('policies'), controls: tx('controls'), risks: tx('risks'), evidence: tx('evidence'), processes: tx('processes'),
  people: tx('people'), systems: tx('systems'), overview: tx('licences'), departments: tx('departments'),
};
const NO_IMPACT = tx('No measured impact');
/** "3", "3.2", "10(a)" in reading order */
const byClause = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function RegulationChanges({ applicable }: { applicable?: number }) {
  const t = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const cal = useQuery<CalLite>({ queryKey: ['change-calendar'], queryFn: () => api('/api/dashboard/calendar'), staleTime: 60_000 });

  const all = (cal.data?.days ?? [])
    .flatMap((d) => d.changes.map((c) => ({ ...c, date: d.date })))
    .sort((a, b) => b.date.localeCompare(a.date));
  // only changes in regulations that apply to us
  const list = all.filter((c) => c.applies);
  const shown = list.slice(0, MAX);
  // the change whose impact the back of the card shows; null = the front
  const [picked, setPicked] = useState<(typeof all)[number] | null>(null);
  const front = useRef<HTMLElement>(null);
  const back = useRef<HTMLElement>(null);
  useEffect(() => {
    // only the face in view can be reached by keyboard or screen reader
    front.current?.toggleAttribute('inert', !!picked);
    back.current?.toggleAttribute('inert', !picked);
    if (picked) back.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [picked]);

  const details = useQueries({
    queries: shown.flatMap((c) => [
      { queryKey: ['regulation-changes', c.id], queryFn: () => api<Changes>(`/api/regulations/${encodeURIComponent(c.id)}/changes`), staleTime: 300_000 },
      { queryKey: ['dash-impact', c.id], queryFn: () => api<Impact>(`/api/regulations/${encodeURIComponent(c.id)}/impact?min_confidence=0&limit=50`), staleTime: 300_000, retry: false },
    ]),
  });

  const today = new Date(`${cal.data?.today ?? new Date().toISOString().slice(0, 10)}T00:00:00`).getTime();
  const ago = (iso: string) => {
    const d = Math.round((today - new Date(`${iso}T00:00:00`).getTime()) / 86_400_000);
    return d <= 0 ? t('Today') : d === 1 ? t('Yesterday') : t('{n} days ago', { n: d.toLocaleString() });
  };

  // with changes to show, or a card turned over, it takes its share of the column; with
  // only the "no change yet" cards it keeps to its own height and Top critical gaps gets the rest
  const tall = shown.length > 0 || !!picked;

  return (
    <div className={cn('rc-flip dg-panel relative flex min-h-0 flex-col', tall ? 'flex-1' : 'flex-none xl:self-start 2xl:self-stretch', picked && 'is-flipped')}>
    <div className="rc-inner relative flex min-h-0 flex-1 flex-col">
    <section ref={front} className="rc-face card flex min-h-0 flex-1 flex-col p-4">
      <header className="mb-2 flex items-center gap-2.5 px-1">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-brand-600 text-white shadow-[0_6px_14px_-6px_rgba(124,58,237,0.7)]">
          <GitCompareArrows className="h-4 w-4" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">{t('Regulation changes')}</h3>
        {list.length > MAX && <CardLink to="/reg-regulations">{t('View all')}</CardLink>}
        <button type="button" onClick={() => navigate('/cascade')} title={t('Open the Impact Cascade')}
                className="group inline-flex shrink-0 items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11.5px] font-semibold text-violet-700 transition hover:bg-violet-100 active:scale-95">
          <Workflow className="h-3.5 w-3.5 transition-transform group-hover:rotate-12" />{t('Impact Cascade')}
        </button>
      </header>

      {cal.isLoading && <p className="px-2 py-3 text-[13px] text-muted">{t('Loading…')}</p>}

      {/* nothing that applies has changed: the regulations that apply, weightiest first, rise one by one */}
      {!cal.isLoading && list.length === 0 && (
        <AppliesTicker applicable={applicable}
                       onImpact={(r) => setPicked({ id: r.id, title: r.title, regulator: r.regulator_short, sections: 0, applies: true, date: '' })} />
      )}

      {shown.length > 0 && (
      <ul className="-mx-1 max-h-[420px] min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1 2xl:max-h-none">
        {shown.map((c, i) => {
          const ch = details[i * 2]?.data as Changes | undefined;
          const im = details[i * 2 + 1]?.data as Impact | undefined;
          const wording = (ch?.items ?? []).filter((x) => x.change_class === 'WORDING');
          const clauses = [...new Set((wording.length ? wording : ch?.items ?? []).map((x) => x.section_number).filter(Boolean))].sort(byClause);
          const added = wording.reduce((s, x) => s + (x.words_added || 0), 0);
          const removed = wording.reduce((s, x) => s + (x.words_removed || 0), 0);
          const level = LEVEL[(im?.regulation?.impact_level ?? '').toUpperCase()];
          const reach = im?.totals?.entities ?? 0;
          const domains = Object.entries(im?.byDomain ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
          return (
            <li key={c.id} className="dg-row" style={{ '--d': `${i * 70}ms`, '--rc': level?.hex ?? '#7c3aed' } as CSSProperties}>
              <button onClick={() => setPicked(c)} className="dg-btn group !items-start">
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-2">
                    <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-ink">{c.title}</span>
                    <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold', level?.cls ?? 'bg-slate-100 text-slate-500')}>
                      {t(level?.label ?? NO_IMPACT)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {[c.regulator, new Date(`${c.date}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }), ago(c.date)].filter(Boolean).join(' · ')}
                  </span>
                  {/* which clauses */}
                  <span className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-[11px] font-medium text-ink-2">{t('Clauses changed')}</span>
                    {clauses.length === 0
                      ? <span className="text-[11px] text-muted">{t('{n} sections reworded', { n: c.sections.toLocaleString() })}</span>
                      : (<>
                        {clauses.slice(0, 5).map((s) => (
                          <span key={s} className="rounded-md bg-violet-50 px-1.5 py-px font-mono text-[10.5px] font-semibold text-violet-700">{s}</span>
                        ))}
                        {clauses.length > 5 && <span className="text-[11px] text-muted">{t('+{n} more', { n: (clauses.length - 5).toLocaleString() })}</span>}
                      </>)}
                  </span>
                  {/* how much, and what it reaches */}
                  <span className="mt-1 block text-[11px] text-muted">
                    {wording.length > 0 && <>{t('{n} clauses reworded', { n: wording.length.toLocaleString() })} · <span className="text-success-600">+{added.toLocaleString()}</span> / <span className="text-critical-600">−{removed.toLocaleString()}</span> {t('words')}</>}
                    {wording.length > 0 && ' · '}
                    {reach > 0
                      ? <>{t('Reaches {n} of your records', { n: reach.toLocaleString() })}{domains.length > 0 && ` (${domains.map(([d, n]) => `${n} ${t(DOMAIN_WORD[d] ?? d)}`).join(', ')})`}</>
                      : t('Reaches none of your records yet')}
                  </span>
                </span>
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
              </button>
            </li>
          );
        })}

      </ul>
      )}

    </section>

    {/* the back: the picked change's impact */}
    <section ref={back} className="rc-face rc-back card absolute inset-0 flex min-h-0 flex-col p-4" aria-label={t('Impact of this change')}>
      {picked && <ImpactBack c={picked} ago={ago} locale={locale} onBack={() => setPicked(null)} />}
    </section>
    </div>
    </div>
  );
}

const IMPACT_OF_CHANGE = tx('Impact of this change');
const IMPACT_ON_US = tx('Impact on us');
const LEVEL_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const NODE_HEX: Record<string, string> = { Critical: '#d70015', High: '#ff3b30', Medium: '#ff9f0a', Low: '#8e8e93' };

/** The back of the card: one regulation's impact, read from the impact engine. */
function ImpactBack({ c, ago, locale, onBack }: {
  c: CalChange & { date: string }; ago: (iso: string) => string; locale?: string; onBack: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const openEntity = useUi((s) => s.openEntity);
  const enc = encodeURIComponent(c.id);
  const im = useQuery<ImpactGraph>({
    queryKey: ['dash-impact-full', c.id], staleTime: 300_000, retry: false,
    queryFn: () => api<ImpactGraph>(`/api/regulations/${enc}/impact?min_confidence=0&limit=200`),
  });
  const ch = useQuery<Changes>({ queryKey: ['regulation-changes', c.id], queryFn: () => api<Changes>(`/api/regulations/${enc}/changes`), staleTime: 300_000 });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onBack]);

  const g = im.data;
  const level = LEVEL[(g?.regulation?.impact_level ?? '').toUpperCase()];
  const score = Number(g?.regulation?.impact_score ?? 0);
  const reach = g?.totals?.entities ?? 0;
  const domains = Object.entries(g?.byDomain ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const maxD = Math.max(1, ...domains.map(([, n]) => n));
  const nodes = [...(g?.nodes ?? [])]
    .sort((a, b) => (LEVEL_RANK[a.impactLevel] ?? 9) - (LEVEL_RANK[b.impactLevel] ?? 9) || b.confidence - a.confidence)
    .slice(0, 4);
  const wording = (ch.data?.items ?? []).filter((x) => x.change_class === 'WORDING');
  const clauses = [...new Set(wording.map((x) => x.section_number).filter(Boolean))].sort(byClause);
  const r = 22, len = 2 * Math.PI * r;
  // a change has a date; a regulation opened from the "applies to you" cards has none
  const heading = c.date ? IMPACT_OF_CHANGE : IMPACT_ON_US;

  return (
    <>
      <header className="mb-2 flex items-center gap-2 px-1">
        <button type="button" onClick={onBack} className="group inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11.5px] font-semibold text-ink-2 transition hover:bg-slate-200 active:scale-95">
          <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />{t('Back')}
        </button>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold uppercase tracking-wide text-violet-600">{t(heading)}</span>
      </header>

      <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-1 pr-1.5">
        <div>
          <p className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-ink" title={c.title}>{c.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted">
            <span>{[c.regulator, ...(c.date ? [new Date(`${c.date}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }), ago(c.date)] : [])].filter(Boolean).join(' · ')}</span>
            <span className={cn('rounded-full px-1.5 py-px text-[10.5px] font-semibold', c.applies ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500')}>
              {t(c.applies ? 'Applies to you' : 'Does not apply to you')}
            </span>
          </p>
        </div>

        {im.isLoading && <p className="rounded-xl bg-slate-50 px-3 py-3 text-[12.5px] text-muted">{t('Reading the impact engine…')}</p>}
        {im.isError && <p className="rounded-xl bg-slate-50 px-3 py-3 text-[12.5px] text-muted">{t('The impact engine could not be reached.')}</p>}

        {g && (<>
          {/* how much it weighs, how far it reaches */}
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
            <span className="relative grid h-[52px] w-[52px] shrink-0 place-items-center">
              <svg viewBox="0 0 52 52" className="absolute inset-0 -rotate-90" aria-hidden="true">
                <circle cx="26" cy="26" r={r} fill="none" stroke="#e5e7eb" strokeWidth="5" />
                <circle cx="26" cy="26" r={r} fill="none" stroke={level?.hex ?? '#a1a1a6'} strokeWidth="5" strokeLinecap="round"
                        strokeDasharray={`${(Math.min(100, score) / 100) * len} ${len}`} className="rc-ring" style={{ '--len': len } as CSSProperties} />
              </svg>
              <b className="relative text-[13px] font-bold tabular-nums" style={{ color: level?.hex ?? '#8e8e93' }}>{score || '—'}</b>
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold', level?.cls ?? 'bg-slate-200 text-slate-600')}>{t(level?.label ?? NO_IMPACT)}</span>
              <span className="mt-1 block text-[12px] text-ink-2">
                {reach > 0 ? t('Reaches {n} of your records', { n: reach.toLocaleString() }) : t('Reaches none of your records yet')}
              </span>
            </span>
          </div>

          {domains.length > 0 && (
            <div className="space-y-1">
              {domains.slice(0, 5).map(([d, n], i) => (
                <div key={d} className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px]">
                  <span className="truncate capitalize text-ink-2">{t(DOMAIN_WORD[d] ?? d)}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <span className="rc-bar block h-full rounded-full bg-violet-500" style={{ width: `${(n / maxD) * 100}%`, '--d': `${250 + i * 70}ms` } as CSSProperties} />
                  </span>
                  <span className="w-6 text-right font-semibold tabular-nums text-ink">{n.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {nodes.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('Most affected')}</p>
              <ul className="space-y-1">
                {nodes.map((nd) => (
                  <li key={nd.id}>
                    <button type="button" onClick={() => openEntity(nd.entityId)}
                            className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_HEX[nd.impactLevel] ?? '#a1a1a6' }} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{nd.name}</span>
                      <span className="shrink-0 text-[10.5px] text-muted">{t(DOMAIN_WORD[nd.domain] ?? nd.domain)} · {t(nd.impactType)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {clauses.length > 0 && (
            <p className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="font-medium text-ink-2">{t('Clauses changed')}</span>
              {clauses.slice(0, 6).map((s) => <span key={s} className="rounded-md bg-violet-50 px-1.5 py-px font-mono text-[10.5px] font-semibold text-violet-700">{s}</span>)}
              {clauses.length > 6 && <span className="text-muted">{t('+{n} more', { n: (clauses.length - 6).toLocaleString() })}</span>}
            </p>
          )}
        </>)}
      </div>

      {/* on to the full picture */}
      <div className="mt-3 flex flex-wrap gap-2 px-1">
        <button type="button" onClick={() => navigate(`/cascade?view=graph&reg=${enc}`)} title={t('Open its impact graph in the Impact Cascade')}
                className="group inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_6px_14px_-6px_rgba(124,58,237,0.7)] transition hover:bg-violet-700 active:scale-95">
          <Network className="h-3.5 w-3.5" />{t('Impact graph')}<ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </button>
        <button type="button" onClick={() => navigate(`/cascade?reg=${enc}`)} title={t('See this regulation in the Impact Cascade')}
                className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-violet-50 px-3 py-1.5 text-[12px] font-semibold text-violet-700 transition hover:bg-violet-100 active:scale-95">
          <Workflow className="h-3.5 w-3.5" />{t('Impact Cascade')}
        </button>
      </div>
    </>
  );
}

interface TopReg { id: string; title: string; regulator_short: string; impact_level: string | null; impact_score: number | null }
/** a card's height plus the gap under it, in px — one step of the ticker */
const CARD_H = 84;
const STEP = CARD_H + 8;
const LEVEL_LOOK: Record<string, { label: string; icon: typeof Flame; pill: string; hex: string }> = {
  Critical: { label: tx('Critical'), icon: Flame, pill: 'bg-critical-500 text-white', hex: '#ff3b30' },
  High: { label: tx('High'), icon: AlertTriangle, pill: 'bg-notcov-500 text-white', hex: '#ff6a00' },
};
const TICK_MS = 3_200;

/**
 * The regulations that apply to us, weightiest first, as cards that rise one by
 * one — a copy of the first card closes the loop so it never jumps. Hovering or
 * focusing stops it; reduced motion gets a plain list. Each card's Impact button
 * turns the big card over to that regulation's impact.
 */
function AppliesTicker({ applicable, onImpact }: { applicable?: number; onImpact: (r: TopReg) => void }) {
  const t = useT();
  const q = useQuery<{ items: TopReg[] }>({
    queryKey: ['dash-applies-top'], staleTime: 300_000,
    // only what weighs: Critical and High, weightiest first
    queryFn: () => api('/api/regulations?page=1&size=10&applicability=APPLICABLE%2CCONDITIONAL&importance=Critical%2CHigh&sort=impact'),
  });
  // the filter is asked of the API and kept here too, so a card is never shown under the wrong badge
  const items = (q.data?.items ?? []).filter((r) => r.impact_level === 'Critical' || r.impact_level === 'High').slice(0, 10);
  const [i, setI] = useState(0);
  const [snap, setSnap] = useState(false);
  const [paused, setPaused] = useState(false);
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (reduce || paused || items.length < 2) return;
    const id = window.setInterval(() => setI((x) => x + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, [reduce, paused, items.length]);
  // having risen onto the copy of the first card, step back to the real one unseen
  useEffect(() => {
    if (!items.length || i !== items.length) return;
    const id = window.setTimeout(() => { setSnap(true); setI(0); }, 700);
    return () => window.clearTimeout(id);
  }, [i, items.length]);
  useEffect(() => {
    if (!snap) return;
    const id = window.requestAnimationFrame(() => window.requestAnimationFrame(() => setSnap(false)));
    return () => window.cancelAnimationFrame(id);
  }, [snap]);

  const card = (r: TopReg, k: number, copy: boolean) => {
    const c = regulatorColor(r.regulator_short);
    const look = LEVEL_LOOK[r.impact_level ?? ''] ?? LEVEL_LOOK.High;
    const LI = look.icon;
    const score = Math.min(100, Number(r.impact_score ?? 0));
    const rr = 15, len = 2 * Math.PI * rr;
    return (
      <li key={`${copy ? 'c' : 'r'}-${r.id}-${k}`} aria-hidden={copy || undefined}
          className="rc-tcard relative flex items-center gap-3 overflow-hidden rounded-xl border px-3"
          style={{ height: CARD_H, '--rc': look.hex } as CSSProperties}>
        {/* the score, as a ring in the level's colour */}
        <span className="relative grid h-[40px] w-[40px] shrink-0 place-items-center">
          <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90" aria-hidden="true">
            <circle cx="20" cy="20" r={rr} fill="none" stroke="color-mix(in srgb, var(--rc) 16%, white)" strokeWidth="4" />
            <circle cx="20" cy="20" r={rr} fill="none" stroke="var(--rc)" strokeWidth="4" strokeLinecap="round"
                    strokeDasharray={`${(score / 100) * len} ${len}`} />
          </svg>
          <b className="relative text-[12px] font-bold tabular-nums" style={{ color: look.hex }}>{score}</b>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide', look.pill)}>
              <LI className="h-2.5 w-2.5" />{t(look.label)}
            </span>
            <span className={cn('rounded-md px-1.5 py-px text-[10px] font-bold', c.tile)}>{r.regulator_short}</span>
          </span>
          <span className="mt-1 line-clamp-2 text-[12.5px] font-semibold leading-snug text-ink" title={r.title}>{r.title}</span>
        </span>
        <button type="button" onClick={() => onImpact(r)} tabIndex={copy ? -1 : undefined} title={t('See its impact on us')}
                className="group inline-flex shrink-0 items-center gap-1 self-center rounded-full bg-violet-600 px-2.5 py-1 text-[11.5px] font-semibold text-white shadow-[0_4px_10px_-4px_rgba(124,58,237,0.7)] transition hover:bg-violet-700 active:scale-95">
          <Network className="h-3.5 w-3.5 transition-transform group-hover:rotate-12" />{t('Impact')}
        </button>
      </li>
    );
  };

  const shownAt = items.length ? i % items.length : 0;
  return (
    <div className="mx-1">
      <p className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-success-600">
        <span className="h-1.5 w-1.5 rounded-full bg-success-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('Applies to you — no change yet')}</span>
      </p>
      {q.isLoading && <div className="animate-pulse rounded-xl bg-slate-100" style={{ height: CARD_H }} />}
      {!q.isLoading && items.length === 0 && (
        <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-[12.5px] text-ink-2">
          {applicable ? t('No change in the {n} regulations that apply to you', { n: applicable.toLocaleString() }) : t('No change in the regulations that apply to you')}
        </p>
      )}
      {items.length > 0 && (reduce ? (
        <ul className="max-h-[172px] space-y-2 overflow-y-auto">{items.map((r, k) => card(r, k, false))}</ul>
      ) : (<>
        <div className="relative overflow-hidden rounded-xl" style={{ height: CARD_H }}
             onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
             onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}>
          <ul className="space-y-2" style={{ transform: `translateY(-${i * STEP}px)`, transition: snap ? 'none' : 'transform 0.65s cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
            {items.map((r, k) => card(r, k, false))}
            {card(items[0], items.length, true)}
          </ul>
        </div>
        {/* where the ticker is, as dots */}
        <div className="mt-1.5 flex justify-center gap-1" aria-hidden="true">
          {items.map((r, k) => (
            <span key={r.id} className={cn('h-1 rounded-full transition-all duration-300', k === shownAt ? 'w-4 bg-violet-500' : 'w-1 bg-slate-300')} />
          ))}
        </div>
      </>))}
    </div>
  );
}
