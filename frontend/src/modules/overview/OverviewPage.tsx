import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { BadgeCheck, CalendarClock, Check, ChevronRight, Copy, FileBadge, XCircle } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { Section, Badge, IconTile, type MetricTone } from '@/components/ui/primitives';
import { MetricTile as MetricCard } from '@/components/ui/premium';
import { CountUp as CountUpNum } from '@/components/ui/motion';
import { BarList, ScoreRing, StackedBar, type Slice } from '@/components/ui/charts';
import { DataTable } from '@/components/tables/DataTable';
import { TabStrip } from '@/components/ui/TabStrip';
import { ActivityList } from '@/components/ActivityList';
import { CompanyLogo } from '@/components/CompanyLogo';
import { activityStyle } from './activityStyle';
import { Icon } from '@/config/icons';
import { DOMAIN_ORDER, DOMAINS } from '@/config/domains';
import { getDomainConfig } from '@/config/registry';
import { OV_TABS, type OverviewTab } from '@/config/overviewDomain';
import { useCompanyProfile } from '@/services/regulationsApi';
import type { Entity } from '@/types/entity';
import { can, useMe } from '@/services/authApi';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { cn, getField } from '@/utils/ui';
import { tx, useT } from '@/i18n';

/* ---------------- colour for each kind of company record (categorical, never a status) ---------------- */
type DomainKey = (typeof DOMAIN_ORDER)[number];
const DOMAIN_LOOK: Record<string, { hex: string; tone: MetricTone; tile: string; bar: string }> = {
  people: { hex: '#2563eb', tone: 'brand', tile: 'bg-blue-50 text-blue-600', bar: 'bg-blue-500' },
  processes: { hex: '#8b5cf6', tone: 'purple', tile: 'bg-violet-50 text-violet-600', bar: 'bg-violet-500' },
  systems: { hex: '#14b8a6', tone: 'teal', tile: 'bg-teal-50 text-teal-600', bar: 'bg-teal-500' },
  data: { hex: '#0ea5e9', tone: 'brand', tile: 'bg-sky-50 text-sky-600', bar: 'bg-sky-500' },
  policies: { hex: '#f59e0b', tone: 'amber', tile: 'bg-amber-50 text-amber-600', bar: 'bg-amber-500' },
  controls: { hex: '#10b981', tone: 'green', tile: 'bg-emerald-50 text-emerald-600', bar: 'bg-emerald-500' },
  risks: { hex: '#ec4899', tone: 'red', tile: 'bg-pink-50 text-pink-600', bar: 'bg-pink-500' },
  evidence: { hex: '#6366f1', tone: 'purple', tile: 'bg-indigo-50 text-indigo-600', bar: 'bg-indigo-500' },
  overview: { hex: '#64748b', tone: 'gray', tile: 'bg-slate-100 text-slate-600', bar: 'bg-slate-500' },
};
const look = (d: string) => DOMAIN_LOOK[d] ?? DOMAIN_LOOK.overview;

/** Verification states keep the status meanings: verified green, pending amber, review orange, rejected red. */
const VER_HEX: Record<string, string> = { Verified: '#16a34a', Pending: '#f59e0b', 'Needs Review': '#f97316', Rejected: '#dc2626' };
const CRIT_HEX: Record<string, string> = { Critical: '#dc2626', High: '#f97316', Medium: '#f59e0b', Low: '#94a3b8' };
const VER_ORDER = [tx('Verified'), tx('Pending'), tx('Needs Review'), tx('Rejected')] as const;
const CRIT_ORDER = [tx('Critical'), tx('High'), tx('Medium'), tx('Low')] as const;

/** An icon for each Overview sub-tab. */
const TAB_ICON: Record<string, string> = {
  summary: 'LayoutGrid', 'company-profile': 'Building2', 'business-activities': 'Briefcase', 'legal-entities': 'Landmark',
  locations: 'MapPin', jurisdictions: 'Globe', industries: 'Factory', products: 'Package', organization: 'FolderTree',
  licenses: 'BadgeCheck', 'regulatory-scope': 'Scale', 'critical-functions': 'HeartPulse', completeness: 'Gauge',
  'data-quality': 'ListChecks', verification: 'ShieldCheck', activity: 'Activity',
};

/**
 * The tabs the strip shows. Each groups one or more of the OV_TABS views,
 * stacked in order; any old /overview/<slug> lands on the group holding it, and
 * one with no group here (the old Profile tables) lands on Summary.
 * Data health is for administrators of the open company. So are Verification
 * and Activity, which stay reachable by URL (Data health links to them) and
 * appear as an extra tab only while open.
 */
