import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BarChart3, ChevronDown, ChevronRight, Download, Search, Table2, X } from 'lucide-react';
import type { FiledRecord, NodeSource, OrgNode } from '@/services/structureApi';
import { cn } from '@/utils/ui';
import {
  amountFieldOf, byId, countOf, dateFieldOf, demoOrigin, formatWhen, isWithin, matches, partsOf, pathTail,
  registerColumns, rupees, showValue, TONE_CLASS, TONE_RANK, toneOf, unitWordText, valueKey,
  type Described, type Facet, type KindGroup,
} from './model';
import { tx, useT } from '@/i18n';
import { IconTile, Tag } from '@/components/ui/primitives';
import { StackedBar } from '@/components/ui/charts';
import { TONE_HEX } from './accent';
import { CodeBadge, DemoBadge, Details, ValueBadge } from './ui';

const PAGE = 100;

export type Filters = {
  unit?: string; status?: string; crit?: string; fk?: string; fv?: string; missing?: string;
  /** "demo" or "imported" — by the origin the source itself states */
  origin?: string;
};

export type RegisterView = 'table' | 'breakdown';

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One register, laid out like the source's own page: its columns, in its
 * order, under its names — Entry date, Supplier, Invoice no, Amount, Status —
 * newest first, with what the register adds up to above it.
 *
 * Every row opens to everything the source sent about it. The same records
 * can be read as a breakdown instead; every number there opens its rows here.
 */
