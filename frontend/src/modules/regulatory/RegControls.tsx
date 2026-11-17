/**
 * Controls — what the hospital runs against this regulation.
 *
 * Two lists, each from its own source:
 *  · MAPPED CONTROLS (/api/regulations/:id/controls) — controls linked to this
 *    regulation's obligations, with owner, type, frequency and test state.
 *    This is the count on the tab.
 *  · HOSPITAL DOCUMENTS IN THE ASSESSMENT — the policies, SOPs, forms and
 *    controls the gap assessment cited for this regulation (/api/cascade/*).
 *    A document's status is computed from the verdicts of the requirements it
 *    covers: all met = Covering, some = Partially, none = Not covering.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Link2 } from 'lucide-react';
import { MetricCard, Callout, Field, Avatar, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Donut, BarList, StackedBar, FlowSteps } from '@/components/ui/charts';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useRegulationControls, type RegulationControl } from '@/services/regulationsApi';
import { cn, readable, type Tone } from '@/utils/ui';
import type { CascadeDoc, CascadeGraph } from '@/modules/cascade/cascadeTypes';
import { useDateLocale, useT } from '@/i18n';
import {
  useGapAssessment, useCascadeGraph, useControlDetail, useLinkResolver, flattenGap, deptsOf,
  GAP_UI, UNMET, riskKey, complianceUi,
  Pill, GapPill, RiskPill, KindChip, TypeChip, CompliancePill, DeptLabel, FilterBar, FilterSelect, TableFooter, usePaging,
  useSelection, HeaderCheckbox, RowCheckbox, downloadCsv, ExportButton, TH, rowProps, TwoLine,
  SidePanel, PanelBlock, Tile, pctOf, fmtDay, type GapRow, type GoTab,
} from './regShared';

type View = 'mapped' | 'docs';

export function ControlsTab({ id, go }: { id: string; go: GoTab }) {
  const t = useT();
  const [params] = useSearchParams();
  const mapped = useRegulationControls(id);
  const gap = useGapAssessment(id);
  const rows = useMemo(() => flattenGap(gap.data), [gap.data]);
  const graph = useCascadeGraph(rows.length > 0);
  const docs = useDocRows(rows, graph.data);
  const [viewSel, setViewSel] = useState<View | null>(null);
  const urlView = params.get('view') === 'docs' ? 'docs' : params.get('view') === 'mapped' ? 'mapped' : null;
  useEffect(() => { if (urlView) setViewSel(urlView); }, [urlView, params]);
  const nMapped = mapped.data?.items.length ?? 0;
  const view: View = viewSel ?? (nMapped || !docs.length ? 'mapped' : 'docs');

  if (mapped.isLoading) return <div className="card"><Skeleton rows={8} /></div>;

  return (
    <div className="space-y-4">
      {(docs.length > 0 || graph.isLoading) && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="max-w-full overflow-x-auto">
            <SegmentedControl ariaLabel="Control source" value={view} onChange={setViewSel} options={[
              { key: 'mapped', label: <>{t('Mapped controls')} <b className="tabular-nums">{nMapped.toLocaleString()}</b></> },
              { key: 'docs', label: <>{t('Hospital policies & controls in the assessment')} <b className="tabular-nums">{docs.length.toLocaleString()}</b></> },
            ]} />
          </div>
          <span className="text-xs text-muted">
            {view === 'mapped' ? t('Controls linked to this regulation’s obligations.')
              : t('Documents the gap assessment cited, with the verdicts of the requirements they cover.')}
          </span>
        </div>
      )}
      {view === 'mapped' && mapped.data && <MappedView id={id} data={mapped.data} go={go} preselect={params.get('ctl')} />}
      {view === 'mapped' && !mapped.data && (
        <div className="card"><EmptyState title={t('Controls could not be loaded')} hint={t('The controls endpoint did not answer.')} /></div>
      )}
      {view === 'docs' && <DocsView id={id} docs={docs} graph={graph.data} go={go} preselect={params.get('doc')} loading={graph.isLoading} />}
    </div>
  );
}

/* ======================================================================
 * hospital documents cited by the assessment
 * ==================================================================== */

interface DocRow extends CascadeDoc {
  code: string; rows: GapRow[]; met: number; unmet: number; status: 'COVERING' | 'PARTIAL' | 'NONE'; dept: string;
}
const DOC_STATUS: Record<DocRow['status'], { label: string; tone: Tone; hex: string }> = {
  COVERING: { label: 'Covering', tone: 'green', hex: '#16a34a' },
  PARTIAL: { label: 'Partially covering', tone: 'amber', hex: '#f59e0b' },
  NONE: { label: 'Not covering', tone: 'red', hex: '#dc2626' },
};

