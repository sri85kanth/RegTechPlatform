/**
 * The left filter rail — the layout every shopper already knows.
 *
 * WHY A RAIL AND NOT A BAR
 * ------------------------
 * The horizontal bar put nine filters behind six dropdowns and an "Advanced"
 * panel. Nothing was visible until you opened a menu, so the shape of the
 * library — that RBI carries most of it, that only 648 records are analysed —
 * was invisible, and an active filter showed only as a chip beside the result
 * count while every control above it still read "All".
 *
 * A rail fixes both. Every group is open by default with its counts on screen,
 * a checked box is a checked box, and the results column is left to do one job.
 * The exception is the technical filters, which few people need: they wait under
 * "More filters", and open by themselves when one of them is in use.
 *
 * COUNTS ARE NOT DECORATION
 * -------------------------
 * Each number is a COUNT(*) from /api/regulations/facets computed under the
 * current selection with that dimension's own filter lifted, so it is exactly
 * what ticking the box would return. An option that would return nothing reads
 * 0 instead of looking available.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search, SlidersHorizontal, Target, X } from 'lucide-react';
import {
  EMPTY_FILTERS, isAppliesToUs, APPLIES_TO_US, useCompanyProfile,
  type RegulationFilters, type RegulationFacets, type FacetValue,
} from '@/services/regulationsApi';
import {
  REGULATION_TYPES, IMPORTANCE, APPLICABILITY, APPLICABILITY_LABEL,
  COLLECTION, COLLECTION_LABEL, withCounts,
  IMPORTANCE_HEX, APPLICABILITY_HEX, COLLECTION_HEX, regulatorColor,
} from './RegulationFilters';
import { CHART, StackedBar } from '@/components/ui/charts';
import { IconTile, type MetricTone } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

type ArrayKey = 'regulator' | 'regulation_type' | 'sector' | 'state_ut'
  | 'collection_status' | 'importance' | 'applicability';

interface Group {
  key: ArrayKey;
  title: string;
  options: { value: string; count: number }[];
  label?: Record<string, string>;
  /** Groups with long tails collapse; short ones never need a "show all". */
  initial?: number;
  note?: string;
  icon: string;
  tone: MetricTone;
  /** each option's colour — its dot and its count bar */
  color: (value: string) => string;
}

/**
 * Categorical colour by name, for values that carry no meaning of their own.
 * Stable per value, so ticking a box (which floats it to the top) never
 * repaints it.
 */
const byName = (v: string) => regulatorColor(v).hex;
const fixed = (map: Record<string, string>) => (v: string) => map[v] ?? CHART[0];
/** Values defined in code (not read from the API) shown as their own label, so they are translated. */
const asLabels = (values: string[]) => Object.fromEntries(values.map((v) => [v, v]));

