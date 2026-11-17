/**
 * Compliance calendar — every dated thing the application knows about, on one
 * month grid with an agenda beside it.
 *
 * Nothing is invented; each source is read as-is:
 *   /api/dashboard/calendar        regulations coming into force (that apply), recurring
 *                                  filings (derived from the text), changes the watcher detected
 *   company records (/api/company/graph, already loaded)
 *                                  licence expiries, registration expiries, review dates
 *   /api/actions                   task due dates
 *   /api/evidence                  evidence validity / check-by dates
 *   /api/accountability/delegations  when a delegated cover ends
 * A source that fails or is not permitted for the user is simply left out.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays, ChevronLeft, ChevronRight, Scale, Send, BadgeCheck, RefreshCw, ListChecks,
  ShieldCheck, UserCog, GitCompareArrows, AlertOctagon, Gavel, ExternalLink, Check, Clock, X, ArrowRight, CalendarRange, type LucideIcon,
} from 'lucide-react';
import { api } from '@/services/http';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { useActions } from '@/services/actionsApi';
import { tx, useDateLocale, useT } from '@/i18n';
import { cn } from '@/utils/ui';
import { useLiquidPill } from '@/components/ui/motion';
import './dashboardCalendar.css';

type Cat = 'force' | 'filing' | 'licence' | 'review' | 'task' | 'evidence' | 'delegation' | 'change' | 'enforce';

interface Ev {
  key: string;
  date: string;           // YYYY-MM-DD
  cat: Cat;
  title: string;
  sub?: string;
  /** in-app route, or an http(s) link that opens in a new tab */
  to: string;
  /** true for things that lapse (expiries, task due dates): past + open = overdue */
  lapses?: boolean;
  /** a penalty amount, shown as a pill (enforcement) */
  amount?: string;
  /** the company record this date belongs to: a click opens that record, at this date */
  entityId?: string;
  /** what the date means on that record, e.g. "Registration expires" */
  fieldLabel?: string;
}
/** Categories that are deadlines: something the organisation must do or renew by a date. */
const DEADLINE_CATS = new Set<Cat>(['task', 'licence', 'filing', 'force', 'review', 'evidence', 'delegation']);