function useDocRows(rows: GapRow[], graph: CascadeGraph | undefined): DocRow[] {
  const resolve = useLinkResolver(graph);
  return useMemo(() => {
    if (!graph || !rows.length) return [];
    const m = new Map<string, GapRow[]>();
    rows.forEach((r) => {
      const l = resolve(r);
      new Set([...l.docs, ...l.ctrls]).forEach((code) => { const a = m.get(code) ?? []; a.push(r); m.set(code, a); });
    });
    return [...m.entries()].filter(([code]) => graph.docs[code]).map(([code, rs]) => {
      const d = graph.docs[code];
      const met = rs.filter((r) => r.st === 'MET').length;
      const partial = rs.filter((r) => r.st === 'PARTIAL').length;
      const status: DocRow['status'] = met === rs.length ? 'COVERING' : met + partial > 0 ? 'PARTIAL' : 'NONE';
      return { ...d, code, rows: rs, met, unmet: rs.filter((r) => UNMET.has(r.st)).length, status, dept: deptsOf(d.o)[0] };
    }).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [rows, graph, resolve]);
}

function DocsView({ id, docs, graph, go, preselect, loading }: {
  id: string; docs: DocRow[]; graph?: CascadeGraph; go: GoTab; preselect: string | null; loading: boolean;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [kind, setKind] = useState('');
  const [dept, setDept] = useState('');
  const [owner, setOwner] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const selection = useSelection();
  useEffect(() => { if (preselect && docs.some((d) => d.code === preselect)) { setSel(preselect); setQ(preselect); } }, [preselect, docs]);

  const opts = useMemo(() => ({
    kinds: [...new Set(docs.map((d) => d.k))],
    depts: [...new Set(docs.map((d) => d.dept))].sort(),
    owners: [...new Set(docs.map((d) => d.o).filter(Boolean) as string[])].sort(),
  }), [docs]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (st === 'NOOWNER' ? !!d.o : st && d.status !== st) return false;
      if (kind && d.k !== kind) return false;
      if (dept && d.dept !== dept) return false;
      if (owner && d.o !== owner) return false;
      if (needle && !(`${d.code} ${d.t} ${d.o ?? ''} ${d.std ?? ''}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [docs, q, st, kind, dept, owner]);
  const paging = usePaging(filtered, [q, st, kind, dept, owner].join('|'));
  const current = docs.find((d) => d.code === sel) ?? null;
  const count = (s: DocRow['status']) => docs.filter((d) => d.status === s).length;
  const noOwner = docs.filter((d) => !d.o).length;

  if (loading) return <div className="card"><Skeleton rows={8} /></div>;
  if (!docs.length) return <div className="card"><EmptyState title={t('No hospital document is cited for this regulation')} hint={t('The gap assessment has not linked any policy, SOP, form or control to it.')} icon="FileWarning" /></div>;

  const exportRows = () => {
    const pick = selection.sel.size ? filtered.filter((d) => selection.has(d.code)) : filtered;
    downloadCsv(`${id}-hospital-controls.csv`, ['Code', 'Title', 'Type', 'Owner', 'Department', 'Linked requirements', 'Documented', 'Status', 'Frequency'],
      pick.map((d) => [d.code, d.t, d.k, d.o, d.dept, d.rows.length, d.met, DOC_STATUS[d.status].label, d.freq]));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard label={t('Total documents')} value={docs.length.toLocaleString()} tone="brand" icon="Shield" onClick={() => setSt('')} />
        <MetricCard label={t('Covering')} value={count('COVERING').toLocaleString()} tone="green" icon="CheckCircle2" pct={pctOf(count('COVERING'), docs.length)}
                    onClick={() => setSt(st === 'COVERING' ? '' : 'COVERING')} active={st === 'COVERING'} />
        <MetricCard label={t('Partially covering')} value={count('PARTIAL').toLocaleString()} tone="amber" icon="AlertTriangle" pct={pctOf(count('PARTIAL'), docs.length)}
                    onClick={() => setSt(st === 'PARTIAL' ? '' : 'PARTIAL')} active={st === 'PARTIAL'} />
        <MetricCard label={t('Not covering')} value={count('NONE').toLocaleString()} tone="red" icon="XCircle" pct={pctOf(count('NONE'), docs.length)}
                    onClick={() => setSt(st === 'NONE' ? '' : 'NONE')} active={st === 'NONE'} />
        <MetricCard label={t('No owner')} value={noOwner.toLocaleString()} tone="gray" icon="UserX" pct={pctOf(noOwner, docs.length)}
                    onClick={() => setSt(st === 'NOOWNER' ? '' : 'NOOWNER')} active={st === 'NOOWNER'} />
      </div>

      {/* the shape of the list, above the table so the table keeps its width */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="card p-5">
          <h3 className="text-[15px] font-semibold text-ink">{t('How well they cover')}</h3>
          <Donut className="mt-3" size={112} thickness={16} sub={t('documents')}
                 data={(['COVERING', 'PARTIAL', 'NONE'] as const).map((s) => ({ label: t(DOC_STATUS[s].label), value: count(s), color: DOC_STATUS[s].hex, onClick: () => setSt(s) }))} />
        </div>
        <div className="card p-5">
          <h3 className="mb-3 text-[15px] font-semibold text-ink">{t('By type')}</h3>
          <BarList data={opts.kinds.map((k, i) => ({ label: t(k), value: docs.filter((d) => d.k === k).length, color: ({ Policy: '#2563eb', SOP: '#8b5cf6', Form: '#94a3b8', Control: '#14b8a6' } as Record<string, string>)[k] ?? ['#2563eb', '#8b5cf6', '#14b8a6'][i % 3], onClick: () => setKind(k) }))} />
        </div>
        <div className="card p-5 md:col-span-2 xl:col-span-1">
          <h3 className="mb-3 text-[15px] font-semibold text-ink">{t('Unmet requirements by owner')}</h3>
          <BarList data={[...new Set(docs.map((d) => d.o ?? 'Unassigned'))]
            .map((o) => ({ label: o, value: docs.filter((d) => (d.o ?? 'Unassigned') === o).reduce((a, d) => a + d.unmet, 0) }))
            .filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 5)
            .map((x) => ({ ...x, label: x.label === 'Unassigned' ? t('Unassigned') : x.label, color: x.label === 'Unassigned' ? '#94a3b8' : undefined, onClick: x.label === 'Unassigned' ? undefined : () => setOwner(x.label) }))} />
        </div>
      </div>

      <div>
        <div className="card min-w-0 overflow-hidden">
          <FilterBar q={q} onQ={setQ} placeholder={t('Search controls…')}
            right={<ExportButton count={selection.sel.size} onExport={exportRows} />}
            more={<FilterSelect label={t('Department')} value={dept} onChange={setDept} options={opts.depts.map((x) => ({ value: x, label: t(x) }))} />}>
            <FilterSelect label={t('Status')} value={st} onChange={setSt} options={[
              { value: 'COVERING', label: t('Covering') }, { value: 'PARTIAL', label: t('Partially covering') },
              { value: 'NONE', label: t('Not covering') }, { value: 'NOOWNER', label: t('No owner') }]} />
            <FilterSelect label={t('Owner')} value={owner} onChange={setOwner} options={opts.owners.map((x) => ({ value: x, label: x }))} />
            <FilterSelect label={t('Type')} value={kind} onChange={setKind} options={opts.kinds.map((x) => ({ value: x, label: t(x) }))} />
          </FilterBar>
          {filtered.length === 0 ? <EmptyState title={t('Nothing matches these filters')} icon="Filter" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-slate-50/80">
                    <th className="w-10 px-3 py-2.5"><HeaderCheckbox keys={paging.pageRows.map((d) => d.code)} selection={selection} /></th>
                    <th className={cn(TH, 'w-10')}>#</th>
                    <th className={TH}>{t('Control / document')}</th>
                    <th className={TH}>{t('Type')}</th>
                    <th className={cn(TH)}>{t('Department')}</th>
                    <th className={TH}>{t('Linked req.')}</th>
                    <th className={TH}>{t('Status')}</th>
                    <th className={TH}>{t('Owner')}</th>
                    <th className={cn(TH)}>{t('Frequency')}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {paging.pageRows.map((d, i) => (
                    <tr key={d.code} {...rowProps(sel === d.code, () => setSel(sel === d.code ? null : d.code))}>
                      <td className="px-3 py-3"><RowCheckbox k={d.code} selection={selection} label={d.code} /></td>
                      <td className={cn('px-3 py-3 text-xs tabular-nums text-muted')}>{paging.offset + i + 1}</td>
                      <td className="min-w-[260px] max-w-[460px] px-3 py-3">
                        <TwoLine title={<><span className="text-brand-700">{d.code}</span> {d.t}</>} sub={d.std ? t('Standards {std}', { std: d.std }) : d.f} />
                      </td>
                      <td className="px-3 py-3"><KindChip kind={d.k} /></td>
                      <td className={cn('max-w-[170px] px-3 py-3 text-[12.5px] text-ink-2')}><DeptLabel name={d.dept} /></td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700"><Link2 className="h-3.5 w-3.5" />{d.rows.length}</span>
                      </td>
                      <td className="px-3 py-3"><Pill tone={DOC_STATUS[d.status].tone}>{t(DOC_STATUS[d.status].label)}</Pill></td>
                      <td className="max-w-[170px] px-3 py-3">
                        {d.o ? <span className="flex items-center gap-2"><Avatar name={d.o} size={26} /><span className="min-w-0 leading-tight"><span className="block truncate text-[12.5px] font-medium text-ink">{d.o}</span><span className="text-[11px] text-muted">{t('Owner')}</span></span></span>
                          : <span className="text-xs font-medium text-critical-600">{t('Unassigned')}</span>}
                      </td>
                      <td className={cn('px-3 py-3 text-xs text-ink-2')}>{d.freq ?? '—'}</td>
                      <td className="px-2 py-3 text-muted-2"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TableFooter page={paging.page} size={paging.size} total={paging.total} onPage={paging.setPage} onSize={paging.setSize} noun={t('documents')} />
        </div>

      </div>
      {current && <DocPanel d={current} graph={graph} id={id} go={go} onClose={() => setSel(null)} />}
    </div>
  );
}

function DocPanel({ d, graph, id, go, onClose }: { d: DocRow; graph?: CascadeGraph; id: string; go: GoTab; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState('details');
  useEffect(() => setTab('details'), [d.code]);
  const risks = graph?.risks ?? {};
  const docs = graph?.docs ?? {};
  const unmetRows = d.rows.filter((r) => UNMET.has(r.st));
  const related = [...(d.pol ?? []), ...(d.sops ?? []), ...(d.forms ?? [])].filter((c) => docs[c]);
  const ordered = [...d.rows].sort((a, b) => (UNMET.has(b.st) ? 1 : 0) - (UNMET.has(a.st) ? 1 : 0));
  return (
    <SidePanel labelId="doc-panel-title" onClose={onClose}
      eyebrow={<span className="font-semibold text-brand-700">{d.code}</span>} title={d.t}
      badge={<><Pill tone={DOC_STATUS[d.status].tone}>{t(DOC_STATUS[d.status].label)}</Pill><KindChip kind={d.k} /></>}
      tabs={[{ key: 'details', label: t('Details') }, { key: 'reqs', label: t('Linked requirements ({n})', { n: d.rows.length.toLocaleString() }) },
        { key: 'risks', label: t('Risks ({n})', { n: (d.risks ?? []).length.toLocaleString() }) }]}
      tab={tab} onTab={setTab}
      footer={<>
        <button className="btn btn-primary btn-sm" onClick={() => go('Obligations', { doc: d.code })}>{t('View obligations')}</button>
        <button className="btn btn-outline btn-sm" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(id)}`)}>{t('Open impact cascade')}</button>
      </>}>
      {tab === 'details' && (<>
        {unmetRows.length > 0 && (
          <Callout tone="red" title={t('Control gap')}>
            {d.rows.length === 1 ? t('1 of 1 linked requirement is not met.')
              : unmetRows.length === 1 ? t('1 of {total} linked requirements is not met.', { total: d.rows.length.toLocaleString() })
                : t('{n} of {total} linked requirements are not met.', { n: unmetRows.length.toLocaleString(), total: d.rows.length.toLocaleString() })}
            {unmetRows[0]?.gap && <span className="mt-1 block text-xs text-muted">{unmetRows[0].c}: {unmetRows[0].gap}</span>}
          </Callout>
        )}
        <div className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3 [&>*]:min-w-0">
          <Field label={t('Type')}><KindChip kind={d.k} /></Field>
          <Field label={t('Department')}><DeptLabel name={d.dept} /></Field>
          <Field label={t('Owner')}>
            {d.o ? <span className="flex items-center gap-1.5"><Avatar name={d.o} size={22} /><span className="truncate text-[13px]">{d.o}</span></span> : <span className="text-critical-600">{t('Unassigned')}</span>}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Frequency')}>{d.freq ?? '—'}</Field>
          <Field label={t('How it is tested')}>{d.test ?? '—'}</Field>
          <Field label={t('Standards')}>{d.std ?? '—'}</Field>
          <Field label={t('Source file')}><span className="break-all text-[12.5px]">{d.f ?? '—'}</span></Field>
        </div>
        <PanelBlock title={t('Coverage of linked requirements')}>
          <StackedBar data={(['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] as const).map((s) => ({ label: t(GAP_UI[s].label), value: d.rows.filter((r) => r.st === s).length, color: GAP_UI[s].hex }))} />
        </PanelBlock>
        <PanelBlock title={t('Linked requirements')} link={{ label: t('View all'), onClick: () => setTab('reqs') }}>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {ordered.slice(0, 4).map((r) => (
              <li key={r.key}>
                <button className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-50" onClick={() => go('Obligations', { ob: r.c })}>
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2"><b className="text-ink">{r.c}</b> <span className="line-clamp-2">{r.ob || r.t}</span></span>
                  <GapPill status={r.st} />
                </button>
              </li>
            ))}
          </ul>
        </PanelBlock>
        {(d.risks ?? []).length > 0 && (
          <PanelBlock title={t('Related risks')} link={(d.risks ?? []).length > 3 ? { label: t('View all'), onClick: () => setTab('risks') } : undefined}>
            <RiskList codes={(d.risks ?? []).slice(0, 3)} risks={risks} />
          </PanelBlock>
        )}
        {related.length > 0 && (
          <PanelBlock title={t('Related documents')}>
            <ul className="space-y-1.5">
              {related.slice(0, 6).map((c) => (
                <li key={c} className="flex items-center gap-2 text-[12.5px]"><KindChip kind={docs[c].k} /><b className="text-ink">{c}</b><span className="truncate text-muted">{docs[c].t}</span></li>
              ))}
            </ul>
          </PanelBlock>
        )}
        <PanelBlock title={t('Relationship')}>
          <FlowSteps steps={[
            { icon: 'ClipboardList', label: d.rows.length === 1 ? t('1 requirement') : t('{n} requirements', { n: d.rows.length.toLocaleString() }),
              sub: t('{n} documented', { n: d.met.toLocaleString() }), tone: 'blue' },
            { icon: d.k === 'Control' ? 'ShieldCheck' : 'FileText', label: d.code, sub: t(d.k), tone: DOC_STATUS[d.status].tone === 'green' ? 'green' : DOC_STATUS[d.status].tone === 'amber' ? 'amber' : 'red' },
            { icon: 'AlertTriangle', label: (d.risks ?? []).length === 1 ? t('1 risk') : t('{n} risks', { n: (d.risks ?? []).length.toLocaleString() }), sub: t('Mitigates'), tone: 'orange' },
            { icon: 'UserRound', label: d.o ?? t('Unassigned'), sub: t('Owner'), tone: d.o ? 'teal' : 'red' },
          ]} />
        </PanelBlock>
      </>)}
      {tab === 'reqs' && (
        <ul className="space-y-2">
          {ordered.map((r) => (
            <li key={r.key}>
              <button className="w-full rounded-xl border border-line p-3 text-left hover:border-brand-300" onClick={() => go('Obligations', { ob: r.c })}>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink"><b>{r.c}</b> {r.ob || r.t}</span>
                  <GapPill status={r.st} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted"><RiskPill risk={r.rk} /><span className="truncate">{t(r.chapter)}</span></div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {tab === 'risks' && ((d.risks ?? []).length
        ? <RiskList codes={d.risks ?? []} risks={risks} />
        : <EmptyState title={t('No register risk')} hint={t("This document does not mitigate a risk in the hospital's risk register.")} icon="Shield" />)}
    </SidePanel>
  );
}

function RiskList({ codes, risks }: { codes: string[]; risks: CascadeGraph['risks'] }) {
  const t = useT();
  return (
    <ul className="space-y-2">
      {codes.map((code) => (
        <li key={code} className="flex items-start gap-2.5 rounded-xl border border-line p-2.5">
          <Tile icon="AlertTriangle" cls="bg-notcov-50 text-notcov-500" size="sm" />
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
            <b className="text-ink">{code}</b> <span className="text-ink-2">{risks[code]?.t ?? t('Not in the risk register')}</span>
            {risks[code]?.o && <span className="block text-xs text-muted">{t('Risk owner {name}', { name: risks[code].o ?? '' })}{risks[code].res ? ` · ${t('residual {level}', { level: risks[code].res ?? '' })}` : ''}</span>}
          </span>
          {risks[code]?.rating && <RiskPill risk={risks[code].rating} />}
        </li>
      ))}
    </ul>
  );
}

/* ======================================================================
 * mapped controls — /api/regulations/:id/controls
 * ==================================================================== */

type MappedData = NonNullable<ReturnType<typeof useRegulationControls>['data']>;
const EFFECT: Record<string, { label: string; tone: Tone; hex: string }> = {
  effective: { label: 'Effective', tone: 'green', hex: '#16a34a' },
  partially_effective: { label: 'Partially effective', tone: 'amber', hex: '#f59e0b' },
  ineffective: { label: 'Ineffective', tone: 'red', hex: '#dc2626' },
  // the database stores 'Not Tested' on every new control; without this it reads as a verdict
  not_tested: { label: 'Not tested', tone: 'gray', hex: '#cbd5e1' },
};
const effectOf = (c: RegulationControl) => {
  const k = (c.effectiveness ?? '').toLowerCase().replace(/\s+/g, '_');
  return EFFECT[k] ?? (c.effectiveness ? { label: readable(c.effectiveness), tone: 'amber' as Tone, hex: '#f59e0b' } : { label: 'Not tested', tone: 'gray' as Tone, hex: '#cbd5e1' });
};

function MappedView({ id, data, go, preselect }: { id: string; data: MappedData; go: GoTab; preselect: string | null }) {
  // `t` names a control type in the lists below, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [type, setType] = useState('');
  const [owner, setOwner] = useState('');
  const [freq, setFreq] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const selection = useSelection();
  useEffect(() => { if (preselect && data.items.some((c) => c.id === preselect)) setSel(preselect); }, [preselect, data]);
  const items = data.items;
  const opts = useMemo(() => ({
    types: [...new Set(items.map((c) => c.control_type).filter(Boolean) as string[])].sort(),
    owners: [...new Set(items.map((c) => c.owner_name).filter(Boolean) as string[])].sort(),
    freqs: [...new Set(items.map((c) => c.frequency).filter(Boolean) as string[])].sort(),
    effects: [...new Set(items.map((c) => effectOf(c).label))],
  }), [items]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((c) => {
      if (st && effectOf(c).label !== st) return false;
      if (type && c.control_type !== type) return false;
      if (owner && (owner === '__none' ? !!c.owner_name : c.owner_name !== owner)) return false;
      if (freq && c.frequency !== freq) return false;
      if (needle && !(`${c.name} ${c.description ?? ''} ${c.owner_name ?? ''} ${c.entity_name ?? ''}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [items, q, st, type, owner, freq]);
  const paging = usePaging(filtered, [q, st, type, owner, freq].join('|'));
  const current = items.find((c) => c.id === sel) ?? null;
  const notTested = items.filter((c) => effectOf(c).label === 'Not tested').length;
  // Columns and filters that would show one value on every row are replaced by one line saying it.
  const ownerSet = new Set(items.map((c) => c.owner_name ?? ''));
  const oneOwner = ownerSet.size === 1 && !ownerSet.has('') ? items[0]?.owner_name ?? null : null;
  const showOwner = ownerSet.size > 1;
  const anyTested = items.some((c) => !!c.last_tested);
  const showStatus = opts.effects.length > 1;
  const cov = pctOf(data.obligationsCovered, data.obligationsTotal);

  const exportRows = () => {
    const pick = selection.sel.size ? filtered.filter((c) => selection.has(c.id)) : filtered;
    downloadCsv(`${id}-controls.csv`, ['Control', 'Type', 'Entity', 'Obligations covered', 'Effectiveness', 'Owner', 'Frequency', 'Last tested'],
      pick.map((c) => [c.name, c.control_type, c.entity_name, c.obligations_covered, effectOf(c).label, c.owner_name, c.frequency, c.last_tested]));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard label={tr('Total controls')} value={items.length.toLocaleString()} tone="brand" icon="Shield" onClick={() => setSt('')} />
        <MetricCard label={tr('Obligations covered')} value={data.obligationsCovered.toLocaleString()} tone="green" icon="ShieldCheck" pct={cov}
                    foot={tr('of {n} obligations', { n: data.obligationsTotal.toLocaleString() })} />
        <MetricCard label={tr('Obligations uncovered')} value={data.obligationsUncovered.toLocaleString()} tone="red" icon="ShieldAlert"
                    pct={pctOf(data.obligationsUncovered, data.obligationsTotal)} foot={tr('no control mapped')} />
        <MetricCard label={tr('Not tested')} value={notTested.toLocaleString()} tone="gray" icon="MinusCircle" pct={pctOf(notTested, items.length)}
                    onClick={() => setSt(st === 'Not tested' ? '' : 'Not tested')} active={st === 'Not tested'} />
      </div>

      {items.length === 0 ? (
        <div className="card">
          <EmptyState title={tr('No controls are mapped to this regulation')} icon="ShieldAlert"
                      hint={tr('Every one of its {n} obligations is currently unmitigated.', { n: data.obligationsTotal.toLocaleString() })} />
          <div className="-mt-8 pb-8 text-center"><button className="btn btn-outline btn-sm" onClick={() => go('Requirements')}>{tr('Review the obligations')}</button></div>
        </div>
      ) : (
        <div className="space-y-4">
          {(oneOwner || !anyTested) && (
            <p className="px-1 text-[13px] text-muted">
              {oneOwner && tr('All controls are owned by {name}.', { name: oneOwner })}{' '}
              {!anyTested && tr('None of the {n} controls has been tested yet.', { n: items.length.toLocaleString() })}
            </p>
          )}
          <div className="card min-w-0 overflow-hidden">
            <FilterBar q={q} onQ={setQ} placeholder={tr('Search controls…')}
              right={<ExportButton count={selection.sel.size} onExport={exportRows} />}
              more={<FilterSelect label={tr('Frequency')} value={freq} onChange={setFreq} options={opts.freqs.map((x) => ({ value: x, label: readable(x) }))} />}>
              {showStatus && <FilterSelect label={tr('Status')} value={st} onChange={setSt} options={opts.effects.map((x) => ({ value: x, label: tr(x) }))} />}
              {showOwner && <FilterSelect label={tr('Owner')} value={owner} onChange={setOwner} options={[...opts.owners.map((x) => ({ value: x, label: x })), { value: '__none', label: tr('Unassigned') }]} />}
              <FilterSelect label={tr('Type')} value={type} onChange={setType} options={opts.types.map((x) => ({ value: x, label: readable(x) }))} />
            </FilterBar>
            {filtered.length === 0 ? <EmptyState title={tr('Nothing matches these filters')} icon="Filter" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-slate-50/80">
                      <th className="w-10 px-3 py-2.5"><HeaderCheckbox keys={paging.pageRows.map((c) => c.id)} selection={selection} /></th>
                      <th className={cn(TH, 'w-10')}>#</th>
                      <th className={TH}>{tr('Control')}</th>
                      <th className={TH}>{tr('Type')}</th>
                      <th className={TH} title={tr('Obligations of this regulation the control covers')}>{tr('Obligations')}</th>
                      {showStatus && <th className={TH}>{tr('Status')}</th>}
                      {showOwner && <th className={TH}>{tr('Owner')}</th>}
                      {anyTested && <th className={cn(TH)}>{tr('Last tested')}</th>}
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {paging.pageRows.map((c, i) => {
                      const e = effectOf(c);
                      return (
                        <tr key={c.id} {...rowProps(sel === c.id, () => setSel(sel === c.id ? null : c.id))}>
                          <td className="px-3 py-3"><RowCheckbox k={c.id} selection={selection} label={c.name} /></td>
                          <td className={cn('px-3 py-3 text-xs tabular-nums text-muted')}>{paging.offset + i + 1}</td>
                          <td className="min-w-[260px] max-w-[460px] px-3 py-3"><TwoLine title={c.name} sub={c.description ?? (c.frequency ? readable(c.frequency) : undefined)} /></td>
                          <td className="px-3 py-3">{c.control_type ? <TypeChip>{readable(c.control_type)}</TypeChip> : <span className="text-muted-2">—</span>}</td>
                          <td className="px-3 py-3"><span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700"><Link2 className="h-3.5 w-3.5" />{c.obligations_covered}</span></td>
                          {showStatus && <td className="px-3 py-3"><Pill tone={e.tone}>{tr(e.label)}</Pill></td>}
                          {showOwner && <td className="max-w-[170px] px-3 py-3">
                            {c.owner_name ? <span className="flex items-center gap-2"><Avatar name={c.owner_name} size={26} /><span className="min-w-0 leading-tight"><span className="block truncate text-[12.5px] font-medium text-ink">{c.owner_name}</span><span className="text-[11px] text-muted">{tr('Owner')}</span></span></span>
                              : <span className="text-xs font-medium text-critical-600">{tr('Unassigned')}</span>}
                          </td>}
                          {anyTested && <td className={cn('whitespace-nowrap px-3 py-3 text-xs text-ink-2')}>{c.last_tested ? fmtDay(c.last_tested, locale) : tr('Never')}</td>}
                          <td className="px-2 py-3 text-muted-2"><ChevronRight className="h-4 w-4" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <TableFooter page={paging.page} size={paging.size} total={paging.total} onPage={paging.setPage} onSize={paging.setSize} noun={tr('controls')} />
          </div>

        </div>
      )}
      {current && <MappedPanel c={current} rid={id} go={go} onClose={() => setSel(null)} />}
    </div>
  );
}

const UNMET_COMPLIANCE = new Set(['NON_COMPLIANT', 'PARTIALLY_COMPLIANT', 'EVIDENCE_MISSING', 'GAP', 'PARTIAL', 'NOT_COVERED']);

function MappedPanel({ c, rid, go, onClose }: { c: RegulationControl; rid: string; go: GoTab; onClose: () => void }) {
  const t = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const [tab, setTab] = useState('details');
  useEffect(() => setTab('details'), [c.id]);
  const { data: det, isLoading } = useControlDetail(c.id);
  const reqs = (det?.requirements ?? []).filter((r) => r.regulation_id === rid);
  const unmet = reqs.filter((r) => UNMET_COMPLIANCE.has((r.compliance_status ?? '').toUpperCase()));
  const evidence = det?.evidence_list ?? [];
  const riskCounts = ['Critical', 'High', 'Medium', 'Low'].map((k) => [k, unmet.filter((r) => riskKey(r.risk) === k).length] as const).filter(([, n]) => n);
  const e = effectOf(c);
  return (
    <SidePanel labelId="ctl-panel-title" onClose={onClose} title={c.name}
      eyebrow={c.control_type ? readable(c.control_type) : t('Control')}
      badge={<><Pill tone={e.tone}>{t(e.label)}</Pill>{c.automated ? <Pill tone="blue" icon="Zap">{t('Automated')}</Pill> : null}</>}
      tabs={[{ key: 'details', label: t('Details') }, { key: 'reqs', label: t('Linked requirements ({n})', { n: reqs.length.toLocaleString() }) },
        { key: 'evidence', label: t('Evidence ({n})', { n: evidence.length.toLocaleString() }) }, { key: 'history', label: t('History') }]}
      tab={tab} onTab={setTab}
      footer={<>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/controls')}>{t('Open in Controls register')}</button>
        <button className="btn btn-outline btn-sm" onClick={() => go('Requirements', { ctl: 'mapped' })}>{t('View requirements')}</button>
        <button className="btn btn-sm" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(rid)}`)}>{t('Impact cascade')}</button>
      </>}>
      {isLoading && <Skeleton rows={4} />}
      {tab === 'details' && !isLoading && (<>
        {unmet.length > 0 ? (
          <Callout tone="red" title={t('Control gap')}>
            {reqs.length === 1 ? t('1 of 1 linked requirement in this regulation is not met.')
              : unmet.length === 1 ? t('1 of {total} linked requirements in this regulation is not met.', { total: reqs.length.toLocaleString() })
                : t('{n} of {total} linked requirements in this regulation are not met.', { n: unmet.length.toLocaleString(), total: reqs.length.toLocaleString() })}
            {unmet[0]?.gap && <span className="mt-1 block text-xs text-muted">{unmet[0].source_clause ? `${unmet[0].source_clause}: ` : ''}{unmet[0].gap}</span>}
          </Callout>
        ) : reqs.length > 0 ? <Callout tone="green" title={t('No open gap')}>{t('Every linked requirement in this regulation is documented or not yet assessed.')}</Callout> : null}
        <div className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3 [&>*]:min-w-0">
          <Field label={t('Control type')}>{c.control_type ? <TypeChip>{readable(c.control_type)}</TypeChip> : '—'}</Field>
          <Field label={t('Entity')}><span className="line-clamp-2 text-[13px]">{c.entity_name ?? '—'}</span></Field>
          <Field label={t('Owner')}>
            {c.owner_name ? <span className="flex items-center gap-1.5"><Avatar name={c.owner_name} size={22} /><span className="truncate text-[13px]">{c.owner_name}</span></span> : <span className="text-critical-600">{t('Unassigned')}</span>}
          </Field>
        </div>
        <PanelBlock title={t('Description')}>
          <p className="text-[13px] leading-relaxed text-ink-2">{c.description ?? det?.description ?? t('No description recorded.')}</p>
        </PanelBlock>
        <PanelBlock title={t('Linked requirements')} link={reqs.length > 4 ? { label: t('View all'), onClick: () => setTab('reqs') } : undefined}>
          {reqs.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {[...reqs].sort((a, b) => (UNMET_COMPLIANCE.has((b.compliance_status ?? '').toUpperCase()) ? 1 : 0) - (UNMET_COMPLIANCE.has((a.compliance_status ?? '').toUpperCase()) ? 1 : 0))
                .slice(0, 4).map((r) => (
                  <li key={r.id} className="flex items-start gap-2.5 px-3 py-2">
                    <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                    <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">{r.source_clause && <b className="text-ink">{r.source_clause} </b>}<span className="line-clamp-2">{r.statement}</span></span>
                    <CompliancePill status={r.compliance_status} />
                  </li>
                ))}
            </ul>
          ) : <p className="text-[13px] text-muted">{c.obligations_covered === 1
            ? t('No requirement of this regulation is linked to this control yet — it covers 1 obligation.')
            : t('No requirement of this regulation is linked to this control yet — it covers {n} obligations.', { n: c.obligations_covered.toLocaleString() })}</p>}
        </PanelBlock>
        {riskCounts.length > 0 && (
          <PanelBlock title={t('Related risks')}>
            <ul className="space-y-1.5">
              {riskCounts.map(([k, n]) => (
                <li key={k} className="flex items-center gap-2.5 text-[12.5px]">
                  <Tile icon="AlertTriangle" cls="bg-notcov-50 text-notcov-500" size="sm" />
                  <span className="flex-1 text-ink-2">{n === 1 ? t('1 unmet requirement rated') : t('{n} unmet requirements rated', { n: n.toLocaleString() })}</span>
                  <RiskPill risk={k} />
                </li>
              ))}
            </ul>
          </PanelBlock>
        )}
        <PanelBlock title={t('Relationship')}>
          <FlowSteps steps={[
            { icon: 'ClipboardList', label: c.obligations_covered === 1 ? t('1 obligation') : t('{n} obligations', { n: c.obligations_covered.toLocaleString() }), sub: t('Covered'), tone: 'blue' },
            { icon: 'ListChecks', label: reqs.length === 1 ? t('1 requirement') : t('{n} requirements', { n: reqs.length.toLocaleString() }),
              sub: t('{n} unmet', { n: unmet.length.toLocaleString() }), tone: unmet.length ? 'red' : 'purple' },
            { icon: 'ShieldCheck', label: t(e.label), sub: t('Control'), tone: e.tone === 'green' ? 'green' : e.tone === 'red' ? 'red' : e.tone === 'amber' ? 'amber' : 'gray' },
            { icon: 'Paperclip', label: evidence.length === 1 ? t('1 item') : t('{n} items', { n: evidence.length.toLocaleString() }), sub: t('Evidence'), tone: evidence.length ? 'teal' : 'red' },
            { icon: 'UserRound', label: c.owner_name ?? t('Unassigned'), sub: t('Owner'), tone: c.owner_name ? 'teal' : 'red' },
          ]} />
        </PanelBlock>
      </>)}
      {tab === 'reqs' && !isLoading && (reqs.length ? (
        <ul className="space-y-2">
          {reqs.map((r) => (
            <li key={r.id} className="rounded-xl border border-line p-3">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{r.source_clause && <b>{r.source_clause} </b>}{r.statement}</span>
                <CompliancePill status={r.compliance_status} />
              </div>
              {(r.risk || r.gap) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {r.risk && <RiskPill risk={r.risk} />}{r.gap && <span className="text-critical-600">{r.gap}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : <EmptyState title={t('No linked requirement in this regulation')} icon="Link2" />)}
      {tab === 'evidence' && !isLoading && (evidence.length ? (
        <ul className="space-y-2">
          {evidence.map((ev) => (
            <li key={ev.evidence_id} className="flex items-center gap-2.5 rounded-xl border border-line p-3">
              <Tile icon="Paperclip" cls="bg-teal-50 text-teal-600" size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{ev.name ?? ev.evidence_id}</span>
              {ev.type && <Pill tone="gray">{readable(ev.type)}</Pill>}
            </li>
          ))}
        </ul>
      ) : <EmptyState title={t('No evidence attached')} hint={t('Nothing yet proves this control operates.')} icon="Paperclip" />)}
      {tab === 'history' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Last tested')}>{c.last_tested ? fmtDay(c.last_tested, locale) : t('Never')}</Field>
          <Field label={t('Next test due')}>{c.next_test_due ? fmtDay(c.next_test_due, locale) : '—'}</Field>
          <Field label={t('Frequency')}>{c.frequency ? readable(c.frequency) : t('Not set')}</Field>
          <Field label={t('Automated')}>{c.automated == null ? '—' : c.automated ? t('Yes') : t('No')}</Field>
          <Field label={t('Compliance mix')} className="col-span-2">
            <StackedBar data={['COMPLIANT', 'PARTIALLY_COMPLIANT', 'NON_COMPLIANT', 'EVIDENCE_MISSING', 'NOT_ASSESSED']
              .map((s) => ({ label: t(complianceUi(s).label), value: reqs.filter((r) => (r.compliance_status ?? 'NOT_ASSESSED').toUpperCase() === s).length, color: complianceUi(s).hex }))} />
          </Field>
        </div>
      )}
    </SidePanel>
  );
}