export function RegulationFacetRail({
  filters, setFilters, facets, loading,
}: {
  filters: RegulationFilters;
  setFilters: (f: RegulationFilters) => void;
  facets: RegulationFacets | undefined;
  loading?: boolean;
}) {
  const t = useT();
  const [openSection, setOpenSection] = useState<string | null>(null);
  const set = <K extends keyof RegulationFilters>(k: K, v: RegulationFilters[K]) =>
    setFilters({ ...filters, [k]: v });

  const toggle = (k: ArrayKey, v: string) => {
    const cur = filters[k];
    set(k, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) as never);
  };

  const states = facets?.vocabulary.states ?? [];
  const uts = facets?.vocabulary.unionTerritories ?? [];

  const regionOptions = useMemo(() => {
    const byValue = new Map((facets?.regions ?? []).map((r) => [r.value, r.count]));
    const all = facets?.allIndiaCount ?? 0;
    // An all-India instrument applies in every region, so a region's real total
    // is its own specific records plus every central one.
    return [...states, ...uts].map((v) => ({ value: v, count: (byValue.get(v) ?? 0) + all }));
  }, [facets, states, uts]);

  const groups: Group[] = [
    {
      key: 'regulator', title: 'Regulator', icon: 'Landmark', tone: 'brand', color: byName,
      options: (facets?.regulators ?? []) as FacetValue[], initial: 8,
    },
    {
      key: 'applicability', title: 'Applicability to us', icon: 'Target', tone: 'green',
      color: fixed(APPLICABILITY_HEX),
      options: withCounts(APPLICABILITY, facets?.applicability),
      label: APPLICABILITY_LABEL,
      note: tx('Computed from the entity types each regulation addresses.'),
    },
    {
      key: 'regulation_type', title: 'Instrument type', icon: 'FileText', tone: 'purple', color: byName,
      options: withCounts(REGULATION_TYPES, facets?.regulationTypes), initial: 8, label: asLabels(REGULATION_TYPES),
    },
    {
      key: 'importance', title: 'Impact level', icon: 'Flame', tone: 'red', color: fixed(IMPORTANCE_HEX),
      options: withCounts(IMPORTANCE, facets?.importance), label: asLabels(IMPORTANCE),
    },
  ];

  const moreGroups: Group[] = [
    {
      key: 'sector', title: 'Sector', icon: 'Building2', tone: 'teal', color: byName,
      options: withCounts([...(facets?.vocabulary.sectors ?? []), 'Unclassified'], facets?.sectors),
      initial: 8, label: { Unclassified: tx('Unclassified') },
    },
    {
      key: 'state_ut', title: 'State / UT', icon: 'MapPin', tone: 'orange', color: byName,
      options: regionOptions, initial: 6,
      note: tx('Where a regulation applies, not who issued it — every all-India instrument matches every region.'),
    },
    {
      key: 'collection_status', title: 'Collection stage', icon: 'Layers', tone: 'purple',
      color: fixed(COLLECTION_HEX),
      options: withCounts(COLLECTION, facets?.collectionStatuses), label: COLLECTION_LABEL,
    },
  ];

  const moreActive =
    (filters.source_verification ? 1 : 0) +
    moreGroups.reduce((a, g) => a + filters[g.key].length, 0);

  const activeCount =
    (filters.q ? 1 : 0) +
    (filters.jurisdiction !== 'All' ? 1 : 0) +
    moreActive +
    groups.reduce((a, g) => a + filters[g.key].length, 0);

  const groupSection = (g: Group) => (
    <Section key={g.key} title={g.title} note={g.note} icon={g.icon} tone={g.tone}
             active={filters[g.key].length}>
      <Checks
        options={g.options}
        selected={filters[g.key]}
        onToggle={(v) => toggle(g.key, v)}
        label={g.label}
        initial={g.initial}
        loading={loading && !facets}
        color={g.color}
      />
    </Section>
  );

  return (
    <aside className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-ink">
          <IconTile icon="Filter" tone="brand" size="sm" />
          {t('Filters')}
          {activeCount > 0 && (
            <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
              {activeCount}
            </span>
          )}
        </h2>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}
            className="text-[12px] font-medium text-brand-600 hover:underline"
          >
            {t('Clear all')}
          </button>
        )}
      </div>

      <OpenSection.Provider value={{ open: openSection, setOpen: setOpenSection }}>
      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <Section title="Jurisdiction" icon="Globe" tone="brand" active={filters.jurisdiction !== 'All' ? 1 : 0}>
          <Radio
            options={[
              { value: 'All', label: 'Anywhere', count: facets?.total ?? 0 },
              { value: 'India', label: 'All India', count: facets?.allIndiaCount ?? 0 },
              { value: 'State', label: 'State-specific', count: (facets?.regions ?? []).filter((r) => r.kind === 'STATE').length },
              { value: 'Union Territory', label: 'UT-specific', count: (facets?.regions ?? []).filter((r) => r.kind === 'UT').length },
            ]}
            value={filters.jurisdiction}
            onChange={(v) => set('jurisdiction', v)}
          />
        </Section>

        {groups.map(groupSection)}

        <Section title="Issued between" icon="Calendar" tone="amber" active={(filters.issued_from ? 1 : 0) + (filters.issued_to ? 1 : 0)}>
          <div className="flex items-center gap-1.5">
            <input
              type="date" value={filters.issued_from}
              onChange={(e) => set('issued_from', e.target.value)}
              aria-label={t('Issued between, start date')} className="input h-8 w-full px-2 text-[12px]"
            />
            <span className="text-xs text-muted">{t('to')}</span>
            <input
              type="date" value={filters.issued_to}
              onChange={(e) => set('issued_to', e.target.value)}
              aria-label={t('Issued between, end date')} className="input h-8 w-full px-2 text-[12px]"
            />
          </div>
        </Section>

        <MoreFilters active={moreActive}>
          {moreGroups.map(groupSection)}

          <Section title="Source" note={tx('A record discovered is not a document verified.')} last icon="BadgeCheck" tone="green">
            <Radio
              options={[
                { value: '', label: 'Any' },
                { value: 'Verified', label: 'Source verified' },
                { value: 'Not Verified', label: 'Not verified' },
              ]}
              value={filters.source_verification}
              onChange={(v) => set('source_verification', v)}
            />
          </Section>
        </MoreFilters>
      </div>
      </OpenSection.Provider>
    </aside>
  );
}

