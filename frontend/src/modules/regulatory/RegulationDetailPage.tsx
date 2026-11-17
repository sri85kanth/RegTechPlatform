import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ExternalLink, AlertCircle, CheckCircle2, ChevronDown, Info, MoreHorizontal, XCircle, HelpCircle,
  LayoutGrid, Target, Gauge, ScrollText, ListChecks, ShieldCheck, FileText, History, Scale, type LucideIcon,
} from 'lucide-react';
import { CountUp, useLiquidPill } from '@/components/ui/motion';
import './regDetail.css';
import { Topbar } from '@/layouts/Topbar';
import {
  useRegulation, useRegulationApplicability,
  useRegulationAmendments, useRegulationChanges, useRegulationDocuments,
  CHANGE_STATUS_LABEL, type ChangeStatusCode, type ApplicabilityCheck, type ApplicabilityStrength,
} from '@/services/regulationsApi';
import { DiffView } from '@/components/DiffView';
import { cn, readable } from '@/utils/ui';
import { MetricCard, EmptyState, Skeleton, Callout } from '@/components/ui/primitives';
import { ScoreRing, BarList, ColumnChart, Progress } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { tx, useDateLocale, useT } from '@/i18n';
import { ImpactTab } from './ImpactTab';
import { RequirementsTab } from './RequirementsTab';
import { useRegulationCompliance } from '@/services/complianceApi';
import { ObligationsTab } from './RegObligations';
import { ControlsTab } from './RegControls';
import { FullTextTab } from './RegFullText';
import {
  useRegOverview, REG_TABS, SUB_PARAMS, RISK_HEX, deptUi, Pill, Tile, fmtDay, parseDay, pctOf,
  type RegTab, type GoTab,
} from './regShared';

// Ordered as a compliance officer works: what is it → does it reach us → what
// must we do → how are we covered → what proves it. Source text and extraction
// provenance stay available but stop being the first thing on the page.
// Impact sits straight after Applicability: once a regulation is established to
// reach this company, the next question is how hard and what it lands on.
// (No Evidence tab: nothing links evidence to a regulation yet, and a tab that
// only explains that was a dead end. Requirements is the real table, with the
// gap-assessment verdict per requirement.)
// Tables now sit under Full Text, and Changes, Amendments and Provenance under
// Updates — the same content, grouped as the regulation's history.
const TABS = REG_TABS;
type Tab = RegTab;
/** URL slug for a tab: 'Full Text' → 'full-text'. Overview is the default and carries no param. */
const tabSlug = (t: Tab) => t.toLowerCase().replace(/\s+/g, '-');
const tabFromSlug = (s: string | null): Tab => TABS.find((t) => tabSlug(t) === s) ?? 'Overview';

type Reg = NonNullable<ReturnType<typeof useRegulation>['data']>;

