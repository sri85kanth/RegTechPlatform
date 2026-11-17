/**
 * The regulatory library filter system.
 *
 * TWO RULES SHAPE THIS COMPONENT
 * ------------------------------
 * 1. Every option is backed by a record. Counts come from /api/regulations/facets,
 *    computed under the current selection by the same clause that filters the
 *    list — so the number beside an option is what pressing it returns, and an
 *    option that would return nothing says 0 rather than looking available.
 *
 * 2. A filter the data cannot answer says so. The backend reports availability
 *    per filter; where coverage is zero the control is shown disabled with the
 *    reason, instead of rendering a dropdown that silently returns an empty list.
 *    A filter that looks like it works and does not is worse than one that is
 *    honestly marked unavailable.
 *
 * WHERE A REGULATION APPLIES IS NOT WHO ISSUED IT
 * -----------------------------------------------
 * The State/UT control filters on applicability. An all-India instrument matches
 * every region, which is why selecting Telangana returns RBI Master Directions.
 * The note under that control says so on screen, because a user who selects a
 * state and sees 1,600 central regulations deserves to know why.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, SlidersHorizontal, X, Check, ChevronDown, Info, Database,
} from 'lucide-react';
import {
  EMPTY_FILTERS, type RegulationFilters, type RegulationFacets, type FacetValue,
} from '@/services/regulationsApi';
import { cn } from '@/utils/ui';
import { tMaybe, tx, useT } from '@/i18n';

/* ------------------------------------------------------------------ helpers */

export const REGULATION_TYPES = [
  tx('Act'), tx('Rule'), tx('Regulation'), tx('Notification'), tx('Circular'), tx('Direction'),
  tx('Master Direction'), tx('Master Circular'), tx('Order'), tx('Guideline'), tx('Standard'),
  tx('Advisory'), tx('Scheme'), tx('Policy'), tx('Gazette Notification'), tx('Other'),
];
export const IMPORTANCE = ['Critical', 'High', 'Medium', 'Low'];
export const APPLICABILITY = ['APPLICABLE', 'CONDITIONAL', 'NOT_APPLICABLE', 'REVIEW_REQUIRED', 'UNKNOWN'];
export const APPLICABILITY_LABEL: Record<string, string> = {
  APPLICABLE: tx('Applicable'), CONDITIONAL: tx('Conditional'), NOT_APPLICABLE: tx('Not applicable'),
  REVIEW_REQUIRED: tx('Review required'), UNKNOWN: tx('Unknown'),
};
export const COLLECTION = ['DISCOVERED', 'MAPPED'];
export const COLLECTION_LABEL: Record<string, string> = {
  DISCOVERED: tx('Discovered'), MAPPED: tx('Mapped & analysed'),
};

/* ------------------------------------------------------------------ colours */

/**
 * Severity keeps one meaning everywhere on the regulatory screens:
 * Critical red, High orange, Medium amber, Low slate.
 */
export const IMPORTANCE_HEX: Record<string, string> = {
  Critical: '#dc2626', High: '#ea580c', Medium: '#f59e0b', Low: '#94a3b8',
};
export const IMPORTANCE_CHIP: Record<string, string> = {
  Critical: 'bg-critical-50 text-critical-600 ring-critical-200',
  High: 'bg-notcov-50 text-notcov-600 ring-notcov-200',
  Medium: 'bg-warning-50 text-warning-600 ring-warning-200',
  Low: 'bg-slate-100 text-slate-600 ring-slate-200',
};

/**
 * Applicability verdicts. Both verdicts that reach us are green (conditional a
 * lighter green — it applies, qualified, it is not a "maybe"); review is
 * indigo, excluded slate, never assessed the palest grey.
 */
export const APPLICABILITY_HEX: Record<string, string> = {
  APPLICABLE: '#16a34a', CONDITIONAL: '#4ade80', REVIEW_REQUIRED: '#6366f1',
  NOT_APPLICABLE: '#94a3b8', UNKNOWN: '#cbd5e1',
};

/** Pipeline stages — progress in blue/violet, waiting in amber, failure in red. */
export const COLLECTION_HEX: Record<string, string> = {
  MAPPED: '#8b5cf6', STRUCTURED: '#6366f1', EXTRACTED: '#0ea5e9', PARSING: '#38bdf8',
  DISCOVERED: '#2563eb', OCR_REQUIRED: '#f59e0b', FAILED: '#dc2626', FAILED_FETCH: '#ef4444',
};

