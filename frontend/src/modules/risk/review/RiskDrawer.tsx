/**
 * One risk, everything a person needs to judge it (design §9 derivation panel,
 * §7 gates): where it stands (inherent → residual → target, verdict, confidence,
 * what is missing), and the decisions — owner, treatment (G6), overrides (G7),
 * controls and their validation (G4), applicability (G3) — with its history.
 *
 * The computed value is always shown beside any override. The store refuses what
 * a person may not do (four eyes, leadership for escalations) and says why.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRightLeft, Ban, Check, ChevronsUp, Handshake, Plus, ShieldCheck, Trash2, UserRound, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { SidePanel, PanelHeader, PanelTabs } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { Skeleton } from '@/components/ui/primitives';
import { can, useMe, useUsers } from '@/services/authApi';
import { useRiskMeta, type Band } from '@/services/riskApi';
import {
  useDecideExposure, useDecideOverride, useDecideTreatment, useProposeOverride, useRecordControl, useRevokeOverride,
  useRiskDetail, useSetOwner, useValidateControl,
  type AssessmentResult, type ControlRating, type Grade, type Override, type ReviewTask, type RiskDetail, type Treatment, type Verdict,
} from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';
import { FieldRow, Pill } from '../riskUi';
import { BAND_LABEL, CATEGORY_LABEL } from '../labels';
import { BandBlocks, ConfidenceRing, VerdictChip } from './reviewUi';
import { FACT_LABEL, GRADE_LABEL, LIFECYCLE_LABEL, TREATMENT_LABEL, VERDICT_HEX, VERDICT_LABEL, inr, taskText } from './reviewLabels';
import { TaskActions } from './TaskActions';

type Section = 'decide' | 'controls' | 'exposures' | 'history';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'decide', label: tx('Decide') }, { key: 'controls', label: tx('Controls') },
  { key: 'exposures', label: tx('What it covers') }, { key: 'history', label: tx('History') },
];
const SECTION_FOR: Record<string, Section> = { G3: 'exposures', G4: 'controls', G9: 'exposures' };

export function RiskDrawer({ riskId, task, onClose }: { riskId: string; task?: ReviewTask | null; onClose: () => void }) {
  const t = useT();
  const { data, isLoading, error } = useRiskDetail(riskId);
  const { data: meta } = useRiskMeta();
  const [section, setSection] = useState<Section>(SECTION_FOR[task?.gate ?? ''] ?? 'decide');
  const theme = meta?.themes.find((x) => x.id === data?.risk.theme)?.name ?? data?.risk.theme ?? '';

  return (
    <SidePanel onClose={onClose} labelledBy="risk-drawer" wide>
      <PanelHeader id="risk-drawer" eyebrow={theme} title={data?.risk.title ?? t('Risk')} onClose={onClose}
                   badges={data && (
                     <>
                       <VerdictChip verdict={data.effective.verdict} />
                       <Pill className="bg-slate-100 text-slate-600">{t(LIFECYCLE_LABEL[data.risk.lifecycle])}</Pill>
                       {data.effective.overridden.length > 0 && <Pill className="bg-violet-50 text-violet-700">{t('Overridden')}</Pill>}
                     </>
                   )} />
      {isLoading ? <div className={DRAWER.body}><Skeleton rows={6} /></div>
        : error || !data ? <div className={DRAWER.body}><p className="text-critical-600">{(error as Error)?.message}</p></div>
        : (
          <>
            <PanelTabs tabs={SECTIONS} value={section} onChange={setSection} />
            <div className={DRAWER.body}>
              {task && task.status === 'OPEN' && (
                <section className="rounded-2xl border border-brand-100 bg-brand-50/60 p-3.5">
                  <p className="text-[12px] font-semibold text-brand-700">{t('Why this is in your queue')}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{taskText(task, t)}</p>
                  <TaskActions task={task} className="mt-3" />
                </section>
              )}
              <Standing d={data} />
              {section === 'decide' && <DecideSection d={data} />}
              {section === 'controls' && <ControlsSection d={data} />}
              {section === 'exposures' && <ExposuresSection d={data} />}
              {section === 'history' && <HistorySection d={data} />}
            </div>
          </>
        )}
    </SidePanel>
  );
}

// ------------------------------------------------------------------ where it stands
function Standing({ d }: { d: RiskDetail }) {
  const t = useT();
  const a = d.assessment;
  if (!a) return <p className="text-muted">{t('Not assessed yet.')}</p>;
  const r = a.result;
  const driver = r.exposures.find((e) => e.id === r.driver);
  const mandatory = r.missing.filter((m) => m.mandatory);
  const overrides = d.overrides.filter((o) => o.status === 'ACTIVE');
  return (
    <section className="space-y-3.5 overflow-hidden rounded-2xl border border-line bg-white p-4"
             style={{ boxShadow: `inset 0 3px 0 ${VERDICT_HEX[d.effective.verdict ?? a.verdict]}` }}>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 pt-1 text-[15px] font-semibold leading-snug text-ink">{verdictText(r, a.confidence, t)}</p>
        <ConfidenceRing value={a.confidence} />
      </div>
      <BandBlocks provisional={!!a.provisional} points={[
        { band: a.inherent_band, impact: r.inherent?.impact, likelihood: r.inherent?.likelihood },
        { band: a.residual_band, impact: r.residual?.impact, likelihood: r.residual?.likelihood },
        { band: a.target_band, impact: r.target?.impact, likelihood: r.target?.likelihood },
      ]} />
      {overrides.map((o) => (
        <p key={o.id} className="rounded-xl bg-violet-50 px-3 py-2 text-[12.5px] text-violet-800">
          {t('{field} set to {value} by people; the rules computed {computed}.', {
            field: o.field === 'verdict' ? t('Verdict') : t('Residual'),
            value: o.field === 'verdict' ? t(VERDICT_LABEL[o.override_value as Verdict]) : t(BAND_LABEL[o.override_value]),
            computed: o.field === 'verdict' ? t(VERDICT_LABEL[o.computed_value as Verdict]) : t(BAND_LABEL[o.computed_value]),
          })}
        </p>
      ))}
      {r.inherent && (
        <p className="text-[12.5px] text-muted">
          {t('Impact {i} × likelihood {l} before controls; driven by {dim} impact. Controls: {grade}.', {
            i: r.inherent.impact, l: r.inherent.likelihood,
            dim: t(CATEGORY_LABEL[driver?.impact.driving_dimension ?? '']?.[0] ?? driver?.impact.driving_dimension ?? '').toLowerCase(),
            grade: driver?.controls.grade === 'UNKNOWN' ? t('not known yet')
              : t(GRADE_LABEL[(driver?.controls.grade ?? 'ABSENT') as Grade]?.[0] ?? '').toLowerCase(),
          })}
        </p>
      )}
      {d.driver && (
        <div className="rounded-xl border border-line bg-slate-50/70 px-3 py-2.5 text-[12.5px]">
          <p className="font-semibold text-ink">
            {t('Driven by {clause} of {regulation}', { clause: d.driver.clause || t('a duty'), regulation: d.driver.regulation ?? '' })}
          </p>
          <p className="mt-0.5 text-ink-2">{d.driver.label}</p>
          <p className="mt-1 text-muted">
            {d.driver.penaltyInr ? t('Statutory ceiling: up to {amount}', { amount: inr(d.driver.penaltyInr) }) : t('No penalty clause found in its text')}
            {d.driver.imprisonment && ` · ${t('imprisonment possible')}`}
            {d.driver.consequence.includes('licence_suspension') && ` · ${t('licence can be suspended')}`}
            {d.driver.inheritedFrom && ` · ${t("from the Act it is made under")}`}
          </p>
          {d.driver.regulationId && (
            <Link to={`/regulation/${encodeURIComponent(d.driver.regulationId)}`} className="mt-1 inline-block font-medium text-brand-600 hover:underline">
              {t('Open the regulation')}
            </Link>
          )}
        </div>
      )}
      <details className="group text-[12px]">
        <summary className="cursor-pointer select-none font-medium text-brand-600">{t('How the rules scored it')}</summary>
        <p className="mt-1.5 rounded-xl bg-slate-50 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{r.rationale}</p>
        <p className="mt-1 text-[11px] text-muted">{t('Rulebook {name} {v}', { name: r.rulebook.name, v: r.rulebook.version })} · {r.rulebook.hash.slice(7, 19)}</p>
      </details>
      {mandatory.length > 0 && (
        <div className="rounded-xl bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> {t('Missing before it can be scored')}
          </p>
          <ul className="mt-1 list-disc pl-5 text-[12.5px] text-amber-800">
            {mandatory.map((m) => <li key={m.fact}>{t(FACT_LABEL[m.fact] ?? m.fact)}</li>)}
          </ul>
          {r.bounds.best && r.bounds.worst && (
            <p className="mt-1 text-[12px] text-amber-700">
              {t('Somewhere between {best} and {worst} once they are in.', { best: t(BAND_LABEL[r.bounds.best.band]), worst: t(BAND_LABEL[r.bounds.worst.band]) })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Why the verdict is what it is, in the reader's language (the engine's own sentence is under "How the rules scored it"). */