interface OvGroup { id: string; label: string; members: string[]; countOf?: string }
const OV_GROUPS: OvGroup[] = [
  { id: 'summary', label: 'Summary', members: ['summary'] },
  { id: 'licenses', label: 'Licences', members: ['licenses'], countOf: 'licenses' },
];
const DATA_HEALTH: OvGroup = { id: 'data-health', label: 'Data health', members: ['completeness', 'data-quality'] };
const HIDDEN_GROUPS: OvGroup[] = ['verification', 'activity'].map((id) => {
  const t = OV_TABS.find((x) => x.id === id);
  return { id, label: t?.label ?? id, members: [id], countOf: id };
});
const groupFor = (slug: string | undefined, admin: boolean): OvGroup =>
  (admin ? [...OV_GROUPS, DATA_HEALTH, ...HIDDEN_GROUPS] : OV_GROUPS)
    .find((g) => g.id === slug || g.members.includes(slug ?? '')) ?? OV_GROUPS[0];

const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function OverviewPage() {
  const { subtab } = useParams<{ subtab?: string }>();
  // callbacks below name their item `t`, so the translate function is `tr` here
  const tr = useT();
  const { entities } = useData(); // subscribe
  const navigate = useNavigate();
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const group = groupFor(subtab, admin);
  const views = group.members.map((id) => OV_TABS.find((t) => t.id === id)).filter((t): t is OverviewTab => !!t);
  const stacked = views.length > 1;
  const tabs = admin ? [...OV_GROUPS, DATA_HEALTH] : OV_GROUPS;
  const strip = HIDDEN_GROUPS.includes(group) ? [...tabs, group] : tabs;

  // an old per-section link (/overview/locations) opens its group, scrolled to that section
  useEffect(() => {
    if (subtab && subtab !== group.id && group.members.includes(subtab)) {
      document.getElementById(`ov-${subtab}`)?.scrollIntoView({ block: 'start' });
    }
  }, [subtab, group]);

  // counts in the tab labels — rows per table tab, records still to verify
  const tabCount = useMemo(() => {
    const ov = entities.filter((e) => e.domain === 'overview');
    const m = new Map<string, number>();
    for (const t of OV_TABS) {
      if (t.kind === 'table') m.set(t.id, ov.filter((e) => e.type === t.filterType).length);
      if (t.kind === 'verification') m.set(t.id, ov.filter((e) => e.verification !== 'Verified').length);
    }
    return m;
  }, [entities]);

  return (
    <>
      <Topbar
        title="Overview"
        subtitle="The company itself and the licences it holds"
        icon="LayoutGrid"
        below={
          <TabStrip
            ariaLabel="Overview sections"
            tabs={strip.map((g) => ({ key: g.id, label: g.label, count: (g.countOf && tabCount.get(g.countOf)) || undefined }))}
            active={group.id}
            onChange={(id) => navigate(id === 'summary' ? '/overview' : `/overview/${id}`)}
          />
        }
      />

      <div className={cn('p-6', stacked ? 'space-y-8' : 'space-y-4')}>
        {group === DATA_HEALTH && <RecordsHealth />}
        {views.map((v) => stacked ? (
          <section key={v.id} id={`ov-${v.id}`} className="scroll-mt-4 space-y-4">
            <div className="flex items-center gap-2.5">
              <IconTile icon={TAB_ICON[v.id] ?? 'LayoutGrid'} tone="brand" size="sm" />
              <h2 className="text-[16px] font-semibold text-ink">{tr(v.label)}</h2>
              {tabCount.has(v.id) && (
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-brand-700">{tabCount.get(v.id)}</span>
              )}
            </div>
            <TabView tab={v} />
          </section>
        ) : <TabView key={v.id} tab={v} />)}
      </div>
    </>
  );
}

/** One OV_TABS view, by kind. */
function TabView({ tab }: { tab: OverviewTab }) {
  return (
    <>
      {tab.kind === 'summary' && <SummaryView />}
      {tab.kind === 'table' && <TableView tab={tab} />}
      {tab.kind === 'completeness' && <CompletenessView />}
      {tab.kind === 'data-quality' && <DataQualityView />}
      {tab.kind === 'verification' && <VerificationView />}
      {(tab.kind === 'activity' || tab.kind === 'history') && <ActivityView />}
    </>
  );
}

/* ---------------- Summary — who the company is, and its licences ---------------- */
const OP_DOMAINS = ['processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence'];

/** A profile list field may arrive as JSON or as "a, b, c". */
function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String).filter(Boolean); } catch { /* plain text */ }
  }
  return s.split(/\s*[,;]\s*/).filter(Boolean);
}