export function RegisterTab({
  group, title, source, d, flat, node, unitWord, filters: asked, setFilters, caveats = {}, view, onView, breakdown,
}: {
  group: KindGroup; title: string; source?: NodeSource; d: Described; flat: OrgNode[]; node?: OrgNode; unitWord: string;
  filters: Filters; setFilters: (f: Filters) => void; caveats?: Record<string, string>;
  view: RegisterView; onView: (v: RegisterView) => void; breakdown: () => ReactNode;
}) {
  const t = useT();
  // A filter from a stale or hand-edited link that names no known value is
  // dropped, not applied: otherwise the table shows nothing while every
  // dropdown still reads "Any", and the empty register looks like missing data.
  const { unit, status, crit, fk, fv, missing, origin } = asked;
  const filters = useMemo<Filters>(() => {
    const known = (f: Facet | undefined, v?: string) => (v && f?.values.some((x) => x.key === v) ? v : undefined);
    const byKey = fk ? d.facets.find((f) => f.key === fk) : undefined;
    return {
      unit: unit === 'own' || known(d.facets.find((f) => f.kind === 'units'), unit) ? unit : undefined,
      status: known(d.status, status),
      crit: known(d.criticality, crit),
      fk: known(byKey, fv) ? fk : undefined,
      fv: known(byKey, fv),
      missing: d.fields.some((f) => f.key === missing) ? missing : undefined,
      origin: origin === 'demo' || origin === 'imported' ? origin : undefined,
    };
  }, [unit, status, crit, fk, fv, missing, origin, d]);

  const columns = useMemo(() => registerColumns(group, d), [group, d]);
  const dateField = useMemo(() => dateFieldOf(d.fields, group.rows), [d, group.rows]);
  const amountField = useMemo(() => amountFieldOf(d.fields), [d]);
  // Registers are read newest first, as the source keeps them.
  const firstSort = dateField && columns.some((c) => c.key === dateField.key)
    ? { key: dateField.key, dir: -1 as const } : { key: columns[0]?.key ?? 'name', dir: 1 as const };

  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>(firstSort);

  const nodes = useMemo(() => byId(flat), [flat]);
  const units = d.facets.find((f) => f.kind === 'units');
  const facet = filters.fk ? d.facets.find((f) => f.key === filters.fk) : undefined;
  const missingField = filters.missing ? d.fields.find((f) => f.key === filters.missing) : undefined;
  // a verdict other than status — a walk-through's finding — gets a filter of its own
  const verdict = d.signals.find((f) => f !== d.status && f !== d.criticality && f.kind === 'value');
  const toned = useMemo(() => new Map(d.signals.map((f) => [f.key, f])), [d]);

  const cell = useCallback((key: string, r: FiledRecord): string | undefined => {
    if (key === 'name') return r.name;
    if (key === 'type') return r.type ?? undefined;
    if (key === 'status') return r.status ?? undefined;
    if (key === 'criticality') return r.criticality ?? undefined;
    return d.fields.find((f) => f.key === key)?.get(r);
  }, [d]);

  const filtered = useMemo(() => {
    const unitNode = filters.unit && filters.unit !== 'own' ? nodes.get(filters.unit) : undefined;
    const needle = q.trim();
    const rank = (key: string, v?: string) => (v && (key === 'status' || key === 'criticality') ? TONE_RANK[toneOf(v)] : 9);
    return group.rows
      .filter((r) =>
        (!filters.unit || (filters.unit === 'own' ? r.org_node_id === node?.id
          : !!unitNode && isWithin(nodes.get(r.org_node_id ?? ''), unitNode)))
        && (!filters.status || !d.status || valueKey(d.status, r) === filters.status)
        && (!filters.crit || !d.criticality || valueKey(d.criticality, r) === filters.crit)
        && (!facet || valueKey(facet, r) === filters.fv)
        && (!missingField || missingField.get(r) === undefined)
        && (!filters.origin || (filters.origin === 'demo') === !!demoOrigin(r))
        && matches(r, needle))
      .sort((a, b) => {
        const x = cell(sort.key, a), y = cell(sort.key, b);
        if (!x !== !y) return x ? -1 : 1;                   // blanks last, whichever way
        const byRank = rank(sort.key, x) - rank(sort.key, y);
        if (byRank) return byRank * sort.dir;
        if (x && y && NUMBER.test(x) && NUMBER.test(y)) return (Number(x) - Number(y)) * sort.dir;
        return (x ?? '').localeCompare(y ?? '', undefined, { numeric: true, sensitivity: 'base' }) * sort.dir;
      });
  }, [group.rows, filters, nodes, node, d, facet, missingField, q, sort, cell]);

  const visible = filtered.slice(0, limit);
  const set = (patch: Filters) => { setFilters({ ...filters, ...patch }); setLimit(PAGE); };
  const chips: { label: string; clear: Filters }[] = [];
  if (facet && filters.fv) {
    const v = facet.values.find((x) => x.key === filters.fv);
    chips.push({ label: t('{field}: {value}', { field: t(facet.label), value: v?.label ?? filters.fv }), clear: { fk: undefined, fv: undefined } });
  }
  if (missingField) chips.push({ label: t('No {field} given', { field: t(missingField.label).toLowerCase() }), clear: { missing: undefined } });
  if (filters.origin) {
    chips.push({ label: filters.origin === 'demo' ? t('Created by the source’s demo loader') : t('Imported records only'),
      clear: { origin: undefined } });
  }
  const demoCount = useMemo(() => group.rows.filter((r) => demoOrigin(r)).length, [group.rows]);

  const unitCounts = useMemo(() => (units ? units.values.map((u) => ({
    ...u, n: group.rows.filter((r) => units.get(r) === u.key).length,
  })).filter((u) => u.n) : []), [units, group.rows]);
  const ownCount = node && units ? group.rows.filter((r) => r.org_node_id === node.id).length : 0;

  // What the register adds up to — all of it above, what is shown below.
  const sum = (rows: FiledRecord[]) => (amountField ? rows.reduce((n, r) => n + (Number(amountField.get(r)) || 0), 0) : 0);
  const span = useMemo(() => {
    if (!dateField) return null;
    const dates = group.rows.map((r) => dateField.get(r)).filter(Boolean).sort() as string[];
    if (!dates.length) return null;
    const [from, to] = [formatWhen(dates[0].slice(0, 10)), formatWhen(dates[dates.length - 1].slice(0, 10))];
    return from === to ? from : `${from} – ${to}`;
    // `t`: the dates are worded in the chosen language
  }, [dateField, group.rows, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = useMemo(() => sum(group.rows), [group.rows, amountField]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = () => {
    const extra = d.fields.filter((f) => f.key !== 'name' && !columns.some((c) => c.key === f.key));
    const lines = [[...columns.map((c) => c.label), ...extra.map((f) => f.label), 'Reference', 'Confirmed'].map(csv).join(',')];
    for (const r of filtered) {
      lines.push([
        ...columns.map((c) => cell(c.key, r) ?? ''),
        ...extra.map((f) => f.get(r) ?? ''),
        r.source_reference ?? '', r.verification === 'Pending' ? 'No' : 'Yes',
      ].map(csv).join(','));
    }
    const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), {
      href: url, download: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  const signalOf = d.status ?? verdict ?? d.criticality;
  const select = 'input w-auto min-w-[150px] pr-8 text-[13px]';
  return (
    <div className="space-y-3">
      <section className="card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <IconTile icon={signalOf ? 'ClipboardList' : 'Layers'} tone="brand" size="md" />
          <div className="min-w-0 flex-1">
            <h2 className="sec-title">{t(title)}</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              <b className="text-ink">{countOf(group.label, group.rows.length)}</b>
              {amountField && <> · {t('{amount} in total', { amount: rupees(Math.round(total * 100) / 100) })}</>}
              {span && <> · {span}</>}
              {source && <> · {t('from {sources}', { sources: source.label })}</>}
              {source?.lastSyncAt && <>, {t('collected {when}', { when: formatWhen(source.lastSyncAt) })}</>}
            </p>
          </div>
          <div role="tablist" aria-label={t('How to read this register')} className="inline-flex rounded-lg border border-line p-0.5">
            {([['table', tx('Table'), Table2], ['breakdown', tx('Breakdown'), BarChart3]] as const).map(([v, label, Icon]) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => onView(v)}
                className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12.5px] font-medium transition',
                  view === v ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-ink')}>
                <Icon className="h-3.5 w-3.5" /> {t(label)}
              </button>
            ))}
          </div>
        </div>
        {(signalOf || demoCount > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {signalOf && <span className="mr-1 text-[12px] font-medium text-muted">{t(signalOf.label)}</span>}
            {signalOf?.values.map((v) => {
              const patch: Filters = signalOf === d.status ? { status: v.key } : signalOf === d.criticality ? { crit: v.key } : { fk: signalOf.key, fv: v.key };
              const on = signalOf === d.status ? filters.status === v.key : signalOf === d.criticality ? filters.crit === v.key : filters.fk === signalOf.key && filters.fv === v.key;
              return (
                <button key={v.key} aria-pressed={on} onClick={() => { onView('table'); set(on ? { status: undefined, crit: undefined, fk: undefined, fv: undefined } : patch); }}
                  className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-offset-1 transition hover:brightness-95', TONE_CLASS[v.tone], on && 'ring-2 ring-brand-500')}>
                  {v.label} <span className="font-semibold">{v.n.toLocaleString()}</span>
                </button>
              );
            })}
            {demoCount > 0 && (
              <button onClick={() => { onView('table'); set({ origin: filters.origin === 'demo' ? undefined : 'demo' }); }}
                aria-pressed={filters.origin === 'demo'}
                title={t('Records the source marks as written by its demo loader, not imported from its register')}
                className={cn('ml-auto rounded-full bg-warning-50 px-2.5 py-0.5 text-[12px] font-semibold text-warning-600 ring-offset-1',
                  filters.origin === 'demo' && 'ring-2 ring-brand-500')}>
                {t('Demo-loaded')} {demoCount}
              </button>
            )}
          </div>
        )}
        {signalOf && signalOf.values.length > 1 && (
          <StackedBar className="mt-3" height={8} legend={false}
            data={signalOf.values.map((v) => ({ label: t('{field}: {value}', { field: t(signalOf.label), value: v.label }), value: v.n, color: TONE_HEX[v.tone] }))} />
        )}
      </section>

      {view === 'breakdown' ? breakdown() : (
        <>
          <div className="card space-y-2.5 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2" />
                <input className="input pl-9" placeholder={t('Search by number, name or any detail…')}
                  value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
                  autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
              </label>
              {units && (unitCounts.length > 0 || ownCount > 0) && (
                <select className={select} value={filters.unit ?? ''} aria-label={t('Filter by {field}', { field: unitWordText(t, unitWord) })}
                  onChange={(e) => set({ unit: e.target.value || undefined })}>
                  <option value="">{t('Every {unit}', { unit: unitWordText(t, unitWord) })}</option>
                  {unitCounts.map((u) => <option key={u.key} value={u.key}>{u.label} ({u.n})</option>)}
                  {ownCount > 0 && <option value="own">{t('No {unit} given', { unit: unitWordText(t, unitWord) })} ({ownCount})</option>}
                </select>
              )}
              {d.status && (
                <select className={select} value={filters.status ?? ''} aria-label={t('Filter by {field}', { field: t(d.status.label).toLowerCase() })}
                  onChange={(e) => set({ status: e.target.value || undefined })}>
                  <option value="">{t('Any {field}', { field: t(d.status.label).toLowerCase() })}</option>
                  {d.status.values.map((v) => <option key={v.key} value={v.key}>{v.label} ({v.n})</option>)}
                </select>
              )}
              {d.criticality && (
                <select className={select} value={filters.crit ?? ''} aria-label={t('Filter by {field}', { field: t(d.criticality.label).toLowerCase() })}
                  onChange={(e) => set({ crit: e.target.value || undefined })}>
                  <option value="">{t('Any {field}', { field: t(d.criticality.label).toLowerCase() })}</option>
                  {d.criticality.values.map((v) => <option key={v.key} value={v.key}>{v.label} ({v.n})</option>)}
                </select>
              )}
              {verdict && (
                <select className={select} value={filters.fk === verdict.key ? filters.fv ?? '' : ''}
                  aria-label={t('Filter by {field}', { field: t(verdict.label).toLowerCase() })}
                  onChange={(e) => set(e.target.value ? { fk: verdict.key, fv: e.target.value } : { fk: undefined, fv: undefined })}>
                  <option value="">{t('Any {field}', { field: t(verdict.label).toLowerCase() })}</option>
                  {verdict.values.map((v) => <option key={v.key} value={v.key}>{v.label} ({v.n})</option>)}
                </select>
              )}
              {demoCount > 0 && (
                <select className={select} value={filters.origin ?? ''} aria-label={t('Filter by origin')}
                  onChange={(e) => set({ origin: e.target.value || undefined })}>
                  <option value="">{t('Imported and demo')}</option>
                  <option value="imported">{t('Imported only ({n})', { n: group.rows.length - demoCount })}</option>
                  <option value="demo">{t('Demo-loaded only ({n})', { n: demoCount })}</option>
                </select>
              )}
              <button className="btn btn-sm btn-outline ml-auto" onClick={download} disabled={!filtered.length}
                title={t('Download the rows shown, with every field the source sent')}>
                <Download className="h-3.5 w-3.5" /> {t('Download CSV')}
              </button>
            </div>
            {columns.filter((c) => caveats[c.key]).map((c) => (
              <p key={c.key} className="text-[12px] text-warning-600">⚠ <b>{t(c.label)}:</b> {caveats[c.key]}</p>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>
                {filtered.length === group.rows.length
                  ? t('All {count}', { count: countOf(group.label, group.rows.length) })
                  : t('Showing {n} of {count}', { n: filtered.length.toLocaleString(), count: countOf(group.label, group.rows.length) })}
                {amountField && filtered.length !== group.rows.length && <> · {rupees(Math.round(sum(filtered) * 100) / 100)}</>}
              </span>
              {chips.map((c) => (
                <button key={c.label} onClick={() => set(c.clear)}
                  className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 font-medium text-brand-700 hover:bg-brand-100">
                  {c.label} <X className="h-3 w-3" />
                </button>
              ))}
              {(filtered.length !== group.rows.length) && (
                <button className="font-medium text-brand-600 hover:underline"
                  onClick={() => { setQ(''); setFilters({}); setLimit(PAGE); }}>{t('Clear all filters')}</button>
              )}
              <span className="ml-auto hidden sm:inline">{t('Click a row for everything the source sent about it.')}</span>
            </div>
          </div>

          <div className="card overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-[12.5px]">
                <thead className="border-b border-line bg-slate-50">
                  <tr>
                    <th className="w-10 px-3 py-2.5 text-right text-xs font-medium text-muted">#</th>
                    {columns.map((c, i) => (
                      <th key={c.key} className={cn('whitespace-nowrap px-3 py-2.5', i === 0 && 'min-w-[170px]', c.numeric && 'text-right')}
                        aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                        <button onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                          className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink">
                          {t(c.label)}
                          {caveats[c.key] && <span title={caveats[c.key]} className="text-warning-600">⚠</span>}
                          {sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visible.map((r, ri) => (
                    <Fragment key={r.id}>
                      <tr onClick={() => setExpanded((x) => (x === r.id ? null : r.id))}
                        className={cn('cursor-pointer align-top transition-colors hover:bg-slate-50', expanded === r.id && 'bg-brand-50/60')}>
                        <td className={cn('px-3 py-2 text-right text-[11.5px] tabular-nums text-muted-2', expanded === r.id && 'border-l-2 border-l-brand-500')}>{ri + 1}</td>
                        {columns.map((c, i) => {
                          const v = cell(c.key, r);
                          const shown = v === undefined ? '—' : partsOf(v).length > 2 ? pathTail(v) : showValue(c.key, v);
                          if (i === 0) {
                            return (
                              <td key={c.key} className="px-3 py-2">
                                <button aria-expanded={expanded === r.id}
                                  onClick={(e) => { e.stopPropagation(); setExpanded((x) => (x === r.id ? null : r.id)); }}
                                  className="flex items-start gap-1.5 text-left font-medium text-ink">
                                  {expanded === r.id
                                    ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                                    : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />}
                                  <span className={cn(c.key === d.reference?.key && 'font-mono text-[12px]')}>{shown}</span>
                                  <DemoBadge r={r} />
                                </button>
                              </td>
                            );
                          }
                          if (c.key === 'status' || c.key === 'criticality') {
                            return <td key={c.key} className="px-3 py-2"><CodeBadge field={c.key} value={v} /></td>;
                          }
                          if (c.key === 'type' && v !== undefined) {
                            return <td key={c.key} className="px-3 py-2"><Tag tone="auto">{v}</Tag></td>;
                          }
                          const signal = toned.get(c.key);
                          if (signal && v !== undefined) {
                            const tone = signal.values.find((x) => x.key === valueKey(signal, r))?.tone ?? 'neutral';
                            return <td key={c.key} className="px-3 py-2"><ValueBadge tone={tone} title={v}>{shown}</ValueBadge></td>;
                          }
                          return (
                            <td key={c.key} title={v && shown !== v ? v : v && v.length > 40 ? v : undefined}
                              className={cn('max-w-[260px] truncate px-3 py-2',
                                v === undefined ? 'text-muted-2' : 'text-ink-2',
                                c.numeric && 'text-right tabular-nums',
                                c.key === d.reference?.key && 'font-mono text-[11.5px]')}>
                              {shown}
                            </td>
                          );
                        })}
                      </tr>
                      {expanded === r.id && (
                        <tr>
                          <td colSpan={columns.length + 1} className="bg-canvas px-3 pb-3 pt-1"><Details r={r} caveats={caveats} fields={d.fields} /></td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-[12.5px] text-muted">{t('Nothing in this register matches these filters.')}</p>
            )}
            {filtered.length > visible.length && (
              <div className="border-t border-line p-2 text-center">
                <button className="btn btn-sm btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  {t('Show {n} more', { n: Math.min(PAGE, filtered.length - visible.length) })}
                  <span className="text-muted-2">· {t('{n} left', { n: (filtered.length - visible.length).toLocaleString() })}</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One CSV cell. A leading = + - @ is neutralised so a spreadsheet never runs it as a formula. */
function csv(v: string): string {
  const s = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
