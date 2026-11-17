/**
 * Requirements for this company — the company side of the boundary.
 *
 * THE SEAM IS THE POINT
 * ---------------------
 * /regulation/:id shows what the regulator wrote. This page shows what each of
 * those duties means for this company: whether it reaches us, which control is
 * proposed for it, whether evidence exists, and the compliance status the chain
 * derives. The two are different API calls and different tables, and this
 * screen never blends them into one sentence.
 *
 * WHY EVERY STATUS CARRIES ITS REASON
 * -----------------------------------
 * A screen that printed NOT_ASSESSED thousands of times without saying why
 * would be indistinguishable from a broken one. The reason names the first
 * missing link — "No approved control is mapped" — so the reader can see what
 * would move it.
 *
 * The status chart counts only the instances whose status has been CHECKED
 * (documented, partial, non-compliant, evidence missing). The whole library is
 * mostly "Not assessed", and percentages over it would all read 0%.
 *
 * The risk and regulation charts come from a DIFFERENT source — the gap
 * assessment against the hospital's own documents (/api/cascade) — and say so
 * in their captions. They show priority only, never a second status split.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, Search } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { can, useMe } from '@/services/authApi';
import { toneFor } from '@/config/tones';
import { api } from '@/services/http';
import { Callout, EmptyState, Field, Skeleton } from '@/components/ui/primitives';
import '@/components/ui/premium.css';
import { FlowSteps } from '@/components/ui/charts';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Icon } from '@/config/icons';
import { cn, critClass, readable, toneClass } from '@/utils/ui';
import {
  ActiveFilter, PanelBlock, StatusChip, PanelHeader, PanelTabs, RowCheck, SidePanel, StatusPill, TableFooter,
} from './ui';
import { DRAWER, downloadCsv, fmtDate, riskPhrase, statusWord } from './uiKit';
import { tx, useDateLocale, useT } from '@/i18n';

interface Summary { byCompliance: Record<string, number>; findings: number; note?: string | null }
interface Row {
  cri_id: string; requirement_id: string; regulation_id: string; regulation_title: string;
  regulator_short: string; statement: string; source_clause: string | null;
  frequency: string | null; deadline: string | null; responsible_role: string | null;
  applicability: string | null; applicability_confidence: string | null;
  missing_facts: string | null; effective_from: string | null;
  compliance_status: string; compliance_reason: string | null;
  control_links: number; controls_approved: number; control_names: string | null;
  evidence_links: number; tests: number; open_findings: number;
  /** worst open finding on this requirement */
  risk: string | null; gap: string | null;
}
interface Detail {
  found: boolean;
  checks?: unknown;
  scopes?: { scope_type: string; scope_label: string; applicability_status: string | null; reason: string | null }[];
  controls?: { id: string; name: string; review_status: string | null; rationale: string | null; derived_from: string | null }[];
  tests?: { id: string; result: string | null; performed_by: string | null; performed_at: string | null }[];
  findings?: { id: string; severity: string | null; title: string | null; status: string | null }[];
}
/** /api/cascade/regulations — the document gap assessment, per regulation. */
interface CascadeReg {
  id: string; title: string; short_title?: string | null; regulator?: string | null;
  applicable: number; met: number; partial: number; gap: number; not_covered: number;
  critical: number; high: number; medium?: number; low?: number;
}

const APP_TONE: Record<string, string> = {
  APPLICABLE: 'bg-success-50 text-success-600', CONDITIONAL: 'bg-warning-50 text-warning-600',
  NOT_APPLICABLE: 'bg-slate-100 text-slate-500', REVIEW_REQUIRED: 'bg-brand-50 text-brand-600',
};
const COMP_ORDER = ['COMPLIANT', 'PARTIALLY_COMPLIANT', 'NON_COMPLIANT', 'EVIDENCE_MISSING', 'NOT_TESTED', 'NOT_ASSESSED', 'REVIEW_REQUIRED', 'NOT_APPLICABLE'];
/** English (also a FlowSteps sub, which translates it); translate it where it is drawn */
const appWord = (v?: string | null) => (v ?? 'UNASSESSED').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase());
/** a gap callout's title per risk band, as one phrase */
const RISK_GAP: Record<string, string> = {
  Critical: tx('Critical-risk gap'), High: tx('High-risk gap'), Medium: tx('Medium-risk gap'), Low: tx('Low-risk gap'),
};

