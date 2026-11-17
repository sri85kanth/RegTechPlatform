import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/layouts/Topbar';
import { EmptyState, IconTile } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { useIngestionStats } from '@/services/regIntel';
import { useWatcherStatus, type WatcherStatus } from '@/services/impactEngineApi';
import { api } from '@/services/http';
import { can, useMe } from '@/services/authApi';
import { cn, readable } from '@/utils/ui';
import { CountUp, prefersReducedMotion } from '@/components/ui/motion';
import { RegulationUpload } from './RegulationUpload';
import { COLLECTION_HEX } from './RegulationFilters';
import { tx, useDateLocale, useT } from '@/i18n';
import './ingestion.css';

/**
 * The ingestion pipeline, as a person reads it: how healthy it is (three
 * rings), how documents move through it (stage cards joined by flowing pipes,
 * with the ones that need attention branching off), whether the sources are
 * still being watched (a timeline of the latest checks), what is new on
 * regulator sites, and every source in one table.
 *
 * Counts are regulations.ingestion_status grouped (GET /api/intel/ingestion).
 * Statuses the pipeline writes that this page does not name still appear — in
 * the "in progress" stage and as their own column — rather than being dropped.
 */
const STATUS_ORDER = ['MAPPED', 'STRUCTURED', 'EXTRACTED', 'PARSING', 'OCR_REQUIRED', 'DISCOVERED', 'FAILED_FETCH', 'FAILED'];
/** Pipeline stages in words. OCR_REQUIRED reads as the action it needs. */
const STATUS_LABEL: Record<string, string> = {
  OCR_REQUIRED: tx('Needs OCR'), FAILED_FETCH: tx('Fetch failed'), MAPPED: tx('Mapped'),
  // the same words readable() gives, listed so they are collected for translation
  STRUCTURED: tx('Structured'), EXTRACTED: tx('Extracted'), PARSING: tx('Parsing'), DISCOVERED: tx('Discovered'), FAILED: tx('Failed'),
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? readable(s);
const hex = (s: string) => COLLECTION_HEX[s] ?? '#8e8e93';

const DISCOVERED = ['DISCOVERED'];
const OCR = ['OCR_REQUIRED'];
const MAPPED = ['MAPPED'];
const FAILED = ['FAILED', 'FAILED_FETCH'];

/** Watcher outcomes: green when a source answered, red when it did not, grey otherwise. */
const OUTCOME_HEX: Record<string, string> = {
  UNCHANGED: '#34C759', CHANGED: '#0071E3', BASELINE_CAPTURED: '#5AC8FA', URL_RESOLVED: '#30B0C7',
  UNREACHABLE: '#FF3B30', URL_UNRESOLVED: '#FF9F0A', QUARANTINED: '#AF52DE',
};
const outcomeHex = (o: string) => OUTCOME_HEX[o] ?? '#8E8E93';

/** How many table rows show before "Show all". */
const FIRST_ROWS = 25;

/**
 * The pipeline is technical state (OCR, fetch failures, raw stage names), so it
 * is for administrators; the sidebar hides it from everyone else. Anyone who
 * arrives by link gets a short note instead, and the stats are never fetched.
 */
export function IngestionPage() {
  const t = useT();
  const { data: me, isLoading } = useMe();
  if (can(me, 'administer')) return <IngestionPipeline />;
  return (
    <>
      <Topbar title="Ingestion" subtitle="Regulatory intelligence pipeline" icon="RefreshCw" />
      <div className="p-6">
        {isLoading ? (
          <div className="card p-8 text-center text-[13px] text-muted">{t('Loading…')}</div>
        ) : (
          <div className="card mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-14 text-center">
            <IconTile icon="ShieldAlert" tone="amber" size="lg" />
            <div className="text-base font-semibold text-ink">{t('Administrator access required')}</div>
            <p className="text-[13px] text-muted">{t('Only administrators can see the ingestion pipeline.')}</p>
          </div>
        )}
      </div>
    </>
  );
}

function IngestionPipeline() {
  const t = useT();
  const locale = useDateLocale();
  const qc = useQueryClient();
  const { data, isLoading, error } = useIngestionStats();
  const watcher = useWatcherStatus();
  const busy = useIsFetching({ predicate: (q) => ['ingestion', 'watcher'].includes(String(q.queryKey[0])) }) > 0;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ingestion'] });
    void qc.invalidateQueries({ queryKey: ['watcher'] });
  };

  const totals = useMemo(() => data?.totals ?? {}, [data]);
  const statuses = data
    ? [...STATUS_ORDER.filter((s) => totals[s] != null), ...Object.keys(totals).filter((s) => !STATUS_ORDER.includes(s))]
    : [];
  const sum = (keys: string[]) => keys.reduce((a, k) => a + (totals[k] ?? 0), 0);
  const all = Object.values(totals).reduce((a, b) => a + b, 0);
  const named = [...DISCOVERED, ...OCR, ...MAPPED, ...FAILED];
  const inFlight = statuses.filter((s) => !named.includes(s));
  const share = (n: number) => (all > 0 ? n / all : 0);

  const sources = useMemo(() => (data
    ? Object.entries(data.bySource)
        .map(([src, st]) => ({ src, st, total: Object.values(st).reduce((x, y) => x + y, 0) }))
        .sort((a, b) => b.total - a.total)
    : []), [data]);

  // watcher: a source is reachable when its latest check got an answer
  const recent = watcher.data?.recent ?? [];
  const reached = recent.filter((r) => r.outcome !== 'UNREACHABLE').length;
  const reachShare = recent.length ? reached / recent.length : 0;
  const downloaded = all - sum(DISCOVERED) - (totals.FAILED_FETCH ?? 0);

  return (
    <div className="ing">
      <Topbar
        title="Ingestion"
        subtitle="Regulatory intelligence pipeline — discovery, extraction, structuring and Company Brain mapping"
        icon="RefreshCw"
        meta={data ? [
          { icon: 'Database', label: 'Records', value: all.toLocaleString() },
          { icon: 'Landmark', label: 'Sources', value: sources.length.toLocaleString() },
          { icon: 'Clock', label: 'Counted', value: new Date(data.generatedAt).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
        ] : undefined}
        actions={<>
          <button type="button" className="btn" onClick={refresh} disabled={busy}>
            <Icon name="RefreshCw" className={cn('h-4 w-4', busy && 'ing-spin')} /> {t('Refresh')}
          </button>
          <button type="button" className="btn btn-primary"
                  onClick={() => document.getElementById('upload')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <Icon name="UploadCloud" className="h-4 w-4" /> {t('Upload a regulation')}
          </button>
        </>}
      />
      <div className="space-y-5 p-4 sm:p-6">
        {isLoading && <div className="card p-8 text-center text-[13px] text-muted">{t('Loading pipeline status…')}</div>}
        {error != null && <EmptyState title={t('No pipeline data')} hint={t('Run scraper/regulatory_ingestion/pipeline.py (--migrate, --process) to populate the intelligence database.')} />}

        {data && (
          <>
            {/* ---- health at a glance + how documents move */}
            <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]">
              <HealthCard
                rings={[
                  { label: t('Mapped'), sub: t('in the Brain'), value: share(sum(MAPPED)), n: sum(MAPPED), of: all, color: ['#30D158', '#34C759'] },
                  { label: t('Downloaded'), sub: t('records'), value: share(downloaded), n: downloaded, of: all, color: ['#64D2FF', '#0A84FF'] },
                  { label: t('Sources reachable'), sub: t('Latest checks'), value: reachShare, n: reached, of: recent.length, color: ['#FF6482', '#FF375F'] },
                ]}
              />
              <FlowCard
                main={[
                  { key: 'disc', icon: 'Search', tone: '#0071E3', label: t('Discovered'), value: sum(DISCOVERED), share: share(sum(DISCOVERED)), foot: t('awaiting download') },
                  { key: 'mid', icon: 'RefreshCw', tone: '#5856D6', label: t('Downloading / parsing'), value: sum(inFlight), share: share(sum(inFlight)), foot: inFlight.length ? t('mid-pipeline') : t('nothing mid-way') },
                  { key: 'map', icon: 'Network', tone: '#34C759', label: t('Mapped'), value: sum(MAPPED), share: share(sum(MAPPED)), foot: t('in the Brain') },
                ]}
                attention={[
                  { key: 'ocr', icon: 'FileSearch', tone: '#FF9F0A', label: t('OCR required'), value: sum(OCR), share: share(sum(OCR)), foot: t('scanned, no text') },
                  { key: 'fail', icon: 'AlertTriangle', tone: '#FF3B30', label: t('Failed'), value: sum(FAILED), share: share(sum(FAILED)),
                    foot: totals.FAILED_FETCH ? t('{n} on fetch', { n: totals.FAILED_FETCH.toLocaleString() }) : undefined },
                ]}
              />
            </div>

            {/* ---- is anyone still watching the sources? what is new out there? */}
            <div className="grid gap-5 lg:grid-cols-2">
              <WatcherCard data={watcher.data} loading={watcher.isLoading} />
              <DiscoveriesCard />
            </div>

            <SourcesTable sources={sources} statuses={statuses} generatedAt={data.generatedAt} />
          </>
        )}

        {/* ---- upload + live jobs */}
        <div id="upload" className="scroll-mt-20">
          <RegulationUpload />
        </div>
      </div>
    </div>
  );
}

/* ============================================================ health rings */

interface Ring { label: string; sub: string; value: number; n: number; of: number; color: [string, string] }

/** Three concentric rings, Apple Watch style: each one fills to its share and draws itself in. */
function HealthCard({ rings }: { rings: Ring[] }) {
  const t = useT();
  const [on, setOn] = useState(prefersReducedMotion());
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  const SIZE = 176, STROKE = 16, GAP = 4;
  return (
    <section className="card relative overflow-hidden p-5">
      {/* a soft colour wash behind the rings */}
      <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(52,199,89,0.14),transparent_70%)]" />
      <div className="relative flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-[#34c759] to-[#248a3d] text-white shadow-[0_2px_8px_rgba(52,199,89,0.35)]"><Icon name="Activity" className="h-4 w-4" /></span>
        <h2 className="sec-title">{t('Pipeline health')}</h2>
      </div>
      <div className="relative mt-4 flex flex-wrap items-center gap-6">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90" role="img"
             aria-label={rings.map((r) => `${r.label} ${Math.round(r.value * 100)}%`).join(', ')}>
          <defs>
            {rings.map((r, i) => (
              <linearGradient key={i} id={`ring-g${i}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={r.color[0]} /><stop offset="100%" stopColor={r.color[1]} />
              </linearGradient>
            ))}
          </defs>
          {rings.map((r, i) => {
            const rad = SIZE / 2 - STROKE / 2 - i * (STROKE + GAP);
            const c = 2 * Math.PI * rad;
            const v = Math.max(0, Math.min(1, r.value));
            return (
              <g key={i}>
                <circle cx={SIZE / 2} cy={SIZE / 2} r={rad} fill="none" stroke={r.color[1]} strokeOpacity={0.16} strokeWidth={STROKE} />
                <circle className={cn('ring-arc', i === 1 && 'r2', i === 2 && 'r3')} cx={SIZE / 2} cy={SIZE / 2} r={rad} fill="none"
                        stroke={`url(#ring-g${i})`} strokeWidth={STROKE} strokeLinecap="round"
                        strokeDasharray={c} strokeDashoffset={on ? c * (1 - v) : c}
                        style={{ filter: v > 0 ? `drop-shadow(0 0 3px ${r.color[1]}55)` : undefined }} />
              </g>
            );
          })}
        </svg>
        <ul className="min-w-0 flex-1 space-y-3.5">
          {rings.map((r) => (
            <li key={r.label} className="flex items-center gap-3">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `linear-gradient(135deg, ${r.color[0]}, ${r.color[1]})` }} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-snug text-ink-2">{r.label}</div>
                <div className="text-xs tabular-nums text-muted">
                  <CountUp value={r.n} /> / {r.of.toLocaleString()}
                </div>
              </div>
              <span className="num text-[22px] font-semibold" style={{ color: r.color[1] }}>
                <CountUp value={Math.round(r.value * 100)} />%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ============================================================ pipeline flow */

interface Stage { key: string; icon: string; tone: string; label: string; value: number; share: number; foot?: string }

/**
 * Documents left to right through the pipeline, with flowing pipes between the
 * stages; the ones that need attention branch off below in amber.
 */
function FlowCard({ main, attention }: { main: Stage[]; attention: Stage[] }) {
  const t = useT();
  return (
    <section className="card relative overflow-hidden p-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-[#2b8cff] to-[#0071e3] text-white shadow-[0_2px_8px_rgba(0,113,227,0.35)]"><Icon name="GitBranch" className="h-4 w-4" /></span>
        <h2 className="sec-title">{t('Ingestion status')}</h2>
      </div>
      {/* main line: stage — pipe — stage — pipe — stage (stacks with vertical pipes on narrow screens) */}
      <div className="mt-4 flex flex-col items-stretch gap-0 md:flex-row md:items-center">
        {main.map((s, i) => (
          <div key={s.key} className="contents">
            <StageCard s={s} />
            {i < main.length - 1 && (
              <div className="flex items-center justify-center py-1.5 md:px-2 md:py-0" aria-hidden="true">
                <div className="pipe h hidden w-10 md:block" /><div className="pipe v h-6 md:hidden" />
                <Icon name="ChevronRight" className="-ml-1 hidden h-4 w-4 text-brand-500 md:block" />
              </div>
            )}
          </div>
        ))}
      </div>
      {/* the branch: documents that stopped and need a person */}
      <div className="mt-1 flex flex-col items-center" aria-hidden="true">
        <div className="pipe v warn h-7" />
      </div>
      <div className="rounded-[16px] bg-gradient-to-br from-[#fff8eb] to-[#fffcf6] p-3 shadow-[inset_0_0_0_0.5px_rgba(255,159,10,0.25)]">
        <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-warning-700">
          <Icon name="AlertTriangle" className="h-3.5 w-3.5" /> {t('Needs attention')}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {attention.map((s) => <StageCard key={s.key} s={s} />)}
        </div>
      </div>
    </section>
  );
}

function StageCard({ s }: { s: Stage }) {
  const pct = Math.round(s.share * 1000) / 10;
  return (
    <div className="card card-int group min-w-0 flex-1 bg-white/90 p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-white transition-transform duration-300 ease-spring group-hover:scale-110 group-hover:-rotate-6"
              style={{ background: `linear-gradient(135deg, ${s.tone}cc, ${s.tone})`, boxShadow: `0 3px 10px ${s.tone}40` }}>
          <Icon name={s.icon} className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <div className="line-clamp-2 text-[12.5px] font-medium leading-tight text-ink-2">{s.label}</div>
          <CountUp value={s.value} className="num block text-[22px] font-semibold leading-tight text-ink" />
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-black/[0.05]">
        <div className="grow h-full rounded-full" style={{ width: `${Math.max(s.value ? 2 : 0, Math.min(100, pct))}%`, background: s.tone }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted">
        <span className="truncate">{s.foot}</span>
        <span className="shrink-0 font-semibold tabular-nums" style={{ color: s.tone }}>{pct}%</span>
      </div>
    </div>
  );
}

/* ============================================================ source monitoring */

/** Is the watcher still reaching the sources? Its outcomes, and a timeline of the latest checks. */
function WatcherCard({ data, loading }: { data?: WatcherStatus; loading: boolean }) {
  const t = useT();
  const locale = useDateLocale();
  const recent = data?.recent ?? [];
  const broken = recent.length > 0 && recent.every((r) => r.outcome === 'UNREACHABLE');
  const outcomes = Object.entries(data?.byOutcome ?? {}).sort((a, b) => b[1] - a[1]);
  const total = outcomes.reduce((a, [, n]) => a + n, 0);
  return (
    <section className="card flex flex-col p-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-[#5ac8fa] to-[#0071e3] text-white shadow-[0_2px_8px_rgba(0,113,227,0.3)]"><Icon name="Radar" className="h-4 w-4" /></span>
        <h2 className="sec-title flex-1">{t('Source monitoring')}</h2>
        {data && (
          <span className={cn('pill', broken ? 'breathe bg-critical-50 text-critical-600' : 'bg-success-50 text-success-700')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', broken ? 'bg-critical-500' : 'bg-success-500')} />
            {t(broken ? 'Not working' : 'Working')}
          </span>
        )}
      </div>
      {loading && <p className="mt-4 text-[13px] text-muted">{t('Loading…')}</p>}
      {data && (
        <>
          {broken && (
            <div className="mt-4 flex gap-2.5 rounded-[14px] bg-critical-50 px-3.5 py-3 text-[12.5px] leading-relaxed text-critical-700">
              <Icon name="AlertTriangle" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('Every recent check failed to reach its source, so changes to these regulations are not being detected.')}</span>
            </div>
          )}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniStat label={t('Checks run')} value={data.totalChecks} />
            <MiniStat label={t('Due for a check')} value={data.dueNow} />
            <MiniStat label={t('Changes found')} value={data.changesDetected} />
          </div>
          {/* every check so far, by outcome */}
          {total > 0 && (
            <>
              <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-black/[0.05]">
                {outcomes.map(([o, n]) => (
                  <div key={o} className="grow h-full first:rounded-l-full last:rounded-r-full" title={`${t(readable(o))}: ${n.toLocaleString()}`}
                       style={{ width: `${(n / total) * 100}%`, background: outcomeHex(o) }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
                {outcomes.map(([o, n]) => (
                  <span key={o} className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: outcomeHex(o) }} />
                    {t(readable(o))} <b className="font-semibold tabular-nums text-ink-2">{n.toLocaleString()}</b>
                  </span>
                ))}
              </div>
            </>
          )}
          {/* timeline of the latest checks */}
          {recent.length > 0 && (
            <>
              <div className="sec-eyebrow mb-2 mt-5">{t('Latest checks')}</div>
              <ol className="stagger relative space-y-0.5 pl-5 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-black/[0.08]">
                {recent.slice(0, 6).map((r) => (
                  <li key={r.regulation_id + r.checked_at} className="relative rounded-xl px-2 py-1.5 transition-colors hover:bg-black/[0.03]">
                    <span className="absolute -left-[17px] top-[11px] h-2.5 w-2.5 rounded-full ring-[3px] ring-white" style={{ background: outcomeHex(r.outcome) }} />
                    <div className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="font-medium text-ink">{t(readable(r.outcome))}</span>
                      <span className="truncate font-mono text-[11.5px] text-muted">{r.regulation_id}</span>
                      <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted">
                        {new Date(r.checked_at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {r.note && <div className="truncate text-[11.5px] text-muted">{r.note}</div>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[14px] bg-black/[0.035] px-3 py-2.5 transition-colors hover:bg-black/[0.05]">
      <CountUp value={value} className="num block text-[20px] font-semibold leading-tight text-ink" />
      <div className="mt-0.5 truncate text-[11.5px] text-muted">{label}</div>
    </div>
  );
}

/* ============================================================ new on regulator sites */

interface Discovery { id: string; source: string; title: string; detail_url: string; first_seen: string; status: string }

/** What the nightly pass found on regulator listing pages that is not in the library yet — as a timeline. */
function DiscoveriesCard() {
  const t = useT();
  const locale = useDateLocale();
  const { data, isLoading } = useQuery<{ items: Discovery[] }>({
    queryKey: ['watcher', 'discoveries'], queryFn: () => api('/api/watcher/discoveries?status=NEW&limit=8'), staleTime: 300_000,
  });
  const items = data?.items ?? [];
  // "rbi_notifications_rss" → "RBI"
  const regulator = (s: string) => s.split('_')[0].toUpperCase();
  return (
    <section className="card flex flex-col p-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-[#bf5af2] to-[#8944ab] text-white shadow-[0_2px_8px_rgba(175,82,222,0.35)]"><Icon name="Sparkles" className="h-4 w-4" /></span>
        <h2 className="sec-title flex-1">{t('New on regulator sites')}</h2>
        {items.length > 0 && <span className="pill bg-[#f5eefb] text-[#8944ab]">{items.length.toLocaleString()}</span>}
      </div>
      <p className="mt-1 text-[12.5px] text-muted">{t('Found on regulator listing pages, not yet added to the library.')}</p>
      {isLoading && <p className="mt-4 text-[13px] text-muted">{t('Loading…')}</p>}
      {!isLoading && items.length === 0 && <p className="mt-6 text-center text-[13px] text-muted">{t('Nothing new found.')}</p>}
      {items.length > 0 && (
        <ol className="stagger relative mt-4 space-y-1 pl-5 before:absolute before:bottom-3 before:left-[7px] before:top-3 before:w-px before:bg-gradient-to-b before:from-[#bf5af2]/40 before:to-transparent">
          {items.map((d) => (
            <li key={d.id} className="relative">
              <span className="absolute -left-[17px] top-[13px] h-2.5 w-2.5 rounded-full bg-gradient-to-br from-[#bf5af2] to-[#8944ab] ring-[3px] ring-white" />
              <a href={d.detail_url} target="_blank" rel="noopener noreferrer"
                 className="group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-all duration-300 ease-spring hover:bg-black/[0.03]">
                <span className="mt-0.5 shrink-0 rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-ink-2">{regulator(d.source)}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[13px] font-medium leading-snug text-ink group-hover:text-brand-600">{d.title}</span>
                  <span className="mt-0.5 block text-[11.5px] tabular-nums text-muted">
                    {new Date(d.first_seen).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </span>
                <Icon name="ArrowUpRight" className="mt-0.5 h-4 w-4 shrink-0 text-muted-2 transition-transform duration-300 ease-spring group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brand-600" />
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ============================================================ every source */

function SourcesTable({ sources, statuses, generatedAt }: {
  sources: { src: string; st: Record<string, number>; total: number }[]; statuses: string[]; generatedAt: string;
}) {
  const t = useT();
  const locale = useDateLocale();
  const [q, setQ] = useState('');
  const [allRows, setAllRows] = useState(false);
  const hit = q.trim() ? sources.filter((s) => s.src.toLowerCase().includes(q.trim().toLowerCase())) : sources;
  const rows = allRows || q.trim() ? hit : hit.slice(0, FIRST_ROWS);
  const max = sources[0]?.total ?? 1;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-4">
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-[#2b8cff] to-[#0071e3] text-white shadow-[0_2px_8px_rgba(0,113,227,0.35)]"><Icon name="LayoutGrid" className="h-4 w-4" /></span>
        <h2 className="sec-title">{t('Documents by source')}</h2>
        <span className="pill bg-black/[0.05] text-ink-2">{t('{n} sources', { n: sources.length.toLocaleString() })}</span>
        <label className="ml-auto flex h-9 w-full items-center gap-2 rounded-full bg-black/[0.05] px-3.5 text-muted transition-all duration-300 ease-spring focus-within:bg-white focus-within:shadow-glow sm:w-72">
          <Icon name="Search" className="h-4 w-4 shrink-0" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search sources')}
                 aria-label={t('Search sources')} className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted" />
        </label>
      </div>
      <div className="max-h-[640px] overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 z-[1] bg-white/85 backdrop-blur-xl">
            <tr className="text-[11.5px] text-muted shadow-[inset_0_-0.5px_0_rgba(0,0,0,0.1)]">
              <th className="px-5 py-2.5 font-medium">{t('Source')}</th>
              <th className="min-w-[180px] px-3 py-2.5 font-medium">{t('Ingestion status')}</th>
              {statuses.map((s) => (
                <th key={s} className="whitespace-nowrap px-3 py-2.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: hex(s) }} aria-hidden="true" />{t(statusLabel(s))}</span>
                </th>
              ))}
              <th className="px-3 py-2.5 text-right font-medium">{t('Total')}</th>
              <th className="px-5 py-2.5 text-right font-medium">{t('Mapped')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ src, st, total }) => {
              const mapped = total ? Math.round(((st.MAPPED ?? 0) / total) * 100) : 0;
              return (
                <tr key={src} className="group shadow-[inset_0_-0.5px_0_rgba(0,0,0,0.06)] last:shadow-none">
                  <td className={cn('max-w-[260px] truncate px-5 py-2.5 font-medium', src.trim() ? 'text-ink' : 'italic text-muted')}>{src.trim() || t('Unattributed')}</td>
                  <td className="px-3 py-2.5">
                    {/* the row's stages as one bar, its length the source's size against the largest */}
                    <div className="flex h-2 overflow-hidden rounded-full bg-black/[0.04] transition-all duration-300 ease-spring group-hover:h-2.5" style={{ width: `${Math.max(8, (total / max) * 100)}%` }}>
                      {statuses.filter((s) => st[s]).map((s) => (
                        <div key={s} className="grow h-full" title={`${t(statusLabel(s))}: ${st[s].toLocaleString()}`} style={{ width: `${(st[s] / total) * 100}%`, background: hex(s) }} />
                      ))}
                    </div>
                  </td>
                  {statuses.map((s) => (
                    <td key={s} className={cn('px-3 py-2.5 text-right tabular-nums', st[s] ? 'font-medium text-ink-2' : 'text-muted-2/60')}
                        style={st[s] && (s === 'FAILED' || s === 'FAILED_FETCH' || s === 'OCR_REQUIRED') ? { color: hex(s) } : undefined}>
                      {st[s] != null ? st[s].toLocaleString() : '—'}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink">{total.toLocaleString()}</td>
                  <td className="px-5 py-2.5 text-right">
                    <span className={cn('pill tabular-nums', mapped >= 90 ? 'bg-success-50 text-success-700' : mapped >= 50 ? 'bg-warning-50 text-warning-700' : 'bg-critical-50 text-critical-600')}>{mapped}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Footer>
        <span>{t('Generated {date} · statuses come from the pipeline database, failures included.', { date: new Date(generatedAt).toLocaleString(locale) })}</span>
        {!q.trim() && hit.length > FIRST_ROWS && (
          <button type="button" className="btn btn-sm ml-auto" onClick={() => setAllRows((v) => !v)}>
            {allRows ? t('Show fewer') : t('Show all {n}', { n: hit.length.toLocaleString() })}
          </button>
        )}
      </Footer>
    </section>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-2xs text-muted shadow-[inset_0_0.5px_0_rgba(0,0,0,0.08)]">{children}</div>;
}

export default IngestionPage;
