import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, FolderTree, Inbox, Layers, MapPin, Search } from 'lucide-react';
import type { FiledRecord } from '@/services/structureApi';
import { cn } from '@/utils/ui';
import {
  byName, flagsOf, groupBy, items, matches, pathTail, plural, showValue, unitWordText,
  type Described, type Group,
} from './model';
import { useT } from '@/i18n';
import { IconTile } from '@/components/ui/primitives';
import { StackedBar } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { accentAt, deptIcon, type Accent } from './accent';
import { CodeBadge, Details, ValueBadge } from './ui';

const FIRST = 50;        // items shown per group before "show more"
const SPLIT = 8;         // more items than this in one group are broken into their types

/**
 * The department as a tree, organised by whichever field the person picks.
 *
 *   Biomedical
 *   ├─ OT Complex · 92          Life support 3 · Critical 45
 *   │  ├─ Multipara monitor · 20
 *   │  │  └─ each unit, with its asset ID, status and where it is
 *   │  └─ …
 *   └─ No department given · 33
 *
 * By location the same records nest Hospital > Building > Floor > Area > Room,
 * each placed where its own location ends. Nothing is dropped: a record
 * without the chosen field sits in a group that says so.
 *
 * The rows are render functions, not components declared in here: a component
 * declared inside another is a new type on every render, and the whole tree
 * would be torn down and rebuilt each time a branch was opened.
 */
