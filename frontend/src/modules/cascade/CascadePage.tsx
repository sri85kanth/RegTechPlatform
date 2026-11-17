/**
 * Impact cascade — regulation → obligation → policy → control → owner.
 *
 * WHAT IT READS
 * -------------
 * /api/cascade/* serves the document-based gap assessment written by
 * scraper/cascade_sync.py: per requirement, a status (met / partial / gap /
 * not covered), a risk band, the rewritten obligation and testable
 * requirement, the hospital documents that cover it, what is missing and the
 * fix. The graph endpoint is the hospital's own policies, SOPs, forms,
 * controls and risk register with their text, so every code on the page opens
 * the document it names.
 *
 * This page owns fetching, the regulation picker and the summary of the
 * selected regulation (KPI cards, counted from the same rows the lattice
 * draws); renderCascade owns one regulation's lattice,
 * dossier, summary table and document drawer. A KPI card sets the lattice's
 * status / risk chips through a `cc:filter` event on the host element.
 * renderCascade builds HTML strings with tNow(), so the lattice is remounted
 * when the interface language changes (`lang` in the mount effect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Topbar } from '@/layouts/Topbar';
import { TabStrip } from '@/components/ui/TabStrip';
import { AppliesByDepartment } from '@/modules/compliance/AppliesByDepartment';
import { CountUp } from '@/components/ui/motion';
import { Icon } from '@/config/icons';
import { api } from '@/services/http';
import { isAuditor, useMe } from '@/services/authApi';
import { useMakeRequest, useMyRequests } from '@/services/auditorApi';
import { cn } from '@/utils/ui';
import { mountCascade, type DocRequestInfo, type DraftRequest } from './renderCascade';
import { RemediationDrawer } from './RemediationDrawer';
import { AuditorTable } from './AuditorTable';
import { draftKey, isRunning, latestDrafts, type DraftSummary, type LlmStatus } from './remediationApi';
import type { CascadeGraph, CascadeRegulation, RegulationSummary, Risk, Status } from './cascadeTypes';
import { MEANING } from './cascadeText';
import { RegulationPicker } from './RegulationPicker';
import { RegulationImpactPage } from '@/modules/impact/RegulationImpactPage';
import { useRegulation } from '@/services/regulationsApi';
import { tx, useLang, useT } from '@/i18n';
import './cascade.css';

interface ListPayload { items: RegulationSummary[]; excluded: string[]; note?: string }
const KEY = 'cb.cascade.reg';
const UNMET: Status[] = ['GAP', 'PARTIAL', 'NOT_COVERED'];
const ALL: Status[] = ['GAP', 'PARTIAL', 'NOT_COVERED', 'MET'];
const pct = (n: number, t: number) => (t > 0 ? Math.round((n / t) * 100) : 0);
/** A test upload is never opened by default; it stays in the picker and its ?reg= link still works. */
const isTestUpload = (id: string) => id.startsWith('upl-test');