/**
 * A regulator keeps one colour everywhere — the tile on its cards, its bar in
 * the chart, the dot in the filter rail. Picked by a stable hash of the short
 * name, so "NABH" is always the same hue.
 */
const REGULATOR_PALETTE = [
  { hex: '#2563eb', ink: '#1d4ed8', tile: 'bg-blue-50 text-blue-700' },
  { hex: '#8b5cf6', ink: '#6d28d9', tile: 'bg-violet-50 text-violet-700' },
  { hex: '#14b8a6', ink: '#0f766e', tile: 'bg-teal-50 text-teal-700' },
  { hex: '#f59e0b', ink: '#b45309', tile: 'bg-amber-50 text-amber-700' },
  { hex: '#ec4899', ink: '#be185d', tile: 'bg-pink-50 text-pink-700' },
  { hex: '#0ea5e9', ink: '#0369a1', tile: 'bg-sky-50 text-sky-700' },
  { hex: '#10b981', ink: '#047857', tile: 'bg-emerald-50 text-emerald-700' },
  { hex: '#6366f1', ink: '#4338ca', tile: 'bg-indigo-50 text-indigo-700' },
  { hex: '#f97316', ink: '#c2410c', tile: 'bg-orange-50 text-orange-700' },
  { hex: '#a855f7', ink: '#7e22ce', tile: 'bg-purple-50 text-purple-700' },
];
export function regulatorColor(short: string | null | undefined) {
  const s = (short || '?').trim().toUpperCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return REGULATOR_PALETTE[h % REGULATOR_PALETTE.length];
}

/** Merge the option vocabulary with real counts; unknown options count 0. */
export function withCounts(options: string[], facets: FacetValue[] | undefined) {
  const byValue = new Map((facets ?? []).map((f) => [f.value, f.count]));
  return options.map((value) => ({ value, count: byValue.get(value) ?? 0 }));
}

function useClickAway<T extends HTMLElement>(onAway: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onAway]);
  return ref;
}

/* ------------------------------------------------------------- multi-select */

