/**
 * Risk review — the register the rules build from the risk library and the
 * company's records, and the queue of what people must decide (design §7,
 * gates G3–G9). Rules decide the scores; people own the judgments:
 *
 *   To decide   review tasks routed to a person or a role, most urgent first
 *   Register    every risk with its verdict and inherent → residual → target
 *   Questions   what decides whether a library risk applies to this organisation
 *   Rulebook    a rulebook version is published by an admin and a governor
 *
 * Opened from a notification as /risk-review?task=<id>: that task's risk opens.
 */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BookCheck, ChevronRight, CircleHelp, Clock, ListChecks, Plus, RefreshCw, Scale, Search, ShieldQuestion, Siren, UserCheck, UserRound, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { TabStrip } from '@/components/ui/TabStrip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Avatar, Callout, EmptyState, Skeleton } from '@/components/ui/primitives';
import { toneFor } from '@/config/tones';
import { can, useMe } from '@/services/authApi';
import { useRiskMeta } from '@/services/riskApi';
import {
  useQuestions, useRegister, useRunRegister, useTasks, type Gate, type RegisterRow, type ReviewTask, type Verdict,
} from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import { Pill } from '../riskUi';
import { RiskDrawer } from './RiskDrawer';
import { TaskActions } from './TaskActions';
import { AddRiskPanel, QuestionsTab, RulebookTab } from './ReviewTabs';
import { ControlsTab } from './ControlsTab';
import { BandChip, BandJourney, ConfidenceMeter, PostureTiles, VerdictChip } from './reviewUi';
import {
  GATE_LABEL, GATE_ORDER, PRIORITY_HEX, PRIORITY_LABEL, PRIORITY_TONE, SOURCE_LABEL, VERDICT_HEX, dueText, roleLabel, sourceOf, taskText,
  type RiskSource,
} from './reviewLabels';

type TabKey = 'queue' | 'register' | 'controls' | 'questions' | 'rulebook';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'queue', label: tx('To decide') }, { key: 'register', label: tx('Register') },
  { key: 'controls', label: tx('Controls') }, { key: 'questions', label: tx('Questions') },
  { key: 'rulebook', label: tx('Rulebook') },
];
const url = (k: TabKey) => (k === 'queue' ? '/risk-review' : `/risk-review/${k}`);

export function RiskReviewPage() {
  const t = useT();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const run = useRunRegister();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ riskId: string; task?: ReviewTask | null } | null>(null);
  const active = (tab ?? 'queue') as TabKey;
  if (!TABS.some((x) => x.key === active)) return <Navigate to="/risk-review" replace />;

  return (
    <>
      <Topbar
        title="Risk review"
        subtitle="The rules score each risk; people decide what to do about it"
        icon="ShieldAlert"
        tone={toneFor('risks')}
        actions={can(me, 'propose') && (
          <>
            <button type="button" className="btn" disabled={run.isPending} onClick={() => run.mutate()}
                    title={t('Rebuild the register from the library and the records, and re-assess every risk')}>
              <RefreshCw className={cn('h-4 w-4', run.isPending && 'animate-spin')} /> {run.isPending ? t('Assessing…') : t('Re-assess')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> {t('Add a risk')}
            </button>
          </>
        )}
        below={<TabStrip ariaLabel="Risk review" tabs={TABS} active={active} onChange={(k) => navigate(url(k))} />}
      />
      <div key={active} className="space-y-4 p-4 sm:p-6">
        {run.error && <p role="alert" className="text-[12.5px] text-critical-600">{run.error.message}</p>}
        {active === 'queue' && <QueueTab onOpen={(riskId, task) => setOpen({ riskId, task })} />}
        {active === 'register' && <RegisterTab onOpen={(riskId) => setOpen({ riskId })} />}
        {active === 'controls' && <ControlsTab />}
        {active === 'questions' && <QuestionsTab />}
        {active === 'rulebook' && <RulebookTab />}
      </div>
      {open && <RiskDrawer riskId={open.riskId} task={open.task} onClose={() => setOpen(null)} />}
      {adding && <AddRiskPanel onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setOpen({ riskId: id }); }} />}
    </>
  );
}

