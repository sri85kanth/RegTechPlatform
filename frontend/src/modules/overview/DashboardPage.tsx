/**
 * The landing page — what is changing, what is critical, what needs action.
 *
 * Layout: greeting · six KPIs · calendar · regulation changes with the top
 * critical gaps under them · upcoming regulations.
 *
 * Every figure is read, never invented:
 *   /api/home                  totals and deadlines (licence expiries)
 *   /api/compliance/requirements   the work list, worst first (top critical gaps)
 *   /api/dashboard/calendar    regulations starting to bind
 * The full regulatory calendar stays one click away ("View calendar").
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FileText, ClipboardList, CheckCircle2, AlertTriangle, UserX, FileSearch, Flame, CircleAlert, Info,
  ShieldAlert,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useMe } from '@/services/authApi';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { Icon } from '@/config/icons';
import { DashboardCalendar } from './DashboardCalendar';
import { useDateLocale, useT } from '@/i18n';
import { CountUp } from '@/components/ui/motion';
import { CardLink } from './DashboardWidgets';
import { RegulationChanges } from './RegulationChanges';
import './dashboard.css';

interface Home {
  company: { name: string | null; state: string | null; city: string | null };
  applicable: number; documents: number; open_findings: number;
  totals: { checked: number; met: number; partial: number; gap: number; not_covered: number; not_assessed?: number;
            critical: number; high: number; medium: number; low: number; regulations: number };
  deadlines: { id: string; title: string; authority: string; date: string; kind: string; days_left: number; entity?: boolean }[];
}
interface GapRow {
  cri_id: string; regulation_id: string; regulation_title: string; regulator_short: string | null;
  source_clause: string | null; statement: string; risk: string | null; gap: string | null;
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const RISK: Record<string, { pill: string; tile: string; icon: typeof Flame }> = {
  CRITICAL: { pill: 'bg-critical-500 text-white', tile: 'bg-critical-50 text-critical-600', icon: Flame },
  HIGH: { pill: 'bg-notcov-600 text-white', tile: 'bg-notcov-50 text-notcov-600', icon: AlertTriangle },
  MEDIUM: { pill: 'bg-amber-400 text-amber-950', tile: 'bg-warning-50 text-warning-600', icon: CircleAlert },
  LOW: { pill: 'bg-slate-200 text-slate-700', tile: 'bg-slate-100 text-slate-500', icon: Info },
};

export function DashboardPage() {
  const navigate = useNavigate();
  // `t` below is the totals object, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();

  const home = useQuery<Home>({ queryKey: ['home'], queryFn: () => api('/api/home'), staleTime: 120_000 });
  const gaps = useQuery<{ items: GapRow[] }>({
    queryKey: ['dashboard', 'top-gaps'], queryFn: () => api('/api/compliance/requirements?applicability=reach&size=12'), staleTime: 300_000,
  });

  const h = home.data;
  const t = h?.totals;
  const checked = t?.checked ?? 0;
  const first = (me?.name ?? '').split(' ')[0];
  // `company` can be missing (no profile yet, or an older API): the greeting falls back rather than crashing the page
  const company = h?.company;
  const where = company?.city ? `${company.city}` : company?.state ?? '';

  return (
    <>
      <Topbar
        title={`${tr(greeting())}${first ? `, ${first}` : ''} 👋`}
        subtitle={company?.name
          ? tr("Here's your compliance overview for {company}{where}.", { company: company.name, where: where ? `, ${where}` : '' })
          : tr('Your compliance overview.')}
        actions={
          <span className="hidden text-sm text-muted md:inline">
            {new Date().toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        }
      />
      <div className="space-y-4 p-4 sm:p-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Kpi icon={FileText} tone="brand" n={h?.applicable} label={tr('Applicable regulations')} foot={tr('{n} assessed', { n: (t?.regulations ?? 0).toLocaleString() })} share={pct(t?.regulations ?? 0, h?.applicable ?? 0)} shareLabel={tr('assessed')} onClick={() => navigate('/applies')} />
          <Kpi icon={ClipboardList} tone="purple" n={checked} label={tr('Requirements checked')}
               foot={t?.not_assessed ? tr('{n} not yet assessed', { n: t.not_assessed.toLocaleString() }) : tr('across {n} regulations', { n: (t?.regulations ?? 0).toLocaleString() })}
               onClick={() => navigate(t?.not_assessed ? '/compliance?compliance=NOT_ASSESSED' : '/compliance')} />
          <Kpi icon={CheckCircle2} tone="green" n={t?.met} label={tr('Documented')} share={pct(t?.met ?? 0, checked)} onClick={() => navigate('/compliance?compliance=COMPLIANT')} />
          <Kpi icon={AlertTriangle} tone="amber" n={t?.partial} label={tr('Partial')} share={pct(t?.partial ?? 0, checked)} onClick={() => navigate('/compliance?compliance=PARTIALLY_COMPLIANT')} />
          <Kpi icon={UserX} tone="red" n={t?.gap} label={tr('Gaps')} share={pct(t?.gap ?? 0, checked)} onClick={() => navigate('/compliance?compliance=NON_COMPLIANT')} />
          <Kpi icon={FileSearch} tone="orange" n={t?.not_covered} label={tr('Not covered')} share={pct(t?.not_covered ?? 0, checked)} onClick={() => navigate('/compliance?compliance=EVIDENCE_MISSING')} />
        </div>

        {/* everything dated, across the whole application. On a wide screen the most critical gaps and
            the regulation changes stand beside it, together as tall as the calendar; narrower, they sit
            side by side under it, with what starts binding below. */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:[grid-template-areas:'cal_cal'_'gaps_gaps'_'up_up'] 2xl:grid-cols-[minmax(0,1fr)_380px] 2xl:[grid-template-areas:'cal_gaps'_'up_up']">
          <div className="min-w-0 xl:[grid-area:cal]"><DashboardCalendar /></div>
          {/* what changed in the regulations that apply, and under it the worst gaps */}
          <div className="relative min-w-0 xl:[grid-area:gaps]">
            <div className="flex flex-col gap-4 xl:grid xl:grid-cols-2 2xl:absolute 2xl:inset-0 2xl:flex 2xl:flex-col">
              <RegulationChanges applicable={h?.applicable} />
              <TopGaps rows={gaps.data?.items ?? []} loading={gaps.isLoading} />
            </div>
          </div>
          <div className="min-w-0 xl:[grid-area:up]"><UpcomingRegulations /></div>
        </div>
      </div>
    </>
  );
}

