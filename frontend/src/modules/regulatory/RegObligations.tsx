/**
 * Obligations — every duty this regulation places on the hospital, with what
 * covers it.
 *
 * Two sources, never blended:
 *  · ASSESSED — the document-based gap assessment (/api/cascade/regulations/:id):
 *    one row per element with the rewritten obligation, a verdict against the
 *    hospital's own policies, SOPs, forms and controls, the risk band, the gap
 *    and the fix. This is where "Fully addressed / Partially / Not addressed"
 *    comes from.
 *  · EXTRACTED — the obligations the extractor lifted from the text
 *    (/api/regulations/:id/obligations), with the control and evidence links
 *    that exist for each. Boilerplate (title, commencement) stays separate.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Link2, ShieldCheck, Flame } from 'lucide-react';
import { MetricCard, Callout, Field, Avatar, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Donut, BarList, FlowSteps } from '@/components/ui/charts';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useRegulationObligationChain, type ObligationRow } from '@/services/regulationsApi';
import { cn, readable } from '@/utils/ui';
import type { CascadeGraph } from '@/modules/cascade/cascadeTypes';
import { useT } from '@/i18n';
import {
  useGapAssessment, useCascadeGraph, useRegOverview, useLinkResolver, flattenGap, deptUi,
  GAP_UI, gapUi, UNMET, RISK_ORDER, riskKey, words, prettyCaps, coreFailRisk, CoreFailPill, DocRequiredPill,
  Pill, GapPill, RiskPill, KindChip, DeptLabel, FilterBar, FilterSelect, TableFooter, usePaging,
  useSelection, HeaderCheckbox, RowCheckbox, downloadCsv, ExportButton, TH, rowProps, TwoLine,
  SidePanel, PanelBlock, Tile, pctOf, type GapRow, type Links, type GoTab,
} from './regShared';

type Mode = 'assessed' | 'duties' | 'scope';

export function ObligationsTab({ id, go }: { id: string; go: GoTab }) {
  const t = useT();
  const [params] = useSearchParams();
  const gap = useGapAssessment(id);
  const rows = useMemo(() => flattenGap(gap.data), [gap.data]);
  const graph = useCascadeGraph(rows.length > 0);
  const chain = useRegulationObligationChain(id);
  const { data: ov } = useRegOverview(id);
  const [modeSel, setModeSel] = useState<Mode | null>(null);
  const hasGap = rows.length > 0;
  const mode: Mode = modeSel ?? (hasGap ? 'assessed' : 'duties');

  if (gap.isLoading || chain.isLoading) return <div className="card"><Skeleton rows={8} /></div>;

  const c = chain.data?.counts;
  const options = [
    ...(hasGap ? [{ key: 'assessed' as Mode, label: <>{t('Assessed against our documents')} <b className="tabular-nums">{rows.length.toLocaleString()}</b></> }] : []),
    { key: 'duties' as Mode, label: <>{t('Extracted duties')} <b className="tabular-nums">{(c?.duties ?? 0).toLocaleString()}</b></> },
    { key: 'scope' as Mode, label: <>{t('Scope & commencement')} <b className="tabular-nums">{(c?.scope ?? 0).toLocaleString()}</b></> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto"><SegmentedControl ariaLabel="Obligation source" options={options} value={mode} onChange={setModeSel} /></div>
        <span className="text-xs text-muted">
          {mode === 'assessed' ? t('Each element checked against the hospital’s policies, SOPs, forms and controls.')
            : mode === 'duties' ? t('Duties the extractor lifted from the text, with the control and evidence links that exist.')
              : t('Title and commencement clauses — not compliance duties.')}
        </span>
      </div>
      {mode === 'assessed' && hasGap && (
        <AssessedView id={id} rows={rows} notApplicable={gap.data?.not_applicable ?? ov?.totals.not_applicable ?? 0}
                      graph={graph.data} go={go} preselect={params.get('ob')} docFilter={params.get('doc')} />
      )}
      {mode !== 'assessed' && chain.data && (
        <DutiesView id={id} data={chain.data} scope={mode === 'scope'} go={go} />
      )}
      {mode !== 'assessed' && !chain.data && (
        <div className="card"><EmptyState title={t('Obligations could not be loaded')} hint={t('The obligations endpoint did not answer.')} /></div>
      )}
    </div>
  );
}

/* ======================================================================
 * assessed — the gap-assessment rows
 * ==================================================================== */

const evidenceOf = (r: GapRow) => {
  const s = (r.subs ?? []).filter((x) => x.ev);
  return s.length ? { n: s.filter((x) => x.st === 'MET').length, m: s.length } : null;
};

