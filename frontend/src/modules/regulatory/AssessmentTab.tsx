// ============================================================
// Assessment / Compliance — the last two links of the chain.
//
// An assessment here is a RULE-derived observation written UNREVIEWED, not a
// compliance decision. PASSED is unreachable unless the evidence behind the
// control carries a validity period, so a control proved only by undated
// evidence reads INSUFFICIENT_EVIDENCE — which is the honest answer.
// ============================================================
import { MetricCard, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Donut, Progress, StackedBar } from '@/components/ui/charts';
import { cn, readable, toneClass, type Tone } from '@/utils/ui';
import { useRegulationCompliance, type RegulationCompliance } from '@/services/complianceApi';
import { complianceUi } from './regShared';
import { tx, useT, type TFunction } from '@/i18n';

const RESULT_TONE: Record<string, Tone> = {
  PASSED: 'green', FAILED: 'red', INSUFFICIENT_EVIDENCE: 'amber', NO_EVIDENCE: 'amber', NOT_ASSESSED: 'gray',
  COMPLIANT: 'green', NON_COMPLIANT: 'red', APPLICABLE: 'green', CONDITIONAL: 'amber', REVIEW_REQUIRED: 'amber',
  NOT_APPLICABLE: 'gray', UNREVIEWED: 'gray',
};
const RESULT_HEX: Record<Tone, string> = {
  green: '#16a34a', red: '#dc2626', amber: '#f59e0b', gray: '#94a3b8', orange: '#f97316', blue: '#2563eb', purple: '#8b5cf6', teal: '#14b8a6',
};
const Pill = ({ v }: { v: string }) => {
  const t = useT();
  return <span className={cn('pill', toneClass(RESULT_TONE[v] ?? 'gray'))}>{v ? t(readable(v)) : '—'}</span>;
};
const toSlices = (data: Record<string, number>, hex: (k: string) => string, t: TFunction) =>
  Object.entries(data ?? {}).map(([k, v]) => ({ label: t(readable(k)), value: v, color: hex(k) }));

/**
 * The regulation's requirement-level compliance as charts: status donut,
 * chain coverage bars and the rule engine's result mix. Used beside the
 * Requirements table and at the top of the assessment view.
 */
export function ComplianceCharts({ data, compact }: { data: RegulationCompliance; compact?: boolean }) {
  const t = useT();
  const s = data.summary;
  // the same words as every other status on the page ("Documented", not "Compliant")
  const status = Object.entries(data.byComplianceStatus ?? {})
    .map(([k, v]) => ({ label: t(complianceUi(k).label), value: v, color: complianceUi(k).hex }));
  return (
    <div className={cn(compact ? 'space-y-6' : 'grid gap-4 md:grid-cols-3')}>
      <div className={cn(!compact && 'card p-5')}>
        <h3 className="text-[15px] font-semibold text-ink">{t('Compliance status')}</h3>
        <p className="mt-0.5 text-xs text-muted">{t("Set by a person's review, never by the rule engine.")}</p>
        {status.length
          ? <Donut className="mt-4" size={compact ? 124 : 160} thickness={20} data={status} sub={t('requirements')} />
          : <p className="mt-3 text-[13px] text-muted">{t('Nothing recorded yet.')}</p>}
      </div>
      <div className={cn(!compact && 'card p-5')}>
        <h4 className={cn('font-semibold text-ink', compact ? 'text-[13px]' : 'text-[15px]')}>{t('Chain coverage')}</h4>
        <ul className="mt-3 space-y-3 text-[13px]">
          {([[tx('With applicability'), s.withApplicability, '#2563eb'], [tx('With a control'), s.withControl, '#16a34a'],
             [tx('With evidence'), s.withEvidence, '#14b8a6'], [tx('Assessed'), s.assessed, '#8b5cf6']] as const).map(([l, n, c]) => (
            <li key={l}>
              <div className="mb-1 flex justify-between text-ink-2"><span>{t(l)}</span><span className="tabular-nums text-muted">{n.toLocaleString()} / {s.requirements.toLocaleString()}</span></div>
              <Progress value={n} total={s.requirements} color={c} />
            </li>
          ))}
        </ul>
      </div>
      <div className={cn(!compact && 'card p-5')}>
        <h4 className={cn('font-semibold text-ink', compact ? 'text-[13px]' : 'text-[15px]')}>{t('Assessment result')}</h4>
        <p className="mt-0.5 text-xs text-muted">{t('Passed requires evidence with a validity period.')}</p>
        {Object.keys(data.byResult ?? {}).length
          ? <StackedBar className="mt-3" data={toSlices(data.byResult, (k) => RESULT_HEX[RESULT_TONE[k] ?? 'gray'], t)} />
          : <p className="mt-3 text-[13px] text-muted">{t('Nothing assessed yet.')}</p>}
      </div>
    </div>
  );
}

/**
 * How far the chain runs for this regulation: of its requirements, how many
 * have an applicability verdict, a control, evidence, an assessment. The one
 * view on the page no other card repeats — where the chain stops is the work.
 */