/** colour and weight of each risk, for the gap list's bars */
const RISK_HEX: Record<string, [string, number]> = { CRITICAL: ['#ff3b30', 100], HIGH: ['#ff6a00', 75], MEDIUM: ['#ff9f0a', 50], LOW: ['#8e8e93', 25] };

/**
 * The most critical open gaps, ranked. The panel slides in from the right, its
 * rows follow one after another, and each row's bar grows to the weight of its
 * risk, so the eye lands on the worst first.
 */
function TopGaps({ rows, loading }: { rows: GapRow[]; loading: boolean }) {
  const tr = useT();
  const navigate = useNavigate();
  return (
    <section className="dg-panel card flex min-h-0 flex-1 flex-col p-4">
      <header className="mb-2 flex items-center gap-2.5 px-1">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-critical-500 to-notcov-500 text-white shadow-[0_6px_14px_-6px_rgba(255,59,48,0.7)]">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">{tr('Top critical gaps')}</h3>
        <CardLink to="/compliance">{tr('View all')}</CardLink>
      </header>
      <ul className="-mx-1 max-h-[420px] min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1 2xl:max-h-none">
        {loading && <li className="px-2 py-3 text-[13px] text-muted">{tr('Loading…')}</li>}
        {!loading && rows.length === 0 && <li className="px-2 py-6 text-center text-[13px] text-muted">{tr('Nothing unmet')}</li>}
        {rows.map((g, i) => {
          const key = (g.risk ?? 'LOW').toUpperCase();
          const r = RISK[key] ?? RISK.LOW;
          const [hex, weight] = RISK_HEX[key] ?? RISK_HEX.LOW;
          const RI = r.icon;
          return (
            <li key={g.cri_id} className="dg-row" style={{ '--d': `${i * 70}ms`, '--rc': hex, '--sev': `${weight}%` } as React.CSSProperties}>
              <button onClick={() => navigate(`/regulation/${encodeURIComponent(g.regulation_id)}?tab=Requirements`)} className="dg-btn group">
                <span className="dg-rank">{i + 1}</span>
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-transform duration-300 group-hover:scale-110', r.tile)}><RI className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] font-semibold leading-snug text-ink">
                    {g.gap?.replace(/^.*?(GAP|PARTIAL|NOT COVERED):\s*/i, '') || g.statement}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {g.regulator_short ? `${g.regulator_short} • ` : ''}{g.regulation_title.replace(/^NABH\s+/, '')}{g.source_clause ? ` (${g.source_clause})` : ''}
                  </span>
                  <span className="dg-meter" aria-hidden="true"><i /></span>
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold', r.pill)}>{tr(cap(g.risk ?? 'Low'))}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface UpcomingReg { id: string; title: string; effective_from: string; effective_basis: string | null; applicability: string | null }
interface CalendarLite {
  upcoming?: UpcomingReg[]; today?: string;
  coverage?: { statedDate: number; immediateOnIssue: number; notStated: number; noSections: number };
}
const APPLIES_WORD: Record<string, string> = { APPLICABLE: 'Applies to us', CONDITIONAL: 'Applies · conditional' };

/**
 * Regulations that have not started binding yet, from the date in their own
 * commencement clause (the same data as the calendar). Those that apply come
 * first; the rest stay behind a link. Most regulations state no start date, so
 * the card says how much it can actually see rather than implying "nothing is
 * coming" when it finds nothing.
 */
function UpcomingRegulations() {
  const navigate = useNavigate();
  const t = useT();
  const locale = useDateLocale();
  const [showOthers, setShowOthers] = useState(false);
  const { data, isLoading, error } = useQuery<CalendarLite>({
    queryKey: ['change-calendar'], queryFn: () => api('/api/dashboard/calendar'), staleTime: 60_000,
  });
  const all = data?.upcoming ?? [];
  const applies = all.filter((r) => APPLIES_WORD[r.applicability ?? '']);
  const others = all.filter((r) => !APPLIES_WORD[r.applicability ?? '']);
  const c = data?.coverage;
  const known = (c?.statedDate ?? 0) + (c?.immediateOnIssue ?? 0);
  const total = known + (c?.notStated ?? 0) + (c?.noSections ?? 0);
  const today = new Date(`${data?.today ?? new Date().toISOString().slice(0, 10)}T00:00:00`).getTime();
  // a card that only says "nothing that applies to you is coming" earns no space on the dashboard
  if (!isLoading && !error && applies.length === 0) return null;

  const row = (r: UpcomingReg, mine: boolean) => {
    const dt = new Date(`${r.effective_from}T00:00:00`);
    const days = Math.round((dt.getTime() - today) / 86_400_000);
    const u = !mine ? URGENCY.far : days <= 7 ? URGENCY.now : days <= 30 ? URGENCY.soon : days <= 90 ? URGENCY.later : URGENCY.far;
    return (
      <li key={r.id}>
        <button onClick={() => navigate(`/regulation/${encodeURIComponent(r.id)}`)}
                className="flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-slate-50">
          <span className="w-12 shrink-0 overflow-hidden rounded-lg text-center leading-none ring-1 ring-inset ring-black/5">
            <span className={cn('block py-1 text-[11px] font-bold uppercase tracking-wide', u.band)}>
              {dt.toLocaleDateString(locale, { month: 'short' })}
            </span>
            <span className={cn('block py-1.5 text-lg font-bold', u.day)}>{dt.getDate()}</span>
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-[13px] font-medium', mine ? 'text-ink' : 'text-ink-2')} title={r.title}>{r.title}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className={cn('shrink-0 rounded px-1.5 py-px text-[11px] font-medium', mine ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-600')}>
                {t(APPLIES_WORD[r.applicability ?? ''] ?? (r.applicability === 'REVIEW_REQUIRED' ? 'Needs review' : 'Does not apply'))}
              </span>
              <span className="truncate">
                {t(r.effective_basis === 'IMMEDIATE_ON_ISSUE' ? 'Date assumed from the issue date' : 'Date stated in the regulation')} · {dt.getFullYear()}
              </span>
            </span>
          </span>
          <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold', u.pill)}>
            {days <= 0 ? t('Today') : t('{n} days', { n: days.toLocaleString() })}
          </span>
        </button>
      </li>
    );
  };

  return (
    <Card title="Upcoming regulations" icon="CalendarClock" tile="bg-teal-50 text-teal-600">
      {isLoading && <p className="py-3 text-[13px] text-muted">{t('Loading…')}</p>}
      {!!error && <p className="py-3 text-[13px] text-critical-600">{t('Could not load upcoming regulations.')}</p>}
      {data && (
        <>
          {applies.length > 0
            ? <ul className="space-y-1.5">{applies.map((r) => row(r, true))}</ul>
            : <p className="text-[13px] font-medium text-ink">{t('No upcoming regulation that applies to you has a start date on record.')}</p>}
          {others.length > 0 && (
            <>
              <button onClick={() => setShowOthers((v) => !v)} className="mt-2 text-xs font-medium text-brand-600 hover:underline">
                {others.length === 1
                  ? t(showOthers ? 'Hide 1 more that does not apply to you' : 'Show 1 more that does not apply to you')
                  : t(showOthers ? 'Hide {n} more that do not apply to you' : 'Show {n} more that do not apply to you', { n: others.length.toLocaleString() })}
              </button>
              {showOthers && <ul className="mt-1.5 space-y-1.5">{others.map((r) => row(r, false))}</ul>}
            </>
          )}
          {total > 0 && (
            <p className="mt-2 text-xs text-muted">
              {t('Start dates are known for {known} of {total} regulations in the library, so others may be coming that cannot be dated yet.', {
                known: known.toLocaleString(), total: total.toLocaleString(),
              })}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** How close a date is: red this week, amber this month, blue this quarter, slate later. */
const URGENCY = {
  now: { band: 'bg-critical-500 text-white', day: 'bg-critical-50 text-critical-700', pill: 'bg-critical-500 text-white' },
  soon: { band: 'bg-amber-400 text-amber-950', day: 'bg-warning-50 text-warning-700', pill: 'bg-amber-400 text-amber-950' },
  later: { band: 'bg-brand-600 text-white', day: 'bg-brand-50 text-brand-700', pill: 'bg-brand-50 text-brand-700' },
  far: { band: 'bg-slate-500 text-white', day: 'bg-slate-50 text-ink', pill: 'bg-slate-100 text-slate-600' },
};
function Card({ title, link, children, icon, tile }: {
  title: string; link?: [string, string | (() => void)]; children: React.ReactNode; icon?: string; tile?: string;
}) {
  const t = useT();
  return (
    <div className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-center gap-2.5">
        {icon && <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tile ?? 'bg-brand-50 text-brand-600')}><Icon name={icon} className="h-4 w-4" /></span>}
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{t(title)}</h3>
        {link && (typeof link[1] === 'string'
          ? <Link to={link[1]} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">{t(link[0])} →</Link>
          : <button onClick={link[1]} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">{t(link[0])} →</button>)}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

const KPI_TONE: Record<string, [string, string, string]> = {
  brand: ['bg-brand-50 text-brand-600', 'bg-brand-500', 'text-brand-700'],
  purple: ['bg-violet-50 text-violet-600', 'bg-violet-500', 'text-violet-700'],
  green: ['bg-success-50 text-success-600', 'bg-success-500', 'text-success-600'],
  amber: ['bg-warning-50 text-warning-600', 'bg-amber-400', 'text-warning-600'],
  red: ['bg-critical-50 text-critical-600', 'bg-red-500', 'text-critical-600'],
  orange: ['bg-notcov-50 text-notcov-600', 'bg-orange-500', 'text-notcov-600'],
};
/** KPI card: icon + number + label; underneath, the share of the whole as % and a bar. */
function Kpi({ icon: I, tone, n, label, foot, share, shareLabel, onClick }: {
  icon: typeof Flame; tone: string; n?: number; label: string; foot?: string; share?: number; shareLabel?: string; onClick?: () => void;
}) {
  const [tile, bar, text] = KPI_TONE[tone];
  return (
    <button onClick={onClick} className="card card-int flex min-h-[128px] flex-col p-4 text-left">
      <div className="flex items-start gap-3">
        <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl', tile)}><I className="h-6 w-6" /></span>
        <span className="min-w-0">
          <span className="num block text-[26px] font-semibold leading-tight text-ink">{n == null ? '—' : <CountUp value={n} />}</span>
          <span className="block text-[13px] leading-snug text-ink-2">{label}</span>
        </span>
      </div>
      <div className="mt-auto flex items-center gap-3 pt-3">
        {share != null ? (
          <>
            <span className={cn('text-sm font-bold tabular-nums', text)}>{share}%{shareLabel && <span className="ml-1 text-[11px] font-medium text-muted">{shareLabel}</span>}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <span className={cn('block h-full rounded-full transition-[width] duration-700', bar)} style={{ width: `${Math.min(100, share)}%` }} />
            </span>
          </>
        ) : <span className="text-xs text-muted">{foot}</span>}
      </div>
    </button>
  );
}

export default DashboardPage;