const CATS: Record<Cat, { label: string; icon: LucideIcon; dot: string; tile: string; pill: string; chipOn: string; hex: string; ink: string }> = {
  force:      { label: 'Comes into force',  icon: Scale,            dot: 'bg-teal-500',    tile: 'bg-teal-50 text-teal-600',       pill: 'border-teal-500 bg-teal-50 text-teal-800',       chipOn: 'border-teal-200 bg-teal-50 text-teal-800', hex: '#14b8a6', ink: 'text-teal-800' },
  filing:     { label: 'Filing due',        icon: Send,             dot: 'bg-sky-500',     tile: 'bg-sky-50 text-sky-600',         pill: 'border-sky-500 bg-sky-50 text-sky-800',          chipOn: 'border-sky-200 bg-sky-50 text-sky-800', hex: '#0ea5e9', ink: 'text-sky-800' },
  licence:    { label: 'Licence & registration', icon: BadgeCheck,  dot: 'bg-violet-500',  tile: 'bg-violet-50 text-violet-600',   pill: 'border-violet-500 bg-violet-50 text-violet-800', chipOn: 'border-violet-200 bg-violet-50 text-violet-800', hex: '#8b5cf6', ink: 'text-violet-800' },
  review:     { label: 'Review due',        icon: RefreshCw,        dot: 'bg-amber-500',   tile: 'bg-amber-50 text-amber-600',     pill: 'border-amber-500 bg-amber-50 text-amber-900',    chipOn: 'border-amber-200 bg-amber-50 text-amber-900', hex: '#f59e0b', ink: 'text-amber-900' },
  task:       { label: 'Task due',          icon: ListChecks,       dot: 'bg-blue-600',    tile: 'bg-blue-50 text-blue-600',       pill: 'border-blue-600 bg-blue-50 text-blue-800',       chipOn: 'border-blue-200 bg-blue-50 text-blue-800', hex: '#2563eb', ink: 'text-blue-800' },
  evidence:   { label: 'Evidence check',    icon: ShieldCheck,      dot: 'bg-emerald-500', tile: 'bg-emerald-50 text-emerald-600', pill: 'border-emerald-500 bg-emerald-50 text-emerald-800', chipOn: 'border-emerald-200 bg-emerald-50 text-emerald-800', hex: '#10b981', ink: 'text-emerald-800' },
  delegation: { label: 'Cover ends',        icon: UserCog,          dot: 'bg-indigo-500',  tile: 'bg-indigo-50 text-indigo-600',   pill: 'border-indigo-500 bg-indigo-50 text-indigo-800', chipOn: 'border-indigo-200 bg-indigo-50 text-indigo-800', hex: '#6366f1', ink: 'text-indigo-800' },
  change:     { label: 'Change detected',   icon: GitCompareArrows, dot: 'bg-rose-500',    tile: 'bg-rose-50 text-rose-600',       pill: 'border-rose-500 bg-rose-50 text-rose-800',       chipOn: 'border-rose-200 bg-rose-50 text-rose-800', hex: '#f43f5e', ink: 'text-rose-800' },
  enforce:    { label: 'Enforcement action', icon: Gavel,           dot: 'bg-orange-500',  tile: 'bg-orange-50 text-orange-600',   pill: 'border-orange-500 bg-orange-50 text-orange-800', chipOn: 'border-orange-200 bg-orange-50 text-orange-800', hex: '#f97316', ink: 'text-orange-800' },
};
const ORDER: Cat[] = ['task', 'licence', 'filing', 'force', 'review', 'evidence', 'delegation', 'change', 'enforce'];
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/* ---------------------------------------------------------------- dates -- */
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/**
 * ISO (2026-12-31…), Indian day-first (31/12/2026, 31-12-2026), or a press-release
 * style date (Sep 11, 2026 · 11 Sep 2026). Anything else is not a date.
 */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(+m[2])}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(+m[1])}`;
  return null;
}
const dayDiff = (a: string, b: string) =>
  Math.round((new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()) / 86_400_000);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/* -------------------------------------------------------------- sources -- */
interface CalDay {
  date: string;
  effective: { id: string; title: string; regulator: string | null; applies: boolean }[];
  changes: { id: string; title: string; regulator: string | null; sections: number; applies: boolean }[];
  recurring: { id: string; title: string; regulator: string | null; expression: string }[];
}
interface EvidenceRow { id: string; name: string; valid_until?: string | null; period_end?: string | null; owner_name?: string | null }
interface Delegation { id: number; from_name?: string; to_name?: string; valid_until?: string | null; revoked_at?: string | null }
interface Deadline { id: string; title: string; authority: string; date: string; kind: string; entity?: boolean }
interface Enforcement { id: string; regulator: string; title: string; entity_name: string | null; amount_fmt: string | null; announced_on: string | null; url: string }
export interface EnforcementStats { actions: number; maxAmountFmt?: string | null }

const ENTITY_DATES: { key: string; cat: Cat; label: string; lapses: boolean }[] = [
  { key: 'expiryDate', cat: 'licence', label: 'Expires', lapses: true },
  { key: 'validTill', cat: 'licence', label: 'Valid till', lapses: true },
  { key: 'registrationExpiryDate', cat: 'licence', label: 'Registration expires', lapses: true },
  { key: 'renewalDate', cat: 'licence', label: 'Renewal due', lapses: true },
  { key: 'reviewDate', cat: 'review', label: 'Review due', lapses: true },
  { key: 'nextReviewDate', cat: 'review', label: 'Review due', lapses: true },
  { key: 'dueDate', cat: 'task', label: 'Due', lapses: true },
];
const CLOSED = new Set(['Done', 'Rejected', 'Cancelled']);

function useCalendarEvents(): { events: Ev[]; loading: boolean; enfStats?: EnforcementStats } {
  const cal = useQuery<{ days?: CalDay[] }>({
    queryKey: ['change-calendar'], queryFn: () => api('/api/dashboard/calendar'), staleTime: 60_000,
  });
  // same query as the dashboard header, so it is fetched once
  const home = useQuery<{ deadlines?: Deadline[] }>({ queryKey: ['home'], queryFn: () => api('/api/home'), staleTime: 120_000 });
  const enf = useQuery<{ items: Enforcement[]; stats?: EnforcementStats }>({
    queryKey: ['calendar', 'enforcement'], queryFn: () => api('/api/enforcement?limit=200'), staleTime: 600_000, retry: false,
  });
  const entities = useData((s) => s.entities);
  const actions = useActions({});
  const evidence = useQuery<{ items: EvidenceRow[] }>({
    queryKey: ['calendar', 'evidence'], queryFn: () => api('/api/evidence?size=200'), staleTime: 300_000, retry: false,
  });
  const deleg = useQuery<{ items: Delegation[] }>({
    queryKey: ['calendar', 'delegations'], queryFn: () => api('/api/accountability/delegations?active_only=true'), staleTime: 300_000, retry: false,
  });

  const events = useMemo(() => {
    const out: Ev[] = [];
    const seen = new Set<string>();
    const push = (e: Ev, dedupeTitle = e.title) => {
      const k = `${e.date}|${norm(dedupeTitle)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(e);
    };

    // the dashboard's deadline list first: it carries the issuing authority and "renewal" wording
    for (const d of home.data?.deadlines ?? []) {
      const date = toIso(d.date);
      if (!date) continue;
      const k = d.kind.toLowerCase();
      const cat: Cat = /licen|expir|renew/.test(k) || d.entity ? 'licence' : /report|filing|return/.test(k) ? 'filing' : /force/.test(k) ? 'force' : 'review';
      const to = d.entity ? '/overview/licenses' : `/regulation/${encodeURIComponent(d.id)}`;
      push({ key: `h-${d.id}-${date}`, date, cat, title: d.title, sub: [d.kind, d.authority].filter(Boolean).join(' · '), to, lapses: cat === 'licence',
             ...(d.entity ? { entityId: d.id, fieldLabel: d.kind } : {}) },
           cat === 'filing' ? `${d.id}${d.kind.replace(/\s+reporting$/i, '')}` : cat === 'force' ? `${d.id}force` : d.title.replace(/\s+renewal$/i, ''));
    }

    for (const d of cal.data?.days ?? []) {
      for (const r of d.effective) if (r.applies)
        push({ key: `f-${r.id}-${d.date}`, date: d.date, cat: 'force', title: r.title, sub: r.regulator ?? undefined, to: `/regulation/${encodeURIComponent(r.id)}` }, `${r.id}force`);
      for (const r of d.recurring)
        push({ key: `r-${r.id}-${r.expression}-${d.date}`, date: d.date, cat: 'filing', title: r.title,
               sub: [cap(r.expression.replace(/_/g, ' ')), r.regulator].filter(Boolean).join(' · '), to: `/regulation/${encodeURIComponent(r.id)}` },
             `${r.id}${r.expression}`);
      for (const r of d.changes) if (r.applies)
        push({ key: `c-${r.id}-${d.date}`, date: d.date, cat: 'change', title: r.title,
               sub: [r.regulator, `${r.sections} section${r.sections === 1 ? '' : 's'} reworded`].filter(Boolean).join(' · '),
               to: `/regulation/${encodeURIComponent(r.id)}?tab=Updates` });
    }

    for (const e of entities) {
      for (const f of ENTITY_DATES) {
        const date = toIso(e.attrs?.[f.key]);
        if (!date) continue;
        const to = f.cat === 'licence' && e.domain === 'overview' ? '/overview/licenses' : e.domain === 'overview' ? '/overview' : `/${e.domain}`;
        push({ key: `e-${e.id}-${f.key}`, date, cat: f.cat, title: e.name, sub: f.label, to, lapses: f.lapses, entityId: e.id, fieldLabel: f.label }, e.name);
      }
    }

    for (const a of actions.data?.items ?? []) {
      const date = toIso(a.due_date);
      if (!date || CLOSED.has(a.status)) continue;
      push({ key: `t-${a.id}`, date, cat: 'task', title: a.title,
             sub: [a.status, a.owner_name ?? 'No owner'].join(' · '), to: '/actions', lapses: true });
    }

    for (const ev of evidence.data?.items ?? []) {
      const date = toIso(ev.valid_until) ?? toIso(ev.period_end);
      if (!date) continue;
      push({ key: `v-${ev.id}`, date, cat: 'evidence', title: ev.name,
             sub: ev.valid_until ? 'Validity ends' : 'Check by', to: '/evidence', lapses: true }, ev.name);
    }

    for (const d of deleg.data?.items ?? []) {
      const date = toIso(d.valid_until);
      if (!date || d.revoked_at) continue;
      push({ key: `d-${d.id}`, date, cat: 'delegation', title: `${d.from_name ?? '—'} → ${d.to_name ?? '—'}`,
             sub: 'Delegated cover ends', to: '/governance' });
    }

    for (const x of enf.data?.items ?? []) {
      const date = toIso(x.announced_on);
      if (!date) continue;
      push({ key: `x-${x.id}`, date, cat: 'enforce', title: x.entity_name || x.title,
             sub: `${x.regulator} penalty`, to: x.url, amount: x.amount_fmt ?? undefined }, `${x.id}`);
    }

    return out.sort((a, b) => a.date.localeCompare(b.date) || ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat));
  }, [home.data, cal.data, entities, actions.data, evidence.data, deleg.data, enf.data]);

  return { events, loading: cal.isLoading || home.isLoading, enfStats: enf.data?.stats };
}

