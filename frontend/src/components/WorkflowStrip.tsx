import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';
import { Icon } from '@/config/icons';
import { useData } from '@/app/store/data';
import { useRegulationFacets } from '@/services/regulationsApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

/**
 * How the product works, as six stages with live counts.
 * The app's value is a pipeline, but nothing on screen said so — this makes the
 * journey legible on the landing page and turns each stage into a way in.
 *
 * Each stage is a coloured step card; where one stage feeds the next, a slim
 * bar says how much of the previous stage has come through (extracted of
 * discovered, analysed of extracted, still open of assessed).
 */
type StageTone = 'blue' | 'violet' | 'teal' | 'sky' | 'amber' | 'red' | 'green';
const TILE: Record<StageTone, string> = {
  blue: 'bg-blue-50 text-blue-600', violet: 'bg-violet-50 text-violet-600',
  teal: 'bg-teal-50 text-teal-600', sky: 'bg-sky-50 text-sky-600',
  amber: 'bg-amber-50 text-amber-600', red: 'bg-critical-50 text-critical-600',
  green: 'bg-success-50 text-success-600',
};
const BAR: Record<StageTone, string> = {
  blue: 'bg-blue-500', violet: 'bg-violet-500', teal: 'bg-teal-500', sky: 'bg-sky-500', amber: 'bg-amber-500', red: 'bg-critical-500', green: 'bg-success-500',
};
const TEXT: Record<StageTone, string> = {
  blue: 'text-blue-700', violet: 'text-violet-700', teal: 'text-teal-700', sky: 'text-sky-700', amber: 'text-amber-700', red: 'text-critical-600', green: 'text-success-600',
};
const BADGE: Record<StageTone, string> = {
  blue: 'bg-blue-600 text-white', violet: 'bg-violet-600 text-white', teal: 'bg-teal-700 text-white', sky: 'bg-sky-700 text-white',
  amber: 'bg-amber-400 text-amber-950', red: 'bg-critical-600 text-white', green: 'bg-success-600 text-white',
};
const LINE: Record<StageTone, string> = {
  blue: 'from-blue-300', violet: 'from-violet-300', teal: 'from-teal-300', sky: 'from-sky-300', amber: 'from-amber-300', red: 'from-critical-200', green: 'from-success-200',
};

