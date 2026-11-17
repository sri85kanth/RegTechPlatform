// ============================================================
// Requirements — the layer between "the regulation says X" and "here is the
// control that satisfies it".
//
// This tab previously claimed no requirements table existed. It does: 34,746
// rows. What is shown here is that table, joined to the three links that
// follow it, with every missing link named rather than hidden.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Link2, Paperclip, Download } from 'lucide-react';
import { EmptyState, Skeleton, Callout, Field } from '@/components/ui/primitives';
import { FlowSteps } from '@/components/ui/charts';
import { cn, readable, type Tone } from '@/utils/ui';
import {
  useRequirements, useRequirementDetail, useTraceability,
  type RequirementRow, type ChainStep,
} from '@/services/complianceApi';
import { tx, useT } from '@/i18n';
import {
  Pill, CompliancePill, complianceUi, FilterBar, FilterSelect, TableFooter, useSelection, HeaderCheckbox,
  RowCheckbox, downloadCsv, TH, rowProps, TwoLine, SidePanel, PanelBlock, Tile, words, type GoTab,
  useGapAssessment, flattenGap, coreFailRisk,
} from './regShared';

const STATE_TONE: Record<string, Tone> = {
  MAPPED: 'green', UNMAPPED: 'gray', PRESENT: 'green', ABSENT: 'gray', MISSING: 'amber',
  APPLICABLE: 'green', CONDITIONAL: 'amber', REVIEW_REQUIRED: 'amber', NOT_APPLICABLE: 'gray', NOT_ASSESSED: 'gray',
  NO_EVIDENCE: 'amber', INSUFFICIENT_EVIDENCE: 'amber', PASSED: 'green', FAILED: 'red', NO_VALIDITY_PERIOD: 'amber',
  VERIFIED: 'green', PENDING_REVIEW: 'gray', ACCEPTED: 'green', NEEDS_REVIEW: 'amber', UNREVIEWED: 'gray',
};
/** A stored state, in words, in its one colour. */
const StatePill = ({ v }: { v: string | null | undefined }) => {
  const t = useT();
  return <Pill tone={STATE_TONE[v ?? ''] ?? 'gray'}>{v ? t(words(v)) : '—'}</Pill>;
};
/** What kind of sentence decided a requirement's applicability, in a few words. */
const KIND_LABEL: Record<string, string> = {
  OURS: tx('Names us'), NOT_A_DUTY: tx('Not a duty'), AUTHORITY: tx("Authority's duty"),
  OTHER_TYPE: tx('Binds someone else'), AMBIGUOUS_TYPE: tx('Confirm who it binds'), SITUATION: tx('Only in a situation'),
  INHERITS: tx('Follows the regulation'), NO_DUTY_WORDS: tx('Follows the regulation'), REGULATION_OUT: tx('Regulation does not apply'),
};
/** A stored enum or free value for display: codes in words, blanks as a dash. */
const rd = (v: unknown) => (v == null || v === '' ? '—' : readable(String(v)));

