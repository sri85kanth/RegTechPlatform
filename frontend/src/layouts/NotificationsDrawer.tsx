/**
 * The inbox, as a panel that slides in from the right.
 *
 * Every notification is a real event (see notificationsApi). Several arrive as
 * many rows for one fact, and are folded here so one fact reads as one card:
 *   - one regulation change reaches several owners: one row per owner, plus the
 *     change itself. One card per regulation per day, each owner's records inside.
 *   - the server's health checks repeat: one card per kind of check, with how often.
 *   - new items on watched sources come in batches, often the same item on two
 *     feeds: one card per day, each item once.
 *
 * Changes in regulations the applicability engine ruled out for this company are
 * kept apart, in grey and folded away: seen, never mistaken for something to act
 * on (the dashboard's Regulation changes does the same).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import {
  Activity, AlarmClock, ArrowRight, ArrowUpRight, Bell, BellOff, Check, CheckCheck, ChevronDown, ClipboardCheck,
  EyeOff, Gavel, GitCompareArrows, Inbox, Layers, Network, Radar, Repeat, UserCheck, X, type LucideIcon,
} from 'lucide-react';
import { Avatar } from '@/components/ui/primitives';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT, type TFunction } from '@/i18n';
import {
  useDismissMany, useMarkRead, useNotifications, type Notification,
} from '@/services/notificationsApi';
import { fetchRegulation } from '@/services/regulationsApi';
import { regulatorColor } from '@/modules/regulatory/RegulationFilters';

const KIND: Record<string, { label: string; icon: LucideIcon }> = {
  owner_impact: { label: tx('Change reaches your records'), icon: Layers },
  source_changed: { label: tx('Regulation changed'), icon: GitCompareArrows },
  action_overdue: { label: tx('Overdue'), icon: AlarmClock },
  action_assigned: { label: tx('Assigned to you'), icon: UserCheck },
  awaiting_review: { label: tx('Waiting for your review'), icon: ClipboardCheck },
  discovery: { label: tx('New on watched sources'), icon: Radar },
  enforcement: { label: tx('Enforcement action'), icon: Gavel },
  ops: { label: tx('System health'), icon: Activity },
};
const OTHER_KIND = { label: tx('Notification'), icon: Bell };

const TONE: Record<string, { fg: string; bg: string; label: string; rank: number }> = {
  critical: { fg: '#d70015', bg: '#fff1f0', label: tx('Critical'), rank: 3 },
  warning: { fg: '#b45f00', bg: '#fff8eb', label: tx('Needs attention'), rank: 2 },
  info: { fg: '#0071e3', bg: '#eef6ff', label: tx('For information'), rank: 1 },
};

/** whether the regulation applies, on a change card (ruled-out ones are folded away) */
const APPLIES: Record<string, { label: string; cls: string }> = {
  APPLICABLE: { label: tx('Applies to you'), cls: 'bg-emerald-50 text-emerald-700' },
  CONDITIONAL: { label: tx('Conditionally applies'), cls: 'bg-amber-50 text-amber-700' },
  REVIEW_REQUIRED: { label: tx('Review required'), cls: 'bg-amber-50 text-amber-700' },
};

/** rows shown on a card before "+N more" */
const ROWS_SHOWN = 3;
/** enough to reach this week's news: the server lists critical before everything else */
const LIST_LIMIT = 500;

interface Owner { name: string; count: number; records: string[] }
interface Lead { title: string; sources: string[]; link: string | null }
interface Group {
  key: string;
  kind: Notification['kind'];
  severity: Notification['severity'];
  ids: number[];
  unreadIds: number[];
  at: string;
  link: string | null;
  regulationId: string | null;
  title: string;
  body: string | null;
  sections: number | null;
  owners: Owner[];
  leads: Lead[];
  /** how many times a repeating health check fired */
  times: number;
  /** rows in a folded change whose wording could not be read: shown as they came */
  loose: Notification[];
  regTitle: string | null;
  regulator: string | null;
  /** undefined: the server did not say (an older server), so it is asked for */
  applicability: string | null | undefined;
}

