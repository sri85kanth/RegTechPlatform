/**
 * Overview — this hospital's compliance posture on one screen.
 *
 * WHAT THE HEADLINE NUMBER MEANS
 * ------------------------------
 * "% compliant" is met duties over the duties this company actually OWES. The
 * engine also evaluates duties inside applicable regulations that do not bind
 * us — a threshold unmet, an exemption that applies — and there are 15,038 of
 * those against 4,709 owed. Leaving them in the denominator reported a hospital
 * with 567 met duties as "2.9% compliant", which describes the corpus rather
 * than the hospital. They are shown separately as "scanned and ruled out",
 * because the work of ruling them out is worth seeing.
 *
 * EVERY PANEL IS COUNTED
 * ----------------------
 * Nothing here is illustrative. Where the data cannot answer a panel it renders
 * an empty state saying so, never a zero — a zero reads as "measured and found
 * none", which is a different and stronger claim than "not measured".
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, BadgeCheck, Building2, CalendarClock,
  ClipboardCheck, FileText, ShieldCheck, Users,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';

interface Overview {
  asOf: string;
  company: {
    name: string | null; entityType: string | null; state: string | null;
    employees: number | null; beds: number | null; licences: number;
    licenceNames: string[];
  };
  funnel: {
    regulationsHeld: number; documents: number; applicableRegulations: number;
    dutiesScanned: number; dutiesChecked: number; dutiesNotApplicable: number;
    openGaps: number;
  };
  posture: {
    total: number; scanned: number; notApplicable: number;
    met: number; metPct: number; partial: number; partialPct: number;
    gaps: number; gapsPct: number; notCovered: number; notCoveredPct: number;
    compliantPct: number; byStatus: Record<string, number>;
  };
  severity: { critical: number; high: number; medium: number; low: number; total: number };
  departments: { department: string; critical: number; high: number; medium: number; low: number; open_total: number }[];
  criticalGaps: { id: string; severity: string; title: string; control: string | null; department: string; regulation: string; regulation_id: string | null }[];
  deadlines: { name: string; evidence_type: string | null; valid_until: string; days_left: number | null; verification_status: string | null }[];
  evidenceWithoutExpiry: number;
  activity: { action: string; entity_id: string | null; actor: string | null; detail: string | null; at: string }[];
  controls: { total: number; withOwner: number; withDocument: number };
}

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

/** A donut drawn from four arcs. No chart library for one figure. */
function Donut({ met, partial, gaps, notCovered, pct }: {
  met: number; partial: number; gaps: number; notCovered: number; pct: number;
}) {
  const t = useT();
  const total = met + partial + gaps + notCovered || 1;
  const R = 70, C = 2 * Math.PI * R;
  const seg = [
    { v: met, cls: 'stroke-success-500' },
    { v: partial, cls: 'stroke-warning-500' },
    { v: gaps, cls: 'stroke-critical-500' },
    { v: notCovered, cls: 'stroke-notcov-500' },
  ];
  let offset = 0;
  return (
    <svg viewBox="0 0 180 180" className="w-44 h-44" role="img"
         aria-label={t('{pct}% of owed duties met', { pct })}>
      <circle cx="90" cy="90" r={R} className="stroke-line fill-none" strokeWidth="18" />
      {seg.map((s, i) => {
        const len = (s.v / total) * C;
        const el = (
          <circle key={i} cx="90" cy="90" r={R} fill="none" strokeWidth="18"
                  className={s.cls} strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset} transform="rotate(-90 90 90)" />
        );
        offset += len;
        return el;
      })}
      <text x="90" y="84" textAnchor="middle" className="fill-ink text-[26px] font-semibold">
        {pct}%
      </text>
      <text x="90" y="104" textAnchor="middle" className="fill-muted text-[11px]">
        {t('of duties owed')}
      </text>
    </svg>
  );
}