export function StructureTab({
  title, kindLabel, rows, d, by, onBy, unitWord, caveats = {}, registers, register = '', onRegister, perRegister,
}: {
  title: string; kindLabel: string; rows: FiledRecord[]; d: Described;
  by: string; onBy: (key: string) => void; unitWord: string; caveats?: Record<string, string>;
  /** when the department holds several registers: which one the tree reads ('' for all) */
  registers?: { id: string; label: string; n: number }[]; register?: string; onRegister?: (id: string) => void;
  /** reading every register at once: what a branch holds, register by register, in place of status flags */
  perRegister?: (records: FiledRecord[]) => { label: string; n: number }[];
}) {
  const t = useT();
  const facet = d.facets.find((f) => f.key === by) ?? d.facets[0];
  const [q, setQ] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, number>>({});

  const shown = useMemo(() => rows.filter((r) => matches(r, q.trim())), [rows, q]);
  const missingLabel = facet?.kind === 'units'
    ? t('No {unit} given', { unit: unitWordText(t, unitWord) })
    : t('{field} not given', { field: t(facet?.label ?? '') });
  const groups = useMemo(() => (facet ? groupBy(shown, facet, missingLabel) : []), [shown, facet, missingLabel]);
  const splitByType = !!d.names && facet !== d.names;

  // Everything a group would reveal, so "Expand all" opens it in one go.
  const allIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (g: Group) => {
      ids.push(g.id);
      g.groups.forEach(walk);
      if (splitByType && g.items.length > SPLIT) byName(g.items, g.id).forEach((x) => ids.push(x.id));
    };
    groups.forEach(walk);
    return ids;
  }, [groups, splitByType]);

  // A chain of single groups — Hospital > Building — opens by itself: there is
  // nothing to choose between until the tree actually branches.
  const autoOpen = useMemo(() => {
    const ids = new Set<string>();
    // "Location not given" sits beside the chain, not in it.
    let level = groups.filter((g) => !g.missing);
    while (level.length === 1) {
      ids.add(level[0].id);
      level = level[0].groups;
    }
    return ids;
  }, [groups]);

  if (!facet) {
    return <p className="card p-4 text-[12.5px] text-muted">{t('These records carry no field that groups them.')}</p>;
  }

  const searching = !!q.trim();
  const isOpen = (id: string) => searching || opened.has(id) || (autoOpen.has(id) && !closed.has(id));
  const toggle = (id: string) => {
    const now = isOpen(id);
    setOpened((s) => { const n = new Set(s); if (now) n.delete(id); else n.add(id); return n; });
    setClosed((s) => { const n = new Set(s); if (now) n.add(id); else n.delete(id); return n; });
  };
  const choose = (key: string) => { onBy(key); setOpened(new Set()); setClosed(new Set()); };

  // What each item says beside its name: the other groupings, briefly.
  const secondary = d.facets.filter((f) => f !== facet && f !== d.status && f !== d.criticality && f !== d.names).slice(0, 3);
  const describeItem = (r: FiledRecord) => secondary.map((f) => {
    const v = f.get(r);
    if (!v) return null;
    if (f.kind === 'units') return f.values.find((x) => x.key === v)?.label ?? null;
    if (f.kind === 'path') return pathTail(v);
    return showValue(f.key, v);
  }).filter(Boolean).join(' · ');

  const flags = (records: FiledRecord[]) => (
    <span className="flex flex-wrap items-center gap-1">
      {perRegister
        ? perRegister(records).map((x) => <span key={x.label} className="text-[11.5px] text-muted">{x.label}</span>)
          .flatMap((el, i) => (i ? [<span key={`sep${i}`} className="text-muted-2">·</span>, el] : [el]))
        : flagsOf(records, d).map((f) => <ValueBadge key={f.label} tone={f.tone}>{f.label} {f.n}</ValueBadge>)}
    </span>
  );

  const row = (id: string, icon: ReactNode, label: ReactNode, records: FiledRecord[], missing?: boolean, extra?: ReactNode, chip = 'bg-slate-100 text-ink-2') => (
    <button onClick={() => toggle(id)} aria-expanded={isOpen(id)}
      className="group flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-50">
      {isOpen(id) ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-2" />}
      {icon}
      <span className={cn('text-[13px] font-semibold', missing ? 'italic text-muted' : 'text-ink')}>{label}</span>
      <span className={cn('rounded-full px-2 py-px text-[11px] font-semibold tabular-nums', chip)}>{records.length.toLocaleString()}</span>
      {flags(records)}
      {extra && <span className="ml-auto">{extra}</span>}
    </button>
  );

  const itemRows = (list: FiledRecord[], id: string) => {
    const limit = more[id] ?? FIRST;
    return (
      <ul className="space-y-px">
        {list.slice(0, limit).map((r) => (
          <li key={r.id}>
            <button onClick={() => setOpenRecord((o) => (o === r.id ? null : r.id))} aria-expanded={openRecord === r.id}
              className={cn('flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-slate-50',
                openRecord === r.id && 'bg-brand-50/50')}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
              <span className="text-[12.5px] font-medium text-ink">{r.name}</span>
              {r.source_reference && <span className="text-[11px] text-muted">{r.source_reference}</span>}
              <span className="text-[11.5px] text-muted">{describeItem(r)}</span>
              <span className="ml-auto flex items-center gap-1">
                {d.criticality && <CodeBadge field="criticality" value={r.criticality} />}
                {d.status && <CodeBadge field="status" value={r.status} />}
              </span>
            </button>
            {openRecord === r.id && <div className="py-1.5 pl-5 pr-1"><Details r={r} caveats={caveats} fields={register ? d.fields : undefined} /></div>}
          </li>
        ))}
        {list.length > limit && (
          <li>
            <button onClick={() => setMore((m) => ({ ...m, [id]: limit + FIRST }))}
              className="ml-5 mt-1 text-[12px] font-medium text-brand-600 hover:underline">
              {t('Show {n} more of {total}', { n: Math.min(FIRST, list.length - limit), total: list.length - limit })}
            </button>
          </li>
        )}
      </ul>
    );
  };

  /** A group's own records, broken into their types when there are many. */
  const contents = (g: Group) => {
    if (!g.items.length) return null;
    if (!(splitByType && g.items.length > SPLIT)) return itemRows(g.items, g.id);
    return byName(g.items, g.id).map((x) => (
      <div key={x.id}>
        {row(x.id, <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-500"><Layers className="h-3.5 w-3.5" /></span>, x.label, x.all)}
        {isOpen(x.id) && <Branch>{itemRows(x.items, x.id)}</Branch>}
      </div>
    ));
  };

  // each top-level group keeps one colour down its whole branch
  const groupNode = (g: Group, a: Accent): ReactNode => (
    <div key={g.id}>
      {row(g.id,
        <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md', g.missing ? 'bg-slate-100 text-slate-400' : a.tile)}>
          {g.missing ? <Inbox className="h-3.5 w-3.5" />
            : facet.kind === 'path' ? <MapPin className="h-3.5 w-3.5" />
              : facet.kind === 'units' ? <Icon name={deptIcon(g.label)} className="h-3.5 w-3.5" />
                : <FolderTree className="h-3.5 w-3.5" />}
        </span>,
        g.label, g.all, g.missing,
        facet.kind === 'units' && !g.missing ? (
          <Link to={`/departments/${g.id.slice(g.id.indexOf(':') + 1)}`} onClick={(e) => e.stopPropagation()}
            className="text-[11.5px] font-medium text-brand-600 opacity-0 transition group-hover:opacity-100 hover:underline">
            {t('Open {name}', { name: g.label })} ›
          </Link>
        ) : undefined,
        g.missing ? undefined : a.chip)}
      {isOpen(g.id) && (
        <Branch>
          {g.groups.map((c) => groupNode(c, a))}
          {contents(g)}
        </Branch>
      )}
    </div>
  );

  const valued = groups.filter((g) => !g.missing).length;
  const without = groups.find((g) => g.missing)?.all.length ?? 0;
  const noun = facet.kind === 'units' ? unitWord : facet.label.toLowerCase();
  const field = t(facet.label).toLowerCase();
  const organised = searching
    ? t('{items} matching “{q}”, organised by {field}', { items: items(shown.length), q: q.trim(), field })
    : t('{items}, organised by {field}', { items: items(shown.length), field });
  const nounText = (n: number) => (facet.kind === 'units' ? unitWordText(t, unitWord, n) : t(plural(noun, n)));

  return (
    <div className="space-y-3">
      <div className="card space-y-3 p-3.5">
        {registers && onRegister && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] font-medium text-muted">{t('Register')}</span>
            {[{ id: '', label: 'All registers', n: registers.reduce((n, r) => n + r.n, 0) }, ...registers].map((r) => (
              <button key={r.id || 'all'} onClick={() => onRegister(r.id)} aria-pressed={r.id === register}
                className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition',
                  r.id === register ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-ink-2 hover:border-line-2 hover:bg-slate-50')}>
                {t(r.label)} <span className="text-muted">{r.n.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] font-medium text-muted">{t('Organise by')}</span>
          {d.facets.map((f) => (
            <button key={f.key} onClick={() => choose(f.key)} aria-pressed={f === facet}
              className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition',
                f === facet ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-ink-2 hover:border-line-2 hover:bg-slate-50')}>
              {t(f.label)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1 sm:max-w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2" />
            <input className="input pl-9" placeholder={t('Find a {kind} by name, number or any detail…', { kind: kindLabel.toLowerCase() })}
              value={q} onChange={(e) => setQ(e.target.value)}
              autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
          </label>
          <button className="btn btn-sm" onClick={() => { setOpened(new Set(allIds)); setClosed(new Set()); }}>{t('Expand all')}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setOpened(new Set()); setClosed(new Set(autoOpen)); }}>{t('Collapse all')}</button>
        </div>
      </div>

      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 pb-2.5">
          <IconTile icon="ListTree" tone="brand" size="sm" />
          <span className="text-sm font-semibold text-ink">{t(title)}</span>
          <span className="text-[12.5px] text-muted">
            {organised}
            {facet.kind !== 'path' && <> — {valued} {nounText(valued)}</>}
            {without > 0 && <>, {t('and {n} with no {thing} given', { n: without, thing: facet.kind === 'units' ? unitWordText(t, unitWord) : field })}</>}
          </span>
          {flags(shown)}
        </div>
        {groups.length > 1 && (
          <StackedBar className="mx-2 mt-2.5" height={10} legend={groups.length <= 10}
            data={groups.map((g, i) => ({ label: g.label, value: g.all.length, color: g.missing ? '#cbd5e1' : accentAt(i).hex }))} />
        )}
        {caveats[facet.key] && (
          <p className="mx-2 mt-2 rounded-md bg-warning-50 px-2.5 py-1.5 text-[12px] text-warning-600">
            ⚠ <b>{t(facet.label)}:</b> {caveats[facet.key]}
          </p>
        )}
        <div className="pt-1.5">
          {groups.length === 0
            ? <p className="px-2 py-6 text-center text-[12.5px] text-muted">{t('Nothing matches “{q}”.', { q })}</p>
            : groups.map((g, i) => groupNode(g, accentAt(i)))}
        </div>
      </div>
    </div>
  );
}

function Branch({ children }: { children: ReactNode }) {
  return <div className="ml-[15px] border-l border-line pl-2.5">{children}</div>;
}