function verdictText(r: AssessmentResult, confidence: number,
                     t: (s: string, v?: Record<string, string | number>) => string): string {
  const band = r.residual ? t(BAND_LABEL[r.residual.band]) : '';
  const cat = r.appetite ? t(CATEGORY_LABEL[r.appetite.category]?.[0] ?? r.appetite.category).toLowerCase() : '';
  switch (r.verdict_rule) {
    case 'EV-01': return t('A person must first decide whether it applies.');
    case 'EV-02': return t('Inputs are missing, so it is shown at its worst case until they are in.');
    case 'EV-03': return t('There is no approved risk appetite to judge it against yet.');
    case 'EV-04': return t('Residual {band} is above the {cat} tolerance ({tol}).', { band, cat, tol: r.appetite ? t(BAND_LABEL[r.appetite.tolerance]) : '' });
    case 'EV-05': return t('Residual {band} is above the {cat} appetite ({app}).', { band, cat, app: r.appetite ? t(BAND_LABEL[r.appetite.appetite]) : '' });
    case 'EV-06': return t('Confidence {n} is below the threshold leadership set.', { n: confidence });
    default: return t('Residual {band} is within the {cat} appetite ({app}).', { band, cat, app: r.appetite ? t(BAND_LABEL[r.appetite.appetite]) : '' });
  }
}