export function CascadePage() {
  const t = useT();
  // the lattice is HTML built with tNow(): redraw it when the language changes
  const lang = useLang();
  // An external auditor sees the cascade of the regulations shared with them,
  // read-only: no AI drafting, no upload polling, no links into the rest of the app.
  const { data: me } = useMe();
  const readOnly = isAuditor(me);
  // A regulation uploaded in the app is assessed batch by batch; while its job
  // runs, the list and its cascade refresh so new rows appear as they land.
  const uploads = useQuery<{ items: { regulation_id: string; status: string }[] }>({
    queryKey: ['reg-uploads'], queryFn: () => api('/api/reg-uploads'), refetchInterval: 20_000, enabled: !readOnly,
  });
  const liveRegs = new Set((uploads.data?.items ?? []).filter((j) => j.status === 'RUNNING' || j.status === 'QUEUED').map((j) => j.regulation_id));
  const list = useQuery<ListPayload>({
    queryKey: ['cascade', 'list'], queryFn: () => api('/api/cascade/regulations'),
    staleTime: liveRegs.size ? 10_000 : 300_000, refetchInterval: liveRegs.size ? 20_000 : false,
  });
  const graph = useQuery<CascadeGraph>({ queryKey: ['cascade', 'graph'], queryFn: () => api('/api/cascade/graph'), staleTime: 300_000 });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  const [params, setParams] = useSearchParams();
  // two ways in: one regulation's cascade, or every department and the regulations it answers for
  const view = params.get('view') === 'departments' ? 'departments' : params.get('view') === 'graph' ? 'graph' : 'regulation';
  const openFromDept = (id: string) => { setRegId(id); setParams({}); };
  const [regId, setRegId] = useState<string>(() => {
    const q = params.get('reg');
    if (q) return q;
    // the open regulation is saved automatically, so a saved test upload is usually the old default, not a choice
    try { const saved = localStorage.getItem(KEY) ?? ''; return isTestUpload(saved) ? '' : saved; } catch { return ''; }
  });
  const active = useMemo(
    () => (items.some((i) => i.id === regId) ? regId : (items.find((i) => !isTestUpload(i.id)) ?? items[0])?.id ?? ''),
    [items, regId],
  );
  useEffect(() => { if (active) { try { localStorage.setItem(KEY, active); } catch { /* private mode */ } } }, [active]);

  // A regulation asked for by name (?reg=…, e.g. from the dashboard) is the one shown —
  // never another one in its place. Only assessed regulations have a cascade, so one
  // without is opened on its impact graph, which every regulation has.
  const outside = !!regId && items.length > 0 && !items.some((i) => i.id === regId);
  useEffect(() => {
    if (outside && view === 'regulation') setParams({ view: 'graph', reg: regId }, { replace: true });
  }, [outside, view, regId, setParams]);
  const graphId = view === 'graph' && outside ? regId : active;
  const outsideReg = useRegulation(view === 'graph' && outside ? regId : undefined);

  const reg = useQuery<CascadeRegulation>({
    queryKey: ['cascade', 'reg', active],
    queryFn: () => api(`/api/cascade/regulations/${encodeURIComponent(active)}`),
    enabled: !!active,
    staleTime: liveRegs.has(active) ? 10_000 : 300_000,
    refetchInterval: liveRegs.has(active) ? 30_000 : false,
  });

  // remediation: is the local model reachable, and what has been drafted for this regulation
  const llm = useQuery<LlmStatus>({ queryKey: ['remediation', 'llm'], queryFn: () => api('/api/remediation/llm'), staleTime: 60_000, retry: false, enabled: !readOnly });
  const drafts = useQuery<{ items: DraftSummary[] }>({
    queryKey: ['remediation', 'drafts', active],
    queryFn: () => api(`/api/remediation/drafts?regulation_id=${encodeURIComponent(active)}`),
    enabled: !!active && !readOnly, retry: false,
    // poll only while a draft is being written, so a chip turns "ready" without a reload
    refetchInterval: (q) => (q.state.data?.items.some((d) => isRunning(d.status)) ? 3000 : false),
  });
  const [draftReq, setDraftReq] = useState<DraftRequest | null>(null);
  const latest = useMemo(() => latestDrafts(drafts.data?.items ?? []), [drafts.data]);
  const refetchRef = useRef(drafts.refetch);
  refetchRef.current = drafts.refetch;
  const refetchDrafts = useCallback(() => { void refetchRef.current(); }, []);

  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  const host = useRef<HTMLDivElement>(null);
  // the renderer is told about drafts through an event; keep the newest values for a fresh mount
  const remediation = useRef({ drafts: [] as DraftSummary[], llm: null as LlmStatus | null });
  remediation.current = { drafts: drafts.data?.items ?? [], llm: llm.data ?? null };
  const pushDrafts = useCallback(() => host.current?.dispatchEvent(new CustomEvent('cc:drafts', { detail: remediation.current })), []);
  // auditor view: ask the hospital for an obligation's documents, and show which were already asked for
  const [docReq, setDocReq] = useState<DocRequestInfo | null>(null);
  const [regSheet, setRegSheet] = useState<'info' | 'change' | null>(null);
  const myRequests = useMyRequests(readOnly);
  const requestedCodes = useMemo(() => (myRequests.data?.items ?? [])
    .filter((q) => q.kind === 'document' && (q.status === 'PENDING' || q.status === 'APPROVED') && q.context.regulation_id === active)
    .map((q) => q.context.item_code ?? ''), [myRequests.data, active]);
  const requestedRef = useRef<string[]>([]);
  requestedRef.current = requestedCodes;
  const pushRequests = useCallback(() => host.current?.dispatchEvent(new CustomEvent('cc:requests', { detail: { codes: requestedRef.current } })), []);
  useEffect(() => {
    if (!host.current || !reg.data || !graph.data) return;
    const off = mountCascade(host.current, reg.data, graph.data,
      { nav: (p) => nav.current(p), onDraft: readOnly ? undefined : (r) => setDraftReq(r), readOnly,
        onRequestDocs: readOnly ? (r) => setDocReq(r) : undefined,
        onRegulation: readOnly ? undefined : (tab) => setRegSheet(tab) });
    pushDrafts();
    if (readOnly) pushRequests();
    return off;
  }, [reg.data, graph.data, pushDrafts, pushRequests, readOnly, lang]);
  useEffect(() => { pushDrafts(); }, [drafts.data, llm.data, pushDrafts]);
  useEffect(() => { if (readOnly) pushRequests(); }, [requestedCodes, readOnly, pushRequests]);

  // the selected regulation, counted from the rows the lattice draws
  const sel = useMemo(() => {
    const rows = (reg.data?.units ?? []).flatMap((u) => u.items);
    const n = (f: (x: (typeof rows)[number]) => boolean) => rows.filter(f).length;
    return {
      total: rows.length,
      gap: n((x) => x.st === 'GAP'), partial: n((x) => x.st === 'PARTIAL'),
      nc: n((x) => x.st === 'NOT_COVERED'), met: n((x) => x.st === 'MET'),
      critical: n((x) => x.rk === 'Critical'),
    };
  }, [reg.data]);
  const [kpi, setKpi] = useState<string>('');
  useEffect(() => { setKpi(''); }, [active]);
  const filter = (key: string, st: Status[], rk: Risk[] = []) => {
    const next = kpi === key ? '' : key;
    setKpi(next);
    host.current?.dispatchEvent(new CustomEvent('cc:filter', { detail: next ? { st, rk } : { st: UNMET, rk: [] } }));
    host.current?.querySelector('.canvas')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const error = list.error ?? graph.error ?? reg.error;
  const loading = list.isLoading || graph.isLoading || (!!active && reg.isLoading);
  const r = reg.data;

  // An auditor gets one table — requirement, what the hospital has, what is missing — and nothing else.
  if (readOnly) {
    return (
      <div>
        <Topbar title="Requirements check" icon="ClipboardCheck"
                subtitle="For each requirement: what the hospital has on record, and what is missing." />
        <div className="p-6">
          {list.data?.note && !items.length && <div className="text-sm text-muted">{list.data.note}</div>}
          <AuditorTable regs={items} active={active} onPick={setRegId} reg={reg.data} graph={graph.data}
                        loading={loading} error={error} requested={requestedCodes} onAsk={setDocReq} />
        </div>
        {docReq && <RequestDocsDialog req={docReq} onClose={() => setDocReq(null)} />}
      </div>
    );
  }

  return (
    <div>
      <Topbar
        title="Impact Cascade"
        subtitle={view === 'departments'
          ? 'Each department, and the regulations it answers for — open one to trace its cascade'
          : view === 'graph'
            ? 'How this regulation propagates through the company, and on what evidence'
            : 'Each obligation traced to the policy, control and owner behind it — or to the gap where there is none'}
        icon="GitBranch"
        // The regulation box in the cascade opens the sheet (info, or Change); the
        // header button is only there when no box is drawn to click.
        actions={view === 'departments' ? undefined
          : <RegulationPicker compact noButton={view === 'regulation' && !!r && sel.total > 0} sheet={regSheet} onSheet={setRegSheet}
                              items={items} active={graphId === active ? active : ''} reg={graphId === active ? r : undefined} onPick={setRegId} />}
        below={
          <TabStrip
            ariaLabel="Impact Cascade views"
            tabs={[{ key: 'regulation', label: 'By regulation' }, { key: 'departments', label: 'By department' }, { key: 'graph', label: 'Impact graph' }]}
            active={view}
            onChange={(v) => setParams(v === 'regulation' ? {} : { view: v })}
          />
        }
      />
      {view === 'departments' && (
        <div className="p-6"><AppliesByDepartment onOpen={openFromDept} /></div>
      )}
      {view === 'graph' && (
        <div className="p-6">
          {/* the regulation this graph is for, named, when it is not one the picker holds */}
          {graphId !== active && (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-white px-4 py-3">
              <Icon name="GitBranch" className="h-4 w-4 shrink-0 text-brand-600" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-ink" title={outsideReg.data?.title}>{outsideReg.data?.title ?? graphId}</span>
                <span className="block text-[12px] text-muted">{t('Not assessed in the cascade yet, so it is shown on its impact graph.')}</span>
              </span>
              <button type="button" onClick={() => navigate(`/regulation/${encodeURIComponent(graphId)}`)} className="btn btn-sm">{t('Open regulation')}</button>
            </div>
          )}
          {graphId ? <RegulationImpactPage key={graphId} embedId={graphId} onChangeRegulation={readOnly || graphId !== active ? undefined : () => setRegSheet('change')} /> : <div className="text-sm text-muted">{t('Loading the cascade…')}</div>}
        </div>
      )}
      {/* kept mounted while another view is open, so the drawn cascade survives the switch */}
      <div className={cn('space-y-4 p-6', view !== 'regulation' && 'hidden')}>
        {/* the selected regulation in numbers; each card filters the lattice */}
        {r && sel.total > 0 && (
            <StatusPanel sel={sel} kpi={kpi} filter={filter} />
        )}

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{(error as Error).message}</div>}
        {list.data?.note && !items.length && <div className="text-sm text-muted">{list.data.note}</div>}
        {loading && <div className="text-sm text-muted">{t('Loading the cascade…')}</div>}
        <div ref={host} className="cascade" />
      </div>
      {docReq && <RequestDocsDialog req={docReq} onClose={() => setDocReq(null)} />}
      {draftReq && !readOnly && (
        <RemediationDrawer
          key={`${draftReq.rid}|${draftReq.kind}`}
          req={draftReq}
          existing={latest.get(draftKey(draftReq.rid, draftReq.kind))}
          llm={llm.data ?? null}
          onClose={() => { setDraftReq(null); refetchDrafts(); }}
          onChanged={refetchDrafts}
        />
      )}
    </div>
  );
}

