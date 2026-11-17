import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Brain, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { DOMAINS } from '@/config/companyBrain';
import { REG_DOMAINS } from '@/config/regDomains';
import { Icon } from '@/config/icons';
import { useUi } from '@/app/store/ui';
import { can, useMe } from '@/services/authApi';
import { usePendingRequests } from '@/services/auditorApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import { useLiquidPill } from '@/components/ui/motion';

interface NavItem {
  to: string;
  /** other routes that belong to this item (e.g. /graph and /structure → Departments) */
  match?: string[];
  label: string;
  icon: string;
  badge?: number;
  /** shown only to administrators of the main company (they add companies) */
  platform?: boolean;
  /** shown only to administrators of the open company (technical pages) */
  admin?: boolean;
  /** shown only to those who can approve: compliance managers and administrators */
  approver?: boolean;
}

/**
 * The nav, as data.
 *
 * Three groups, by what a user is trying to do: work through compliance, look
 * at the hospital's own records, or (administrators only) set the system up.
 *
 * Declaring it once means the section a route belongs to is derived from this
 * list rather than restated in a second place that can disagree with it.
 */
interface NavSection {
  name: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    // The compliance work itself: what applies, what must be done, the proof.
    name: 'Compliance',
    items: [
      { to: '/', label: 'Dashboard', icon: 'LayoutGrid' },
      // An allow-list, not an exclude-list. Six regulatory domains exist and one
      // belongs in the nav; the omitted pages keep their routes and stay reachable
      // by link.
      ...(['reg-regulations'] as const)
        .map((d) => ({ to: `/${d}`, label: REG_DOMAINS[d].title, icon: REG_DOMAINS[d].icon })),
      { to: '/applies', label: 'What applies to us', icon: 'BadgeCheck' },
      { to: '/compliance', label: 'Requirements', icon: 'ClipboardCheck' },
      { to: '/controls', label: 'Controls', icon: 'ShieldCheck' },
      // Risk inputs (/risk-setup) has no menu item; its route stays and is reachable by link.
      // the register the rules build, and what people decide about it (risk module, Phase 3)
      { to: '/risk-review', label: 'Risk review', icon: 'ShieldAlert' },
      { to: '/cascade', label: 'Impact Cascade', icon: 'GitBranch' },
      { to: '/evidence', label: DOMAINS.evidence.title, icon: DOMAINS.evidence.icon },
      { to: '/auditor-access', label: 'Auditor access', icon: 'UserCheck', approver: true },
      { to: '/knowledge', label: 'Knowledge Search', icon: 'Sparkles' },
    ],
  },
  {
    // The hospital's own records. Also an allow-list: Controls and Evidence sit
    // under Compliance, and /data keeps its route without a menu item.
    name: 'Hospital records',
    items: [
      { to: '/overview', label: 'Overview', icon: 'Building2' },
      { to: '/departments', label: 'Departments', icon: 'FolderTree', match: ['/graph', '/structure'] },
      ...(['people', 'processes', 'systems', 'policies', 'risks'] as const)
        .map((d) => ({ to: `/${d}`, label: DOMAINS[d].title, icon: DOMAINS[d].icon })),
    ],
  },
  {
    // Set up once, or technical: administrators of the open company only.
    name: 'Admin',
    items: [
      { to: '/company-setup', label: 'Company Setup', icon: 'Building2', admin: true },
      // Connections, Documents and Spreadsheet import are tabs of one page; the
      // old URLs redirect there, and /intake/:id (one upload) belongs to it too.
      { to: '/add-data', label: 'Add data', icon: 'UploadCloud', match: ['/onboarding', '/integrations', '/intake'], admin: true },
      // the pipeline's technical state (OCR, fetch failures)
      { to: '/ingestion', label: 'Ingestion', icon: 'RefreshCw', admin: true },
      { to: '/governance', label: 'Governance', icon: 'ShieldCheck', admin: true },
      { to: '/users', label: 'Users', icon: 'Users', admin: true },
      { to: '/workspaces', label: 'Companies', icon: 'Building2', admin: true, platform: true },
    ],
  },
];

/** Longest matching route wins, so /reg-regulations beats a bare '/'. */
function sectionForPath(pathname: string): string {
  let best = { name: 'Compliance', len: -1 };
  for (const s of SECTIONS) {
    for (const i of s.items) {
      for (const to of [i.to, ...(i.match ?? [])]) {
        const hit = to === '/' ? pathname === '/' : pathname.startsWith(to);
        if (hit && to.length > best.len) best = { name: s.name, len: to.length };
      }
    }
  }
  return best.name;
}