/* ---------------- the tab ---------------- */
export function RequirementsTab({ id, go }: { id: string; go?: GoTab }) {
  // `t` is a timer in the search effect below, so the translate function is `tr` here
  const tr = useT();
  const [params] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const urlCtl = params.get('ctl') ?? '';
  const obl = params.get('obl') ?? '';
  const [q, setQ] = useState(urlQ);
  const [dq, setDq] = useState(urlQ);
  const [controlStatus, setControlStatus] = useState(urlCtl);
  const [evidence, setEvidence] = useState('');
  const [applies, setApplies] = useState('');
  const [oblFilter, setOblFilter] = useState(obl);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [open, setOpen] = useState<string | null>(null);
  const selection = useSelection();
  const seen = useRef(new Map<string, RequirementRow>());

  // a selection handed over from another tab
  useEffect(() => { setQ(urlQ); setDq(urlQ); }, [urlQ]);
  useEffect(() => { setControlStatus(urlCtl); }, [urlCtl]);
  useEffect(() => { setOblFilter(obl); }, [obl]);
  // search as you type, without a request per keystroke
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [dq, controlStatus, evidence, applies, oblFilter, size]);

  const reqParams: Parameters<typeof useRequirements>[0] & { obligation_id?: string } = {
    regulation_id: id, page, size, q: dq || undefined, control_status: controlStatus || undefined,
    evidence_status: evidence || undefined, applicability: applies || undefined, obligation_id: oblFilter || undefined,
  };
  const list = useRequirements(reqParams);
  useEffect(() => { list.data?.items.forEach((r) => seen.current.set(r.id, r)); }, [list.data]);
  const rows = list.data?.items ?? [];
  const current = open ? (rows.find((r) => r.id === open) ?? seen.current.get(open) ?? null) : null;
  // A column whose every row says the same thing ("Conditional" 639 times) is dropped.
  const showApplies = new Set(rows.map((r) => r.applicability ?? '')).size > 1;
  // NABH: how accreditation scores these elements, from the gap assessment (moved here from the old Obligations tab)
  const gap = useGapAssessment(id);
  const nabh = useMemo(() => {
    const g = flattenGap(gap.data);
    return { core: g.filter((r) => r.cat === 'CORE').length, coreFail: g.filter(coreFailRisk).length, star: g.filter((r) => r.doc).length };
  }, [gap.data]);

  const exportRows = () => {
    const pick = selection.sel.size ? [...selection.sel].map((k) => seen.current.get(k)).filter(Boolean) as RequirementRow[] : rows;
    downloadCsv(`${id}-requirements.csv`,
      ['Id', 'Requirement', 'Clause', 'Obligation', 'Responsible', 'Applies', 'Why', 'Controls', 'Evidence', 'Assessment', 'Compliance'],
      pick.map((r) => [r.id, r.statement, r.source_clause, r.obligation_title, r.responsible_role, r.applicability, r.applicability_reason ?? '',
        r.control_count, r.evidence_count, r.assessment_result, complianceUi(r.compliance_status).label]));
  };

  return (
    <div className="space-y-4">
      {nabh.core > 0 && (
        <Callout tone="blue" icon="Info" title={<>{tr('Core fail risks')}: <b className="tabular-nums">{nabh.coreFail.toLocaleString()}</b> · {tr('of {n} Core elements · each must score 4+', { n: nabh.core.toLocaleString() })}</>}>
          {tr('NABH scores each element 1–5 from sampled records, observation and staff interviews. “Fully documented” means a policy or SOP covers the element. It is not yet a score.')}{' '}
          {nabh.star > 0 && tr('Elements marked “{term}” ({n}) need an approved, controlled document; without one the score drops by one.', {
            term: tr('Documentation required *'), n: nabh.star.toLocaleString(),
          })}
        </Callout>
      )}
      <div>
        <div className="card min-w-0 overflow-hidden">
          <FilterBar q={q} onQ={setQ} placeholder={tr('Search requirement text or clause…')}
            right={<>
              <span className="hidden text-[12.5px] text-muted lg:inline">{list.data ? tr('{n} in this regulation', { n: list.data.total.toLocaleString() }) : ''}</span>
              <button type="button" className="btn btn-sm" onClick={exportRows} disabled={!rows.length}>
                <Download className="h-3.5 w-3.5" /> {selection.sel.size ? tr('Export {n} selected', { n: selection.sel.size.toLocaleString() }) : tr('Export this page')}
              </button>
            </>}
            more={<>
              <FilterSelect label={tr('Applies')} value={applies} onChange={setApplies} allLabel={tr('Any')}
                            options={['APPLICABLE', 'CONDITIONAL', 'REVIEW_REQUIRED', 'NOT_APPLICABLE'].map((v) => ({ value: v, label: tr(words(v)) }))} />
              {oblFilter && (
                <button className="pill bg-brand-50 text-brand-700 hover:bg-brand-100" onClick={() => setOblFilter('')}>{tr('One obligation')} ×</button>
              )}
            </>}>
            <FilterSelect label={tr('Control')} value={controlStatus} onChange={setControlStatus} allLabel={tr('Any')}
                          options={[{ value: 'mapped', label: tr('Mapped to a control') }, { value: 'unmapped', label: tr('No control mapped') }]} />
            <FilterSelect label={tr('Evidence')} value={evidence} onChange={setEvidence} allLabel={tr('Any')}
                          options={[{ value: 'present', label: tr('Evidence present') }, { value: 'absent', label: tr('No evidence') }]} />
          </FilterBar>

          {list.isLoading && <Skeleton rows={8} />}
          {list.error && <div className="py-8 text-center text-[13px] text-critical-600">{(list.error as Error).message}</div>}
          {list.data && rows.length === 0 && (
            <EmptyState title={tr(dq || controlStatus || evidence || applies || oblFilter ? 'No requirement matches these filters' : 'No requirements for this regulation.')}
                        hint={tr('Requirements are derived from extracted obligations. A regulation with no parsed obligations has none — that is a coverage gap, not an error.')} />
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-slate-50/80">
                    <th className="w-10 px-3 py-2.5"><HeaderCheckbox keys={rows.map((r) => r.id)} selection={selection} /></th>
                    <th className={cn(TH, 'w-10')}>#</th>
                    <th className={TH}>{tr('Requirement')}</th>
                    <th className={TH}>{tr('Section')}</th>
                    <th className={cn(TH)}>{tr('Responsible')}</th>
                    {showApplies && <th className={cn(TH)}>{tr('Applies')}</th>}
                    <th className={TH}>{tr('Control')}</th>
                    <th className={TH}>{tr('Evidence')}</th>
                    <th className={cn(TH)}>{tr('Status')}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} title={r.id} {...rowProps(open === r.id, () => setOpen(open === r.id ? null : r.id))}>
                      <td className="px-3 py-3"><RowCheckbox k={r.id} selection={selection} label={r.source_clause ?? r.id} /></td>
                      <td className={cn('px-3 py-3 text-xs tabular-nums text-muted')}>{(page - 1) * size + i + 1}</td>
                      <td className="min-w-[300px] max-w-[520px] px-3 py-3">
                        <TwoLine title={r.statement} sub={`${r.obligation_title ? r.obligation_title : tr('No parent obligation')}${r.frequency ? ` · ${r.frequency}` : ''}`} />
                        {!!r.criteria_count && (
                          <span className="mt-1 inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700"
                                title={tr('Guidebook assessment criteria for this element. NABH scores the element; the criteria are how it is checked.')}>
                            {r.criteria_count === 1 ? tr('1 guidebook criterion') : tr('{n} guidebook criteria', { n: r.criteria_count.toLocaleString() })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs font-medium text-ink-2">{r.source_clause ?? '—'}</td>
                      <td className={cn('max-w-[160px] px-3 py-3 text-xs text-ink-2')}><span className="line-clamp-2">{r.responsible_role ?? '—'}</span></td>
                      {showApplies && (
                        <td className="max-w-[180px] px-3 py-3" title={r.applicability_reason ?? undefined}>
                          <StatePill v={r.applicability} />
                          {r.applicability_kind && KIND_LABEL[r.applicability_kind] && (
                            <span className="mt-1 block truncate text-[11px] text-muted">{tr(KIND_LABEL[r.applicability_kind])}</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-3">
                        {r.control_count
                          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700"><Link2 className="h-3.5 w-3.5" />{r.control_count}</span>
                          : <Pill tone="red">{tr('None')}</Pill>}
                      </td>
                      <td className="px-3 py-3">
                        {r.evidence_count
                          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700"><Paperclip className="h-3.5 w-3.5" />{r.evidence_count}</span>
                          : <span className="text-xs text-muted-2">0</span>}
                      </td>
                      <td className={cn('px-3 py-3')}><StatePill v={r.assessment_result} /></td>
                      <td className="px-2 py-3 text-muted-2"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.data && list.data.total > 0 && (
            <TableFooter page={page} size={size} total={list.data.total} onPage={setPage} onSize={setSize} noun={tr('requirements')} />
          )}
        </div>

      </div>
      {open && <RequirementDetailPanel id={open} row={current} rid={id} go={go} onClose={() => setOpen(null)} />}

      {list.data && <p className="px-1 text-xs text-muted">{list.data.note}</p>}
    </div>
  );
}

/* ---------------- detail ---------------- */
const STEP_ICON: Record<string, string> = {
  REQUIREMENT: 'ClipboardList', APPLICABILITY: 'Target', CONTROL: 'ShieldCheck', EVIDENCE: 'Paperclip',
  ASSESSMENT: 'ClipboardCheck', COMPLIANCE: 'BadgeCheck', COMPLIANCE_RESULT: 'BadgeCheck', OBLIGATION: 'ScrollText', CLAUSE: 'Hash',
};
function ChainStrip({ chain }: { chain: ChainStep[] }) {
  const t = useT();
  return (
    <ol className="space-y-1.5">
      {chain.map((s) => (
        <li key={s.step} className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
          <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', s.state === 'PRESENT' ? 'bg-success-500' : 'bg-warning-500')} />
          <span className="w-[9.5rem] shrink-0 text-xs font-semibold text-ink-2">{t(readable(String(s.step)))}</span>
          <span className="text-muted">
            {s.state === 'PRESENT' ? String(s.detail ?? '') : <span className="text-warning-700">{t('Missing — {reason}', { reason: String(s.reason ?? '') })}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RequirementDetailPanel({ id, row, rid, go, onClose }: {
  id: string; row: RequirementRow | null; rid: string; go?: GoTab; onClose: () => void;
}) {
  // `t` is the traceability record below, so the translate function is `tr` here
  const tr = useT();
  const navigate = useNavigate();
  const detail = useRequirementDetail(id);
  const trace = useTraceability(id);
  const d = detail.data;
  const t = trace.data;
  const [tab, setTab] = useState('details');
  useEffect(() => setTab('details'), [id]);
  const statement = row?.statement ?? d?.requirement.statement ?? id;
  const cs = complianceUi(row?.compliance_status);
  const unmet = ['red', 'amber', 'orange'].includes(cs.tone);

  return (
    <SidePanel labelId="req-drawer-title" onClose={onClose}
      eyebrow={<span title={id}>{row?.source_clause ? tr('Clause {clause}', { clause: row.source_clause }) : tr('Requirement')}</span>}
      title={<span className="line-clamp-4">{statement}</span>}
      badge={row ? <><CompliancePill status={row.compliance_status} /><StatePill v={row.applicability} />
        {row.control_count
          ? <Pill tone="green" icon="ShieldCheck">{row.control_count === 1 ? tr('1 control') : tr('{n} controls', { n: row.control_count.toLocaleString() })}</Pill>
          : <Pill tone="red" icon="ShieldAlert">{tr('No control')}</Pill>}</> : undefined}
      tabs={[{ key: 'details', label: tr('Details') }, { key: 'lineage', label: tr('Lineage') },
        { key: 'trace', label: t ? tr('Traceability ({n}/{total})', { n: t.chain.filter((c) => c.state === 'PRESENT').length, total: t.chain.length }) : tr('Traceability') }]}
      tab={tab} onTab={setTab}
      footer={<>
        <button className="btn btn-primary btn-sm" onClick={() => go?.('Obligations', { ob: id })}>{tr('View in obligations')}</button>
        {d?.lineage.regulation.documentUrl && (
          <a className="btn btn-outline btn-sm" href={d.lineage.regulation.documentUrl} target="_blank" rel="noreferrer">{tr('Official PDF')}</a>
        )}
        <button className="btn btn-sm" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(rid)}`)}>{tr('Impact cascade')}</button>
      </>}>
      {detail.isLoading && <Skeleton rows={5} />}
      {detail.error && <p className="text-[13px] text-critical-600">{(detail.error as Error).message}</p>}

      {d && tab === 'details' && (<>
        {unmet && t?.assessments[0]?.rationale && <Callout tone="red" title={tr('{status} — assessment', { status: tr(cs.label) })}>{t.assessments[0].rationale}</Callout>}
        <div className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3 [&>*]:min-w-0">
          <Field label={tr('Responsible')}><span className="line-clamp-2 text-[13px]">{row?.responsible_role ?? rd(d.requirement.responsible_role)}</span></Field>
          <Field label={tr('Frequency')}>{row?.frequency ?? rd(d.requirement.frequency)}</Field>
          <Field label={tr('Evidence')}>{row ? (row.evidence_count === 1 ? tr('1 item') : tr('{n} items', { n: row.evidence_count.toLocaleString() })) : '—'}</Field>
        </div>
        {row?.applicability_reason && (
          <div className="rounded-xl border border-line px-3 py-2.5">
            <p className="sec-eyebrow mb-1 flex items-center gap-2">{tr('Does it apply to us?')}<StatePill v={row.applicability} /></p>
            <p className="text-[12.5px] leading-relaxed text-ink-2">{row.applicability_reason}</p>
          </div>
        )}
        {/* the four kinds of text, never blurred together */}
        <div className="rounded-xl border border-success-200 bg-success-50/50 p-3">
          <div className="text-2xs font-semibold text-success-700">{tr('Original legal text — verbatim')}</div>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{d.provenance.originalLegalText.text ?? tr('Not available')}</p>
          <div className="mt-1.5 text-xs text-muted">
            {rd(d.provenance.originalLegalText.kind)}
            {d.provenance.originalLegalText.citation ? ` · ${tr('cited as {citation}', { citation: d.provenance.originalLegalText.citation })}` : ''}
            {d.provenance.originalLegalText.page ? ` · ${tr('p.{page}', { page: d.provenance.originalLegalText.page })}` : ''}
          </div>
        </div>
        <div className="rounded-xl border border-violet-100 bg-violet-50/50 p-3">
          <div className="text-2xs font-semibold text-violet-700">{tr('Extracted obligation — system, not the drafter')}</div>
          <p className="mt-1 text-[12.5px] text-ink-2">{(d.lineage.obligation?.description as string) ?? d.lineage.obligation?.title ?? tr('Not available')}</p>
          <div className="mt-1 text-xs text-muted">
            {rd(d.provenance.extractedObligation.method)} · {tr('Confidence {n}', { n: d.provenance.extractedObligation.confidence ?? '—' })} · {rd(d.provenance.extractedObligation.reviewStatus)}
          </div>
        </div>
        <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3">
          <div className="text-2xs font-semibold text-brand-700">{tr('Derived requirement — system, not the drafter')}</div>
          <p className="mt-1 text-[12.5px] text-ink-2">{d.requirement.statement}</p>
          <div className="mt-1 text-xs text-muted">
            {rd(d.provenance.derivedRequirement.method)} · {tr('Confidence {n}', { n: d.provenance.derivedRequirement.confidence ?? '—' })} · {rd(d.provenance.derivedRequirement.reviewStatus)}
          </div>
        </div>
        {d.provenance.aiInterpretation === null && (
          <p className="text-xs text-muted">{tr('No AI interpretation exists for this requirement. Nothing on this page was written by a model.')}</p>
        )}
        {(d.criteria?.length ?? 0) > 0 && (
          <PanelBlock title={tr('Guidebook assessment criteria ({n})', { n: d.criteria!.length.toLocaleString() })}>
            <p className="mb-2 text-xs text-muted">{tr('NABH scores this element, not each criterion. The criteria are what an assessor checks to decide the score.')}</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {d.criteria!.map((c, i) => (
                <li key={c.id} className="flex items-start gap-2.5 px-3 py-2">
                  <span className="mt-0.5 w-5 shrink-0 text-xs font-semibold tabular-nums text-muted">{i + 1}.</span>
                  <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
                    {c.statement}
                    {c.test_method && <span className="mt-0.5 block text-xs text-muted">{c.test_method}</span>}
                  </span>
                  <CompliancePill status={c.compliance_status} />
                </li>
              ))}
            </ul>
          </PanelBlock>
        )}
        {t && (
          <PanelBlock title={tr('Relationship')} link={{ label: tr('Traceability'), onClick: () => setTab('trace') }}>
            <FlowSteps steps={t.chain.slice(0, 5).map((c) => ({
              icon: STEP_ICON[String(c.step).toUpperCase()] ?? 'CircleDot', label: tr(readable(String(c.step))),
              sub: tr(c.state === 'PRESENT' ? 'present' : 'missing'), tone: c.state === 'PRESENT' ? 'green' as const : 'amber' as const,
            }))} />
          </PanelBlock>
        )}
      </>)}

      {d && tab === 'lineage' && (
        <ol className="space-y-0">
          {([
            ['Landmark', 'bg-brand-50 text-brand-600', tx('Regulation'), d.lineage.regulation.title ?? d.lineage.regulation.id],
            ['BookOpen', 'bg-violet-50 text-violet-600', tx('Chapter'), d.lineage.chapter],
            ['ScrollText', 'bg-teal-50 text-teal-600', tx('Section'), d.lineage.section ? `§${d.lineage.section.section_number} ${d.lineage.section.section_title}` : null],
            ...d.lineage.clauseAncestors.map((a) => ['Hash', 'bg-slate-100 text-slate-600', tx('Parent clause'), a.clause_number] as const),
            ['Hash', 'bg-amber-50 text-amber-600', tx('Clause'), d.lineage.clause ? `${d.lineage.clause.clause_number}${d.lineage.clause.clause_path ? ` (${d.lineage.clause.clause_path})` : ''}` : null],
            ['ClipboardList', 'bg-pink-50 text-pink-600', tx('Obligation'), d.lineage.obligation ? (d.lineage.obligation.title ?? d.lineage.obligation.id) : null],
          ] as const).filter(([, , , v]) => v).map(([icon, cls, label, v], i, all) => (
            <li key={`${label}-${i}`} className="relative flex gap-3 pb-4">
              {i < all.length - 1 && <span className="absolute left-[17px] top-9 h-[calc(100%-36px)] w-px bg-line" aria-hidden="true" />}
              <Tile icon={icon} cls={cls} />
              <div className="min-w-0 pt-0.5">
                <div className="text-xs text-muted">{tr(label)}</div>
                <div className="text-[13px] font-medium text-ink">{v}</div>
              </div>
            </li>
          ))}
          {d.lineage.regulation.documentUrl && (
            <li><a className="text-xs font-medium text-brand-600 hover:underline" href={d.lineage.regulation.documentUrl} target="_blank" rel="noreferrer">{tr('Open the official PDF')} →</a></li>
          )}
        </ol>
      )}

      {tab === 'trace' && (<>
        {trace.isLoading && <Skeleton rows={4} />}
        {t && (<>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">{tr('Chain')}</span>
            <Pill tone={t.chainComplete ? 'green' : 'amber'}>{tr(t.chainComplete ? 'Complete' : 'Incomplete')}</Pill>
          </div>
          <ChainStrip chain={t.chain} />
          {t.controls.length > 0 && (
            <PanelBlock title={tr('Controls')}>
              <div className="space-y-2">
                {t.controls.map((c) => (
                  <div key={String(c.mapping_id)} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <b>{c.control_name ?? c.control_id}</b>
                      <StatePill v={c.review_status} />
                      <span className="text-xs text-muted">{c.mapping_method ?? c.mapped_by} {c.derived_from ? `· ${tr('derived from {source}', { source: String(c.derived_from) })}` : ''}</span>
                    </div>
                    {c.rationale && <p className="mt-1 text-[12px] text-muted">{c.rationale}</p>}
                    <div className="mt-2 space-y-1">
                      {c.evidence.length === 0 && <p className="text-xs text-warning-700">{tr('No evidence proves this control operates.')}</p>}
                      {c.evidence.map((e) => (
                        <div key={e.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                          <Paperclip className="h-3.5 w-3.5 text-teal-600" /><span>{e.name}</span>
                          <StatePill v={e.evidenceState} />
                          <span className="text-muted">
                            {e.owner_id ? tr('Owner {name}', { name: String(e.owner_id) }) : tr('No owner')} · {e.valid_until ? tr('valid to {date}', { date: String(e.valid_until) }) : tr('no validity period')} · {tr(e.content_hash ? 'hashed' : 'no hash')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </PanelBlock>
          )}
          {t.assessments.length > 0 && (
            <div className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <b>{tr('Assessment')}</b><StatePill v={t.assessments[0].result} />
                <span className="text-xs text-muted">{t.assessments[0].method} · {t.assessments[0].review_status}</span>
              </div>
              <p className="mt-1 text-[12px] text-muted">{t.assessments[0].rationale}</p>
            </div>
          )}
          <p className="text-xs text-muted">{t.note}</p>
        </>)}
      </>)}
    </SidePanel>
  );
}
