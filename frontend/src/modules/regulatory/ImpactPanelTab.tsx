/**
 * Impact — how hard this regulation lands on this company.
 *
 * NO SCORE WITHOUT ITS INPUTS
 * ---------------------------
 * The score renders beside the factors that produced it and the formula that
 * combined them. A number on its own is something nobody can argue with, which
 * is the opposite of what a compliance officer needs when they disagree with it.
 *
 * THE FIVE DIMENSIONS IN THE MOCKUP DO NOT EXIST
 * ----------------------------------------------
 * The design showed Patient Safety / Clinical Care / Facility / HR / Management
 * scored out of 10. This system has no such model and inventing one would mean
 * five plausible numbers backed by nothing. What it does have is a real risk
 * calculation — gross exposure, severity, likelihood, deadline pressure,
 * mitigation coverage, giving an inherent and a residual score — so that is what
 * is shown, under its own name.
 */
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDown, Building2, FileText, Gauge, Layers, ShieldCheck, Users,
} from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

const SEV_CLS: Record<string, string> = {
  CRITICAL: 'bg-critical-50 text-critical-600',
  HIGH: 'bg-notcov-50 text-notcov-600',
  MEDIUM: 'bg-warning-50 text-warning-600',
  LOW: 'bg-canvas text-muted',
};
const sevCls = (s?: string | null) => SEV_CLS[String(s || '').toUpperCase()] || SEV_CLS.LOW;