// ------------------------------------------------------------------ to decide
function QueueTab({ onOpen }: { onOpen: (riskId: string, task: ReviewTask) => void }) {
  const t = useT();
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const [mine, setMine] = useState<'mine' | 'all'>('all');
  const [gate, setGate] = useState<Gate | null>(null);
  const { data, isLoading, error } = useTasks(mine === 'mine', null);
  const { data: reg } = useRegister();
  const { data: qs } = useQuestions();
  const navigate = useNavigate();
  const run = useRunRegister();
  const open = (qs?.items ?? []).filter((q) => q.value == null && q.waiting > 0);
  const items = useMemo(() => (data?.items ?? []).filter((x) => !gate || x.gate === gate), [data, gate]);

  // /risk-review?task=… (from a notification): open that task's risk once the queue is in
  const wanted = params.get('task');
  useEffect(() => {
    if (!wanted || !data) return;
    const hit = data.items.find((x) => x.id === wanted);
    if (hit?.risk_id) onOpen(hit.risk_id, hit);
    params.delete('task');
    setParams(params, { replace: true });
  }, [wanted, data]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <Skeleton rows={6} />;
  if (error || !data) return <p className="text-critical-600">{(error as Error)?.message}</p>;
  if (reg && reg.items.length === 0) return <FirstRun canBuild={can(me, 'propose')} run={run} />;
  const s = data.summary;
  return (
    <div className="space-y-4">
      {reg && !reg.appetite && (
        <Callout tone="amber" icon="AlertTriangle" title={t('No approved risk appetite yet')}>
          {t('Risks are scored, but nothing is judged "treat" or "escalate" until leadership approves the appetite in Risk inputs.')}
        </Callout>
      )}
      {open.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-brand-100 bg-brand-50/60 px-4 py-3">
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">
            <b className="font-semibold text-ink">{t('{n} questions would settle most possible risks.', { n: open.length })}</b>{' '}
            {t('One answer — "do you build software?" — decides every library risk that depends on it.')}
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/risk-review/questions')}>{t('Answer the questions')}</button>
        </div>
      )}
      {open.length === 0 && <ControlsCallout n={reg?.controls?.waitingOnControls ?? 0} />}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
        <Metric icon={ListChecks} label={t('Open')} value={s.open} />
        <Metric icon={Siren} label={t('Urgent')} value={s.urgent} hex={s.urgent ? '#dc2626' : undefined} />
        <Metric icon={Clock} label={t('Overdue')} value={s.overdue} hex={s.overdue ? '#d97706' : undefined} />
        <SegmentedControl ariaLabel="Show" className="ml-auto" value={mine} onChange={setMine}
                          options={[{ key: 'all', label: tx('Everyone') }, { key: 'mine', label: tx('For me') }]} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        <nav aria-label={t('Kind of decision')} className="card h-fit p-1.5 lg:sticky lg:top-24">
          <GateButton icon={ListChecks} label={t('Everything')} n={s.open} on={!gate} onClick={() => setGate(null)} />
          {GATE_ORDER.filter((g) => s.byGate[g]).map((g) => (
            <GateButton key={g} icon={GATE_ICON[g]} label={t(GATE_LABEL[g])} n={s.byGate[g] ?? 0} on={gate === g} onClick={() => setGate(g)} />
          ))}
        </nav>
        {items.length === 0 ? (
          <div className="card p-8"><EmptyState icon="CheckCircle2" title={t('Nothing waiting here.')} hint={t('New reviews appear when an assessment calls for a person.')} /></div>
        ) : (
          <div className="space-y-5">
            {buckets(items).map(([key, list]) => (
              <section key={key} aria-label={t(BUCKET_LABEL[key])}>
                <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: BUCKET_HEX[key] }} aria-hidden="true" />
                  {t(BUCKET_LABEL[key])}<span className="font-normal tabular-nums">· {list.length}</span>
                </h3>
                <ul className="space-y-2.5">
                  {list.map((x) => <TaskCard key={x.id} task={x} me={me?.id} onOpen={() => x.risk_id && onOpen(x.risk_id, x)} />)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const GATE_ICON: Record<Gate, LucideIcon> = {
  G6: Wrench, G5: Siren, G7: UserCheck, G4: ShieldQuestion, G3: Scale, G9: CircleHelp, G8: BookCheck,
};
type Bucket = 'late' | 'week' | 'later';
const BUCKET_LABEL: Record<Bucket, string> = { late: tx('Overdue'), week: tx('Due this week'), later: tx('Later') };
const BUCKET_HEX: Record<Bucket, string> = { late: '#dc2626', week: '#d97706', later: '#94a3b8' };
/** the queue in three bands by due date, each still most urgent first */
function buckets(items: ReviewTask[]): [Bucket, ReviewTask[]][] {
  const now = Date.now(), week = now + 7 * 86_400_000;
  const out: Record<Bucket, ReviewTask[]> = { late: [], week: [], later: [] };
  for (const x of items) {
    const due = new Date(x.due_at).getTime();
    out[due < now ? 'late' : due <= week ? 'week' : 'later'].push(x);
  }
  return (['late', 'week', 'later'] as Bucket[]).filter((k) => out[k].length).map((k) => [k, out[k]]);
}

/** The first visit: three steps, in order, before the register means anything. */
function FirstRun({ canBuild, run }: { canBuild: boolean; run: ReturnType<typeof useRunRegister> }) {
  const t = useT();
  const navigate = useNavigate();
  const steps = [
    { n: 1, title: t('Build the register'), text: t('The rules read the risk library and your records — sites, vendors, systems, history — and list every risk that may apply.') },
    { n: 2, title: t('Answer the questions'), text: t('One answer, like "do you build software?", settles every library risk that depends on it.') },
    { n: 3, title: t('Bring in your controls'), text: t('Match the controls you already have, or fill the workbook. Then the risks are scored.') },
  ];
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line bg-gradient-to-br from-brand-50/80 to-white px-6 py-6">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-brand-600">{t('Risk review')}</p>
        <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">{t('The register has not been built yet')}</h2>
        <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">
          {t('Anything the rules cannot decide comes to "To decide" for a person. Nothing is judged "low" because it is unknown.')}
        </p>
        {canBuild && (
          <button type="button" className="btn btn-primary mt-4" disabled={run.isPending} onClick={() => run.mutate()}>
            <RefreshCw className={cn('h-4 w-4', run.isPending && 'animate-spin')} /> {run.isPending ? t('Building…') : t('Build the register')}
          </button>
        )}
        {run.error && <p role="alert" className="mt-2 text-[12.5px] text-critical-600">{run.error.message}</p>}
      </div>
      <ol className="grid gap-px bg-line md:grid-cols-3">
        {steps.map((x) => (
          <li key={x.n} className="bg-surface px-6 py-5">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-600 text-[13px] font-bold text-white">{x.n}</span>
            <p className="mt-3 text-[14px] font-semibold text-ink">{x.title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{x.text}</p>
            {x.n === 2 && <button type="button" className="mt-3 text-[13px] font-medium text-brand-600 hover:underline" onClick={() => navigate('/risk-review/questions')}>{t('Open Questions')}</button>}
            {x.n === 3 && <button type="button" className="mt-3 text-[13px] font-medium text-brand-600 hover:underline" onClick={() => navigate('/risk-review/controls')}>{t('Open Controls')}</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Shown while risks wait on their controls: the one step that turns "can't score yet" into scores. */
function ControlsCallout({ n }: { n: number }) {
  const t = useT();
  const navigate = useNavigate();
  if (!n) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-amber-200 bg-amber-50/60 px-4 py-3">
      <p className="min-w-0 flex-1 text-[13px] text-ink-2">
        <b className="font-semibold text-ink">{n === 1 ? t("1 risk can't be scored until its controls are known.") : t("{n} risks can't be scored until their controls are known.", { n })}</b>{' '}
        {t('Bring in the controls you already have, or fill the workbook.')}
      </p>
      <button type="button" className="btn btn-sm" onClick={() => navigate('/risk-review/controls')}>{t('Import controls')}</button>
    </div>
  );
}

function Metric({ icon: Icon, label, value, hex }: { icon: LucideIcon; label: string; value: number; hex?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-ink-2" style={hex ? { background: `${hex}1a`, color: hex } : undefined}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="leading-tight">
        <span className="block text-[20px] font-bold tabular-nums text-ink" style={hex ? { color: hex } : undefined}>{value.toLocaleString()}</span>
        <span className="block text-[11.5px] font-medium text-muted">{label}</span>
      </span>
    </div>
  );
}

function GateButton({ icon: Icon, label, n, on, onClick }: { icon: LucideIcon; label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
            className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition',
              on ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-2 hover:bg-slate-50')}>
      <Icon className={cn('h-4 w-4 shrink-0', on ? 'text-brand-600' : 'text-muted')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('min-w-6 rounded-full px-1.5 text-center text-[11.5px] font-semibold tabular-nums', on ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-ink-2')}>{n.toLocaleString()}</span>
    </button>
  );
}

function TaskCard({ task, me, onOpen }: { task: ReviewTask; me?: string; onOpen: () => void }) {
  const t = useT();
  const due = dueText(task.due_at, t);
  const who = task.assignee_user ? (task.assignee_user === me ? t('You') : t('The risk owner')) : roleLabel(task.assignee_role, t);
  const Icon = GATE_ICON[task.gate];
  return (
    <li>
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
           className="group relative flex cursor-pointer gap-3.5 overflow-hidden rounded-card border border-line bg-surface p-4 pl-5 shadow-card transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
        <span className="absolute inset-y-0 left-0 w-1" style={{ background: PRIORITY_HEX[task.priority] }} aria-hidden="true" />
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-brand-600">{t(GATE_LABEL[task.gate])}</span>
            <Pill className={PRIORITY_TONE[task.priority]}>{t(PRIORITY_LABEL[task.priority])}</Pill>
            <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
              due.late ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-ink-2')}>
              <Clock className="h-3 w-3" />{due.text}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-start gap-2">
            <p className="min-w-0 flex-1 text-[14.5px] font-semibold leading-snug text-ink">{task.risk_title ?? t('Rulebook')}</p>
            {task.gate !== 'G9' && <VerdictChip verdict={task.verdict} />}
            {task.residual_band && <BandChip band={task.residual_band} />}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{taskText(task, t)}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted"><UserRound className="h-3.5 w-3.5" />{who}</span>
            <span className="flex-1" aria-hidden="true" />
            <TaskActions task={task} />
            {task.risk_id && <span className="inline-flex items-center gap-0.5 text-[12.5px] font-medium text-brand-600">{t('Open the risk')}<ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" /></span>}
          </div>
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ register
const PAGE = 60;

function RegisterTab({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const { data: me } = useMe();
  const run = useRunRegister();
  const { data, isLoading, error } = useRegister();
  const { data: meta } = useRiskMeta();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [source, setSource] = useState<RiskSource | 'all'>('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const themeName = (id: string | null) => meta?.themes.find((x) => x.id === id)?.name ?? id ?? '';
  const counts = useMemo(() => {
    const c: Partial<Record<Verdict, number>> = {};
    for (const r of data?.items ?? []) if (r.effective_verdict) c[r.effective_verdict] = (c[r.effective_verdict] ?? 0) + 1;
    return c;
  }, [data]);
  const rows = useMemo(() => (data?.items ?? [])
    .filter((r) => !verdict || r.effective_verdict === verdict)
    .filter((r) => source === 'all' || sourceOf(r) === source)
    .filter((r) => !q.trim() || `${r.title} ${themeName(r.theme)} ${r.owner_name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title)),
  [data, verdict, source, q, meta]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <Skeleton rows={8} />;
  if (error || !data) return <p className="text-critical-600">{(error as Error)?.message}</p>;
  if (data.items.length === 0) return <FirstRun canBuild={can(me, 'propose')} run={run} />;
  return (
    <div className="space-y-4">
      <PostureTiles counts={counts} total={data.items.length} active={verdict} onSelect={(v) => { setVerdict(v); setShown(PAGE); }} />
      <ControlsCallout n={data.controls?.waitingOnControls ?? 0} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input w-full pl-9" placeholder={t('Search risks, themes, owners')} value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
          </label>
          <select className="input w-auto" aria-label={t('Where it came from')} value={source}
                  onChange={(e) => { setSource(e.target.value as RiskSource | 'all'); setShown(PAGE); }}>
            <option value="all">{t('Every source')}</option>
            {(['regulations', 'library', 'person'] as RiskSource[]).map((k) => <option key={k} value={k}>{t(SOURCE_LABEL[k])}</option>)}
          </select>
          <span className="text-[12px] tabular-nums text-muted">{t('{n} of {m} risks', { n: rows.length, m: data.items.length })}</span>
        </div>
        {!data.rulebook.published && (
          <p className="border-b border-line bg-slate-50/70 px-4 py-2 text-[12px] text-muted">
            {t('Scored with rulebook {name} {v}, not yet published by an admin and a governor.', { name: data.rulebook.name, v: data.rulebook.version })}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-slate-50/60 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-2.5 pl-5 pr-3">{t('Risk')}</th>
                <th className="px-3 py-2.5">{t('Verdict')}</th>
                <th className="px-3 py-2.5">{t('Inherent → residual → target')}</th>
                <th className="px-3 py-2.5">{t('Confidence')}</th>
                <th className="px-3 py-2.5">{t('Owner')}</th>
                <th className="px-4 py-2.5 text-right">{t('Reviews')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.id); }}
                    className="group cursor-pointer border-b border-line/60 last:border-0 hover:bg-brand-50/40 focus-visible:bg-brand-50 focus-visible:outline-none">
                  <td className="relative max-w-[400px] py-3 pl-5 pr-3"
                      style={{ boxShadow: r.effective_verdict ? `inset 3px 0 0 ${VERDICT_HEX[r.effective_verdict]}` : undefined }}>
                    <p className="line-clamp-2 font-medium leading-snug text-ink group-hover:text-brand-700" title={r.title}>{r.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
                      <span className="truncate">{themeName(r.theme) || t('No theme yet')}</span>
                      <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-ink-2">{t(SOURCE_LABEL[sourceOf(r)])}</span>
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <span className="inline-flex items-center gap-1">
                      <VerdictChip verdict={r.effective_verdict} />
                      {r.overridden.length > 0 && <span className="text-[11px] font-semibold text-violet-700" title={t('Overridden')}>*</span>}
                    </span>
                  </td>
                  <td className="px-3 py-3"><BandJourney inherent={r.inherent_band} residual={r.effective_residual} target={r.target_band} provisional={!!r.provisional} /></td>
                  <td className="px-3 py-3"><ConfidenceMeter value={r.confidence} /></td>
                  <td className="px-3 py-3">
                    {r.owner_name
                      ? <span className="inline-flex max-w-[160px] items-center gap-2 text-ink-2"><Avatar name={r.owner_name} size={24} /><span className="truncate">{r.owner_name}</span></span>
                      : <span className="text-[12px] italic text-muted">{t('No owner')}</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.open_tasks > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11.5px] font-semibold text-brand-700">
                        <ListChecks className="h-3 w-3" />{r.open_tasks}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="p-8"><EmptyState icon="Search" title={t('No risk matches.')} /></div>}
        </div>
      </div>
      {rows.length > shown && (
        <button type="button" className="btn mx-auto flex" onClick={() => setShown(shown + PAGE)}>
          {t('Show {n} more', { n: Math.min(PAGE, rows.length - shown) })}
        </button>
      )}
    </div>
  );
}

/** most pressing first: escalate, treat, can't score, review, within */
function rank(r: RegisterRow): number {
  const v = { ESCALATE: 5, TREAT: 4, INSUFFICIENT_EVIDENCE: 3, REVIEW_REQUIRED: 2, WITHIN_APPETITE: 1 }[r.effective_verdict ?? 'WITHIN_APPETITE'] ?? 0;
  const b = { CRITICAL: 0.4, HIGH: 0.3, MEDIUM: 0.2, LOW: 0.1 }[r.effective_residual ?? 'LOW'] ?? 0;
  return v + b;
}
