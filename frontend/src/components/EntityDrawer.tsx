import { useEffect, useState, type ReactNode } from 'react';
import { X, BadgeCheck, ChevronRight, UserCog, ArrowRight, ArrowLeft, FileText, Plug, PenLine, Database } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { LIFECYCLE } from '@/types/entity';
import type { Entity } from '@/types/entity';
import { getDomainConfig } from '@/config/registry';
import { RELATED_SECTION_ORDER, DOMAIN_ORDER, registryVisual } from '@/config/companyBrain';
import type { ResolvedRel } from '@/services/entities';
import { Avatar, Badge, EmptyState, Callout, Field as GridField, IconTile, Tag } from '@/components/ui/primitives';
import { FlowSteps } from '@/components/ui/charts';
import { entityById, relationsFor, ownerName, ownershipRelations } from '@/services/entities';
import { useData } from '@/app/store/data';
import { useUi, type EntityFocus } from '@/app/store/ui';
import { useSourceLocation, type SourceLocation } from '@/services/sourceLocation';
import { cn, getField, readable } from '@/utils/ui';
import { TabStrip } from '@/components/ui/TabStrip';
import { activityStyle } from '@/components/ActivityList';
import { DomainTile } from '@/modules/registry/DomainTile';
import { shortDate } from '@/modules/registry/visuals';
import { PeoplePicker, ownerCandidates } from '@/components/PeoplePicker';
import { showValue } from '@/modules/departments/model';
import { can, useMe } from '@/services/authApi';
import { tx, useDateLocale, useT, type TFunction } from '@/i18n';
import '@/components/ui/premium.css';

const TABS = [tx('Overview'), tx('Properties'), tx('Relationships'), tx('Owners'), tx('Evidence'), tx('Sources'), tx('Verification')] as const;
type Tab = (typeof TABS)[number];

/** Domains where an auditor expects linked evidence. */
const EXPECTS_EVIDENCE = new Set(['controls', 'policies']);

