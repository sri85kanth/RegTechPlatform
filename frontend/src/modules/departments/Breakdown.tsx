import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FiledRecord, NodeSource } from '@/services/structureApi';
import {
  demoOrigin, formatWhen, items, keyOf, listText, nounOf, partsOf, pathTail, plural, unitWordText, valueKey,
  type Described, type Facet, type KindGroup,
} from './model';
import { useT } from '@/i18n';
import { CHART, Donut } from '@/components/ui/charts';
import { IconTile } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import { accentAt, TONE_HEX } from './accent';
import { BarRow, CodeBadge, Details, LinkButton, Panel, StatTile, ValueBadge } from './ui';

export type Go = (tab: string, params?: Record<string, string>) => void;

const TOP = 8;

/**
 * One register in plain words, then every number behind the words.
 *
 * This replaced a panel of field-coverage percentages ("Department 282 · 90%")
 * that told a reader how complete the feed was but not what was in it. Every
 * figure here opens the items it counts, in the register's table.
 */
export function Breakdown({ title, rows, d, kinds, unitWord, sources, registerId, go, caveats = {} }: {
  title: string; rows: FiledRecord[]; d: Described; kinds: KindGroup[]; unitWord: string;
  sources: NodeSource[]; registerId: string; go: Go; caveats?: Record<string, string>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const n = rows.length;
  const units = d.facets.find((f) => f.kind === 'units');
  const paths = d.facets.filter((f) => f.kind === 'path');
  const others = d.facets.filter((f) => f.kind === 'value' && f !== d.names && f !== d.status && f !== d.criticality);
  const pending = rows.filter((r) => r.verification === 'Pending').length;
  // "65 invoices" for one register; "1,482 items" across several
  const noun = (k: number) => (kinds.length === 1 ? nounOf(kinds[0].label, k) : k === 1 ? t('item') : t('items'));
  const filter = (f: Facet, v: string) => go(registerId,
    f === d.status ? { status: v } : f === d.criticality ? { crit: v } : { fk: f.key, fv: v });

  // ---------------------------------------------------------------- the words
  // "315 equipment items of 88 different types, spread across 19 departments
  // and 25 locations." — each clause only when the records support it, each
  // variant one whole sentence for the translator.
  const holds = { title, n: n.toLocaleString(), noun: noun(n) };
  const what = kinds.length > 1
    ? t('{title} holds {n} {noun}: {list}', { ...holds, list: listText(t, kinds.map((k) => `${k.rows.length} ${k.label.toLowerCase()}`)) })
    : d.names && kinds.length === 1
      ? t('{title} holds {n} {noun} of {types} different types', { ...holds, types: d.names.values.length })
      : t('{title} holds {n} {noun}', holds);
  const where = {
    what,
    u: units?.values.length ?? 0, units: units ? unitWordText(t, unitWord, units.values.length) : '',
    p: paths[0]?.values.length ?? 0, places: paths[0] ? t(plural(paths[0].label.toLowerCase(), paths[0].values.length)) : '',
  };
  const headline = units && paths[0] ? t('{what}, spread across {u} {units} and {p} {places}.', where)
    : units ? t('{what}, spread across {u} {units}.', where)
      : paths[0] ? t('{what}, in {p} {places}.', where)
        : `${what}.`;

  const said = (f?: Facet) => {
    if (!f || f.values.length === 0) return false;
    const vars = {
      field: t(f.label).toLowerCase(), m: f.missing,
      list: listText(t, f.values.map((v) => `${v.n.toLocaleString()} ${v.label.toLowerCase()}`)),
    };
    return <p>{f.missing > 0 ? t('By {field}: {list}; {m} not given.', vars) : t('By {field}: {list}.', vars)}</p>;
  };

  // ------------------------------------------------------- needs attention
  const attention = useMemo(() => (d.status
    ? rows.filter((r) => {
      const k = valueKey(d.status!, r);
      const v = d.status!.values.find((x) => x.key === k);
      return v && (v.tone === 'danger' || v.tone === 'warn');
    }) : []), [rows, d.status]);
  const attentionLabels = d.status?.values.filter((v) => v.tone === 'danger' || v.tone === 'warn').map((v) => v.label) ?? [];
  // "life support or breakdown or under maintenance"
  const attentionWords = attentionLabels.map((l) => l.toLowerCase())
    .reduce((acc, l) => (acc ? t('{a} or {b}', { a: acc, b: l }) : l), '');
  const demo = rows.filter((r) => demoOrigin(r));

  // charts of the source's own verdicts: every slice opens its rows
  const toneSlices = (f?: Facet) => (f ? f.values.map((v) => ({
    label: v.label, value: v.n, color: TONE_HEX[v.tone], onClick: () => filter(f, v.key),
  })) : []);

  return (
    <div className="space-y-3">
      <section className="card flex gap-3 p-4 text-[13.5px] leading-relaxed text-ink-2">
        <IconTile icon="Info" tone="brand" size="md" />
        <div className="min-w-0 space-y-1.5">
          <p>{headline}</p>
          {said(d.status)}
          {said(d.criticality)}
          {sources.length > 0 && (
            <p className="text-[12.5px] text-muted">
              {sources[0]?.lastSyncAt
                ? t('Collected from {sources}, last on {when}', { sources: listText(t, sources.map((s) => s.label)), when: formatWhen(sources[0].lastSyncAt) })
                : t('Collected from {sources}', { sources: listText(t, sources.map((s) => s.label)) })}
              {pending > 0 && <>. {pending === n
                ? t('None of it has been confirmed by anyone yet')
                : t('{n} of these have not been confirmed by anyone yet', { n: pending.toLocaleString() })}</>}.
            </p>
          )}
        </div>
      </section>

      {demo.length > 0 && (
        <section className="card flex flex-wrap items-center gap-3 border-warning-500/40 bg-warning-50 p-3.5 text-[12.5px] text-warning-600">
          <span className="min-w-0 flex-1">
            {t('{n} of these {noun} are marked by the source as created by its demo loader (“{origin}”), not imported from its register. They are kept, and labelled Demo-loaded wherever they appear.', {
              n: demo.length.toLocaleString(), noun: noun(rows.length), origin: demoOrigin(demo[0]) ?? '',
            })}
          </span>
          <LinkButton onClick={() => go(registerId, { origin: 'demo' })}>{t('Show them')}</LinkButton>
        </section>
      )}

      {(d.status || d.criticality) ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label={noun(n)} n={n} icon="FileText" />
          {[d.status, d.criticality].flatMap((f) => (f ? f.values.map((v) => (
            <StatTile key={`${f.key}:${v.key}`} label={v.label} n={v.n} tone={v.tone} of={n}
              hint={t('{field}: {value} — open these', { field: t(f.label), value: v.label })} onClick={() => filter(f, v.key)} />
          )) : []))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile label={noun(n)} n={n} icon="FileText" />
          {units && <StatTile label={unitWordText(t, unitWord, units.values.length)} n={units.values.length} icon="FolderTree" />}
          {d.names && <StatTile label={t('different types')} n={d.names.values.length} icon="Layers" />}
          <StatTile label={t('not confirmed yet')} n={pending} tone={pending ? 'warn' : 'neutral'} of={n} icon="ShieldAlert" />
        </div>
      )}

      {(d.status || d.criticality) && (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {d.status && d.status.values.length > 0 && (
            <Panel title={t('{field} mix', { field: t(d.status.label) })} icon="PieChart" tone="teal" subtitle={t('As the source reports it. Select a slice to open those rows.')}>
              <Donut data={toneSlices(d.status)} size={140} thickness={18} center={n.toLocaleString()} sub={noun(n)} />
            </Panel>
          )}
          {d.criticality && d.criticality.values.length > 0 && (
            <Panel title={t('By {field}', { field: t(d.criticality.label).toLowerCase() })} icon="Flame" tone="red" subtitle={t('As the source rates each item.')}>
              <div className="space-y-0.5">
                {d.criticality.values.map((v) => (
                  <BarRow key={v.key} label={v.label} n={v.n} of={n} tone={v.tone} onClick={() => filter(d.criticality!, v.key)} />
                ))}
                {d.criticality.missing > 0 && (
                  <BarRow label={<span className="italic">{t('Not given')}</span>} n={d.criticality.missing} of={n} tone="muted"
                    onClick={() => go(registerId, { missing: d.criticality!.key })} />
                )}
              </div>
            </Panel>
          )}
        </div>
      )}

      {attention.length > 0 && d.status && (
        <Panel title={t('Needs attention · {n}', { n: attention.length })} icon="AlertTriangle" tone="amber"
          subtitle={t('{n} {noun} whose {field} is {values}, as the source reports it.', {
            n: attention.length.toLocaleString(), noun: noun(attention.length), field: t(d.status.label).toLowerCase(), values: attentionWords,
          })}
          className="border-warning-500/40">
          <AttentionList rows={attention} d={d} caveats={caveats} />
        </Panel>
      )}

      <div className="grid items-start gap-3 lg:grid-cols-2">
        {units && (
          <Panel title={t('By {unit}', { unit: unitWordText(t, unitWord) })} icon="FolderTree" tone="brand"
            subtitle={t('{n} {units}, from the source’s own {unit} field', {
              n: units.values.length, units: unitWordText(t, unitWord, units.values.length), unit: unitWordText(t, unitWord),
            })}
            action={<LinkButton onClick={() => go('units')}>{t('See all {n}', { n: units.values.length })}</LinkButton>}>
            <div className="space-y-0.5">
              {units.values.slice(0, TOP).map((v, i) => (
                <BarRow key={v.key} label={v.label} n={v.n} of={n} color={accentAt(i).hex} onClick={() => navigate(`/departments/${v.key}`)}
                  hint={t('Open {name}', { name: v.label })} />
              ))}
              {units.missing > 0 && (
                <BarRow label={<span className="italic">{t('No {unit} given', { unit: unitWordText(t, unitWord) })}</span>} n={units.missing} of={n} tone="muted"
                  onClick={() => go(registerId, { unit: 'own' })} />
              )}
            </div>
            {units.values.length > TOP && <p className="mt-1.5 px-1.5 text-[12px] text-muted">{t('and {n} more', { n: units.values.length - TOP })}</p>}
          </Panel>
        )}

        {d.names && (
          <Panel title={kinds.length === 1 ? t('{kind} types', { kind: kinds[0].label }) : d.names.label} icon="Layers" tone="purple"
            subtitle={t('{n} different types. The most common:', { n: d.names.values.length })}
            action={<LinkButton onClick={() => go('structure', { by: d.names!.key, reg: registerId })}>{t('See all {n}', { n: d.names.values.length })}</LinkButton>}>
            <div className="space-y-0.5">
              {d.names.values.slice(0, TOP).map((v, i) => (
                <BarRow key={v.key} label={v.label} n={v.n} of={n} color={CHART[i % CHART.length]} onClick={() => filter(d.names!, v.key)} />
              ))}
            </div>
          </Panel>
        )}

        {paths.map((f) => <PathPanel key={f.key} f={f} rows={rows} go={go} caveat={caveats[f.key]} registerId={registerId} />)}

        {others.map((f, fi) => (
          <Panel key={f.key} title={t('By {field}', { field: t(f.label).toLowerCase() })} icon={f.toned ? 'Activity' : 'BarChart3'} tone={f.toned ? 'amber' : fi % 2 ? 'purple' : 'teal'}
            subtitle={t('{n} different {things}', { n: f.values.length, things: t(plural(f.label.toLowerCase(), 2)) })}
            action={f.values.length > TOP
              ? <LinkButton onClick={() => go('structure', { by: f.key, reg: registerId })}>{t('See all {n}', { n: f.values.length })}</LinkButton> : undefined}>
            <div className="space-y-0.5">
              {f.values.slice(0, TOP).map((v, i) => (
                <BarRow key={v.key} label={v.label} n={v.n} of={n} onClick={() => filter(f, v.key)}
                  {...(f.toned ? { tone: v.tone } : { color: accentAt(i + fi).hex })}
                  hint={v.spellings.length ? t('Spelled {spellings}', { spellings: v.spellings.map(([s, c]) => `“${s}” ×${c}`).join(', ') }) : undefined} />
              ))}
              {f.missing > 0 && (
                <BarRow label={<span className="italic">{t('Not given')}</span>} n={f.missing} of={n} tone="muted"
                  onClick={() => go(registerId, { missing: f.key })} />
              )}
            </div>
          </Panel>
        ))}

        <GapsPanel d={d} n={n} go={go} registerId={registerId} />
        <SourcePanel d={d} sources={sources} pending={pending} n={n} />
      </div>
    </div>
  );
}

function AttentionList({ rows, d, caveats }: { rows: FiledRecord[]; d: Described; caveats: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const where = (r: FiledRecord) => {
    const place = d.facets.find((f) => f.kind === 'path')?.get(r);
    const unit = d.facets.find((f) => f.kind === 'units');
    const unitName = unit ? unit.values.find((v) => v.key === unit.get(r))?.label : undefined;
    return [unitName, place ? pathTail(place) : undefined].filter(Boolean).join(' · ') || '—';
  };
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {rows.map((r) => (
        <li key={r.id}>
          <button onClick={() => setOpen((o) => (o === r.id ? null : r.id))} aria-expanded={open === r.id}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50">
            {open === r.id ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-ink" title={r.name}>{r.name}</span>
              <span className="block truncate text-xs text-muted">
                {[r.source_reference, where(r)].filter((x) => x && x !== '—').join(' · ') || '—'}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {d.criticality && <CodeBadge field="criticality" value={r.criticality} />}
              <CodeBadge field="status" value={r.status} />
            </span>
          </button>
          {open === r.id && <div className="px-3 pb-3"><Details r={r} caveats={caveats} fields={d.fields} /></div>}
        </li>
      ))}
    </ul>
  );
}

/** A location breakdown starts where locations differ, with what they share stated once. */
function PathPanel({ f, rows, go, caveat, registerId }: { f: Facet; rows: FiledRecord[]; go: Go; caveat?: string; registerId: string }) {
  const t = useT();
  const level = f.prefix.length;
  const counts = new Map<string, { label: string; n: number }>();
  let atPrefix = 0;
  for (const r of rows) {
    const v = f.get(r);
    if (v === undefined) continue;
    const part = partsOf(v)[level];
    if (!part) { atPrefix += 1; continue; }
    const k = keyOf(part);
    const c = counts.get(k) ?? { label: part, n: 0 };
    c.n += 1;
    counts.set(k, c);
  }
  const vals = [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  const n = rows.length;
  const open = () => go('structure', { by: f.key, reg: registerId });
  return (
    <Panel title={t('By {field}', { field: t(f.label).toLowerCase() })} icon="MapPin" tone="teal"
      subtitle={f.prefix.length ? t('All within {place}', { place: f.prefix.join(' › ') }) : undefined}
      action={<LinkButton onClick={open}>{t('Open the {field} tree', { field: t(f.label).toLowerCase() })}</LinkButton>}>
      {caveat && (
        <p className="mb-2 rounded-md bg-warning-50 px-2.5 py-1.5 text-[12px] text-warning-600">⚠ {caveat}</p>
      )}
      <div className="space-y-0.5">
        {vals.slice(0, TOP).map((v, i) => <BarRow key={v.label} label={v.label} n={v.n} of={n} color={accentAt(i + 2).hex} onClick={open} />)}
        {atPrefix > 0 && (
          <BarRow label={<span className="italic">{t('{place}, nothing more specific', { place: f.prefix[f.prefix.length - 1] })}</span>} n={atPrefix} of={n} tone="muted" onClick={open} />
        )}
        {f.missing > 0 && (
          <BarRow label={<span className="italic">{t('{field} not given', { field: t(f.label) })}</span>} n={f.missing} of={n} tone="muted"
            onClick={open} />
        )}
      </div>
      {vals.length > TOP && <p className="mt-1.5 px-1.5 text-[12px] text-muted">{t('and {n} more', { n: vals.length - TOP })}</p>}
    </Panel>
  );
}

/** What the source left out, and what it spelled more than one way — both fixable at the source. */
function GapsPanel({ d, n, go, registerId }: { d: Described; n: number; go: Go; registerId: string }) {
  const t = useT();
  const gaps = d.fields.filter((f) => f.key !== 'name' && f.missing > 0 && f.present > 0)
    .sort((a, b) => b.missing - a.missing);
  const variants = d.facets.filter((f) => f.kind !== 'units')
    .flatMap((f) => f.values.filter((v) => v.spellings.length > 1).map((v) => ({ f, v })))
    .sort((a, b) => b.v.n - a.v.n);
  return (
    <Panel title={t('Missing or inconsistent information')} icon="FileWarning" tone="orange"
      subtitle={t('What the source did not send, or sent in more than one spelling. Both are fixed in the source system.')}>
      {gaps.length === 0 && variants.length === 0 ? (
        <p className="flex items-center gap-2 text-[12.5px] text-success-600">
          <IconTile icon="CircleCheck" tone="green" size="sm" /> {t('Every item carries every field the source sends, spelled one way.')}
        </p>
      ) : (
        <div className="space-y-3">
          {gaps.length > 0 && (
            <ul className="space-y-1.5">
              {gaps.map((g) => {
                const p = n ? Math.round((g.missing / n) * 100) : 0;
                return (
                  <li key={g.key} className="text-[12.5px]">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 text-ink-2">
                        {t('{m} of {n} have no {field}', { m: g.missing.toLocaleString(), n: n.toLocaleString(), field: t(g.label).toLowerCase() })}
                      </span>
                      <span className="ml-auto"><LinkButton onClick={() => go(registerId, { missing: g.key })}>{t('Show them')}</LinkButton></span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <span className={cn('block h-full rounded-full', p >= 50 ? 'bg-notcov-500' : 'bg-warning-500')} style={{ width: `${Math.max(p, 2)}%` }} />
                      </span>
                      <span className="w-9 text-right text-[11px] font-semibold tabular-nums text-muted">{p}%</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {variants.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted">{t('Spelled more than one way')}</p>
              <ul className="mt-1 space-y-1">
                {variants.slice(0, 6).map(({ f, v }) => (
                  <li key={`${f.key}:${v.key}`} className="text-[12.5px] text-ink-2">
                    <span className="text-muted">{t(f.label)}:</span>{' '}
                    {v.spellings.map(([s, c], i) => (
                      <Fragment key={s}>{i > 0 && ', '}<b className="font-semibold text-ink">“{s}”</b> <span className="text-muted">×{c}</span></Fragment>
                    ))}
                  </li>
                ))}
              </ul>
              {variants.length > 6 && <p className="mt-1 text-[12px] text-muted">{t('and {n} more', { n: variants.length - 6 })}</p>}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function SourcePanel({ d, sources, pending, n }: { d: Described; sources: NodeSource[]; pending: number; n: number }) {
  const t = useT();
  const sent = d.fields.filter((f) => f.present > 0);
  return (
    <Panel title={t('Where this came from')} icon="Plug" tone="purple">
      {sources.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t('These items were not collected through a connection — they were added by hand or imported.')}</p>
      ) : (
        <ul className="space-y-2">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <IconTile icon={/folder/i.test(s.kind) ? 'FolderOpen' : 'Plug'} tone={/folder/i.test(s.kind) ? 'amber' : 'brand'} size="sm" />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">{s.label}</p>
                <p className="text-[12px] text-muted">
                  {s.kind}{s.where && <> · {s.where}</>} · {items(s.records)}
                  {s.lastSyncAt && <> · {t('last collected {when}', { when: formatWhen(s.lastSyncAt) })}</>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs font-medium text-muted">{t('Fields it sends')} <span className="font-normal">· {t('green when every item carries it')}</span></p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {sent.map((f) => (
          <ValueBadge key={f.key} tone={f.missing > 0 ? 'neutral' : 'ok'} title={t('{n} of {total} items carry it', { n: f.present, total: n })}>
            {t(f.label)}{f.missing > 0 && <span className="ml-1 font-normal text-muted">{Math.round((f.present / n) * 100)}%</span>}
          </ValueBadge>
        ))}
      </div>
      {pending > 0 && (
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          {t('Collected automatically.')} {pending === n
            ? t('None of it has been confirmed by a person yet — until then this is what the source says, not a verified register.')
            : t('{n} of {total} have not been confirmed by a person yet — until then this is what the source says, not a verified register.', {
              n: pending.toLocaleString(), total: n.toLocaleString(),
            })}
        </p>
      )}
    </Panel>
  );
}