/** Every field on this page comes from /api/regulations. Nothing is authored. */
export function RegulationDetailPage() {
  // `t` names a tab throughout this component, so the translate function is `tr`
  const tr = useT();
  const locale = useDateLocale();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // The active tab lives in ?tab= so a tab deep-links and survives a refresh.
  const [params, setParams] = useSearchParams();
  const askedTab = tabFromSlug(params.get('tab'));
  /** Switch tab; a selection handed to the next tab rides along as ?q= / ?ob= / ?doc= … */
  const go: GoTab = (t0, extra0) => {
    // Once a regulation is assessed, Obligations listed the same rows as Requirements: it opens Requirements instead.
    const merged = t0 === 'Obligations' && assessedRef.current;
    const t = merged ? 'Requirements' : t0;
    const extra = merged && extra0?.ob ? { q: extra0.ob } : extra0;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      SUB_PARAMS.forEach((k) => next.delete(k));
      if (t === 'Overview') next.delete('tab'); else next.set('tab', tabSlug(t));
      Object.entries(extra ?? {}).forEach(([k, v]) => next.set(k, v));
      return next;
    });
    if (extra) window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const setTab = (t: Tab) => go(t);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
  const { data: reg, isLoading, error } = useRegulation(id);
  const { data: ov } = useRegOverview(id ?? '');
  const appVerdict = useRegulationApplicability(id ?? '').data?.evaluation.verdict ?? null;
  const { data: amend } = useRegulationAmendments(id ?? '');
  const assessedRef = useRef(false);
  assessedRef.current = !!ov?.assessed;
  const tab: Tab = askedTab === 'Obligations' && ov?.assessed ? 'Requirements' : askedTab;

  if (isLoading) return <div className="p-8"><div className="card"><Skeleton rows={8} /></div></div>;

  if (error || !reg) {
    return (
      <div className="p-8">
        <div className="card mx-auto max-w-lg p-6 text-center">
          <AlertCircle className="mx-auto h-6 w-6 text-critical-600" />
          <h3 className="mt-3 text-sm font-semibold">{tr('Regulation not found in the database')}</h3>
          <p className="mt-1.5 text-[13px] text-muted">
            {tr('{id} is not present in the ingestion database, or the API is unavailable.', { id: id ?? '' })}
          </p>
          <button className="btn mt-4" onClick={() => navigate('/reg-regulations')}>{tr('Back to library')}</button>
        </div>
      </div>
    );
  }

  const p = reg.provenance ?? ({} as NonNullable<typeof reg.provenance>);
  const r = reg as Record<string, unknown>;
  const s = (k: string) => (r[k] == null || r[k] === '' ? null : String(r[k]));
  const sourceUrl = p.source_url ?? (r.official_document_url as string | undefined);
  const docUrl = (r.official_document_url as string | undefined) || p.document_url || p.source_url || undefined;
  const appliesKey = String(r.applicability ?? '').toUpperCase();
  const applies = APPLIES[appliesKey];
  // tab counts, each from the list that tab shows
  const updatesCount = (amend?.items?.length ?? 0) + (reg.changeStatus?.status === 'CHANGE_DETECTED' ? 1 : 0);
  const type = s('regulation_type');
  // The header's meta row: only fields the record actually holds.
  const meta = ([
    // Only a real version: falling back to the type duplicated the Type tag.
    { icon: 'FileText', label: 'Version', value: s('current_version') },
    { icon: 'Calendar', label: 'In force', value: s('effective_from') ? fmtDay(s('effective_from'), locale) : null },
    { icon: 'Landmark', label: 'Regulator', value: s('regulator_short') ?? s('regulator') },
    { icon: 'Globe', label: 'Jurisdiction', value: s('jurisdiction') },
    { icon: 'Tag', label: 'Sector', value: s('sector') },
    { icon: 'FileText', label: 'Type', value: type },
  ]).filter((m): m is { icon: string; label: string; value: string } => !!m.value);

  return (
    <>
      <Topbar
        title={reg.short_title ? String(reg.short_title) : reg.title}
        subtitle={reg.regulator}
        icon="Scale"
        tone="#4f46e5"
        onBack={() => navigate('/reg-regulations')}
        backLabel="Back to Regulations"
        titleExtra={applies && (
          <span className={cn('pill', applies[1])}>
            {appliesKey === 'APPLICABLE' ? <CheckCircle2 className="h-3.5 w-3.5" />
              : appliesKey === 'NOT_APPLICABLE' ? <XCircle className="h-3.5 w-3.5" />
                : <HelpCircle className="h-3.5 w-3.5" />}
            {tr(applies[0])}
          </span>
        )}
        meta={meta}
        actions={
          <>
            {sourceUrl && (
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn btn-outline">
                {tr('Open Source')} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <div className="relative">
              <button className="btn w-9 px-0" aria-label={tr('More actions')} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 top-10 z-40 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-pop">
                    {([
                      ['GitBranch', tx('Open impact cascade'), () => navigate(`/cascade?reg=${encodeURIComponent(reg.id)}`)],
                      ['Network', tx('Open impact graph'), () => navigate(`/regulation/${reg.id}/impact`)],
                      ['Search', tx('Search this regulation'), () => navigate('/knowledge')],
                    ] as const).map(([ic, l, fn]) => (
                      <button key={l} onClick={() => { setMenu(false); fn(); }}
                              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink-2 hover:bg-slate-50">
                        <Icon name={ic} className="h-4 w-4 text-muted" />{tr(l)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        }
        below={
          <RegTabBar tabs={TABS.filter((t) => !(t === 'Obligations' && ov?.assessed) && !(t === 'Updates' && updatesCount === 0 && tab !== 'Updates'))}
                     tab={tab} onTab={setTab} slug={tabSlug}
                     score={ov?.impact.score != null ? Math.round(Number(ov.impact.score)) : null} level={ov?.impact.level ?? null}
                     verdict={appVerdict} />
        }
      />

      <div key={tab} className="rd-tab-in p-4 sm:p-6" role="tabpanel" id="reg-tabpanel" aria-labelledby={`reg-tab-${tabSlug(tab)}`}>
        {tab === 'Overview' && <OverviewTab reg={reg} onTab={setTab} />}
        {tab === 'Applicability' && <ApplicabilityTab id={reg.id} />}
        {tab === 'Impact' && <ImpactTab id={reg.id} go={go} />}
        {tab === 'Obligations' && <ObligationsTab id={reg.id} go={go} />}
        {tab === 'Requirements' && <RequirementsTab id={reg.id} go={go} />}
        {tab === 'Controls' && <ControlsTab id={reg.id} go={go} />}
        {tab === 'Full Text' && <FullTextTab id={reg.id} go={go} sourceUrl={docUrl} lastUpdated={s('last_updated') ?? s('updated_at')} />}
        {tab === 'Updates' && <UpdatesTab reg={reg} />}
      </div>
    </>
  );
}

/* ---------------- the tab bar ---------------- */

/** each tab's icon and what it holds, said once under the bar */
const TAB_UI: Record<string, [LucideIcon, string]> = {
  Overview: [LayoutGrid, tx('The regulation in brief: what it is, whether it applies, and where we stand.')],
  Applicability: [Target, tx('Whether it applies to the hospital, and every check behind that answer.')],
  Impact: [Gauge, tx('How much it affects the hospital, and which records it touches.')],
  Obligations: [ScrollText, tx('The duties it places, as written in the text.')],
  Requirements: [ListChecks, tx('Each requirement, and whether our documents meet it.')],
  Controls: [ShieldCheck, tx('The controls that answer its requirements.')],
  'Full Text': [FileText, tx('The regulation itself, section by section.')],
  Updates: [History, tx('Amendments and changes found in the source.')],
};
const VERDICT_DOT: Record<string, [string, string]> = {
  APPLICABLE: ['#34c759', tx('Applies to us')], CONDITIONAL: ['#ff9f0a', tx('Conditionally applies')],
  REVIEW_REQUIRED: ['#ff9f0a', tx('Review required')], NOT_APPLICABLE: ['#a1a1a6', tx('Not applicable')],
};

/**
 * The regulation's sections as tabs that say something before they are
 * opened: an icon, Impact's score in its level's colour and Applicability's
 * verdict as a dot. A pill slides to the open tab,
 * and a line under the bar says what that tab holds.
 */
function RegTabBar({ tabs, tab, onTab, slug, score, level, verdict }: {
  tabs: readonly Tab[]; tab: Tab; onTab: (t: Tab) => void; slug: (t: Tab) => string;
  score: number | null; level: string | null; verdict: string | null;
}) {
  const tr = useT();
  const box = useRef<HTMLDivElement>(null);
  const pill = useLiquidPill(box, '[aria-selected="true"]', 'x', [tab, tabs.length]);
  const lv = level ? level.charAt(0).toUpperCase() + level.slice(1).toLowerCase() : null;
  const lvHex = lv ? RISK_HEX[lv] ?? '#64748b' : '#94a3b8';
  return (
    <div className="pb-2.5">
      <div ref={box} role="tablist" aria-label={tr('Regulation sections')}
           className="relative flex gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span aria-hidden="true" className="liquid-pill top-1 bottom-1 rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.07)]" style={pill} />
        {tabs.map((t) => {
          const on = t === tab;
          const [I] = TAB_UI[t] ?? [FileText, ''];
          const dot = t === 'Applicability' && verdict ? VERDICT_DOT[verdict] : null;
          return (
            <button key={t} role="tab" aria-selected={on} id={`reg-tab-${slug(t)}`} aria-controls="reg-tabpanel" onClick={() => onTab(t)}
                    title={tr(TAB_UI[t]?.[1] ?? t)}
                    className={cn('relative z-[1] flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors',
                      on ? 'text-brand-700' : 'text-ink-2 hover:bg-white/60 hover:text-ink')}>
              <I className={cn('h-4 w-4 transition-colors', on ? 'text-brand-600' : 'text-muted')} />
              {tr(t)}
              {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot[0] }} title={tr(dot[1])} />}
              {t === 'Impact' && score != null && (
                <span className="rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums text-white" style={{ background: lvHex }} title={lv ? tr('{level} impact', { level: tr(lv) }) : undefined}>{score}</span>
              )}
            </button>
          );
        })}
      </div>
      {TAB_UI[tab] && <p key={tab} className="animate-fade mt-2 px-1 text-[12.5px] text-muted">{tr(TAB_UI[tab][1])}</p>}
    </div>
  );
}

/* ---------------- header pill ---------------- */
const APPLIES: Record<string, [string, string]> = {
  APPLICABLE: [tx('Applies to us'), 'bg-success-100 text-success-700'],
  CONDITIONAL: [tx('Conditionally applies'), 'bg-warning-100 text-warning-700'],
  REVIEW_REQUIRED: [tx('Review required'), 'bg-warning-100 text-warning-700'],
  NOT_APPLICABLE: [tx('Not applicable'), 'bg-slate-100 text-slate-600'],
};

/* ---------------- status pill ---------------- */
function StatusPill({ status }: { status: ChangeStatusCode }) {
  const t = useT();
  const cls: Record<ChangeStatusCode, string> = {
    // Amber, matching the library list: a detected change needs review, it is not a gap.
    CHANGE_DETECTED: 'bg-warning-50 text-warning-600',
    SOURCE_CHANGED_UNVERIFIED: 'bg-warning-50 text-warning-600',
    AMENDMENT_MENTIONED: 'bg-warning-50 text-warning-600',
    CHECKED_UNCHANGED: 'bg-success-50 text-success-600',
    INSUFFICIENT_HISTORY: 'bg-slate-100 text-slate-600',
    NOT_CHECKED: 'bg-slate-100 text-slate-600',
  };
  return <span className={cn('pill', cls[status])}>{t(CHANGE_STATUS_LABEL[status])}</span>;
}

/* ================= verdict vocabulary ================= */

const VERDICT_UI: Record<string, { tile: string; text: string; bg: string; icon: string; label: string }> = {
  APPLICABLE:      { tile: 'bg-success-500 text-white', text: 'text-success-700', bg: 'bg-success-50', icon: 'CheckCircle2', label: 'Applicable' },
  NOT_APPLICABLE:  { tile: 'bg-slate-400 text-white', text: 'text-slate-700', bg: 'bg-slate-50', icon: 'XCircle', label: 'Not applicable' },
  // Amber, not green: it reaches companies of this kind, but conditions that
  // could exclude this one were never evaluated.
  CONDITIONAL:     { tile: 'bg-warning-500 text-white', text: 'text-warning-700', bg: 'bg-warning-50', icon: 'CircleAlert', label: 'Conditionally applicable' },
  REVIEW_REQUIRED: { tile: 'bg-warning-500 text-white', text: 'text-warning-700', bg: 'bg-warning-50', icon: 'CircleAlert', label: 'Review required' },
};

const CHECK_UI: Record<string, { Icon: typeof CheckCircle2; cls: string; row: string; label: string; short: string }> = {
  MATCH:    { Icon: CheckCircle2, cls: 'text-success-600', row: 'bg-success-50/70 border-success-100', label: 'Matches', short: tx('Yes') },
  NO_MATCH: { Icon: XCircle,      cls: 'text-critical-600', row: 'bg-critical-50/70 border-critical-100', label: 'Does not match', short: tx('No') },
  UNKNOWN:  { Icon: HelpCircle,   cls: 'text-warning-600', row: 'bg-warning-50/70 border-warning-100', label: 'Not confirmed', short: tx('Not confirmed') },
};
const checkUi = (r: string) => CHECK_UI[r] ?? CHECK_UI.UNKNOWN;

/** heaviest first: the check that decides most is the one to read, and to confirm, first */
const byWeight = (a: ApplicabilityCheck, b: ApplicabilityCheck) => (b.weight ?? 0) - (a.weight ?? 0);
const TIER_LABEL = { gate: tx('Deciding'), support: tx('Supporting') } as const;
const EVIDENCE = { have: '#34c759', open: '#ffdf99', against: '#ff3b30', none: '#e5e7eb' } as const;
const fmtPts = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * What each check is worth. The seven checks are not equal: the Entity type
 * decides, a Sector tick only adds confidence. So each one is a bar as long as
 * its weight, filled as far as it was actually established, and the two kinds
 * are kept apart: a deciding check can rule the regulation out on its own, a
 * supporting one never decides anything. Every bar is on one scale, in one
 * column, so their lengths can be compared.
 */
function CheckWeights({ checks, strength }: { checks: ApplicabilityCheck[]; strength: ApplicabilityStrength }) {
  const t = useT();
  const max = Math.max(1, ...checks.map((c) => c.weight ?? 0));
  const notRun = new Set(strength.notChecked);
  const gates = checks.filter((c) => c.tier === 'gate').sort(byWeight);
  const support = checks.filter((c) => c.tier === 'support').sort(byWeight);
  const order = [...gates, ...support];
  const row = (c: ApplicabilityCheck) => {
    const w = c.weight ?? 0;
    const got = c.result === 'MATCH' ? c.counts ?? w : 0;
    const rest = c.result === 'NO_MATCH' ? EVIDENCE.against : notRun.has(c.name) ? EVIDENCE.none : EVIDENCE.open;
    const cu = checkUi(c.result);
    return (
      <li key={c.name} className="rounded-lg py-1">
        <div className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_4rem] items-center gap-3 text-[12.5px]">
          <span className="flex min-w-0 items-center gap-1.5">
            <cu.Icon className={cn('h-3.5 w-3.5 shrink-0', cu.cls)} aria-label={t(cu.label)} />
            <span className="truncate font-medium text-ink">{c.name}</span>
          </span>
          <span className="block h-2.5" title={notRun.has(c.name) ? t('Not checked yet') : t(cu.label)}>
            <span className="rd-grow flex h-full overflow-hidden rounded-full"
                  style={{ width: `${(w / max) * 100}%`, background: rest, '--d': `${order.indexOf(c) * 70}ms` } as React.CSSProperties}>
              {got > 0 && <span className="h-full rounded-full" style={{ width: `${(got / w) * 100}%`, background: EVIDENCE.have }} />}
            </span>
          </span>
          <span className="text-right tabular-nums text-muted">
            <b className={cn('font-semibold', got > 0 ? 'text-ink' : c.result === 'NO_MATCH' ? 'text-critical-600' : 'text-muted')}>{fmtPts(got)}</b> / {w}
          </span>
        </div>
        {c.weightNote && <p className="mt-0.5 pl-5 text-[11.5px] leading-snug text-warning-700">{c.weightNote}</p>}
      </li>
    );
  };
  const parts = [
    { k: 'have', n: strength.confirmed, hex: EVIDENCE.have, label: t('{n} confirmed', { n: fmtPts(strength.confirmed) }) },
    { k: 'open', n: strength.open, hex: EVIDENCE.open, label: t('{n} to confirm', { n: fmtPts(strength.open) }) },
    { k: 'against', n: strength.against, hex: EVIDENCE.against, label: t('{n} against', { n: fmtPts(strength.against) }) },
  ].filter((p) => p.n > 0);
  const group = (label: string, list: ApplicabilityCheck[]) => list.length > 0 && (
    <div>
      <p className="mb-0.5 text-[11.5px] font-semibold text-ink-2">{label}</p>
      <ul>{list.map(row)}</ul>
    </div>
  );

  return (
    <section className="px-5 pt-4">
      <h4 className="sec-eyebrow mb-1 flex items-center gap-1.5"><Scale className="h-3.5 w-3.5 text-brand-600" />{t('What each check is worth')}</h4>
      <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-muted">{t('The verdict is never a sum: any one deciding check that fails rules the regulation out on its own.')}</p>
      <div className="grid gap-x-10 gap-y-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {group(t('Deciding checks — any one can rule it out'), gates)}
          {group(t('Supporting checks — add confidence, never decide'), support)}
        </div>
        <div className="self-start rounded-2xl bg-slate-50 px-4 py-3.5">
          <p className="text-[12.5px] font-semibold text-ink">{t('Evidence that it reaches us')}</p>
          <p className="mt-0.5 text-[26px] font-bold leading-none tabular-nums text-ink">{fmtPts(strength.confirmed)}<span className="text-[13px] font-semibold text-muted"> / {fmtPts(strength.total)}</span></p>
          <div className="mt-3 flex h-3 gap-0.5">
            {parts.map((p, j) => (
              <span key={p.k} className="rd-grow h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${(p.n / (strength.total || 100)) * 100}%`, background: p.hex, '--d': `${j * 120}ms` } as React.CSSProperties} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
            {parts.map((p) => <li key={p.k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: p.hex }} />{p.label}</li>)}
          </ul>
          {strength.notChecked.length > 0 && (
            <p className="mt-2.5 border-t border-line pt-2.5 text-[12px] leading-snug text-muted">{t('Not checked yet: {list}', { list: strength.notChecked.join(', ') })}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The applicability verdict, with its reasoning always visible.
 *
 * The verdict is never shown on its own. A compliance officer has to defend the
 * answer to an auditor, so every check that produced it — what was compared and
 * what was found — sits directly beneath it, and the checks that could NOT be
 * evaluated are shown just as prominently as the ones that passed.
 */
function VerdictCard({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading, error } = useRegulationApplicability(id);
  if (isLoading) return <div className="card"><Skeleton rows={4} /></div>;
  if (error || !data) {
    return <div className="card p-5 text-[13px] text-muted">{t('Applicability could not be assessed — the API is unavailable.')}</div>;
  }
  const e = data.evaluation;
  const ui = VERDICT_UI[e.verdict] ?? VERDICT_UI.REVIEW_REQUIRED;
  const company = e.company as { legalName?: string; entityType?: string; jurisdictions?: string[] };
  // the checks still open come first: they are what a person has to do
  const open = e.checks.filter((c) => c.result !== 'MATCH').sort(byWeight);
  const matched = e.checks.filter((c) => c.result === 'MATCH').sort(byWeight);
  const st = e.strength;
  const clause = (c: (typeof e.checks)[number]) => c.clauseText ? (
    <details className="group/cl mt-1">
      <summary className="rd-link cursor-pointer list-none text-[12px] [&::-webkit-details-marker]:hidden">
        {c.quoted ? t('Read the clause naming “{quoted}”', { quoted: c.quoted }) : t('Read the clause')}<i aria-hidden="true" className="transition-transform group-open/cl:rotate-90">›</i>
      </summary>
      <blockquote className="pm-open mt-1.5 rounded-lg border-l-2 border-brand-300 bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-muted">{c.clauseText}</blockquote>
    </details>
  ) : null;

  return (
    <div className="card rd-rise overflow-hidden">
      <div className={cn('flex flex-wrap items-center gap-4 px-5 py-4', ui.bg)}>
        <span className={cn('rd-pop grid h-12 w-12 shrink-0 place-items-center rounded-2xl shadow-sm', ui.tile)}><Icon name={ui.icon} className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-lg font-bold', ui.text)}>{t(ui.label)}</div>
          <div className="truncate text-[13px] text-ink-2">
            {company.legalName ?? t('No company profile')}
            {company.entityType && <> · {company.entityType}</>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-[13px] font-semibold text-ink">
              {st ? t('Evidence {n} of 100', { n: fmtPts(st.confirmed) }) : t('{n} of {total} checks match', { n: e.matched, total: e.checks.length })}
            </p>
            <span className={cn('rd-pop pill mt-1', e.confidence === 'High' ? 'bg-success-100 text-success-700' : e.confidence === 'Medium' ? 'bg-warning-100 text-warning-700' : 'bg-slate-100 text-slate-600')}
                  style={{ '--d': '150ms' } as React.CSSProperties}>
              {t('{level} confidence', { level: t(e.confidence) })}
            </span>
          </div>
          {st
            ? <MiniRing part={st.confirmed} whole={st.total || 100} hex="#34c759" size={64} label={fmtPts(st.confirmed)} />
            : <MiniRing part={e.matched} whole={e.checks.length} hex="#34c759" size={64} label={`${e.matched}/${e.checks.length}`} />}
        </div>
      </div>

      <p className="max-w-3xl px-5 pt-4 text-[13px] leading-relaxed text-ink-2">{e.why}</p>

      {st && <CheckWeights checks={e.checks} strength={st} />}

      {open.length > 0 && (
        <section className="px-5 pt-4">
          <h4 className="sec-eyebrow mb-2 flex items-center gap-1.5"><HelpCircle className="h-3.5 w-3.5 text-warning-600" />{t('To confirm')}</h4>
          <ul className="grid gap-2.5 lg:grid-cols-2">
            {open.map((c, i) => {
              const cu = checkUi(c.result);
              return (
                <li key={c.name} className={cn('rd-rise rd-card group flex gap-3 rounded-2xl border px-4 py-3.5 text-[13px]', cu.row)} style={{ '--d': `${120 + i * 90}ms` } as React.CSSProperties}>
                  <span className="rd-pulse grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white" style={{ '--c': c.result === 'NO_MATCH' ? '#ff3b30' : '#ff9f0a' } as React.CSSProperties}>
                    <cu.Icon className={cn('h-[18px] w-[18px]', cu.cls)} aria-label={t(cu.label)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{c.name}</span>
                      <span className={cn('rounded-full bg-white px-2 py-px text-[11px] font-semibold', cu.cls)}>{t(cu.label)}</span>
                      {c.tier && <span className="rounded-full px-2 py-px text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">{t(TIER_LABEL[c.tier])}</span>}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-snug text-ink-2">{c.detail}</span>
                    {clause(c)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {matched.length > 0 && (
        <section className="px-5 pb-5 pt-4">
          <h4 className="sec-eyebrow mb-2 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success-600" />{t('Checks that match')}</h4>
          {/* a stepper: each passed check joined to the next by a line that draws down */}
          <ul className="rd-steps space-y-1.5">
            {matched.map((c, i) => (
              <li key={c.name} className="rd-rise rd-row relative flex gap-3 rounded-xl py-2 pl-0 pr-3 text-[13px]" style={{ '--d': `${200 + i * 80}ms` } as React.CSSProperties}>
                <span className="rd-pop relative z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white shadow-[0_0_0_2px_#d9f5e1]" style={{ '--d': `${260 + i * 80}ms` } as React.CSSProperties}>
                  <CheckCircle2 className="h-[18px] w-[18px] text-success-600" aria-label={t('Matches')} />
                </span>
                <span className="min-w-0 flex-1 pt-1">
                  <span className="font-semibold text-ink">{c.name}</span>
                  {c.sourceClause && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{c.sourceClause}</span>}
                  <span className="block text-[12.5px] leading-snug text-muted">{c.detail}</span>
                  {clause(c)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ================= overview ================= */

/** a card's heading: its icon on a tinted tile, the title, and an action on the right */
function CardHead({ icon, hex, title, action }: { icon: string; hex: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex items-center gap-2.5">
      <span className="rd-ic grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in srgb, ${hex} 13%, white)`, color: hex }}>
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
      {action}
    </div>
  );
}
function GoLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="rd-link shrink-0">{children}<i aria-hidden="true">→</i></button>;
}
/** a small ring: part of a whole, drawn in */
function MiniRing({ part, whole, hex, size = 56, label }: { part: number; whole: number; hex: string; size?: number; label: React.ReactNode }) {
  const th = 6, r = (size - th) / 2, len = 2 * Math.PI * r;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f2f2f7" strokeWidth={th} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hex} strokeWidth={th} strokeLinecap="round"
                strokeDasharray={`${whole ? (part / whole) * len : 0} ${len}`} className="rd-ring" style={{ '--len': len } as React.CSSProperties} />
      </svg>
      <span className="relative text-[12px] font-bold tabular-nums text-ink">{label}</span>
    </span>
  );
}

const NOT_YET_HEX = '#cbd5e1';
/** requirement verdicts: [key, label, colour, icon] */
const STAND: [string, string, string, string][] = [
  ['met', tx('Documented'), '#34c759', 'CheckCircle2'], ['partial', tx('Partial'), '#ff9f0a', 'AlertTriangle'],
  ['gap', tx('Gaps'), '#ff3b30', 'XCircle'], ['not_covered', tx('Not covered'), '#ff6a00', 'FileWarning'],
];

function OverviewTab({ reg, onTab }: { reg: Reg; onTab: (t: Tab) => void }) {
  // `t` below is the totals object, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const { data: ov, isLoading } = useRegOverview(reg.id);
  const { data: app } = useRegulationApplicability(reg.id);
  const { data: comp } = useRegulationCompliance(reg.id);
  const [more, setMore] = useState(false);
  const t = ov?.totals;
  const reqTotal = ov ? (ov.assessed ? t?.applicable ?? 0 : ov.counts?.obligations ?? 0) : 0;
  const verdict = app?.evaluation.verdict;
  const checks = app?.evaluation.checks ?? [];
  const passed = checks.filter((c) => c.result === 'MATCH');
  const open = checks.filter((c) => c.result !== 'MATCH').sort(byWeight);
  const st = app?.evaluation.strength;
  // One scale everywhere: out of 100, as the library, the Impact tab and the cascade show it.
  const score = ov?.impact.score != null ? Math.round(Number(ov.impact.score)) : null;
  const level = ov?.impact.level ? ov.impact.level.charAt(0).toUpperCase() + ov.impact.level.slice(1).toLowerCase() : null;
  const levelHex = level ? RISK_HEX[level] ?? '#64748b' : '#94a3b8';
  const vui = verdict ? VERDICT_UI[verdict] ?? VERDICT_UI.REVIEW_REQUIRED : null;
  const unmet = (t?.partial ?? 0) + (t?.gap ?? 0) + (t?.not_covered ?? 0);
  const backed = comp?.summary;
  const n = (k: string) => Number((t as Record<string, unknown> | undefined)?.[k] ?? 0);

  if (isLoading) return <div className="card"><Skeleton rows={8} /></div>;

  // the donut: each verdict's arc, one after another
  const R = 46, LEN = 2 * Math.PI * R;
  let at = 0;
  // owed but not yet checked: a grey arc of its own, and kept out of the tiles' percentages
  const notYet = n('not_assessed');
  const checkedTotal = Math.max(0, reqTotal - notYet);
  const arcs = [...STAND, ['not_assessed', '', NOT_YET_HEX, ''] as const].map(([k, , hex]) => {
    const part = reqTotal ? (n(k) / reqTotal) * LEN : 0; const a = { k, hex, part, at }; at += part; return a;
  });

  return (
    <div className="space-y-4">
      {/* the three questions anyone opening a regulation asks, answered side by side */}
      <section className="card rd-rise grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="group p-5 transition-colors hover:bg-slate-50/50">
          <CardHead icon="BookOpen" hex="#0071e3" title={tr('What is it?')} />
          <p className={cn('text-[13.5px] leading-relaxed text-ink-2', !more && 'line-clamp-4')}>{ov?.about}</p>
          {(ov?.about?.length ?? 0) > 280 && (
            <button onClick={() => setMore((m) => !m)} className="rd-link mt-1.5">{tr(more ? 'Show less' : 'Read more')}<i aria-hidden="true">{more ? '↑' : '↓'}</i></button>
          )}
        </div>

        <div className="group border-t border-line p-5 transition-colors hover:bg-slate-50/50 lg:border-l lg:border-t-0">
          <CardHead icon="Target" hex="#34c759" title={tr('Does it apply to us?')} />
          {vui ? (
            <div className="flex items-center gap-3">
              <span className={cn('rd-pop grid h-11 w-11 shrink-0 place-items-center rounded-2xl', vui.tile)}><Icon name={vui.icon} className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-[15px] font-bold leading-tight', vui.text)}>{tr(vui.label)}</p>
                {checks.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted">
                    {st ? tr('Evidence {n} of 100', { n: fmtPts(st.confirmed) }) : tr('{n} of {total} checks match', { n: passed.length, total: checks.length })}
                  </p>
                )}
              </div>
              {checks.length > 0 && (st
                ? <MiniRing part={st.confirmed} whole={st.total || 100} hex="#34c759" label={fmtPts(st.confirmed)} />
                : <MiniRing part={passed.length} whole={checks.length} hex="#34c759" label={`${passed.length}/${checks.length}`} />)}
            </div>
          ) : <p className="text-[13px] text-muted">{tr('Not assessed yet')}</p>}
          {open.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] font-semibold text-warning-700">{tr('To confirm')}:</span>
              {open.map((c, i) => (
                <span key={c.name} className="rd-pop inline-flex items-center gap-1 rounded-full bg-warning-50 px-2 py-0.5 text-[11.5px] font-semibold text-warning-700 ring-1 ring-inset ring-warning-200"
                      style={{ '--d': `${200 + i * 80}ms` } as React.CSSProperties}>
                  <HelpCircle className="h-3 w-3" />{c.name}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3"><GoLink onClick={() => onTab('Applicability')}>{tr('See why')}</GoLink></div>
        </div>

        <div className="group border-t border-line p-5 transition-colors hover:bg-slate-50/50 lg:border-l lg:border-t-0">
          <CardHead icon="Gauge" hex="#ff6a00" title={tr('How much does it affect us?')} />
          <div className="flex items-center gap-4">
            <ScoreRing value={score ?? 0} max={100} size={88} thickness={9} invert label={score != null ? String(score) : '—'} sub={tr('of 100')} />
            <div className="min-w-0">
              {level
                ? <p className="rd-pop text-[15px] font-bold leading-tight" style={{ color: levelHex }}>{tr('{level} impact', { level: tr(level) })}</p>
                : <p className="text-[13px] text-muted">{tr('Not scored')}</p>}
              {ov?.assessed && unmet > 0 && <p className="mt-0.5 text-xs text-muted">{tr('{n} unmet', { n: unmet.toLocaleString() })}</p>}
            </div>
          </div>
          <div className="mt-3"><GoLink onClick={() => onTab('Impact')}>{tr('What drives this score')}</GoLink></div>
        </div>
      </section>

      {/* where we stand on its requirements: a donut, a tile per verdict, and how far they are backed */}
      {reqTotal > 0 && (
        <section className="card rd-rise p-5" style={{ '--d': '80ms' } as React.CSSProperties}>
          <CardHead icon="ClipboardCheck" hex="#0071e3" title={tr('Where we stand')}
                    action={<GoLink onClick={() => onTab('Requirements')}>{reqTotal === 1 ? tr('1 requirement') : tr('{n} requirements', { n: reqTotal.toLocaleString() })}</GoLink>} />
          {ov?.assessed && t ? (<>
            <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[132px_minmax(0,1fr)]">
              <span className="relative mx-auto grid h-[120px] w-[120px] place-items-center">
                <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90" aria-hidden="true">
                  <circle cx="60" cy="60" r={R} fill="none" stroke="#f2f2f7" strokeWidth="13" />
                  {arcs.filter((a) => a.part > 0).map((a, i) => (
                    <circle key={a.k} cx="60" cy="60" r={R} fill="none" stroke={a.hex} strokeWidth="13"
                            strokeDasharray={`${Math.max(0, a.part - 1.5)} ${LEN}`} strokeDashoffset={-a.at}
                            className="rd-ring" style={{ '--len': LEN, '--d': `${i * 120}ms` } as React.CSSProperties} />
                  ))}
                </svg>
                <span className="relative text-center leading-none">
                  <CountUp value={reqTotal} className="num block text-[24px] font-bold text-ink" />
                  <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">{tr('Requirements')}</span>
                </span>
              </span>
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                {STAND.map(([k, l, hex, icon], i) => {
                  const v = n(k);
                  const p = pctOf(v, checkedTotal);
                  return (
                    <button key={k} onClick={() => onTab('Requirements')} style={{ '--d': `${120 + i * 70}ms` } as React.CSSProperties}
                            className="rd-rise rd-card group rounded-2xl border border-line bg-white p-3 text-left">
                      <span className="flex items-center justify-between">
                        <span className="rd-ic grid h-7 w-7 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${hex} 14%, white)`, color: hex }}><Icon name={icon} className="h-3.5 w-3.5" /></span>
                        <span className="rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums" style={{ background: `color-mix(in srgb, ${hex} 11%, white)`, color: `color-mix(in srgb, ${hex} 80%, black)` }}>{p}%</span>
                      </span>
                      <CountUp value={v} className="num mt-2 block text-[22px] font-bold leading-none tracking-tight text-ink" />
                      <span className="mt-1 block text-[12.5px] font-medium text-ink-2">{tr(l)}</span>
                      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-100"><span className="rd-grow block h-full rounded-full" style={{ width: `${Math.max(v ? 3 : 0, p)}%`, background: hex }} /></span>
                    </button>
                  );
                })}
              </div>
            </div>
            {notYet > 0 && (
              <button type="button" onClick={() => onTab('Requirements')}
                      className="rd-rise mt-3 flex w-full items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-slate-100">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: NOT_YET_HEX }} />
                <b className="tabular-nums text-ink">{notYet.toLocaleString()}</b>
                <span className="min-w-0 flex-1 truncate">{tr('not yet assessed: owed by us, not yet checked against our documents')}</span>
                <i aria-hidden="true" className="text-muted">→</i>
              </button>
            )}
            {/* how far the requirements are backed: by a control, by evidence */}
            {backed && backed.requirements > 0 && (
              <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                {([[tx('With a control'), backed.withControl, '#34c759', 'ShieldCheck'], [tx('With evidence'), backed.withEvidence, '#30b0c7', 'Paperclip']] as const).map(([l, v, hex, icon], i) => {
                  const p = pctOf(v, backed.requirements);
                  return (
                    <div key={l} className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in srgb, ${hex} 13%, white)`, color: hex }}><Icon name={icon} className="h-4 w-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                          <span className="font-medium text-ink-2">{tr(l)}</span>
                          <span className="tabular-nums text-muted"><b className="font-semibold text-ink">{p}%</b> · {v.toLocaleString()} / {backed.requirements.toLocaleString()}</span>
                        </div>
                        <span className="block h-2 overflow-hidden rounded-full bg-slate-100"><span className="rd-grow block h-full rounded-full" style={{ width: `${Math.max(p ? 2 : 0, p)}%`, background: hex, '--d': `${300 + i * 120}ms` } as React.CSSProperties} /></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>) : <p className="text-[13px] text-muted">{tr('Not assessed yet')}</p>}
        </section>
      )}

      {/* where the work is: sections and departments */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card rd-rise rd-card p-5" style={{ '--d': '160ms' } as React.CSSProperties}>
          <CardHead icon="BookMarked" hex="#5e5ce6" title={tr('Key sections')} action={<GoLink onClick={() => onTab('Full Text')}>{tr('Full text')}</GoLink>} />
          {ov?.sections.length ? (
            <ul className="space-y-1">
              {ov.sections.slice(0, 4).map((sec, i) => (
                <li key={sec.name} className="rd-rise" style={{ '--d': `${220 + i * 60}ms` } as React.CSSProperties}>
                  <button onClick={() => onTab('Requirements')} className="rd-row group grid w-full grid-cols-[26px_minmax(0,1fr)_96px] items-center gap-3 rounded-xl px-1.5 py-2 text-left">
                    <span className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-600">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-ink group-hover:text-brand-600">{sec.name.split(' · ').slice(-1)[0]}</span>
                      <span className="block text-[11.5px] text-muted">{sec.requirements === 1 ? tr('1 requirement') : tr('{n} requirements', { n: sec.requirements.toLocaleString() })}</span>
                    </span>
                    {ov.assessed
                      ? <span className="text-right"><span className="block text-xs font-semibold tabular-nums text-critical-600">{tr('{n} unmet', { n: sec.unmet.toLocaleString() })}</span>
                          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-black/[0.06]"><span className="rd-grow block h-full rounded-full bg-gradient-to-r from-critical-400 to-critical-500" style={{ width: `${pctOf(sec.unmet, sec.requirements)}%`, '--d': `${300 + i * 60}ms` } as React.CSSProperties} /></span></span>
                      : <span className="text-right text-xs tabular-nums text-muted">{sec.requirements}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted">{tr('No sections extracted yet.')}</p>}
        </div>

        <div className="card rd-rise rd-card p-5" style={{ '--d': '220ms' } as React.CSSProperties}>
          <CardHead icon="Building2" hex="#30b0c7" title={tr('Top departments affected')} action={<GoLink onClick={() => navigate('/departments')}>{tr('View all')}</GoLink>} />
          {ov?.departments.length ? (
            <BarList data={ov.departments.slice(0, 6).map((d) => ({ label: tr(d.name), value: d.requirements, color: deptUi(d.name).hex }))} />
          ) : <p className="text-[13px] text-muted">{tr("Departments appear once this regulation has been checked against the hospital's documents.")}</p>}
        </div>
      </div>

      {/* what changed lately (when anything did) · the documents */}
      <div className={cn('grid grid-cols-1 gap-4', ov?.updates.length ? 'lg:grid-cols-2' : '')}>
        {ov?.updates.length ? (
          <div className="card rd-rise rd-card p-5" style={{ '--d': '260ms' } as React.CSSProperties}>
            <CardHead icon="History" hex="#af52de" title={tr('Latest updates')} action={<GoLink onClick={() => onTab('Updates')}>{tr('View all')}</GoLink>} />
            <ol className="relative space-y-3 border-l-2 border-slate-100 pl-5">
              {ov.updates.map((u, i) => (
                <li key={i} className="rd-rise relative" style={{ '--d': `${300 + i * 60}ms` } as React.CSSProperties}>
                  <span className={cn('absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-white', u.kind === 'Amendment' ? 'bg-violet-500' : 'bg-warning-500')} />
                  <button onClick={() => onTab('Updates')} className="block w-full text-left">
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <span className={cn('pill px-2 py-0.5 text-[11px]', u.kind === 'Amendment' ? 'bg-violet-50 text-violet-700' : 'bg-warning-50 text-warning-700')}>{tr(u.kind)}</span>
                      {u.date ? fmtDay(u.date, locale) : '—'}
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] font-medium text-ink hover:text-brand-600">{u.title}</span>
                    {u.detail && <span className="block truncate text-xs text-muted">{u.detail}</span>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="card rd-rise p-5" style={{ '--d': '300ms' } as React.CSSProperties}>
          <CardHead icon="FileText" hex="#ff3b30" title={tr('Linked documents')} />
          <ul className={cn('grid gap-2.5', !ov?.updates.length && 'md:grid-cols-2')}>
            {(ov?.documents ?? []).map((d, i) => (
              <li key={i} className="rd-rise rd-card group flex items-center gap-3 rounded-2xl border border-line bg-white px-3 py-2.5" style={{ '--d': `${340 + i * 70}ms` } as React.CSSProperties}>
                <span className="rd-ic"><Tile icon={d.search ? 'BookMarked' : 'FileText'} cls={d.search ? 'bg-violet-50 text-violet-600' : 'bg-critical-50 text-critical-500'} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{d.title}</span>
                  <span className="block truncate text-xs text-muted">{d.kind}</span>
                </span>
                {d.url ? (
                  <a href={d.url} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm transition active:scale-95">{tr('Download')}</a>
                ) : d.search ? (
                  <button onClick={() => navigate('/knowledge')} className="btn btn-outline btn-sm transition active:scale-95">{tr('Search')}</button>
                ) : null}
              </li>
            ))}
            {!ov?.documents.length && <p className="text-[13px] text-muted">{tr('No documents on file.')}</p>}
          </ul>
          {(reg.provenance?.source_name || reg.provenance?.retrieved_at) && (
            <p className="mt-3 text-xs text-muted">
              {reg.provenance?.source_name && <>{tr('Source')}: <span className="text-ink-2">{reg.provenance.source_name}</span></>}
              {reg.provenance?.retrieved_at && <> · {tr('Retrieved')} {fmtDate(reg.provenance.retrieved_at, locale)}</>}
              {reg.provenance?.source_url && !(ov?.documents ?? []).some((d) => d.url === reg.provenance?.source_url) && (
                <> · <a href={reg.provenance.source_url} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">{tr('Source URL')}</a></>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= applicability ================= */

/** "Clinical Establishments", "clinical establishment", "hospital", "hospitals" → "Clinical establishments", "Hospitals". */
function uniqueTypes(types: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of types) {
    const k = raw.trim().toLowerCase().replace(/s$/, '');
    if (!k) continue;
    const plural = raw.trim().toLowerCase().endsWith('s') ? raw.trim() : seen.get(k) ?? raw.trim();
    const nice = plural.charAt(0).toUpperCase() + plural.slice(1).toLowerCase();
    if (!seen.has(k) || /s$/i.test(raw.trim())) seen.set(k, nice);
  }
  return [...seen.values()];
}

function ApplicabilityTab({ id }: { id: string }) {
  // `t` names an entity type below, so the translate function is `tr` here
  const tr = useT();
  const { data, isLoading } = useRegulationApplicability(id);
  return (
    <div className="space-y-4">
      <VerdictCard id={id} />

      <div className="card rd-rise rd-card group p-5" style={{ '--d': '120ms' } as React.CSSProperties}>
        <CardHead icon="Building2" hex="#5e5ce6" title={tr('Who this regulation covers')} />
        <p className="-mt-1.5 text-[12.5px] text-muted">
          {tr("Entity types named by the source, as extracted. These are the regulation's own words, not an interpretation.")}
        </p>
        {isLoading && <Skeleton rows={1} />}
        {data && data.entityTypes.length === 0 && (
          <p className="mt-3 text-[13px] text-muted">
            {tr('No entity types were extracted for this regulation. Applicability must be confirmed against the source text.')}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {uniqueTypes(data?.entityTypes ?? []).map((t, i) => (
            <span key={t} style={{ '--d': `${200 + i * 70}ms` } as React.CSSProperties}
                  className={cn('rd-pop pill', ['bg-brand-50 text-brand-700', 'bg-violet-50 text-violet-700', 'bg-teal-50 text-teal-700', 'bg-sky-50 text-sky-700', 'bg-indigo-50 text-indigo-700'][i % 5])}>
              <Icon name="Hospital" className="h-3.5 w-3.5" />{t}
            </span>
          ))}
        </div>
      </div>

      <details className="card rd-rise group overflow-hidden" style={{ '--d': '180ms' } as React.CSSProperties}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2.5 px-5 py-3.5 hover:bg-slate-50/60 group-open:border-b group-open:border-line [&::-webkit-details-marker]:hidden">
          <Tile icon="ScrollText" cls="bg-teal-50 text-teal-600" size="sm" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{tr('Extracted applicability statements')}</h3>
            <p className="mt-0.5 text-[12px] text-muted">
              {tr('Each row is an excerpt from the source with the clause it came from — supporting evidence for the verdict above, not a parsed condition.')}
            </p>
          </div>
          {data && <Pill tone="blue">{data.rules.length === 1 ? tr('1 statement') : tr('{n} statements', { n: data.rules.length.toLocaleString() })}</Pill>}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="divide-y divide-line">
          {(data?.rules ?? []).map((r) => (
            <div key={String(r.id)} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-ink">{r.entity_type || tr('Unspecified entity')}</span>
                <Pill tone={r.applicability === 'Applies' ? 'green' : 'gray'}>{r.applicability ?? tr('Unknown')}</Pill>
                {r.source_clause && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{r.source_clause}</span>}
                {r.confidence != null && (
                  <span className="ml-auto flex w-40 items-center gap-2 text-xs text-muted">
                    {tr('Confidence')} <Progress className="flex-1" value={Math.round(r.confidence * 100)} total={100} color="#14b8a6" />
                  </span>
                )}
              </div>
              {r.applicability_rule && <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-muted">{r.applicability_rule}</p>}
            </div>
          ))}
          {data && data.rules.length === 0 && (
            <p className="px-5 py-8 text-center text-[13px] text-muted">{tr('No applicability statements were extracted from this regulation.')}</p>
          )}
        </div>
      </details>
    </div>
  );
}

/* ================= updates ================= */

function UpdatesTab({ reg }: { reg: Reg }) {
  // `t` is a date helper inside the memo below, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const { data: ch } = useRegulationChanges(reg.id);
  const { data: am } = useRegulationAmendments(reg.id);
  const p = reg.provenance ?? ({} as NonNullable<typeof reg.provenance>);

  /** One dated history from every source the page already has. */
  const events = useMemo(() => {
    const ev: { date: string; kind: string; title: string; sub?: string; icon: string; cls: string; url?: string | null }[] = [];
    (ch?.versions ?? []).forEach((v, i) => v.captured_at && ev.push({
      date: v.captured_at, kind: tx('Version'), icon: 'GitCompare', cls: 'bg-brand-50 text-brand-600',
      title: tr('Version {n} captured', { n: (i + 1).toLocaleString() }),
      sub: [v.section_count != null && (v.section_count === 1 ? tr('1 section') : tr('{n} sections', { n: v.section_count.toLocaleString() })),
        v.retrieved_from === 'INTERNET_ARCHIVE' && tr('from a web archive')].filter(Boolean).join(' · ') || undefined,
    }));
    if (ch?.comparison?.detectedAt) ev.push({
      date: ch.comparison.detectedAt, kind: tx('Comparison'), icon: 'FileSearch', cls: 'bg-warning-50 text-warning-600',
      title: ch.comparison.sectionsChanged === 1 ? tr('1 section differs between captured copies')
        : tr('{n} sections differ between captured copies', { n: ch.comparison.sectionsChanged.toLocaleString() }),
    });
    (am?.timeline ?? []).forEach((a) => a.amendedOn && ev.push({
      date: a.amendedOn, kind: tx('Amendment'), icon: 'Gavel', cls: 'bg-violet-50 text-violet-600', url: a.url,
      title: a.reference || tr('Amendment recorded in the text'),
      sub: [a.sectionCount === 1 ? tr('1 section') : tr('{n} sections', { n: a.sectionCount.toLocaleString() }), a.actions.map((x) => readable(String(x))).join(', ')].filter(Boolean).join(' · '),
    }));
    if (p.retrieved_at) {
      ev.push({ date: p.retrieved_at, kind: tx('Retrieved'), icon: 'Download', cls: 'bg-teal-50 text-teal-600',
        title: p.source_name ? tr('Retrieved from {source}', { source: p.source_name }) : tr('Retrieved from the source') });
    }
    const t = (d: string) => { const x = new Date(d).getTime(); return Number.isNaN(x) ? 0 : x; };
    return ev.sort((a, b) => t(b.date) - t(a.date));
  }, [ch, am, p, tr]);

  const years = useMemo(() => {
    const m = new Map<string, number>();
    (am?.items ?? []).forEach((a) => { const y = (a.amended_on ?? '').match(/(19|20)\d{2}/)?.[0]; if (y) m.set(y, (m.get(y) ?? 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10).map(([label, value]) => ({ label, value, color: '#8b5cf6' }));
  }, [am]);

  const quiet = !(ch?.computedChanges) && !(am?.total) && (ch?.versionsCaptured ?? 0) <= 1;
  if (quiet) {
    return (
      <div className="space-y-4">
        <div className="card flex flex-wrap items-start gap-4 p-5">
          <Tile icon="History" cls="bg-brand-50 text-brand-600" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{tr('No changes or amendments recorded')}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {p.retrieved_at
                ? tr('Captured once, on {date}. A change is shown here when a newer copy differs from it, or when the text records an amendment.', { date: fmtDate(p.retrieved_at, locale, false) })
                : tr('A change is shown here when a newer copy differs from the captured one, or when the text records an amendment.')}
            </p>
            {ch?.message && <p className="mt-1 text-[12.5px] text-muted">{ch.message}</p>}
          </div>
        </div>
        <ProvenanceTab reg={reg} />
      </div>
    );
  }
  const tiles = [
    { label: tx('Versions captured'), n: ch?.versionsCaptured ?? 0, tone: 'brand', icon: 'GitCompare', foot: undefined as string | undefined },
    { label: tx('Wording changed'), n: ch?.wordingChanges ?? 0, tone: 'amber', icon: 'FileText', foot: tr('sections reworded') },
    { label: tx('Renumbered only'), n: ch?.numberingOnlyChanges ?? 0, tone: 'gray', icon: 'Hash', foot: tr('no wording moved') },
    { label: tx('Amendments recorded'), n: am?.total ?? 0, tone: 'purple', icon: 'Gavel',
      foot: am?.circulars ? (am.circulars === 1 ? tr('1 circular') : tr('{n} circulars', { n: am.circulars.toLocaleString() })) : tr('in the document text') },
  ].filter((x) => x.n > 0);

  return (
    <div className="space-y-6">
      {tiles.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((x) => <MetricCard key={x.label} label={tr(x.label)} value={x.n.toLocaleString()} tone={x.tone as 'brand'} icon={x.icon} foot={x.foot} />)}
      </div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="card p-5">
          <div className="mb-4 flex items-center gap-2.5">
            <Tile icon="History" cls="bg-brand-50 text-brand-600" size="sm" />
            <h3 className="text-[15px] font-semibold text-ink">{tr('History of this document')}</h3>
          </div>
          {events.length ? (
            <ol className="relative space-y-4 border-l-2 border-slate-100 pl-6">
              {events.slice(0, 12).map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[42px] top-0"><Tile icon={e.icon} cls={cn(e.cls, 'ring-4 ring-white')} size="sm" /></span>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className={cn('pill px-2 py-0.5 text-[11px]', e.cls)}>{tr(e.kind)}</span>
                    <span className="tabular-nums">{fmtDate(e.date, locale, false)}</span>
                  </div>
                  {e.url
                    ? <a href={e.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline">{e.title}<ExternalLink className="h-3 w-3" /></a>
                    : <div className="mt-0.5 text-[13px] font-medium text-ink">{e.title}</div>}
                  {e.sub && <div className="text-xs text-muted">{e.sub}</div>}
                </li>
              ))}
            </ol>
          ) : <EmptyState title={tr('No dated history yet')} hint={tr('A version capture, comparison or recorded amendment appears here.')} icon="History" />}
          {events.length > 12 && <p className="mt-3 text-xs text-muted">{tr('Showing the latest 12 of {n} events — every amendment is listed below.', { n: events.length.toLocaleString() })}</p>}
        </div>
        <div className="space-y-4">
          {ch && (
            <div className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="text-[15px] font-semibold text-ink">{tr('Change status')}</h3>
                <StatusPill status={ch.status} />
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{ch.message}</p>
            </div>
          )}
          {years.length > 0 && (
            <div className="card p-5">
              <h3 className="text-[15px] font-semibold text-ink">{tr('Amendments by year')}</h3>
              <p className="mt-0.5 text-xs text-muted">{tr("As recorded in the document's own text.")}</p>
              <ColumnChart className="mt-4" data={years} height={150} />
            </div>
          )}
        </div>
      </div>

      <section>
        <BlockHead icon="GitCompare" title="Detected changes" hint="Wording differences between captured copies of this document." />
        <ChangesTab id={reg.id} />
      </section>
      <section>
        <BlockHead icon="Gavel" title="Amendments" hint="Amendments recorded in the document's own text." />
        <AmendmentsTab id={reg.id} />
      </section>
      <section>
        <BlockHead icon="Info" title="Provenance" hint="Where this record came from and what was downloaded." />
        <ProvenanceTab reg={reg} />
      </section>
    </div>
  );
}

/* ---------------- provenance ---------------- */
function ProvenanceCard({ reg }: { reg: Reg }) {
  const t = useT();
  const locale = useDateLocale();
  const p = reg.provenance ?? ({} as NonNullable<typeof reg.provenance>);
  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Info className="h-4 w-4 text-muted" /> {t('Where this came from')}
      </h3>
      <dl className="mt-3 space-y-2.5">
        <Prov icon="Landmark" k={t('Source')} v={p.source_name ?? '—'} />
        <Prov icon="ExternalLink" k={t('Source URL')} v={p.source_url ?? '—'} link={p.source_url ?? undefined} />
        {p.document_url && p.document_url !== p.source_url && <Prov icon="FileText" k={t('Document URL')} v={p.document_url} link={p.document_url} />}
        <Prov icon="Calendar" k={t('Retrieved')} v={fmtDate(p.retrieved_at, locale)} />
        {p.document_hash && <Prov icon="Hash" k="SHA-256" v={p.document_hash} mono />}
        {p.document_downloaded && (
          <Prov icon="CheckCircle2" k={t('Document')}
                v={t('downloaded · {kb} KB · {pages} pages', { kb: ((p.file_size ?? 0) / 1024).toFixed(0), pages: p.page_count ?? '?' })} />
        )}
      </dl>
    </div>
  );
}

function ProvenanceTab({ reg }: { reg: Reg }) {
  const t = useT();
  const { data: docs } = useRegulationDocuments(reg.id);
  return (
    <div className={cn('grid grid-cols-1 gap-4', docs?.items.length ? 'lg:grid-cols-2' : '')}>
      <ProvenanceCard reg={reg} />
      {!!docs?.items.length && <div className="card p-5">
        <h3 className="text-sm font-semibold text-ink">{t('Downloaded documents')}</h3>
          <ul className="mt-3 space-y-3">
            {docs.items.map((d) => (
              <li key={d.id} className="flex gap-3 rounded-xl border border-line p-3">
                <Tile icon="FileText" cls="bg-critical-50 text-critical-500" />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-[13px] font-semibold text-ink">{d.file_name}</div>
                  <dl className="mt-1.5 space-y-1 text-xs text-muted">
                    <div>{t('{kb} KB · {n} pages', { kb: (d.file_size / 1024).toFixed(0), n: d.page_count })}</div>
                    <div className="break-all font-mono text-[11px]">SHA-256 {d.document_hash}</div>
                    <div className="truncate" title={d.source_url ?? undefined}>{d.source_url}</div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
      </div>}
    </div>
  );
}

/* ---------------- amendments (evidence) ---------------- */
function AmendmentsTab({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading } = useRegulationAmendments(id);
  if (isLoading) return <div className="card"><Skeleton rows={3} /></div>;
  if (!data?.total) return <Empty msg={t('This document records no amendments in its own text.')} />;
  return (
    <div className="space-y-4">
      <Callout tone="purple" icon="Gavel" title={t('Amendment mentioned in source · {total} entries · {circulars} circulars', {
        total: data.total.toLocaleString(), circulars: data.circulars.toLocaleString(),
      })}>{data.note}</Callout>
      <div className="card divide-y divide-line">
        {data.items.map((a, i) => (
          <div key={i} className="flex gap-3 px-5 py-3">
            <Tile icon="Gavel" cls="bg-violet-50 text-violet-600" size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-ink">{a.section_number ? t('Section {n}', { n: a.section_number }) : t('Document')}</span>
                <span className="pill bg-warning-50 text-warning-600">{a.action ? readable(String(a.action)) : a.action}</span>
                <span className="text-xs text-muted">{a.meaning}</span>
                <span className="ml-auto text-xs tabular-nums text-muted">{a.amended_on}</span>
              </div>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer"
                   className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-brand-600 hover:underline"
                   title={t("Open the circular that made this amendment on the regulator's site")}>
                  {a.reference}<ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <div className="mt-1 font-mono text-[11px] text-muted">{a.reference}</div>
              )}
              {a.context && <p className="mt-1.5 border-l-2 border-warning-500 pl-2.5 text-[12px] text-ink-2">…{a.context}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- changes (computed only) ---------------- */
function ChangesTab({ id }: { id: string }) {
  const t = useT();
  const locale = useDateLocale();
  const { data, isLoading } = useRegulationChanges(id);
  if (isLoading) return <div className="card"><Skeleton rows={3} /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink">{t('Change comparison')}</h3>
          <StatusPill status={data.status} />
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{data.message}</p>
        {data.computedChanges > 0 && (
          <div className="mt-3 max-w-xl">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <span className="h-full bg-warning-500" style={{ width: `${pctOf(data.wordingChanges, data.computedChanges)}%` }} title={t('Wording changed: {n}', { n: data.wordingChanges.toLocaleString() })} />
              <span className="h-full bg-slate-400" style={{ width: `${pctOf(data.numberingOnlyChanges, data.computedChanges)}%` }} title={t('Renumbered only: {n}', { n: data.numberingOnlyChanges.toLocaleString() })} />
            </div>
            <div className="mt-1.5 flex gap-4 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning-500" />{t('Wording changed')} <b className="text-ink">{data.wordingChanges}</b></span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-400" />{t('Renumbered only')} <b className="text-ink">{data.numberingOnlyChanges}</b></span>
            </div>
          </div>
        )}
        {data.numberingOnlyChanges > 0 && (
          <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">
            {t('Inserting a footnote or paragraph shifts every reference after it. Those sections differ but no wording moved, so they are listed separately rather than counted as amendments — and never hidden.')}
          </p>
        )}
      </div>

      {data.comparison && (
        <div className="card overflow-hidden">
          <div className="border-b border-line px-5 py-2.5">
            <h3 className="text-sm font-semibold text-ink">{t('What was compared')}</h3>
            <p className="mt-0.5 text-[12px] text-muted">{t('Every detected change below is the difference between exactly these two copies.')}</p>
          </div>

          {/* the source document itself */}
          <div className="border-b border-line px-5 py-3">
            <div className="text-xs font-medium text-muted">{t('Original document')}</div>
            {data.comparison.sourceUrl ? (
              <a href={data.comparison.sourceUrl} target="_blank" rel="noreferrer"
                 title={data.comparison.sourceUrl} className="mt-0.5 block truncate text-[12.5px] font-medium text-brand-600 hover:underline">
                {data.comparison.sourceUrl}
              </a>
            ) : (
              <div className="mt-0.5 text-[12.5px] text-muted">{t('Source URL not recorded')}</div>
            )}
            {data.document && (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                {data.document.page_count != null && <span>{data.document.page_count === 1 ? t('1 page') : t('{n} pages', { n: data.document.page_count.toLocaleString() })}</span>}
                {data.document.file_size != null && <span>{Math.round(data.document.file_size / 1024)} KB</span>}
                {data.document.created_at && <span>{t('First ingested {date}', { date: fmtDate(data.document.created_at, locale, false) })}</span>}
              </div>
            )}
          </div>

          {/* the two copies, side by side */}
          <div className="grid gap-px bg-line sm:grid-cols-2">
            {([[tx('Earlier copy'), data.comparison.from, 'bg-slate-100 text-slate-600'], [tx('Later copy'), data.comparison.to, 'bg-brand-50 text-brand-700']] as const).map(
              ([label, side, cls]) => (
              <div key={label} className="bg-surface px-5 py-3">
                <span className={cn('pill', cls)}>{t(label)}</span>
                <div className="mt-1.5 text-[15px] font-semibold tabular-nums text-ink">{fmtDate(side.capturedAt, locale, false)}</div>
                <div className="text-xs text-muted">{t('The date this copy is from')}</div>
                <dl className="mt-2 space-y-0.5 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted">{t('Fetched')}</dt>
                    <dd className="tabular-nums text-ink-2">{fmtDate(side.retrievedAt, locale, false)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted">{t('Via')}</dt>
                    <dd>
                      {side.retrievedFrom === 'INTERNET_ARCHIVE' ? (
                        <span className="pill bg-warning-50 text-warning-600" title={t('Recovered from a web archive, not fetched from the regulator')}>{t('Web archive')}</span>
                      ) : (
                        <span className="pill bg-slate-100 text-slate-600">{t('Regulator')}</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted">SHA-256</dt>
                    <dd className="break-all font-mono text-[11px] text-muted">{side.documentHash?.slice(0, 32) ?? '—'}…</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-5 py-2.5 text-[12px]">
            <span className="text-muted">{t('Comparison run')} <b className="tabular-nums text-ink-2">{fmtDate(data.comparison.detectedAt, locale)}</b></span>
            <span className="text-muted">{data.comparison.sectionsChanged === 1 ? t('1 section differs')
              : t('{n} sections differ', { n: data.comparison.sectionsChanged.toLocaleString() })}</span>
            {data.comparison.from.documentHash !== data.comparison.to.documentHash && (
              <span className="ml-auto text-xs text-muted">{t('Hashes differ — the document genuinely changed')}</span>
            )}
          </div>
        </div>
      )}

      {data.versions.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-ink">{t('Captured versions')}</h3>
          <ul className="mt-3 space-y-2">
            {data.versions.map((v, i) => (
              <li key={v.id} className="flex items-center gap-3 text-[12.5px]">
                <span className="pill bg-brand-50 text-brand-700">v{i + 1}</span>
                <span className="tabular-nums text-ink-2">{fmtDate(v.captured_at, locale, false)}</span>
                {v.retrieved_at && v.retrieved_at.slice(0, 10) !== v.captured_at?.slice(0, 10) && (
                  <span className="text-xs text-muted" title={t('When we fetched this copy')}>{t('Fetched {date}', { date: fmtDate(v.retrieved_at, locale, false) })}</span>
                )}
                {v.section_count != null && <span className="text-xs text-muted">{v.section_count === 1 ? t('1 section') : t('{n} sections', { n: v.section_count.toLocaleString() })}</span>}
                {v.retrieved_from === 'INTERNET_ARCHIVE' && (
                  <span className="pill bg-warning-50 text-warning-600" title={t('Recovered from a web archive, not fetched from the regulator')}>{t('Web archive')}</span>
                )}
                <span className="ml-auto break-all font-mono text-[11px] text-muted">{v.document_hash?.slice(0, 24)}…</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.items.length === 0 ? (
        <div className="card">
          <EmptyState title={t('No previous version available for comparison')} icon="GitCompare"
            hint={t('A change comparison requires two captures of the same document. Nothing is inferred and no old-versus-new values are shown until a real comparison has been performed.')} />
        </div>
      ) : (
        <div className="space-y-3">
          {data.items.filter((c) => c.change_class !== 'NUMBERING_ONLY').map((c, i) => (
            <DiffView key={`w${i}`} location={t('Section {n} — {change}', { n: c.section_number, change: readable(String(c.change_type ?? '')) })}
              oldText={c.old_text} newText={c.new_text} mode="split" />
          ))}
          {data.numberingOnlyChanges > 0 && (
            <details className="card p-4">
              <summary className="cursor-pointer text-[13px] font-semibold text-ink">
                {t('{n} section(s) renumbered only — no wording changed', { n: data.numberingOnlyChanges.toLocaleString() })}
              </summary>
              <div className="mt-3 space-y-3">
                {data.items.filter((c) => c.change_class === 'NUMBERING_ONLY').map((c, i) => (
                  <DiffView key={`n${i}`} location={t('Section {n} — {change}', { n: c.section_number, change: readable(String(c.change_type ?? '')) })}
                    oldText={c.old_text} newText={c.new_text} mode="split" />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- small pieces ---------------- */
/** Header for a stacked block inside a tab (Updates). */
function BlockHead({ title, hint, icon }: { title: string; hint?: string; icon: string }) {
  const t = useT();
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <Tile icon={icon} cls="bg-slate-100 text-slate-600" size="sm" />
      <div>
        <h2 className="sec-title">{t(title)}</h2>
        {hint && <p className="text-[12.5px] text-muted">{t(hint)}</p>}
      </div>
    </div>
  );
}
function Empty({ msg }: { msg: string }) {
  return <div className="card"><EmptyState title={msg} icon="Inbox" /></div>;
}
export function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-dashed border-line py-1.5 text-[13px]">
      <dt className="text-muted">{k}</dt><dd className="font-medium text-ink-2">{v}</dd>
    </div>
  );
}
function Prov({ icon, k, v, link, mono }: { icon: string; k: string; v: string; link?: string; mono?: boolean }) {
  return (
    <div className="flex gap-2.5">
      <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted">{k}</div>
        {link ? (
          // One line, never broken mid-word; the full URL is in the tooltip.
          <a href={link} target="_blank" rel="noreferrer" title={v}
             className="block truncate text-[12.5px] text-brand-600 hover:underline">{v}</a>
        ) : (
          <div className={cn('text-[12.5px] text-ink-2', mono ? 'break-all font-mono text-[11.5px]' : 'break-words')}>{v}</div>
        )}
      </div>
    </div>
  );
}

/** "2025-03-14T09:12:00Z" → "14 Mar 2025, 09:12". Non-dates are returned as written. `locale` is `useDateLocale()`. */
function fmtDate(v: string | null | undefined, locale: string, withTime = true): string {
  if (!v) return '—';
  const d = parseDay(v);
  if (Number.isNaN(d.getTime())) return v;
  const hasTime = withTime && /T\d{2}:\d{2}/.test(v);
  return d.toLocaleString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
    ...(hasTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export default RegulationDetailPage;