export function WorkflowStrip() {
  const navigate = useNavigate();
  const t = useT();
  const { entities } = useData();
  const { data: facets } = useRegulationFacets();
  const byStatus = (v: string) => facets?.statuses.find((s: { value: string; count: number }) => s.value === v)?.count ?? 0;
  const analysed = byStatus('MAPPED');
  const extracted = analysed + byStatus('STRUCTURED') + byStatus('EXTRACTED');

  const companyEntities = entities.filter((e) =>
    ['people', 'processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence'].includes(e.domain),
  ).length;
  // gap-assessment totals, the same numbers the Impact Cascade picker shows
  const { data: gaps } = useQuery<{ items: { applicable: number; partial: number; gap: number; not_covered: number; critical: number }[] }>({
    queryKey: ['cascade', 'list'], queryFn: () => api('/api/cascade/regulations'), staleTime: 300_000,
  });
  const sum = (f: (i: { applicable: number; partial: number; gap: number; not_covered: number; critical: number }) => number) =>
    (gaps?.items ?? []).reduce((a, i) => a + f(i), 0);
  const assessed = sum((i) => i.applicable);
  const unmet = sum((i) => i.partial + i.gap + i.not_covered);
  const critical = sum((i) => i.critical);
  const share = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : undefined);

  const stages: {
    n: number; icon: string; label: string; value: number; unit: string; caption: string; to: string;
    tone: StageTone; needsHuman?: boolean; ratio?: { pct?: number; label: string };
  }[] = [
    {
      n: 1, icon: 'Landmark', label: 'Discover', tone: 'blue',
      value: facets?.total ?? 0, unit: t('regulations'),
      caption: t('{n} official authorities, crawled daily', { n: (facets?.regulators.length ?? 0).toLocaleString() }),
      to: '/reg-regulations',
    },
    {
      n: 2, icon: 'FileText', label: 'Extract', tone: 'violet',
      value: extracted, unit: t('documents'),
      caption: t('PDF downloaded, hashed and text-extracted'),
      to: '/ingestion',
      ratio: { pct: share(extracted, facets?.total ?? 0), label: '{pct}% of discovered' },
    },
    {
      n: 3, icon: 'Gavel', label: 'Parse', tone: 'teal',
      value: analysed, unit: t('documents analysed'),
      caption: t('Binding requirements found clause by clause'),
      to: '/reg-regulations',
      ratio: { pct: share(analysed, extracted), label: '{pct}% of extracted' },
    },
    {
      n: 4, icon: 'Network', label: 'Match', tone: 'sky',
      value: companyEntities, unit: t('company records'),
      caption: t('Policies, SOPs, controls and people the obligations are checked against'),
      to: '/departments',
    },
    {
      n: 5, icon: 'Activity', label: 'Assess gaps', tone: 'amber',
      value: assessed, unit: t('requirements assessed'),
      caption: t('Each requirement judged against your own documents'),
      to: '/cascade',
    },
    {
      n: 6, icon: 'Inbox', needsHuman: true, label: 'Close gaps', tone: unmet > 0 ? 'red' : 'green',
      value: unmet, unit: t('open gaps'),
      caption: critical > 0 ? t('{n} critical — start there', { n: critical.toLocaleString() }) : t('Partial, gap and not-covered requirements'),
      to: '/compliance',
      ratio: { pct: share(unmet, assessed), label: '{pct}% of assessed still open' },
    },
  ];

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <div className="sec-eyebrow">{t('How this works')}</div>
          <h2 className="sec-title">{t('From a published regulation to a decision you can defend')}</h2>
        </div>
        <span className="pill bg-brand-50 text-brand-600"><Icon name="Sparkles" className="h-3.5 w-3.5" /> {t('AI proposes · a human approves')}</span>
      </div>

      <ol className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6 lg:gap-0 lg:p-0">
        {stages.map((s, i) => (
          <li key={s.n} className="relative">
            {/* connector to the next stage, behind the icons */}
            {i < stages.length - 1 && (
              <span aria-hidden="true"
                className={cn('absolute left-[52px] right-0 top-[38px] hidden h-0.5 bg-gradient-to-r to-slate-200 lg:block', LINE[s.tone])} />
            )}
            <button
              onClick={() => navigate(s.to)}
              className="group relative flex h-full w-full flex-col gap-2 rounded-xl border border-line px-4 py-4 text-left transition hover:bg-slate-50/70 lg:rounded-none lg:border-0"
            >
              <div className="flex items-center gap-2">
                <span className={cn('relative grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-4 ring-white transition group-hover:scale-105', TILE[s.tone])}>
                  <Icon name={s.icon} className="h-5 w-5" />
                  <span className={cn('absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ring-2 ring-white', BADGE[s.tone])}>
                    {s.n}
                  </span>
                </span>
                {s.needsHuman && (
                  <span className="ml-auto hidden rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 xl:inline">{t('You')}</span>
                )}
              </div>
              <span className={cn('text-[13px] font-bold', TEXT[s.tone])}>{t(s.label)}</span>

              <div>
                <div className="num text-[22px] font-bold leading-none text-ink">
                  {s.value.toLocaleString()}
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-muted-2">{s.unit}</div>
              </div>

              {s.ratio?.pct !== undefined && (
                <div className="flex items-center gap-2" title={t(s.ratio.label, { pct: s.ratio.pct })}>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <span className={cn('block h-full rounded-full transition-[width] duration-700', BAR[s.tone])} style={{ width: `${Math.min(100, s.ratio.pct)}%` }} />
                  </span>
                  <span className={cn('text-[11px] font-semibold tabular-nums', TEXT[s.tone])}>{s.ratio.pct}%</span>
                </div>
              )}

              <p className="text-[11.5px] leading-snug text-muted">{s.caption}</p>

              <span className="mt-auto inline-flex items-center gap-1 pt-1 text-[11px] font-semibold text-brand-600 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {t('Open')} <Icon name="ArrowRight" className="h-3 w-3" />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