export function ChainCoverage({ data }: { data: RegulationCompliance }) {
  const t = useT();
  const s = data.summary;
  const rows = [
    [tx('With applicability'), s.withApplicability, '#0a84ff'],
    [tx('With a control'), s.withControl, '#34c759'],
    [tx('With evidence'), s.withEvidence, '#30b0c7'],
    [tx('Assessed'), s.assessed, '#bf5af2'],
  ] as const;
  const weakest = [...rows].sort((a, b) => a[1] - b[1])[0];
  // A step every requirement already reaches (100%) carries no news: only the steps still short are drawn.
  const short = rows.filter((r) => r[1] < s.requirements);
  const shown = short.length ? short : rows;
  return (
    <div className="card p-5">
      <h3 className="text-[15px] font-semibold text-ink">{t('Chain coverage')}</h3>
      <p className="mt-0.5 text-xs text-muted">
        {t('Of {n} requirements, how far each reaches. The chain stops at: {step}.', { n: s.requirements.toLocaleString(), step: t(weakest[0]).toLowerCase() })}
      </p>
      <ul className="pm-stagger mt-4 space-y-3.5 text-[13px]">
        {shown.map(([l, n, c], i) => {
          const pct = s.requirements ? Math.round((n / s.requirements) * 100) : 0;
          return (
            <li key={l}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className={cn('text-ink-2', l === weakest[0] && 'font-semibold text-ink')}>{t(l)}</span>
                <span className="tabular-nums text-muted"><b className="font-semibold text-ink">{pct}%</b> · {n.toLocaleString()} / {s.requirements.toLocaleString()}</span>
              </div>
              <span className="block h-2 overflow-hidden rounded-full bg-black/[0.06]">
                <span className="pm-grow block h-full rounded-full" style={{ width: `${Math.max(pct ? 2 : 0, pct)}%`, background: c, animationDelay: `${0.1 + i * 0.08}s` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AssessmentTab({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading, error } = useRegulationCompliance(id);

  if (isLoading) return <div className="card"><Skeleton rows={6} /></div>;
  if (error) return <div className="card py-10 text-center text-[13px] text-critical-600">{(error as Error).message}</div>;
  if (!data) return null;

  const s = data.summary;
  const pct = (n: number) => (s.requirements ? Math.round((n / s.requirements) * 100) : 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label={t('Requirements')} value={s.requirements.toLocaleString()} tone="brand" icon="ClipboardList" />
        <MetricCard label={t('With applicability')} value={s.withApplicability.toLocaleString()} tone="green" icon="Target" pct={pct(s.withApplicability)} />
        <MetricCard label={t('With a control')} value={s.withControl.toLocaleString()} tone={s.withControl ? 'green' : 'amber'} icon="ShieldCheck" pct={pct(s.withControl)} />
        <MetricCard label={t('With evidence')} value={s.withEvidence.toLocaleString()} tone={s.withEvidence ? 'green' : 'amber'} icon="Paperclip" pct={pct(s.withEvidence)} />
        <MetricCard label={t('Assessed')} value={s.assessed.toLocaleString()} tone={s.assessed ? 'green' : 'amber'} icon="ClipboardCheck" pct={pct(s.assessed)} />
        <MetricCard label={t('Not assessed')} value={s.notAssessed.toLocaleString()} tone="amber" icon="MinusCircle" pct={pct(s.notAssessed)} />
      </div>

      <ComplianceCharts data={data} />

      {data.assessments.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('Nothing has been assessed for this regulation')}
            hint={t('An assessment needs a requirement, an applicable company instance, a mapped control and evidence. Whichever of those is missing is shown on the Requirements and Evidence tabs.')} />
        </div>
      ) : (
        <div className="card divide-y divide-line">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <span className="text-[13.5px] font-semibold text-ink">{t('Assessments')}</span>
            <span className="pill bg-slate-100 text-slate-600">{t('{n} shown', { n: data.assessments.length.toLocaleString() })}</span>
            <span className="text-xs text-muted">{t('Worst results first')}</span>
          </div>
          {data.assessments.map((a) => (
            <div key={a.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill v={a.result} />
                <span className="pill bg-slate-100 text-slate-600">{a.method ? readable(String(a.method)) : '—'}</span>
                <Pill v={a.review_status} />
                <span className="max-w-[16rem] truncate text-[11px] text-muted" title={a.requirement_id}>{a.requirement_id}</span>
                {a.source_clause && <span className="text-xs text-muted">{t('Clause {clause}', { clause: a.source_clause })}</span>}
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-2">{a.statement}</p>
              <div className="mt-1 text-xs text-muted">
                {t('Control {name}', { name: a.control_name ?? a.control_id ?? t('— none mapped') })} ·{' '}
                {a.evidence_count === 1 ? t('1 evidence record') : t('{n} evidence records', { n: a.evidence_count.toLocaleString() })} ·{' '}
                {a.assessed_by
                  ? t('Assessed {date} by {name}', { date: a.assessed_at?.slice(0, 10) ?? '—', name: a.assessed_by })
                  : t('Assessed {date} by the rule engine', { date: a.assessed_at?.slice(0, 10) ?? '—' })}
              </div>
              <p className="mt-1 text-xs text-muted">{a.rationale}</p>
            </div>
          ))}
        </div>
      )}

      <p className="px-1 text-xs leading-relaxed text-muted">{data.note}</p>
    </div>
  );
}
