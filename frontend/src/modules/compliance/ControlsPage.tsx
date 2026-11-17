/**
 * Controls — the measures this company runs, and what backs each one.
 *
 * WHAT EACH COLUMN IS, AND IS NOT
 * -------------------------------
 * "Linked requirements" is how many requirements this control claims to
 * satisfy, and "approved" how many of those links a human accepted — they are
 * different numbers on purpose, because a bulk acceptance is not thousands of
 * judgements. The status pill is derived from exactly those two numbers:
 *   Approved        every link accepted by a person
 *   Partly approved some links accepted
 *   Not reviewed    links proposed, none accepted yet
 *   No requirements nothing is linked
 * "Document" is whether any evidence is attached, NOT whether the procedure is
 * followed: many attached documents are DRAFT SOPs generated from the mapped
 * duties, a statement of what the procedure must cover, never a record that
 * anyone follows it. "Tested" is only populated where holding a certificate is
 * itself the compliance; elsewhere it shows "—" rather than a reassuring zero.
 *
 * Clicking a control opens what it covers (GET /api/controls/:id): the
 * regulations its duties come from and the linked requirements, unmet and most
 * severe first, with the gap the assessment recorded.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, Download, Filter, Link2, Paperclip, Search } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { can, useMe } from '@/services/authApi';
import { Avatar, Callout, EmptyState, Field, Skeleton, Tag } from '@/components/ui/primitives';
import { FlowSteps } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { api } from '@/services/http';
import { cn, critClass, readable, toneClass, type Tone } from '@/utils/ui';
import {
  StatusChip, ActiveFilter, FilterSelect, HueTile, PanelBlock, PanelHeader, PanelTabs, RowCheck, SidePanel, StatusPill, TableFooter,
} from './ui';
import { DRAWER, downloadCsv, fmtDate, riskPhrase } from './uiKit';
import { tx, useDateLocale, useT, type TFunction } from '@/i18n';

interface Control {
  id: string; name: string; description?: string | null;
  owner_id?: string | null; owner_name?: string | null;
  entity_name?: string | null; entity_id?: string | null; department_id?: string | null;
  control_type?: string | null; frequency?: string | null; automated?: string | null;
  effectiveness?: string | null; last_tested?: string | null; next_test_due?: string | null;
  created_at?: string | null; updated_at?: string | null;
  duties?: number; duties_approved?: number; regulations?: number;
  evidence?: number; tests_passed?: number; tests_run?: number;
}
interface Payload { items: Control[] }
interface ControlDetail extends Control {
  regulations_list: { id: string; title: string; duties: number; unmet: number }[];
  requirements: {
    id: string; regulation_id: string; source_clause: string | null; statement: string;
    compliance_status: string | null; risk: string | null; gap: string | null;
    relationship_type?: string | null; review_status?: string | null;
  }[];
  evidence_list: { evidence_id: string; name: string | null; type: string | null }[];
}

const pretty = (s?: string | null) =>
  !s ? '—' : s.replace(/^(peo-role-|peo-|role-|dept-)/, '').replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());
const num = (n?: number) => (n ?? 0).toLocaleString();

/* ---------------------------------------------------------------- status */

type Cov = 'approved' | 'partial' | 'unreviewed' | 'unlinked';
const COV: Record<Cov, { label: string; tone: Tone; hint: string }> = {
  approved: { label: 'Approved', tone: 'green', hint: 'every requirement link accepted by a person' },
  partial: { label: 'Partly approved', tone: 'amber', hint: 'some requirement links accepted' },
  unreviewed: { label: 'Not reviewed', tone: 'orange', hint: 'links proposed, none accepted yet' },
  unlinked: { label: 'No requirements', tone: 'gray', hint: 'no requirement is linked to it' },
};
const COV_ORDER: Cov[] = ['approved', 'partial', 'unreviewed', 'unlinked'];
const COV_DOT: Record<Cov, string> = { approved: '#16a34a', partial: '#f59e0b', unreviewed: '#f97316', unlinked: '#94a3b8' };
function covOf(c: Control): Cov {
  const d = c.duties ?? 0, a = c.duties_approved ?? 0;
  return d === 0 ? 'unlinked' : a >= d ? 'approved' : a > 0 ? 'partial' : 'unreviewed';
}
function CovPill({ c }: { c: Control }) {
  const t = useT();
  const k = covOf(c);
  return <span className={cn('pill', toneClass(COV[k].tone))} title={t(COV[k].hint)}>{t(COV[k].label)}</span>;
}

