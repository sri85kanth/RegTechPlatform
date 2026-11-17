import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, ChevronLeft, Download, Link2, BadgeCheck, X } from 'lucide-react';
import type { Entity } from '@/types/entity';
import type { ColumnDef } from '@/config/domains';
import { Badge, Avatar, Tag, EmptyState } from '@/components/ui/primitives';
import { cn, getField } from '@/utils/ui';
import { entityById } from '@/services/entities';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { DomainTile } from '@/modules/registry/DomainTile';
import { PeoplePicker, ownerCandidates } from '@/components/PeoplePicker';
import { can, useMe } from '@/services/authApi';
import { useT } from '@/i18n';

/** The visible columns as a CSV download — owner shown by name, not id. */
export function exportCsv(rows: Entity[], columns: ColumnDef[], name = 'records') {
  const text = (e: Entity, c: ColumnDef) => {
    if (c.kind === 'name') return e.name;
    if (c.kind === 'person') return e.ownerId ? entityById(e.ownerId)?.name ?? e.ownerId : '';
    const v = getField(e, c.key);
    return v === undefined || v === null ? '' : String(v);
  };
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['ID', ...columns.map((c) => c.label)], ...rows.map((e) => [e.id, ...columns.map((c) => text(e, c))])]
    .map((r) => r.map(esc).join(','));
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

const PERSON_TYPES = /^(person|employee|external person)$/i;

/** A person's one-line role, from whatever their record carries. */
function roleOf(p: Entity): string | undefined {
  const v = p.attrs.role ?? p.attrs.jobTitle ?? p.attrs.designation ?? p.attrs.department;
  return v === undefined || v === '' ? undefined : String(v);
}

function Cell({ e, col, hideType, columns }: { e: Entity; col: ColumnDef; hideType?: boolean; columns?: ColumnDef[] }) {
  const t = useT();
  const raw = getField(e, col.key);
  const val = raw === undefined || raw === '' ? undefined : String(raw);
  switch (col.kind) {
    case 'name': {
      // second line: what the record says about itself, else its type, else its id —
      // but never a value another column on this row already shows (a Designation
      // column makes the designation under the name a repeat)
      const isPerson = e.domain === 'people' && PERSON_TYPES.test(e.type ?? '');
      const shown = new Set((columns ?? []).filter((c) => c.key !== col.key && c.kind !== 'person')
        .map((c) => String(getField(e, c.key) ?? '').trim().toLowerCase()).filter(Boolean));
      const fresh = (v?: string) => (v && !shown.has(v.trim().toLowerCase()) ? v : undefined);
      const sub = fresh(e.description && e.description !== e.name ? e.description : undefined)
        ?? fresh(isPerson ? roleOf(e) : undefined)
        ?? (!hideType ? fresh(e.type ?? e.id) : undefined);
      return (
        <div className="flex min-w-0 max-w-[13rem] items-center gap-3 min-[1400px]:max-w-[18rem] 2xl:max-w-[24rem]">
          {isPerson ? <Avatar name={e.name} size={32} /> : <DomainTile domain={e.domain} size="sm" />}
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink" title={e.name}>{e.name}</div>
            {sub && <div className="truncate text-xs text-muted" title={sub}>{sub}</div>}
          </div>
        </div>
      );
    }
    case 'person': {
      const person = e.ownerId ? entityById(e.ownerId) : undefined;
      if (!person) return <span className="text-xs font-medium text-muted-2">{t('Unassigned')}</span>;
      const role = roleOf(person);
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={person.name} size={30} />
          <div className="min-w-0 leading-tight">
            <div className="max-w-[11rem] truncate font-medium text-ink">{person.name}</div>
            {role && <div className="max-w-[11rem] truncate text-xs text-muted">{role}</div>}
          </div>
        </div>
      );
    }
    case 'status':
      return <Badge value={val} kind="status" />;
    case 'verification':
      return <Badge value={val} kind="verification" />;
    case 'criticality':
      return <Badge value={val} kind="criticality" />;
    case 'pill':
      return val ? <Tag tone="auto" title={val} className="!inline-block max-w-[11rem] truncate align-middle 2xl:max-w-[16rem]">{val}</Tag> : <span className="text-muted-2">—</span>;
    default:
      return <span className="block max-w-[150px] truncate text-ink-2 min-[1400px]:max-w-[190px] 2xl:max-w-[220px]" title={val}>{val ?? <span className="text-muted-2">—</span>}</span>;
  }
}