function AssessedView({ id, rows, notApplicable, graph, go, preselect, docFilter }: {
  id: string; rows: GapRow[]; notApplicable: number; graph?: CascadeGraph; go: GoTab;
  preselect: string | null; docFilter: string | null;
}) {
  const t = useT();
  const resolve = useLinkResolver(graph);
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [dept, setDept] = useState('');
  const [risk, setRisk] = useState('');
  const [chap, setChap] = useState('');
  const [ctl, setCtl] = useState('');
  const [cat, setCat] = useState('');
  const [doc, setDoc] = useState(docFilter ?? '');
  const [star, setStar] = useState('');        // NABH asterisk: documentation required
  const [core, setCore] = useState(false);     // Core elements that are a fail risk
  const [order, setOrder] = useState<'doc' | 'risk'>('doc');
  const [sel, setSel] = useState<string | null>(null);
  const selection = useSelection();

  // a code handed over from another tab opens that row
  useEffect(() => {
    if (!preselect) return;
    const hit = rows.find((r) => r.c === preselect || r.rid === preselect);
    if (hit) { setSel(hit.key); setQ(hit.c); }
  }, [preselect, rows]);
  useEffect(() => { if (docFilter) setDoc(docFilter); }, [docFilter]);

  const n = useMemo(() => {
    const k = (s: string) => rows.filter((r) => r.st === s).length;
    return { met: k('MET'), partial: k('PARTIAL'), gap: k('GAP'), nc: k('NOT_COVERED'),
      core: rows.filter((r) => r.cat === 'CORE').length, coreFail: rows.filter(coreFailRisk).length,
      star: rows.filter((r) => r.doc).length };
  }, [rows]);
  const nabh = n.core > 0;
  const total = rows.length + notApplicable;
  const opts = useMemo(() => ({
    depts: [...new Set(rows.map((r) => r.dept))].sort(),
    chapters: [...new Set(rows.map((r) => r.chapter))],
    cats: [...new Set(rows.map((r) => r.cat).filter(Boolean))].sort(),
  }), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (st === 'UNMET' ? !(r.st === 'GAP' || r.st === 'NOT_COVERED') : st && r.st !== st) return false;
      if (dept && !r.depts.includes(dept)) return false;
      if (risk && riskKey(r.rk) !== risk) return false;
      if (chap && r.chapter !== chap) return false;
      if (cat && r.cat !== cat) return false;
      if (star && (star === 'yes') !== !!r.doc) return false;
      if (core && !coreFailRisk(r)) return false;
      if (ctl) { const has = resolve(r).ctrls.length > 0; if ((ctl === 'with') !== has) return false; }
      if (doc) { const l = resolve(r); if (!(r.by ?? []).includes(doc) && !l.ctrls.includes(doc)) return false; }
      if (needle && !(`${r.c} ${r.ob} ${r.t} ${r.who} ${r.chapter}`.toLowerCase().includes(needle))) return false;
      return true;
    });
    if (order === 'risk') {
      // NABH's pass/fail lever first: a Core element short of documented fails accreditation
      out.sort((a, b) => ((coreFailRisk(b) ? 1 : 0) - (coreFailRisk(a) ? 1 : 0))
        || (RISK_ORDER[riskKey(a.rk)] - RISK_ORDER[riskKey(b.rk)])
        || ((UNMET.has(b.st) ? 1 : 0) - (UNMET.has(a.st) ? 1 : 0)));
    }
    return out;
  }, [rows, q, st, dept, risk, chap, cat, star, core, ctl, doc, order, resolve]);

  const paging = usePaging(filtered, [q, st, dept, risk, chap, cat, star, core, ctl, doc, order].join('|'));
  const current = rows.find((r) => r.key === sel) ?? null;

  const exportRows = () => {
    const pick = selection.sel.size ? filtered.filter((r) => selection.has(r.key)) : filtered;
    downloadCsv(`${id}-obligations.csv`,
      ['Code', 'Obligation', 'Regulator wording', 'Chapter', 'Department', 'Responsible', 'Risk', 'Status', 'Linked controls', 'Documents', 'Gap', 'Fix'],
      pick.map((r) => [r.c, r.ob, r.t, r.chapter, r.dept, r.who, riskKey(r.rk), gapUi(r.st).ob,
        resolve(r).ctrls.join(' '), (r.by ?? []).join(' '), r.gap, r.fix]));
  };

  return (
    <div className="space-y-4">
      <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-3', (nabh ? 1 : 0) + (notApplicable > 0 ? 1 : 0) + 4 >= 6 ? 'xl:grid-cols-6' : (nabh || notApplicable > 0) ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
        <MetricCard label={t('Total obligations')} value={total.toLocaleString()} tone="brand" icon="ShieldCheck"
                    foot={t('{n} applicable', { n: rows.length.toLocaleString() })} onClick={() => setSt('')} />
        <MetricCard label={t('Fully documented')} value={n.met.toLocaleString()} tone="green" icon="CheckCircle2"
                    pct={pctOf(n.met, total)} onClick={() => setSt(st === 'MET' ? '' : 'MET')} active={st === 'MET'} />
        <MetricCard label={t('Partly documented')} value={n.partial.toLocaleString()} tone="amber" icon="AlertTriangle"
                    pct={pctOf(n.partial, total)} onClick={() => setSt(st === 'PARTIAL' ? '' : 'PARTIAL')} active={st === 'PARTIAL'} />
        <MetricCard label={t('Not addressed')} value={(n.gap + n.nc).toLocaleString()} tone="red" icon="UserX"
                    pct={pctOf(n.gap + n.nc, total)} foot={t('{gap} gap · {nc} not covered', { gap: n.gap.toLocaleString(), nc: n.nc.toLocaleString() })}
                    onClick={() => setSt(st === 'UNMET' ? '' : 'UNMET')} active={st === 'UNMET'} />
        {nabh && (
          <MetricCard label={t('Core fail risks')} value={n.coreFail.toLocaleString()} tone="red" icon="Flame"
                      foot={t('of {n} Core elements · each must score 4+', { n: n.core.toLocaleString() })}
                      onClick={() => { setCore(!core); setOrder('risk'); }} active={core} />
        )}
        {notApplicable > 0 && <MetricCard label={t('Not applicable')} value={notApplicable.toLocaleString()} tone="gray" icon="MinusCircle"
                    pct={pctOf(notApplicable, total)} />}
      </div>
      {nabh && (
        <Callout tone="blue" icon="Info" title={t('These verdicts come from the hospital’s documents, not from records.')}>
          {t('NABH scores each element 1–5 from sampled records, observation and staff interviews. “Fully documented” means a policy or SOP covers the element. It is not yet a score.')}{' '}
          {t('Elements marked “{term}” ({n}) need an approved, controlled document; without one the score drops by one.', {
            term: t('Documentation required *'), n: n.star.toLocaleString(),
          })}
        </Callout>
      )}

      <div>
        <div className="card min-w-0 overflow-hidden">
          <FilterBar q={q} onQ={setQ} placeholder={t('Search obligations…')}
            right={<ExportButton count={selection.sel.size} onExport={exportRows} />}
            more={<>
              <FilterSelect label={t('Area')} value={chap} onChange={setChap} options={opts.chapters.map((x) => ({ value: x, label: t(x) }))} />
              <FilterSelect label={t('Control')} value={ctl} onChange={setCtl} allLabel={t('Any')}
                            options={[{ value: 'with', label: t('Has a control') }, { value: 'without', label: t('No control') }]} />
              {opts.cats.length > 0 && <FilterSelect label={t('Category')} value={cat} onChange={setCat} options={opts.cats.map((x) => ({ value: x, label: t(words(x)) }))} />}
              {n.star > 0 && (
                <FilterSelect label={t('Documentation *')} value={star} onChange={setStar} allLabel={t('Any')}
                              options={[{ value: 'yes', label: t('Required (*)') }, { value: 'no', label: t('Not required') }]} />
              )}
              <FilterSelect label={t('Order')} value={order === 'risk' ? 'risk' : ''} onChange={(v) => setOrder(v === 'risk' ? 'risk' : 'doc')} allLabel={t('Document order')}
                            options={[{ value: 'risk', label: t(nabh ? 'Core fail risks, then highest risk' : 'Highest risk first') }]} />
              {core && (
                <button className="pill bg-critical-50 text-critical-700 hover:bg-critical-100" onClick={() => setCore(false)}>
                  {t('Core fail risks only')} ×
                </button>
              )}
              {doc && (
                <button className="pill bg-brand-50 text-brand-700 hover:bg-brand-100" onClick={() => setDoc('')}>
                  {t('Linked to {doc}', { doc })} ×
                </button>
              )}
            </>}>
            <FilterSelect label={t('Status')} value={st} onChange={setSt}
                          options={[{ value: 'MET', label: t('Fully documented') }, { value: 'PARTIAL', label: t('Partly documented') },
                            { value: 'UNMET', label: t('Not addressed (all)') }, { value: 'GAP', label: t('Gap') }, { value: 'NOT_COVERED', label: t('Not covered') }]} />
            <FilterSelect label={t('Department')} value={dept} onChange={setDept} options={opts.depts.map((x) => ({ value: x, label: t(x) }))} />
            <FilterSelect label={t('Risk')} value={risk} onChange={setRisk} options={['Critical', 'High', 'Medium', 'Low'].map((x) => ({ value: x, label: t(x) }))} />
          </FilterBar>

          {filtered.length === 0 ? (
            <EmptyState title={t('No obligation matches these filters')} hint={t('Clear a filter to see more rows.')} icon="Filter" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-slate-50/80">
                    <th className="w-10 px-3 py-2.5"><HeaderCheckbox keys={paging.pageRows.map((r) => r.key)} selection={selection} /></th>
                    <th className={cn(TH, 'w-10')}>#</th>
                    <th className={cn(TH, 'min-w-[320px]')}>{t('Obligation / duty')}</th>
                    <th className={cn(TH)}>{t('Department')}</th>
                    <th className={TH}>{t('Risk')}</th>
                    <th className={cn(TH)}>{t('Linked control')}</th>
                    <th className={TH}>{t('Status')}</th>
                    <th className={TH} title={t('Guidebook evidence items met / named')}>{t('Evidence')}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {paging.pageRows.map((r, i) => {
                    const l = resolve(r);
                    const ev = evidenceOf(r);
                    const c0 = l.ctrls[0];
                    return (
                      <tr key={r.key} {...rowProps(sel === r.key, () => setSel(sel === r.key ? null : r.key))}>
                        <td className="px-3 py-3"><RowCheckbox k={r.key} selection={selection} label={r.c} /></td>
                        <td className={cn('px-3 py-3 text-xs tabular-nums text-muted')}>{paging.offset + i + 1}</td>
                        <td className="min-w-[320px] max-w-[560px] px-3 py-3">
                          <p className="line-clamp-2 font-semibold leading-snug text-ink">{r.ob || r.rq || r.t}</p>
                          <p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
                            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-700">{r.c}</span>
                            {r.cat === 'CORE' && <span className="shrink-0 rounded bg-critical-50 px-1.5 py-0.5 text-[11px] font-semibold text-critical-700" title={t('NABH Core element: must score 4 or more')}>{t('Core')}</span>}
                            {r.doc && <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700" title={t('NABH asterisk (*): a written, approved, controlled document is mandatory')}>{t('Doc *')}</span>}
                            <span className="truncate" title={r.ob ? r.t : r.unitTitle}>{r.ob ? r.t : r.unitTitle}</span>
                          </p>
                        </td>
                        <td className={cn('w-[160px] max-w-[170px] px-3 py-3 text-[12.5px] text-ink-2')}>
                          <DeptLabel name={r.dept} title={r.who || undefined} />
                        </td>
                        <td className="px-3 py-3" title={t(r.chapter)}><RiskPill risk={r.rk} /></td>
                        <td className={cn('max-w-[180px] px-3 py-3')}>
                          {c0 ? (
                            <div className="min-w-0">
                              <div className="flex items-center gap-1 text-xs font-semibold text-brand-700"><ShieldCheck className="h-3.5 w-3.5" />{c0}
                                {l.ctrls.length > 1 && <span className="font-normal text-muted">+{l.ctrls.length - 1}</span>}</div>
                              <div className="truncate text-[11.5px] text-muted" title={graph?.docs[c0]?.t}>{graph?.docs[c0]?.t}</div>
                            </div>
                          ) : <span className="text-xs font-medium text-critical-600">{t('No control')}</span>}
                        </td>
                        <td className="px-3 py-3"><GapPill status={r.st} obligation /></td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">
                          {ev ? <span className={cn('font-semibold', ev.n === ev.m ? 'text-success-600' : ev.n ? 'text-warning-600' : 'text-critical-600')}>{ev.n}/{ev.m}</span>
                            : (r.by ?? []).length ? <span className="inline-flex items-center gap-1 text-brand-700"><Link2 className="h-3.5 w-3.5" />{(r.by ?? []).length}</span>
                              : <span className="text-muted-2">—</span>}
                        </td>
                        <td className="px-2 py-3 text-muted-2"><ChevronRight className="h-4 w-4" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <TableFooter page={paging.page} size={paging.size} total={paging.total} onPage={paging.setPage} onSize={paging.setSize} noun={t('obligations')} />
        </div>

        {current && <GapRowPanel row={current} links={resolve(current)} graph={graph} id={id} go={go} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

function GapRowPanel({ row, links, graph, id, go, onClose }: {
  row: GapRow; links: Links; graph?: CascadeGraph; id: string; go: GoTab; onClose: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState('details');
  useEffect(() => setTab('details'), [row.key]);
  const docs = graph?.docs ?? {};
  const risks = graph?.risks ?? {};
  const subs = row.subs ?? [];
  const ev = evidenceOf(row);
  const c0 = links.ctrls[0];
  const owner = c0 ? docs[c0]?.o : undefined;
  const subCount = (s: string) => subs.filter((x) => x.st === s).length;
  const unmet = UNMET.has(row.st);

  return (
    <SidePanel labelId="ob-panel-title" onClose={onClose}
      eyebrow={<span className="inline-flex items-center gap-2"><span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">{row.c}</span>{t(row.chapter)}</span>}
      title={row.ob || row.rq || row.t}
      badge={<><GapPill status={row.st} obligation /><RiskPill risk={row.rk} />{row.cat && <Pill tone="purple">{t(words(row.cat))}</Pill>}
        {coreFailRisk(row) && <CoreFailPill />}{row.doc && <DocRequiredPill />}</>}
      tabs={[{ key: 'details', label: t('Details') }, { key: 'reqs', label: t('Requirements ({n})', { n: (subs.length || 1).toLocaleString() }) },
        { key: 'docs', label: t('Documents ({n})', { n: (row.by ?? []).length.toLocaleString() }) }]}
      tab={tab} onTab={setTab}
      footer={<>
        <button className="btn btn-primary btn-sm" onClick={() => go('Requirements', { q: row.c })}>{t('View requirements')}</button>
        <button className="btn btn-outline btn-sm" disabled={!c0} onClick={() => c0 && go('Controls', { view: 'docs', doc: c0 })}>{t('Open control')}</button>
        <button className="btn btn-sm" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(id)}`)}>{t('View impact cascade')}</button>
      </>}>
      {tab === 'details' && (<>
        {unmet && row.gap && <Callout tone="red" title={t('Gap identified')}>{row.gap}</Callout>}
        {row.fix && <Callout tone="blue" icon="Wrench" title={t('Recommended fix')}>{row.fix}</Callout>}
        {row.why && (
          <p className="flex gap-2 rounded-lg bg-warning-50 px-3 py-2 text-[12.5px] leading-relaxed text-warning-700">
            <Flame className="mt-0.5 h-4 w-4 shrink-0" /><span><b>{t('If not complied')}:</b> {row.why}</span>
          </p>
        )}

        <PanelBlock title={t('Obligation summary')}>
          <p className="text-[13px] leading-relaxed text-ink-2">{row.ob || row.rq || '—'}</p>
          {row.rq && row.rq !== row.ob && <p className="mt-1.5 text-xs leading-relaxed text-muted"><b className="text-ink-2">{t('Testable requirement')}:</b> {row.rq}</p>}
        </PanelBlock>

        <div className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3 [&>*]:min-w-0">
          <Field label={t('Section')}>{row.c}</Field>
          <Field label={t('Department')}><DeptLabel name={row.dept} title={row.who || undefined} /></Field>
          <Field label={t('Risk area')}><span className="line-clamp-2 text-[13px]" title={t(row.chapter)}>{t(row.chapter)}</span></Field>
        </div>

        <PanelBlock title={t('Linked control')} link={links.ctrls.length > 1 ? { label: t('All {n}', { n: links.ctrls.length.toLocaleString() }), onClick: () => go('Controls', { view: 'docs' }) } : undefined}>
          {c0 ? (
            <ul className="space-y-2">
              {links.ctrls.slice(0, 2).map((code) => (
                <li key={code}>
                  <button onClick={() => go('Controls', { view: 'docs', doc: code })}
                          className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left hover:border-brand-300 hover:bg-brand-50/40">
                    <Tile icon="ShieldCheck" cls="bg-success-50 text-success-600" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-brand-700">{code}</span>
                      <span className="block truncate text-[13px] font-medium text-ink">{docs[code]?.t}</span>
                      <span className="block truncate text-xs text-muted">{[docs[code]?.freq, docs[code]?.o && t('Owner {name}', { name: docs[code]?.o ?? '' })].filter(Boolean).join(' · ') || '—'}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-2" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Callout tone="amber" title={t('No control linked')}>{t('None of the documents the assessment cited runs a control for this obligation.')}</Callout>
          )}
        </PanelBlock>

        <PanelBlock title={t('Related requirements')} link={subs.length > 3 ? { label: t('View all'), onClick: () => setTab('reqs') } : undefined}>
          {subs.length ? (<>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] as const).filter((s) => subCount(s)).map((s) => (
                <Pill key={s} tone={GAP_UI[s].tone}>{subCount(s)} {t(GAP_UI[s].label).toLowerCase()}</Pill>
              ))}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {subs.slice(0, 3).map((s) => (
                <li key={s.n} className="flex items-start gap-2.5 px-3 py-2">
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2"><b className="text-ink">{row.c}.{s.n}</b> {s.rq}</span>
                  <GapPill status={s.st} />
                </li>
              ))}
            </ul>
          </>) : (
            <div className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2">
              <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">{row.rq || row.t}</span>
              <GapPill status={row.st} />
            </div>
          )}
        </PanelBlock>

        <PanelBlock title={t('Documents checked')} link={(row.by ?? []).length > 4 ? { label: t('View all'), onClick: () => setTab('docs') } : undefined}>
          {(row.by ?? []).length ? (
            <ul className="space-y-1.5">
              {(row.by ?? []).slice(0, 4).map((code) => (
                <li key={code} className="flex items-center gap-2 text-[12.5px]">
                  {docs[code] ? <KindChip kind={docs[code].k} /> : <Pill tone="gray">{t('Document')}</Pill>}
                  <b className="shrink-0 text-ink">{code}</b>
                  <span className="truncate text-muted">{docs[code]?.t ?? ''}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted">{t('No hospital document covers this obligation.')}</p>}
        </PanelBlock>

        <PanelBlock title={t('Ownership')}>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2.5">
              {owner ? <Avatar name={owner} size={32} /> : <Tile icon="UserX" cls="bg-critical-50 text-critical-500" size="md" />}
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[13px] font-medium text-ink">{owner ?? t('No control owner')}</div>
                <div className="text-xs text-muted">{t('Control owner')}</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Tile icon={deptUi(row.dept).icon} cls={deptUi(row.dept).cls} />
              <div className="min-w-0 leading-tight">
                <div className="line-clamp-2 text-[13px] font-medium text-ink" title={row.who}>{row.who || '—'}</div>
                <div className="text-xs text-muted">{t('Responsible (assessment)')}</div>
              </div>
            </div>
          </div>
        </PanelBlock>

        <PanelBlock title={t('Relationship')}>
          <FlowSteps steps={[
            { icon: 'ClipboardList', label: row.c, sub: t('Obligation'), tone: 'blue' },
            { icon: 'ListChecks', label: (subs.length || 1) === 1 ? t('1 requirement') : t('{n} requirements', { n: subs.length.toLocaleString() }),
              sub: subs.length ? t('{n} documented', { n: subCount('MET').toLocaleString() }) : t(gapUi(row.st).label), tone: 'purple' },
            { icon: 'ShieldCheck', label: c0 ?? t('None'), sub: t('Control'), tone: c0 ? 'green' : 'red', onClick: c0 ? () => go('Controls', { view: 'docs', doc: c0 }) : undefined },
            { icon: 'Paperclip', label: ev ? `${ev.n}/${ev.m}` : (row.by ?? []).length === 1 ? t('1 doc') : t('{n} docs', { n: (row.by ?? []).length.toLocaleString() }),
              sub: t('Evidence'), tone: ev ? (ev.n === ev.m ? 'green' : 'amber') : (row.by ?? []).length ? 'teal' : 'red' },
            { icon: 'UserRound', label: owner ?? t('Unassigned'), sub: t('Owner'), tone: owner ? 'teal' : 'red' },
          ]} />
        </PanelBlock>

        {links.risks.length > 0 && (
          <PanelBlock title={t('Related risks')}>
            <ul className="space-y-1.5">
              {links.risks.slice(0, 4).map((code) => (
                <li key={code} className="flex items-center gap-2.5 text-[12.5px]">
                  <Tile icon="AlertTriangle" cls="bg-notcov-50 text-notcov-500" size="sm" />
                  <b className="shrink-0 text-ink">{code}</b>
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={risks[code]?.t}>{risks[code]?.t ?? ''}</span>
                  {risks[code]?.rating && <RiskPill risk={risks[code]?.rating} />}
                </li>
              ))}
            </ul>
          </PanelBlock>
        )}

        <details className="rounded-xl border border-line px-3 py-2">
          <summary className="cursor-pointer text-[12.5px] font-medium text-brand-600">{t('The regulator’s wording')}</summary>
          <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{row.t}</p>
          {row.interp && <p className="mt-2 border-l-2 border-violet-200 pl-2.5 text-xs leading-relaxed text-muted"><b className="text-ink-2">{t('Guidebook interpretation')}:</b> {row.interp}</p>}
          {row.gbp != null && <p className="mt-1 text-xs text-muted">{t('Guidebook page {n}', { n: row.gbp })}</p>}
        </details>
      </>)}

      {tab === 'reqs' && (
        subs.length ? (
          <ul className="space-y-2.5">
            {subs.map((s) => (
              <li key={s.n} className="rounded-xl border border-line p-3">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink"><b>{row.c}.{s.n}</b> {s.rq}</span>
                  <GapPill status={s.st} />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  {s.who && <span>{t('Who')}: <b className="font-medium text-ink-2">{s.who}</b></span>}
                  {s.freq && <span>{t('Frequency')}: <b className="font-medium text-ink-2">{s.freq}</b></span>}
                  {s.risk && s.risk !== 'None' && <RiskPill risk={s.risk} />}
                </div>
                {s.ev && <p className="mt-1.5 text-xs text-muted"><b className="text-ink-2">{t('Evidence expected')}:</b> {s.ev}</p>}
                {UNMET.has(s.st) && s.gap && <p className="mt-1.5 text-xs text-critical-600"><b>{t('Gap')}:</b> {s.gap}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-line p-3">
            <div className="flex items-start gap-2"><span className="flex-1 text-[13px] text-ink">{row.rq || row.t}</span><GapPill status={row.st} /></div>
            <p className="mt-2 text-xs text-muted">{t('The assessment states one testable requirement for this element.')}</p>
          </div>
        )
      )}

      {tab === 'docs' && (
        (row.by ?? []).length ? (
          <ul className="space-y-2">
            {(row.by ?? []).map((code) => (
              <li key={code} className="rounded-xl border border-line p-3">
                <div className="flex items-center gap-2">
                  {docs[code] ? <KindChip kind={docs[code].k} /> : <Pill tone="gray">{t('Document')}</Pill>}
                  <b className="text-[13px] text-ink">{code}</b>
                </div>
                <p className="mt-1 text-[13px] text-ink-2">{docs[code]?.t ?? t('Not in the document register')}</p>
                <p className="mt-0.5 text-xs text-muted">{[docs[code]?.o && t('Owner {name}', { name: docs[code]?.o ?? '' }), docs[code]?.f && t('File {name}', { name: docs[code]?.f ?? '' })].filter(Boolean).join(' · ')}</p>
              </li>
            ))}
          </ul>
        ) : <EmptyState title={t('No document checked')} hint={t('No hospital policy, SOP, form or control covers this obligation.')} icon="FileWarning" />
      )}
    </SidePanel>
  );
}

/* ======================================================================
 * extracted duties — the obligation chain
 * ==================================================================== */

type ChainData = NonNullable<ReturnType<typeof useRegulationObligationChain>['data']>;

function DutiesView({ id, data, scope, go }: { id: string; data: ChainData; scope: boolean; go: GoTab }) {
  // `t` names a duty type in the lists below, so the translate function is `tr` here
  const tr = useT();
  const c = data.counts;
  const [q, setQ] = useState('');
  const [ctl, setCtl] = useState('');
  const [evd, setEvd] = useState('');
  const [type, setType] = useState('');
  const [rev, setRev] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const selection = useSelection();
  const base = useMemo(() => data.items.filter((o) => (scope ? o.kind === 'scope' : o.kind === 'duty')), [data, scope]);
  const types = useMemo(() => [...new Set(base.map((o) => o.obligation_type).filter(Boolean) as string[])].sort(), [base]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return base.filter((o) => {
      if (ctl && (ctl === 'with') !== (o.controlStatus === 'MAPPED')) return false;
      if (evd && (evd === 'stated') !== (o.evidenceStatus === 'STATED')) return false;
      if (type && o.obligation_type !== type) return false;
      if (rev && (rev === 'verified') !== !!o.verified) return false;
      if (needle && !(`${o.title} ${o.description ?? ''} ${o.source_reference ?? ''} ${o.responsible_entity ?? ''}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [base, q, ctl, evd, type, rev]);
  const paging = usePaging(filtered, [q, ctl, evd, type, rev, scope].join('|'));
  const current = base.find((o) => o.id === sel) ?? null;
  const withCtl = base.filter((o) => o.controlStatus === 'MAPPED').length;
  const evStated = base.filter((o) => o.evidenceStatus === 'STATED').length;

  const exportRows = () => {
    const pick = selection.sel.size ? filtered.filter((o) => selection.has(o.id)) : filtered;
    downloadCsv(`${id}-${scope ? 'scope' : 'duties'}.csv`,
      ['Duty', 'Source', 'Type', 'Responsible', 'Frequency', 'Control', 'Evidence', 'Reviewed'],
      pick.map((o) => [o.title, o.source_reference, o.obligation_type, o.responsible_entity, o.frequency,
        o.control_name ?? 'Not mapped', o.evidenceStatus === 'STATED' ? 'Stated' : 'Not stated', o.verified ? 'Yes' : 'No']));
  };

  return (
    <div className="space-y-4">
      {!scope && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <MetricCard label={tr('Duties')} value={c.duties.toLocaleString()} tone="brand" icon="ClipboardCheck" onClick={() => { setCtl(''); setEvd(''); setRev(''); }} />
          <MetricCard label={tr('With a control')} value={c.withControl.toLocaleString()} tone="green" icon="ShieldCheck" pct={pctOf(c.withControl, c.duties)}
                      onClick={() => setCtl(ctl === 'with' ? '' : 'with')} active={ctl === 'with'} />
          <MetricCard label={tr('No control')} value={c.withoutControl.toLocaleString()} tone="red" icon="ShieldAlert" pct={pctOf(c.withoutControl, c.duties)}
                      onClick={() => setCtl(ctl === 'without' ? '' : 'without')} active={ctl === 'without'} />
          <MetricCard label={tr('Evidence stated')} value={c.evidenceStated.toLocaleString()} tone="teal" icon="FileSearch" pct={pctOf(c.evidenceStated, c.duties)}
                      onClick={() => setEvd(evd === 'stated' ? '' : 'stated')} active={evd === 'stated'} />
          <MetricCard label={tr('Human-verified')} value={c.verified.toLocaleString()} tone="purple" icon="BadgeCheck" pct={pctOf(c.verified, c.total)}
                      onClick={() => setRev(rev === 'verified' ? '' : 'verified')} active={rev === 'verified'} />
        </div>
      )}
      <Callout tone="blue" title={`${data.extraction.method}.`}>{data.extraction.note}</Callout>

      {/* the shape of the list, above the table so the duty text keeps its width */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="card p-5">
          <h3 className="text-[15px] font-semibold text-ink">{tr('Control coverage')}</h3>
          <Donut className="mt-3" size={112} thickness={16} sub={tr(scope ? 'clauses' : 'duties')}
                 data={[{ label: tr('Control mapped'), value: withCtl, color: '#16a34a', onClick: () => setCtl('with') },
                   { label: tr('No control'), value: base.length - withCtl, color: '#dc2626', onClick: () => setCtl('without') }]} />
        </div>
        <div className="card p-5">
          <h3 className="text-[15px] font-semibold text-ink">{tr('Evidence named by the regulator')}</h3>
          <Donut className="mt-3" size={112} thickness={16} sub={tr(scope ? 'clauses' : 'duties')}
                 data={[{ label: tr('Stated'), value: evStated, color: '#14b8a6', onClick: () => setEvd('stated') },
                   { label: tr('Not stated'), value: base.length - evStated, color: '#f59e0b', onClick: () => setEvd('not') }]} />
        </div>
        <div className="card p-5 md:col-span-2 xl:col-span-1">
          <h3 className="mb-3 text-[15px] font-semibold text-ink">{tr('By duty type')}</h3>
          {types.length
            ? <BarList data={types.map((t) => ({ label: readable(t), value: base.filter((o) => o.obligation_type === t).length, onClick: () => setType(t) }))
                .sort((a, b) => b.value - a.value).slice(0, 5)} />
            : <p className="text-[13px] text-muted">{tr('No duty type was extracted.')}</p>}
        </div>
      </div>

      <div>
        <div className="card min-w-0 overflow-hidden">
          <FilterBar q={q} onQ={setQ} placeholder={tr(scope ? 'Search clauses…' : 'Search duties…')}
            right={<ExportButton count={selection.sel.size} onExport={exportRows} />}
            more={<>
              {types.length > 0 && <FilterSelect label={tr('Type')} value={type} onChange={setType} options={types.map((t) => ({ value: t, label: readable(t) }))} />}
              <FilterSelect label={tr('Review')} value={rev} onChange={setRev} allLabel={tr('Any')}
                            options={[{ value: 'verified', label: tr('Human-verified') }, { value: 'unreviewed', label: tr('Unreviewed') }]} />
            </>}>
            <FilterSelect label={tr('Control')} value={ctl} onChange={setCtl} allLabel={tr('Any')}
                          options={[{ value: 'with', label: tr('Mapped') }, { value: 'without', label: tr('Not mapped') }]} />
            <FilterSelect label={tr('Evidence')} value={evd} onChange={setEvd} allLabel={tr('Any')}
                          options={[{ value: 'stated', label: tr('Stated') }, { value: 'not', label: tr('Not stated') }]} />
          </FilterBar>
          {filtered.length === 0 ? (
            <EmptyState title={tr(base.length ? 'Nothing matches these filters' : 'Nothing in this group')} icon="Inbox" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-slate-50/80">
                    <th className="w-10 px-3 py-2.5"><HeaderCheckbox keys={paging.pageRows.map((o) => o.id)} selection={selection} /></th>
                    <th className={cn(TH, 'w-10')}>#</th>
                    <th className={cn(TH, 'min-w-[320px]')}>{tr('Duty')}</th>
                    <th className={TH}>{tr('Source')}</th>
                    <th className={cn(TH)}>{tr('Responsible')}</th>
                    <th className={TH}>{tr('Control')}</th>
                    <th className={TH}>{tr('Evidence')}</th>
                    <th className={cn(TH)}>{tr('Review')}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {paging.pageRows.map((o, i) => (
                    <tr key={o.id} {...rowProps(sel === o.id, () => setSel(sel === o.id ? null : o.id))}>
                      <td className="px-3 py-3"><RowCheckbox k={o.id} selection={selection} label={o.title} /></td>
                      <td className={cn('px-3 py-3 text-xs tabular-nums text-muted')}>{paging.offset + i + 1}</td>
                      <td className="min-w-[320px] max-w-[560px] px-3 py-3">
                        <TwoLine title={prettyCaps(o.title)} sub={[o.obligation_type && readable(o.obligation_type), o.frequency && readable(o.frequency), o.mandatory_action].filter(Boolean).join(' · ') || undefined} />
                      </td>
                      <td className="max-w-[150px] px-3 py-3 text-xs text-ink-2"><span className="line-clamp-2">{prettyCaps(o.source_reference) ?? '—'}</span></td>
                      <td className={cn('max-w-[160px] px-3 py-3 text-xs text-ink-2')}><span className="line-clamp-2">{o.responsible_entity ?? '—'}</span></td>
                      <td className="max-w-[180px] px-3 py-3">
                        {o.controlStatus === 'MAPPED'
                          ? <span className="inline-flex max-w-full items-center gap-1 text-xs font-semibold text-brand-700" title={o.control_name ?? undefined}><ShieldCheck className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{o.control_name ?? tr('Mapped')}</span></span>
                          : <Pill tone="red">{tr('Not mapped')}</Pill>}
                      </td>
                      <td className="px-3 py-3">{o.evidenceStatus === 'STATED' ? <Pill tone="green">{tr('Stated')}</Pill> : <Pill tone="amber">{tr('Not stated')}</Pill>}</td>
                      <td className={cn('px-3 py-3')}>{o.verified ? <Pill tone="green" icon="BadgeCheck">{tr('Verified')}</Pill> : <Pill tone="gray">{tr('Unreviewed')}</Pill>}</td>
                      <td className="px-2 py-3 text-muted-2"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TableFooter page={paging.page} size={paging.size} total={paging.total} onPage={paging.setPage} onSize={paging.setSize} noun={tr(scope ? 'clauses' : 'duties')} />
        </div>

        {current
          ? <DutyPanel o={current} id={id} go={go} onClose={() => setSel(null)} />
          : null}
      </div>
    </div>
  );
}

function DutyPanel({ o, id, go, onClose }: { o: ObligationRow; id: string; go: GoTab; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const mapped = o.controlStatus === 'MAPPED';
  return (
    <SidePanel labelId="duty-panel-title" onClose={onClose}
      eyebrow={o.source_reference ? prettyCaps(o.source_reference) : t('Extracted duty')}
      title={prettyCaps(o.title)}
      badge={<>
        {mapped ? <Pill tone="green" icon="ShieldCheck">{t('Control mapped')}</Pill> : <Pill tone="red" icon="ShieldAlert">{t('No control')}</Pill>}
        {o.verified ? <Pill tone="green" icon="BadgeCheck">{t('Human-verified')}</Pill> : <Pill tone="gray">{t('Unreviewed')}</Pill>}
        {o.obligation_type && <Pill tone="blue">{readable(o.obligation_type)}</Pill>}
      </>}
      footer={<>
        <button className="btn btn-primary btn-sm" onClick={() => go('Requirements', { obl: o.id })}>{t('View requirements')}</button>
        <button className="btn btn-sm" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(id)}`)}>{t('View impact cascade')}</button>
      </>}>
      {!mapped && <Callout tone="red" title={t('Control gap')}>{t('No control is mapped to this duty, so nothing currently mitigates it.')}</Callout>}
      {o.description && o.description !== o.title && (
        <PanelBlock title={t('Obligation summary')}><p className="text-[13px] leading-relaxed text-ink-2">{o.description}</p></PanelBlock>
      )}
      <div className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3 [&>*]:min-w-0">
        <Field label={t('Responsible')}><span className="line-clamp-2 text-[13px]">{o.responsible_entity ?? '—'}</span></Field>
        <Field label={t('Frequency')}>{o.frequency ? readable(o.frequency) : '—'}</Field>
        <Field label={t('Confidence')}>{o.confidence != null ? `${Math.round(o.confidence * 100)}%` : '—'}</Field>
      </div>
      {o.mandatory_action && <PanelBlock title={t('Required action')}><p className="text-[13px] text-ink-2">{o.mandatory_action}</p></PanelBlock>}
      <PanelBlock title={t('Linked control')}>
        {mapped ? (
          <div className="flex items-center gap-3 rounded-xl border border-line p-3">
            <Tile icon="ShieldCheck" cls="bg-success-50 text-success-600" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">{o.control_name ?? t('Mapped control')}</div>
              <div className="text-xs text-muted">{o.control_effectiveness ? readable(o.control_effectiveness) : t('Not tested')}{o.controls_mapped > 1 ? ` · ${t('{n} controls', { n: o.controls_mapped.toLocaleString() })}` : ''}</div>
            </div>
            {o.control_owner && <Avatar name={o.control_owner} size={28} />}
          </div>
        ) : <p className="text-[13px] text-muted">{t('None mapped.')}</p>}
      </PanelBlock>
      <PanelBlock title={t('Evidence the regulator names')}>
        {o.evidence_required
          ? <p className="border-l-2 border-teal-300 pl-3 text-[12.5px] leading-relaxed text-ink-2">{o.evidence_required}</p>
          : <p className="text-[13px] text-muted">{t('The text does not state what evidence is expected.')}</p>}
      </PanelBlock>
      <PanelBlock title={t('Relationship')}>
        <FlowSteps steps={[
          { icon: 'ClipboardList', label: t('Duty'), sub: o.source_reference ?? '', tone: 'blue' },
          { icon: 'ShieldCheck', label: mapped ? (o.control_name ?? t('Mapped')) : t('None'), sub: t('Control'), tone: mapped ? 'green' : 'red' },
          { icon: 'Paperclip', label: t(o.evidenceStatus === 'STATED' ? 'Stated' : 'Not stated'), sub: t('Evidence'), tone: o.evidenceStatus === 'STATED' ? 'teal' : 'amber' },
          { icon: 'UserRound', label: o.control_owner ?? t('Unassigned'), sub: t('Owner'), tone: o.control_owner ? 'teal' : 'red' },
        ]} />
      </PanelBlock>
      <p className="text-xs text-muted">{t('Extraction')}: {o.extraction_method ? readable(o.extraction_method) : '—'}</p>
    </SidePanel>
  );
}