function SummaryView() {
  // The company's own profile — what someone entered in Company Setup. Until
  // then the header says so; it never shows an example company as if it were
  // this one.
  const tr = useT();
  const { data: profileRes } = useCompanyProfile();
  const profile = (profileRes?.profile ?? null) as Record<string, string | number | null> | null;
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const { entities } = useData();
  const licenceTab = OV_TABS.find((t) => t.id === 'licenses');
  const licences = entities.filter((e) => e.domain === 'overview' && e.type === licenceTab?.filterType);

  const lic = useMemo(() => {
    const now = Date.now();
    let expired = 0, soon = 0, dated = 0;
    for (const e of licences) {
      const d = dateOf(e.attrs.validTill ?? e.attrs.expiryDate);
      if (d === undefined) continue;
      dated += 1;
      if (d < now) expired += 1; else if (d - now <= 90 * 86_400_000) soon += 1;
    }
    const verified = licences.filter((e) => e.verification === 'Verified').length;
    return { expired, soon, dated, verified, pending: licences.length - verified };
  }, [licences]);
  const sectors = profile ? listOf(profile.sectors) : [];
  const jurisdictions = profile ? listOf(profile.jurisdictions) : [];
  const facts = profile ? ([
    ['MapPin', tx('Head office'), profile.hq_state],
    ['CalendarClock', tx('Incorporated'), profile.incorporated],
    ['Users', tx('Employees'), profile.employees],
    ['Hash', tx('CIN'), profile.registration_no],
  ] as const).filter(([, , v]) => v) : [];

  return (
    <>
      {/* who the company is: a name, the facts that identify it, what it does and where */}
      <section className="card overflow-hidden">
        {profile ? (<>
          <div className="flex flex-wrap items-center gap-4 border-b border-line bg-gradient-to-r from-brand-50/70 via-white to-white px-5 py-4">
            <span className="rounded-[18px] bg-white p-0.5 shadow-card ring-1 ring-black/5">
              <CompanyLogo name={String(profile.legal_name ?? '?')} size={52} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">{tr('Company profile')}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <h2 className="text-[22px] font-semibold capitalize leading-tight tracking-tight text-ink">{String(profile.legal_name ?? '').toLowerCase()}</h2>
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold', profile.source_verified ? 'bg-success-50 text-success-600' : 'bg-warning-50 text-warning-600')}>
                  {profile.source_verified ? <BadgeCheck className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
                  {tr(profile.source_verified ? 'Confirmed' : 'Not yet confirmed')}
                </span>
              </div>
              {profile.entity_type && <p className="text-[13px] text-muted">{profile.entity_type}</p>}
            </div>
            {admin && <Link to="/company-setup" className="btn btn-sm shrink-0">{tr('Edit profile')}</Link>}
          </div>

          {/* the facts, each with its name above it */}
          {facts.length > 0 && (
            <dl className="pm-stagger grid grid-cols-1 gap-px bg-line sm:grid-cols-2 2xl:grid-cols-4">
              {facts.map(([icon, label, value]) => (
                <div key={label} className="flex min-w-0 items-center gap-3 bg-white px-5 py-3.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><Icon name={icon} className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <dt className="text-[11.5px] text-muted">{tr(label)}</dt>
                    <dd className="truncate text-[14px] font-semibold tabular-nums text-ink" title={String(value)}>{label === 'Incorporated' ? niceDate(value) : String(value)}</dd>
                  </div>
                  {label === 'CIN' && <CopyButton text={String(value)} />}
                </div>
              ))}
            </dl>
          )}

          {(sectors.length > 0 || jurisdictions.length > 0) && (
            <div className="grid gap-4 border-t border-line px-5 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              {sectors.length > 0 && (
                <div>
                  <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{tr('What it does')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {sectors.slice(0, 8).map((x) => (
                      <span key={x} className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[12.5px] font-medium text-ink-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />{x}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {jurisdictions.length > 0 && (
                <div>
                  <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{tr('Where it operates')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {jurisdictions.slice(0, 6).map((x) => (
                      <span key={x} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[12.5px] font-medium text-brand-700">
                        <Icon name="MapPin" className="h-3.5 w-3.5" />{x}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>) : (
          <div className="flex flex-wrap items-center gap-4 p-5">
            <IconTile icon="Building2" tone="brand" size="lg" />
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold text-ink">{tr('No company profile yet')}</div>
              <p className="text-[13px] text-muted">{tr('What this page shows comes from what you enter and connect — nothing is filled in for you.')}</p>
            </div>
            {admin && <Link to="/company-setup" className="btn btn-primary">{tr('Set up the company')}</Link>}
          </div>
        )}
      </section>

      {/* the licences in four plain figures, each saying what it counts */}
      {licences.length > 0 && (
        <section className="card grid grid-cols-1 gap-px overflow-hidden bg-line sm:grid-cols-2 xl:grid-cols-4">
          <LicFigure icon={FileBadge} tone="blue" n={licences.length} label={tr('Licences and registrations')} />
          <LicFigure icon={BadgeCheck} tone={lic.verified ? 'green' : 'slate'} n={lic.verified} label={tr('Verified')}
                     sub={lic.pending ? tr('{n} waiting for review', { n: lic.pending.toLocaleString() }) : `${pctOf(lic.verified, licences.length)}%`}
                     share={lic.verified / licences.length} />
          <LicFigure icon={CalendarClock} tone={lic.soon ? 'amber' : 'slate'} n={lic.soon} label={tr('Expiring within 90 days')}
                     sub={tr('of {n} with a validity date', { n: lic.dated.toLocaleString() })} />
          <LicFigure icon={XCircle} tone={lic.expired ? 'red' : 'slate'} n={lic.expired} label={tr('Expired')}
                     sub={tr('of {n} with a validity date', { n: lic.dated.toLocaleString() })} />
        </section>
      )}

      {licenceTab && licences.length > 0 && <RecordTable tab={licenceTab} rows={licences} />}
    </>
  );
}

/** "1989-11-20" → "20 Nov 1989"; anything else as it was written */
function niceDate(v: unknown): string {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : s;
}

/** copies a value (the CIN) and says so for a moment */
function CopyButton({ text }: { text: string }) {
  const tr = useT();
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1400); }); }}
            title={tr(done ? 'Copied' : 'Copy')} aria-label={tr(done ? 'Copied' : 'Copy')}
            className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full transition', done ? 'bg-success-50 text-success-600' : 'text-muted hover:bg-slate-100 hover:text-ink')}>
      {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

const LIC_TONE: Record<string, [string, string]> = {
  blue: ['bg-brand-50 text-brand-600', 'text-ink'], green: ['bg-success-50 text-success-600', 'text-success-600'],
  amber: ['bg-warning-50 text-warning-600', 'text-warning-600'], red: ['bg-critical-50 text-critical-600', 'text-critical-600'],
  slate: ['bg-slate-100 text-slate-400', 'text-slate-400'],
};
/** one licence figure: icon, number, what it counts, and a line of context */
function LicFigure({ icon: I, tone, n, label, sub, share }: { icon: typeof FileBadge; tone: string; n: number; label: string; sub?: string; share?: number }) {
  const [tile, num] = LIC_TONE[tone];
  return (
    <div className="flex min-w-0 items-center gap-3.5 bg-white px-5 py-4">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-2xl', tile)}><I className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <CountUpNum value={n} className={cn('block text-[24px] font-bold leading-none tracking-tight tabular-nums', n ? num : 'text-slate-300')} />
        <span className="mt-1 block text-[13px] font-semibold leading-tight text-ink">{label}</span>
        {share != null && (
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span className="block h-full rounded-full bg-success-500 transition-[width] duration-700" style={{ width: `${Math.max(2, share * 100)}%` }} />
          </span>
        )}
        {sub && <p className="mt-0.5 text-[12px] leading-snug text-muted">{sub}</p>}
      </div>
    </div>
  );
}

/* ---------------- Data health — how sound the record is (administrators) ---------------- */
function RecordsHealth() {
  const t = useT();
  const { entities, relationships, history } = useData();
  const companyDomains = new Set<string>(DOMAIN_ORDER);
  const company = entities.filter((e) => companyDomains.has(e.domain));
  const companyIds = new Set(company.map((e) => e.id));
  const links = relationships.filter((r) => companyIds.has(r.sourceId) && companyIds.has(r.targetId)).length;
  const verified = company.filter((e) => e.verification === 'Verified').length;
  const completeness = company.length ? Math.round((verified / company.length) * 100) : 0;

  const byVer: Slice[] = VER_ORDER.map((v) => ({ label: v, value: company.filter((e) => e.verification === v).length, color: VER_HEX[v] }))
    .filter((x) => x.value > 0);
  const ownable = company.filter((e) => OP_DOMAINS.includes(e.domain));
  const owned = ownable.filter((e) => e.ownerId).length;
  const byCrit: Slice[] = CRIT_ORDER.map((c) => ({ label: c, value: company.filter((e) => e.criticality === c).length, color: CRIT_HEX[c] }));

  return (
    <div className="space-y-4">
      {/* how much of the record has been confirmed */}
      <section className="card flex flex-wrap items-center gap-4 p-5">
        <ScoreRing value={completeness} size={92} thickness={10}
                   label={<span className="text-[20px] font-bold tabular-nums text-ink">{completeness}%</span>}
                   sub={<span className="text-[11px] text-muted">{t('verified')}</span>} />
        <div className="text-[13px]">
          <div className="font-semibold text-ink">{t('{n} of {total} records', { n: verified.toLocaleString(), total: company.length.toLocaleString() })}</div>
          <div className="text-muted">{t('confirmed by a person')}</div>
          <Link to="/overview/verification" className="btn btn-sm btn-primary mt-2">{t('Verify records')}</Link>
        </div>
      </section>

      {/* every kind of company record, its size and how far it is confirmed */}
      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-ink">{t('Company records')}</h3>
          <span className="text-[12.5px] text-muted">
            {t('{n} records', { n: company.length.toLocaleString() })} · {t('{n} links', { n: links.toLocaleString() })} ·{' '}
            <Link to="/departments" className="font-medium text-brand-600 hover:underline">{t('By department')}</Link>
          </span>
        </div>
        <DomainMap />
      </section>

      {/* what changed lately, beside how sound the record is. "Needs your attention"
          is not repeated here: it is on this same tab, under Data Quality. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Section title="Recent activity" icon="Activity" tone="teal"
                 action={<Link to="/overview/activity" className="text-[13px] font-medium text-brand-600 hover:underline">{t('View all')}</Link>}>
          {history.length === 0 ? <p className="py-4 text-[13px] text-muted">{t('No activity yet.')}</p> : (
            <ol className="divide-y divide-slate-100">
              {history.slice(0, 6).map((h) => {
                const st = activityStyle(h.action);
                return (
                  <li key={h.id} className="flex items-center gap-3 py-2.5 text-[13px] first:pt-0 last:pb-0">
                    <IconTile icon={st.icon} tone={st.tone} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink first-letter:uppercase">{h.action}</div>
                      <div className="truncate text-xs text-muted">{h.by}{h.detail ? ` · ${h.detail}` : ''}</div>
                    </div>
                    {h.at && <span className="shrink-0 text-xs text-muted">{h.at}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </Section>

        <Section title="Record health" icon="ShieldCheck" tone="green">
          <div className="space-y-5">
            <div>
              <div className="mb-2 flex items-baseline justify-between text-[13px]">
                <span className="font-medium text-ink">{t('Verification')}</span>
                <span className="text-xs text-muted"><b className="text-success-600">{completeness}%</b> {t('verified')}</span>
              </div>
              {byVer.length ? <StackedBar data={byVer} height={10} /> : <p className="text-xs text-muted">{t('No records yet.')}</p>}
            </div>
            <div>
              <div className="mb-2 flex items-baseline justify-between text-[13px]">
                <span className="font-medium text-ink">{t('Ownership')}</span>
                <span className="text-xs text-muted"><b className="text-ink-2">{pctOf(owned, ownable.length)}%</b> {t('have an owner')}</span>
              </div>
              {ownable.length ? (
                <StackedBar height={10} data={[
                  { label: 'Owner assigned', value: owned, color: '#16a34a' },
                  { label: 'No owner', value: ownable.length - owned, color: '#dc2626' },
                ]} />
              ) : <p className="text-xs text-muted">{t('No operating records yet.')}</p>}
            </div>
            <div>
              <div className="mb-2 text-[13px] font-medium text-ink">{t('Criticality')}</div>
              <BarList data={byCrit} />
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* Domain map — each domain is a clickable card showing size, verified %, and any attention flag. */
function DomainMap() {
  const t = useT();
  const navigate = useNavigate();
  const { entities } = useData();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8 xl:max-2xl:gap-2.5">
      {DOMAIN_ORDER.map((d: DomainKey) => {
        const list = entities.filter((e) => e.domain === d);
        const v = list.length ? Math.round((list.filter((e) => e.verification === 'Verified').length / list.length) * 100) : 0;
        const unverified = list.filter((e) => e.verification !== 'Verified').length;
        const noOwner = OP_DOMAINS.includes(d) ? list.filter((e) => !e.ownerId).length : 0;
        const l = look(d);
        return (
          <button
            key={d}
            onClick={() => navigate(`/${d}`)}
            className="card group p-3.5 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop xl:max-2xl:p-3"
          >
            <span className={cn('grid h-9 w-9 place-items-center rounded-lg', l.tile)}>
              <Icon name={DOMAINS[d].icon} className="h-[18px] w-[18px]" />
            </span>
            <div className="mt-2.5 text-[22px] font-bold leading-none tabular-nums text-ink">{list.length.toLocaleString()}</div>
            <div className="mt-1 text-[13px] font-medium text-ink-2">{t(DOMAINS[d].title)}</div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={cn('h-full rounded-full', v >= 80 ? 'bg-success-500' : v >= 50 ? 'bg-warning-500' : list.length ? 'bg-critical-500' : 'bg-slate-200')} style={{ width: `${Math.max(v, list.length ? 2 : 0)}%` }} />
            </div>
            {/* each phrase stays whole: on a narrow tile the second one moves to its own line */}
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11.5px] text-muted [&>span]:whitespace-nowrap">
              <span>{t('{n}% verified', { n: v })}</span>
              {noOwner > 0 && <span className="font-medium text-critical-600" title={t('{n} with no owner', { n: noOwner.toLocaleString() })}>{t('{n} no owner', { n: noOwner.toLocaleString() })}</span>}
              {!noOwner && unverified > 0 && <span title={t('{n} to verify', { n: unverified.toLocaleString() })}>{t('{n} to verify', { n: unverified.toLocaleString() })}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* Attention signals — the same four everywhere they are listed. */
function useAttention() {
  const { entities } = useData();
  return useMemo(() => {
    const companyDomains = new Set<string>(DOMAIN_ORDER);
    const company = entities.filter((e) => companyDomains.has(e.domain));
    const all: { key: string; label: string; hint: string; icon: string; tone: MetricTone; pill: string; rows: Entity[]; of: number; deepLink?: string }[] = [
      { key: 'owner', label: 'Missing owner', hint: '{pct}% of operating records with nobody accountable', icon: 'UserX', tone: 'red', pill: 'bg-critical-500 text-white',
        rows: company.filter((e) => OP_DOMAINS.includes(e.domain) && !e.ownerId), of: company.filter((e) => OP_DOMAINS.includes(e.domain)).length },
      { key: 'verify', label: 'Needs verification', hint: '{pct}% of records nobody has confirmed yet', icon: 'ShieldAlert', tone: 'amber', pill: 'bg-amber-400 text-amber-950',
        rows: company.filter((e) => e.verification !== 'Verified'), of: company.length },
      { key: 'risk', label: 'High & critical risks', hint: '{pct}% of risks rated high or critical', icon: 'Flame', tone: 'red', pill: 'bg-critical-500 text-white',
        rows: company.filter((e) => e.domain === 'risks' && (e.criticality === 'Critical' || e.criticality === 'High')), of: company.filter((e) => e.domain === 'risks').length,
        deepLink: '/risks/register?criticality=Critical,High' },
      { key: 'evidence', label: 'Expiring / expired evidence', hint: '{pct}% of evidence past or near its expiry', icon: 'Clock', tone: 'orange', pill: 'bg-notcov-600 text-white',
        rows: company.filter((e) => e.domain === 'evidence' && ['Expired', 'Approaching Expiry'].includes(String(e.attrs.freshness ?? ''))),
        of: company.filter((e) => e.domain === 'evidence').length },
      // (no "low-confidence" item: records carry no confidence score from the server)
    ];
    return all;
  }, [entities]);
}

/* Attention panel — every item is clickable, expands the affected entities inline, and opens the drawer to act. */
function AttentionPanel() {
  const t = useT();
  const navigate = useNavigate();
  const openEntity = useUi((s) => s.openEntity);
  const [open, setOpen] = useState<string | null>(null);
  const items = useAttention().filter((i) => i.rows.length > 0);

  return (
    <Section title="Needs your attention" icon="Bell" tone="amber" action={<span className="text-xs text-muted">{t('Select an item to act')}</span>}>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center text-[13px] text-muted">
          <IconTile icon="CircleCheck" tone="green" size="lg" />
          {t('Nothing needs attention — the brain is healthy.')}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const isOpen = open === it.key;
            return (
              <li key={it.key} className={cn('rounded-xl border transition', isOpen ? 'border-brand-200 bg-brand-50/30' : 'border-line hover:border-line-2')}>
                <div className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
                  <button onClick={() => setOpen(isOpen ? null : it.key)} aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <IconTile icon={it.icon} tone={it.tone} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold text-ink">{t(it.label)}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums', it.pill)}>{it.rows.length}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-2">
                        <span className="h-1.5 max-w-[180px] flex-1 overflow-hidden rounded-full bg-slate-100">
                          <span className={cn('block h-full rounded-full', it.tone === 'red' ? 'bg-critical-500' : it.tone === 'orange' ? 'bg-notcov-500' : 'bg-warning-500')}
                                style={{ width: `${Math.max(2, pctOf(it.rows.length, it.of))}%` }} />
                        </span>
                        <span className="truncate text-xs text-muted">{t(it.hint, { pct: pctOf(it.rows.length, it.of) })}</span>
                      </span>
                    </span>
                    <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-2 transition', isOpen && 'rotate-90')} />
                  </button>
                  {it.deepLink && (
                    <button
                      onClick={() => navigate(it.deepLink!)}
                      className="shrink-0 text-xs font-semibold text-brand-600 hover:underline"
                    >
                      {t('View all →')}
                    </button>
                  )}
                </div>
                {isOpen && (
                  <ul className="mx-3 mb-2.5 space-y-0.5 border-t border-line pt-2">
                    {it.rows.slice(0, 8).map((e) => (
                      <li key={e.id}>
                        <button onClick={() => openEntity(e.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-2xs hover:bg-white">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', look(e.domain).bar)} />
                          <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.name}</span>
                          <Badge value={t(getDomainConfig(e.domain)?.title ?? e.domain)} kind="plain" size="sm" />
                        </button>
                      </li>
                    ))}
                    {it.rows.length > 8 && <li className="px-2 pt-0.5 text-2xs text-muted-2">{t('+{n} more…', { n: (it.rows.length - 8).toLocaleString() })}</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ---------------- Table view (the licence register) ---------------- */
/** A date-like attribute, read as a date: "2027-03-31", "31/03/2027". */
function dateOf(v: unknown): number | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s.slice(0, 10)) : NaN;
  if (Number.isFinite(iso)) return iso;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return undefined;
}

/** The records of one table tab, as a list. */
function RecordTable({ tab, rows }: { tab: OverviewTab; rows: Entity[] }) {
  const t = useT();
  const openEntity = useUi((s) => s.openEntity);
  // a column no row has a value for says nothing — keep the name column and verification always
  const columns = (tab.columns ?? []).filter((c) => c.kind === 'name' || c.key === 'verification'
    || rows.some((e) => { const v = getField(e, c.key); return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== '—'; }));
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <IconTile icon={TAB_ICON[tab.id] ?? 'LayoutGrid'} tone="brand" size="sm" />
        <span className="text-[15px] font-semibold text-ink">{t(tab.label)}</span>
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-brand-700">{rows.length}</span>
        <span className="ml-auto hidden text-xs text-muted sm:inline">{t('Select a row to open it')}</span>
      </div>
      <DataTable rows={rows} columns={columns} onRowClick={(e) => openEntity(e.id)} />
    </div>
  );
}

function TableView({ tab }: { tab: OverviewTab }) {
  const { entities } = useData();
  const rows = useMemo(() => entities.filter((e) => e.domain === 'overview' && e.type === tab.filterType), [entities, tab.filterType]);
  // the table alone: the count, verified and by-category strip above it repeated the table's own columns
  return <RecordTable tab={tab} rows={rows} />;
}

/* ---------------- Completeness ---------------- */
function CompletenessView() {
  const t = useT();
  const { entities } = useData();
  const groups = [...DOMAIN_ORDER, 'overview'] as const;
  const scoped = entities.filter((e) => (groups as readonly string[]).includes(e.domain));
  const verified = scoped.filter((e) => e.verification === 'Verified').length;
  const overall = pctOf(verified, scoped.length);
  const pending = scoped.filter((e) => e.verification === 'Pending').length;
  const review = scoped.filter((e) => e.verification === 'Needs Review').length;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Overall completeness" value={`${overall}%`} tone={overall >= 80 ? 'green' : overall >= 50 ? 'amber' : 'red'} icon="Gauge" />
        <MetricCard label="Verified records" value={verified} tone="green" icon="CheckCircle2" pct={scoped.length ? overall : undefined} />
        <MetricCard label="Pending" value={pending} tone="amber" icon="Clock" pct={scoped.length ? pctOf(pending, scoped.length) : undefined} />
        <MetricCard label="Needs review" value={review} tone="orange" icon="FileWarning" pct={scoped.length ? pctOf(review, scoped.length) : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section title="Completeness by domain" icon="BarChart3" tone="brand">
          <div className="space-y-3">
            {groups.map((d) => {
              const list = entities.filter((e) => e.domain === d);
              const ok = list.filter((e) => e.verification === 'Verified').length;
              const v = list.length ? Math.round((ok / list.length) * 100) : 0;
              const label = d === 'overview' ? 'Overview' : DOMAINS[d as Exclude<typeof d, 'overview'>].title;
              const ic = d === 'overview' ? 'LayoutGrid' : DOMAINS[d as Exclude<typeof d, 'overview'>].icon;
              return (
                <div key={d} className="grid grid-cols-[150px_1fr_auto] items-center gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2 text-ink-2">
                    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', look(d).tile)}><Icon name={ic} className="h-3.5 w-3.5" /></span>
                    <span className="truncate">{t(label)}</span>
                  </span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={cn('h-full rounded-full', v >= 80 ? 'bg-success-500' : v >= 50 ? 'bg-warning-500' : 'bg-critical-500')} style={{ width: `${Math.max(v, list.length ? 2 : 0)}%` }} />
                  </div>
                  <span className="w-[86px] text-right text-2xs">
                    <b className={cn('text-[13px]', v >= 80 ? 'text-success-600' : v >= 50 ? 'text-warning-600' : 'text-critical-600')}>{v}%</b>
                    <span className="ml-1 text-muted">{ok}/{list.length}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
        <Section title="What drives completeness" icon="Info" tone="purple">
          <div className="mb-4 flex justify-center">
            <ScoreRing value={overall} max={100} label={`${overall}%`} sub={t('verified overall')} />
          </div>
          <ul className="space-y-2 text-[13px] text-muted">
            <li className="flex gap-2"><Icon name="CheckCircle2" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" /><span>{t('An entity counts as complete once it reaches Verified with provenance and an owner.')}</span></li>
            <li className="flex gap-2"><Icon name="AlertTriangle" className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" /><span>{t('Pending and Needs-Review records lower the score for their domain.')}</span></li>
            <li className="flex gap-2"><Icon name="LayoutGrid" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" /><span>{t('Overview records (profile, licenses, legal entities) are tracked separately from the 8 operating domains.')}</span></li>
          </ul>
        </Section>
      </div>
    </>
  );
}

/* ---------------- Data Quality — the same actionable attention system ---------------- */
function DataQualityView() {
  const t = useT();
  const items = useAttention();
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {items.map((it) => (
          <MetricCard key={it.key} label={it.label} value={it.rows.length} tone={it.tone} icon={it.icon}
                      pct={it.of ? pctOf(it.rows.length, it.of) : undefined} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AttentionPanel />
        <Section title="How to read this" icon="Info" tone="brand">
          <ul className="space-y-2.5 text-[13px] text-muted">
            <Hint icon="Eye" tone="brand">{t('Every signal is clickable — expand it to see the affected entities, then open one to act.')}</Hint>
            <Hint icon="UserX" tone="red"><b className="text-ink">{t('Missing owner')}</b> → {t('open the entity → Owners tab → assign → it logs to History and clears here.')}</Hint>
            <Hint icon="ShieldAlert" tone="amber"><b className="text-ink">{t('Needs verification')}</b> → {t('open the entity → Verify.')}</Hint>
            <Hint icon="Flame" tone="red"><b className="text-ink">{t('High & critical risks')}</b> → {t('jump straight to the filtered Risk Register.')}</Hint>
          </ul>
        </Section>
      </div>
    </>
  );
}

function Hint({ icon, tone, children }: { icon: string; tone: MetricTone; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <IconTile icon={icon} tone={tone} size="sm" />
      <span className="pt-1.5">{children}</span>
    </li>
  );
}

/* ---------------- Verification (overview records not yet verified) ---------------- */
function VerificationView() {
  // OV_TABS.find below names its item `t`, so the translate function is `tr` here
  const tr = useT();
  const openEntity = useUi((s) => s.openEntity);
  const { entities } = useData();
  const overview = entities.filter((e) => e.domain === 'overview');
  const rows = overview.filter((e) => e.verification !== 'Verified');
  const byType: Slice[] = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of rows) m.set(e.type ?? 'Record', (m.get(e.type ?? 'Record') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value }));
  }, [rows]);
  const state = (v: string) => rows.filter((e) => e.verification === v).length;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="To verify" value={rows.length} tone="amber" icon="ShieldAlert" pct={overview.length ? pctOf(rows.length, overview.length) : undefined} />
        <MetricCard label="Pending" value={state('Pending')} tone="amber" icon="Clock" />
        <MetricCard label="Needs review" value={state('Needs Review')} tone="orange" icon="FileWarning" />
        <MetricCard label="Rejected" value={state('Rejected')} tone="red" icon="XCircle" />
      </div>
      {rows.length === 0 ? (
        <Section title="Verification" icon="ShieldCheck" tone="green">
          <div className="flex flex-col items-center gap-2 py-6 text-center text-[13px] text-muted">
            <IconTile icon="CircleCheck" tone="green" size="lg" />
            {tr('All Overview records are verified.')}
          </div>
        </Section>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3 text-[13px]">
              <IconTile icon="ShieldAlert" tone="amber" size="sm" />
              <span className="text-ink-2">{rows.length === 1
                ? tr('1 Overview record needs verification.')
                : tr('{n} Overview records need verification.', { n: rows.length.toLocaleString() })}</span>
            </div>
            <ul className="divide-y divide-line">
              {rows.map((e) => (
                <li key={e.id}>
                  <button onClick={() => openEntity(e.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-brand-50/40">
                    <IconTile icon={TAB_ICON[OV_TABS.find((t) => t.filterType === e.type)?.id ?? ''] ?? 'FileText'} tone="gray" size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{e.name}</div>
                      <div className="text-2xs text-muted">{e.type}</div>
                    </div>
                    <Badge value={e.verification} kind="verification" />
                    <ChevronRight className="h-4 w-4 text-muted-2" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <Section title="To verify, by type" icon="BarChart3" tone="purple">
            <BarList data={byType} />
          </Section>
        </div>
      )}
    </>
  );
}

/* ---------------- Activity / History ---------------- */
function ActivityView() {
  const t = useT();
  const { history } = useData();
  const stats = useMemo(() => {
    const actions = new Map<string, number>();
    const actors = new Map<string, number>();
    for (const h of history) {
      const a = h.action.replace(/^\w/, (c) => c.toUpperCase());
      actions.set(a, (actions.get(a) ?? 0) + 1);
      actors.set(h.by, (actors.get(h.by) ?? 0) + 1);
    }
    const top = (m: Map<string, number>): Slice[] => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
    return {
      actions: top(actions), actors: top(actors), people: actors.size,
      records: new Set(history.map((h) => h.entityId).filter(Boolean)).size,
      verified: history.filter((h) => /verif/i.test(h.action)).length,
    };
  }, [history]);

  if (history.length === 0) {
    return (
      <Section title="Activity" icon="Activity" tone="teal">
        <div className="py-6 text-center text-[13px] text-muted">{t('No activity yet.')}</div>
      </Section>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Events recorded" value={history.length} tone="brand" icon="Activity" />
        <MetricCard label="People and services acting" value={stats.people} tone="purple" icon="Users" />
        <MetricCard label="Records touched" value={stats.records} tone="teal" icon="FileText" />
        <MetricCard label="Verifications" value={stats.verified} tone="green" icon="ShieldCheck" pct={pctOf(stats.verified, history.length)} />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ActivityList items={history} wide />
        <div className="space-y-4">
          <Section title="By kind of change" icon="PieChart" tone="purple">
            <BarList data={stats.actions} />
          </Section>
          <Section title="By who acted" icon="Users" tone="brand">
            <BarList data={stats.actors} />
          </Section>
        </div>
      </div>
    </>
  );
}
