/**
 * Applicability — the engine's working, shown rather than summarised.
 *
 * WHY THE CRITERIA TABLE IS THE POINT
 * -----------------------------------
 * `applicability_results.checks` already records one row per criterion: what
 * was expected, what this company has, where in the instrument it was found,
 * and the verdict. A screen that prints only the conclusion ("Applies to us")
 * is a screen an auditor cannot argue with, which makes it useless to them.
 * This renders the rows unchanged.
 *
 * UNKNOWN IS NOT "NOT MET"
 * ------------------------
 * Exemptions and Thresholds come back UNKNOWN on every regulation in the
 * corpus, because the engine does not extract them from regulation text. That
 * is a limitation of ours, not a finding about the hospital, so they are shown
 * in their own column and never counted as failures. Folding them into "not
 * met" would invent a problem; folding them into "met" would hide one.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, FileCheck, HelpCircle, XCircle } from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

interface Check {
  name: string;
  result: 'MATCH' | 'NO_MATCH' | 'UNKNOWN';
  expected?: unknown;
  found?: unknown;
  origin?: string | null;
  quoted?: string | null;
  detail?: string | null;
  sourceClause?: string | null;
  clauseText?: string | null;
  family?: string | null;
}
interface Payload {
  assessed: boolean;
  verdict?: string; confidence?: string; reason?: string;
  engineVersion?: string; computedAt?: string;
  checks: Check[];
  missingFacts: string[];
  summary: { total: number; MATCH: number; NO_MATCH: number; UNKNOWN: number } | null;
  addressees: { entity_type: string; role: string; confidence: number; applicability_rule: string }[];
  evidenceFor: { check: string; origin: string; found: unknown; family?: string | null; sourceClause?: string | null }[];
  dutiesOwed: number;
  dutiesRuledOut: number;
}

const show = (v: unknown): string => {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v);
};

const RESULT = {
  MATCH: { label: 'Met', icon: CheckCircle2, cls: 'bg-success-50 text-success-600', dot: 'bg-success-500' },
  NO_MATCH: { label: 'Not met', icon: XCircle, cls: 'bg-critical-50 text-critical-600', dot: 'bg-critical-500' },
  UNKNOWN: { label: 'Not evaluated', icon: HelpCircle, cls: 'bg-canvas text-muted', dot: 'bg-line-2' },
} as const;

export function ApplicabilityCheckTab({ id }: { id: string }) {
  const { data, isLoading } = useQuery<Payload>({
    queryKey: ['reg-applicability', id],
    queryFn: () => api(`/api/regulation/${id}/applicability`),
    staleTime: 60_000,
  });
  const t = useT();

  if (isLoading) return <p className="p-5 text-sm text-muted">{t("Reading the engine's working…")}</p>;
  if (!data?.assessed) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
        <p className="text-sm text-muted">
          {t('This regulation has not been evaluated against the company profile, so no verdict is shown. Nothing is assumed in its place.')}
        </p>
      </div>
    );
  }

  const s = data.summary!;
  const applies = data.verdict === 'CONDITIONAL' || data.verdict === 'APPLICABLE';
  const R = 54, C = 2 * Math.PI * R;
  const arc = (v: number) => (v / Math.max(s.total, 1)) * C;
  let off = 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_330px]">
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">{t('Applicability check')}</h3>
              <p className="mt-1 max-w-xl text-sm text-muted">
                {t('Each criterion the engine tested, what it expected, and what this company holds. Read straight from the stored assessment.')}
              </p>
            </div>
            <div className={cn('flex items-start gap-2.5 rounded-lg border p-3',
              applies ? 'border-success-200 bg-success-50' : 'border-line bg-canvas')}>
              {applies
                ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success-600" />
                : <AlertCircle size={18} className="mt-0.5 shrink-0 text-muted" />}
              <div className="max-w-sm">
                <div className="text-sm font-medium text-ink">
                  {applies ? t('This regulation reaches this company') : data.verdict}
                </div>
                {data.reason && (
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{data.reason}</p>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-[11px] uppercase tracking-wide text-muted-2">
                <tr>
                  <th className="px-5 py-2.5 text-left font-medium">{t('Criterion')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('What we hold')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('What it asks for')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('Result')}</th>
                  <th className="px-5 py-2.5 text-left font-medium">{t('Why')}</th>
                </tr>
              </thead>
              <tbody>
                {(data.checks ?? []).map((c) => {
                  const r = RESULT[c.result] ?? RESULT.UNKNOWN;
                  const Icon = r.icon;
                  return (
                    <tr key={c.name} className="border-t border-line align-top">
                      <td className="px-5 py-3">
                        <div className="font-medium text-ink">{c.name}</div>
                        {c.sourceClause && (
                          <div className="text-[11px] text-muted-2">{c.sourceClause}</div>
                        )}
                      </td>
                      <td className="max-w-[180px] px-3 py-3 text-ink-2">
                        <div className="truncate" title={show(c.found)}>{show(c.found)}</div>
                        {c.origin && (
                          <div className="truncate text-[11px] text-muted-2" title={c.origin}>
                            {t('from {origin}', { origin: c.origin })}
                          </div>
                        )}
                      </td>
                      <td className="max-w-[160px] px-3 py-3 text-muted">
                        <div className="truncate" title={show(c.expected)}>{show(c.expected)}</div>
                        {c.quoted && (
                          <div className="truncate text-[11px] text-muted-2" title={c.quoted}>
                            “{c.quoted}”
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium', r.cls)}>
                          <Icon size={11} /> {t(r.label)}
                        </span>
                      </td>
                      <td className="max-w-[320px] px-5 py-3 text-xs leading-relaxed text-muted">
                        {c.detail || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {(data.evidenceFor?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('Evidence for applicability')}</h3>
            <p className="mt-1 text-xs text-muted">
              {t('The company fact each satisfied criterion rested on. These are what the engine read — not the whole profile.')}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(data.evidenceFor ?? []).map((e, i) => (
                <div key={i} className="rounded-lg border border-line p-3">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-2">
                    <FileCheck size={12} className="text-success-600" /> {e.check}
                  </div>
                  <div className="mt-1 line-clamp-2 text-sm text-ink" title={e.origin}>
                    {e.origin}
                  </div>
                  <span className="mt-2 inline-block rounded bg-success-50 px-2 py-0.5 text-[11px] font-medium text-success-600">
                    {t('Satisfied')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(data.addressees?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{t('Who this instrument addresses')}</h3>
            <p className="mt-1 text-xs text-muted">
              {t('Parties named in the text, with the role each plays in its own sentence. Only an addressee reading counts towards applicability — a mention does not.')}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(data.addressees ?? []).map((a, i) => (
                <span key={i} className={cn('rounded-full border px-2.5 py-1 text-xs',
                  a.role?.startsWith('ADDRESSEE')
                    ? 'border-brand-200 bg-brand-50 text-brand-700'
                    : 'border-line bg-canvas text-muted')}>
                  {a.entity_type || t('Unknown')}
                  <span className="ml-1.5 text-[10px] opacity-70">{a.role}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink">{t('Summary')}</h3>
          <div className="mt-3 flex items-center gap-4">
            <svg viewBox="0 0 140 140" className="h-32 w-32 shrink-0">
              <circle cx="70" cy="70" r={R} className="fill-none stroke-line" strokeWidth="14" />
              {([['MATCH', 'stroke-success-500'], ['NO_MATCH', 'stroke-critical-500'],
                 ['UNKNOWN', 'stroke-line-2']] as const).map(([k, cls]) => {
                const len = arc(s[k]);
                const el = (
                  <circle key={k} cx="70" cy="70" r={R} fill="none" strokeWidth="14"
                          className={cls} strokeDasharray={`${len} ${C - len}`}
                          strokeDashoffset={-off} transform="rotate(-90 70 70)" />
                );
                off += len;
                return el;
              })}
              <text x="70" y="68" textAnchor="middle" className="fill-ink text-[20px] font-semibold">
                {s.MATCH}/{s.total}
              </text>
              <text x="70" y="86" textAnchor="middle" className="fill-muted text-[10px]">
                {t('criteria met')}
              </text>
            </svg>
            <ul className="flex-1 space-y-2 text-sm">
              {([['MATCH', tx('Met')], ['NO_MATCH', tx('Not met')], ['UNKNOWN', tx('Not evaluated')]] as const)
                .map(([k, label]) => (
                  <li key={k} className="flex items-center gap-2">
                    <span className={cn('h-2.5 w-2.5 rounded-full', RESULT[k].dot)} />
                    <span className="text-ink-2">{t(label)}</span>
                    <span className="ml-auto tabular-nums text-ink">{s[k]}</span>
                  </li>
                ))}
            </ul>
          </div>
        </div>

        {(data.missingFacts?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-warning-200 bg-warning-50 p-5">
            <h3 className="text-sm font-semibold text-ink">{t('Not evaluated')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              {t('The engine could not test these, so the verdict is reported as conditional rather than unqualified. This is a limit of the extraction, not a finding about the hospital.')}
            </p>
            <ul className="mt-2.5 space-y-1">
              {(data.missingFacts ?? []).map((f) => (
                <li key={f} className="flex items-center gap-1.5 text-xs text-ink-2">
                  <HelpCircle size={11} className="text-warning-600" /> {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink">{t('Duties in scope')}</h3>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted">{t('This company owes')}</span>
              <span className="tabular-nums font-medium text-ink">
                {data.dutiesOwed?.toLocaleString() ?? 0}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{t('Evaluated and ruled out')}</span>
              <span className="tabular-nums text-ink-2">
                {data.dutiesRuledOut?.toLocaleString() ?? 0}
              </span>
            </div>
          </div>
          {data.dutiesRuledOut === 0 && (
            <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-muted-2">
              {t('No duty in this instrument has been ruled out. Thresholds and exemptions are not extracted from regulation text, so a duty is only excluded when the company profile positively excludes it.')}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink">{t('How this was decided')}</h3>
          <dl className="mt-3 space-y-2 text-sm">
            {[[tx('Verdict'), data.verdict], [tx('Confidence'), data.confidence],
              [tx('Engine'), data.engineVersion],
              [tx('Computed'), data.computedAt?.slice(0, 10)]].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3">
                <dt className="text-muted">{t(k as string)}</dt>
                <dd className="truncate text-ink-2">{(v as string) || '—'}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
