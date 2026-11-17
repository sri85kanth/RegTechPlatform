import { Fragment, useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { EmptyState } from '@/components/ui/primitives';
import { SkeletonTable } from '@/components/ui/skeletons';
import { useNodeRecords, useStructure, type FiledRecord } from '@/services/structureApi';
import { TabStrip } from '@/components/ui/TabStrip';
import {
  ancestorsOf, childrenOf, describe, formatWhen, groupByKind, groupWord, isWithin, layoutFor, registerTitle, unitWordText,
} from './model';
import { useT } from '@/i18n';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import { deptAccent, deptIcon } from './accent';
import { Breakdown, type Go } from './Breakdown';
import { SummaryTab } from './SummaryTab';
import { StructureTab } from './StructureTab';
import { RegisterTab, type Filters, type RegisterView } from './RegisterTab';
import { UnitsTab } from './UnitsTab';

/**
 * One department, explained.
 *
 *   Summary          every register it holds, in a line each; what is still open
 *   <each register>  its rows, laid out like the source's own page — or as a breakdown
 *   Structure        the records as a tree — by department, location, type…
 *   By <unit>        its sub-units, each saying what is inside it
 *
 * Nothing on it is written for one kind of company: the tabs, groupings and
 * columns all come from the records collected into the department, and each
 * register keeps the name and the columns its source gave it.
 */
const FILTER_KEYS = ['unit', 'status', 'crit', 'fk', 'fv', 'missing', 'origin'] as const;

export function DepartmentPage() {
  const t = useT();
  const { nodeId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: structure, isLoading: structureLoading } = useStructure();
  const { data, isLoading, isError } = useNodeRecords(nodeId || null);

  const unfiled = nodeId === 'unfiled';
  const flat = useMemo(() => structure?.flat ?? [], [structure]);
  const counts = structure?.counts;
  const node = flat.find((n) => n.id === nodeId);
  const rows = useMemo(() => data?.records ?? [], [data]);
  const sources = useMemo(() => data?.sources ?? [], [data]);
  // What a connection's owner has said about a field — "location: as placed
  // in the source, not verified" — keyed as the page keys fields.
  const caveats = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sources) for (const [k, v] of Object.entries(s.caveats ?? {})) m[k.startsWith('attr.') ? k : `attr.${k}`] = v;
    return m;
  }, [sources]);
  const expected = unfiled ? counts?.unfiled : counts?.total?.[nodeId];

  const units = useMemo(() => childrenOf(flat, nodeId)
    .map((c) => ({ node: c, n: counts?.total?.[c.id] ?? 0 }))
    .sort((a, b) => b.n - a.n || a.node.name.localeCompare(b.node.name)), [flat, nodeId, counts]);
  const unitWord = groupWord(units.map((u) => u.node));

  // Which sub-unit each record sits in, by the node it is filed on.
  const unitOf = useMemo(() => {
    if (!units.length) return undefined;
    const unitOfNode = new Map<string, string>();
    for (const u of units) for (const n of flat) if (isWithin(n, u.node)) unitOfNode.set(n.id, u.node.id);
    return (r: FiledRecord) => unitOfNode.get(r.org_node_id ?? '');
  }, [units, flat]);

  // One register per kind of record, each with its source's own layout.
  const kinds = useMemo(() => groupByKind(rows), [rows]);
  const found = useMemo(() => new Map(kinds.map((k) => [k.id, layoutFor(k, sources)])), [kinds, sources]);
  const titles = useMemo(() => new Map(kinds.map((k) => [k.id, registerTitle(k, found.get(k.id))])), [kinds, found]);
  // `t` is a dependency: a facet's label is worded in the chosen language
  const described = useMemo(() => new Map(kinds.map((k) => [k.id, describe(k.rows, {
    kind: k.label, units, unitWord, unitOf, layout: found.get(k.id)?.layout,
  })])), [kinds, units, unitWord, unitOf, found, t]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every register together — for the tree and the sub-unit cards.
  const all = useMemo(() => (kinds.length === 1 ? described.get(kinds[0].id)!
    : describe(rows, { kind: t('Record'), units, unitWord, unitOf })), [kinds, described, rows, units, unitWord, unitOf, t]);

  const parents = node ? ancestorsOf(flat, node.id) : [];
  const parent = parents[parents.length - 1];
  const heads = (!unfiled && counts?.heads?.[nodeId]) || [];

  const tabs: { id: string; label: string; n?: number }[] = [
    { id: 'summary', label: 'Summary' },
    ...kinds.map((k) => ({ id: k.id, label: titles.get(k.id) ?? k.label, n: k.rows.length })),
    { id: 'structure', label: 'Structure' },
    ...(units.length ? [{ id: 'units', label: t('By {unit}', { unit: unitWordText(t, unitWord) }), n: units.length }] : []),
  ];
  const wanted = params.get('tab') ?? 'summary';
  const tab = tabs.some((x) => x.id === wanted) ? wanted : 'summary';

  // Moving between tabs is navigation (Back returns to the summary you came
  // from); refining a filter inside a tab is not, so it replaces.
  const go: Go = (id, extra = {}) => {
    const next = new URLSearchParams();
    if (id !== 'summary') next.set('tab', id);
    for (const [k, v] of Object.entries(extra)) if (v) next.set(k, v);
    setParams(next);
  };
  const patch = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const filters: Filters = Object.fromEntries(
    FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]).filter(([, v]) => v));
  const setFilters = (f: Filters) => patch(Object.fromEntries(FILTER_KEYS.map((k) => [k, f[k]])));
  const view: RegisterView = params.get('view') === 'breakdown' ? 'breakdown' : 'table';

  // The tree reads one register, or all of them together.
  const treeKind = kinds.find((k) => k.id === params.get('reg'));
  const treeRows = treeKind ? treeKind.rows : rows;
  const treeD = treeKind ? described.get(treeKind.id)! : all;

  if (!unfiled && !structureLoading && structure && !node) {
    return (
      <>
        <Topbar title="Departments" icon="FolderTree" tone={toneFor('overview')} />
        <div className="w-full p-4 sm:p-6">
          <EmptyState title="This department no longer exists"
            hint="It may have been renamed away, moved or deleted in the structure. Open Departments to see what there is now." />
          <div className="mt-3 text-center">
            <Link className="btn" to="/departments">{t('Open Departments')}</Link>
          </div>
        </div>
      </>
    );
  }

  const title = unfiled ? t('Not filed yet') : node?.name ?? '…';
  const total = expected ?? rows.length;
  const lead = sources[0];
  const accent = deptAccent(flat, node?.id);

  return (
    <>
      <Topbar
        title={title}
        icon={unfiled ? 'Inbox' : 'FolderTree'}
        tone={toneFor('overview')}
        // the back link already names where you came from; a second crumb line
        // under it only repeated it
        onBack={() => navigate(parent ? `/departments/${parent.id}` : '/departments')}
        backLabel={parent ? t('Back to {name}', { name: parent.name }) : t('Back to Departments')}
        titleExtra={
          <span className={cn('pill', unfiled ? 'bg-warning-50 text-warning-600' : accent.chip)}>
            <Icon name={unfiled ? 'Inbox' : deptIcon(node?.name)} className="h-3.5 w-3.5" />
            {unfiled ? t('In no department') : node?.kind ? t(node.kind) : t('Unit')}
          </span>
        }
        meta={[
          ...(parent ? [{ icon: 'Building2', label: 'In', value: parent.name }] : []),
          ...(!unfiled ? [{
            icon: 'UserRound',
            label: heads.length > 1 && !node?.head_name ? t('Heads') : t('Head'),
            value: node?.head_name ? (
              <>{node.head_name}{node.head_role && <span className="font-normal text-muted"> ({node.head_role})</span>}</>
            ) : heads.length ? (
              <>
                {heads.map((h, i) => (
                  <Fragment key={h.name}>{i > 0 && ', '}{h.name}{h.role && <span className="font-normal text-muted"> ({h.role})</span>}</Fragment>
                ))}
                <span className="font-normal text-muted-2"> {t('— per the organisation chart')}</span>
              </>
            ) : <span className="font-normal italic text-muted">{t('No head recorded')}</span>,
          }] : []),
          {
            icon: 'FileText', label: total === 1 ? t('Record') : t('Records'),
            value: <>{total.toLocaleString()}{kinds.length > 1 && <span className="font-normal text-muted"> {t('in {n} registers', { n: kinds.length })}</span>}</>,
          },
          ...(lead ? [{
            icon: 'Plug', label: 'From',
            value: <>{lead.label} <span className="font-normal text-muted">({lead.kind}){sources.length > 1 && <> {t('and {n} more', { n: sources.length - 1 })}</>}</span></>,
          }] : []),
          ...(lead?.lastSyncAt ? [{ icon: 'Clock', label: 'Collected', value: formatWhen(lead.lastSyncAt) }] : []),
        ]}
        actions={<>
          <Link className="btn btn-outline" to="/graph"><Icon name="Network" className="h-4 w-4" /> {t('Org chart')}</Link>
          <Link className="btn" to="/structure"><Icon name="Pencil" className="h-4 w-4" /> {t('Edit structure')}</Link>
        </>}
        below={
          <TabStrip
            ariaLabel={t('{name} sections', { name: title })}
            tabs={tabs.map((x) => ({ key: x.id, label: x.label, count: x.n }))}
            active={tab}
            onChange={(id) => go(id)}
          />
        }
      />

      <div className="w-full space-y-3 p-4 sm:p-6">
        {isLoading || structureLoading ? (
          <SkeletonTable rows={8} cols={5} />
        ) : isError ? (
          <EmptyState title="The records could not be loaded" hint="The server did not answer. Try again in a moment." />
        ) : rows.length === 0 ? (
          unfiled ? (
            <EmptyState title="Everything is filed" hint="No record is sitting outside the structure." />
          ) : (
            <EmptyState title={t('Nothing filed under {name} yet', { name: title })}
              hint="Connect a folder or an API in Integrations and give it this name, or move records here from Not filed yet." />
          )
        ) : (
          <>
            {expected !== undefined && rows.length < expected && (
              <p className="rounded-lg bg-warning-50 px-3 py-2 text-[12px] text-warning-600">
                {t('Showing the first {n} of {total} records.', { n: rows.length.toLocaleString(), total: expected.toLocaleString() })}
              </p>
            )}
            {tab === 'summary' && (kinds.length === 1 ? (
              <Breakdown title={title} rows={rows} d={all} kinds={kinds} unitWord={unitWord}
                sources={sources} registerId={kinds[0].id} go={go} caveats={caveats} />
            ) : (
              <SummaryTab title={title} kinds={kinds} described={described} titles={titles} sources={sources} go={go}
                heads={heads} manualHead={node?.head_name ? { name: node.head_name, role: node.head_role } : undefined} />
            ))}
            {kinds.filter((k) => k.id === tab).map((k) => (
              <RegisterTab key={`${nodeId}:${k.id}`} group={k} title={titles.get(k.id) ?? k.label}
                source={found.get(k.id)?.from ?? lead} d={described.get(k.id)!} flat={flat} node={node} unitWord={unitWord}
                filters={filters} setFilters={setFilters} caveats={caveats}
                view={view} onView={(v) => patch({ view: v === 'breakdown' ? v : undefined })}
                breakdown={() => (
                  <Breakdown title={titles.get(k.id) ?? k.label} rows={k.rows} d={described.get(k.id)!} kinds={[k]}
                    unitWord={unitWord} sources={sources} registerId={k.id} go={go} caveats={caveats} />
                )} />
            ))}
            {tab === 'structure' && (
              <StructureTab key={treeKind?.id ?? 'all'} title={treeKind ? titles.get(treeKind.id) ?? title : title}
                kindLabel={treeKind ? treeKind.label : t('record')} rows={treeRows} d={treeD} unitWord={unitWord} caveats={caveats}
                by={params.get('by') ?? treeD.facets[0]?.key ?? ''}
                onBy={(key) => patch({ by: key })}
                registers={kinds.length > 1 ? kinds.map((k) => ({ id: k.id, label: titles.get(k.id) ?? k.label, n: k.rows.length })) : undefined}
                register={treeKind?.id ?? ''} onRegister={(id) => patch({ reg: id || undefined, by: undefined })} />
            )}
            {tab === 'units' && (
              <UnitsTab rows={rows} d={all} unitWord={unitWord} kinds={kinds}
                onUnassigned={() => go(kinds[0]?.id ?? 'summary', { unit: 'own' })} />
            )}
          </>
        )}
      </div>
    </>
  );
}
