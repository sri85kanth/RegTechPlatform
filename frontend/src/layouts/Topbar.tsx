import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Bell, LogOut, ArrowLeft, ChevronDown, Users, Building2 } from 'lucide-react';
import { Avatar } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import { can, useMe, useLogout, isAuditor, type User } from '@/services/authApi';
import { useUnreadCount } from '@/services/notificationsApi';
import { NotificationsDrawer } from './NotificationsDrawer';
import { Icon } from '@/config/icons';
import { useEffect, useRef, useState } from 'react';
import { CompanySwitcher } from './CompanySwitcher';
import { useT } from '@/i18n';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';

/** Which nav area a route belongs to — shown as the breadcrumb eyebrow. */
/**
 * The section a page belongs to — the same groups, in the same words, as the
 * sidebar. Derived here for every page rather than passed by each one, because
 * pages passing their own label drifted (Import Data said "Company" while the
 * sidebar files it under Onboarding).
 */
const SECTION_OF: Record<string, string> = {
  overview: 'Company', departments: 'Company', graph: 'Company', structure: 'Company',
  'company-setup': 'Onboarding', onboarding: 'Onboarding', integrations: 'Onboarding', intake: 'Onboarding',
  regulation: 'Regulatory', ingestion: 'Regulatory',
  applies: 'Compliance', compliance: 'Compliance', controls: 'Compliance', cascade: 'Compliance',
  governance: 'Compliance', knowledge: 'Compliance', 'risk-setup': 'Compliance', 'risk-review': 'Compliance',
  users: 'Platform', 'auditor-access': 'Platform',
};
/** each section's own icon and colour, for a page that names neither */
const SECTION_LOOK: Record<string, [string, string]> = {
  Company: ['Building2', '#2563eb'], Onboarding: ['UploadCloud', '#0d9488'], Regulatory: ['Scale', '#4f46e5'],
  Compliance: ['ShieldCheck', '#0071e3'], Platform: ['Settings', '#64748b'],
};
function sectionFor(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean)[0] ?? '';
  // the explicit map first: /controls is the Compliance page, though 'controls'
  // is also the name of a company record type
  if (SECTION_OF[seg]) return SECTION_OF[seg];
  if (seg.startsWith('reg-')) return 'Regulatory';
  return 'Company';
}

/**
 * Page header — one consistent header for every screen.
 *
 *   1. A slim sticky app bar: global search on the left; company, notifications
 *      and the user on the right.
 *   2. The page heading in the content area: back link, title, subtitle, and the
 *      page's own actions on the right; an optional toolbar line beneath.
 *   3. `below` (tab strips, meta rows) as a sticky white strip under the app bar,
 *      so tabs stay reachable while the page scrolls.
 *
 * The heading reads the same on every page: the section above the title (in the
 * page's colour, `tone`, or its section's), the title and a softer subtitle, facts
 * as chips, and the page's actions on the right. No icon tile: the title says it.
 */
