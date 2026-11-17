import { useEffect, useMemo, useState } from 'react';
import { useParams, NavLink, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search as SearchIcon, Download, SlidersHorizontal, X } from 'lucide-react';
import { DOMAINS, type DomainConfig, type Subtab, type AnyContentDomain } from '@/config/domains';
import { getDomainConfig } from '@/config/registry';
import type { DomainId, Entity } from '@/types/entity';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { DataTable, exportCsv } from '@/components/tables/DataTable';
import { Avatar, Badge, EmptyState } from '@/components/ui/primitives';
import { BarList, Donut } from '@/components/ui/charts';
import { AddEntityModal } from '@/components/forms/AddEntityModal';
import {
  entitiesForSubtab,
  ownershipRelations,
  historyForDomain,
  relatedContext,
} from '@/services/entities';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { cn, getField, plural } from '@/utils/ui';
import { registryVisual } from '@/config/companyBrain';
import { TabStrip } from '@/components/ui/TabStrip';
import { ActivityList, activityStyle } from '@/components/ActivityList';
import { ChartCard } from '@/modules/registry/ChartStrip';
import { DomainTile } from '@/modules/registry/DomainTile';
import { NONE, humanKey, CHART } from '@/modules/registry/visuals';
import { showValue } from '@/modules/departments/model';
import { can, useMe } from '@/services/authApi';
import { tx, useT } from '@/i18n';

export function EntityListPage() {
  const t = useT();
  const { domain, subtab } = useParams<{ domain: string; subtab?: string }>();
  const { data: me } = useMe();
  const openEntity = useUi((s) => s.openEntity);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const loading = useData((s) => s.loading); // subscribes for live updates too
  useData(); // re-render when the records change: the tab counts below read the store
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);

  // Filters are URL-addressable so attention items elsewhere can deep-link to a
  // filtered list, e.g. /risks/register?criticality=Critical,High (multi-value = comma).
  useEffect(() => {
    const next: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      if (k === 'q') setSearch(v);
      else next[k] = v;
    });
    setFilters(next);
  }, [searchParams]);

  // /controls is the compliance Controls page; the old config-driven controls
  // list only survived as /controls/<subtab> and showed a second, different set.
  if (domain === 'controls') return <Navigate to="/controls" replace />;
  // The other regulatory "domains" (regulators, clauses, obligations, changes,
  // sources) have no data source and were always empty; the library is the page.
  if (domain?.startsWith('reg-')) return <Navigate to="/reg-regulations" replace />;
  const config = getDomainConfig(domain);
  if (!config) return <Navigate to="/" replace />;
  const hasRows = (s: Subtab) => s.kind !== 'entities' || entitiesForSubtab(config.id, s).length > 0;
  const firstWithData = config.subtabs.find((s) => s.kind === 'entities' && hasRows(s));
  // The main tab is the first record list that has records (Equipment, not an
  // empty Applications); it always shows.
  const mainTab = firstWithData ?? config.subtabs[0];
  const mayApprove = can(me, 'approve');
  // People's export is personal data, so it is for administrators only.
  const mayExport = config.id === 'people' ? can(me, 'administer') : mayApprove;
  const tabCount = (s: Subtab): number | undefined => {
    if (loading) return undefined;
    if (s.kind === 'history') return historyForDomain(config.id).length;
    if (s.kind === 'ownership') return ownershipRelations().length;
    return entitiesForSubtab(config.id, s).length;
  };
  // Any other tab with nothing in it is hidden (Teams, Ownership, a related
  // Data or Controls list…), so the tab row lists only what exists. A URL that
  // names a hidden tab shows the main tab instead.
  // Until the store has loaded, every tab shows — otherwise they would all flash away.
  // Verification and History always show, but only to those who may approve.
  const keepTab = (s: Subtab) =>
    s.kind === 'verification' || s.kind === 'history'
      ? mayApprove
      : loading || s === mainTab || (tabCount(s) ?? 0) > 0;
  const tabs = config.subtabs.filter(keepTab);
  const current: Subtab = tabs.find((s) => s.id === subtab) ?? mainTab;
  // A Regulation is a regulatory instrument — open its dedicated instrument viewer,
  // not the generic entity drawer.
  const openRow = (e: Entity) => (e.domain === 'reg-regulations' ? navigate(`/regulation/${e.id}`) : openEntity(e.id));

  return (
    <>
      <Topbar
        title={config.title}
        subtitle={config.description}
        icon={config.icon}
        tone={toneFor(config.id)}
        actions={
          mayExport || mayApprove ? (
            <>
              {mayExport && (
                <button
                  className="btn btn-outline"
                  onClick={() => exportCsv(entitiesForSubtab(config.id, current), current.columns ?? config.columns, `${config.id}-${current.id}`)}
                >
                  <Download className="h-4 w-4" /> {t('Export')}
                </button>
              )}
              {mayApprove && (
                <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> {t('Add {noun}', { noun: t(config.entityNoun) })}
                </button>
              )}
            </>
          ) : undefined
        }
        below={
          <TabStrip
            ariaLabel={t('{name} sections', { name: t(config.title) })}
            tabs={tabs.map((s) => {
              const n = tabCount(s);
              return { key: s.id, label: n === undefined ? s.label : `${t(s.label)} (${n.toLocaleString()})` };
            })}
            active={current.id}
            onChange={(id) => navigate(`/${config.id}/${id}`)}
          />
        }
      />

      <div className="space-y-4 p-6">
        {current.kind === 'ownership' ? (
          <OwnershipView />
        ) : current.kind === 'history' ? (
          <HistoryView domain={config.id} />
        ) : (
          <ListView config={config} subtab={current} search={search} setSearch={setSearch} filters={filters} setFilters={setFilters} onOpen={openRow} />
        )}
      </div>

      {addOpen && <AddEntityModal config={config} onClose={() => setAddOpen(false)} />}
    </>
  );
}