function Card({ title, right, children, className }: {
  title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  const t = useT();
  return (
    <section className={cn('rounded-xl border border-line bg-surface shadow-card', className)}>
      {title && (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold text-ink">{t(title)}</h3>
          {right}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const DOMAIN_ICON: Record<string, typeof FileText> = {
  policies: FileText, processes: Layers, people: Users, systems: Gauge,
  data: Layers, controls: ShieldCheck, risks: AlertTriangle,
};

export function ImpactPanelTab({ id }: { id: string }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ['reg-impact-panel', id],
    queryFn: () => api(`/api/regulation/${id}/impact`),
    staleTime: 60_000,
  });
  const t = useT();

  if (isLoading) return <p className="p-5 text-sm text-muted">{t('Counting…')}</p>;
  if (!data) return <p className="p-5 text-sm text-muted">{t('No impact data.')}</p>;

  if (!data.hasScore) {
    return (
      <Card>
        <p className="text-sm text-muted">
          {t('The impact engine has not scored this regulation. Nothing is estimated in its place — a score here would be a guess wearing a number.')}
        </p>
      </Card>
    );
  }

  const level = String(data.level || '').toLowerCase();
  const ring = level.includes('high') ? 'stroke-critical-500'
    : level.includes('medium') ? 'stroke-warning-500'
      : level.includes('low') ? 'stroke-success-500' : 'stroke-line-2';
  const pct = Math.max(0, Math.min(100, Number(data.score) || 0));
  const R = 62, C = 2 * Math.PI * R;

  const cascade = [
    { icon: FileText, label: 'Regulation', value: data.topRequirements?.length
        ? t('{n} duties sampled', { n: n(data.topRequirements?.length) }) : t('this instrument') },
    { icon: Layers, label: 'Entities touched',
      value: t('{n} across {domains} domains', { n: n(data.relationshipsByDomain?.reduce((a: number, d: any) => a + d.entities, 0)), domains: n(data.relationshipsByDomain?.length) }) },
    { icon: Building2, label: 'Departments reached', value: t('{n} named', { n: n(data.departments?.length) }) },
    { icon: AlertTriangle, label: 'Open risks', value: t('{n} linked', { n: n(data.risks?.length) }) },
  ];

  return (
    <div className="space-y-4">
      {/* ------------------------------------------- score, drivers, risks */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Impact score"
              right={<span className="text-[11px] text-muted-2">{t('our engine, not the regulator')}</span>}>
          <div className="flex items-center gap-5">
            <svg viewBox="0 0 160 160" className="h-36 w-36 shrink-0" role="img"
                 aria-label={t('impact score {score}, {level}', { score: data.score, level: data.level ? t(data.level) : '' })}>
              <circle cx="80" cy="80" r={R} className="fill-none stroke-line" strokeWidth="14" />
              <circle cx="80" cy="80" r={R} fill="none" strokeWidth="14" strokeLinecap="round"
                      className={ring} strokeDasharray={`${(pct / 100) * C} ${C}`}
                      transform="rotate(-90 80 80)" />
              <text x="80" y="76" textAnchor="middle" className="fill-ink text-[30px] font-semibold">
                {data.score}
              </text>
              <text x="80" y="97" textAnchor="middle" className="fill-muted text-[11px]">
                {t('{level} impact', { level: data.level ? t(data.level) : '' })}
              </text>
            </svg>
            <dl className="min-w-0 flex-1 space-y-2 text-sm">
              {[[tx('Inherent'), data.inherent], [tx('Residual, after controls'), data.residual],
                [tx('Confidence'), data.confidence != null ? `${Math.round(data.confidence * 100)}%` : null],
                [tx('Applicability'), data.applicability]].map(([k, v]) =>
                v == null ? null : (
                  <div key={k as string} className="flex justify-between gap-3">
                    <dt className="text-muted">{t(k as string)}</dt>
                    <dd className="tabular-nums text-ink">{v as string}</dd>
                  </div>
                ))}
            </dl>
          </div>
          {data.formula && (
            <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-muted-2">
              {data.formula}
            </p>
          )}
        </Card>

        <Card title="What produced that score">
          {!data.drivers?.length ? (
            <p className="text-sm text-muted">{t('The score records no inputs.')}</p>
          ) : (
            <ul className="space-y-3.5">
              {(data.drivers ?? []).map((d: any) => {
                const width = d.kind === 'ratio' ? d.value * 100
                  : d.kind === 'factor' ? Math.min(100, (d.value / 2) * 100)
                    : null;
                return (
                  <li key={d.key} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-ink-2">{d.label}</span>
                      <span className="shrink-0 tabular-nums font-medium text-ink">
                        {d.kind === 'ratio' ? `${Math.round(d.value * 100)}%` : n(d.value)}
                      </span>
                    </div>
                    {width != null && (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-brand-400"
                             style={{ width: `${Math.max(width, 3)}%` }} />
                      </div>
                    )}
                    {d.note && (
                      <div className="mt-1 text-[11px] leading-relaxed text-muted-2">{d.note}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Open risks"
              right={<span className="text-[11px] text-muted-2">{n(data.risks?.length)}</span>}>
          {!data.risks?.length ? (
            <p className="text-sm text-muted">{t('No open risk is linked to this regulation.')}</p>
          ) : (
            <ul className="space-y-2.5">
              {(data.risks ?? []).map((r: any) => (
                <li key={r.id} className="flex items-start gap-2 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-600" />
                  <span className="min-w-0 flex-1 text-ink-2">{r.name}</span>
                  {r.criticality && (
                    <span className={cn('shrink-0 rounded px-2 py-0.5 text-[11px] font-medium',
                      sevCls(r.criticality))}>{r.criticality}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* --------------------------------------- departments, cascade, duties */}
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.8fr_1.3fr]">
        <Card title="Departments affected">
          {!data.departments?.length ? (
            <p className="text-sm text-muted">{t('No control for this regulation names a department.')}</p>
          ) : (
            <ul className="space-y-3">
              {(data.departments ?? []).map((d: any) => {
                const max = data.departments[0].requirements || 1;
                return (
                  <li key={d.department} className="text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-ink-2">{d.department}</span>
                      <span className="shrink-0 tabular-nums text-muted">
                        {t('{n} duties', { n: n(d.requirements) })}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-2 rounded bg-brand-400"
                           style={{ width: `${Math.max((d.requirements / max) * 100, 5)}%` }} />
                      <span className="text-[11px] text-muted-2">{t('{n} controls', { n: n(d.controls) })}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Impact cascade">
          <ol className="space-y-1">
            {cascade.map((c, i) => (
              <li key={c.label}>
                <div className="flex items-start gap-2.5 rounded-lg border border-line p-2.5">
                  <c.icon size={15} className="mt-0.5 shrink-0 text-brand-500" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-ink">{t(c.label)}</div>
                    <div className="truncate text-[11px] text-muted">{c.value}</div>
                  </div>
                </div>
                {i < cascade.length - 1 && (
                  <div className="flex justify-center py-0.5">
                    <ArrowDown size={12} className="text-line-2" />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Duties with the most control attention"
              right={<span className="text-[11px] text-muted-2">{t('a real proxy for high impact')}</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-muted-2">
                <tr>
                  <th className="pb-2 text-left font-medium">{t('Clause')}</th>
                  <th className="pb-2 text-left font-medium">{t('Duty')}</th>
                  <th className="pb-2 text-right font-medium">{t('Controls')}</th>
                  <th className="pb-2 text-left font-medium">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {(data.topRequirements || []).map((r: any) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3 tabular-nums text-muted-2">{r.source_clause || '—'}</td>
                    <td className="max-w-[300px] py-2 pr-3 text-ink">
                      <span className="line-clamp-2">{r.statement}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-ink">{n(r.controls)}</td>
                    <td className="py-2 text-[11px] text-muted">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ----------------------------------------------- records affected */}
      {(data.relationshipsByDomain?.length ?? 0) > 0 && (
        <Card title="Records affected"
              right={<span className="text-[11px] text-muted-2">
                {t("matched from this regulation's text")}
              </span>}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(data.relationshipsByDomain ?? []).map((d: any) => {
              const Icon = DOMAIN_ICON[String(d.domain).toLowerCase()] || Layers;
              return (
                <div key={d.domain} className="rounded-lg border border-line p-3">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-2">
                    <Icon size={12} className="text-brand-500" />
                    <span className="truncate">{d.domain}</span>
                  </div>
                  <div className="mt-1 text-xl font-semibold tabular-nums text-ink">
                    {n(d.entities)}
                  </div>
                  <div className="text-[11px] text-muted">{t('{n} links', { n: n(d.n) })}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