const TYPE_TONE: Record<string, Tone> = { preventive: 'blue', detective: 'purple', corrective: 'teal', directive: 'amber' };
function TypeChip({ type }: { type?: string | null }) {
  // `t` is the tone below, so the translate function is `tr` here
  const tr = useT();
  if (!type) return <span className="text-muted-2">—</span>;
  const t = TYPE_TONE[type.toLowerCase()];
  // an unknown type keeps its English text: the 'auto' tone is picked from the text, so its colour stays the same in every language
  return <Tag tone={t ?? 'auto'}>{t ? tr(readable(type)) : readable(type)}</Tag>;
}

/** English 'Unassigned' doubles as a filter value; ownerLabel is how it is shown. */
const ownerName = (c: Control) => (c.owner_id || c.owner_name ? c.owner_name ?? pretty(c.owner_id) : tx('Unassigned'));
const ownerLabel = (t: TFunction, c: Control) => (c.owner_id || c.owner_name ? ownerName(c) : t(ownerName(c)));
/** What kind of record the owner is, read from its id's namespace (English; translate where drawn). */
const ownerRole = (id?: string | null) =>
  !id ? tx('no owner yet') : /^(peo-role-|role-)/.test(id) ? tx('Designation') : /^peo-/.test(id) ? tx('Person') : /^dept-/.test(id) ? tx('Department') : tx('Owner');
const NO_DEPT = '__none';
const deptOf = (c: Control) => c.entity_name ?? (c.entity_id ? pretty(c.entity_id) : '');
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));