export function EntityDrawer() {
  const t = useT();
  const { openEntityId, entityFocus, closeEntity } = useUi();
  const { history, verifyEntity } = useData();
  const [tab, setTab] = useState<Tab>('Overview');

  // reset to Overview whenever a different entity is opened
  useEffect(() => setTab('Overview'), [openEntityId]);
  // close on Escape
  useEffect(() => {
    if (!openEntityId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeEntity();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openEntityId, closeEntity]);

  const e = openEntityId ? entityById(openEntityId) : undefined;
  const open = Boolean(openEntityId);

  return (
    <>
      {/* backdrop */}
      <div
        className={cn('fixed inset-0 z-40 bg-slate-900/30 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={closeEntity}
      />
      {/* panel */}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[500px] flex-col overflow-hidden bg-white/95 shadow-[-12px_0_40px_rgba(15,18,34,.18)] backdrop-blur-2xl transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] sm:inset-y-3 sm:right-3 sm:rounded-[24px]',
          open ? 'translate-x-0' : 'invisible translate-x-[calc(100%+24px)] shadow-none',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={e ? e.name : t('Record detail')}
      >
        {e && (
          <DrawerBody
            key={e.id}
            entity={e}
            focus={entityFocus}
            tab={tab}
            setTab={setTab}
            history={history.filter((h) => h.entityId === e.id)}
            onVerify={() => verifyEntity(e.id)}
            onClose={closeEntity}
          />
        )}
        {!e && open && <div className="p-8"><EmptyState title="Entity not found" /></div>}
      </aside>
    </>
  );
}

function DrawerBody({
  entity: e,
  focus,
  tab,
  setTab,
  history,
  onVerify,
  onClose,
}: {
  entity: Entity;
  focus: EntityFocus | null;
  tab: Tab;
  setTab: (t: Tab) => void;
  history: { id: string; action: string; by: string; at: string; detail?: string }[];
  onVerify: () => void;
  onClose: () => void;
}) {
  // tab keys below are named `t`, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const { openEntity } = useUi();
  const { assignOwner, entities } = useData();
  const { data: me } = useMe();
  const cfg = getDomainConfig(e.domain);
  const rels = relationsFor(e.id);
  const evidence = rels.filter((r) => r.other.domain === 'evidence');
  const owner = ownerName(e);
  const ownerEntity = e.ownerId ? entityById(e.ownerId) : undefined;
  const owns = ownershipRelations().filter((o) => o.target.id === e.id);
  const curLc = Math.max(0, LIFECYCLE.indexOf(e.lifecycle));
  // staff come from the HR feed as type "Employee" — the old filter on "Person" left the list empty
  const people = ownerCandidates(entities);
  const canOwn = e.domain !== 'people' && e.type !== 'Attribute';
  const noun = tr(cfg?.entityNoun ?? 'record');
  const verified = e.verification === 'Verified';
  const loc = useSourceLocation(e);
  const navigate = useNavigate();
  // the record's own field that holds the date it was opened for
  const focusKey = focus ? Object.keys(e.attrs).find((k) => String(e.attrs[k] ?? '').slice(0, 10) === focus.date) : undefined;
  // named the way the Properties list names it
  const focusField = focusKey ? (cfg?.columns.find((c) => c.key === focusKey)?.label ?? cap(focusKey)) : undefined;
  const openConnection = () => { onClose(); navigate('/add-data'); };

  const counts: Partial<Record<Tab, number>> = {
    Relationships: rels.length,
    Evidence: evidence.length,
    Verification: history.length,
  };

  return (
    <>
      {/* header */}
      <div className="border-b border-line px-5 pb-3 pt-4">
        <div className="flex items-start gap-3.5">
          <DomainTile domain={e.domain} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-muted">
              {tr(cfg?.title ?? 'Record')} · {e.type ?? noun}
            </div>
            <h2 className="mt-0.5 line-clamp-2 text-[17px] font-bold leading-snug tracking-tight text-ink" title={e.name}>{e.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {e.status && <Badge value={e.status} kind="status" size="sm" />}
              {e.criticality && <Badge value={e.criticality} kind="criticality" size="sm" />}
              <Badge value={e.verification} kind="verification" size="sm" />
            </div>
          </div>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-slate-100 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
            onClick={onClose}
            aria-label={tr('Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="border-b border-line px-3">
        <TabStrip
          size="sm"
          ariaLabel="Record sections"
          tabs={TABS.map((t) => ({ key: t, label: counts[t] !== undefined ? `${tr(t)} (${counts[t]})` : t }))}
          active={tab}
          onChange={setTab}
        />
      </div>

      {/* body */}
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {tab === 'Overview' && (
          <>
            {/* opened for a date (a calendar item): that date, and where it was read from, come first */}
            {focus && <FocusDate focus={focus} />}
            {focus && <SourceCard loc={loc} field={focusField} title={tx('Where this date comes from')} onOpenConnection={openConnection} />}

            {/* problems first — what stops this record being trusted */}
            {(canOwn && !e.ownerId) || !verified || (EXPECTS_EVIDENCE.has(e.domain) && evidence.length === 0) ? (
              <div className="space-y-2.5">
                {canOwn && !e.ownerId && (
                  <Callout tone="red" icon="UserX" title="No owner assigned">
                    {tr('Nobody is accountable for this {noun}, so reviews and approvals cannot be routed.', { noun: noun.toLowerCase() })}{' '}
                    <button className="font-semibold text-brand-600 hover:underline" onClick={() => setTab('Owners')}>{tr('Assign an owner →')}</button>
                  </Callout>
                )}
                {!verified && (
                  <Callout tone={e.verification === 'Rejected' ? 'red' : 'amber'} title={tr(e.verification === 'Rejected' ? 'Rejected at review' : 'Not yet verified')}>
                    {tr('Verification is {state}. Until a person confirms it, this record is a proposal, not a fact.', { state: tr(e.verification) })}
                  </Callout>
                )}
                {EXPECTS_EVIDENCE.has(e.domain) && evidence.length === 0 && (
                  <Callout tone="amber" icon="FileWarning" title="No evidence linked">
                    {tr('An auditor will ask for proof that this {noun} operates. None is linked yet.', { noun: noun.toLowerCase() })}
                  </Callout>
                )}
              </div>
            ) : (
              <Callout tone="green" title="Verified and accounted for">
                {canOwn
                  ? (owner ? tr('Owned by {owner} and confirmed by a person.', { owner }) : tr('Owned by its owner and confirmed by a person.'))
                  : tr('Confirmed by a person.')}
              </Callout>
            )}

            {/* key fields */}
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 rounded-xl border border-line p-4">
              <GridField label="Type">{e.type ? <Tag tone="auto">{e.type}</Tag> : '—'}</GridField>
              <GridField label="Owner">
                {owner ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={owner} size={22} />
                    <span className="truncate">{owner}</span>
                  </span>
                ) : canOwn ? (
                  <span className="text-critical-600">{tr('Unassigned')}</span>
                ) : (
                  '—'
                )}
              </GridField>
              <GridField label="Criticality">{e.criticality ? <Badge value={e.criticality} kind="criticality" size="sm" /> : '—'}</GridField>
              <GridField label="Status">{e.status ? <Badge value={e.status} kind="status" size="sm" /> : '—'}</GridField>
              <GridField label="Source">
                {loc ? (
                  <span className="flex min-w-0 items-start gap-1.5" title={e.provenance.source}>
                    <FileText className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0">{loc.kind === 'manual' ? tr(loc.name) : loc.name}</span>
                  </span>
                ) : '—'}
              </GridField>
              <GridField label="Updated">{shortDate(e.provenance.updatedAt, locale) || '—'}</GridField>
            </div>

            {!focus && <SourceCard loc={loc} title={tx('Where this record comes from')} onOpenConnection={openConnection} />}

            {e.description && (
              <Block title="Description">
                <p className="text-[13.5px] leading-relaxed text-ink-2">{e.description}</p>
              </Block>
            )}

            <Block title="Relationship">
              <FlowSteps steps={flowFor(e, rels, owner, canOwn, (t) => setTab(t), tr)} />
            </Block>

            {can(me, 'administer') && (
              <Block title="Lifecycle">
                <div className="flex flex-wrap items-center gap-1">
                  {LIFECYCLE.map((s, i) => (
                    <span key={s} className="flex items-center gap-1">
                      {i > 0 && <ChevronRight className="h-3 w-3 text-muted-2" aria-hidden="true" />}
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs',
                          i < curLc ? 'bg-brand-50 text-brand-600' : i === curLc ? 'bg-brand-600 font-semibold text-white' : 'bg-slate-100 text-muted',
                        )}
                      >
                        {tr(s)}
                      </span>
                    </span>
                  ))}
                </div>
              </Block>
            )}

            <KeyValues entity={e} owner={owner} limit={8} onMore={() => setTab('Properties')} />

            {rels.length > 0 && (
              <Block title={tr('Relationships ({n})', { n: rels.length.toLocaleString() })} link={rels.length > 6 ? { label: 'View all', onClick: () => setTab('Relationships') } : undefined}>
                <ul className="space-y-1.5">
                  {rels.slice(0, 6).map((r) => (
                    <RelRow key={r.rel.id} r={r} onOpen={openEntity} />
                  ))}
                </ul>
              </Block>
            )}
          </>
        )}

        {tab === 'Properties' && <KeyValues entity={e} owner={owner} />}

        {tab === 'Relationships' && (
          rels.length === 0 ? (
            <EmptyState title="No relationships" hint="This entity is not yet connected in the graph." icon="Link2" />
          ) : (
            <RelatedSections entity={e} rels={rels} onOpen={openEntity} />
          )
        )}

        {tab === 'Owners' && (
          <div className="space-y-5">
            <Block title="Owner">
              {owner ? (
                <div className="flex items-center gap-3 rounded-xl border border-line p-3">
                  <Avatar name={owner} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink">{owner}</div>
                    {ownerEntity && (
                      <div className="truncate text-xs text-muted">
                        {String(ownerEntity.attrs.role ?? ownerEntity.attrs.jobTitle ?? ownerEntity.description ?? ownerEntity.type ?? '')}
                      </div>
                    )}
                  </div>
                  {ownerEntity && (
                    <button className="btn btn-sm btn-outline" onClick={() => openEntity(ownerEntity.id)}>
                      {tr('Open')}
                    </button>
                  )}
                </div>
              ) : (
                <Callout tone={canOwn ? 'red' : 'blue'} icon="UserX" title="No owner assigned">
                  {tr(canOwn ? 'Choose the person accountable for this record below.' : 'People records are not owned by another person.')}
                </Callout>
              )}
            </Block>
            {canOwn && (
              <Block title={tr(owner ? 'Reassign owner' : 'Assign owner')}>
                <div className="flex flex-wrap items-center gap-2">
                  <PeoplePicker
                    className="w-72"
                    people={people}
                    value={e.ownerId}
                    placeholder={tr(owner ? 'Choose a new owner…' : 'Choose an owner…')}
                    onPick={(id) => assignOwner(e.id, id)}
                  />
                  <span className="text-2xs text-muted">{tr('Saves immediately · logged to History.')}</span>
                </div>
              </Block>
            )}
            <Block title="Ownership records">
              {owns.length === 0 ? (
                <span className="text-xs text-muted">{tr('Owned via the Owner field above.')}</span>
              ) : (
                <ul className="space-y-1.5">
                  {owns.map((o) => (
                    <li key={o.person.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                      <Avatar name={o.person.name} size={24} /> <span className="text-ink">{tr('{name} owns this', { name: o.person.name })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Block>
          </div>
        )}

        {tab === 'Evidence' && (
          evidence.length === 0 ? (
            <div className="space-y-4">
              <Callout tone="amber" icon="FileWarning" title="No linked evidence">
                {tr('Attach evidence to prove this {noun} is real and current.', { noun: noun.toLowerCase() })}
              </Callout>
            </div>
          ) : (
            <ul className="space-y-2">
              {evidence.map((r) => (
                <RelRow key={r.rel.id} r={r} onOpen={openEntity} />
              ))}
            </ul>
          )
        )}

        {tab === 'Sources' && (
          <div className="space-y-4">
            <SourceCard loc={loc} field={focusField} title={tx('Where this record comes from')} onOpenConnection={openConnection} />
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border border-line p-4">
              <GridField label="Confidence">{`${e.provenance.confidence}%`}</GridField>
              <GridField label="Verified by">{e.provenance.verifiedBy ?? '—'}</GridField>
              <GridField label="Verified at">{e.provenance.verifiedAt ?? '—'}</GridField>
              <GridField label="Created">{shortDate(e.provenance.createdAt, locale) || '—'}</GridField>
              <GridField label="Last updated">{shortDate(e.provenance.updatedAt, locale) || '—'}</GridField>
            </div>
          </div>
        )}

        {tab === 'Verification' && (
          <div className="space-y-5">
            <div className="flex items-center gap-3 rounded-xl border border-line p-4">
              <IconTile
                icon={verified ? 'ShieldCheck' : e.verification === 'Rejected' ? 'XCircle' : 'Clock'}
                tone={verified ? 'green' : e.verification === 'Rejected' ? 'red' : 'amber'}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted">{tr('Verification status')}</div>
                <div className="mt-0.5"><Badge value={e.verification} kind="verification" /></div>
              </div>
              {!verified && (
                <button className="btn btn-sm btn-primary" onClick={onVerify}>
                  <BadgeCheck className="h-3.5 w-3.5" /> {tr('Verify')}
                </button>
              )}
            </div>
            <Block title={tr('History ({n})', { n: history.length.toLocaleString() })}>
              {history.length === 0 ? (
                <p className="text-xs text-muted">{tr('No recorded changes to this record yet.')}</p>
              ) : (
                <ol className="space-y-3">
                  {history.map((h) => {
                    const s = activityStyle(h.action);
                    return (
                      <li key={h.id} className="flex items-center gap-3">
                        <IconTile icon={s.icon} tone={s.tone} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-ink first-letter:uppercase">{h.action}</div>
                          <div className="text-xs text-muted">{h.by}{h.detail ? ` · ${h.detail}` : ''}{h.at ? ` · ${h.at}` : ''}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Block>
          </div>
        )}
      </div>

      {/* footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-slate-50/60 px-5 py-3">
        {canOwn && (
          <button className="btn btn-sm btn-outline" onClick={() => setTab('Owners')}>
            <UserCog className="h-3.5 w-3.5" /> {tr(owner ? 'Change owner' : 'Assign owner')}
          </button>
        )}
        {rels.length > 0 && tab !== 'Relationships' && (
          <button className="btn btn-sm" onClick={() => setTab('Relationships')}>
            {tr('Relationships')} <span className="tabular-nums text-muted">{rels.length}</span>
          </button>
        )}
        <button
          className="btn btn-sm btn-primary ml-auto"
          disabled={verified}
          onClick={onVerify}
        >
          <BadgeCheck className="h-3.5 w-3.5" /> {tr(verified ? 'Verified' : 'Verify')}
        </button>
      </div>
    </>
  );
}

/** The record's place in the graph: itself → its linked domains → evidence → owner. */
function flowFor(
  e: Entity,
  rels: ResolvedRel[],
  owner: string | undefined,
  canOwn: boolean,
  go: (tab: Tab) => void,
  t: TFunction,
) {
  const visual = registryVisual(e.domain);
  const byDomain = new Map<string, number>();
  for (const r of rels) if (r.other.domain !== 'evidence') byDomain.set(r.other.domain, (byDomain.get(r.other.domain) ?? 0) + 1);
  const order = RELATED_SECTION_ORDER[e.domain as keyof typeof RELATED_SECTION_ORDER] ?? DOMAIN_ORDER;
  const linked = [...new Set([...order, ...byDomain.keys()])].filter((d) => byDomain.has(d) && d !== 'people').slice(0, canOwn ? 2 : 3);
  const evidenceN = rels.filter((r) => r.other.domain === 'evidence').length;

  const steps: Parameters<typeof FlowSteps>[0]['steps'] = [
    { icon: visual.icon, label: getDomainConfig(e.domain)?.entityNoun ?? 'Record', sub: t('this record'), tone: visual.flow },
    ...linked.map((d) => {
      const v = registryVisual(d);
      const n = byDomain.get(d) ?? 0;
      return { icon: v.icon, label: getDomainConfig(d)?.title ?? d, sub: t('{n} linked', { n: n.toLocaleString() }), tone: v.flow, onClick: () => go('Relationships') };
    }),
  ];
  if (e.domain !== 'evidence') {
    steps.push({ icon: 'FileCheck', label: 'Evidence', sub: t('{n} linked', { n: evidenceN.toLocaleString() }), tone: evidenceN > 0 ? 'green' : 'gray', onClick: () => go('Evidence') });
  }
  if (canOwn) {
    steps.push({ icon: owner ? 'UserCheck' : 'UserX', label: 'Owner', sub: owner ?? t('none'), tone: owner ? 'green' : 'red', onClick: () => go('Owners') });
  }
  return steps;
}

/** One related record as a coloured link row. */
function RelRow({ r, onOpen, showConfidence }: { r: ResolvedRel; onOpen: (id: string) => void; showConfidence?: boolean }) {
  const t = useT();
  return (
    <li>
      <button
        onClick={() => onOpen(r.other.id)}
        className="group flex w-full items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left text-[13px] transition hover:border-brand-300 hover:bg-brand-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
      >
        <DomainTile domain={r.other.domain} size="xs" />
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
          {r.direction === 'out' ? <ArrowRight className="h-3 w-3" aria-hidden="true" /> : <ArrowLeft className="h-3 w-3" aria-hidden="true" />}
          {t(readable(r.verb))}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-ink group-hover:text-brand-700">{r.other.name}</span>
        {showConfidence && <span className="shrink-0 text-xs tabular-nums text-muted">{r.rel.confidence}%</span>}
        <Badge value={r.other.verification} kind="verification" size="sm" />
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-brand-600" aria-hidden="true" />
      </button>
    </li>
  );
}

/** Entity-type-aware relationship sections — related entities grouped by their
 *  domain, ordered per the master config, showing only the groups that have data. */
function RelatedSections({
  entity,
  rels,
  onOpen,
}: {
  entity: Entity;
  rels: ResolvedRel[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const groups = new Map<string, ResolvedRel[]>();
  for (const r of rels) {
    const k = r.other.domain;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const preferred = RELATED_SECTION_ORDER[entity.domain as keyof typeof RELATED_SECTION_ORDER] ?? DOMAIN_ORDER;
  const seen = new Set<string>();
  const ordered = [...preferred, ...DOMAIN_ORDER, ...groups.keys()].filter((d) => {
    if (seen.has(d) || !groups.has(d)) return false;
    seen.add(d);
    return true;
  });

  return (
    <div className="space-y-5">
      {ordered.map((domain) => {
        const list = groups.get(domain)!;
        return (
          <div key={domain}>
            <div className="mb-2 flex items-center gap-2">
              <DomainTile domain={domain} size="xs" />
              <span className="text-[13px] font-semibold text-ink">{t(getDomainConfig(domain)?.title ?? domain)}</span>
              <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold tabular-nums text-ink-2">{list.length}</span>
            </div>
            <ul className="space-y-1.5">
              {list.map((r) => (
                <RelRow key={r.rel.id} r={r} onOpen={onOpen} showConfidence />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** A titled block inside the drawer, with an optional "View all →". */
/** the date a record was opened for: when, what it means, and how far off (or late) it is */
function FocusDate({ focus }: { focus: EntityFocus }) {
  const t = useT();
  const locale = useDateLocale();
  const d = new Date(`${focus.date}T00:00:00`);
  const now = new Date();
  const diff = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const late = !!focus.lapses && diff < 0;
  const when = late ? t('{n} days late', { n: (-diff).toLocaleString() })
    : diff === 0 ? t('Today') : diff === 1 ? t('Tomorrow')
    : diff > 0 ? t('in {n} days', { n: diff.toLocaleString() }) : t('{n} days ago', { n: (-diff).toLocaleString() });
  return (
    <div className={cn('flex items-center gap-3 rounded-2xl border p-3.5', late ? 'border-critical-200 bg-critical-50/60' : 'border-brand-100 bg-brand-50/40')}>
      <span className="w-12 shrink-0 overflow-hidden rounded-lg bg-white text-center leading-none shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]">
        <span className={cn('block py-[3px] text-[10px] font-bold uppercase tracking-wide text-white', late ? 'bg-critical-500' : 'bg-brand-600')}>
          {d.toLocaleDateString(locale, { month: 'short' })}
        </span>
        <span className="block py-1.5 text-lg font-bold tabular-nums text-ink">{d.getDate()}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted">{t(focus.label)}</p>
        <p className="mt-0.5 text-[15px] font-semibold text-ink">{d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>
      <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold',
        late ? 'bg-critical-500 text-white shadow-[0_2px_8px_-2px_rgba(239,68,68,0.6)]' : diff >= 0 && diff <= 30 ? 'bg-amber-400 text-amber-950' : 'bg-slate-100 text-slate-600')}>
        {when}
      </span>
    </div>
  );
}

/** where the record (or the date) was read from: the connection, its address, the record's id there, when collected */
function SourceCard({ loc, title, field, onOpenConnection }: { loc?: SourceLocation; title: string; field?: string; onOpenConnection: () => void }) {
  const t = useT();
  const locale = useDateLocale();
  if (!loc) return null;
  const Icon = loc.kind === 'connection' ? Plug : loc.kind === 'document' ? FileText : loc.kind === 'manual' ? PenLine : Database;
  const rows: [string, ReactNode][] = [];
  if (loc.address) rows.push([tx('Address'), <span className="font-mono text-[12px]" title={loc.address}>{loc.address}</span>]);
  if (loc.reference) rows.push([tx('Record ID in the source'), <span className="font-mono text-[12px]">{loc.reference}</span>]);
  if (field) rows.push([tx('Field'), t(field)]);
  if (loc.filedUnder) rows.push([tx('Filed under'), loc.filedUnder]);
  if (loc.collectedAt) rows.push([tx('Last collected'), shortDate(loc.collectedAt, locale)]);
  if (loc.sourceUpdatedAt) rows.push([tx('Source last changed it'), shortDate(loc.sourceUpdatedAt, locale)]);
  return (
    <Block title={title} link={loc.kind === 'connection' ? { label: tx('Open connection'), onClick: onOpenConnection } : undefined}>
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center gap-2.5 bg-slate-50/70 px-3.5 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-brand-600 shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)]"><Icon className="h-[18px] w-[18px]" aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink" title={loc.name}>{loc.kind === 'manual' ? t(loc.name) : loc.name}</p>
            {loc.via && <p className="truncate text-xs text-muted">{t(loc.via)}</p>}
          </div>
        </div>
        {rows.length > 0 && (
          <dl className="divide-y divide-line border-t border-line">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-3 px-3.5 py-2 text-[12.5px]">
                <dt className="w-[42%] shrink-0 text-muted">{t(k)}</dt>
                <dd className="min-w-0 flex-1 font-medium text-ink [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Block>
  );
}

function Block({ title, children, link }: { title: string; children: ReactNode; link?: { label: string; onClick: () => void } }) {
  const t = useT();
  return (
    <section>
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[13px] font-semibold text-ink">{t(title)}</h3>
        {link && (
          <button onClick={link.onClick} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700">
            {t(link.label)} <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function KeyValues({ entity: e, owner, limit, onMore }: { entity: Entity; owner?: string; limit?: number; onMore?: () => void }) {
  const t = useT();
  const cfg = getDomainConfig(e.domain);
  // Prefer the domain's configured columns for a clean, ordered property list.
  const cols = cfg?.columns.filter((c) => c.key !== 'name') ?? [];
  const base: [string, string][] = [
    [tx('Id'), e.id],
    ...(owner ? ([[tx('Owner'), owner]] as [string, string][]) : []),
  ];
  // the resolved owner is shown above; the raw owner id beside it is noise
  const isRawOwner = (key: string) => Boolean(owner) && /^owner_?id$/i.test(key);
  const colRows = cols
    .filter((c) => !isRawOwner(c.key) && !(owner && c.kind === 'person'))
    .map((c): [string, string] | null => {
      const val = getField(e, c.key);
      return val === undefined || val === '' ? null : [c.label, showValue(c.key, val)];
    })
    .filter((x): x is [string, string] => x !== null);
  const attrExtra = Object.entries(e.attrs)
    .filter(([k, v]) => v !== undefined && v !== '' && !cols.some((c) => c.key === k) && !isRawOwner(k))
    .map(([k, v]): [string, string] => [cap(k), showValue(k, v)]);

  let all = [...base, ...colRows, ...attrExtra];
  const total = all.length;
  if (limit) all = all.slice(0, limit);

  return (
    <Block
      title={limit && total > limit ? t('Properties ({n} of {total})', { n: limit.toLocaleString(), total: total.toLocaleString() }) : t('Properties')}
      link={limit && total > limit && onMore ? { label: 'View all', onClick: onMore } : undefined}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line p-4">
        {all.map(([k, v], i) => (
          <div key={`${k}-${i}`} className={cn('min-w-0', v.length > 32 && 'col-span-2')}>
            <dt className="text-xs text-muted">{t(k)}</dt>
            <dd className="mt-0.5 break-words text-[13px] font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Block>
  );
}

function cap(s: string) {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase());
}
