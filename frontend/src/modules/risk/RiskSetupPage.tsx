/**
 * Risk inputs — what risk scoring needs to know about the company (design §6–§7):
 * its sites and their size, licences, third parties, history (or a signed
 * statement that there was none), leadership's risk appetite, and the facts read
 * from documents waiting for a person to confirm them.
 *
 * The overview says which mandatory inputs are present and what each unlocks:
 * a missing one makes every risk it touches "insufficient evidence", never "low".
 */
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ChevronRight, CircleDashed } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { TabStrip } from '@/components/ui/TabStrip';
import { Callout, Skeleton } from '@/components/ui/primitives';
import { toneFor } from '@/config/tones';
import { useReadiness, type ReadinessItem } from '@/services/riskApi';
import { cn } from '@/utils/ui';
import { tx, useT, type TFunction } from '@/i18n';
import { RecordsTab } from './RecordsTab';
import { HistoryCoverage } from './HistoryCoverage';
import { AppetiteTab } from './AppetiteTab';
import { FactsTab } from './FactsTab';
import { HISTORY_KIND_LABEL, METRIC_LABEL } from './labels';

type TabKey = 'overview' | 'sites' | 'licences' | 'third-parties' | 'history' | 'appetite' | 'facts';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: tx('Overview') },
  { key: 'sites', label: tx('Sites') },
  { key: 'licences', label: tx('Licences') },
  { key: 'third-parties', label: tx('Third parties') },
  { key: 'history', label: tx('History') },
  { key: 'appetite', label: tx('Risk appetite') },
  { key: 'facts', label: tx('Facts to confirm') },
];
const url = (k: TabKey) => (k === 'overview' ? '/risk-setup' : `/risk-setup/${k}`);

export function RiskSetupPage() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const active = (tab ?? 'overview') as TabKey;
  if (!TABS.some((x) => x.key === active)) return <Navigate to="/risk-setup" replace />;

  return (
    <>
      <Topbar
        title="Risk inputs"
        subtitle="What risk scoring needs to know about the company, and the appetite leadership sets"
        icon="Gauge"
        tone={toneFor('risks')}
        below={<TabStrip ariaLabel="Risk inputs" tabs={TABS} active={active} onChange={(k) => navigate(url(k))} />}
      />
      <div key={active} className="space-y-4 p-4 sm:p-6">
        {active === 'overview' && <Overview onOpen={(k) => navigate(url(k))} />}
        {active === 'sites' && <RecordsTab kind="sites" />}
        {active === 'licences' && <RecordsTab kind="licences" />}
        {active === 'third-parties' && <RecordsTab kind="third_parties" />}
        {active === 'history' && <RecordsTab kind="history" below={<HistoryCoverage />} />}
        {active === 'appetite' && <AppetiteTab />}
        {active === 'facts' && <FactsTab />}
      </div>
    </>
  );
}

const ITEM: Record<ReadinessItem['key'], { title: string; unlocks: string; tab: TabKey }> = {
  sites: { title: tx('Sites'), tab: 'sites', unlocks: tx('Likelihood grows with the number of sites.') },
  scale: { title: tx('Size of each site'), tab: 'sites', unlocks: tx('Likelihood grows with size.') },
  history: { title: tx('History, or a signed "none"'), tab: 'history', unlocks: tx('Without records or an attestation, nothing can be scored.') },
  appetite: { title: tx('Risk appetite, approved'), tab: 'appetite', unlocks: tx('Scores are judged against appetite only once leadership approves it.') },
  licences: { title: tx('Licences'), tab: 'licences', unlocks: tx('Duties that guard a licence carry the highest operational impact.') },
  third_parties: { title: tx('Third parties'), tab: 'third-parties', unlocks: tx('Each vendor gets the third-party risks from the library.') },
  facts: { title: tx('Facts confirmed'), tab: 'facts', unlocks: tx('Values read from documents count only once a person confirms them.') },
};

function state(i: ReadinessItem, t: TFunction): string {
  switch (i.key) {
    case 'sites': return !i.count ? t('No site yet') : i.count === 1 ? t('1 site') : t('{n} sites', { n: i.count });
    case 'scale': return i.of
      ? t('{n} of {m} sites give their {metric}', { n: i.count ?? 0, m: i.of, metric: t(METRIC_LABEL[i.metric ?? ''] ?? i.metric ?? '').toLowerCase() })
      : t('Add a site first');
    case 'history': return i.done ? t('Every kind is covered')
      : t('Not covered: {kinds}', { kinds: (i.missing ?? []).map((k) => t(HISTORY_KIND_LABEL[k] ?? k)).join(', ') });
    case 'appetite': return i.done ? t('Version {v} in force', { v: i.version ?? '' })
      : i.draft === 'DRAFT' ? t('A draft is waiting for approval') : i.draft === 'RETURNED' ? t('Returned for changes') : t('Not set');
    case 'facts': return i.count ? t('{n} waiting', { n: i.count }) : t('Nothing waiting');
    default: return i.count ? t('{n} recorded', { n: i.count }) : t('None yet');
  }
}

function Overview({ onOpen }: { onOpen: (k: TabKey) => void }) {
  const t = useT();
  const { data, isLoading, error } = useReadiness();
  if (isLoading) return <Skeleton rows={6} />;
  if (error || !data) return <p className="text-critical-600">{(error as Error)?.message}</p>;
  const mandatory = data.items.filter((i) => i.mandatory);
  const optional = data.items.filter((i) => !i.mandatory);
  const blocking = mandatory.filter((i) => !i.done);

  return (
    <div className="space-y-5">
      {data.ready ? (
        <Callout tone="green" icon="CheckCircle2" title={t('Everything risk scoring needs is here')}>
          {t('Risks are scored with the {pack} rulebook and judged against the approved appetite.', { pack: data.pack })}
        </Callout>
      ) : (
        <Callout tone="amber" icon="AlertTriangle" title={t('Risks cannot be fully scored yet')}>
          {t('Until these are in, every risk they touch says "insufficient evidence" rather than a guess: {items}.',
            { items: blocking.map((i) => t(ITEM[i.key].title)).join(', ') })}
        </Callout>
      )}
      <Group title={t('Needed for scoring')} items={mandatory} onOpen={onOpen} />
      <Group title={t('Make the scores sharper')} items={optional} onOpen={onOpen} />
    </div>
  );
}

function Group({ title, items, onOpen }: { title: string; items: ReadinessItem[]; onOpen: (k: TabKey) => void }) {
  const t = useT();
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="grid gap-3 md:grid-cols-2">
        {items.map((i) => {
          const meta = ITEM[i.key];
          return (
            <li key={i.key}>
              <button type="button" onClick={() => onOpen(meta.tab)}
                      className={cn('group flex w-full items-start gap-3 rounded-card border bg-surface p-4 text-left shadow-card transition hover:shadow-md',
                        i.done ? 'border-line' : i.mandatory ? 'border-amber-200' : 'border-line')}>
                {i.done
                  ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  : <CircleDashed className={cn('mt-0.5 h-5 w-5 shrink-0', i.mandatory ? 'text-amber-600' : 'text-muted')} />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink">{t(meta.title)}</span>
                  <span className={cn('block text-[13px]', i.done ? 'text-emerald-700' : i.mandatory ? 'text-amber-700' : 'text-muted')}>{state(i, t)}</span>
                  <span className="mt-1 block text-[12px] text-muted">{t(meta.unlocks)}</span>
                </span>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