export function ControlsPage() {
  // `t` is a control type in several callbacks below, so the translate function is `tr` here
  const tr = useT();
  // exporting, and the row picking that only serves it, is for those who may approve
  const { data: me } = useMe();
  const canExport = can(me, 'approve');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [owner, setOwner] = useState('');
  const [dept, setDept] = useState('');
  const [type, setType] = useState('');
  const [more, setMore] = useState(false);
  const [freq, setFreq] = useState('');
  const [doc, setDoc] = useState('');
  const [tested, setTested] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<Payload>({
    queryKey: ['controls'], queryFn: () => api('/api/controls'), staleTime: 60_000,
  });
  const items = useMemo(() => data?.items ?? [], [data]);

  const opts = useMemo(() => ({
    owners: uniq(items.map(ownerName)),
    depts: uniq(items.map(deptOf)),
    types: uniq(items.map((c) => c.control_type ?? '')),
    freqs: uniq(items.map((c) => c.frequency ?? '')),
  }), [items]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((c) => {
      if (needle && !(c.name?.toLowerCase().includes(needle) || ownerName(c).toLowerCase().includes(needle)
        || c.id.toLowerCase().includes(needle) || (c.description ?? '').toLowerCase().includes(needle))) return false;
      if (status === 'uncovered' ? !['unreviewed', 'unlinked'].includes(covOf(c)) : status && covOf(c) !== status) return false;
      if (owner && ownerName(c) !== owner) return false;
      if (dept && (dept === NO_DEPT ? deptOf(c) !== '' : deptOf(c) !== dept)) return false;
      if (type && c.control_type !== type) return false;
      if (freq && c.frequency !== freq) return false;
      if (doc === 'with' && !(c.evidence ?? 0)) return false;
      if (doc === 'without' && (c.evidence ?? 0) > 0) return false;
      if (tested === 'yes' && !(c.tests_run ?? 0)) return false;
      if (tested === 'no' && (c.tests_run ?? 0) > 0) return false;
      return true;
    });
  }, [items, q, status, owner, dept, type, freq, doc, tested]);

  useEffect(() => { setPage(1); }, [q, status, owner, dept, type, freq, doc, tested, size]);

  const covCount = useMemo(() => {
    const m: Record<Cov, number> = { approved: 0, partial: 0, unreviewed: 0, unlinked: 0 };
    items.forEach((c) => { m[covOf(c)] += 1; });
    return m;
  }, [items]);

  const byDept = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((c) => { const d = deptOf(c) || NO_DEPT; m.set(d, (m.get(d) ?? 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const pageRows = rows.slice((page - 1) * size, page * size);
  const openRow = items.find((c) => c.id === open);
  const filtersOn = [status, owner, dept, type, freq, doc, tested].filter(Boolean).length + (q ? 1 : 0);
  const moreOn = [owner, freq, doc, tested].filter(Boolean).length;
  const clearAll = () => { setQ(''); setStatus(''); setOwner(''); setDept(''); setType(''); setFreq(''); setDoc(''); setTested(''); };

  const exportRows = (list: Control[]) => downloadCsv(
    `controls-${new Date().toISOString().slice(0, 10)}.csv`,
    ['id', 'name', 'type', 'department', 'owner', 'linked_requirements', 'approved_links', 'regulations', 'documents', 'tests_run', 'tests_passed', 'status', 'updated_at'],
    list.map((c) => [c.id, c.name, c.control_type, deptOf(c), ownerName(c), c.duties ?? 0, c.duties_approved ?? 0, c.regulations ?? 0,
      c.evidence ?? 0, c.tests_run ?? 0, c.tests_passed ?? 0, COV[covOf(c)].label, c.updated_at]),
  );
  const allOnPage = pageRows.length > 0 && pageRows.every((c) => picked.has(c.id));
  const someOnPage = pageRows.some((c) => picked.has(c.id));
  const togglePage = (v: boolean) => setPicked((s) => {
    const n = new Set(s);
    pageRows.forEach((c) => (v ? n.add(c.id) : n.delete(c.id)));
    return n;
  });
  const toggle = (id: string, v: boolean) => setPicked((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });

  return (
    <>
      <Topbar
        title="Controls"
        subtitle="The measures the hospital runs to meet its duties — owner, requirements covered, documents and tests"
        icon="ShieldCheck"
        actions={canExport && items.length > 0 && (
          <button type="button" className="btn btn-outline" onClick={() => exportRows(rows)}>
            <Download className="h-4 w-4" /> {tr('Export CSV')}
          </button>
        )}
      />
      <div className="space-y-4 p-6">
        <div>
          <div className="card min-w-0 overflow-hidden">
            {/* filter bar */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input className="input w-full pl-9" placeholder={tr('Search controls, codes or owners…')} aria-label={tr('Search controls or owners')}
                       value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <FilterSelect label="Department" value={dept} onChange={setDept}
                            options={[...opts.depts.map((d) => ({ value: d, label: d })), ...(byDept.some(([d]) => d === NO_DEPT) ? [{ value: NO_DEPT, label: 'No department' }] : [])]} />
              <FilterSelect label="Control type" value={type} onChange={setType} options={opts.types.map((t) => ({ value: t, label: readable(t) }))} />
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
                      className={cn('btn', (more || moreOn > 0) && 'border-brand-400 text-brand-700')}>
                <Filter className="h-4 w-4" /> {tr('More Filters')}
                {moreOn > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold text-white">{moreOn}</span>}
              </button>
              {filtersOn > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>{tr('Clear all')}</button>}
              <span className="ml-auto text-xs text-muted">{rows.length === 1 ? tr('1 control') : tr('{n} controls', { n: num(rows.length) })}</span>
            </div>
            {items.length > 0 && (
              <div className="pm-stagger flex flex-wrap gap-2 border-b border-line px-4 py-2.5" role="group" aria-label={tr('Filter by status')}>
                <StatusChip label={tr('All')} n={items.length} on={!status} onClick={() => setStatus('')} />
                {COV_ORDER.filter((k) => covCount[k] > 0).map((k) => (
                  <StatusChip key={k} label={tr(COV[k].label)} n={covCount[k]} dot={COV_DOT[k]}
                              on={status === k} onClick={() => setStatus(status === k ? '' : k)} />
                ))}
              </div>
            )}
            {more && (
              <div className="pm-open flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-slate-50/70 px-4 py-2.5">
                <FilterSelect label="Owner" value={owner} onChange={setOwner} options={opts.owners.map((o) => ({ value: o, label: o }))} />
                <FilterSelect label="Frequency" value={freq} onChange={setFreq} options={opts.freqs.map((f) => ({ value: f, label: readable(f) }))} />
                <FilterSelect label="Document" value={doc} onChange={setDoc} options={[{ value: 'with', label: 'Attached' }, { value: 'without', label: 'None attached' }]} />
                <FilterSelect label="Tested" value={tested} onChange={setTested} options={[{ value: 'yes', label: 'Has a test' }, { value: 'no', label: 'No test on record' }]} />
              </div>
            )}
            {(dept === NO_DEPT || status === 'uncovered') && (
              <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2">
                {status === 'uncovered' && <ActiveFilter label="Status" value={tr('Uncovered — no approved link')} onClear={() => setStatus('')} />}
                {dept === NO_DEPT && <ActiveFilter label="Department" value={tr('No department')} onClear={() => setDept('')} />}
              </div>
            )}
            {canExport && picked.size > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-b border-brand-100 bg-brand-50/60 px-4 py-2 text-[13px]">
                <span><b className="text-ink">{num(picked.size)}</b> {tr('selected')}</span>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => exportRows(items.filter((c) => picked.has(c.id)))}>
                  <Download className="h-3.5 w-3.5" /> {tr('Export selected')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>{tr('Clear selection')}</button>
              </div>
            )}

            {isLoading && <Skeleton rows={8} />}
            {error != null && <div className="py-10 text-center text-[13px] text-critical-600">{(error as Error).message}</div>}
            {!isLoading && !error && rows.length === 0 && (
              <EmptyState icon="ShieldCheck" title={tr(filtersOn ? 'No control matches these filters' : 'No controls have been proposed yet')}
                          hint={filtersOn ? tr('Clear a filter or the search to see more.') : undefined} />
            )}

            {pageRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-[13px]">
                  <thead>
                    <tr className="whitespace-nowrap border-b border-line bg-slate-50/70 text-left text-xs font-medium text-muted">
                      {canExport && <th className="w-10 py-2.5 pl-4 pr-1"><RowCheck checked={allOnPage} indeterminate={!allOnPage && someOnPage} onChange={togglePage} label={tr('Select all controls on this page')} /></th>}
                      <th className={cn('py-2.5 pr-3', canExport ? 'pl-2' : 'pl-4')}>{tr('Control')}</th>
                      <th className="px-3 py-2.5">{tr('Requirements')}</th>
                      <th className="px-3 py-2.5">{tr('Document')}</th>
                      <th className="px-3 py-2.5">{tr('Status')}</th>
                      <th className="w-8 px-2 py-2.5"><span className="sr-only">{tr('Open')}</span></th>
                    </tr>
                  </thead>
                  <tbody key={`${page}|${status}|${dept}|${type}|${q}`} className="pm-stagger">
                    {pageRows.map((c) => {
                      const hasDoc = (c.evidence ?? 0) > 0;
                      const d = deptOf(c);
                      const edge = { boxShadow: `inset 3px 0 0 ${COV_DOT[covOf(c)]}` };
                      return (
                        <tr key={c.id} onClick={() => setOpen(c.id)} tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(c.id); } }}
                            className={cn('group cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-brand-50/40 focus-visible:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                              open === c.id && 'bg-brand-50/70', picked.has(c.id) && open !== c.id && 'bg-brand-50/30')}>
                          {canExport && <td className="py-3 pl-4 pr-1" style={edge}><RowCheck checked={picked.has(c.id)} onChange={(v) => toggle(c.id, v)} label={tr('Select {name}', { name: c.name })} /></td>}
                          <td className={cn('max-w-[560px] py-3 pr-3', canExport ? 'pl-2' : 'pl-4')} style={canExport ? undefined : edge}>
                            <div className="line-clamp-1 font-semibold text-ink first-letter:uppercase" title={c.name}>{c.name}</div>
                            <div className="mt-0.5 truncate text-[11.5px] text-muted">
                              {[d, c.control_type ? tr(readable(c.control_type)) : '', ownerLabel(tr, c)].filter(Boolean).join(' · ')}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3">
                            <span className="font-semibold tabular-nums text-ink">{num(c.duties)}</span>
                            <span className="ml-1 text-[11.5px] text-muted">{tr('{n} approved', { n: num(c.duties_approved) })}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3">
                            <span className={cn('inline-flex items-center gap-1 text-[12.5px]', hasDoc ? 'text-ink-2' : 'text-muted-2')}>
                              <Paperclip className="h-3.5 w-3.5" />{hasDoc ? num(c.evidence) : tr('None')}
                            </span>
                          </td>
                          <td className="px-3 py-3"><CovPill c={c} /></td>
                          <td className="px-2 py-3 text-muted">
                            <ChevronRight className="h-4 w-4 opacity-60 transition group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden="true" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > 0 && (
              <TableFooter page={page} total={rows.length} size={size} onPage={setPage} onSize={setSize} noun="controls" />
            )}
          </div>

          {open && <ControlPanel key={open} id={open} row={openRow} onClose={() => setOpen(null)} onDept={(d) => { setDept(d); setOpen(null); }} />}
        </div>

        <p className="max-w-3xl text-2xs text-muted">
          {tr('A document attached to a control is not a record that the procedure is followed. Many are DRAFT procedures generated from the duties mapped to the control; they say what the procedure must cover and stay pending until a person adopts one. "Tested" is populated only where holding a certificate is itself the compliance.')}
        </p>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- detail panel */

type PTab = 'details' | 'reqs' | 'evidence' | 'history';
const RISK_TONE: Record<string, 'red' | 'orange' | 'amber' | 'gray'> = { CRITICAL: 'red', HIGH: 'orange', MEDIUM: 'amber', LOW: 'gray' };

function ControlPanel({ id, row, onClose, onDept }: { id: string; row?: Control; onClose: () => void; onDept: (d: string) => void }) {
  // `t` is a risk tone in the Related Risks block below, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const [tab, setTab] = useState<PTab>('details');
  const { data: c, isLoading, error } = useQuery<ControlDetail>({
    queryKey: ['control', id],
    // the panel lists all three; a reply missing one shows it empty instead of crashing the page
    queryFn: () => api<ControlDetail>(`/api/controls/${encodeURIComponent(id)}`).then((d) => ({
      ...d, requirements: d?.requirements ?? [], regulations_list: d?.regulations_list ?? [], evidence_list: d?.evidence_list ?? [],
    })),
  });

  // The listing's counts come from control_requirements; the detail record's own
  // "regulations" field counts an older, empty table — so the row's numbers win.
  const duties = c?.duties ?? row?.duties ?? 0;
  const approved = row?.duties_approved ?? 0;
  const regs = row?.regulations ?? c?.regulations_list.length ?? 0;
  const evidence = row?.evidence ?? c?.evidence_list.length ?? 0;
  const unmet = (c?.regulations_list ?? []).reduce((a, r) => a + (r.unmet ?? 0), 0);
  const base = row ?? c;
  const owner = base ? ownerName(base) : '—';
  const ownerShown = base ? ownerLabel(tr, base) : '—';
  const d = base ? deptOf(base) : '';
  const firstGap = c?.requirements.find((r) => r.gap);
  const risks = (c?.requirements ?? []).filter((r) => r.risk || r.gap);
  const topReg = c?.regulations_list[0];
  const history = base ? ([
    [tx('Created'), base.created_at, 'Plus'], [tx('Last updated'), base.updated_at, 'Pencil'],
    [tx('Last tested'), base.last_tested, 'ClipboardCheck'], [tx('Next test due'), base.next_test_due, 'CalendarClock'],
  ] as const).filter(([, v]) => !!v) : [];

  return (
    <SidePanel onClose={onClose} labelledBy="control-panel-title">
      <PanelHeader
        id="control-panel-title"
        eyebrow={<>{tr('Control')} · <span className="text-brand-600">{id}</span></>}
        title={<span className="first-letter:uppercase">{base?.name ?? id}</span>}
        badges={base && (
          <>
            <CovPill c={base} />
            {base.effectiveness && <StatusPill value={base.effectiveness} size="sm" />}
          </>
        )}
        onClose={onClose}
      />
      <PanelTabs<PTab>
        value={tab} onChange={setTab}
        tabs={[
          { key: 'details', label: 'Details' },
          { key: 'reqs', label: 'Linked Requirements', count: duties },
          { key: 'evidence', label: 'Evidence', count: c ? c.evidence_list.length : evidence },
          { key: 'history', label: 'History', count: history.length },
        ]}
      />
      <div className={DRAWER.body}>
        {isLoading && <Skeleton rows={5} />}
        {error != null && <p className="text-critical-600">{(error as Error).message}</p>}

        {c && tab === 'details' && (
          <>
            {unmet > 0 ? (
              <Callout tone="red" title="Control gap">
                {unmet === 1
                  ? tr('1 of its linked requirements is unmet (non-compliant, partial or missing evidence).')
                  : tr('{n} of its linked requirements are unmet (non-compliant, partial or missing evidence).', { n: num(unmet) })}
                {firstGap?.gap && <span className="mt-1 block text-critical-700">{firstGap.gap}</span>}
              </Callout>
            ) : duties === 0 ? (
              <Callout tone="amber" title="No requirements linked">{tr('Nothing has been mapped to this control yet.')}</Callout>
            ) : approved === 0 ? (
              <Callout tone="amber" title="Not yet approved">
                {tr('None of its {n} requirement links has been accepted by a person — it is a proposal.', { n: num(duties) })}
              </Callout>
            ) : evidence === 0 ? (
              <Callout tone="amber" title="No document attached">{tr('The control covers approved requirements but has no document behind it.')}</Callout>
            ) : (
              <Callout tone="green" title="No recorded gap">{tr('None of the linked requirements read here has an open gap.')}</Callout>
            )}

            {c.description && <p className="leading-relaxed text-ink-2">{c.description}</p>}

            <div className="grid grid-cols-3 gap-3 rounded-[18px] bg-black/[0.03] p-4">
              <Field label="Control type"><TypeChip type={base?.control_type} /></Field>
              <Field label="Department">
                {d ? (
                  <button type="button" onClick={() => onDept(d)} className="inline-flex max-w-full items-center gap-1 text-left text-brand-600 hover:underline" title={tr("Show this department's controls")}>
                    <Building2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{d}</span>
                  </button>
                ) : '—'}
              </Field>
              <Field label="Owner">
                <span className="flex items-center gap-1.5">
                  <Avatar name={owner} size={22} />
                  <span className={cn('truncate', !base?.owner_id && 'text-warning-600')}>{ownerShown}</span>
                </span>
              </Field>
              <Field label="Frequency">{base?.frequency ? tr(readable(base.frequency)) : '—'}</Field>
              <Field label="Automation">{base?.automated ? tr(readable(base.automated)) : '—'}</Field>
              <Field label="Tests">{(row?.tests_run ?? 0) ? tr('{passed} / {run} passed', { passed: num(row?.tests_passed), run: num(row?.tests_run) }) : tr('None')}</Field>
            </div>

            <div>
              <div className="sec-eyebrow mb-3">{tr('Relationship')}</div>
              <FlowSteps steps={[
                { icon: 'ShieldCheck', label: 'Control', sub: base?.control_type ? readable(base.control_type) : tx('no type'), tone: 'blue' },
                { icon: 'ListChecks', label: tr('{n} requirements', { n: num(duties) }), sub: tr('{n} approved', { n: num(approved) }),
                  tone: duties && approved >= duties ? 'green' : approved ? 'amber' : 'orange', onClick: () => setTab('reqs') },
                { icon: 'Scale', label: tr('{n} regulations', { n: num(regs) }), sub: unmet ? tr('{n} unmet', { n: num(unmet) }) : tr('none unmet'), tone: unmet ? 'red' : 'purple' },
                { icon: 'Paperclip', label: tr('Evidence {n}', { n: num(evidence) }), sub: tr(evidence ? 'attached' : 'none'), tone: evidence ? 'teal' : 'orange', onClick: () => setTab('evidence') },
                { icon: 'UserRound', label: ownerShown, sub: ownerRole(base?.owner_id), tone: base?.owner_id ? 'purple' : 'red' },
              ]} />
            </div>

            <PanelBlock title="Linked Requirements" icon="Link2" link={c.requirements.length > 4 ? { onClick: () => setTab('reqs') } : undefined}>
              {c.requirements.length === 0 ? <p className="text-muted">{tr('No requirement is linked.')}</p> : (
                <ul className="divide-y divide-line overflow-hidden rounded-[16px] border border-black/[0.06] bg-white">
                  {c.requirements.slice(0, 4).map((r) => (
                    <li key={r.id} className="flex items-start gap-2.5 px-3 py-2">
                      <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11.5px] font-medium text-brand-600">{r.source_clause ? `§${r.source_clause}` : r.regulation_id}</div>
                        <p className="line-clamp-2 leading-snug text-ink">{r.statement}</p>
                      </div>
                      <StatusPill value={r.compliance_status} size="sm" />
                    </li>
                  ))}
                </ul>
              )}
            </PanelBlock>

            <PanelBlock title="Related Risks" icon="AlertTriangle">
              {risks.length === 0 ? (
                <p className="text-muted">{tr('No open finding on the linked requirements read here.')}</p>
              ) : (
                <ul className="space-y-2">
                  {risks.slice(0, 5).map((r) => {
                    const t = RISK_TONE[(r.risk ?? '').toUpperCase()] ?? 'gray';
                    return (
                      <li key={r.id} className="flex items-start gap-2.5">
                        <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', toneClass(t))}><Icon name="AlertTriangle" className="h-3.5 w-3.5" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11.5px] font-medium text-muted">{r.source_clause ? `§${r.source_clause}` : r.regulation_id}</div>
                          <p className="line-clamp-2 leading-snug text-ink">{r.gap ?? r.statement}</p>
                        </div>
                        {r.risk && <span className={cn('pill px-2 py-0.5 text-[11px]', critClass(r.risk))}>{tr(readable(r.risk))}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </PanelBlock>

            <PanelBlock title={tr('Regulations it answers ({n})', { n: c.regulations_list.length.toLocaleString() })} icon="Scale">
              <ul className="divide-y divide-line overflow-hidden rounded-[16px] border border-black/[0.06] bg-white">
                {c.regulations_list.map((r) => (
                  <li key={r.id} className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      <Link to={`/regulation/${encodeURIComponent(r.id)}`} className="line-clamp-2 min-w-0 flex-1 font-medium text-ink hover:text-brand-600 hover:underline" title={r.title}>{r.title}</Link>
                      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted">
                        {r.duties === 1 ? tr('1 duty') : tr('{n} duties', { n: num(r.duties) })}
                        {r.unmet > 0 && <span className="font-medium text-critical-600"> · {tr('{n} unmet', { n: num(r.unmet) })}</span>}
                      </span>
                    </div>
                    {r.duties > 0 && (
                      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-slate-100" title={tr('{n} unmet of {total}', { n: num(r.unmet), total: num(r.duties) })}>
                        <span className="h-full bg-critical-500" style={{ width: `${(r.unmet / r.duties) * 100}%` }} />
                        <span className="h-full bg-brand-200" style={{ width: `${((r.duties - r.unmet) / r.duties) * 100}%` }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </PanelBlock>
          </>
        )}

        {c && tab === 'reqs' && (
          <section>
            <div className="sec-eyebrow mb-2">{tr('Unmet first — showing {n} of {total}', { n: num(c.requirements.length), total: num(duties) })}</div>
            <ul className="space-y-2">
              {c.requirements.map((r) => (
                <li key={r.id} className="rounded-[16px] border border-black/[0.06] bg-white p-3.5 transition-shadow hover:shadow-sm">
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <StatusPill value={r.compliance_status} size="sm" />
                    {r.risk && <span className={cn('pill px-2 py-0.5 text-[11px]', critClass(r.risk))}>{riskPhrase(tr, r.risk)}</span>}
                    {r.review_status && <span className="pill bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{tr(readable(r.review_status))}</span>}
                    <span className="text-muted">{r.source_clause ? `§${r.source_clause}` : ''}</span>
                    <Link to={`/regulation/${encodeURIComponent(r.regulation_id)}`} className="ml-auto text-brand-600 hover:underline">{tr('Regulation')}</Link>
                  </div>
                  <p className="mt-1 line-clamp-3 leading-relaxed text-ink">{r.statement}</p>
                  {r.gap && <p className="mt-1 text-[12px] text-critical-600">{r.gap}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {c && tab === 'evidence' && (
          c.evidence_list.length === 0 ? (
            <EmptyState icon="Paperclip" title="No document attached" hint="Attach the procedure, record or certificate that shows this control operates." />
          ) : (
            <>
              <ul className="space-y-2">
                {c.evidence_list.map((e) => (
                  <li key={e.evidence_id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                    <HueTile icon="FileText" hue="teal" size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink">{e.name ?? e.evidence_id}</div>
                      <div className="text-[11.5px] text-muted">{e.type ?? tr('Document')} · {e.evidence_id}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-[12px] leading-relaxed text-muted">{tr('An attached document is not a record that the procedure is followed; draft SOPs stay pending until a person adopts one.')}</p>
            </>
          )
        )}

        {c && tab === 'history' && (
          history.length === 0 ? <EmptyState icon="History" title="No dates recorded" /> : (
            <>
              <ol className="relative ml-3 space-y-4 border-l border-line pl-5">
                {history.map(([label, v, icon]) => (
                  <li key={label} className="relative">
                    <span className="absolute -left-[33px] grid h-6 w-6 place-items-center rounded-full bg-brand-50 text-brand-600 ring-4 ring-white">
                      <Icon name={icon} className="h-3.5 w-3.5" />
                    </span>
                    <div className="font-medium text-ink">{tr(label)}</div>
                    <div className="text-[12px] text-muted">{fmtDate(v, locale)}</div>
                  </li>
                ))}
              </ol>
              <p className="text-[12px] text-muted">{tr('These are the dates on the control record; edits are not logged line by line.')}</p>
            </>
          )
        )}
      </div>

      <div className={DRAWER.footer}>
        {topReg && (
          <button type="button" className="btn btn-primary" title={topReg.title} onClick={() => navigate(`/regulation/${encodeURIComponent(topReg.id)}`)}>
            <Icon name="Scale" className="h-4 w-4" /> {tr('Open regulation')}
          </button>
        )}
        {topReg && (
          <button type="button" className="btn btn-outline" title={`${tr('Impact cascade')} — ${topReg.title}`} onClick={() => navigate(`/cascade?reg=${encodeURIComponent(topReg.id)}`)}>
            <Icon name="GitBranch" className="h-4 w-4" /> {tr('Impact cascade')}
          </button>
        )}
        <button type="button" className="btn ml-auto" onClick={onClose}>{tr('Close')}</button>
      </div>
    </SidePanel>
  );
}