const isExternal = (to: string) => /^https?:\/\//i.test(to);
/** the at-a-glance tabs: each one is also a list in the agenda */
type Glance = 'overdue' | 'upcoming' | 'penalties';
type View = 'month' | 'week' | 'agenda';
/** a list in the agenda: one month, or a stretch of time ahead (next 7 days, 8–30 days…) */
interface Group { key: string; kind: 'month' | 'band'; items: Ev[]; label?: string; icon?: LucideIcon; hex?: string }
/** Upcoming is one list, cut into stretches — each one the old 7 / 30 / 90-day view, without repeating the nearer ones */
const BANDS: { key: string; label: string; icon: LucideIcon; hex: string; from: number; to: number }[] = [
  { key: 'b7', label: tx('Next 7 days'), icon: Clock, hex: '#f59e0b', from: 0, to: 7 },
  { key: 'b30', label: tx('In 8–30 days'), icon: CalendarDays, hex: '#0071e3', from: 8, to: 30 },
  { key: 'b90', label: tx('In 31–90 days'), icon: CalendarRange, hex: '#6366f1', from: 31, to: 90 },
  { key: 'later', label: tx('Later'), icon: ListChecks, hex: '#14b8a6', from: 91, to: Infinity },
];
/** a busy day's list, anchored to what was clicked (an item itself opens straight away) */
type Pop = { kind: 'day'; iso: string; at: DOMRect } | null;
/** a CSS variable bag (colour, stagger delay) */
const vars = (v: Record<string, string | number>) => v as CSSProperties;
const LATE_HEX = '#ef4444';
const mondayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Once per page load (a sign-in or a reload), 20 s after the calendar appears, the
 * at-a-glance tabs show themselves one after another — Overdue, Upcoming, Penalties —
 * then the month comes back, so a reader learns what each tab holds without hunting.
 * It never fights the reader: any click, key or scroll in the calendar stops it where
 * it is, it waits until the calendar is on screen, and reduced motion skips it.
 */
let toured = false;
const TOUR_AFTER_MS = 20_000;
const TOUR_STEP_MS = 3_500;
const TOUR: Glance[] = ['overdue', 'upcoming', 'penalties'];