/**
 * Sections collapse, because a long nav should not make anyone scan every item
 * to reach the two they use.
 *
 * Two rules keep it from hiding things:
 *  - the section holding the current route is always open, so navigation can
 *    never leave you looking at a closed group with no idea where you are;
 *  - the choice is remembered, so it is not re-made on every page change.
 */
const OPEN_KEY = 'cb.nav.sections';

function useOpenSections(activeSection: string) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(OPEN_KEY);
      // Default: everything open. A nav that hides itself on first run is worse
      // than a long one.
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* private mode */ }
  }, [open]);

  const isOpen = (name: string) =>
    name === activeSection ? true : open[name] !== false;
  const toggle = (name: string) =>
    setOpen((o) => ({ ...o, [name]: o[name] === false }));
  return { isOpen, toggle };
}

/**
 * Each nav group keeps a small coloured dot so the groups read apart; the
 * active icon tile is the one accent colour everywhere, as on Apple platforms.
 */
const ACTIVE_TILE = 'from-[#2b8cff] to-[#0071e3]';
const SECTION_TONE: Record<string, { dot: string; tile: string; soft: string }> = {
  Compliance: { dot: 'bg-warning-500', tile: ACTIVE_TILE, soft: 'bg-amber-50 text-amber-600' },
  'Hospital records': { dot: 'bg-brand-500', tile: ACTIVE_TILE, soft: 'bg-blue-50 text-blue-600' },
  Admin: { dot: 'bg-slate-400', tile: ACTIVE_TILE, soft: 'bg-slate-100 text-slate-600' },
};

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUi();
  const { pathname } = useLocation();
  // labels are translated where they are drawn; section names stay English
  // underneath, because they key the colours and the remembered open state
  const t = useT();

  // Which group owns the current route, so it can never be collapsed shut.
  const { isOpen, toggle } = useOpenSections(sectionForPath(pathname));

  // No counts in the nav: the pages say how many. Only something waiting on the
  // reader — an auditor's request — gets a dot.
  // auditor requests waiting for a decision — only for those who can decide
  const { data: me } = useMe();
  const approver = can(me, 'approve');
  const { data: auditorPending } = usePendingRequests(approver);
  // adding companies is a job for an administrator of the main company
  const platformAdmin = !!me?.platformAdmin;
  // technical pages (the ingestion pipeline) are for administrators of the open company
  const admin = can(me, 'administer');
  const BADGE: Record<string, { n?: number; tone: string; title: string }> = {
    '/auditor-access': { n: auditorPending?.pending, tone: 'bg-amber-500', title: 'auditor requests waiting for a decision' },
  };

  // The nav scrolls on short screens; keep the active item in view after navigating.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [pathname]);
  // the selection is one white pill that flows from item to item
  const listRef = useRef<HTMLDivElement>(null);
  const isItemActive = (item: NavItem) =>
    (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`))
    || !!item.match?.some((m) => pathname.startsWith(m));
  const pill = useLiquidPill(listRef, '[data-active="true"]', 'y', [pathname, sidebarCollapsed, admin, approver, platformAdmin]);

  const link = (item: NavItem, sectionName: string) => {
    const tone = SECTION_TONE[sectionName] ?? SECTION_TONE.Compliance;
    const badge = BADGE[item.to];
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === '/'}
        data-active={isItemActive(item) ? 'true' : undefined}
        title={sidebarCollapsed ? t(item.label) : undefined}
        className={({ isActive: navActive }) => {
          const isActive = navActive || !!item.match?.some((m) => pathname.startsWith(m));
          return cn(
            'group relative z-[1] flex items-center gap-2.5 rounded-xl py-[3px] pl-[6px] pr-2.5 text-[13.5px] transition-colors duration-200',
            sidebarCollapsed && 'justify-center px-0 pl-0 pr-0',
            isActive
              ? 'font-semibold text-ink'
              : 'font-medium text-slate-600 hover:bg-black/[0.04] hover:text-ink',
          );
        }}
      >
        {({ isActive: navActive }) => {
          const isActive = navActive || !!item.match?.some((m) => pathname.startsWith(m));
          return (
            <>
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-all duration-300 ease-spring',
                isActive ? cn('scale-100 bg-gradient-to-br text-white shadow-[0_2px_6px_rgba(0,113,227,0.35)]', tone.tile)
                  : 'text-slate-500 group-hover:scale-105 group-hover:bg-black/[0.04] group-hover:text-slate-700')}>
                <Icon name={item.icon} className="h-[17px] w-[17px]" />
              </span>
              {!sidebarCollapsed && <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>}
              {!sidebarCollapsed && badge?.n !== undefined && badge.n > 0 && (
                <span title={`${badge.n.toLocaleString()} ${t(badge.title)}`} className={cn('h-2 w-2 shrink-0 rounded-full', badge.tone)} />
              )}
              {sidebarCollapsed && badge?.n !== undefined && badge.n > 0 && (
                <span className={cn('absolute right-1.5 top-1 h-2 w-2 rounded-full ring-2 ring-slate-50', badge.tone)} />
              )}
            </>
          );
        }}
      </NavLink>
    );
  };

  /**
   * A collapsed sidebar is already icons-only, so a disclosure there would hide
   * navigation behind two interactions. The header stays a plain marker.
   */
  const section = (label: string, children: React.ReactNode) => {
    const tone = SECTION_TONE[label] ?? SECTION_TONE.Compliance;
    if (sidebarCollapsed) {
      return (
        <div key={label} className="mt-3 space-y-0.5 border-t border-slate-200/70 pt-3 first:mt-1 first:border-t-0 first:pt-0">
          {children}
        </div>
      );
    }
    const open = isOpen(label);
    const id = `nav-${label.toLowerCase().replace(/\s+/g, '-')}`;
    return (
      <div key={label}>
        <button
          type="button"
          onClick={() => toggle(label)}
          aria-expanded={open}
          aria-controls={id}
          className="mb-1 mt-3.5 flex w-full items-center gap-2 rounded-md px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-slate-600"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden="true" />
          <span>{t(label)}</span>
          <ChevronDown
            className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
              !open && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
        <div id={id} hidden={!open} className="space-y-px">{children}</div>
      </div>
    );
  };

  return (
    <aside
      className={cn(
        'liquid-glass sticky top-0 z-20 flex h-screen shrink-0 flex-col border-r border-black/[0.06] text-ink transition-[width] duration-300 ease-spring',
        sidebarCollapsed ? 'w-[76px]' : 'w-[252px]',
      )}
    >
      {/* logo — same height as the app bar beside it */}
      <div className={cn('flex h-16 shrink-0 items-center border-b border-slate-200/80', sidebarCollapsed ? 'justify-center px-2' : 'gap-3 px-4')}>
        <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 shadow-[0_4px_12px_rgba(79,70,229,.35)]">
          <Brain className="h-5 w-5 text-white" />
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-slate-50" title={t('Workspace online')} />
        </div>
        {!sidebarCollapsed && (
          <div className="min-w-0 leading-tight">
            <div className="text-[16px] font-bold tracking-tight text-ink">Company Brain</div>
            <div className="text-[11.5px] font-medium text-slate-500">{t('Compliance. Simplified.')}</div>
          </div>
        )}
      </div>

      <nav ref={navRef} aria-label={t('Main')} className="flex-1 overflow-y-auto px-3 pb-3 pt-1 [scrollbar-width:thin]">
        <div ref={listRef} className="relative">
          <span aria-hidden="true"
                className="liquid-pill left-0 right-0 rounded-xl bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.05),0_1px_2px_rgba(0,0,0,0.06),0_4px_14px_rgba(0,0,0,0.06)]"
                style={pill} />
          {SECTIONS.map((s) => {
            const items = s.items.filter((i) => (!i.platform || platformAdmin) && (!i.admin || admin) && (!i.approver || approver));
            // a group with nothing to show has no header either
            return items.length > 0 && section(s.name, <>{items.map((i) => link(i, s.name))}</>);
          })}
        </div>
      </nav>

      <div className="border-t border-slate-200/80 p-2.5">
        <button
          onClick={toggleSidebar}
          aria-label={t(sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-1.5 text-[13px] font-medium text-slate-500 transition-colors hover:bg-white hover:text-ink"
        >
          {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!sidebarCollapsed && <span>{t('Collapse')}</span>}
        </button>
      </div>
    </aside>
  );
}
