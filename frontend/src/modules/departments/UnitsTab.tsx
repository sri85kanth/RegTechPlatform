import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox } from 'lucide-react';
import type { FiledRecord } from '@/services/structureApi';
import { BarList } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import { byName, countOf, flagsOf, items, unitWordText, type Described, type KindGroup } from './model';
import { useT } from '@/i18n';
import { accentAt, deptIcon, type Accent } from './accent';
import { Panel, ValueBadge } from './ui';

/**
 * Each sub-unit as a card that says what is in it — not just how much.
 * "OT Complex · 92 items · Life support 3 · Critical 45 · mostly Multipara
 * monitor 20, Syringe pump 10" instead of "OT Complex · 92 records".
 * Above the cards, the same counts as one bar chart, in the cards' colours.
 */
export function UnitsTab({ rows, d, unitWord, kinds = [], onUnassigned }: {
  rows: FiledRecord[]; d: Described; unitWord: string; kinds?: KindGroup[]; onUnassigned: () => void;
}) {
  const t = useT();
  const units = d.facets.find((f) => f.kind === 'units');
  // which register each record belongs to, so a card can say "12 equipment items, 4 complaints"
  const kindOf = useMemo(() => {
    const m = new Map<string, KindGroup>();
    for (const k of kinds) for (const r of k.rows) m.set(r.id, k);
    return m;
  }, [kinds]);
  const cards = useMemo(() => {
    if (!units) return [];
    const by = new Map<string, FiledRecord[]>();
    const none: FiledRecord[] = [];
    for (const r of rows) {
      const u = units.get(r);
      if (!u) { none.push(r); continue; }
      const list = by.get(u);
      if (list) list.push(r); else by.set(u, [r]);
    }
    const out = units.values.map((v) => ({ key: v.key, label: v.label, records: by.get(v.key) ?? [] }));
    return { out, none };
  }, [units, rows]);

  if (!units || !cards || Array.isArray(cards)) return null;
  const total = rows.length;

  const body = (records: FiledRecord[], a?: Accent) => {
    const flags = flagsOf(records, d);
    const types = d.names ? byName(records, 'u').slice(0, 3) : [];
    const perKind = kinds.length > 1
      ? kinds.map((k) => ({ k, n: records.filter((r) => kindOf.get(r.id) === k).length })).filter((x) => x.n) : [];
    const share = total ? Math.round((records.length / total) * 100) : 0;
    return (
      <>
        {perKind.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {perKind.map(({ k, n }) => (
              <span key={k.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] text-ink-2">{countOf(k.label, n)}</span>
            ))}
          </div>
        )}
        {flags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {flags.map((f) => <ValueBadge key={f.label} tone={f.tone}>{f.label} {f.n}</ValueBadge>)}
          </div>
        )}
        {types.length > 0 && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-muted">
            <span className="font-medium text-ink-2">{t('Mostly')} </span>
            {types.map((x, i) => (
              <span key={x.id}>{i > 0 && ' · '}{x.label} <b className="font-semibold text-ink-2">{x.all.length}</b></span>
            ))}
            {byName(records, 'u').length > 3 && <> · {byName(records, 'u').length - 3 === 1
              ? t('and 1 other type')
              : t('and {n} other types', { n: byName(records, 'u').length - 3 })}</>}
          </p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-3" title={t('{pct}% of the {items} here', { pct: share, items: items(total) })}>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <span className={cn('block h-full rounded-full', a ? a.dot : 'bg-amber-400')}
              style={{ width: `${total ? Math.max(2, share) : 0}%` }} />
          </span>
          <span className="text-[11px] font-semibold tabular-nums text-ink-2">{share}%</span>
        </div>
      </>
    );
  };

  return (
    <div className="space-y-3">
      <Panel title={t('Items by {unit}', { unit: unitWordText(t, unitWord) })} icon="BarChart3" tone="brand"
        subtitle={t('{n} {units}, from the source’s own {unit} field — largest first. Open one to see its own summary, tree and register.', {
          n: cards.out.length, units: unitWordText(t, unitWord, cards.out.length), unit: unitWordText(t, unitWord),
        })}>
        <BarList data={[
          ...cards.out.slice(0, 12).map((c, i) => ({ label: c.label, value: c.records.length, color: accentAt(i).hex })),
          ...(cards.none.length ? [{ label: t('No {unit} given', { unit: unitWordText(t, unitWord) }), value: cards.none.length, color: '#cbd5e1', onClick: onUnassigned }] : []),
        ]} />
        {cards.out.length > 12 && <p className="mt-2 text-[12px] text-muted">{t('and {n} more below', { n: cards.out.length - 12 })}</p>}
      </Panel>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {cards.out.map((c, i) => {
          const a = accentAt(i);
          return (
            <Link key={c.key} to={`/departments/${c.key}`} className={cn('card card-int flex flex-col overflow-hidden border-t-4 p-3.5', a.edge)}>
              <div className="flex items-start gap-2.5">
                <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', a.tile)}>
                  <Icon name={deptIcon(c.label)} className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-ink" title={c.label}>{c.label}</p>
                  <p className="text-[12px] text-muted">{items(c.records.length)}</p>
                </div>
                <span className="text-[20px] font-bold leading-none tabular-nums text-ink">{c.records.length.toLocaleString()}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-2" />
              </div>
              {body(c.records, a)}
            </Link>
          );
        })}
        {cards.none.length > 0 && (
          <button onClick={onUnassigned} className="card card-int flex flex-col overflow-hidden border-t-4 border-t-amber-400 p-3.5 text-left">
            <div className="flex items-start gap-2.5">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning-50">
                <Inbox className="h-[18px] w-[18px] text-warning-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">{t('No {unit} given', { unit: unitWordText(t, unitWord) })}</p>
                <p className="text-[12px] text-muted">{t('{items} the source did not place', { items: items(cards.none.length) })}</p>
              </div>
            </div>
            {body(cards.none)}
          </button>
        )}
      </div>
    </div>
  );
}