// ------------------------------------------------------------------ decide: owner, treatment, overrides
function DecideSection({ d }: { d: RiskDetail }) {
  const { data: me } = useMe();
  const isOwner = !!d.risk.owner_user && me?.id === d.risk.owner_user;
  const approver = can(me, 'approve');
  const active = d.treatments.find((x) => x.status === 'ACTIVE');
  const called = ['TREAT', 'ESCALATE'].includes(d.effective.verdict ?? '') || ['TREAT', 'ESCALATE'].includes(d.effective.floor_verdict ?? '');
  return (
    <div className="space-y-5">
      <OwnerRow d={d} canEdit={approver} />
      {active && <ActiveTreatment d={d} />}
      {(isOwner || approver) && d.assessment?.residual_band && <TreatmentForm d={d} replacing={!!active} called={called} />}
      <Overrides d={d} canPropose={approver} />
    </div>
  );
}

function OwnerRow({ d, canEdit }: { d: RiskDetail; canEdit: boolean }) {
  const t = useT();
  const { data: users } = useUsers();
  const setOwner = useSetOwner();
  const [editing, setEditing] = useState(false);
  const [userId, setUserId] = useState(d.risk.owner_user ?? '');
  const [name, setName] = useState(d.risk.owner_name ?? '');
  const list = users?.items ?? [];
  return (
    <section>
      <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Owner')}</h3>
      {!editing ? (
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-muted" />
          <span className={cn('text-[13.5px]', d.risk.owner_name ? 'font-medium text-ink' : 'text-muted')}>
            {d.risk.owner_name ?? t('No owner yet: treatment decisions go to compliance managers')}
          </span>
          {canEdit && <button type="button" className="btn btn-sm ml-auto" onClick={() => setEditing(true)}>{t('Change')}</button>}
        </div>
      ) : (
        <div className="space-y-2">
          {list.length > 0 && (
            <select className="input w-full" value={userId} onChange={(e) => {
              setUserId(e.target.value);
              setName(list.find((u) => u.id === e.target.value)?.name ?? '');
            }}>
              <option value="">{t('Choose a person')}</option>
              {list.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
            </select>
          )}
          <input className="input w-full" placeholder={t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={setOwner.isPending || !name.trim()}
                    onClick={() => setOwner.mutate({ id: d.risk.id, userId: userId || null, name }, { onSuccess: () => setEditing(false) })}>
              {t('Save')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          </div>
          {setOwner.error && <p role="alert" className="text-[12.5px] text-critical-600">{setOwner.error.message}</p>}
        </div>
      )}
    </section>
  );
}

function ActiveTreatment({ d }: { d: RiskDetail }) {
  const t = useT();
  const locale = useDateLocale();
  const x = d.treatments.find((y) => y.status === 'ACTIVE');
  if (!x) return null;
  const date = (s: string) => new Date(s).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <section className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3.5">
      <p className="text-[12px] font-semibold text-emerald-800">{t('Decided: {d}', { d: t(TREATMENT_LABEL[x.decision][0]) })}</p>
      <p className="mt-1 text-[13px] text-ink-2">{x.rationale}</p>
      <p className="mt-1.5 text-[12px] text-muted">
        {x.decider_name}, {x.decider_designation} · {date(x.created_at)}
        {x.accept_until && ` · ${t('Review by {d}', { d: date(x.accept_until) })}`}
        {x.transfer_to && ` · ${x.transfer_to} (${x.instrument})`}
      </p>
      {d.actions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {d.actions.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate text-ink">{a.title}</span>
              {a.due_date && <span className="text-muted">{date(a.due_date)}</span>}
              <Pill className="bg-white text-ink-2">{a.status}</Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TREATMENTS: Treatment[] = ['MITIGATE', 'ACCEPT', 'TRANSFER', 'AVOID', 'ESCALATE'];
const TREATMENT_ICON: Record<Treatment, LucideIcon> = { MITIGATE: Wrench, ACCEPT: Handshake, TRANSFER: ArrowRightLeft, AVOID: Ban, ESCALATE: ChevronsUp };

function TreatmentForm({ d, replacing, called }: { d: RiskDetail; replacing: boolean; called: boolean }) {
  const t = useT();
  const { data: me } = useMe();
  const decide = useDecideTreatment();
  const [open, setOpen] = useState(!replacing && called);
  const [decision, setDecision] = useState<Treatment>('MITIGATE');
  const [rationale, setRationale] = useState('');
  const [name, setName] = useState(me?.name ?? '');
  const [designation, setDesignation] = useState('');
  const [until, setUntil] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [instrument, setInstrument] = useState('');
  const [actions, setActions] = useState([{ title: '', dueDate: '', kind: 'preventive' }]);
  const above = d.effective.verdict === 'ESCALATE' || d.effective.floor_verdict === 'ESCALATE';
  if (!open) {
    return (
      <section>
        <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Treatment')}</h3>
        {!replacing && (
          <p className="mb-2 text-[12.5px] text-muted">
            {d.assessment?.provisional
              ? t('No treatment is called for yet: the score is a worst case until the missing inputs are in. Record the controls first.')
              : t('No treatment is called for: the risk is within appetite.')}
          </p>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          {replacing ? t('Change the treatment decision') : t('Decide a treatment anyway')}
        </button>
      </section>
    );
  }
  const ready = rationale.trim().length >= 10 && name.trim() && designation.trim()
    && (decision !== 'ACCEPT' || until) && (decision !== 'TRANSFER' || (transferTo.trim() && instrument.trim()))
    && (decision !== 'MITIGATE' || actions.some((a) => a.title.trim()));
  const submit = () => decide.mutate({
    id: d.risk.id, decision, rationale, name, designation,
    acceptUntil: decision === 'ACCEPT' ? until : undefined,
    transferTo: decision === 'TRANSFER' ? transferTo : undefined, instrument: decision === 'TRANSFER' ? instrument : undefined,
    actions: decision === 'MITIGATE' ? actions.filter((a) => a.title.trim()) : undefined,
  }, { onSuccess: () => setOpen(false) });

  return (
    <section className="space-y-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Treatment')}</h3>
      <div role="radiogroup" aria-label={t('Treatment')} className="grid gap-2 sm:grid-cols-2">
        {TREATMENTS.map((k) => {
          const Icon = TREATMENT_ICON[k];
          const on = decision === k;
          return (
            <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setDecision(k)}
                    className={cn('flex items-start gap-3 rounded-xl border p-3 text-left transition',
                      on ? 'border-brand-400 bg-brand-50/80 shadow-sm ring-1 ring-brand-300' : 'border-line hover:border-slate-300 hover:bg-slate-50',
                      k === 'ESCALATE' && 'sm:col-span-2')}>
              <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-ink-2')}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold text-ink">{t(TREATMENT_LABEL[k][0])}</span>
                <span className="block text-[12px] leading-snug text-muted">{t(TREATMENT_LABEL[k][1])}</span>
              </span>
            </button>
          );
        })}
      </div>
      {decision === 'ACCEPT' && above && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{t('This risk is above tolerance: only leadership can accept it.')}</p>
      )}
      {decision === 'ACCEPT' && (
        <FieldRow label="Review by" required hint="Within the next 12 months. The risk comes back for a decision on this date.">
          <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
        </FieldRow>
      )}
      {decision === 'TRANSFER' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow label="Transferred to" required><input className="input w-full" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} /></FieldRow>
          <FieldRow label="Policy or contract" required><input className="input w-full" value={instrument} onChange={(e) => setInstrument(e.target.value)} /></FieldRow>
        </div>
      )}
      {decision === 'MITIGATE' && (
        <div className="space-y-2">
          <span className="block text-[12px] font-semibold text-ink-2">{t('Actions')}</span>
          {actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input className="input min-w-0 flex-1" placeholder={t('What will be done')} value={a.title}
                     onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input type="date" className="input w-[150px]" aria-label={t('Due date')} value={a.dueDate}
                     onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
              <select className="input w-[130px]" aria-label={t('Kind')} value={a.kind}
                      onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                <option value="preventive">{t('Preventive')}</option>
                <option value="detective">{t('Detective')}</option>
                <option value="corrective">{t('Corrective')}</option>
              </select>
              {actions.length > 1 && (
                <button type="button" className="btn btn-sm" aria-label={t('Remove')} onClick={() => setActions(actions.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setActions([...actions, { title: '', dueDate: '', kind: 'preventive' }])}>
            <Plus className="h-3.5 w-3.5" /> {t('Add an action')}
          </button>
        </div>
      )}
      <FieldRow label="Rationale" required>
        <textarea className="input min-h-[80px] w-full py-2" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </FieldRow>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldRow label="Decided by" required><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></FieldRow>
        <FieldRow label="Designation" required><input className="input w-full" value={designation} onChange={(e) => setDesignation(e.target.value)} /></FieldRow>
      </div>
      {decide.error && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{decide.error.message}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" disabled={!ready || decide.isPending} onClick={submit}>
          <Check className="h-4 w-4" /> {t('Record the decision')}
        </button>
        {replacing && <button type="button" className="btn" onClick={() => setOpen(false)}>{t('Cancel')}</button>}
      </div>
    </section>
  );
}

const OVERRIDE_STATUS: Record<Override['status'], [string, string]> = {
  PENDING: [tx('Waiting for a second approver'), 'bg-amber-50 text-amber-700'],
  ACTIVE: [tx('In force'), 'bg-violet-50 text-violet-700'],
  STALE: [tx('Stale: the inputs changed'), 'bg-slate-100 text-slate-600'],
  REJECTED: [tx('Rejected'), 'bg-slate-100 text-slate-600'],
  REVOKED: [tx('Revoked'), 'bg-slate-100 text-slate-600'],
};

function Overrides({ d, canPropose }: { d: RiskDetail; canPropose: boolean }) {
  const t = useT();
  const { data: me } = useMe();
  const propose = useProposeOverride();
  const decide = useDecideOverride();
  const revoke = useRevokeOverride();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<'residual_band' | 'verdict'>('residual_band');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const shown = d.overrides.filter((o) => ['PENDING', 'ACTIVE', 'STALE'].includes(o.status));
  const computed = field === 'verdict' ? d.assessment?.verdict : d.assessment?.residual_band;
  const options: string[] = field === 'verdict' ? ['WITHIN_APPETITE', 'TREAT', 'ESCALATE'] : ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const label = (f: string, v: string) => (f === 'verdict' ? t(VERDICT_LABEL[v as Verdict]) : t(BAND_LABEL[v as Band]));
  const err = propose.error ?? decide.error ?? revoke.error;
  return (
    <section className="space-y-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Overrides')}</h3>
      {shown.map((o) => {
        const mineToApprove = o.status === 'PENDING' && canPropose && o.proposed_by_user !== me?.id;
        return (
          <div key={o.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-ink">
                {o.field === 'verdict' ? t('Verdict') : t('Residual')}: {label(o.field, o.computed_value)} → {label(o.field, o.override_value)}
              </span>
              <Pill className={OVERRIDE_STATUS[o.status][1]}>{t(OVERRIDE_STATUS[o.status][0])}</Pill>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-2">{o.reason}</p>
            <p className="mt-0.5 text-[11.5px] text-muted">{o.proposed_by}{o.second_by && ` · ${t('approved by {who}', { who: o.second_by })}`}</p>
            {canPropose && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {mineToApprove && (
                  <>
                    <input className="input h-8 min-w-0 flex-1 text-[12.5px]" placeholder={t('Note (needed to reject)')} value={note} onChange={(e) => setNote(e.target.value)} />
                    <button type="button" className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: o.id, approve: true, note })}>{t('Approve')}</button>
                    <button type="button" className="btn btn-sm" disabled={decide.isPending || !note.trim()} onClick={() => decide.mutate({ id: o.id, approve: false, note })}>{t('Reject')}</button>
                  </>
                )}
                <button type="button" className="btn btn-sm ml-auto" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: o.id })}>{t('Revoke')}</button>
              </div>
            )}
          </div>
        );
      })}
      {canPropose && d.assessment?.residual_band && (!open ? (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{t('Override a computed value')}</button>
      ) : (
        <div className="space-y-2.5 rounded-xl border border-line p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <FieldRow label="Value">
              <select className="input w-full" value={field} onChange={(e) => { setField(e.target.value as typeof field); setValue(''); }}>
                <option value="residual_band">{t('Residual')}</option>
                <option value="verdict">{t('Verdict')}</option>
              </select>
            </FieldRow>
            <FieldRow label="Set to" hint={computed ? t('Computed: {v}', { v: label(field, computed) }) : undefined}>
              <select className="input w-full" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">{t('Choose')}</option>
                {options.filter((o) => o !== computed).map((o) => <option key={o} value={o}>{label(field, o)}</option>)}
              </select>
            </FieldRow>
          </div>
          <FieldRow label="Reason" required hint="A value lower than the computed one is in force only once a second approver agrees.">
            <textarea className="input min-h-[70px] w-full py-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FieldRow>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={!value || reason.trim().length < 10 || propose.isPending}
                    onClick={() => propose.mutate({ id: d.risk.id, field, value, reason }, { onSuccess: () => { setOpen(false); setReason(''); setValue(''); } })}>
              {t('Submit the override')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          </div>
        </div>
      ))}
      {err && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{err.message}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ controls (and G4)
const GRADE_TONE: Record<Grade, string> = {
  TESTED: 'bg-emerald-50 text-emerald-700', DOCUMENTED: 'bg-sky-50 text-sky-700',
  CLAIMED: 'bg-amber-50 text-amber-700', ABSENT: 'bg-red-50 text-red-700',
};

function ControlsSection({ d }: { d: RiskDetail }) {
  const t = useT();
  const rows = useMemo(() => {
    const byKey = new Map(d.controls.ratings.map((r) => [r.control_key, r]));
    const typical = d.controls.typical.map((c) => ({ key: c.key, label: c.text, interval: c.interval_days, rating: byKey.get(c.key) }));
    const own = d.controls.ratings.filter((r) => !d.controls.typical.some((c) => c.key === r.control_key))
      .map((r) => ({ key: r.control_key, label: r.label, interval: r.interval_days, rating: r }));
    return [...typical, ...own];
  }, [d]);
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-muted">
        {t('Until a control is known, the risk cannot be scored: "unknown" is never taken as "absent" or as "working".')}
      </p>
      {rows.map((r) => <ControlCard key={r.key} riskId={d.risk.id} controlKey={r.key} label={r.label} interval={r.interval} rating={r.rating} />)}
      <ControlCard riskId={d.risk.id} label="" interval={null} adding />
    </div>
  );
}

function ControlCard({ riskId, controlKey, label, interval, rating, adding }: {
  riskId: string; controlKey?: string; label: string; interval: number | null; rating?: ControlRating; adding?: boolean;
}) {
  const t = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();
  const record = useRecordControl();
  const validate = useValidateControl();
  const approver = can(me, 'approve');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(label);
  const [grade, setGrade] = useState<Grade>(approver ? 'DOCUMENTED' : 'CLAIMED');
  const [evidence, setEvidence] = useState('');
  const [on, setOn] = useState('');
  const needsEvidence = grade === 'DOCUMENTED' || grade === 'TESTED';
  const validating = rating?.grade === 'CLAIMED' && approver && rating.rated_by_user !== me?.id;
  const grades: Grade[] = approver ? ['TESTED', 'DOCUMENTED', 'CLAIMED', 'ABSENT'] : ['CLAIMED', 'ABSENT'];
  const err = record.error ?? validate.error;
  const save = () => {
    const done = { onSuccess: () => setOpen(false) };
    if (validating && grade !== 'CLAIMED') {
      validate.mutate({ ratingId: rating!.id, grade, evidence: evidence || undefined, evidenceOn: on || undefined }, done);
    } else {
      record.mutate({ id: riskId, control_key: controlKey, label: name, grade, evidence: evidence || undefined,
                      evidence_on: on || undefined, interval_days: interval }, done);
    }
  };
  if (adding && !open) {
    return <button type="button" className="btn btn-sm" onClick={() => { setName(''); setOpen(true); }}><Plus className="h-3.5 w-3.5" /> {t('Add a control')}</button>;
  }
  return (
    <div className="rounded-xl border border-line p-3">
      {!adding && (
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">{label}</p>
            {rating ? (
              <p className="mt-0.5 text-[12px] text-muted">
                {rating.evidence && `${rating.evidence} · `}
                {rating.evidence_on && `${new Date(rating.evidence_on).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })} · `}
                {rating.rated_by}{rating.validated_by && ` · ${t('validated by {who}', { who: rating.validated_by })}`}
                {rating.source === 'workbook' && ` · ${t('from the workbook')}`}
                {/^(control|entity):/.test(rating.source ?? '') && ` · ${t('mapped from a control record')}`}
              </p>
            ) : <p className="mt-0.5 text-[12px] text-amber-700">{t('Not known yet')}</p>}
          </div>
          {rating && <Pill className={GRADE_TONE[rating.grade]}>{t(GRADE_LABEL[rating.grade][0])}</Pill>}
        </div>
      )}
      {!open ? (
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{rating ? t('Update') : t('Record')}</button>
          {validating && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setGrade('TESTED'); setOpen(true); }}>{t('Validate')}</button>}
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {adding && <FieldRow label="Control" required><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></FieldRow>}
          <div role="radiogroup" aria-label={t('Grade')} className="grid gap-1.5 sm:grid-cols-2">
            {grades.map((g) => (
              <button key={g} type="button" role="radio" aria-checked={grade === g} onClick={() => setGrade(g)}
                      className={cn('rounded-xl border px-2.5 py-1.5 text-left', grade === g ? 'border-brand-300 bg-brand-50/70' : 'border-line hover:bg-slate-50')}>
                <span className="block text-[12.5px] font-semibold text-ink">{t(GRADE_LABEL[g][0])}</span>
                <span className="block text-[11.5px] leading-snug text-muted">{t(GRADE_LABEL[g][1])}</span>
              </button>
            ))}
          </div>
          {needsEvidence && (
            <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
              <FieldRow label="Evidence" required><input className="input w-full" placeholder={t('Report, document or link')} value={evidence} onChange={(e) => setEvidence(e.target.value)} /></FieldRow>
              <FieldRow label={grade === 'TESTED' ? 'Tested on' : 'Reviewed on'} required><input type="date" className="input w-full" value={on} onChange={(e) => setOn(e.target.value)} /></FieldRow>
            </div>
          )}
          {!approver && <p className="text-[12px] text-muted">{t('A compliance manager grades a control documented or tested, with evidence.')}</p>}
          {err && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{err.message}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={record.isPending || validate.isPending || !name.trim() || (needsEvidence && (!evidence.trim() || !on))} onClick={save}>{t('Save')}</button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}><X className="h-3.5 w-3.5" /> {t('Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ what it covers (and G3)
function ExposuresSection({ d }: { d: RiskDetail }) {
  const t = useT();
  const { data: me } = useMe();
  const decide = useDecideExposure();
  const [reason, setReason] = useState<Record<string, string>>({});
  const shown = d.exposures.filter((x) => x.active);
  const c = d.exposureCounts;
  const duties = shown.some((x) => x.kind === 'obligation');
  return (
    <div className="space-y-2">
      <p className="text-[12.5px] text-muted">
        {duties
          ? t('Every duty that applies to the company under this theme. Each is scored from its penalty, regulator and controls; the worst one drives the risk.')
          : t('Where this risk sits: the organisation, a site, a vendor, a system. Each is scored; the worst one drives the risk.')}
      </p>
      {duties && (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-[12.5px] text-ink-2">
          {t('{n} duties from {m} regulations.', { n: c.total.toLocaleString(), m: c.regulations.toLocaleString() })}
          {c.pending === 1 && ` ${t('1 duty waits on its applicability, decided on the Requirements page.')}`}
          {c.pending > 1 && ` ${t('{n} wait on their applicability, decided on the Requirements page.', { n: c.pending.toLocaleString() })}`}
          {c.total > c.shown && ` ${t('Showing the first {n}.', { n: c.shown })}`}
        </p>
      )}
      {shown.map((x) => {
        const state = x.decided_applicability ?? x.engine_applicability;
        const open = !x.decided_applicability && x.engine_applicability === 'REVIEW_REQUIRED';
        const duty = x.kind === 'obligation';
        return (
          <div key={x.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              {duty && x.regulation_id ? (
                <Link to={`/regulation/${encodeURIComponent(x.regulation_id)}`} className="min-w-0 flex-1 text-[13px] font-medium text-ink hover:text-brand-600 hover:underline">{x.label}</Link>
              ) : <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">{x.label}</span>}
              <Pill className={state === 'APPLICABLE' ? 'bg-emerald-50 text-emerald-700' : state === 'NOT_APPLICABLE' ? 'bg-slate-100 text-slate-600' : 'bg-sky-50 text-sky-700'}>
                {state === 'APPLICABLE' ? t('Applies') : state === 'NOT_APPLICABLE' ? t("Doesn't apply") : t('Undecided')}
              </Pill>
            </div>
            {x.decided_applicability && (
              <p className="mt-1 text-[12px] text-muted">{t('Decided by {who}: {why}', { who: x.decided_by ?? '', why: x.decision_reason ?? '' })}</p>
            )}
            {open && x.missing.length > 0 && (
              <p className="mt-1 text-[12px] text-sky-800">{t('Unknown: {facts}', { facts: x.missing.map((f) => t(FACT_LABEL[f] ?? f)).join(', ') })}</p>
            )}
            {open && can(me, 'approve') && !duty && (
              <div className="mt-2 flex flex-wrap gap-2">
                <input className="input h-8 min-w-0 flex-1 text-[12.5px]" placeholder={t('Reason')} value={reason[x.id] ?? ''}
                       onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} />
                <button type="button" className="btn btn-sm btn-primary" disabled={decide.isPending || (reason[x.id] ?? '').trim().length < 3}
                        onClick={() => decide.mutate({ id: x.id, decision: 'APPLICABLE', reason: reason[x.id] })}>{t('Applies')}</button>
                <button type="button" className="btn btn-sm" disabled={decide.isPending || (reason[x.id] ?? '').trim().length < 3}
                        onClick={() => decide.mutate({ id: x.id, decision: 'NOT_APPLICABLE', reason: reason[x.id] })}>{t("Doesn't apply")}</button>
              </div>
            )}
          </div>
        );
      })}
      {decide.error && <p role="alert" className="text-[12.5px] text-critical-600">{decide.error.message}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ history
function HistorySection({ d }: { d: RiskDetail }) {
  const t = useT();
  const locale = useDateLocale();
  const when = (s: string) => new Date(s).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Assessments')}</h3>
        <ol className="space-y-1.5">
          {d.history.map((h) => (
            <li key={h.seq} className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="w-8 font-semibold tabular-nums text-ink">v{h.seq}</span>
              <VerdictChip verdict={h.verdict} />
              <span className="text-muted">{when(h.recorded_at)}</span>
              {h.diff && <span className="w-full pl-10 text-[12px] text-muted">{Object.entries(h.diff).map(([k, [a, b]]) => `${k}: ${a ?? '—'} → ${b ?? '—'}`).join(' · ')}</span>}
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('What happened')}</h3>
        <ol className="space-y-2 border-l border-line pl-4">
          {d.events.map((e) => (
            <li key={e.id} className="text-[12.5px]">
              <p className="font-medium text-ink">{e.kind}</p>
              {e.detail && <p className="text-ink-2">{e.detail}</p>}
              <p className="text-[11.5px] text-muted">{e.actor} · {when(e.at)}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
