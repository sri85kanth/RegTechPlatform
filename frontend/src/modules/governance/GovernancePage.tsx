import { useMemo, useState } from 'react';
import {
  UserCheck, FileText, Loader2, Clock, Link2, Search as SearchIcon, ArrowRight, RefreshCw,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import {
  useGovernanceCoverage, useDelegations, useDocuments,
  useResolveOwners, useDeriveEdges, useSyncDocuments, useRevokeDelegation,
  type Delegation, type CompanyDoc,
} from '@/services/governanceApi';
import { can, useMe } from '@/services/authApi';
import { cn, readable } from '@/utils/ui';
import { MetricCard, EmptyState, Avatar, Callout, IconTile, Tag, Pager, type MetricTone } from '@/components/ui/primitives';
import { BarList, Donut, Progress, StackedBar, CHART } from '@/components/ui/charts';
import { TabStrip } from '@/components/ui/TabStrip';
import { ChartCard } from '@/modules/registry/ChartStrip';
import { DomainTile } from '@/modules/registry/DomainTile';
import { tx, useT } from '@/i18n';

const TABS = [tx('Ownership'), tx('Delegations'), tx('Document register')] as const;
type Tab = typeof TABS[number];

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** The colour of each accountability edge. */
const EDGE_HEX: Record<string, string> = { owns: '#2563eb', approves: '#16a34a', heads: '#8b5cf6', delegate_for: '#14b8a6' };
/** The same edges as the chart names them; any other kind is shown as the server spells it. */
const EDGE_LABEL: Record<string, string> = { owns: tx('Owns'), approves: tx('Approves'), heads: tx('Heads'), delegate_for: tx('Delegate for') };

/**
 * Governance — who is accountable, and what evidence exists.
 *
 * The derivation actions default to a DRY RUN. Rewriting ownership across the
 * whole estate is not something to trigger by accident, so the result is shown
 * before anything is written. They are admin tools: the Ownership tab holds only
 * them, so nobody else sees that tab.
 */
export function GovernancePage() {
  // `t` names a tab in the callbacks below, so the translate function is `tr` here
  const tr = useT();
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const [picked, setTab] = useState<Tab>('Ownership');
  const tab: Tab = picked === 'Ownership' && !admin ? 'Document register' : picked;
  const { data } = useGovernanceCoverage();

  const tabLabel = (t: Tab) => {
    if (!data) return t;
    if (t === 'Delegations') return `${tr(t)} (${data.edges.delegations.total.toLocaleString()})`;
    if (t === 'Document register') return `${tr(t)} (${data.documents.total.toLocaleString()})`;
    return t;
  };

  // An empty Delegations tab is hidden: it only lists and revokes delegations
  // (nothing is created there), so with none recorded it has nothing to offer.
  // It stays while it is the open tab, e.g. after the "Active delegations" card.
  // The Document register is kept even when empty — it holds "Sync collected files".
  const visibleTabs = TABS.filter((t) => (t === 'Ownership' ? admin
    : t !== 'Delegations' || !data || data.edges.delegations.total > 0 || tab === t));

  const noOwner = data ?Math.max(0, data.owners.entities - data.owners.withOwnerLink - data.owners.withOwnerNameOnly) : 0;
  const dl = data?.edges.delegations;
  const docs = data?.documents;

  return (
    <>
      <Topbar
        title="Governance"
        subtitle="Who owns it, who approves it, who is covering — and the evidence behind each"
        icon="ShieldCheck"
        tone="#0d9488"
        meta={
          data
            ? [
                { icon: 'Layers', label: 'Records', value: data.owners.entities.toLocaleString() },
                { icon: 'UserCheck', label: 'Owner linked', value: `${data.owners.coveragePct}%` },
                { icon: 'Building2', label: 'Departments headed', value: `${data.edges.departmentsWithHead} / ${data.edges.departmentsTotal}` },
                { icon: 'FileText', label: 'Documents', value: data.documents.total.toLocaleString() },
              ]
            : undefined
        }
        below={
          <TabStrip
            ariaLabel="Governance sections"
            tabs={visibleTabs.map((t) => ({ key: t, label: tabLabel(t) }))}
            active={tab}
            onChange={setTab}
          />
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {data && dl && docs && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <MetricCard label="Ownership coverage" value={`${data.owners.coveragePct}%`} icon="UserRound"
                   foot={tr('{n} of {total} owner-linked', { n: data.owners.withOwnerLink.toLocaleString(), total: data.owners.entities.toLocaleString() })}
                   tone={data.owners.coveragePct > 70 ? 'green' : 'amber'} />
              <MetricCard label="Departments with a head" value={`${data.edges.departmentsWithHead} / ${data.edges.departmentsTotal}`} icon="Building2"
                   pct={pctOf(data.edges.departmentsWithHead, data.edges.departmentsTotal)}
                   tone={data.edges.departmentsWithHead ? 'green' : 'amber'} />
              <MetricCard label="Active delegations" value={dl.active} icon="Users"
                   foot={dl.openEnded ? tr('{n} with no end date', { n: dl.openEnded }) : tr('all have an end date')}
                   tone={dl.openEnded ? 'amber' : 'green'}
                   onClick={() => setTab('Delegations')} />
              <MetricCard label="Documents on file" value={docs.total} icon="FileText"
                   foot={tr('{n} not linked to a record', { n: docs.unlinked.toLocaleString() })}
                   tone={docs.total ? 'brand' : 'amber'}
                   onClick={() => setTab('Document register')} />
              <MetricCard label="Without an approver" value={docs.withoutApprover} icon="FileWarning"
                   pct={docs.total ? pctOf(docs.withoutApprover, docs.total) : undefined}
                   tone="red"
                   onClick={() => setTab('Document register')} />
            </div>

            {'pending' in docs && typeof (docs as { pending?: unknown }).pending === 'string' && (
              <Callout tone="amber" title="Document register not ready">{String((docs as { pending?: unknown }).pending)}</Callout>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ChartCard title={tr('Record ownership')} icon="UserCheck" tone="green" note={tr('{n} records', { n: data.owners.entities.toLocaleString() })}>
                <Donut
                  size={128}
                  thickness={16}
                  center={`${Math.round(data.owners.coveragePct)}%`}
                  sub={tr('linked')}
                  data={[
                    { label: 'Linked to a person', value: data.owners.withOwnerLink, color: '#16a34a' },
                    { label: 'Named, not linked', value: data.owners.withOwnerNameOnly, color: '#f59e0b' },
                    { label: 'No owner', value: noOwner, color: '#dc2626' },
                  ]}
                />
              </ChartCard>

              <ChartCard title={tr('Accountability links')} icon="Link2" tone="brand">
                {Object.keys(data.edges.edges ?? {}).length === 0 ? (
                  <p className="text-[13px] text-muted">{tr('No owns, approves or heads links yet.')}</p>
                ) : (
                  <BarList
                    data={Object.entries(data.edges.edges).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({
                      label: EDGE_LABEL[k] ?? readable(k),
                      value: v,
                      color: EDGE_HEX[k] ?? CHART[i % CHART.length],
                    }))}
                  />
                )}
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted">{tr('Departments with a head')}</span>
                    <span className="font-medium tabular-nums text-ink-2">{tr('{n} of {total}', { n: data.edges.departmentsWithHead, total: data.edges.departmentsTotal })}</span>
                  </div>
                  <Progress value={data.edges.departmentsWithHead} total={data.edges.departmentsTotal} color="#8b5cf6" />
                </div>
              </ChartCard>

              <ChartCard title={tr('Document quality')} icon="FileCheck" tone="teal" note={tr('{n} documents', { n: docs.total.toLocaleString() })}>
                {docs.total === 0 ? (
                  <p className="text-[13px] text-muted">{tr('No documents on file yet.')}</p>
                ) : (
                  <div className="space-y-3.5">
                    {[
                      { label: 'Approver recorded', v: docs.total - docs.withoutApprover },
                      { label: 'Version recorded', v: docs.total - docs.withoutVersion },
                      { label: 'Linked to a record', v: docs.total - docs.unlinked },
                    ].map((r) => (
                      <div key={r.label}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-ink-2">{tr(r.label)}</span>
                          <span className="tabular-nums text-muted">{tr('{n} of {total}', { n: r.v.toLocaleString(), total: docs.total.toLocaleString() })}</span>
                        </div>
                        <Progress
                          value={r.v}
                          total={docs.total}
                          color={pctOf(r.v, docs.total) >= 80 ? '#16a34a' : pctOf(r.v, docs.total) >= 40 ? '#f59e0b' : '#dc2626'}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </ChartCard>

              <ChartCard title={tr('Delegations')} icon="Users" tone="amber" note={tr('{n} recorded', { n: dl.total.toLocaleString() })}>
                {dl.total === 0 ? (
                  <p className="text-[13px] text-muted">{tr('No delegations recorded.')}</p>
                ) : (
                  <StackedBar
                    height={12}
                    data={[
                      { label: 'Active, dated', value: Math.max(0, dl.active - dl.openEnded), color: '#16a34a' },
                      { label: 'Open-ended', value: dl.openEnded, color: '#f59e0b' },
                      { label: 'Expired', value: dl.expired, color: '#dc2626' },
                      { label: 'Other', value: Math.max(0, dl.total - dl.active - dl.expired), color: '#94a3b8' },
                    ].filter((d) => d.value > 0)}
                  />
                )}
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  {tr('An open-ended delegation is flagged: it is indistinguishable from a permanent transfer of accountability.')}
                </p>
              </ChartCard>
            </div>
          </>
        )}

        {tab === 'Ownership' && <Ownership />}
        {tab === 'Delegations' && <Delegations />}
        {tab === 'Document register' && <Documents />}
      </div>
    </>
  );
}

function ActionCard({
  icon, tone, title, children, actions,
}: { icon: string; tone: MetricTone; title: string; children: React.ReactNode; actions: React.ReactNode }) {
  const t = useT();
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tone={tone} size="md" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">{t(title)}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">{actions}</div>
    </div>
  );
}

function Ownership() {
  const t = useT();
  const resolve = useResolveOwners();
  const derive = useDeriveEdges();
  const [preview, setPreview] = useState<{ what: string; apply: boolean; result: Record<string, unknown> } | null>(null);

  const run = (m: typeof resolve, what: string, apply: boolean) =>
    m.mutate(apply, { onSuccess: (r) => setPreview({ what, apply, result: r as Record<string, unknown> }) });

  // the top-level figures of a run, as chips; the full result stays below
  const figures = preview
    ? Object.entries(preview.result)
        .map(([k, v]): [string, number] | null =>
          typeof v === 'number' ? [k, v] : Array.isArray(v) ? [k, v.length] : null)
        .filter((x): x is [string, number] => x !== null)
    : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ActionCard
          icon="UserCheck"
          tone="brand"
          title="Resolve owner names into owner records"
          actions={
            <>
              <button className="btn btn-sm btn-outline" disabled={resolve.isPending} onClick={() => run(resolve, tx('Resolve owners'), false)}>
                {resolve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('Dry run')}
              </button>
              <button className="btn btn-sm btn-primary" disabled={resolve.isPending} onClick={() => run(resolve, tx('Resolve owners'), true)}>
                <UserCheck className="h-3.5 w-3.5" /> {t('Apply')}
              </button>
            </>
          }
        >
          {t('Many records carry an owner as free text. Until that is linked to a real person, "who owns this?" returns a string you cannot route an approval to. Matching is deliberately conservative — an ambiguous name is left unset and reported, because a wrong owner misroutes approvals and makes the audit trail untrue.')}
        </ActionCard>

        <ActionCard
          icon="Link2"
          tone="purple"
          title="Link who owns, approves and heads what"
          actions={
            <>
              <button className="btn btn-sm btn-outline" disabled={derive.isPending} onClick={() => run(derive, tx('Link accountability'), false)}>
                {derive.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('Dry run')}
              </button>
              <button className="btn btn-sm" disabled={derive.isPending} onClick={() => run(derive, tx('Link accountability'), true)}>
                <Link2 className="h-3.5 w-3.5" /> {t('Apply')}
              </button>
            </>
          }
        >
          {t('Builds owns, approves and heads relationships from data already present, so accountability shows up in the graph and travels with impact analysis.')}
        </ActionCard>
      </div>

      {(resolve.error || derive.error) && (
        <Callout tone="red" title="The run failed">{((resolve.error || derive.error) as Error).message}</Callout>
      )}

      {preview && (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <IconTile icon={preview.apply ? 'CheckCircle2' : 'Eye'} tone={preview.apply ? 'green' : 'amber'} size="sm" />
            <h3 className="text-[15px] font-semibold text-ink">{t(preview.what)}</h3>
            <span className={cn('pill', preview.apply ? 'bg-success-50 text-success-600' : 'bg-warning-50 text-warning-600')}>
              {preview.apply ? t('Applied') : t('Dry run — nothing written')}
            </span>
          </div>
          {figures.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {figures.map(([k, v]) => (
                <span key={k} className="pill bg-slate-100 text-slate-600">
                  {readable(k.replace(/([a-z])([A-Z])/g, '$1 $2'))} <b className="tabular-nums text-ink">{v.toLocaleString()}</b>
                </span>
              ))}
            </div>
          )}
          <details open>
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">{t('Full result')}</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-[11.5px] leading-relaxed text-ink-2">
              {JSON.stringify(preview.result, null, 1)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

const DELEG_TONE: Record<string, string> = {
  active: 'bg-success-50 text-success-600',
  active_open_ended: 'bg-warning-50 text-warning-600',
  pending: 'bg-slate-100 text-slate-600',
  expired: 'bg-critical-50 text-critical-600',
  revoked: 'bg-slate-100 text-slate-600',
};
const DELEG_HEX: Record<string, string> = {
  active: '#16a34a', active_open_ended: '#f59e0b', pending: '#94a3b8', expired: '#dc2626', revoked: '#cbd5e1',
};
/** A delegation's status as shown; translate where drawn. */
const DELEG_NAME: Record<string, string> = {
  active: tx('Active'), active_open_ended: tx('Active open ended'), pending: tx('Pending'), expired: tx('Expired'), revoked: tx('Revoked'),
};
const statusName = (s: string) => DELEG_NAME[s] ?? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase());

function Delegations() {
  const t = useT();
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const { data } = useDelegations();
  const revoke = useRevokeDelegation();
  const items = data?.items ?? [];
  const byStatus = new Map<string, number>();
  for (const d of items) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);

  return (
    <div className="space-y-4">
      <Callout tone="blue" title="Open-ended delegations are flagged">
        {t('A delegation that never expires is indistinguishable from a permanent transfer of accountability, so open-ended ones are flagged rather than treated as normal.')}
      </Callout>
      {items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No delegations recorded"
            hint="Nothing is inferred here — a delegation exists only if someone recorded it."
            icon="Users"
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-line px-5 py-4">
            <StackedBar
              height={10}
              data={[...byStatus.entries()].map(([s, n]) => ({ label: statusName(s), value: n, color: DELEG_HEX[s] ?? '#94a3b8' }))}
            />
          </div>
          <ul className="divide-y divide-slate-100">
            {items.map((d: Delegation) => {
              const to = d.to_name || d.to_person;
              const from = d.from_name || d.from_person;
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-[13px] hover:bg-slate-50">
                  <span className="flex items-center gap-2">
                    <Avatar name={to} size={30} />
                    <span className="font-semibold text-ink">{to}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-muted">{t('acting for')} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                  <span className="flex items-center gap-2">
                    <Avatar name={from} size={30} />
                    <span className="font-semibold text-ink">{from}</span>
                  </span>
                  <span className={cn('pill', DELEG_TONE[d.status])}>{t(statusName(d.status))}</span>
                  {d.scope && <Tag tone="auto">{d.scope}</Tag>}
                  <span className="inline-flex items-center gap-1 text-muted">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {d.valid_from} → {d.valid_until || t('no end date')}
                  </span>
                  {admin && d.status.startsWith('active') && (
                    <button onClick={() => revoke.mutate(d.id)}
                            className="btn btn-sm ml-auto hover:border-critical-200 hover:bg-critical-50 hover:text-critical-600">
                      {t('Revoke')}
                    </button>
                  )}
                  {d.reason && <p className="w-full pl-[38px] text-xs text-muted">{d.reason}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const PAGE = 15;
function fileSize(n: number | null) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Documents() {
  const t = useT();
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const [type, setType] = useState<string>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useDocuments(type || undefined);
  const sync = useSyncDocuments();
  const items = useMemo(() => data?.items ?? [], [data]);
  const shown = useMemo(
    () => (q ? items.filter((d) => `${d.name} ${d.document_type ?? ''} ${d.approved_by ?? ''} ${d.entity_name ?? ''}`.toLowerCase().includes(q.toLowerCase())) : items),
    [items, q],
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages);
  const pageRows = shown.slice((cur - 1) * PAGE, cur * PAGE);
  const byType = Object.entries(data?.stats?.byType ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      {byType.length > 0 && (
        <ChartCard title={t('Documents by type')} icon="Files" tone="purple" note={t('click a bar to filter')}>
          <BarList
            className="grid gap-x-8 md:grid-cols-2 md:space-y-0 md:gap-y-2.5"
            data={byType.slice(0, 10).map(([dt, n], i) => ({
              label: dt,
              value: n,
              color: dt === 'Unclassified' ? '#f59e0b' : CHART[i % CHART.length],
              onClick: () => { setType(dt === type ? '' : dt); setPage(1); },
            }))}
          />
        </ChartCard>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-4 py-3">
          <div className="relative w-full sm:w-64">
            <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" aria-hidden="true" />
            <input className="input h-9 pl-9" placeholder={t('Search documents…')} aria-label={t('Search documents')} value={q}
                   onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            {t('Type')}
            <select className="input h-9 w-56" aria-label={t('Document type')} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">{t('All document types')}</option>
              {(data?.types ?? []).map((dt) => <option key={dt} value={dt}>{dt}</option>)}
            </select>
          </label>
          {admin && (
            <button className="btn btn-sm btn-outline h-9" disabled={sync.isPending} onClick={() => sync.mutate(undefined)}>
              {sync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              {t('Sync collected files')}
            </button>
          )}
          {data?.stats && (
            <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="pill bg-brand-50 text-brand-700">{t('{n} on file', { n: data.stats.total.toLocaleString() })}</span>
              <span className={cn('pill', data.stats.withoutVersion ? 'bg-warning-50 text-warning-600' : 'bg-success-50 text-success-600')}>
                {t('{n} without a version', { n: data.stats.withoutVersion.toLocaleString() })}
              </span>
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <IconTile icon="FileText" tone="gray" size="lg" className="mx-auto" />
            <div className="mt-3 text-sm font-semibold text-ink">{q ? t('No documents match your search') : t('No documents on file')}</div>
            {!q && (
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted">
                {t("Connect a folder or upload files; an administrator then runs Sync collected files. The type is inferred from the document's name and domain — never from its file extension.")}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="whitespace-nowrap border-b border-line bg-slate-50 text-xs font-semibold text-muted">
                    <th className="w-10 px-4 py-2.5">#</th>
                    <th className="px-4 py-2.5">{t('Document')}</th><th className="px-4 py-2.5">{t('Type')}</th>
                    <th className="px-4 py-2.5">{t('Version')}</th><th className="px-4 py-2.5">{t('Approved by')}</th>
                    <th className="px-4 py-2.5">{t('Linked to')}</th><th className="px-4 py-2.5">{t('Source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((d: CompanyDoc, i) => (
                    <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-2.5 text-xs tabular-nums text-muted">{(cur - 1) * PAGE + i + 1}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex min-w-0 max-w-[26rem] items-center gap-3">
                          <IconTile icon="FileText" tone="brand" size="sm" />
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-ink" title={d.name}>{d.name}</div>
                            {(d.kind || d.size) && (
                              <div className="truncate text-xs text-muted">{[d.kind, fileSize(d.size)].filter(Boolean).join(' · ')}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {d.document_type === 'Unclassified' || !d.document_type
                          ? <span className="pill bg-warning-50 text-warning-600">{t(d.document_type || 'Unclassified')}</span>
                          : <Tag tone="blue">{d.document_type}</Tag>}
                      </td>
                      <td className="px-4 py-2.5">
                        {d.version ? <span className="pill bg-slate-100 text-slate-600">{d.version}</span> : <span className="text-muted-2">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {d.approved_by ? (
                          <span className="flex items-center gap-2">
                            <Avatar name={d.approved_by} size={26} />
                            <span className="text-ink-2">{d.approved_by}</span>
                          </span>
                        ) : (
                          <span className="pill bg-critical-50 text-critical-600">{t('Not recorded')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {d.entity_name ? (
                          <span className="flex items-center gap-2">
                            <DomainTile domain={d.entity_domain ?? undefined} size="xs" />
                            <span className="max-w-[14rem] truncate text-ink-2">{d.entity_name}</span>
                          </span>
                        ) : (
                          <span className="text-muted-2">—</span>
                        )}
                      </td>
                      <td className="max-w-[16rem] truncate px-4 py-2.5 text-xs text-muted" title={d.source_reference || d.source || undefined}>{d.source_reference || d.source || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 ? (
              <Pager page={cur} pages={pages} total={shown.length} size={PAGE} onPage={setPage} />
            ) : (
              <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-muted">
                {shown.length === 1 ? t('Showing 1 document') : t('Showing {n} documents', { n: shown.length.toLocaleString() })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default GovernancePage;