/**
 * The gap line arrives as "[Critical risk · Owner missing] No approved control…".
 * The risk already has its own badge, so the bracket is unwrapped and the
 * repeated risk words dropped.
 */
function cleanGap(gap: string, risk: string | null): string {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/s.exec(gap);
  if (!m) return gap;
  const parts = m[1].split('·').map((p) => p.trim()).filter(Boolean)
    .filter((p) => !(risk && new RegExp(`^${risk}\\s+risk$`, 'i').test(p)));
  const rest = m[2].trim();
  return [parts.join(' · '), rest].filter(Boolean).join(' — ');
}
function parseList(v: string | null | undefined): string[] {
  if (!v || v === '[]') return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export function CompliancePage() {
  const t = useT();
  // exporting, and the row picking that only serves it, is for those who may approve
  const { data: me } = useMe();
  const canExport = can(me, 'approve');
  const [sp, setSp] = useSearchParams();
  const applicability = sp.get('applicability') ?? 'reach';
  const compliance = sp.get('compliance') ?? '';
  const regulation = sp.get('regulation') ?? '';
  const q = sp.get('q') ?? '';
  const page = Number(sp.get('page') ?? 1);
  const size = Number(sp.get('size') ?? 25);
  const [draft, setDraft] = useState(q);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, Row>>(new Map());

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    // applicability "" means All and must stay in the URL: a missing key reads as "reach"
    if (v || k === 'applicability') n.set(k, v); else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n);
  };

  const { data: s } = useQuery<Summary>({
    queryKey: ['compliance-summary'], queryFn: () => api('/api/compliance/summary'), staleTime: 60_000,
  });
  const cascade = useQuery<{ items: CascadeReg[]; note?: string }>({
    queryKey: ['cascade', 'list'], queryFn: () => api('/api/cascade/regulations'), staleTime: 300_000,
  });
  const qs = new URLSearchParams({ applicability, page: String(page), size: String(size) });
  if (compliance) qs.set('compliance', compliance);
  if (regulation) qs.set('regulation_id', regulation);
  if (q) qs.set('q', q);
  const { data, isLoading, error } = useQuery<{ total: number; items: Row[] }>({
    queryKey: ['compliance-requirements', qs.toString()],
    queryFn: () => api(`/api/compliance/requirements?${qs}`), staleTime: 60_000,
  });
  const total = data?.total ?? 0;
  const rows = data?.items ?? [];

  const regTitle = regulation
    ? cascade.data?.items.find((i) => i.id === regulation)?.short_title
      ?? cascade.data?.items.find((i) => i.id === regulation)?.title
      ?? rows[0]?.regulation_title ?? regulation
    : '';

  const allOnPage = rows.length > 0 && rows.every((r) => picked.has(r.cri_id));
  const someOnPage = rows.some((r) => picked.has(r.cri_id));
  const togglePage = (v: boolean) => setPicked((m) => { const n = new Map(m); rows.forEach((r) => (v ? n.set(r.cri_id, r) : n.delete(r.cri_id))); return n; });
  const toggle = (r: Row, v: boolean) => setPicked((m) => { const n = new Map(m); if (v) n.set(r.cri_id, r); else n.delete(r.cri_id); return n; });
  const exportRows = (list: Row[]) => downloadCsv(
    `requirements-${new Date().toISOString().slice(0, 10)}.csv`,
    ['cri_id', 'regulator', 'regulation', 'clause', 'requirement', 'applies', 'control_links', 'controls_approved', 'evidence', 'tests', 'risk', 'compliance_status', 'reason'],
    list.map((r) => [r.cri_id, r.regulator_short, r.regulation_title, r.source_clause, r.statement, r.applicability, r.control_links,
      r.controls_approved, r.evidence_links, r.tests, r.risk, r.compliance_status, r.compliance_reason]),
  );
  const openRow = rows.find((r) => r.cri_id === open) ?? (open ? picked.get(open) : undefined);

  return (
    <>
      <Topbar title="Requirements" subtitle="What each regulatory duty means for this company"
              icon="ClipboardCheck" tone={toneFor('reg-regulations')} hideSearch
              actions={canExport && rows.length > 0 && (
                <button type="button" className="btn btn-outline" onClick={() => exportRows(rows)} title={t('Export the rows on this page')}>
                  <Download className="h-4 w-4" /> {t('Export page')}
                </button>
              )} />
      <div className="space-y-4 p-4 sm:p-6">

        <div>
          <div className="card min-w-0 overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
              <form className="relative w-full min-w-[220px] max-w-md flex-1" onSubmit={(e) => { e.preventDefault(); set('q', draft.trim()); }}>
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input className="input w-full pl-9" placeholder={t('Search the requirement text… (Enter)')} aria-label={t('Search the requirement text')}
                       value={draft} onChange={(e) => setDraft(e.target.value)} />
              </form>
              <SegmentedControl
                ariaLabel="Applicability"
                className="ml-auto"
                value={applicability}
                onChange={(v) => set('applicability', v)}
                options={[{ key: 'reach', label: 'Reaches us' }, { key: 'REVIEW_REQUIRED', label: 'Needs review' },
                          { key: 'NOT_APPLICABLE', label: 'Not applicable' }, { key: '', label: 'All' }]}
              />
            </div>
            {s && (
              <div className="pm-stagger flex flex-wrap gap-2 border-b border-line px-4 py-2.5" role="group" aria-label={t('Filter by status')}>
                <StatusChip label={t('All')} on={!compliance} onClick={() => set('compliance', '')} />
                {COMP_ORDER.filter((k) => (s.byCompliance[k] ?? 0) > 0).map((k) => (
                  <StatusChip key={k} label={t(statusWord(k))} n={s.byCompliance[k]} dot={STATUS_DOT[k] ?? '#94a3b8'}
                              on={compliance === k} onClick={() => set('compliance', compliance === k ? '' : k)} />
                ))}
              </div>
            )}
            {(regulation || q || ['APPLICABLE', 'CONDITIONAL'].includes(applicability)) && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                {regulation && <ActiveFilter label="Regulation" value={regTitle} onClear={() => set('regulation', '')} />}
                {q && <ActiveFilter label="Text" value={`“${q}”`} onClear={() => { setDraft(''); set('q', ''); }} />}
                {['APPLICABLE', 'CONDITIONAL'].includes(applicability) && <ActiveFilter label="Applies" value={t(appWord(applicability))} onClear={() => set('applicability', 'reach')} />}
              </div>
            )}
            {canExport && picked.size > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-b border-brand-100 bg-brand-50/60 px-4 py-2 text-[13px]">
                <span><b className="text-ink">{picked.size.toLocaleString()}</b> {t('selected')}</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => exportRows([...picked.values()])}>
                  <Download className="h-3.5 w-3.5" /> {t('Export selected')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Map())}>{t('Clear selection')}</button>
              </div>
            )}

            {isLoading && <Skeleton rows={8} />}
            {error && <div className="py-12 text-center text-[13px] text-critical-600">{String((error as Error).message)}</div>}
            {data && rows.length === 0 && (
              <EmptyState icon="ClipboardCheck" title="No requirement instance matches" hint="Change the applicability, status or search above." />
            )}

            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead>
                    <tr className="whitespace-nowrap border-b border-line bg-slate-50/70 text-left text-xs font-medium text-muted">
                      {canExport && <th className="w-10 py-2.5 pl-4 pr-1"><RowCheck checked={allOnPage} indeterminate={!allOnPage && someOnPage} onChange={togglePage} label={t('Select all requirements on this page')} /></th>}
                      <th className={cn('py-2.5 pr-3', canExport ? 'pl-2' : 'pl-4')}>{t('Requirement')}</th>
                      <th className="px-3 py-2.5">{t('Risk')}</th>
                      <th className="px-3 py-2.5">{t('Status')}</th>
                      <th className="w-8 px-2 py-2.5"><span className="sr-only">{t('Open')}</span></th>
                    </tr>
                  </thead>
                  <tbody key={qs.toString()} className="pm-stagger">
                    {rows.map((r) => (
                        <tr key={r.cri_id} onClick={() => setOpen(r.cri_id)} tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(r.cri_id); } }}
                            className={cn('group cursor-pointer border-b border-line last:border-0 transition-colors hover:bg-brand-50/40 focus-visible:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                              open === r.cri_id && 'bg-brand-50/70', picked.has(r.cri_id) && open !== r.cri_id && 'bg-brand-50/30')}>
                          {canExport && <td className="py-3 pl-4 pr-1 align-top" style={edge(r)}><RowCheck checked={picked.has(r.cri_id)} onChange={(v) => toggle(r, v)} label={t('Select requirement {ref}', { ref: r.source_clause ?? r.cri_id })} /></td>}
                          <td className={cn('max-w-[720px] py-3 pr-3', canExport ? 'pl-2' : 'pl-4')} style={canExport ? undefined : edge(r)}>
                            <p className="line-clamp-2 leading-snug text-ink">{r.statement}</p>
                            <p className="mt-1 truncate text-[11.5px] text-muted" title={r.regulation_title}>
                              {r.regulator_short && <span className="font-semibold text-brand-600">{r.regulator_short} · </span>}
                              {r.regulation_title}{r.source_clause ? ` · §${r.source_clause}` : ''}
                            </p>
                          </td>
                          <td className="px-3 py-3">{r.risk ? <span className={cn('pill', critClass(r.risk))}>{t(readable(r.risk))}</span> : <span className="text-muted-2">—</span>}</td>
                          <td className="px-3 py-3"><StatusPill value={r.compliance_status} title={r.compliance_reason ?? undefined} /></td>
                          <td className="px-2 py-3 text-muted">
                            <ChevronRight className="h-4 w-4 opacity-60 transition group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden="true" />
                          </td>
                        </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data && total > 0 && (
              <TableFooter page={page} total={total} size={size} noun="requirement instances"
                           onPage={(p) => set('page', String(p))}
                           onSize={(n) => { const x = new URLSearchParams(sp); x.set('size', String(n)); x.delete('page'); setSp(x); }} />
            )}
          </div>

          {open && openRow && <RequirementPanel key={open} row={openRow} onClose={() => setOpen(null)} />}
        </div>
      </div>
    </>
  );
}