// the sentences scraper/regulatory_ingestion/notifications.py writes; a row that
// does not match is still shown, just not folded
const OWNER_RE = /^(.+?): (\d+) of your record\(s\) affected — (.+)$/;
const OWNER_BODY_RE = /^(\d+) section\(s\) changed wording[^.]*\.(?:\s*Affected: (.+?))?\.?$/;
const SOURCE_RE = /^(\d+) section\(s\) changed: (.+)$/;
const DISCOVERY_RE = /^New on ([^:]+): (.+)$/;

/** "rbi_notifications_rss" → "RBI notifications RSS" */
const sourceName = (s: string) => s.split('_').map((w) => (w.length <= 4 ? w.toUpperCase() : w)).join(' ');
const cleanLink = (l: string) => l.replace(/&amp;/g, '&');
const isExternal = (l: string) => /^https?:\/\//i.test(l);

/**
 * A lead is titled with its link's text, which on some sites says only
 * "Download(10.23 MB)" or a bare file name; the file's own name says more.
 */
const GENERIC_LEAD = /^(download|click here|view|read more|pdf)\b/i;
function leadTitle(text: string, link: string | null): string {
  // some feeds arrive as UTF-8 read as Latin-1 ("Banks â€“ Forthcoming"): read them again
  let raw = text;
  if (/â€|Ã./.test(raw)) {
    try { raw = decodeURIComponent(escape(raw)); } catch { /* not that mistake after all */ }
  }
  if (!link || (!GENERIC_LEAD.test(raw) && !/\.(pdf|docx?|xlsx?|zip)$/i.test(raw))) return raw;
  let file = cleanLink(link).split(/[?#]/)[0].split('/').pop() ?? '';
  try { file = decodeURIComponent(file); } catch { /* keep it as written */ }
  const name = file.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  const size = /\(([\d.]+\s*[KMG]B)\)/i.exec(raw)?.[1];
  return name ? (size ? `${name} (${size})` : name) : raw;
}

function groupNotifications(items: Notification[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const n of items) {
    const day = n.created_at.slice(0, 10);
    const change = (n.kind === 'owner_impact' || n.kind === 'source_changed') && !!n.regulation_id;
    const key = change ? `change|${n.regulation_id}|${day}`
      : n.kind === 'ops' ? `ops|${n.title}`
      : n.kind === 'discovery' ? `discovery|${day}`
      : `n${n.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key, kind: n.kind, severity: n.severity, ids: [], unreadIds: [], at: n.created_at, link: n.link,
        regulationId: n.regulation_id, title: n.title, body: n.body, sections: null, owners: [], leads: [],
        times: 0, loose: [], regTitle: null, regulator: null, applicability: undefined,
      };
      byKey.set(key, g);
    }
    g.ids.push(n.id);
    if (!n.read_at) g.unreadIds.push(n.id);
    if ((TONE[n.severity]?.rank ?? 0) > (TONE[g.severity]?.rank ?? 0)) g.severity = n.severity;
    const newest = n.created_at >= g.at;
    if (newest) g.at = n.created_at;
    if ('regulation_applicability' in n) {
      g.applicability = n.regulation_applicability ?? null;
      g.regTitle ??= n.regulation_title ?? null;
      g.regulator ??= n.regulator_short ?? null;
    }

    if (change) {
      const owner = n.kind === 'owner_impact' ? OWNER_RE.exec(n.title) : null;
      const source = n.kind === 'source_changed' ? SOURCE_RE.exec(n.title) : null;
      const body = OWNER_BODY_RE.exec(n.body ?? '');
      if (owner) {
        g.kind = 'owner_impact';
        g.title = owner[3];
        g.sections ??= body ? Number(body[1]) : null;
        g.owners.push({ name: owner[1], count: Number(owner[2]), records: body?.[2] ? body[2].split(', ') : [] });
      } else if (source) {
        g.sections ??= Number(source[1]);
        if (!g.owners.length) g.title = source[2];
      } else {
        g.loose.push(n);
      }
    } else if (n.kind === 'ops') {
      g.times += 1;
      if (newest) { g.body = n.body; g.link = n.link; }
    } else if (n.kind === 'discovery') {
      const m = DISCOVERY_RE.exec(n.title);
      const title = leadTitle(m?.[2] ?? n.title, n.link);
      const lead = g.leads.find((l) => l.title === title);
      if (lead) { if (m && !lead.sources.includes(m[1])) lead.sources.push(m[1]); }
      else g.leads.push({ title, sources: m ? [m[1]] : [], link: n.link });
    }
  }
  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at));
}

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function dayLabel(iso: string, t: TFunction, locale: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return t('Today');
  if (days === 1) return t('Yesterday');
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "5 min ago", "3 hr ago", "26 days ago": how fresh it is, at a glance */
function ago(iso: string, t: TFunction): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return t('Just now');
  if (mins < 60) return t('{n} min ago', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('{n} hr ago', { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('Yesterday');
  if (days < 30) return t('{n} days ago', { n: days });
  const months = Math.floor(days / 30);
  return months === 1 ? t('a month ago') : t('{n} months ago', { n: months });
}

const sectionsLabel = (n: number, t: TFunction) =>
  n === 1 ? t('1 section reworded') : t('{n} sections reworded', { n: n.toLocaleString() });

export function NotificationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const locale = useDateLocale();
  const { data, isLoading } = useNotifications(false, open, LIST_LIMIT);
  const markRead = useMarkRead();
  const dismiss = useDismissMany();
  const [show, setShow] = useState<'all' | 'unread'>('all');
  const [ruledOutOpen, setRuledOutOpen] = useState(false);
  // a new number each time the panel opens, so the cards rise in again
  const [opened, setOpened] = useState(0);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // focus the panel while it is open, Escape closes it, and focus goes back where it was
  useEffect(() => {
    if (!open) return;
    setOpened((n) => n + 1);
    const before = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => closeBtn.current?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open]);

  const groups = useMemo(() => groupNotifications(data?.items ?? []), [data]);
  // a server that does not join the regulation in: ask for each one, once, from
  // the same cache the regulation page reads
  const askIds = useMemo(() => [...new Set(groups
    .filter((g) => g.regulationId && g.applicability === undefined)
    .map((g) => g.regulationId as string))], [groups]);
  const asked = useQueries({
    queries: askIds.map((id) => ({
      queryKey: ['regulation', id],
      queryFn: () => fetchRegulation(id),
      enabled: open,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const askedById = new Map<string, { title: string; regulator: string | null; applicability: string | null }>();
  asked.forEach((q, i) => {
    if (q.data) askedById.set(askIds[i], {
      title: q.data.title, regulator: q.data.regulator_short || null,
      applicability: typeof q.data.applicability === 'string' ? q.data.applicability : null,
    });
  });
  const settling = open && asked.some((q) => q.isPending && q.fetchStatus !== 'idle');
  for (const g of groups) {
    const a = g.regulationId && g.applicability === undefined ? askedById.get(g.regulationId) : undefined;
    if (a) { g.regTitle ??= a.title; g.regulator ??= a.regulator; }
  }
  const applicabilityOf = (g: Group) =>
    g.applicability !== undefined ? g.applicability : (g.regulationId ? askedById.get(g.regulationId)?.applicability ?? null : null);

  const ruledOut = (g: Group) => !!g.regulationId && applicabilityOf(g) === 'NOT_APPLICABLE';
  const visible = groups.filter((g) => show === 'all' || g.unreadIds.length > 0);
  const attention = visible.filter((g) => !ruledOut(g));
  const ignored = visible.filter(ruledOut);
  const days: [string, Group[]][] = [];
  for (const g of attention) {
    const label = dayLabel(g.at, t, locale);
    const last = days[days.length - 1];
    if (last && last[0] === label) last[1].push(g); else days.push([label, [g]]);
  }

  const unread = data?.unread ?? 0;
  const read = (g: Group) => { if (g.unreadIds.length) markRead.mutate(g.unreadIds); };
  /** in-app links move the page; a source on the web opens in a new tab and the panel stays */
  const follow = (g: Group, link: string | null = g.link) => {
    read(g);
    if (!link) return;
    const url = cleanLink(link);
    if (isExternal(url)) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    navigate(url);
    onClose();
  };
  const openImpact = (g: Group) => {
    if (!g.regulationId) return;
    read(g);
    navigate(`/cascade?view=graph&reg=${encodeURIComponent(g.regulationId)}`);
    onClose();
  };

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn('fixed inset-0 z-40 bg-slate-900/25 backdrop-blur-[2px] transition-opacity duration-300 motion-reduce:transition-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0')}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="notifications-title"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col overflow-hidden bg-[#f5f5f7]/95 shadow-[-12px_0_40px_rgba(15,18,34,.18)] backdrop-blur-2xl',
          'transition-[transform,visibility] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none sm:inset-y-3 sm:right-3 sm:rounded-[24px]',
          open ? 'visible translate-x-0' : 'invisible translate-x-[calc(100%+24px)] shadow-none',
        )}
      >
        {/* header */}
        <div className="border-b border-black/[0.06] bg-gradient-to-b from-white to-white/70 px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-[0_4px_12px_rgba(0,113,227,0.3)]">
              <Bell className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="notifications-title" className="text-[17px] font-semibold leading-tight tracking-tight text-ink">{t('Notifications')}</h2>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {unread ? t('{n} unread', { n: unread.toLocaleString() }) : t('All caught up')}
              </p>
            </div>
            <button ref={closeBtn} type="button" onClick={onClose} aria-label={t('Close')} title={t('Close')}
                    className="grid h-8 w-8 place-items-center rounded-full bg-black/[0.05] text-slate-500 transition hover:bg-black/[0.09] hover:text-ink active:scale-90">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <SegmentedControl size="sm" ariaLabel="Show" value={show} onChange={setShow}
                              options={[{ key: 'all', label: tx('All') }, { key: 'unread', label: tx('Unread') }]} />
            <button type="button" disabled={!unread} onClick={() => markRead.mutate(undefined)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-semibold text-brand-600 transition hover:bg-brand-50 disabled:pointer-events-none disabled:text-muted disabled:opacity-60">
              <CheckCheck className="h-3.5 w-3.5" /> {t('Mark all read')}
            </button>
          </div>
        </div>

        {/* cards */}
        <div key={opened} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
          {isLoading || settling ? (
            <CardSkeletons />
          ) : groups.length === 0 ? (
            <Empty icon={Inbox} title={t('Nothing to report')}
                   body={t('No source changed, nothing is overdue, and no work is waiting.')} />
          ) : visible.length === 0 ? (
            <Empty icon={CheckCheck} title={t('All caught up')}
                   body={t('Nothing unread. Choose All to see earlier notifications.')} />
          ) : (
            <>
              {attention.length === 0 && (
                <Empty icon={BellOff} title={t('Nothing here needs you')}
                       body={t('Every change below is in a regulation that does not apply to you.')} />
              )}
              {days.map(([label, gs]) => (
                <section key={label}>
                  <h3 className="sticky top-0 z-10 -mx-4 bg-[#f5f5f7]/90 px-5 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted backdrop-blur">
                    {label}
                  </h3>
                  <ul className="space-y-2.5">
                    {gs.map((g, i) => (
                      <li key={g.key} className="animate-rise motion-reduce:animate-none" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                        <NotificationCard
                          g={g}
                          applicability={applicabilityOf(g)}
                          onOpen={(link) => follow(g, link)}
                          onImpact={() => openImpact(g)}
                          onRead={() => read(g)}
                          onDismiss={() => dismiss.mutate(g.ids)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {ignored.length > 0 && (
                <RuledOut
                  groups={ignored}
                  open={ruledOutOpen}
                  onToggle={() => setRuledOutOpen((o) => !o)}
                  onOpen={(g) => follow(g)}
                  onDismiss={(g) => dismiss.mutate(g.ids)}
                  onDismissAll={() => dismiss.mutate(ignored.flatMap((g) => g.ids))}
                />
              )}
            </>
          )}
        </div>

        <div className="border-t border-black/[0.06] bg-white/70 px-5 py-2.5 text-[11.5px] leading-snug text-muted">
          {t('Only real events: a regulation that changed, work past its date, or a review waiting on you.')}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function NotificationCard({ g, applicability, onOpen, onImpact, onRead, onDismiss }: {
  g: Group; applicability: string | null;
  onOpen: (link?: string | null) => void; onImpact: () => void; onRead: () => void; onDismiss: () => void;
}) {
  const t = useT();
  const locale = useDateLocale();
  const [allRows, setAllRows] = useState(false);
  const kind = KIND[g.kind] ?? OTHER_KIND;
  const tone = TONE[g.severity] ?? TONE.info;
  const KindIcon = kind.icon;
  const unread = g.unreadIds.length > 0;
  const leadDigest = g.leads.length > 1;
  const title = leadDigest
    ? t('{n} new items on watched sources', { n: g.leads.length.toLocaleString() })
    : g.leads.length === 1 ? g.leads[0].title : (g.regTitle || g.title);
  const link = g.leads.length === 1 ? g.leads[0].link : leadDigest ? null : g.link;
  const external = !!link && isExternal(cleanLink(link));
  const applies = applicability ? APPLIES[applicability] : undefined;
  const owners = allRows ? g.owners : g.owners.slice(0, ROWS_SHOWN);
  const leads = allRows ? g.leads : g.leads.slice(0, ROWS_SHOWN);
  const extraRows = Math.max(g.owners.length, leadDigest ? g.leads.length : 0) - ROWS_SHOWN;
  // the same record can sit with two owners; count it once
  const recordNames = new Set(g.owners.flatMap((o) => o.records));
  const records = recordNames.size || g.owners.reduce((s, o) => s + o.count, 0);
  const when = new Date(g.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  // a lead's body opens with the address the Open source button already follows
  const body = (g.body ?? '').replace(/&amp;/g, '&').replace(/^Listed at \S+?\.\s+/, '');
  const showBody = g.owners.length === 0 && g.loose.length <= 1 && !leadDigest && !!body;

  return (
    <article className={cn(
      'relative overflow-hidden rounded-2xl bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)] transition-shadow duration-300',
      'hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.09),0_10px_28px_rgba(15,18,34,0.10)]',
    )}>
      {unread && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-brand-500" />}

      <button type="button" onClick={() => onOpen(link)} disabled={!link}
              className="block w-full rounded-t-2xl px-4 pt-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 disabled:cursor-default">
        <span className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: tone.bg, color: tone.fg }}>
            <KindIcon className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: tone.fg }}>{t(kind.label)}</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-muted" title={when}>{ago(g.at, t)}</span>
              {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" title={t('Unread')} />}
            </span>
            <span className="mt-1 line-clamp-2 text-[14px] font-semibold leading-snug text-ink" title={title}>{title}</span>
            <span className="mt-2 flex flex-wrap items-center gap-1.5">
              {g.regulator && (
                <span className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold tracking-wide', regulatorColor(g.regulator).tile)}>{g.regulator}</span>
              )}
              <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: tone.bg, color: tone.fg }}>{t(tone.label)}</span>
              {applies && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', applies.cls)}>{t(applies.label)}</span>}
              {g.sections != null && <Chip icon={GitCompareArrows}>{sectionsLabel(g.sections, t)}</Chip>}
              {g.times > 1 && <Chip icon={Repeat}>{t('{n} times', { n: g.times.toLocaleString() })}</Chip>}
              {g.leads.length === 1 && g.leads[0].sources.map((s) => <Chip key={s} icon={Radar}>{sourceName(s)}</Chip>)}
            </span>
            {showBody && (
              <span className="mt-2 line-clamp-4 block whitespace-pre-line text-[12.5px] leading-relaxed text-muted">{body}</span>
            )}
          </span>
        </span>
      </button>

      {g.owners.length > 0 && (
        <div className="mx-4 mt-3 rounded-xl bg-slate-50 p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px]">
            <span className="font-semibold uppercase tracking-[0.06em] text-muted">{t('Who it reaches')}</span>
            <span className="text-muted">
              {records === 1 ? t('1 record') : t('{n} records', { n: records.toLocaleString() })}
              {' · '}
              {g.owners.length === 1 ? t('1 owner') : t('{n} owners', { n: g.owners.length.toLocaleString() })}
            </span>
          </div>
          <ul>
            {owners.map((o) => (
              <li key={o.name} className="flex items-start gap-2.5 rounded-lg px-1 py-1.5">
                <Avatar name={o.name} size={26} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold text-ink">{o.name}</span>
                    <span className="shrink-0 text-[11.5px] text-muted">
                      {o.count === 1 ? t('1 record') : t('{n} records', { n: o.count.toLocaleString() })}
                    </span>
                  </span>
                  {o.records.length > 0 && (
                    <span className="mt-0.5 block truncate text-[12px] text-muted" title={o.records.join(', ')}>{o.records.join(' · ')}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {extraRows > 0 && <MoreRows all={allRows} extra={extraRows} onToggle={() => setAllRows((a) => !a)} />}
        </div>
      )}

      {leadDigest && (
        <div className="mx-4 mt-3 rounded-xl bg-slate-50 p-1.5">
          <ul>
            {leads.map((l) => (
              <li key={l.title}>
                <button type="button" onClick={() => onOpen(l.link)} disabled={!l.link}
                        className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white disabled:cursor-default">
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="line-clamp-2 text-[12.5px] font-medium text-ink">{l.title}</span>
                    {l.sources.length > 0 && <span className="mt-0.5 block truncate text-[11.5px] text-muted">{l.sources.map(sourceName).join(' · ')}</span>}
                  </span>
                  {l.link && <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition group-hover:text-brand-600" />}
                </button>
              </li>
            ))}
          </ul>
          {extraRows > 0 && <div className="px-1 pb-0.5"><MoreRows all={allRows} extra={extraRows} onToggle={() => setAllRows((a) => !a)} /></div>}
        </div>
      )}

      {g.loose.length > (g.owners.length ? 0 : 1) && (
        <ul className="mx-4 mt-3 space-y-1.5 rounded-xl bg-slate-50 p-2.5">
          {g.loose.map((n) => (
            <li key={n.id} className="line-clamp-2 px-1 text-[12.5px] leading-snug text-ink-2">{n.title}</li>
          ))}
        </ul>
      )}

      <div className={cn('flex items-center gap-1 px-2.5 py-2', (showBody || g.owners.length || leadDigest || g.loose.length > 1) ? 'mt-3 border-t border-black/[0.05]' : 'mt-2')}>
        {link && (
          <button type="button" onClick={() => onOpen(link)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-[12.5px] font-semibold text-brand-700 transition hover:bg-brand-100 active:scale-95">
            {t(g.regulationId ? 'Open regulation' : external ? 'Open source' : 'Open')}
            {external ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        )}
        {g.regulationId && (
          <button type="button" onClick={onImpact} title={t('Open its impact graph in the Impact Cascade')}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 transition hover:bg-black/[0.04] active:scale-95">
            <Network className="h-3.5 w-3.5" /> {t('Impact')}
          </button>
        )}
        <span className="ml-auto" />
        {unread && <IconAction label={t('Mark as read')} onClick={onRead}><Check className="h-4 w-4" /></IconAction>}
        <IconAction label={t('Dismiss')} onClick={onDismiss} danger><X className="h-4 w-4" /></IconAction>
      </div>
    </article>
  );
}

function MoreRows({ all, extra, onToggle }: { all: boolean; extra: number; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onToggle}
            className="mt-0.5 inline-flex items-center gap-1 px-1 text-[12px] font-semibold text-brand-600 hover:text-brand-700">
      {all ? t('Show less') : t('+{n} more', { n: extra })}
      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', all && 'rotate-180')} />
    </button>
  );
}

/** Changes in regulations that do not apply: one quiet, folded list. */
function RuledOut({ groups, open, onToggle, onOpen, onDismiss, onDismissAll }: {
  groups: Group[]; open: boolean; onToggle: () => void;
  onOpen: (g: Group) => void; onDismiss: (g: Group) => void; onDismissAll: () => void;
}) {
  const t = useT();
  return (
    <section className="mt-5 overflow-hidden rounded-2xl bg-white/60 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06)]">
      <button type="button" onClick={onToggle} aria-expanded={open}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/80">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
          <EyeOff className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block text-[13px] font-semibold text-ink-2">{t("Doesn't apply to you")}</span>
          <span className="mt-0.5 block text-[12px] text-muted">
            {groups.length === 1
              ? t('1 change in a regulation ruled out for your company')
              : t('{n} changes in regulations ruled out for your company', { n: groups.length.toLocaleString() })}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-black/[0.05] px-2 pb-2">
          <p className="px-2 pb-1 pt-2.5 text-[11.5px] leading-snug text-muted">
            {t('The applicability check ruled these regulations out, so nothing here needs action. Kept for the record.')}
          </p>
          <ul className="divide-y divide-black/[0.04]">
            {groups.map((g) => {
              const title = g.regTitle || g.title;
              return (
                <li key={g.key} className="flex items-center gap-2.5 px-2 py-2">
                  {g.regulator && (
                    <span className="w-12 shrink-0 truncate rounded-md bg-slate-100 px-1.5 py-0.5 text-center text-[10.5px] font-bold text-slate-500">{g.regulator}</span>
                  )}
                  <button type="button" onClick={() => onOpen(g)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px] font-medium text-ink-2" title={title}>{title}</span>
                    <span className="block text-[11.5px] text-muted">
                      {[g.sections != null ? sectionsLabel(g.sections, t) : null, ago(g.at, t)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <IconAction label={t('Dismiss')} onClick={() => onDismiss(g)} danger><X className="h-3.5 w-3.5" /></IconAction>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end px-2 pt-1.5">
            <button type="button" onClick={onDismissAll}
                    className="rounded-full px-2.5 py-1 text-[12px] font-semibold text-muted transition hover:bg-critical-50 hover:text-critical-600">
              {t('Dismiss all of these')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Chip({ icon: I, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-ink-2">
      <I className="h-3 w-3 text-muted" /> {children}
    </span>
  );
}

function IconAction({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
            className={cn('grid h-8 w-8 place-items-center rounded-full text-slate-400 transition active:scale-90',
              danger ? 'hover:bg-critical-50 hover:text-critical-600' : 'hover:bg-brand-50 hover:text-brand-600')}>
      {children}
    </button>
  );
}

function Empty({ icon: I, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-brand-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_6px_20px_rgba(0,0,0,0.06)]">
        <I className="h-6 w-6" />
      </span>
      <div className="mt-4 text-[15px] font-semibold text-ink">{title}</div>
      <p className="mt-1 max-w-[280px] text-[12.5px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function CardSkeletons() {
  return (
    <div className="space-y-2.5 pt-4" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-2xl bg-white p-4 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06)]">
          <div className="flex gap-3">
            <div className="h-9 w-9 rounded-xl bg-slate-100" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-1/3 rounded bg-slate-100" />
              <div className="h-3.5 w-5/6 rounded bg-slate-100" />
              <div className="h-3 w-1/2 rounded bg-slate-100" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