export function Topbar({
  title,
  subtitle,
  tone,
  dense = false,
  actions,
  toolbar,
  hideSearch,
  breadcrumb,
  titleExtra,
  below,
  onBack,
  backLabel,
  meta,
}: {
  title: string;
  subtitle?: string;
  /** One line instead of three — for screens where canvas height matters. */
  dense?: boolean;
  /** accepted for older callers; the heading shows no icon tile */
  icon?: string;
  tone?: string;
  /**
   * Page-level controls — filters, a primary button. Rendered in the toolbar
   * row BENEATH the header, right-aligned, not in the header itself: the header
   * row already carries global search, the company badge, notifications and the
   * user menu, and page controls squeezed in beside them truncated the title
   * to "M…" on every detail screen.
   */
  actions?: ReactNode;
  /** Left-hand content of that same toolbar row — page context, counts, legend. */
  toolbar?: ReactNode;
  /** shown inline after the title — a status badge such as "Applies to us" */
  titleExtra?: ReactNode;
  /** a trail under the section, e.g. "Departments / Nursing" (defaults to the section) */
  breadcrumb?: string;
  /** hide the global search (e.g. when the page has its own search) */
  hideSearch?: boolean;
  /** optional row rendered beneath the header bar — meta fields, tab nav */
  below?: ReactNode;
  /** back affordance for detail pages */
  onBack?: () => void;
  backLabel?: string;
  /** icon · label · value facts under the subtitle — "Version 6th Edition", "In force 1 Jan 2025" */
  meta?: { icon: string; label: string; value: ReactNode }[];
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const { data: me } = useMe();
  // an external auditor gets no search, inbox or AI status: none of it is shared with them
  const auditor = isAuditor(me);
  const logout = useLogout();
  const [bellOpen, setBellOpen] = useState(false);
  // the badge needs only the count; the panel loads the list when it opens
  const { data: notif } = useUnreadCount(!auditor);
  // the search box shows ⌘K, so ⌘K / Ctrl+K has to open search
  useEffect(() => {
    if (hideSearch || auditor) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate('/knowledge'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hideSearch, auditor, navigate]);
  const crumb = breadcrumb ?? sectionFor(pathname);
  const look = SECTION_LOOK[sectionFor(pathname)] ?? ['LayoutGrid', '#0071e3'];
  const hex = tone && tone.startsWith('#') ? tone : look[1];
  // Knowledge Search has its own search box; everywhere else the app bar has one
  const showSearch = !auditor && (!hideSearch || !pathname.startsWith('/knowledge'));

  return (
    <>
      {/* 1 · app bar */}
      <header className="liquid-glass sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-black/[0.06] px-6">
        <div className="min-w-0 flex-1">
          {showSearch && (
            <button
              onClick={() => navigate('/knowledge')}
              className="group flex h-10 w-full max-w-[560px] items-center gap-2.5 rounded-full border border-transparent bg-black/[0.05] px-4 text-left text-sm text-slate-500 transition-all duration-300 ease-spring hover:bg-white hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.06)] focus:outline-none focus-visible:shadow-glow"
            >
              <Search className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-blue-500" />
              <span className="flex-1 truncate">{t('Search regulations, policies, documents or ask a question…')}</span>
              <kbd className="hidden rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[11px] font-semibold text-slate-500 shadow-sm sm:block">{/Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          {auditor ? (
            <span className="hidden h-10 items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 text-[12.5px] font-medium text-orange-700 md:inline-flex"
                  title={t('You see only what the hospital shared with you. Every document you open is recorded.')}>
              <Icon name="ShieldCheck" className="h-4 w-4" /> {t('Auditor view · read only')}
            </span>
          ) : (<>
            {me && <CompanySwitcher me={me} />}
            <div className="relative">
              <IconBtn label={t('Notifications')}
                       badge={notif?.unread || undefined}
                       active={bellOpen}
                       onClick={() => setBellOpen((o) => !o)}>
                <Bell className="h-[18px] w-[18px]" />
              </IconBtn>
              <NotificationsDrawer open={bellOpen} onClose={() => setBellOpen(false)} />
            </div>
          </>)}
          <span className="mx-1 hidden h-7 w-px bg-slate-200 sm:block" />
          <UserMenu me={me} onSignOut={() => logout.mutate()} />
        </div>
      </header>

      {/* 2 · page heading — one design for every page */}
      <div className={cn('px-6', dense ? 'pt-4' : 'pt-5', below ? 'pb-3' : 'pb-1')}>
        {onBack && (
          <button onClick={onBack}
                  className="group mb-3 inline-flex items-center gap-1.5 rounded-full bg-white py-1 pl-2 pr-3 text-[12.5px] font-semibold text-brand-600 shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)] transition hover:text-brand-700 hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_3px_10px_rgba(0,0,0,0.08)] active:scale-95">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" /> {t(backLabel ?? 'Back')}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: hex }}>
                {crumb.split(' / ').map((c) => t(c)).join(' / ')}
              </p>
              <div className="mt-0.5 flex min-w-0 items-center gap-x-3">
                {/* pages pass their title and subtitle as English text; a title that
                    is data (a regulation's name) has no entry and stays as it is */}
                {/* one line: a long title ends in "…" and reads in full on hover */}
                <h1 className={cn('min-w-0 truncate font-semibold tracking-tight text-ink', dense ? 'text-xl leading-snug' : 'text-[24px] leading-tight')} title={t(title)}>
                  {t(title)}
                </h1>
                {titleExtra && <span className="shrink-0">{titleExtra}</span>}
              </div>
              {subtitle && !dense && <p className="mt-1 truncate text-[14px] text-muted" title={t(subtitle)}>{t(subtitle)}</p>}
              {meta && meta.length > 0 && !dense && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {meta.map((m, i) => (
                    <span key={`${m.label}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[12.5px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]">
                      <span style={{ color: hex }}><Icon name={m.icon} className="h-3.5 w-3.5" /></span>
                      <span className="text-muted">{t(m.label)}</span>
                      <span className="font-semibold text-ink">{m.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {toolbar && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{toolbar}</div>}
      </div>

      {/* 3 · tabs / meta strip */}
      {below && (
        <div className="liquid-glass sticky top-16 z-20 border-b border-black/[0.06] px-6">{below}</div>
      )}
    </>
  );
}

function IconBtn({ children, label, badge, onClick, active }: {
  children: ReactNode; label: string; badge?: number; onClick?: () => void; active?: boolean;
}) {
  const t = useT();
  return (
    <button
      aria-label={badge ? `${label} (${t('{n} unread', { n: badge })})` : label}
      title={label}
      onClick={onClick}
      aria-expanded={active}
      className={cn('relative grid h-10 w-10 place-items-center rounded-full transition-all duration-300 ease-spring active:scale-90',
        active ? 'bg-brand-50 text-brand-600'
          : 'bg-black/[0.04] text-slate-500 hover:bg-black/[0.07] hover:text-ink')}
    >
      {children}
      {badge != null && (
        <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-gradient-to-br from-red-500 to-rose-600 px-1 text-[10.5px] font-bold leading-none text-white shadow-sm ring-2 ring-white">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
}

const ROLE_TONE: Record<string, string> = {
  ADMIN: 'bg-violet-100 text-violet-700', APPROVER: 'bg-blue-100 text-blue-700',
  REVIEWER: 'bg-teal-100 text-teal-700', VIEWER: 'bg-slate-100 text-slate-600',
  AUDITOR: 'bg-orange-100 text-orange-700',
};

/** Who is signed in, and the account menu — signing out is a menu item, not a click on your own name. */
function UserMenu({ me, onSignOut }: { me?: User | null; onSignOut: () => void }) {
  const navigate = useNavigate();
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const role = t(me ? me.role.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase()) : 'Not signed in');
  const go = (to: string) => { setOpen(false); navigate(to); };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={me ? t('Signed in as {email}', { email: me.email }) : t('Not signed in')}
        className={cn('flex items-center gap-2.5 rounded-xl border py-1 pl-1 pr-2.5 transition-colors duration-150',
          open ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50')}
      >
        <span className="rounded-full bg-gradient-to-br from-blue-500 to-violet-500 p-[2px]">
          <span className="block rounded-full bg-white p-[1px]"><Avatar name={me?.name ?? 'Guest'} size={32} /></span>
        </span>
        <span className="hidden text-left leading-tight lg:block">
          <span className="block max-w-[160px] truncate text-sm font-semibold text-ink">{me?.name ?? t('Not signed in')}</span>
          <span className="block text-xs text-slate-500">{role}</span>
        </span>
        <ChevronDown className={cn('hidden h-4 w-4 text-slate-400 transition-transform lg:block', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open && me && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-float">
          <div className="flex items-center gap-3 bg-gradient-to-br from-blue-50 via-indigo-50 to-violet-50 px-4 py-4">
            <Avatar name={me.name} size={44} />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold text-ink">{me.name}</div>
              <div className="truncate text-xs text-slate-500">{me.email}</div>
              <span className={cn('mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold', ROLE_TONE[me.role.toUpperCase()] ?? ROLE_TONE.VIEWER)}>{role}</span>
            </div>
          </div>
          {can(me, 'administer') && (
            <div className="p-1.5">
              <MenuItem icon={<Building2 className="h-4 w-4" />} label={t('Company setup')} hint={t('Profile, licences, sectors')} onClick={() => go('/company-setup')} />
              <MenuItem icon={<Users className="h-4 w-4" />} label={t('Users & roles')} hint={t('Who can see and approve')} onClick={() => go('/users')} />
            </div>
          )}
          <div className="border-t border-slate-100 p-1.5">
            <button role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50">
              <LogOut className="h-4 w-4" /> {t('Sign out')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-slate-50">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-600">{icon}</span>
      <span className="min-w-0 leading-tight">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}