/** Auditor view: ask the hospital for the documents behind one obligation. */
function RequestDocsDialog({ req, onClose }: { req: DocRequestInfo; onClose: () => void }) {
  const t = useT();
  const make = useMakeRequest();
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const none = req.codes.length === 0;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="pm-fade fixed inset-0 z-[80] grid place-items-center bg-slate-900/30 p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="rq-title"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pm-modal w-full max-w-[520px] overflow-hidden rounded-[24px] bg-white shadow-[0_30px_80px_-24px_rgba(0,0,0,0.38),0_0_0_0.5px_rgba(0,0,0,0.08)]">
        <div className="border-b border-line bg-gradient-to-r from-orange-50 to-amber-50/40 px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">{t('Request documents')} · {req.code}</div>
          <h2 id="rq-title" className="mt-1 text-[15px] font-semibold leading-snug text-ink">{req.title}</h2>
        </div>
        {done ? (
          <div className="space-y-3 p-5">
            <p className="text-[13.5px] text-ink-2">{t('Your request was sent to the hospital. You can follow it under Requests; files they approve appear under Shared with you.')}</p>
            <div className="flex justify-end"><button className="btn btn-primary" onClick={onClose}>{t('Close')}</button></div>
          </div>
        ) : (
          <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); make.mutate({ kind: 'document', ref: `${req.regId}|${req.code}`, message }, { onSuccess: () => setDone(true) }); }}>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
              {none
                ? <>{t('No supporting document is on record for this obligation. Ask for whatever shows it is done: a policy, a register, filled forms.')}</>
                : <>{t('Documents on record')}: <b className="font-mono text-[12px]">{req.codes.join(', ')}</b>. {t('The hospital can share the files that hold them.')}</>}
            </div>
            <label className="block">
              <span className="field-label">{t('What you need, and why (optional)')}</span>
              <textarea className="input h-[96px] w-full py-2 text-[13px]" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)}
                        placeholder={t(none ? 'e.g. The intra-operative monitoring charts for 10 recent cases' : 'e.g. The signed policy and the last 3 months of audit sheets')} />
            </label>
            {make.error && <p className="text-[12.5px] text-critical-600">{make.error.message}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={make.isPending}>{t(make.isPending ? 'Sending…' : 'Send request')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * A KPI card whose caption says, in plain words, what the colour means — the
 * same wording as the status key and the filter chips (cascadeText.ts).
 * Clicking it sets the diagram's filter. Label and caption arrive in English
 * and are translated here.
 */
const CRIT = 'crit';
const CRIT_MEANING = tx('Duties that would be most serious if not met');
/** the four verdicts, in the order the panel draws them: [key, label, status, tone colour, ink, icon] */
const STATUS_ROWS: [string, string, Status, string, string, string][] = [
  ['gap', tx('Gap'), 'GAP', '#ff3b30', 'text-critical-600', 'XCircle'],
  ['partial', tx('Partial'), 'PARTIAL', '#ff9f0a', 'text-warning-600', 'AlertTriangle'],
  ['nc', tx('Not covered'), 'NOT_COVERED', '#ff6a00', 'text-notcov-600', 'FileWarning'],
  ['met', tx('Documented'), 'MET', '#34c759', 'text-success-600', 'CheckCircle2'],
];

/**
 * The selected regulation in numbers, as one panel: a donut of how its
 * obligations split, then a tile per verdict (and for the critical ones) with
 * its share drawn as a bar. Every part filters the diagram below.
 */
function StatusPanel({ sel, kpi, filter }: {
  sel: { total: number; gap: number; partial: number; nc: number; met: number; critical: number };
  kpi: string; filter: (k: string, st: Status[], rk?: Risk[]) => void;
}) {
  const t = useT();
  const counts: Record<string, number> = { gap: sel.gap, partial: sel.partial, nc: sel.nc, met: sel.met };
  const r = 44, len = 2 * Math.PI * r;
  let at = 0;
  const segs = STATUS_ROWS.map(([k, , , hex]) => {
    const part = sel.total ? (counts[k] / sel.total) * len : 0;
    const seg = { k, hex, part, at };
    at += part;
    return seg;
  });
  const tile = (key: string, label: string, n: number, hex: string, ink: string, icon: string, onClick: () => void, i: number) => {
    const on = kpi === key;
    const share = pct(n, sel.total);
    const caption = key === CRIT ? CRIT_MEANING : MEANING[STATUS_ROWS.find((x) => x[0] === key)![2]];
    return (
      <button key={key} type="button" onClick={onClick} aria-pressed={on}
              title={t('{label}: {caption}. Click to show these in the diagram.', { label: t(label), caption: t(caption) })}
              style={{ '--c': hex, '--d': `${i * 70}ms` } as React.CSSProperties}
              className={cn('cc-stat group relative flex min-w-0 flex-col items-start bg-white px-4 py-3.5 text-left transition-colors', on && 'cc-stat-on')}>
        <span className="flex w-full items-center justify-between">
          <span className={cn('grid h-8 w-8 place-items-center rounded-xl transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6', n ? ink : 'text-slate-400')}
                style={{ background: n ? `color-mix(in srgb, ${hex} 14%, white)` : '#f2f2f7' }}>
            <Icon name={icon} className="h-4 w-4" />
          </span>
          <span className={cn('rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums', n ? ink : 'text-slate-400')}
                style={{ background: n ? `color-mix(in srgb, ${hex} 10%, white)` : '#f2f2f7' }}>{share}%</span>
        </span>
        <CountUp value={n} className={cn('num mt-2.5 text-[26px] font-bold leading-none tracking-tight', n ? 'text-ink' : 'text-slate-300')} />
        <span className="mt-1 text-[12.5px] font-semibold text-ink-2">{t(label)}</span>
        <span className="mt-2.5 block h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <span className="cc-bar block h-full rounded-full" style={{ width: `${Math.max(n ? 3 : 0, share)}%`, background: hex }} />
        </span>
      </button>
    );
  };
  return (
    <section className="card grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
      {/* the whole: every obligation, split by verdict */}
      <button type="button" onClick={() => filter('all', ALL)} aria-pressed={kpi === 'all'}
              title={t('{label}: {caption}. Click to show these in the diagram.', { label: t('Obligations'), caption: t('Duties this regulation places on the hospital') })}
              className={cn('flex items-center gap-4 border-b border-line bg-gradient-to-br from-slate-50 to-white p-4 text-left transition-colors hover:from-brand-50/60 lg:border-b-0 lg:border-r', kpi === 'all' && 'cc-stat-on')}>
        <span className="relative grid h-[108px] w-[108px] shrink-0 place-items-center">
          <svg viewBox="0 0 108 108" className="absolute inset-0 -rotate-90" aria-hidden="true">
            <circle cx="54" cy="54" r={r} fill="none" stroke="#f2f2f7" strokeWidth="12" />
            {segs.filter((g) => g.part > 0).map((g, i) => (
              <circle key={g.k} cx="54" cy="54" r={r} fill="none" stroke={g.hex} strokeWidth="12"
                      strokeDasharray={`${Math.max(0, g.part - 1.5)} ${len}`} strokeDashoffset={-g.at}
                      className="cc-seg" style={{ '--d': `${i * 120}ms`, '--len': len } as React.CSSProperties} />
            ))}
          </svg>
          <span className="relative text-center leading-none">
            <CountUp value={sel.total} className="num block text-[24px] font-bold text-ink" />
            <span className="mt-1 block text-[10.5px] font-semibold uppercase tracking-wide text-muted">{t('Obligations')}</span>
          </span>
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-ink">{t('Obligations')}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-muted">{t('Duties this regulation places on the hospital')}</span>
          <span className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1">
            {STATUS_ROWS.map(([k, l, , hex]) => counts[k] > 0 && (
              <span key={k} className="inline-flex items-center gap-1 text-[11px] text-muted"><i className="h-2 w-2 rounded-full" style={{ background: hex }} />{t(l)}</span>
            ))}
          </span>
        </span>
      </button>
      {/* each verdict, and the critical ones */}
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-5">
        {STATUS_ROWS.map(([k, l, st, hex, ink, icon], i) => tile(k, l, counts[k], hex, ink, icon, () => filter(k, [st]), i))}
        {tile(CRIT, tx('Critical priority'), sel.critical, '#d70015', 'text-critical-600', 'Flame', () => filter(CRIT, ALL, ['Critical']), 4)}
      </div>
    </section>
  );
}
