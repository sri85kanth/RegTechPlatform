import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import {
  ArrowDownUp, ChevronDown, ChevronRight, Landmark, FileText, AlertTriangle,
  SlidersHorizontal, X, ExternalLink, Gauge, GitCompare, CheckCircle2, CircleCheck, MinusCircle,
  CircleHelp, UploadCloud,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { can, useMe } from '@/services/authApi';
import {
  useRegulations, useRegulationFacets, CHANGE_STATUS_LABEL,
  filtersToParams, paramsToFilters, EMPTY_FILTERS,
  isAppliesToUs, APPLIES_TO_US,
  type RegulationRow, type ChangeStatusCode, type RegulationFilters,
} from '@/services/regulationsApi';
import { RegulationFacetRail, AppliesToUsNote, AppliesToUsToggle, RegulationSearch } from './RegulationFacetRail';
import { RegulationsOverview } from './RegulationsOverview';
import {
  IMPORTANCE, IMPORTANCE_HEX,
  regulatorColor,
} from './RegulationFilters';
import { Pager } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import '@/components/ui/premium.css';
import './regulationsList.css';
import { tx, useT } from '@/i18n';

/**
 * Filters live in the URL, so a filtered library can be bookmarked, shared, and
 * survives back/forward and a refresh. sessionStorage is only a backstop for
 * arriving with no query string at all — returning here from the sidebar after
 * opening a regulation should not silently reset what was selected.
 */
const STORE_KEY = 'regulations.filters';

/**
 * Where a bare URL opens when nothing was saved: the hospital's own rules, not a
 * library that is mostly banking directions. An empty saved selection is different:
 * it means the reader turned the filters off and asked for the whole library.
 */
const OPENING_VIEW = filtersToParams({ ...EMPTY_FILTERS, applicability: APPLIES_TO_US }).toString();

/**
 * What the verdict means for the reader, in the fewest words that stay true.
 *
 * CONDITIONAL is the engine's ceiling today — it means entity type, jurisdiction
 * and regulator all match, with exemptions and thresholds unevaluated — so it is
 * shown as applying, qualified, rather than as a maybe. A row with no verdict
 * shows nothing: "no rule was extracted" is not "does not apply", and a grey
 * pill saying so on 2,500 rows would be noise.
 */
const APPLIES_LABEL: Record<string, string> = {
  APPLICABLE: tx('Applies to us'),
  CONDITIONAL: tx('Applies · conditional'),
  NOT_APPLICABLE: tx('Not applicable'),
  REVIEW_REQUIRED: tx('Needs review'),
};
const APPLIES_TONE: Record<string, string> = {
  APPLICABLE: 'bg-success-50 text-success-600',
  CONDITIONAL: 'bg-success-50 text-success-600',
  NOT_APPLICABLE: 'bg-slate-100 text-slate-600',
  REVIEW_REQUIRED: 'bg-indigo-50 text-indigo-700',
};
const APPLIES_ICON: Record<string, typeof CheckCircle2> = {
  APPLICABLE: CheckCircle2, CONDITIONAL: CircleCheck, NOT_APPLICABLE: MinusCircle, REVIEW_REQUIRED: CircleHelp,
};

/**
 * The regulatory library.
 *
 * Data path:  Frontend → FastAPI /api/regulations → PostgreSQL (company_brain)
 * There is no seed import, no static JSON and no fallback in this file.
 */
const PAGE = 25;


export function RegulationsListPage() {
  const t = useT();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const { data: me } = useMe();
  const [sp, setSp] = useSearchParams();
  const [page, setPage] = useState(() => Number(sp.get('page') || 1));
  // The rail is always on from lg up; this only drives the small-screen toggle.
  const [railOpen, setRailOpen] = useState(false);
  const filters = paramsToFilters(sp);

  // A bare URL restores the previous selection, or opens on OPENING_VIEW. It runs
  // on every bare arrival, because the sidebar link reaches this page without
  // remounting it, but not on back/forward: a bare history entry is a page the
  // reader chose, and redirecting away from it would trap the back button.
  const arrived = useRef(false);
  useEffect(() => {
    const arriving = !arrived.current;
    arrived.current = true;
    if (sp.toString() || (!arriving && navType === 'POP')) return;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(STORE_KEY);
    } catch {
      // Private mode: the reader's choice cannot be read back, so default only on
      // arrival, or turning the switch off would switch it straight back on.
      if (!arriving) return;
    }
    const next = saved ?? OPENING_VIEW;
    if (!next) return; // saved empty: the whole library, by choice
    const qs = new URLSearchParams(next);
    setPage(Number(qs.get('page') || 1));
    setSp(qs, { replace: true });
    try { sessionStorage.setItem(STORE_KEY, next); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  const apply = (next: RegulationFilters, nextPage = 1) => {
    const qs = filtersToParams(next);
    if (nextPage > 1) qs.set('page', String(nextPage));
    setPage(nextPage);
    setSp(qs);
    try { sessionStorage.setItem(STORE_KEY, qs.toString()); } catch { /* ignore */ }
  };

  const { data, isLoading, error } = useRegulations({ page, size: PAGE, ...filters });
  const { data: facets } = useRegulationFacets(filters);
  // Counted with the applicability filter lifted, so pressing the button does
  // not rewrite the numbers printed on the button.
  const { data: baseFacets } = useRegulationFacets({ ...filters, applicability: [] });
  // The whole library, for the "of {total} in the library" count line.
  const { data: lib } = useRegulationFacets();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const appliesOnly = isAppliesToUs(filters);
  const libTotal = lib?.total ?? 0;
  // the obligations bars are drawn against the heaviest regulation on this page
  const maxObligations = Math.max(1, ...items.map((r) => r.obligations ?? 0));

  return (
    <>
      <Topbar
        title="Regulations"
        subtitle="Every regulation in the library, and whether it applies to us"
        icon="Scale"
        tone={toneFor('reg-regulations')}
        hideSearch
        // the one filter most people want sits with the page's own actions, above
        // the filters and the search, so it reads as a choice of which library to see
        actions={(
          <>
            <AppliesToUsToggle filters={filters} setFilters={(f) => apply(f)} facets={facets} />
            {/* /ingestion, where the upload lives, is an administrators' page; anyone
                else would land on its "Administrator access required" notice */}
            {can(me, 'administer') && (
              <button type="button" className="btn btn-outline" onClick={() => navigate('/ingestion')}>
                <UploadCloud className="h-4 w-4" /> {t('Upload a regulation')}
              </button>
            )}
          </>
        )}
      />

      <div className="space-y-5 p-4 sm:p-6">
        {/* Rail left, results right. The rail is sticky because a filter you
            have to scroll back up to change is a filter you stop using. */}
        <div className="grid items-start gap-5 lg:grid-cols-[268px_minmax(0,1fr)]">
          {/* the left column runs the full height, so the card above scrolls away
              and the filters below it stay in reach */}
          <div className="min-w-0 space-y-4 lg:self-stretch">
            {/* what the list is made of: impact mix and who issues it — each part filters the list */}
            {data && <RegulationsOverview compact facets={facets} total={total} filters={filters} apply={(f) => apply(f)} />}
            <div className={cn('lg:sticky lg:top-20 lg:block', railOpen ? 'block' : 'hidden')}>
              <RegulationFacetRail
                filters={filters}
                setFilters={(f) => apply(f)}
                facets={facets}
                loading={isLoading}
              />
            </div>
          </div>

          <div className="min-w-0">
            <div className="liquid-glass sticky top-[72px] z-10 mb-3 flex items-center gap-2 rounded-2xl p-2 shadow-card">
              <button
                type="button"
                onClick={() => setRailOpen((o) => !o)}
                className="btn btn-sm h-9 shrink-0 gap-1.5 lg:hidden"
                aria-expanded={railOpen}
              >
                {railOpen ? <X className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
                {t('Filters')}
              </button>
              <div className="min-w-0 flex-1">
                <RegulationSearch value={filters.q} onChange={(q) => apply({ ...filters, q })} />
              </div>
            </div>

            {appliesOnly && <AppliesToUsNote facets={baseFacets} />}

        {isLoading && (
          <div className="card py-16 text-center text-[13px] text-muted">{t('Loading from the database…')}</div>
        )}

        {error && (
          <div className="card flex flex-col items-center gap-3 py-14 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-critical-50 text-critical-600">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="text-sm font-semibold text-ink">{t('Cannot reach the regulatory API')}</div>
            <p className="max-w-md text-[13px] text-muted">
              {String((error as Error).message)}. {t('Start it with')}{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                uvicorn regulatory_ingestion.api:app --port 8787
              </code>
            </p>
            <p className="text-xs text-muted">{t('No cached or sample regulations are shown — this screen has no fallback data.')}</p>
          </div>
        )}


        {data && (
          <section className="card overflow-hidden">
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
              <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
                <b className="text-[17px] font-semibold tracking-tight tabular-nums text-ink">{data ? total.toLocaleString() : '—'}</b>{' '}
                <span className="text-ink-2">{t(appliesOnly ? (total === 1 ? 'regulation applies to us' : 'regulations apply to us') : (total === 1 ? 'regulation' : 'regulations'))}</span>
                {/* on a laptop the line stays one row: the overview card and the rail already give the library total */}
                {lib && data && total !== libTotal && <span className="hidden 2xl:inline"> · {t('of {total} in the library', { total: libTotal.toLocaleString() })}</span>}
              </p>
              {/* Sorting by score alone left 29,000 unscored rows in the running,
                  sharing one NULL and landing wherever the tiebreak fell. This
                  asks the narrower question: what has the engine actually scored? */}
              <button
                onClick={() => apply({
                  ...filters,
                  has_impact: filters.has_impact ? '' : '1',
                  sort: filters.has_impact ? filters.sort : 'impact',
                })}
                aria-pressed={!!filters.has_impact}
                className={cn('pm-press inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium',
                  filters.has_impact
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-line-2 bg-white text-ink-2 hover:border-brand-300 hover:text-ink')}
              >
                <Gauge className="h-3.5 w-3.5" />
                {t('Scored for impact')}
                {facets?.scoredForImpact != null && <span className="tabular-nums text-muted">{facets.scoredForImpact.toLocaleString()}</span>}
              </button>
              <label className="relative inline-flex h-8 items-center rounded-full border border-line-2 bg-white pl-3 text-[12.5px] text-muted transition-colors hover:border-brand-300">
                <ArrowDownUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">{t('Sort')}</span>
                <select
                  value={filters.sort}
                  onChange={(e) => apply({ ...filters, sort: e.target.value })}
                  aria-label={t('Sort')}
                  className="h-full cursor-pointer appearance-none bg-transparent pr-8 font-medium text-ink-2 outline-none"
                >
                  <option value="created">{t('Recently added')}</option>
                  <option value="issued">{t('Issued date')}</option>
                  <option value="title">{t('Title')}</option>
                  <option value="impact">{t('Impact score')}</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5" aria-hidden="true" />
              </label>
            </header>
            {total === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-muted-2">
                  <FileText className="h-5 w-5" />
                </span>
                <div className="text-sm font-semibold text-ink">{t('No regulation matches these filters')}</div>
                <p className="max-w-md text-[13px] text-muted">
                  {t('Every filter is backed by a stored value, so a combination with no records returns nothing rather than something approximate. Clear a filter on the left to widen the search.')}
                </p>
              </div>
            )}
            {total > 0 && (<>
              {/* the columns, the way a register reads: what it is, how much it asks, how much it weighs */}
              <div className={cn(ROW_GRID, 'border-b border-line bg-slate-50/80 px-4 py-2.5 text-[12px] font-semibold text-ink-2')} aria-hidden="true">
                <span className="hidden text-center lg:block">#</span>
                <span>{t('Regulation')}</span>
                <span className="hidden text-right lg:block">{t('Obligations')}</span>
                <span className="hidden text-right 2xl:block">{t('Sections')}</span>
                <span className="hidden lg:block">{t('Impact')}</span>
                <span />
              </div>
              <ul key={`${page}-${sp.toString()}`} className="pm-stagger divide-y divide-line">
                {items.map((r, i) => <RegulationRowItem key={r.id} r={r} n={(page - 1) * PAGE + i + 1} showVerdict={!appliesOnly} maxObligations={maxObligations} />)}
              </ul>
              {pages > 1
                ? <Pager page={page} pages={pages} total={total} size={PAGE} onPage={(p) => apply(filters, p)} />
                : <div className="border-t border-line px-4 py-3 text-[13px] text-muted">{t('Showing all {n}', { n: total.toLocaleString() })}</div>}
            </>)}
          </section>
        )}

          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ one record */

/** The change statuses worth a pill on the card. */
const CHANGED: ChangeStatusCode[] = ['CHANGE_DETECTED', 'SOURCE_CHANGED_UNVERIFIED', 'AMENDMENT_MENTIONED'];

/** status → colour. A computed change is amber; a footnote mention is amber too, never red. */
const STATUS_TONE: Record<ChangeStatusCode, string> = {
  NOT_CHECKED: 'bg-slate-100 text-slate-600',
  INSUFFICIENT_HISTORY: 'bg-slate-100 text-slate-600',
  CHECKED_UNCHANGED: 'bg-success-50 text-success-600',
  CHANGE_DETECTED: 'bg-warning-50 text-warning-600',
  // The bytes moved but we could not read the new copy: a real signal, but not
  // a verified diff — amber, never the red reserved for a computed change.
  SOURCE_CHANGED_UNVERIFIED: 'bg-warning-50 text-warning-600',
  AMENDMENT_MENTIONED: 'bg-warning-50 text-warning-600',
};

/** The regulator as a coloured tile — its short name when it fits, a landmark when it does not. */
function RegulatorTile({ short }: { short: string }) {
  const c = regulatorColor(short);
  const text = (short || '').trim();
  return (
    <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', c.tile)} aria-hidden="true">
      {text && text.length <= 5
        ? <span className="text-[11px] font-extrabold tracking-tight">{text.toUpperCase()}</span>
        : <Landmark className="h-5 w-5" />}
    </span>
  );
}

/** one grid for the column heads and every row, so they line up */
// below 1536px (a laptop, the filter rail beside it) Sections gives way and Impact is the ring alone, so titles keep their room
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 lg:grid-cols-[32px_minmax(0,1fr)_76px_56px_44px] 2xl:grid-cols-[36px_minmax(0,1fr)_92px_80px_148px_52px]';

/**
 * The impact score as a ring that draws itself to the score, in the colour of
 * its level, with the number in the middle and the level beside it.
 */
function ScoreRing({ score, level }: { score: number; level: string | null }) {
  const t = useT();
  const lv = level && IMPORTANCE.includes(level) ? level : null;
  const hex = lv ? IMPORTANCE_HEX[lv] : '#94a3b8';
  const r = 15, len = 2 * Math.PI * r;
  return (
    <span className="flex items-center gap-2" title={`${t('Impact score computed by the impact engine (0–100)')}${lv ? ` · ${t(lv)}` : ''}`}>
      <span className="relative grid h-[38px] w-[38px] shrink-0 place-items-center">
        <svg viewBox="0 0 38 38" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="19" cy="19" r={r} fill="none" stroke="#f2f2f7" strokeWidth="4" />
          <circle cx="19" cy="19" r={r} fill="none" stroke={hex} strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={len} strokeDashoffset={len * (1 - Math.min(100, score) / 100)}
                  className="rg-ring" style={{ '--len': len } as CSSProperties} />
        </svg>
        <b className="relative text-[11.5px] font-bold tabular-nums" style={{ color: hex }}>{score}</b>
      </span>
      {lv && <span className="hidden text-[12px] font-semibold 2xl:inline" style={{ color: hex }}>{t(lv)}</span>}
    </span>
  );
}

function RegulationRowItem({ r, n, showVerdict, maxObligations }: { r: RegulationRow; n: number; showVerdict: boolean; maxObligations: number }) {
  const t = useT();
  const navigate = useNavigate();
  // Wording only. Renumbering would light up documents nobody amended.
  const moved = r.wording_changes ?? 0;
  const status = ((r as RegulationRow & { change_status?: ChangeStatusCode }).change_status ?? 'NOT_CHECKED') as ChangeStatusCode;
  // Not applicable to us: still listed, visibly receded.
  const notApplicable = r.applicability === 'NOT_APPLICABLE';
  const reg = regulatorColor(r.regulator_short);
  const open = () => navigate(`/regulation/${r.id}`);
  const obligations = r.obligations ?? 0;
  const sections = (r as RegulationRow & { sections?: number }).sections ?? 0;
  const scored = r.impact_score != null && Number(r.impact_score) > 0;
  const changed = CHANGED.includes(status);
  const verdict = showVerdict && r.applicability ? APPLIES_LABEL[r.applicability] : undefined;
  const VI = verdict ? APPLIES_ICON[r.applicability!] : null;

  return (
    <li role="link" tabIndex={0} onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
        // the impact colour is a quiet edge on every row (rg-row), full strength under the pointer
        className={cn(ROW_GRID, 'rg-row group cursor-pointer px-4 py-3 transition-[background-color,box-shadow] duration-200 hover:bg-brand-50/40 focus-visible:bg-brand-50/60 focus-visible:outline-none',
          notApplicable && 'opacity-75')}
        style={{ '--pm-accent': r.impact_level && IMPORTANCE_HEX[r.impact_level] ? IMPORTANCE_HEX[r.impact_level]
          : r.applicability === 'APPLICABLE' || r.applicability === 'CONDITIONAL' ? '#34c759' : 'transparent' } as CSSProperties}>
      <span className="hidden text-center text-[12px] tabular-nums text-muted lg:block">{n.toLocaleString()}</span>

      <div className="flex min-w-0 items-center gap-3">
        <RegulatorTile short={r.regulator_short} />
        <div className="min-w-0 flex-1">
          <p className={cn('line-clamp-2 text-[13.5px] font-semibold leading-snug tracking-tight transition-colors group-hover:text-brand-700',
            notApplicable ? 'text-ink-2' : 'text-ink')} title={r.title}>
            {r.title}
          </p>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted">
            <span className="font-semibold" style={{ color: reg.ink }}>{r.regulator_short}</span>
            {r.regulation_type && <><span aria-hidden="true">·</span><span className="truncate">{r.regulation_type}</span></>}
            {(r.ministry || r.sector) && <><span aria-hidden="true">·</span><span className="truncate">{r.ministry || r.sector}</span></>}
            {/* narrow screens have no number columns: say it here */}
            {obligations > 0 && <span className="lg:hidden">· {obligations === 1 ? t('1 obligation') : t('{n} obligations', { n: obligations.toLocaleString() })}</span>}
            {verdict && VI && (
              <span className={cn('ml-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-semibold', APPLIES_TONE[r.applicability!])}
                    title={t("This company's applicability verdict — open the regulation to read the reasoning")}>
                <VI className="h-3 w-3" aria-hidden="true" />{t(verdict)}
              </span>
            )}
            {/* only a change is news; "not checked" on every row would be noise */}
            {changed && (
              <span className={cn('ml-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-semibold', STATUS_TONE[status])}
                    title={moved ? (moved === 1 ? t('1 section reworded since the previous captured version') : t('{n} sections reworded since the previous captured version', { n: moved.toLocaleString() })) : undefined}>
                <GitCompare className="h-3 w-3" aria-hidden="true" />
                {moved ? (moved === 1 ? t('1 section changed') : t('{n} sections changed', { n: moved.toLocaleString() })) : t(CHANGE_STATUS_LABEL[status])}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* how much it asks: the number, and a bar against the heaviest on the page */}
      <span className="hidden text-right lg:block">
        <span className={cn('block text-[13px] font-semibold tabular-nums', obligations ? 'text-ink' : 'text-muted-2')}>{obligations ? obligations.toLocaleString() : '—'}</span>
        {obligations > 0 && (
          <span className="ml-auto mt-1 block h-1 w-full max-w-[64px] overflow-hidden rounded-full bg-slate-100">
            <span className="rg-grow ml-auto block h-full rounded-full bg-brand-400" style={{ width: `${Math.max(6, (obligations / maxObligations) * 100)}%`, transformOrigin: 'right', '--d': '200ms' } as CSSProperties} />
          </span>
        )}
      </span>
      <span className={cn('hidden text-right text-[13px] tabular-nums 2xl:block', sections ? 'text-ink-2' : 'text-muted-2')}>{sections ? sections.toLocaleString() : '—'}</span>
      {/* unscored rows say so plainly rather than a misleading "0/100" */}
      <span className="hidden lg:block">
        {scored ? <ScoreRing score={Number(r.impact_score)} level={r.impact_level} />
          : <span className="text-[12px] text-muted-2" title={t('Not scored')}><span className="hidden 2xl:inline">{t('Not scored')}</span><span className="2xl:hidden">—</span></span>}
      </span>

      <span className="flex items-center justify-end gap-0.5">
        {scored && <span className="mr-1 lg:hidden"><ScoreRing score={Number(r.impact_score)} level={null} /></span>}
        {r.source_url && (
          <a href={r.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
             title={t('Official source')} aria-label={t('Official source')}
             className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted opacity-0 transition hover:bg-black/[0.05] hover:text-brand-600 focus-visible:opacity-100 group-hover:opacity-100">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-2 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600" aria-hidden="true" />
      </span>
    </li>
  );
}

export default RegulationsListPage;