function MultiSelect({
  label, options, selected, onChange, disabled, disabledReason, width = 'w-44', groups,
}: {
  label: string;
  options: { value: string; count: number; label?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  disabledReason?: string | null;
  width?: string;
  groups?: { title: string; values: string[] }[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return n ? options.filter((o) => (o.label ? t(o.label) : o.value).toLowerCase().includes(n)) : options;
  }, [options, needle, t]);

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const summary = selected.length === 0 ? t('All')
    : selected.length === 1 ? (tMaybe(t, options.find((o) => o.value === selected[0])?.label) ?? selected[0])
    : t('{n} selected', { n: selected.length.toLocaleString() });

  const render = (list: { value: string; count: number; label?: string }[]) =>
    list.map((o) => (
      <button
        key={o.value}
        type="button"
        onClick={() => toggle(o.value)}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-canvas',
          o.count === 0 && !selected.includes(o.value) && 'opacity-45',
        )}
      >
        <span className={cn(
          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border',
          selected.includes(o.value) ? 'border-brand-500 bg-brand-500 text-white' : 'border-line',
        )}>
          {selected.includes(o.value) && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-2">{o.label ? t(o.label) : o.value}</span>
        <span className="shrink-0 tabular-nums text-[11px] text-muted">{o.count.toLocaleString()}</span>
      </button>
    ));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        title={disabled ? disabledReason ?? undefined : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-[10px] border px-2.5 py-1.5 text-[12.5px] transition',
          width,
          disabled ? 'cursor-not-allowed border-line bg-canvas text-muted-2'
                   : selected.length ? 'border-brand-400 bg-brand-50 text-brand-700'
                   : 'border-line bg-surface text-ink-2 hover:border-brand-300',
        )}
      >
        <span className="shrink-0 text-muted">{t(label)}</span>
        <span className="min-w-0 flex-1 truncate text-right font-medium">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-2" />
      </button>

      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-80 w-64 overflow-hidden rounded-[10px] border border-line bg-surface shadow-lg">
          {options.length > 8 && (
            <div className="border-b border-line p-1.5">
              <input
                autoFocus
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder={t('Find {label}…', { label: t(label).toLowerCase() })}
                className="input h-7 w-full text-[12px]"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {groups
              ? groups.map((g) => {
                  const list = shown.filter((o) => g.values.includes(o.value));
                  if (!list.length) return null;
                  return (
                    <div key={g.title}>
                      <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold text-muted">
                        {t(g.title)}
                      </div>
                      {render(list)}
                    </div>
                  );
                })
              : render(shown)}
            {!shown.length && (
              <div className="px-2.5 py-3 text-[12px] text-muted">{t('No matching options')}</div>
            )}
          </div>
          {selected.length > 0 && (
            <div className="border-t border-line px-2 py-1.5">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[11.5px] font-medium text-brand-600 hover:underline"
              >
                {t('Clear {label}', { label: t(label).toLowerCase() })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- filter bar */

export function RegulationFilterBar({
  filters, setFilters, facets, resultCount, loading,
}: {
  filters: RegulationFilters;
  setFilters: (f: RegulationFilters) => void;
  facets: RegulationFacets | undefined;
  resultCount: number;
  loading?: boolean;
}) {
  const t = useT();
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState(filters);
  useEffect(() => { if (drawer) setDraft(filters); }, [drawer, filters]);

  const set = <K extends keyof RegulationFilters>(k: K, v: RegulationFilters[K]) =>
    setFilters({ ...filters, [k]: v });

  const avail = facets?.availability ?? {};
  const can = (k: string) => avail[k]?.available !== false;
  const why = (k: string) => avail[k]?.note ?? null;

  const states = facets?.vocabulary.states ?? [];
  const uts = facets?.vocabulary.unionTerritories ?? [];
  const regionOptions = useMemo(() => {
    const byValue = new Map((facets?.regions ?? []).map((r) => [r.value, r.count]));
    const all = facets?.allIndiaCount ?? 0;
    // An all-India instrument applies in every region, so each region's real
    // total is its own specific records PLUS every central one.
    return [...states, ...uts].map((v) => ({ value: v, count: (byValue.get(v) ?? 0) + all }));
  }, [facets, states, uts]);

  const chips = useMemo(() => {
    const out: { key: string; label: string; remove: () => void }[] = [];
    const arrChip = (k: keyof RegulationFilters, prefix: string, fmt?: (v: string) => string) =>
      (filters[k] as string[]).forEach((v) =>
        out.push({
          key: `${k}:${v}`,
          label: prefix ? `${prefix}: ${fmt ? fmt(v) : v}` : (fmt ? fmt(v) : v),
          remove: () => set(k, (filters[k] as string[]).filter((x) => x !== v) as never),
        }));
    if (filters.q) out.push({ key: 'q', label: `“${filters.q}”`, remove: () => set('q', '') });
    if (filters.jurisdiction !== 'All')
      out.push({ key: 'j', label: t(filters.jurisdiction), remove: () => set('jurisdiction', 'All') });
    arrChip('state_ut', '');
    arrChip('sector', '');
    arrChip('regulator', '');
    arrChip('regulation_type', '', (v) => t(v));
    arrChip('importance', t('Importance'), (v) => t(v));
    arrChip('applicability', t('Applicability'), (v) => t(APPLICABILITY_LABEL[v] ?? v));
    arrChip('collection_status', t('Collection'), (v) => t(COLLECTION_LABEL[v] ?? v));
    if (filters.source_verification)
      out.push({ key: 'sv', label: `${t('Source')}: ${t(filters.source_verification)}`, remove: () => set('source_verification', '') });
    if (filters.issued_from)
      out.push({ key: 'df', label: t('Issued from {date}', { date: filters.issued_from }), remove: () => set('issued_from', '') });
    if (filters.issued_to)
      out.push({ key: 'dt', label: t('Issued to {date}', { date: filters.issued_to }), remove: () => set('issued_to', '') });
    return out;
  }, [filters, t]);

  const lib = facets?.library;

  return (
    <div className="mb-4 space-y-2.5">
      {/* ---- search ---- */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
        <input
          value={filters.q}
          onChange={(e) => set('q', e.target.value)}
          className="input w-full pl-9"
          placeholder={t('Search title, reference number, regulator, or text inside the document…')}
        />
        {filters.q && (
          <button
            type="button"
            onClick={() => set('q', '')}
            className="absolute right-2.5 top-2 grid h-5 w-5 place-items-center rounded text-muted-2 hover:bg-canvas hover:text-ink"
            aria-label={t('Clear search')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* ---- primary row ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <MultiSelect
          label="Jurisdiction" width="w-48"
          options={[
            { value: tx('India'), count: facets?.allIndiaCount ?? 0, label: 'All India' },
            { value: tx('State'), count: (facets?.regions ?? []).filter((r) => r.kind === 'STATE').length, label: 'State-specific' },
            { value: tx('Union Territory'), count: (facets?.regions ?? []).filter((r) => r.kind === 'UT').length, label: 'UT-specific' },
          ]}
          selected={filters.jurisdiction === 'All' ? [] : [filters.jurisdiction]}
          onChange={(v) => set('jurisdiction', v.length ? v[v.length - 1] : 'All')}
        />
        <MultiSelect
          label="State / UT" width="w-48"
          options={regionOptions}
          groups={[{ title: 'States', values: states }, { title: 'Union Territories', values: uts }]}
          selected={filters.state_ut}
          onChange={(v) => set('state_ut', v)}
        />
        <MultiSelect
          label="Sector" width="w-44"
          options={withCounts(
            [...(facets?.vocabulary.sectors ?? []), 'Unclassified'], facets?.sectors)
            .map((o) => (o.value === 'Unclassified' ? { ...o, label: tx('Unclassified') } : o))}
          selected={filters.sector}
          onChange={(v) => set('sector', v)}
        />
        <MultiSelect
          label="Regulator" width="w-44"
          options={(facets?.regulators ?? []).map((r) => ({ value: r.value, count: r.count }))}
          selected={filters.regulator}
          onChange={(v) => set('regulator', v)}
        />
        <MultiSelect
          label="Type" width="w-48"
          options={withCounts(REGULATION_TYPES, facets?.regulationTypes).map((o) => ({ ...o, label: o.value }))}
          selected={filters.regulation_type}
          onChange={(v) => set('regulation_type', v)}
        />
        <MultiSelect
          label="Collection" width="w-48"
          options={withCounts(COLLECTION, facets?.collectionStatuses).map((o) => ({
            ...o, label: COLLECTION_LABEL[o.value] ?? o.value,
          }))}
          selected={filters.collection_status}
          onChange={(v) => set('collection_status', v)}
        />

        <button
          type="button"
          onClick={() => setDrawer(true)}
          className={cn('btn btn-ghost btn-sm gap-1.5',
            Boolean(filters.importance.length || filters.applicability.length ||
              filters.source_verification || filters.issued_from || filters.issued_to)
              && 'border-brand-400 bg-brand-50 text-brand-700')}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('Advanced')}
        </button>
      </div>

      {/* ---- why a state returns central regulations ---- */}
      {filters.state_ut.length > 0 && (
        <div className="flex items-start gap-2 rounded-card border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
          <span>
            {t('Showing regulations that apply in {places} — not only those issued there. {n} all-India instruments apply in every state and are included.', {
              places: filters.state_ut.join(', '), n: (facets?.allIndiaCount ?? 0).toLocaleString(),
            })}
          </span>
        </div>
      )}

      {/* ---- active filters + count ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] font-semibold text-ink">
          {loading ? t('Filtering…')
            : resultCount === 1 ? t('{n} regulatory record', { n: resultCount.toLocaleString() })
            : t('{n} regulatory records', { n: resultCount.toLocaleString() })}
        </span>
        {lib && (
          <span className="text-xs text-muted">
            {t('of {sourced} with a source · {extracted} extracted · {analysed} analysed', {
              sourced: lib.withSourceUrl.toLocaleString(),
              extracted: lib.documentsExtracted.toLocaleString(),
              analysed: lib.mapped.toLocaleString(),
            })}
          </span>
        )}
        {chips.length > 0 && <span className="mx-1 h-3 w-px bg-line-2" />}
        {chips.map((c) => (
          <span key={c.key}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2 pr-1 text-[11.5px] font-medium text-brand-700">
            {c.label}
            <button type="button" onClick={c.remove}
                    className="grid h-4 w-4 place-items-center rounded-full hover:bg-brand-100"
                    aria-label={t('Remove {label}', { label: c.label })}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {chips.length > 0 && (
          <button type="button" onClick={() => setFilters({ ...EMPTY_FILTERS })}
                  className="text-[11.5px] font-medium text-muted hover:text-ink hover:underline">
            {t('Clear all')}
          </button>
        )}
      </div>

      {/* ---- advanced drawer ---- */}
      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setDrawer(false)} />
          <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl">
            <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="text-sm font-semibold text-ink">{t('Advanced filters')}</h2>
              <button type="button" onClick={() => setDrawer(false)}
                      className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-canvas">
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <Group title="Importance"
                     note={t('Computed impact score · {n} of {total} records scored', {
                       n: (avail.importance?.records ?? 0).toLocaleString(), total: (facets?.library.discovered ?? 0).toLocaleString(),
                     })}>
                <Pills options={withCounts(IMPORTANCE, facets?.importance)}
                       selected={draft.importance}
                       onChange={(v) => setDraft({ ...draft, importance: v })} />
              </Group>

              <Group title="Applicability"
                     note={t('A separate question from importance — a Critical regulation can still be Not applicable.')}>
                <Pills options={withCounts(APPLICABILITY, facets?.applicability)
                          .map((o) => ({ ...o, label: APPLICABILITY_LABEL[o.value] ?? o.value }))}
                       selected={draft.applicability}
                       onChange={(v) => setDraft({ ...draft, applicability: v })} />
              </Group>

              <Group title="Source verification"
                     note={t('{n} records have a verified source document.', { n: (avail.source_verification?.records ?? 0).toLocaleString() })}>
                <Pills single
                       options={[{ value: tx('Verified'), count: avail.source_verification?.records ?? 0 },
                                 { value: tx('Not Verified'), count: (facets?.total ?? 0) - (avail.source_verification?.records ?? 0) }]}
                       selected={draft.source_verification ? [draft.source_verification] : []}
                       onChange={(v) => setDraft({ ...draft, source_verification: v[0] ?? '' })} />
              </Group>

              <Group title="Issued date"
                     note={can('effective_date')
                       ? null
                       : why('effective_date')}>
                <div className="flex items-center gap-2">
                  <input type="date" value={draft.issued_from}
                         onChange={(e) => setDraft({ ...draft, issued_from: e.target.value })}
                         className="input h-8 flex-1 text-[12.5px]" />
                  <span className="text-[12px] text-muted">{t('to')}</span>
                  <input type="date" value={draft.issued_to}
                         onChange={(e) => setDraft({ ...draft, issued_to: e.target.value })}
                         className="input h-8 flex-1 text-[12.5px]" />
                </div>
              </Group>

              <Unavailable avail={avail} />
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
              <button type="button"
                      onClick={() => setDraft({ ...EMPTY_FILTERS, q: draft.q })}
                      className="btn btn-ghost btn-sm">{t('Clear all')}</button>
              <button type="button"
                      onClick={() => { setFilters(draft); setDrawer(false); }}
                      className="btn btn-primary btn-sm">{t('Apply filters')}</button>
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ drawer parts */

function Group({ title, note, children }: { title: string; note?: string | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <section>
      <h3 className="text-[12.5px] font-semibold text-ink">{t(title)}</h3>
      {note && <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-muted">{note}</p>}
      <div className={note ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

function Pills({ options, selected, onChange, single }: {
  options: { value: string; count: number; label?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  single?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(single ? (on ? [] : [o.value])
                                           : on ? selected.filter((x) => x !== o.value)
                                                : [...selected, o.value])}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition',
              on ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                 : 'border-line bg-surface text-ink-2 hover:border-brand-300',
              o.count === 0 && !on && 'opacity-45',
            )}
          >
            {t(o.label ?? o.value)}
            <span className="tabular-nums text-[11px] text-muted">{o.count.toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Filters the spec asks for that this database cannot answer yet. Naming them
 * is the point: a compliance user needs to know the library is not being
 * narrowed by version or effective date, rather than assuming it was.
 */
function Unavailable({ avail }: { avail: Record<string, { available: boolean; note: string | null }> }) {
  const missing = Object.entries(avail)
    .filter(([k, v]) => !k.startsWith('_') && v && v.available === false && v.note);
  const t = useT();
  if (!missing.length) return null;
  return (
    <section className="rounded-card border border-line bg-canvas px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5 text-muted-2" />
        <h3 className="text-[12.5px] font-semibold text-ink">{t('Not available on this data')}</h3>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {missing.map(([k, v]) => (
          <li key={k} className="text-[11.5px] leading-relaxed text-muted">
            <b className="text-ink-2">{k.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase())}</b> — {v.note}
          </li>
        ))}
      </ul>
    </section>
  );
}