/**
 * The filters few people need. Closed by default, but never hiding one that is
 * doing something: it opens when a saved selection or a link turns one on.
 */
function MoreFilters({ active, children }: { active: number; children: React.ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(active > 0);
  useEffect(() => { if (active > 0) setOpen(true); }, [active]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[40px] w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-slate-50/70"
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{t('More filters')}</span>
        {active > 0 && (
          <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-brand-700">
            {t('{n} on', { n: active.toLocaleString() })}
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="border-t border-line">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ applies-to-us */

/**
 * The one-click applicability filter.
 *
 * It selects APPLICABLE and CONDITIONAL together because the engine withholds
 * an unqualified APPLICABLE until every mandatory condition has been evaluated,
 * and thresholds are not extracted yet — so a regulation whose entity type,
 * jurisdiction and regulator all match settles on CONDITIONAL. Filtering to
 * APPLICABLE alone would return nothing and read as "no regulation applies to
 * you", which is the worst answer this screen could give.
 */
export function AppliesToUsToggle({ filters, setFilters, facets }: {
  filters: RegulationFilters;
  setFilters: (f: RegulationFilters) => void;
  facets: RegulationFacets | undefined;
}) {
  const t = useT();
  const on = isAppliesToUs(filters);
  const { data: profileRes } = useCompanyProfile();
  const legalName = (profileRes?.profile?.legal_name as string) || t('this company');
  const entityType = (profileRes?.profile?.entity_type as string) || '';

  const n = (v: string) => facets?.applicability.find((f) => f.value === v)?.count ?? 0;
  const applies = n('APPLICABLE') + n('CONDITIONAL');

  const all = facets ? facets.applicability.reduce((a, f) => a + f.count, 0) : 0;
  const share = all > 0 ? Math.round((applies / all) * 100) : 0;
  // the whole story on hover; the pill itself carries the name, the count and the switch
  const why = [
    facets ? t('{n} regulations · {share}% of assessed', { n: applies.toLocaleString(), share }) : t('Counting…'),
    on ? t('Showing only what the system can defend. Press again for the whole library.')
      : `${t('Matched against {name}', { name: legalName })}${entityType ? ` — ${entityType}` : ''}`,
  ].join('\n');

  // It sits beside the search because it is the one filter most people want:
  // strong blue when on, a quiet blue pill when off, and a switch that says which.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={why}
      disabled={!facets || (!on && applies === 0)}
      onClick={() => setFilters({ ...filters, applicability: on ? [] : APPLIES_TO_US })}
      className={cn(
        'relative flex h-10 shrink-0 items-center gap-2.5 overflow-hidden rounded-xl pl-2 pr-2.5 text-left transition-all duration-300 ease-spring active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'bg-gradient-to-br from-brand-600 to-indigo-600 text-white shadow-[0_4px_14px_rgba(0,113,227,0.35)] hover:from-brand-700 hover:to-indigo-700'
          : 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100',
      )}
    >
      {on && <span className="pointer-events-none absolute -right-5 -top-6 h-14 w-14 rounded-full bg-white/10" aria-hidden="true" />}
      <span className={cn('relative grid h-7 w-7 shrink-0 place-items-center rounded-lg',
        on ? 'bg-white/15 ring-1 ring-white/25' : 'bg-white text-brand-600 ring-1 ring-brand-200')}>
        <Target className="h-4 w-4" />
      </span>
      <span className="relative min-w-0 leading-tight">
        <span className="block whitespace-nowrap text-[13px] font-semibold">{t('Applies to us')}</span>
        <span className={cn('block whitespace-nowrap text-[11px] tabular-nums', on ? 'text-white/80' : 'text-brand-600/80')}>
          {facets ? t('{n} regulations', { n: applies.toLocaleString() }) : t('Counting…')}
        </span>
      </span>
      <span aria-hidden="true"
            className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-white' : 'bg-brand-200')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full shadow-sm transition-all duration-300 ease-spring',
          on ? 'left-[18px] bg-brand-600' : 'left-0.5 bg-white')} />
      </span>
    </button>
  );
}

/**
 * What filtering to "applies to us" leaves out.
 *
 * Rendered in the results column, not the rail, because it is the one thing on
 * this screen a compliance officer must read and a 268px column cannot carry
 * it. Filtering to what applies also hides 1,111 regulations that were never
 * assessed at all, and silence is not a "no".
 */
export function AppliesToUsNote({ facets }: { facets: RegulationFacets | undefined }) {
  const t = useT();
  const n = (v: string) => facets?.applicability.find((f) => f.value === v)?.count ?? 0;
  const applicable = n('APPLICABLE');
  const conditional = n('CONDITIONAL');
  const review = n('REVIEW_REQUIRED');
  const notApplicable = n('NOT_APPLICABLE');
  const assessed = (facets?.applicability ?? []).reduce((a, f) => a + f.count, 0);
  const unassessed = facets ? Math.max(0, facets.matched - assessed) : 0;

  return (
    <details className="group mb-3 overflow-hidden rounded-[16px] border border-black/[0.06] bg-white/70 text-[12.5px] leading-relaxed">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 text-ink-2 hover:bg-black/[0.02] [&::-webkit-details-marker]:hidden">
        <Icon name="Info" className="h-4 w-4 shrink-0 text-brand-600" />
        <span className="min-w-0 flex-1">
          {applicable === 0
            ? t('All {n} that apply are conditional: entity type, jurisdiction and regulator match; thresholds and exemptions are not checked yet.', { n: conditional.toLocaleString() })
            : t('{a} apply outright and {c} conditionally.', { a: applicable.toLocaleString(), c: conditional.toLocaleString() })}
        </span>
        <span className="shrink-0 text-[12px] font-medium text-brand-600">{t('Details')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="pm-open border-t border-black/[0.06] px-4 py-3">
        {facets && (
          <StackedBar
            className="mb-2.5"
            height={8}
            data={[
              { label: t('Applicable'), value: applicable, color: APPLICABILITY_HEX.APPLICABLE },
              { label: t('Conditional'), value: conditional, color: APPLICABILITY_HEX.CONDITIONAL },
              { label: t('Awaiting review'), value: review, color: APPLICABILITY_HEX.REVIEW_REQUIRED },
              { label: t('Not applicable'), value: notApplicable, color: APPLICABILITY_HEX.NOT_APPLICABLE },
              { label: t('Never assessed'), value: unassessed, color: APPLICABILITY_HEX.UNKNOWN },
            ]}
          />
        )}
        <p className="text-muted">
          {t('Set aside by this filter: {review} awaiting review (entity type could not be confirmed) · {excluded} positively excluded · {never} never assessed, with no applicability rule extracted.', {
            review: review.toLocaleString(), excluded: notApplicable.toLocaleString(), never: unassessed.toLocaleString(),
          })}
          {' '}{t('Never assessed is not the same as not applicable.')}
        </p>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ pieces */

const SECTION_ICON: Record<MetricTone, string> = {
  neutral: 'text-brand-600', brand: 'text-brand-600', green: 'text-success-500', amber: 'text-warning-500',
  orange: 'text-notcov-500', red: 'text-critical-500', purple: 'text-violet-600', teal: 'text-teal-600', gray: 'text-slate-500',
};

/**
 * The rail is an accordion: every section starts closed, and opening one closes
 * the one that was open, so the list stays short. A closed section still says
 * how many of its filters are on.
 */
const OpenSection = createContext<{ open: string | null; setOpen: (k: string | null) => void } | null>(null);

function Section({ title, note, last, children, icon, tone = 'brand', active = 0 }: {
  title: string; note?: string; last?: boolean; children: React.ReactNode;
  icon?: string; tone?: MetricTone; active?: number;
}) {
  const t = useT();
  const shared = useContext(OpenSection);
  const [own, setOwn] = useState(false);
  const open = shared ? shared.open === title : own;
  const setOpen = (f: (o: boolean) => boolean) => (shared ? shared.setOpen(f(open) ? title : null) : setOwn(f));
  return (
    <div className={cn(!last && 'border-b border-line', open && 'bg-slate-50/40')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[40px] w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-slate-50/70"
      >
        {icon && <span className={cn('shrink-0', SECTION_ICON[tone])}><Icon name={icon} className="h-4 w-4" /></span>}
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{t(title)}</span>
        {active > 0 && (
          <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-brand-700">
            {t('{n} on', { n: active.toLocaleString() })}
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-300', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="pm-open px-3.5 pb-3">
          {note && <p className="mb-2 text-[11px] leading-snug text-muted">{t(note)}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

function Checks({ options, selected, onToggle, label, initial = 100, loading, color }: {
  options: { value: string; count: number }[];
  selected: string[];
  onToggle: (v: string) => void;
  label?: Record<string, string>;
  initial?: number;
  loading?: boolean;
  color: (value: string) => string;
}) {
  const t = useT();
  // bars are scaled to the group's largest option, so the shape of the group reads at a glance
  const top = Math.max(1, ...options.map((o) => o.count));
  const [all, setAll] = useState(false);
  // A selected option is always visible, even if it sits in the collapsed tail.
  const ordered = useMemo(() => {
    const sel = options.filter((o) => selected.includes(o.value));
    const rest = options.filter((o) => !selected.includes(o.value));
    return [...sel, ...rest];
  }, [options, selected]);

  if (loading) {
    return <div className="space-y-1.5">{[0, 1, 2].map((i) => (
      <div key={i} className="h-4 animate-pulse rounded bg-canvas" />
    ))}</div>;
  }
  if (!ordered.length) {
    return <p className="text-xs text-muted">{t('Nothing recorded for this filter.')}</p>;
  }

  const shown = all ? ordered : ordered.slice(0, initial);
  return (
    <>
      <ul className="space-y-0.5">
        {shown.map((o) => {
          const on = selected.includes(o.value);
          const hex = color(o.value);
          return (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => onToggle(o.value)}
                disabled={!on && o.count === 0}
                aria-pressed={on}
                className={cn(
                  'group flex min-h-[34px] w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition',
                  on ? 'bg-brand-50/70' : 'hover:bg-canvas',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                )}
              >
                <span className={cn(
                  'grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border transition',
                  on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-2 bg-white',
                )}>
                  {on && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hex }} aria-hidden="true" />
                    <span className={cn('min-w-0 flex-1 truncate text-[12.5px]',
                      on ? 'font-medium text-ink' : 'text-ink-2')} title={label?.[o.value] ? t(label[o.value]) : o.value}>
                      {label?.[o.value] ? t(label[o.value]) : o.value}
                    </span>
                  </span>
                  {o.count > 0 && (
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                      <span className="block h-full rounded-full transition-[width] duration-500"
                            style={{ width: `${Math.max(3, (o.count / top) * 100)}%`, background: hex }} />
                    </span>
                  )}
                </span>
                <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                  on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-ink-2')}>
                  {o.count.toLocaleString()}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {ordered.length > initial && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="mt-1.5 text-[11.5px] font-medium text-brand-600 hover:underline"
        >
          {all ? t('Show fewer') : t('Show all {n}', { n: ordered.length.toLocaleString() })}
        </button>
      )}
    </>
  );
}

function Radio({ options, value, onChange }: {
  options: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <ul className="space-y-0.5">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <li key={o.value || 'any'}>
            <button
              type="button"
              onClick={() => onChange(o.value)}
              aria-pressed={on}
              className={cn('group flex min-h-[32px] w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition',
                on ? 'bg-brand-50/70' : 'hover:bg-canvas')}
            >
              <span className={cn('grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border transition',
                on ? 'border-brand-600' : 'border-line-2')}>
                {on && <span className="h-[7px] w-[7px] rounded-full bg-brand-600" />}
              </span>
              <span className={cn('min-w-0 flex-1 truncate text-[12.5px]',
                on ? 'font-medium text-ink' : 'text-ink-2')}>{t(o.label)}</span>
              {o.count != null && (
                <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                  on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-ink-2')}>{o.count.toLocaleString()}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Search sits above the results, where the results are. */
export function RegulationSearch({ value, onChange }: {
  value: string; onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('Search regulations')} className="input w-full pl-9"
        placeholder={t('Search title, reference number, regulator, or text inside the document…')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2.5 top-2 grid h-5 w-5 place-items-center rounded text-muted-2 hover:bg-canvas hover:text-ink"
          aria-label={t('Clear search')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