/** What the rows are called in running text — "employees", "equipment", "policies". Translate where drawn. */
const UNCOUNTED: Record<string, string> = { Equipment: tx('equipment'), 'External Person': tx('external personnel'), Evidence: tx('evidence'), Person: tx('people') };
function rowNoun(filterType: string | undefined, entityNoun: string): string {
  const n = filterType ?? entityNoun;
  return UNCOUNTED[n] ?? plural(n).toLowerCase();
}

function ListView({
  config,
  subtab,
  search,
  setSearch,
  filters,
  setFilters,
  onOpen,
}: {
  config: DomainConfig;
  subtab: Subtab;
  search: string;
  setSearch: (v: string) => void;
  filters: Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
  onOpen: (e: Entity) => void;
}) {
  const t = useT();
  const { entities } = useData(); // live store — rows must recompute when it hydrates
  const [moreOpen, setMoreOpen] = useState(false);
  const isRelated = subtab.kind === 'related' && subtab.relatedDomain;
  const displayConfig = isRelated ? DOMAINS[subtab.relatedDomain!] : config;
  // a subtab may carry its own columns when it lists a different entity type
  const columns = subtab.columns ?? displayConfig.columns;

  // `entities` is a dependency because entitiesForSubtab reads the live store,
  // which now hydrates asynchronously from the database.
  const baseRows = useMemo(() => entitiesForSubtab(config.id, subtab), [config.id, subtab, entities]);

  // filter option values derived from the visible rows
  // (a filter with nothing to choose from is left out unless it is in use)
  const filterDefs = displayConfig.filters
    .map((key) => {
      const label = columns.find((c) => c.key === key)?.label ?? humanKey(key);
      const options = Array.from(new Set(baseRows.map((r) => getField(r, key)).filter((v): v is string | number => v !== undefined && v !== '')));
      return { key, label, options: options.map(String).sort((a, b) => a.localeCompare(b)) };
    })
    .filter((f) => f.options.length > 0 || (filters[f.key] && filters[f.key] !== 'All'));
  const shownDefs = moreOpen ? filterDefs : filterDefs.slice(0, 4);
  const extraDefs = filterDefs.length - 4;

  // A tab filters on one type. When that type has no records but a sibling tab
  // does, saying "no records match your filters" sends the reader looking for a
  // filter that is not there — 413 employees sat one tab away, invisible.
  const elsewhere = useMemo(
    () =>
      config.subtabs
        .filter((s) => s.kind === 'entities' && s.id !== subtab.id)
        .map((s) => ({ subtab: s, n: entitiesForSubtab(config.id, s).length }))
        .filter((x) => x.n > 0),
    [config.id, config.subtabs, subtab.id, entities],
  );

  const rows = baseRows.filter((e) => {
    for (const [k, v] of Object.entries(filters)) {
      if (!v || v === 'All') continue;
      const cell = String(getField(e, k) ?? '');
      // comma-separated values act as an OR set (e.g. criticality=Critical,High);
      // the (none) token matches a record with no value for the field
      const wanted = v.split(',');
      if (!wanted.includes(cell) && !(cell === '' && wanted.includes(NONE))) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const hay = [e.name, e.type, e.description, ...Object.values(e.attrs).map(String)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const active = Object.entries(filters).filter(([, v]) => v && v !== 'All');
  const labelFor = (k: string) => columns.find((c) => c.key === k)?.label ?? filterDefs.find((f) => f.key === k)?.label ?? humanKey(k);
  const valueText = (k: string, v: string) =>
    v.split(',').map((x) => (x === NONE ? (k === 'ownerId' ? t('No owner') : t('Not recorded')) : k === 'ownerId' ? entities.find((p) => p.id === x)?.name ?? x : showValue(k, x))).join(', ');
  const nounPlural = rowNoun(!isRelated && subtab.kind === 'entities' ? subtab.filterType : undefined, displayConfig.entityNoun);

  return (
    <>
      <div className="card overflow-hidden">
        {/* filter bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-4 py-3">
          <div className="relative w-full sm:w-64">
            <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" aria-hidden="true" />
            <input
              className="input h-9 pl-9"
              placeholder={t('Search {noun}…', { noun: t(nounPlural) })}
              aria-label={t('Search {noun}', { noun: t(nounPlural) })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {shownDefs.map((f) => {
            const cur = filters[f.key] ?? 'All';
            const custom = cur !== 'All' && !f.options.includes(cur);
            return (
              <label key={f.key} className="flex items-center gap-2 text-[13px] text-muted">
                <span className="whitespace-nowrap">{t(f.label)}</span>
                <select
                  aria-label={t('Filter by {field}', { field: t(f.label).toLowerCase() })}
                  className={cn(
                    'h-9 max-w-[11rem] truncate rounded-lg border bg-white px-2.5 text-[13px] font-medium focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100',
                    cur !== 'All' ? 'border-brand-300 text-brand-700' : 'border-line text-ink-2',
                  )}
                  value={cur}
                  onChange={(e) => setFilters({ ...filters, [f.key]: e.target.value })}
                >
                  <option value="All">{t('All')}</option>
                  {custom && <option value={cur}>{valueText(f.key, cur)}</option>}
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {showValue(f.key, o)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {extraDefs > 0 && (
            <button className="btn btn-sm h-9" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen}>
              <SlidersHorizontal className="h-4 w-4" /> {moreOpen ? t('Fewer filters') : t('More Filters ({n})', { n: extraDefs })}
            </button>
          )}
          <div className="ml-auto flex items-center gap-3 text-[13px] text-muted">
            <span>
              {rows.length !== baseRows.length
                ? t('{n} of {total} records', { n: rows.length.toLocaleString(), total: baseRows.length.toLocaleString() })
                : rows.length === 1 ? t('1 record') : t('{n} records', { n: rows.length.toLocaleString() })}
            </span>
            {(search || active.length > 0) && (
              <button
                className="font-medium text-brand-600 hover:underline"
                onClick={() => {
                  setSearch('');
                  setFilters({});
                }}
              >
                {t('Clear all')}
              </button>
            )}
          </div>
        </div>

        {active.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-slate-50/60 px-4 py-2">
            <span className="text-xs text-muted">{t('Filtered by')}</span>
            {active.map(([k, v]) => (
              <span key={k} className="pill bg-brand-50 pr-1 text-brand-700">
                <span className="text-brand-600/80">{t(labelFor(k))}:</span> {valueText(k, v)}
                <button
                  className="grid h-4 w-4 place-items-center rounded hover:bg-brand-100"
                  aria-label={t('Remove {field} filter', { field: t(labelFor(k)) })}
                  onClick={() => {
                    const next = { ...filters };
                    delete next[k];
                    setFilters(next);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {baseRows.length === 0 && elsewhere.length > 0 ? (
          <div className="px-4 py-10 text-center">
            <DomainTile domain={displayConfig.id} size="lg" className="mx-auto" />
            <p className="mt-3 text-[13.5px] font-semibold text-ink">
              {t('No {things} have been collected.', { things: t(plural(subtab.label.toLowerCase())) })}
            </p>
            <p className="mt-1 text-[12.5px] text-muted">{t('The records that were collected are here:')}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {elsewhere.map(({ subtab: s, n }) => (
                <NavLink key={s.id} to={`/${config.id}/${s.id}`} className="btn btn-sm btn-outline">
                  {t(s.label)} <span className="ml-1 tabular-nums">{n.toLocaleString()}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            onRowClick={onOpen}
            noun={nounPlural}
            contextLabel={isRelated ? (e) => relatedContext(config.id, e.id) : undefined}
          />
        )}
      </div>
    </>
  );
}

function OwnershipView() {
  const t = useT();
  const openEntity = useUi((s) => s.openEntity);
  useData();
  const rows = ownershipRelations();

  // who owns the most, and what kind of records are owned — counted from the edges
  const byOwner = new Map<string, number>();
  const byDomain = new Map<string, number>();
  for (const { person, target } of rows) {
    byOwner.set(person.name, (byOwner.get(person.name) ?? 0) + 1);
    byDomain.set(target.domain, (byDomain.get(target.domain) ?? 0) + 1);
  }
  const topOwners = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const domains = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      {rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title={t('Records owned, by domain')} icon="PieChart" tone="purple" note={t('{n} ownership links', { n: rows.length.toLocaleString() })}>
            <Donut
              size={140}
              thickness={18}
              sub={t('owned')}
              data={domains.map(([d, n]) => ({
                label: DOMAINS[d as Exclude<DomainId, 'overview'>]?.title ?? d,
                value: n,
                color: registryVisual(d).hex,
              }))}
            />
          </ChartCard>
          <ChartCard title={t('Top owners')} icon="UserCheck" tone="brand" note={t('{n} owners', { n: byOwner.size.toLocaleString() })}>
            <BarList data={topOwners.map(([name, n], i) => ({ label: name, value: n, color: CHART[i % CHART.length] }))} />
          </ChartCard>
        </div>
      )}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3 text-[13px] text-muted">
          <DomainTile domain="people" size="sm" />
          <span>
            {t('Ownership is modelled as relationships — Person → owns → Entity (never duplicated).')}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No ownership links yet" hint="Assign an owner on any record and it appears here." icon="UserX" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-slate-50 text-left">
                  {['#', tx('Owner'), tx('Owns'), tx('Record'), tx('Domain')].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted">
                      {t(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ person, target }, i) => (
                  <tr
                    key={person.id + target.id}
                    tabIndex={0}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-brand-50/40 focus-visible:bg-brand-50/40 focus-visible:outline-none"
                    onClick={() => openEntity(target.id)}
                    onKeyDown={(ev) => ev.key === 'Enter' && openEntity(target.id)}
                  >
                    <td className="px-4 py-2.5 tabular-nums text-muted">{i + 1}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar name={person.name} size={28} />
                        <span className="font-medium text-ink">{person.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{t('owns')}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <DomainTile domain={target.domain} size="xs" />
                        <span className="font-semibold text-ink">{target.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge value={t(DOMAINS[target.domain as Exclude<DomainId, 'overview'>]?.title ?? target.domain)} kind="plain" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function HistoryView({ domain }: { domain: AnyContentDomain }) {
  const t = useT();
  useData();
  const events = historyForDomain(domain);
  if (events.length === 0) return <div className="card"><EmptyState title="No change history yet." icon="History" /></div>;

  const byAction = new Map<string, number>();
  const byActor = new Map<string, number>();
  for (const h of events) {
    const a = h.action.trim().toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    byAction.set(a, (byAction.get(a) ?? 0) + 1);
    byActor.set(h.by, (byActor.get(h.by) ?? 0) + 1);
  }
  const toneHex: Record<string, string> = {
    green: '#16a34a', red: '#dc2626', orange: '#f97316', amber: '#f59e0b', brand: '#2563eb', neutral: '#2563eb',
    purple: '#8b5cf6', teal: '#14b8a6', gray: '#94a3b8',
  };
  const actions = [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const actors = [...byActor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={t('Changes by kind')} icon="Activity" tone="teal" note={t('{n} events', { n: events.length.toLocaleString() })}>
          <BarList data={actions.map(([a, n]) => ({ label: a, value: n, color: toneHex[activityStyle(a).tone] ?? '#94a3b8' }))} />
        </ChartCard>
        <ChartCard title={t('Changes by person')} icon="UserRound" tone="brand" note={byActor.size === 1 ? t('1 actor') : t('{n} actors', { n: byActor.size.toLocaleString() })}>
          <BarList data={actors.map(([a, n], i) => ({ label: a, value: n, color: CHART[i % CHART.length] }))} />
        </ChartCard>
      </div>
      <ActivityList items={events} />
    </>
  );
}