export function DataTable({
  rows,
  columns,
  onRowClick,
  contextLabel,
  noun = 'records',
}: {
  rows: Entity[];
  columns: ColumnDef[];
  onRowClick?: (e: Entity) => void;
  contextLabel?: (e: Entity) => string | undefined;
  /** plural, lower case — the pager reads "Showing 1–10 of 59 policies" */
  noun?: string;
}) {
  const t = useT();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { entities, relationships, verifyEntity, assignOwner } = useData();
  // selecting rows is only for bulk Verify / Assign / Export: those who cannot do them get no checkboxes
  const { data: me } = useMe();
  const canBulk = can(me, 'approve');
  // staff records are personal data: only an administrator exports them
  const canExport = rows[0]?.domain === 'people' ? can(me, 'administer') : canBulk;
  const openId = useUi((s) => s.openEntityId);
  const people = useMemo(() => ownerCandidates(entities), [entities]);
  // how many graph links each record has — one pass over the edges
  const links = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of relationships) {
      m.set(r.sourceId, (m.get(r.sourceId) ?? 0) + 1);
      m.set(r.targetId, (m.get(r.targetId) ?? 0) + 1);
    }
    return m;
  }, [relationships]);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = String(getField(a, sortKey) ?? '');
      const bv = String(getField(b, sortKey) ?? '');
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const clampPage = Math.min(page, pages);
  const pageRows = sorted.slice((clampPage - 1) * perPage, clampPage * perPage);
  const firstIndex = (clampPage - 1) * perPage;

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }
  function toggleRow(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));

  // The name cell's grey type line only helps when rows differ in type and no
  // Type column already says it.
  const hideType = useMemo(
    () => columns.some((c) => c.key === 'type') || new Set(rows.map((r) => r.type ?? '')).size <= 1,
    [columns, rows],
  );
  // Columns with no value on any row stay (the column is part of the record),
  // but read quieter so the filled columns carry the eye.
  const emptyCols = useMemo(() => {
    const out = new Set<string>();
    if (rows.length === 0) return out;
    for (const c of columns) {
      if (c.kind === 'name') continue;
      const has = rows.some((r) => {
        if (c.kind === 'person') return !!r.ownerId;
        const v = getField(r, c.key);
        return v !== undefined && v !== null && v !== '';
      });
      if (!has) out.add(c.key);
    }
    return out;
  }, [columns, rows]);

  // right-edge fade while the table is wider than its card
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);
  const measure = () => {
    const el = scroller.current;
    if (el) setFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageRows.length, columns.length]);
  const showPerPage = sorted.length > 10;

  // numbered pages: 1 … 4 5 6 … 32
  const nums: (number | '…')[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - clampPage) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }

  return (
    <div>
      {canBulk && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-brand-100 bg-brand-50 px-4 py-2 text-[13px] text-brand-700">
          <span className="grid h-6 min-w-6 place-items-center rounded-md bg-brand-600 px-1.5 text-xs font-semibold tabular-nums text-white">{selected.size}</span>
          <span className="font-medium">{t('selected')}</span>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              if (!window.confirm(`Mark ${selected.size} record(s) as verified?`)) return;
              selected.forEach((id) => verifyEntity(id));
              setSelected(new Set());
            }}
          >
            <BadgeCheck className="h-3.5 w-3.5" /> {t('Verify')}
          </button>
          <PeoplePicker
            compact
            className="w-56"
            people={people}
            placeholder={t('Assign owner to {n}…', { n: selected.size })}
            onPick={(owner) => {
              const name = people.find((p) => p.id === owner)?.name ?? 'this person';
              if (!window.confirm(`Make ${name} the owner of ${selected.size} record(s)?`)) return;
              selected.forEach((id) => assignOwner(id, owner));
              setSelected(new Set());
            }}
          />
          {canExport && (
            <button className="btn btn-sm" onClick={() => exportCsv(rows.filter((r) => selected.has(r.id)), columns)}>
              <Download className="h-3.5 w-3.5" /> {t('Export')}
            </button>
          )}
          <button className="btn btn-sm btn-ghost ml-auto" onClick={() => setSelected(new Set())}>
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      )}
      <div className="relative">
      <div ref={scroller} onScroll={measure} className="overflow-x-auto">
        {/* Below 1536px (most Windows laptops) the cells pad less and the name column is capped
            narrower, so the whole table fits the screen instead of scrolling sideways. */}
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-slate-200/80 bg-slate-50 text-left">
              {canBulk && (
                <th className="w-10 px-1.5 py-1">
                  <label className="grid h-8 w-8 cursor-pointer place-items-center rounded-md hover:bg-slate-100">
                    <input
                      type="checkbox"
                      aria-label="Select page"
                      className="h-4 w-4 rounded accent-brand-600"
                      checked={allOnPage}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (allOnPage) pageRows.forEach((r) => n.delete(r.id));
                          else pageRows.forEach((r) => n.add(r.id));
                          return n;
                        })
                      }
                    />
                  </label>
                </th>
              )}
              <th className="w-10 px-2 py-2.5 text-xs font-semibold text-muted">#</th>
              {contextLabel && <th className="whitespace-nowrap px-3 py-2.5 max-2xl:px-2 text-xs font-semibold text-muted">{t('Relationship')}</th>}
              {columns.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      'whitespace-nowrap px-3 py-2.5 max-2xl:px-2 text-xs font-semibold',
                      emptyCols.has(c.key) ? 'text-muted-2' : 'text-muted',
                      active && 'text-brand-700',
                      c.sortable && 'group cursor-pointer select-none hover:text-ink',
                    )}
                    onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                    onKeyDown={c.sortable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleSort(c.key); } } : undefined}
                    tabIndex={c.sortable ? 0 : undefined}
                    title={emptyCols.has(c.key) ? t('No values recorded yet') : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {t(c.label)}
                      {active ? (
                        sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                      ) : (
                        c.sortable && <ChevronsUpDown className="h-3 w-3 opacity-30 group-hover:opacity-60" aria-hidden="true" />
                      )}
                    </span>
                  </th>
                );
              })}
              <th className="whitespace-nowrap px-3 py-2.5 max-2xl:px-2 text-xs font-semibold text-muted" title={t('Links to other records in the company graph')}>{t('Links')}</th>
              <th className="w-8 px-2 py-2.5"><span className="sr-only">{t('Open')}</span></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((e, i) => {
              const isSel = selected.has(e.id);
              const isOpen = openId === e.id;
              const n = links.get(e.id) ?? 0;
              return (
                <tr
                  key={e.id}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={isSel || isOpen || undefined}
                  className={cn(
                    'group/row cursor-pointer border-b border-slate-100 transition-colors last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                    isOpen ? 'bg-brand-50 shadow-[inset_3px_0_0_#2563eb]' : isSel ? 'bg-brand-50/60 hover:bg-brand-50' : 'hover:bg-slate-50',
                  )}
                  onClick={() => onRowClick?.(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' && ev.target === ev.currentTarget) {
                      ev.preventDefault();
                      onRowClick?.(e);
                    }
                  }}
                >
                  {canBulk && (
                    <td className="px-1.5 py-1" onClick={(ev) => ev.stopPropagation()}>
                      <label className="grid h-8 w-8 cursor-pointer place-items-center rounded-md hover:bg-slate-100">
                        <input type="checkbox" className="h-4 w-4 rounded accent-brand-600" aria-label={`Select ${e.name}`} checked={isSel} onChange={() => toggleRow(e.id)} />
                      </label>
                    </td>
                  )}
                  <td className="px-2 py-2.5 text-xs tabular-nums text-muted">{firstIndex + i + 1}</td>
                  {contextLabel && (
                    <td className="px-3 py-2.5 max-2xl:px-2">
                      <span className="pill whitespace-nowrap bg-slate-100 text-slate-600">{contextLabel(e) ?? 'related'}</span>
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-3 py-2.5 max-2xl:px-2 align-middle', emptyCols.has(c.key) && 'opacity-60')}>
                      <Cell e={e} col={c} hideType={hideType} columns={columns} />
                    </td>
                  ))}
                  <td className="px-3 py-2.5 max-2xl:px-2">
                    <span
                      className={cn('inline-flex items-center gap-1 text-[13px] font-medium tabular-nums', n > 0 ? 'text-brand-600' : 'text-muted-2')}
                      title={`${n} ${n === 1 ? 'link' : 'links'} in the company graph`}
                    >
                      <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> {n}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-muted-2">
                    <ChevronRight className="h-4 w-4 transition group-hover/row:translate-x-0.5 group-hover/row:text-brand-600" aria-hidden="true" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {fade && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white to-transparent" aria-hidden="true" />
      )}
      </div>
      {sorted.length === 0 && <EmptyState title={t('No records match your filters.')} hint={t('Adjust filters or clear the search.')} icon="Filter" />}
      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-[13px] text-muted">
          <span>
            {t('Showing {from}–{to} of {total}', {
              from: (firstIndex + 1).toLocaleString(),
              to: Math.min(clampPage * perPage, sorted.length).toLocaleString(),
              total: sorted.length.toLocaleString(),
            })}{' '}
            {t(noun)}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {canExport && (
              <button className="btn btn-sm btn-ghost gap-1" onClick={() => exportCsv(sorted, columns)}>
                <Download className="h-3.5 w-3.5" /> {t('Export')}
              </button>
            )}
            {pages > 1 && (
              <nav className="flex items-center gap-1" aria-label={t('Pages')}>
                <button className="btn btn-sm h-8 w-8 px-0" disabled={clampPage <= 1} onClick={() => setPage(clampPage - 1)} aria-label={t('Previous page')}>
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {nums.map((p, k) =>
                  p === '…' ? (
                    <span key={`e${k}`} className="px-1" aria-hidden="true">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      aria-current={p === clampPage ? 'page' : undefined}
                      aria-label={t('Page {n}', { n: p })}
                      className={cn(
                        'h-8 min-w-8 rounded-lg px-2 text-[13px] font-medium tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100',
                        p === clampPage ? 'border border-brand-500 bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-100',
                      )}
                    >
                      {p}
                    </button>
                  ),
                )}
                <button className="btn btn-sm h-8 w-8 px-0" disabled={clampPage >= pages} onClick={() => setPage(clampPage + 1)} aria-label={t('Next page')}>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </nav>
            )}
            {showPerPage && (
              <select
                aria-label={t('Rows per page')}
                className="h-8 rounded-lg border border-line bg-white px-2 text-[12.5px] text-ink-2"
                value={perPage}
                onChange={(e) => {
                  setPerPage(Number(e.target.value));
                  setPage(1);
                }}
              >
                {[10, 25, 50].map((n) => (
                  <option key={n} value={n}>{t('{n} per page', { n })}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