/* ------------------------------------------------------------ component -- */
export function DashboardCalendar() {
  const t = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const openEntity = useUi((s) => s.openEntity);
  const { events, loading, enfStats } = useCalendarEvents();
  const today = isoOf(new Date());
  // the day the view is anchored on: its month for Month, its Monday-to-Sunday for Week
  const [cursor, setCursor] = useState(() => new Date());
  // which way the view moved, so the new month or week slides in from that side
  const [dir, setDir] = useState<-1 | 0 | 1>(0);
  const [view, setView] = useState<View>('month');
  const [picked, setPicked] = useState<string | null>(null);
  const [glance, setGlance] = useState<Glance>('upcoming');
  const [hidden, setHidden] = useState<Set<Cat>>(new Set());
  const [pop, setPop] = useState<Pop>(null);
  const root = useRef<HTMLElement>(null);

  // the one-time tour of the at-a-glance tabs (see `toured` above)
  useEffect(() => {
    const el = root.current;
    if (toured || !el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timers: number[] = [];
    let stopped = false;
    let seen: IntersectionObserver | null = null;
    const stop = () => { stopped = true; timers.forEach((t) => window.clearTimeout(t)); seen?.disconnect(); };
    const play = () => {
      if (stopped || toured) return;
      toured = true;
      TOUR.forEach((g, i) => timers.push(window.setTimeout(() => { setGlance(g); setView('agenda'); setPop(null); }, i * TOUR_STEP_MS)));
      timers.push(window.setTimeout(() => { setGlance('upcoming'); setView('month'); }, TOUR.length * TOUR_STEP_MS));
    };
    const onScreen = () => { const b = el.getBoundingClientRect(); return b.top < window.innerHeight - 120 && b.bottom > 120; };
    timers.push(window.setTimeout(() => {
      if (stopped) return;
      if (document.visibilityState === 'visible' && onScreen()) { play(); return; }
      // not in view yet: start once the reader scrolls it into view
      seen = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { seen?.disconnect(); timers.push(window.setTimeout(play, 800)); } }, { threshold: 0.35 });
      seen.observe(el);
    }, TOUR_AFTER_MS));
    // the reader's own hand always wins
    const opts = { capture: true, passive: true } as const;
    el.addEventListener('pointerdown', stop, opts);
    el.addEventListener('keydown', stop, opts);
    el.addEventListener('wheel', stop, opts);
    return () => {
      stop();
      el.removeEventListener('pointerdown', stop, opts);
      el.removeEventListener('keydown', stop, opts);
      el.removeEventListener('wheel', stop, opts);
    };
  }, []);

  const visible = useMemo(() => events.filter((e) => !hidden.has(e.cat)), [events, hidden]);
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of visible) { const l = m.get(e.date); if (l) l.push(e); else m.set(e.date, [e]); }
    return m;
  }, [visible]);
  const catCounts = useMemo(() => {
    const c = {} as Record<Cat, number>;
    for (const e of events) c[e.cat] = (c[e.cat] ?? 0) + 1;
    return c;
  }, [events]);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthKey = isoOf(monthStart).slice(0, 7);
  const weekStart = mondayOf(cursor);
  const weekKey = isoOf(weekStart);
  // 6×7 grid for the month, weeks start on Monday
  const monthCells = useMemo(() => {
    const s = mondayOf(monthStart);
    return Array.from({ length: 42 }, (_, i) => addDays(s, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekKey]);

  // headline numbers: deadlines still ahead, plus what has already lapsed
  const ahead = visible.filter((e) => DEADLINE_CATS.has(e.cat));
  const overdue = visible.filter((e) => e.lapses && e.date < today);
  const deadlinesAll = ahead.filter((e) => e.date >= today);
  const enforceList = useMemo(() => visible.filter((e) => e.cat === 'enforce').reverse(), [visible]);
  const enfRecent = enforceList.filter((e) => dayDiff(today, e.date) <= 90).length;
  const fmtLong = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const monthName = monthStart.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const weekRange = `${weekDays[0].toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${weekDays[6].toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const inView = (iso: string) => (view === 'week' ? iso >= weekKey && iso <= isoOf(weekDays[6]) : iso.startsWith(monthKey));
  const viewEmpty = !visible.some((e) => inView(e.date));
  const nextDated = visible.find((e) => e.date > (view === 'week' ? isoOf(weekDays[6]) : `${monthKey}-31`));

  /** the agenda's lists */
  const groups = useMemo((): Group[] => {
    const group = (list: Ev[], key: (e: Ev) => string, kind: Group['kind']): Group[] => {
      const m = new Map<string, Ev[]>();
      for (const e of list) { const k = key(e); const l = m.get(k); if (l) l.push(e); else m.set(k, [e]); }
      return [...m.entries()].map(([k, items]) => ({ key: k, kind, items }));
    };
    if (glance === 'overdue') return group([...overdue].reverse(), (e) => e.date.slice(0, 7), 'month');
    if (glance === 'penalties') return group(enforceList, (e) => e.date.slice(0, 7), 'month');
    return BANDS.map((b) => ({ key: b.key, kind: 'band' as const, label: b.label, icon: b.icon, hex: b.hex,
      items: deadlinesAll.filter((e) => { const d = dayDiff(e.date, today); return d >= b.from && d <= b.to; }) }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glance, visible, today]);

  /** an item opens what it is about: its own record (at this date), its regulation, or the press release */
  const open = (e: Ev) => {
    setPop(null);
    if (e.entityId) openEntity(e.entityId, { date: e.date, label: e.fieldLabel ?? CATS[e.cat].label, lapses: e.lapses });
    else if (isExternal(e.to)) window.open(e.to, '_blank', 'noopener,noreferrer');
    else navigate(e.to);
  };
  const moveTo = (d: Date) => {
    const a = view === 'week' ? isoOf(mondayOf(d)) : isoOf(d).slice(0, 7);
    const b = view === 'week' ? weekKey : monthKey;
    setDir(a > b ? 1 : a < b ? -1 : 0);
    setCursor(d);
    setPop(null);
  };
  const step = (n: number) => moveTo(view === 'week' ? addDays(cursor, 7 * n) : new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const toggle = (c: Cat) => setHidden((h) => { const n = new Set(h); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const showAgenda = (g: Glance) => { setGlance(g); setView('agenda'); setPop(null); };
  const pickDay = (iso: string) => { setPicked(iso); moveTo(new Date(`${iso}T00:00:00`)); if (view === 'agenda') setView('month'); };
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'short' }));
  const popAt = (el: HTMLElement) => el.getBoundingClientRect();

  // the view switch and the agenda tabs: a liquid pill slides to the chosen one
  const viewBox = useRef<HTMLDivElement>(null);
  const viewPill = useLiquidPill(viewBox, '[aria-checked="true"]', 'x', [view]);
  const glBox = useRef<HTMLDivElement>(null);
  const glPill = useLiquidPill(glBox, '[aria-selected="true"]', 'x', [glance, view]);
  const slide = dir === 1 ? 'dc-in-next' : dir === -1 ? 'dc-in-prev' : 'dc-in';
  const isWeek = view === 'week';
  let stagger = 0;

  // [id, label, icon, colour, number colour, count, full name (tooltip, agenda heading)]
  const GLANCES: [Glance, string, LucideIcon, string, string, number, string?][] = [
    ['overdue', t('Overdue'), AlertOctagon, '#ef4444', '#d70015', overdue.length, t('Overdue or expired')],
    ['upcoming', t('Upcoming'), CalendarRange, '#0071e3', '#0062c4', deadlinesAll.length, t('Upcoming deadlines')],
    ['penalties', t('Penalties'), Gavel, '#f97316', '#c24f00', enfRecent, t('Penalties · 90 days')],
  ];
  const glanceOf = GLANCES.find((g) => g[0] === glance)!;

  return (
    <section ref={root} className="card overflow-hidden p-0">
      {/* at a glance: a tab bar, always in view; each tab opens its list in the agenda */}
      <div className="border-b border-line bg-gradient-to-b from-slate-50 to-white px-3 py-2.5">
        <div ref={glBox} role="tablist" aria-label={t('At a glance')}
             className="relative flex gap-1 overflow-x-auto rounded-2xl bg-slate-100/90 p-1 [scrollbar-width:none]">
          <span aria-hidden="true" className="liquid-pill top-1 bottom-1 rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.07)]" style={glPill} />
          {GLANCES.map(([id, label, I, hex, ink, n, full], i) => {
            const on = view === 'agenda' && glance === id;
            return (
              <button key={id} role="tab" aria-selected={on} onClick={() => showAgenda(id)} title={full ?? label}
                      style={vars({ '--c': hex, '--ci': ink, '--d': `${i * 50}ms` })} className={cn('dc-gtab dc-rise group', n === 0 && 'dc-zero')}>
                <span className="dc-gicon"><I className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 truncate">{label}</span>
                {id === 'overdue' && n > 0 && <span className="dc-gdot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[252px_minmax(0,1fr)]">
        {/* ------------------------------------------------ sidebar */}
        <aside className="border-b border-line bg-gradient-to-b from-slate-50/80 to-white p-4 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_4px_12px_-4px_rgba(0,113,227,0.6)]">
              <CalendarDays className="h-4 w-4" />
            </span>
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">{t('Compliance calendar')}</h3>
          </div>
          <p key={monthKey} className={cn('mt-4 text-[26px] font-bold leading-none tracking-tight text-ink', slide)}>{monthName}</p>
          <p className="mt-1.5 text-[11.5px] leading-snug text-muted">{t('Deadlines, filings, licences, reviews, tasks, evidence and enforcement — in one place.')}</p>

          <MiniMonth cursor={cursor} today={today} picked={picked} byDay={byDay} weekdays={weekdays}
                     weekKey={view === 'week' ? weekKey : null} onPick={pickDay} onStep={step} locale={locale} />

          <h4 className="mb-1.5 mt-5 text-[12px] font-semibold text-ink">{t('My calendars')}</h4>
          <ul className="space-y-0.5">
            {ORDER.map((c) => {
              const k = CATS[c]; const on = !hidden.has(c);
              return (
                <li key={c}>
                  <button onClick={() => toggle(c)} role="checkbox" aria-checked={on} title={on ? t('Hide') : t('Show')} style={vars({ '--c': k.hex })}
                          className="dc-check group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-[12.5px] transition hover:bg-white">
                    <span className="dc-box grid h-4 w-4 shrink-0 place-items-center rounded-[5px]"><Check className="h-3 w-3" strokeWidth={3} /></span>
                    <span className={cn('min-w-0 flex-1 truncate', on ? 'text-ink-2' : 'text-muted line-through')}>{t(k.label)}</span>
                    <span className="tabular-nums text-[11px] text-muted">{catCounts[c] ?? 0}</span>
                  </button>
                </li>
              );
            })}
          </ul>

        </aside>

        {/* ------------------------------------------------ main */}
        <div className="flex min-w-0 flex-col">
          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            {view !== 'agenda' && (<>
              <div className="flex items-center gap-1">
                <button onClick={() => step(-1)} aria-label={t(isWeek ? 'Previous week' : 'Previous month')}
                        className="grid h-8 w-8 place-items-center rounded-full bg-white text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.08)] transition hover:text-ink active:scale-90"><ChevronLeft className="h-4 w-4" /></button>
                <button onClick={() => step(1)} aria-label={t(isWeek ? 'Next week' : 'Next month')}
                        className="grid h-8 w-8 place-items-center rounded-full bg-white text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.08)] transition hover:text-ink active:scale-90"><ChevronRight className="h-4 w-4" /></button>
              </div>
              <button onClick={() => { setPicked(null); moveTo(new Date()); }}
                      className="h-8 rounded-full bg-white px-3.5 text-xs font-semibold text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.08)] transition hover:text-ink active:scale-95">{t('Today')}</button>
              <span key={`${view}-${view === 'week' ? weekKey : monthKey}`} className={cn('ml-1 text-[15px] font-semibold tracking-tight text-ink', slide)}>
                {view === 'week' ? weekRange : monthName}
              </span>
            </>)}
            {view === 'agenda' && (
              <span key={glance} className="dc-in flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink">
                <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${glanceOf[3]} 14%, white)`, color: glanceOf[3] }}>
                  {(() => { const I = glanceOf[2]; return <I className="h-4 w-4" />; })()}
                </span>
                {glanceOf[6] ?? glanceOf[1]}
                <span className="rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums text-white" style={{ background: glanceOf[3] }}>{glanceOf[5]}</span>
              </span>
            )}
            {/* Month · Week · Agenda */}
            <div ref={viewBox} role="radiogroup" aria-label={t('Calendar view')} className="relative ml-auto flex items-center gap-0.5 rounded-full bg-slate-100 p-1">
              <span aria-hidden="true" className="liquid-pill top-1 bottom-1 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.06)]" style={viewPill} />
              {([['month', t('Month')], ['week', t('Week')], ['agenda', t('Agenda')]] as [View, string][]).map(([v, l]) => (
                <button key={v} role="radio" aria-checked={view === v} onClick={() => { setView(v); setDir(0); setPop(null); }}
                        className={cn('relative z-[1] rounded-full px-3.5 py-1 text-[12px] font-semibold transition-colors', view === v ? 'text-ink' : 'text-muted hover:text-ink')}>{l}</button>
              ))}
            </div>
          </div>

          {/* ---------------- month */}
          {view === 'month' && (<>
            <div className="grid grid-cols-7 border-b border-line">
              {weekdays.map((w, i) => (
                <span key={w} className={cn('py-2 text-center text-[11px] font-semibold uppercase tracking-wider', i >= 5 ? 'text-slate-400' : 'text-slate-500')}>{w}</span>
              ))}
            </div>
            <div key={monthKey} className={cn('grid flex-1 grid-cols-7 grid-rows-6', slide)}>
              {monthCells.map((d, i) => {
                const iso = isoOf(d);
                const inMonth = d.getMonth() === monthStart.getMonth();
                const list = byDay.get(iso) ?? [];
                const isToday = iso === today;
                const late = list.some((e) => e.lapses && iso < today);
                const weekend = i % 7 >= 5;
                const shown = list.length > 3 ? list.slice(0, 2) : list;
                const tint = late ? LATE_HEX : list[0] ? CATS[list[0].cat].hex : undefined;
                return (
                  <div key={iso} role="button" tabIndex={0}
                       onClick={(ev) => { setPicked(iso); if (list.length) setPop({ kind: 'day', iso, at: popAt(ev.currentTarget) }); }}
                       onKeyDown={(ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && list.length) { ev.preventDefault(); setPop({ kind: 'day', iso, at: popAt(ev.currentTarget) }); } }}
                       aria-label={list.length ? `${fmtLong(iso)} · ${list.map((e) => e.title).join(', ')}` : fmtLong(iso)}
                       style={vars({ '--d': `${Math.floor(i / 7) * 45 + (i % 7) * 20}ms`, ...(tint ? { '--c': tint } : {}) })}
                       className={cn('dc-cell relative flex min-h-[64px] cursor-pointer flex-col gap-1 border-line p-1.5 sm:min-h-[104px]',
                         i % 7 !== 6 && 'border-r', i < 35 && 'border-b', weekend && !list.length && 'bg-slate-50/50',
                         list.length > 0 && 'dc-has', late && 'dc-late', picked === iso && 'dc-sel', isToday && 'dc-today', !inMonth && 'dc-out')}>
                    <span className="flex items-center justify-between gap-1">
                      <span className={cn('dc-num grid h-6 min-w-[1.5rem] place-items-center rounded-full px-1 text-xs tabular-nums',
                        isToday ? 'bg-brand-600 font-bold text-white shadow-sm'
                          : !inMonth ? 'font-medium text-slate-300'
                          : list.length ? 'font-bold text-ink' : weekend ? 'font-semibold text-slate-400' : 'font-semibold text-ink-2')}>{d.getDate()}</span>
                      {late ? <span className="dc-badge dc-badge-late" title={t('Overdue or expired')}>!</span>
                        : list.length > 1 && <span className="dc-badge">{list.length}</span>}
                    </span>
                    <span className="hidden min-w-0 flex-col gap-[3px] sm:flex">
                      {shown.map((e, j) => (
                        <button key={e.key} type="button" title={`${t(CATS[e.cat].label)} · ${e.title}`} style={vars({ '--c': CATS[e.cat].hex, '--j': j })}
                                onClick={(ev) => { ev.stopPropagation(); open(e); }}
                                className={cn('dc-chip text-left', CATS[e.cat].ink)}>
                          <span className={list.length === 1 ? 'line-clamp-2' : 'truncate'}>{e.title}</span>
                        </button>
                      ))}
                      {list.length > 3 && <span className="dc-more" style={vars({ '--j': 2 })}>+{list.length - 2} {t('more')}</span>}
                    </span>
                    {list.length > 0 && (
                      <span className="mt-auto flex flex-wrap gap-0.5 sm:hidden">
                        {[...new Set(list.map((e) => e.cat))].slice(0, 4).map((c) => <span key={c} className={cn('h-1.5 w-1.5 rounded-full', CATS[c].dot)} />)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </>)}

          {/* ---------------- week: big day headings, each day's items as cards */}
          {view === 'week' && (
            <div key={weekKey} className={cn('grid flex-1 grid-cols-7', slide)}>
              {weekDays.map((d, i) => {
                const iso = isoOf(d);
                const list = byDay.get(iso) ?? [];
                const isToday = iso === today;
                const weekend = i >= 5;
                return (
                  <div key={iso} className={cn('flex min-h-[460px] min-w-0 flex-col border-line', i < 6 && 'border-r', isToday ? 'bg-brand-50/40' : weekend && 'bg-slate-50/50', picked === iso && 'dc-wsel')}>
                    <button type="button" onClick={() => { setPicked(iso); if (list.length) setPop({ kind: 'day', iso, at: popAt(document.getElementById(`dc-w-${iso}`) ?? document.body) }); }}
                            id={`dc-w-${iso}`} className="border-b border-line px-1 py-3 text-center transition hover:bg-slate-50">
                      <span className={cn('block text-[11px] font-semibold uppercase tracking-wider', isToday ? 'text-brand-600' : weekend ? 'text-slate-400' : 'text-slate-500')}>{weekdays[i]}</span>
                      <span className={cn('mt-0.5 block text-[26px] font-semibold leading-none tabular-nums', isToday ? 'text-brand-600' : weekend ? 'text-slate-400' : 'text-ink')}>{d.getDate()}</span>
                      {isToday && <span className="mx-auto mt-1.5 block h-1 w-6 rounded-full bg-brand-600" />}
                    </button>
                    <div className="flex flex-1 flex-col gap-2 p-1.5">
                      {list.map((e, j) => <WeekCard key={e.key} e={e} today={today} delay={i * 50 + j * 70}
                                                    onClick={() => open(e)} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* nothing in this month / week: point to the next dated thing */}
          {view !== 'agenda' && (loading || viewEmpty) && (
            <div className="border-t border-line px-4 py-2.5 text-xs text-muted">
              {loading ? t('Loading…') : (<>
                {t(isWeek ? 'Nothing this week.' : 'Nothing dated in this month.')}{' '}
                {nextDated && (
                  <button onClick={() => { setPicked(nextDated.date); moveTo(new Date(`${nextDated.date}T00:00:00`)); }} className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline">
                    {t('Next: {title} on {date}', { title: nextDated.title, date: fmtLong(nextDated.date) })} <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </>)}
            </div>
          )}

          {/* ---------------- agenda: upcoming · every deadline · enforcement */}
          {view === 'agenda' && (
            <div key={glance} className="max-h-[720px] min-h-[460px] flex-1 space-y-4 overflow-y-auto overscroll-contain bg-gradient-to-b from-slate-50/70 to-white p-4">
              {/* something has already lapsed: say so on every list but its own */}
              {glance !== 'overdue' && glance !== 'penalties' && overdue.length > 0 && (
                <button onClick={() => setGlance('overdue')}
                        className="dc-rise flex w-full items-center gap-2 rounded-2xl bg-gradient-to-r from-critical-50 to-white px-3.5 py-2.5 text-left text-xs font-semibold text-critical-700 shadow-[0_0_0_1px_rgba(239,68,68,0.2)] transition hover:shadow-[0_0_0_1px_rgba(239,68,68,0.4),0_6px_18px_-10px_rgba(239,68,68,0.5)]">
                  <AlertOctagon className="h-4 w-4" />{t('Overdue or expired')}
                  <span className="rounded-full bg-critical-500 px-1.5 text-[10.5px] font-bold tabular-nums text-white">{overdue.length}</span>
                  <ArrowRight className="ml-auto h-4 w-4" />
                </button>
              )}
              {glance === 'penalties' && (
                <div className="dc-rise rounded-2xl bg-gradient-to-br from-orange-50 to-white px-3.5 py-2.5 text-xs text-orange-900 shadow-[0_0_0_1px_rgba(249,115,22,0.18)]">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <Gavel className="h-3.5 w-3.5" />
                    {t('{n} penalties imposed by regulators', { n: (enfStats?.actions ?? enforceList.length).toLocaleString() })}
                    {enfStats?.maxAmountFmt ? ` · ${t('largest {amount}', { amount: enfStats.maxAmountFmt })}` : ''}
                  </p>
                  <p className="mt-1 leading-relaxed text-orange-800/80">{t('From the regulators’ own press releases. They show what regulators are acting on — not penalties against us.')}</p>
                </div>
              )}
              {groups.length === 0 && (
                <div className="dc-rise grid place-items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-white px-3 py-10 text-center text-[13px] text-muted">
                  <CalendarDays className="h-6 w-6 text-slate-300" />
                  {glance === 'penalties' ? t('No enforcement actions on record.') : glance === 'overdue' ? t('Nothing is overdue.') : t('No future deadlines on record.')}
                </div>
              )}
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="dc-rise mb-2 flex items-center gap-2.5" style={vars({ '--d': `${stagger * 45}ms` })}>
                    {g.kind === 'band' && g.icon ? (
                      <span className="flex items-center gap-2">
                        <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${g.hex} 14%, white)`, color: g.hex }}>
                          <g.icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-[12.5px] font-semibold text-ink">{t(g.label ?? '')}</span>
                      </span>
                    ) : (
                      <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                        {new Date(`${g.key}-01T00:00:00`).toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
                      </span>
                    )}
                    <span className="h-px flex-1 bg-slate-200" />
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)]">{g.items.length}</span>
                  </div>
                  <ul className="grid gap-2 xl:grid-cols-2">
                    {g.items.map((e) => <AgendaItem key={e.key} e={e} today={today} showDate locale={locale} delay={stagger++ * 45}
                                                    onClick={() => open(e)} />)}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {pop && (
        <Popover at={pop.at} onClose={() => setPop(null)}>
          <DayList iso={pop.iso} items={byDay.get(pop.iso) ?? []} today={today} locale={locale} fmtLong={fmtLong} onClose={() => setPop(null)}
                   onPick={open} />
        </Popover>
      )}
    </section>
  );
}

/** "Today", "Tomorrow", "in 29 days", "14 days ago" */
function whenText(t: ReturnType<typeof useT>, d: number) {
  return d === 0 ? t('Today') : d === 1 ? t('Tomorrow') : d > 0 ? t('in {n} days', { n: d.toLocaleString() }) : t('{n} days ago', { n: (-d).toLocaleString() });
}
/** the colour and wording of an item's "when": late, soon, later */
function useWhen(e: Ev, today: string) {
  const t = useT();
  const d = dayDiff(e.date, today);
  const late = !!e.lapses && d < 0;
  const cls = e.amount ? 'bg-orange-100 text-orange-800'
    : late ? 'bg-critical-500 text-white shadow-[0_2px_8px_-2px_rgba(239,68,68,0.6)]'
    : d < 0 ? 'bg-slate-100 text-slate-500'
    : d <= 7 ? 'bg-amber-400 text-amber-950'
    : d <= 30 ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600';
  return { late, cls, text: e.amount ? e.amount : late ? t('{n} days late', { n: (-d).toLocaleString() }) : whenText(t, d) };
}

/** a small month to jump around with: a dot under each day that has something on it */
function MiniMonth({ cursor, today, picked, byDay, weekdays, weekKey, onPick, onStep, locale }: {
  cursor: Date; today: string; picked: string | null; byDay: Map<string, Ev[]>; weekdays: string[]; weekKey: string | null;
  onPick: (iso: string) => void; onStep: (n: number) => void; locale?: string;
}) {
  const t = useT();
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = mondayOf(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weekEnd = weekKey ? isoOf(addDays(new Date(`${weekKey}T00:00:00`), 6)) : null;
  return (
    <div className="mt-4 rounded-2xl bg-white p-2.5 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.04)]">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[12px] font-semibold text-ink">{first.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</span>
        <span className="flex gap-0.5">
          <button onClick={() => onStep(-1)} aria-label={t('Previous month')} className="grid h-6 w-6 place-items-center rounded-full text-muted transition hover:bg-slate-100 hover:text-ink"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <button onClick={() => onStep(1)} aria-label={t('Next month')} className="grid h-6 w-6 place-items-center rounded-full text-muted transition hover:bg-slate-100 hover:text-ink"><ChevronRight className="h-3.5 w-3.5" /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center">
        {weekdays.map((w) => <span key={w} className="pb-1 text-[9.5px] font-semibold uppercase text-slate-400">{w.slice(0, 1)}</span>)}
        {days.map((d) => {
          const iso = isoOf(d);
          const inMonth = d.getMonth() === first.getMonth();
          const list = byDay.get(iso) ?? [];
          const inWeek = !!weekKey && iso >= weekKey && iso <= weekEnd!;
          return (
            <button key={iso} onClick={() => onPick(iso)} aria-label={iso}
                    className={cn('relative mx-auto my-[1px] grid h-7 w-7 place-items-center rounded-full text-[11px] tabular-nums transition',
                      iso === today ? 'bg-brand-600 font-bold text-white shadow-sm'
                        : picked === iso ? 'bg-brand-50 font-bold text-brand-700 ring-1 ring-brand-300'
                        : inWeek ? 'bg-brand-50/70 text-brand-700'
                        : inMonth ? 'text-ink-2 hover:bg-slate-100' : 'text-slate-300 hover:bg-slate-50')}>
              {d.getDate()}
              {list.length > 0 && iso !== today && (
                <span className="absolute bottom-[3px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full" style={{ background: list.some((e) => e.lapses && iso < today) ? LATE_HEX : CATS[list[0].cat].hex }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** a page-of-a-desk-calendar: the month on a coloured band, the day under it */
function DateTile({ iso, locale, big, hex }: { iso: string; locale?: string; big?: boolean; hex?: string }) {
  const dt = new Date(`${iso}T00:00:00`);
  return (
    <span className={cn('shrink-0 overflow-hidden rounded-lg bg-white text-center leading-none shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]', big ? 'w-12' : 'w-10')}>
      <span className={cn('block py-[3px] font-bold uppercase tracking-wide text-white', big ? 'text-[10px]' : 'text-[9px]')} style={{ background: hex ?? '#0071e3' }}>
        {dt.toLocaleDateString(locale, { month: 'short' })}
      </span>
      <span className={cn('block font-bold tabular-nums text-ink', big ? 'py-1.5 text-lg' : 'py-1 text-[15px]')}>{dt.getDate()}</span>
    </span>
  );
}

/** an item in the week: a tinted card with its colour along the top, its icon, title and when */
function WeekCard({ e, today, delay, onClick }: { e: Ev; today: string; delay: number; onClick: (el: HTMLElement) => void }) {
  const t = useT();
  const k = CATS[e.cat];
  const I = k.icon;
  const w = useWhen(e, today);
  return (
    <button type="button" onClick={(ev) => onClick(ev.currentTarget)} title={e.title}
            style={vars({ '--c': w.late ? LATE_HEX : k.hex, '--d': `${delay}ms` })} className="dc-wcard dc-rise group">
      <span className="flex items-center gap-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/90 shadow-sm" style={{ color: k.hex }}><I className="h-3.5 w-3.5" /></span>
        <span className={cn('min-w-0 truncate text-[10px] font-bold uppercase tracking-wide', k.ink)}>{t(k.label)}</span>
      </span>
      <span className={cn('mt-1.5 line-clamp-3 text-[12px] font-semibold leading-snug', k.ink)}>{e.title}</span>
      {e.sub && <span className="mt-0.5 line-clamp-1 text-[10.5px] text-ink-2/80">{t(e.sub)}</span>}
      <span className={cn('mt-1.5 inline-block self-start whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold', w.cls)}>{w.text}</span>
    </button>
  );
}

/** an item in the agenda: a card with an accent edge in its colour */
function AgendaItem({ e, today, onClick, showDate, locale, delay = 0 }: { e: Ev; today: string; onClick: (el: HTMLElement) => void; showDate?: boolean; locale?: string; delay?: number }) {
  const t = useT();
  const k = CATS[e.cat];
  const I = k.icon;
  const w = useWhen(e, today);
  return (
    <li className="dc-rise" style={vars({ '--d': `${delay}ms`, '--c': w.late ? LATE_HEX : k.hex })}>
      <button onClick={(ev) => onClick(ev.currentTarget)} className="dc-item group">
        {showDate ? <DateTile iso={e.date} locale={locale} hex={k.hex} /> : (
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-300 group-hover:scale-110', k.tile)}><I className="h-[18px] w-[18px]" /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-1">
            <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink" title={e.title}>{e.title}</span>
            {isExternal(e.to) && <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted" />}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-semibold', k.tile)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', k.dot)} />{t(k.label)}
            </span>
            {e.sub && <span className="min-w-0 truncate text-muted">{t(e.sub)}</span>}
          </span>
        </span>
        <span className={cn('shrink-0 self-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', w.cls)}>{w.text}</span>
      </button>
    </li>
  );
}

/**
 * A card that opens next to what was clicked (below it, or above when there is
 * no room), over everything; a click outside, Esc or scrolling the page closes it.
 */
function Popover({ at, onClose, children }: { at: DOMRect; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, { passive: true });
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('scroll', onClose); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  const W = 320;
  const left = Math.min(Math.max(12, at.left + at.width / 2 - W / 2), window.innerWidth - W - 12);
  const below = window.innerHeight - at.bottom > 340 || at.top < 340;
  const style: CSSProperties = below ? { left, top: at.bottom + 8, width: W } : { left, bottom: window.innerHeight - at.top + 8, width: W };
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="false" className={cn('dc-pop fixed z-[61] overflow-hidden rounded-2xl bg-white shadow-float', below ? 'origin-top' : 'origin-bottom')} style={style}>
        {children}
      </div>
    </>,
    document.body,
  );
}

/** a busy day: everything on it, each opening what it is about */
function DayList({ iso, items, today, locale, fmtLong, onPick, onClose }: {
  iso: string; items: Ev[]; today: string; locale?: string; fmtLong: (iso: string) => string; onPick: (e: Ev) => void; onClose: () => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <DateTile iso={iso} locale={locale} big />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">{fmtLong(iso)}</p>
          <p className="text-xs text-muted">{whenText(t, dayDiff(iso, today))}</p>
        </div>
        <button onClick={onClose} aria-label={t('Close')} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition hover:bg-slate-100 hover:text-ink"><X className="h-4 w-4" /></button>
      </div>
      <ul className="max-h-[300px] space-y-1.5 overflow-y-auto border-t border-line p-2.5">
        {items.map((e, i) => {
          const k = CATS[e.cat];
          const I = k.icon;
          return (
            <li key={e.key} className="dc-rise" style={vars({ '--d': `${i * 40}ms`, '--c': k.hex })}>
              <button onClick={() => onPick(e)} className="dc-item group !py-2">
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', k.tile)}><I className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] font-semibold leading-snug text-ink">{e.title}</span>
                  <span className="block truncate text-[11px] text-muted">{t(k.label)}{e.sub ? ` · ${t(e.sub)}` : ''}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 self-center text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default DashboardCalendar;