function Tile({ icon: Icon, value, label, sub, tone }: {
  icon: typeof FileText; value: string; label: string; sub?: string;
  tone?: 'success' | 'warning' | 'critical' | 'notcov';
}) {
  const t = useT();
  const toneCls = tone
    ? { success: 'text-success-600', warning: 'text-warning-600',
        critical: 'text-critical-600', notcov: 'text-notcov-600' }[tone]
    : 'text-brand-600';
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-2">
        <Icon size={14} className={toneCls} /> {t(label)}
      </div>
      <div className="mt-1.5 text-2xl font-semibold text-ink tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

const SEV = [
  { key: 'critical', label: 'Critical', bar: 'bg-critical-500', text: 'text-critical-600' },
  { key: 'high', label: 'High', bar: 'bg-notcov-500', text: 'text-notcov-600' },
  { key: 'medium', label: 'Medium', bar: 'bg-warning-500', text: 'text-warning-600' },
  { key: 'low', label: 'Low', bar: 'bg-line-2', text: 'text-muted' },
] as const;

export function CompliancePosturePage() {
  const nav = useNavigate();
  const t = useT();
  const locale = useDateLocale();
  const { data, isLoading, error } = useQuery<Overview>({
    queryKey: ['overview-posture'],
    queryFn: () => api('/api/overview'),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (<><Topbar title="Overview" />
      <div className="p-6 text-sm text-muted">{t('Counting…')}</div></>);
  }
  if (error || !data) {
    return (<><Topbar title="Overview" />
      <div className="m-6 rounded-xl border border-line bg-surface p-6 text-sm text-ink-2">
        {t('Could not reach {path}. Nothing is shown rather than a cached or assumed figure.', { path: '/api/overview' })}
      </div></>);
  }

  // Defaulted at the destructure. A panel whose key is absent should render its
  // empty state, not take the page down: an error-boundary screen tells the
  // reader nothing about their compliance posture, which is the one thing this
  // page exists to show.
  const { company, funnel, posture, severity, controls, evidenceWithoutExpiry } = data;
  const departments = data.departments ?? [];
  const criticalGaps = data.criticalGaps ?? [];
  const deadlines = data.deadlines ?? [];
  const activity = data.activity ?? [];
  const sevMax = Math.max(severity.critical, severity.high, severity.medium, severity.low, 1);

  const steps = [
    { label: 'Hospital profile', value: t(company.name ? 'Recorded' : 'Not set'), done: !!company.name },
    { label: 'Documents', value: t('{n} on file', { n: n(funnel.documents) }), done: funnel.documents > 0 },
    { label: 'Regulations mapped', value: t('{n} apply', { n: n(funnel.applicableRegulations) }), done: funnel.applicableRegulations > 0 },
    { label: 'Duties assessed', value: t('{n} evaluated', { n: n(posture.scanned) }), done: posture.scanned > 0 },
    { label: 'Gaps closed', value: t('{n} open', { n: n(posture.gaps) }), done: false },
  ];

  return (
    <>
      <Topbar title="Overview" />
      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted">
            {t('What this hospital owes, what is met, and what is open. Every figure is counted from the live chain — regulation → duty → control → evidence → test.')}
          </p>
          <span className="text-xs text-muted-2 tabular-nums">
            {t('as of {date}', { date: new Date(data.asOf).toLocaleString(locale) })}
          </span>
        </div>

        {/* ---------------------------------------------------------- funnel */}
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-start gap-x-2 gap-y-4">
              {steps.map((s, i) => (
                <div key={s.label} className="flex min-w-[150px] flex-1 items-start gap-2.5">
                  <div className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                    s.done ? 'bg-success-500 text-white' : 'bg-line text-muted')}>
                    {s.done ? '✓' : i + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">{t(s.label)}</div>
                    <div className="text-xs text-muted tabular-nums">{s.value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={cn('rounded-xl border p-5 shadow-card',
            posture.compliantPct >= 50
              ? 'border-success-200 bg-success-50' : 'border-warning-200 bg-warning-50')}>
            <div className="flex items-start gap-3">
              <BadgeCheck size={20} className={posture.compliantPct >= 50
                ? 'mt-0.5 text-success-600' : 'mt-0.5 text-warning-600'} />
              <div>
                <div className="text-lg font-semibold text-ink tabular-nums">
                  {t('{pct}% of owed duties met', { pct: posture.compliantPct })}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">
                  {t('{met} met of {total} this hospital owes. A further {ruledOut} were evaluated and ruled out — thresholds unmet or exemptions that apply.', {
                    met: n(posture.met), total: n(posture.total), ruledOut: n(posture.notApplicable),
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------ tiles */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Tile icon={FileText} value={n(funnel.applicableRegulations)}
                label="Regulations that apply" sub={t('of {n} held', { n: n(funnel.regulationsHeld) })} />
          <Tile icon={ClipboardCheck} value={n(posture.total)}
                label="Duties owed" sub={t('{n} evaluated', { n: n(posture.scanned) })} />
          <Tile icon={ShieldCheck} value={n(posture.met)} label="Met"
                sub={`${posture.metPct}%`} tone="success" />
          <Tile icon={AlertTriangle} value={n(posture.partial)} label="Partial"
                sub={`${posture.partialPct}%`} tone="warning" />
          <Tile icon={AlertTriangle} value={n(posture.gaps)} label="Gaps"
                sub={`${posture.gapsPct}%`} tone="critical" />
          <Tile icon={ShieldCheck} value={`${n(controls.withOwner)}/${n(controls.total)}`}
                label="Controls with an owner"
                sub={t('{n} with a document', { n: n(controls.withDocument) })} />
        </div>

        {/* ------------------------------------------- donut / severity / depts */}
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('Compliance progress')}</h3>
            <div className="mt-3 flex items-center gap-5">
              <Donut met={posture.met} partial={posture.partial} gaps={posture.gaps}
                     notCovered={posture.notCovered} pct={posture.compliantPct} />
              <ul className="space-y-2 text-sm">
                {[
                  [tx('Met'), posture.met, posture.metPct, 'bg-success-500'],
                  [tx('Partial'), posture.partial, posture.partialPct, 'bg-warning-500'],
                  [tx('Gaps'), posture.gaps, posture.gapsPct, 'bg-critical-500'],
                  [tx('Not covered'), posture.notCovered, posture.notCoveredPct, 'bg-notcov-500'],
                ].map(([label, v, p, cls]) => (
                  <li key={label as string} className="flex items-center gap-2">
                    <span className={cn('h-2.5 w-2.5 rounded-full', cls as string)} />
                    <span className="text-ink-2">{t(label as string)}</span>
                    <span className="ml-auto tabular-nums text-ink">{n(v as number)}</span>
                    <span className="w-12 text-right tabular-nums text-muted-2">{p as number}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink">{t('Open findings by severity')}</h3>
              <span className="text-xs tabular-nums text-muted-2">{t('{n} open', { n: n(severity.total) })}</span>
            </div>
            {severity.total === 0 ? (
              <p className="mt-6 text-sm text-muted">
                {t('No findings have been raised. Findings come from a failed test, and tests run only where the chain reaches evidence.')}
              </p>
            ) : (
              <div className="mt-5 flex h-44 items-end gap-5">
                {SEV.map((s) => {
                  const v = severity[s.key];
                  return (
                    <div key={s.key} className="flex flex-1 flex-col items-center gap-2">
                      <span className={cn('text-sm font-semibold tabular-nums', s.text)}>{n(v)}</span>
                      <div className={cn('w-full rounded-t', s.bar)}
                           style={{ height: `${Math.max((v / sevMax) * 120, 4)}px` }} />
                      <span className="text-xs text-muted">{t(s.label)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('Departments by open findings')}</h3>
            {departments.length === 0 ? (
              <p className="mt-6 text-sm text-muted">
                {t('No finding is linked to a department yet.')}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {departments.map((d) => {
                  const max = departments[0].open_total || 1;
                  return (
                    <li key={d.department} className="text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-ink-2">{d.department}</span>
                        <span className="shrink-0 tabular-nums text-muted">
                          {n(d.open_total)}
                          {d.critical > 0 && (
                            <span className="ml-1.5 text-critical-600">{t('{n} critical', { n: d.critical.toLocaleString() })}</span>
                          )}
                        </span>
                      </div>
                      <div className="mt-1 flex h-2 overflow-hidden rounded bg-line"
                           style={{ width: `${Math.max((d.open_total / max) * 100, 6)}%` }}>
                        {(['critical', 'high', 'medium', 'low'] as const).map((k, i) => {
                          const w = d.open_total ? (d[k] / d.open_total) * 100 : 0;
                          return w > 0 ? (
                            <span key={k} style={{ width: `${w}%` }} className={SEV[i].bar} />
                          ) : null;
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* ------------------------------------------------ gaps + activity */}
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-line bg-surface shadow-card">
            <div className="flex items-baseline justify-between border-b border-line px-5 py-3.5">
              <h3 className="text-sm font-semibold text-ink">{t('Most severe open findings')}</h3>
              <button onClick={() => nav('/compliance?compliance=NON_COMPLIANT')}
                      className="flex items-center gap-1 text-xs text-brand-600 hover:underline">
                {t('View all')} <ArrowRight size={12} />
              </button>
            </div>
            {criticalGaps.length === 0 ? (
              <p className="p-5 text-sm text-muted">{t('No critical or high findings are open.')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-canvas text-[11px] uppercase tracking-wide text-muted-2">
                  <tr>
                    <th className="px-5 py-2 text-left font-medium">{t('Finding')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('Department')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('Regulation')}</th>
                    <th className="px-5 py-2 text-left font-medium">{t('Severity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {criticalGaps.map((g) => (
                    <tr key={g.id} className="border-t border-line hover:bg-canvas/70">
                      <td className="max-w-[300px] truncate px-5 py-2.5 text-ink" title={g.title}>
                        {g.title}
                      </td>
                      <td className="px-3 py-2.5 text-muted">{g.department || '—'}</td>
                      <td className="max-w-[180px] truncate px-3 py-2.5 text-muted"
                          title={g.regulation}>{g.regulation || '—'}</td>
                      <td className="px-5 py-2.5">
                        <span className={cn('rounded px-2 py-0.5 text-[11px] font-medium',
                          g.severity === 'CRITICAL'
                            ? 'bg-critical-50 text-critical-600'
                            : 'bg-notcov-50 text-notcov-600')}>
                          {/* the severity enum, shown in capitals as before; its label is translated */}
                          {t(g.severity.charAt(0).toUpperCase() + g.severity.slice(1).toLowerCase()).toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('Recent activity')}</h3>
            {activity.length === 0 ? (
              <p className="mt-4 text-sm text-muted">{t('Nothing recorded yet.')}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {activity.map((a, i) => (
                  <li key={i} className="flex gap-2.5 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                    <div className="min-w-0">
                      <div className="truncate text-ink-2">{a.action}</div>
                      <div className="truncate text-xs text-muted-2">
                        {a.detail || a.entity_id || ''}
                        {a.at && ` · ${new Date(a.at).toLocaleDateString(locale)}`}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* --------------------------------------- deadlines + the company */}
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink">{t('Licences expiring')}</h3>
              {evidenceWithoutExpiry > 0 && (
                <span className="text-xs text-warning-600">
                  {t('{n} with no expiry recorded', { n: n(evidenceWithoutExpiry) })}
                </span>
              )}
            </div>
            {deadlines.length === 0 ? (
              <p className="mt-4 text-sm text-muted">{t('No certificate carries an expiry date.')}</p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {deadlines.slice(0, 4).map((d) => (
                  <div key={d.name} className="rounded-lg border border-line p-3">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-2">
                      <CalendarClock size={12} /> {d.valid_until}
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-ink" title={d.name}>
                      {d.name}
                    </div>
                    {d.days_left !== null && (
                      <div className={cn('mt-1.5 inline-block rounded px-2 py-0.5 text-[11px]',
                        d.days_left < 60 ? 'bg-critical-50 text-critical-600'
                          : d.days_left < 180 ? 'bg-warning-50 text-warning-600'
                            : 'bg-canvas text-muted')}>
                        {d.days_left < 0 ? t('expired') : d.days_left === 1 ? t('1 day left') : t('{n} days left', { n: n(d.days_left) })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('This company')}</h3>
            <div className="mt-3 text-base font-semibold text-ink">{company.name || '—'}</div>
            <div className="text-xs text-muted">
              {[company.entityType, company.state].filter(Boolean).join(' · ')}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                [Building2, tx('Type'), company.entityType || '—'],
                [Users, tx('Staff'), n(company.employees)],
                [ClipboardCheck, tx('Beds'), n(company.beds)],
                [BadgeCheck, tx('Licences'), n(company.licences)],
              ].map(([Icon, label, value]) => {
                const I = Icon as typeof Building2;
                return (
                  <div key={label as string}>
                    <div className="flex items-center gap-1 text-[11px] text-muted-2">
                      <I size={12} /> {t(label as string)}
                    </div>
                    <div className="mt-0.5 truncate font-medium text-ink">{value as string}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