const STATUS_DOT: Record<string, string> = {
  COMPLIANT: '#16a34a', PARTIALLY_COMPLIANT: '#f59e0b', NON_COMPLIANT: '#dc2626', EVIDENCE_MISSING: '#f97316',
};
/** a row's status as a thin coloured edge on its first cell (a table row cannot carry a ::before) */
const edge = (r: { compliance_status: string }) => {
  const c = STATUS_DOT[r.compliance_status];
  return c ? { boxShadow: `inset 3px 0 0 ${c}` } : undefined;
};

/* ---------------------------------------------------------------- detail panel */

type PTab = 'details' | 'controls' | 'findings' | 'scopes';
type Check = { name?: string; result?: string; [k: string]: unknown };
function parseChecks(v: unknown): Check[] {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? (a as Check[]) : [];
  } catch { return []; }
}
const resultTone = (r?: string) => {
  const v = (r ?? '').toUpperCase();
  if (/^(MATCH|PASS|YES|TRUE|MET|OK)$/.test(v)) return 'green' as const;
  if (/(NO_MATCH|MISMATCH|FAIL|^NO$|FALSE)/.test(v)) return 'red' as const;
  if (/(UNKNOWN|MISSING|PARTIAL)/.test(v)) return 'amber' as const;
  return 'gray' as const;
};
const SEV_TONE: Record<string, 'red' | 'orange' | 'amber' | 'gray'> = { CRITICAL: 'red', HIGH: 'orange', MEDIUM: 'amber', LOW: 'gray' };

function RequirementPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const navigate = useNavigate();
  // `t` is each test in the Tests block below, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const [tab, setTab] = useState<PTab>('details');
  const { data: d, isLoading, error } = useQuery<Detail>({
    queryKey: ['compliance-requirement', row.cri_id],
    queryFn: () => api(`/api/compliance/requirements/${encodeURIComponent(row.cri_id)}`),
  });
  const checks = parseChecks(d?.checks);
  const missing = parseList(row.missing_facts);
  const controls = d?.controls ?? [];
  const findings = d?.findings ?? [];
  const scopes = d?.scopes ?? [];
  const tests = d?.tests ?? [];
  const status = row.compliance_status;

  return (
    <SidePanel onClose={onClose} labelledBy="req-panel-title">
      <PanelHeader
        id="req-panel-title"
        eyebrow={<><span className="font-semibold text-brand-600">{row.regulator_short}</span> · §{row.source_clause ?? '—'}</>}
        title={row.regulation_title}
        badges={(
          <>
            <StatusPill value={status} size="sm" />
            <span className={cn('pill px-2 py-0.5 text-[11px]', APP_TONE[row.applicability ?? ''] ?? 'bg-slate-100 text-slate-500')}>{tr(appWord(row.applicability))}</span>
            {row.risk && <span className={cn('pill px-2 py-0.5 text-[11px]', critClass(row.risk))}>{riskPhrase(tr, row.risk)}</span>}
          </>
        )}
        onClose={onClose}
      />
      <PanelTabs<PTab>
        value={tab} onChange={setTab}
        tabs={[
          { key: 'details', label: 'Details' },
          { key: 'controls', label: 'Controls', count: d ? controls.length : row.control_links },
          { key: 'findings', label: 'Findings', count: d ? findings.length : row.open_findings },
          { key: 'scopes', label: 'Scopes', count: d ? scopes.length : undefined },
        ]}
      />
      <div className={DRAWER.body}>
        {tab === 'details' && (
          <>
            {row.gap ? (
              <Callout tone="red" title={row.risk ? (RISK_GAP[readable(row.risk)] ? tr(RISK_GAP[readable(row.risk)]) : `${readable(row.risk)}-risk gap`) : tr('Gap')}>{cleanGap(row.gap, row.risk)}</Callout>
            ) : status === 'COMPLIANT' ? (
              <Callout tone="green" title="Documented">{row.compliance_reason ?? tr('Our documents cover this duty.')}</Callout>
            ) : row.compliance_reason ? (
              <Callout tone="blue" title={tr('Why it reads {status}', { status: tr(statusWord(status)).toLowerCase() })}>{row.compliance_reason}</Callout>
            ) : null}

            <div className="rounded-[18px] bg-black/[0.03] p-4 leading-relaxed text-ink">
              <div className="sec-eyebrow mb-1">{tr('Requirement')}</div>
              {row.statement}
            </div>

            <div>
              <div className="sec-eyebrow mb-3">{tr('The chain')}</div>
              <FlowSteps steps={[
                { icon: 'ClipboardList', label: 'Requirement', sub: `§${row.source_clause ?? '—'}`, tone: 'blue' },
                { icon: 'BadgeCheck', label: 'Applies', sub: appWord(row.applicability),
                  tone: row.applicability === 'APPLICABLE' ? 'green' : row.applicability === 'CONDITIONAL' ? 'amber' : 'gray' },
                { icon: 'ShieldCheck', label: row.control_links === 1 ? tr('1 control') : tr('{n} controls', { n: row.control_links.toLocaleString() }), sub: tr('{n} approved', { n: row.controls_approved.toLocaleString() }),
                  tone: row.controls_approved ? 'green' : row.control_links ? 'amber' : 'gray', onClick: () => setTab('controls') },
                { icon: 'Paperclip', label: tr('Evidence {n}', { n: row.evidence_links.toLocaleString() }), sub: row.tests === 1 ? tr('1 test') : tr('{n} tests', { n: row.tests.toLocaleString() }), tone: row.evidence_links ? 'teal' : 'gray' },
                { icon: 'CircleCheck', label: 'Status', sub: statusWord(status),
                  tone: status === 'COMPLIANT' ? 'green' : status === 'NON_COMPLIANT' ? 'red' : status === 'PARTIALLY_COMPLIANT' ? 'amber' : status === 'EVIDENCE_MISSING' ? 'orange' : 'gray' },
              ]} />
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-[18px] bg-black/[0.03] p-4">
              <Field label="Frequency">{row.frequency ? tr(readable(row.frequency)) : '—'}</Field>
              <Field label="Deadline">{row.deadline ?? '—'}</Field>
              <Field label="Responsible role">{row.responsible_role ?? '—'}</Field>
              <Field label="Effective from">{fmtDate(row.effective_from, locale)}</Field>
              <Field label="Applicability confidence">{row.applicability_confidence ? tr(readable(row.applicability_confidence)) : '—'}</Field>
              <Field label="Open findings">{row.open_findings.toLocaleString()}</Field>
            </div>

            {missing.length > 0 && (
              <Callout tone="amber" title="Facts the engine is missing">{missing.join(', ')}</Callout>
            )}

            <PanelBlock title="Why it applies" icon="ListChecks">
              {isLoading ? <Skeleton rows={2} /> : checks.length === 0 ? (
                <p className="text-muted">{tr('No applicability checks were recorded for this instance.')}</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-[16px] border border-black/[0.06] bg-white">
                  {checks.map((c, i) => {
                    const detail = ['reason', 'detail', 'origin', 'note', 'value'].map((k) => c[k]).find((v) => typeof v === 'string' && v) as string | undefined;
                    return (
                      <li key={i} className="flex items-start gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-ink">{c.name ?? tr('Check {n}', { n: i + 1 })}</div>
                          {detail && <div className="line-clamp-2 text-[12px] text-muted">{detail}</div>}
                        </div>
                        {c.result && <span className={cn('pill px-2 py-0.5 text-[11px]', toneClass(resultTone(c.result)))}>{tr(readable(String(c.result)))}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </PanelBlock>

            {tests.length > 0 && (
              <PanelBlock title={tr('Tests ({n})', { n: tests.length.toLocaleString() })} icon="ClipboardCheck">
                <ul className="space-y-1.5">
                  {tests.map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      {t.result ? <span className={cn('pill px-2 py-0.5 text-[11px]', toneClass(resultTone(t.result)))}>{tr(readable(t.result))}</span> : <span className="text-muted-2">—</span>}
                      <span className="text-ink-2">{t.performed_by ?? '—'}</span>
                      <span className="ml-auto text-[12px] text-muted">{fmtDate(t.performed_at, locale)}</span>
                    </li>
                  ))}
                </ul>
              </PanelBlock>
            )}
          </>
        )}

        {tab === 'controls' && (
          isLoading ? <Skeleton rows={3} /> : controls.length === 0 ? (
            <EmptyState icon="ShieldCheck" title="No control mapped" hint="No control has been proposed for this requirement yet." />
          ) : (
            <ul className="space-y-2">
              {controls.map((c) => (
                <li key={c.id} className="rounded-[16px] border border-black/[0.06] bg-white p-3.5 transition-shadow hover:shadow-sm">
                  <div className="flex items-start gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon name="ShieldCheck" className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1 font-medium text-ink first-letter:uppercase">{c.name}</div>
                    {c.review_status && <span className={cn('pill px-2 py-0.5 text-[11px]', toneClass(/^(ACCEPTED|APPROVED)$/.test(c.review_status) ? 'green' : c.review_status === 'REJECTED' ? 'red' : 'gray'))}>{tr(readable(c.review_status))}</span>}
                  </div>
                  {c.rationale && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{c.rationale}</p>}
                  {c.derived_from && <p className="mt-1 text-[11.5px] text-muted">{tr('Derived from {source}', { source: c.derived_from })}</p>}
                </li>
              ))}
            </ul>
          )
        )}

        {tab === 'findings' && (
          isLoading ? <Skeleton rows={3} /> : findings.length === 0 ? (
            <EmptyState icon="CircleCheck" title="No findings" hint="No finding has been raised on this requirement." />
          ) : (
            <ul className="space-y-2">
              {findings.map((f) => (
                <li key={f.id} className="flex items-start gap-2.5 rounded-[16px] border border-black/[0.06] bg-white p-3.5 transition-shadow hover:shadow-sm">
                  <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', toneClass(SEV_TONE[(f.severity ?? '').toUpperCase()] ?? 'gray'))}>
                    <Icon name="AlertTriangle" className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="leading-snug text-ink">{f.title ? cleanGap(f.title, f.severity) : f.id}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {f.severity && <span className={cn('pill px-2 py-0.5 text-[11px]', critClass(f.severity))}>{tr(readable(f.severity))}</span>}
                      {f.status && <span className="pill bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{tr(readable(f.status))}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}

        {tab === 'scopes' && (
          isLoading ? <Skeleton rows={3} /> : scopes.length === 0 ? (
            <EmptyState icon="Layers" title="No scopes recorded" hint="This instance has not been asked about a site, department or service line." />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-[16px] border border-black/[0.06] bg-white">
              {scopes.map((sc, i) => (
                <li key={i} className="flex items-start gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink">{sc.scope_label}</div>
                    <div className="text-[11.5px] text-muted">{tr(readable(sc.scope_type))}{sc.reason ? ` · ${sc.reason}` : ''}</div>
                  </div>
                  {sc.applicability_status && <span className={cn('pill px-2 py-0.5 text-[11px]', APP_TONE[sc.applicability_status] ?? 'bg-slate-100 text-slate-500')}>{tr(appWord(sc.applicability_status))}</span>}
                </li>
              ))}
            </ul>
          )
        )}
        {error != null && <p className="text-critical-600">{(error as Error).message}</p>}
      </div>

      <div className={DRAWER.footer}>
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/regulation/${row.regulation_id}`)}>
          <Icon name="Scale" className="h-4 w-4" /> {tr('Regulation')}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(row.regulation_id)}`)}>
          <Icon name="GitBranch" className="h-4 w-4" /> {tr('Impact cascade')}
        </button>
        <button type="button" className="btn ml-auto" onClick={onClose}>{tr('Close')}</button>
      </div>
    </SidePanel>
  );
}

export default CompliancePage;
