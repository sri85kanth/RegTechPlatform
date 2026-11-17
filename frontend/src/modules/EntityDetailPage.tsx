import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { BadgeCheck, Pencil, Link2 } from 'lucide-react';
import { LIFECYCLE } from '@/types/entity';
import { getDomainConfig } from '@/config/registry';
import { toneFor } from '@/config/tones';
import { Topbar } from '@/layouts/Topbar';
import { Badge, EmptyState, Section } from '@/components/ui/primitives';
import { entityById, relationsFor, ownerName } from '@/services/entities';
import { useData } from '@/app/store/data';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

const TABS = [tx('Overview'), tx('Relationships'), tx('Evidence'), tx('Verification'), tx('History'), tx('Impact')] as const;
type Tab = (typeof TABS)[number];

export function EntityDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { history, verifyEntity } = useData();
  const [tab, setTab] = useState<Tab>('Overview');

  const e = id ? entityById(id) : undefined;
  if (!e) {
    return (
      <div className="p-8">
        <EmptyState title="Entity not found" hint="It may have been archived or the link is stale." />
      </div>
    );
  }
  const domainCfg = getDomainConfig(e.domain);
  const rels = relationsFor(e.id);
  const evidence = rels.filter((r) => r.other.domain === 'evidence');
  const events = history.filter((h) => h.entityId === e.id);

  return (
    <>
      <Topbar
        title={e.name}
        subtitle={`${e.type ?? (domainCfg?.entityNoun ? t(domainCfg.entityNoun) : '')}${ownerName(e) ? ` · ${t('owned by {name}', { name: ownerName(e) ?? '' })}` : ''} · ${e.id}`}
        icon={domainCfg?.icon ?? 'LayoutGrid'}
        tone={toneFor(e.domain)}
        hideSearch
        onBack={() => navigate(-1)}
        backLabel="Back"
        actions={
          <>
            <Badge value={e.criticality} kind="criticality" />
            <Badge value={e.verification} kind="verification" />
            {e.verification !== 'Verified' && (
              <button className="btn btn-sm gap-1.5" onClick={() => verifyEntity(e.id)}>
                <BadgeCheck className="h-4 w-4" /> {t('Verify')}
              </button>
            )}
            <button className="btn btn-sm btn-primary gap-1.5">
              <Pencil className="h-4 w-4" /> {t('Edit')}
            </button>
          </>
        }
        below={
          <div className="flex gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition', tab === k ? 'border-brand-500 font-semibold text-brand-600' : 'border-transparent text-muted hover:text-ink')}
              >
                {t(k)}
              </button>
            ))}
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {tab === 'Overview' && (
          <>
            <Section title="Lifecycle">
              <div className="flex flex-wrap items-center gap-1.5">
                {LIFECYCLE.map((s, i) => {
                  const cur = e.lifecycle === s;
                  const done = LIFECYCLE.indexOf(e.lifecycle) > i;
                  return (
                    <span key={s} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-muted-2">›</span>}
                      <span className={cn('rounded-full px-2.5 py-1 text-2xs', cur ? 'bg-brand-500 font-semibold text-white' : done ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-muted')}>{t(s)}</span>
                    </span>
                  );
                })}
              </div>
            </Section>
            <Section title="Properties">
              <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {[
                  [tx('Name'), e.name],
                  [tx('Type'), e.type ?? '—'],
                  [tx('Status'), e.status ?? '—'],
                  [tx('Criticality'), e.criticality ?? '—'],
                  [tx('Owner'), ownerName(e) ?? '—'],
                  [tx('Description'), e.description ?? '—'],
                  ...Object.entries(e.attrs).map(([k, v]) => [cap(k), String(v)] as [string, string]),
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 border-b border-dashed border-line py-2 text-[13px]">
                    <dt className="text-muted">{t(k)}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </>
        )}

        {tab === 'Relationships' && <RelationshipList entityId={e.id} />}

        {tab === 'Evidence' &&
          (evidence.length ? (
            <Section title={t('Evidence ({n})', { n: evidence.length })}>
              <div className="flex flex-wrap gap-2">
                {evidence.map((r) => (
                  <Link key={r.rel.id} to={`/entity/${r.other.id}`} className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-white px-3 py-1.5 text-[12.5px] hover:border-brand-300">
                    <Link2 className="h-3.5 w-3.5 text-brand-500" /> {r.other.name}
                  </Link>
                ))}
              </div>
            </Section>
          ) : (
            <EmptyState title="No linked evidence." hint="Evidence proves a control, process or policy operates." />
          ))}

        {tab === 'Verification' && (
          <Section title="Verification & Provenance">
            <div className="mb-3 flex items-center gap-3">
              <Badge value={e.verification} kind="verification" />
              {e.verification !== 'Verified' && (
                <button className="btn btn-sm gap-1.5" onClick={() => verifyEntity(e.id)}>
                  <BadgeCheck className="h-4 w-4" /> {t('Mark verified')}
                </button>
              )}
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2">
              {[
                [tx('Source'), e.provenance.source],
                [tx('Source reference'), e.provenance.sourceReference ?? '—'],
                [tx('Confidence'), `${e.provenance.confidence}%`],
                [tx('Verified by'), e.provenance.verifiedBy ?? '—'],
                [tx('Verified at'), e.provenance.verifiedAt ?? '—'],
                [tx('Created'), e.provenance.createdAt],
                [tx('Updated'), e.provenance.updatedAt],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-dashed border-line py-2 text-[13px]">
                  <dt className="text-muted">{t(k)}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {tab === 'History' &&
          (events.length ? (
            <Section title="History">
              <ol className="space-y-3">
                {events.map((h) => (
                  <li key={h.id} className="flex gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                    <div className="mt-1 h-2 w-2 rounded-full bg-brand-500" />
                    <div className="flex-1">
                      <div className="text-[13.5px] font-semibold">{h.action}</div>
                      <div className="text-2xs text-muted">{t('by {name}', { name: h.by })}{h.detail ? ` · ${h.detail}` : ''}</div>
                    </div>
                    <div className="text-2xs text-muted-2">{h.at}</div>
                  </li>
                ))}
              </ol>
            </Section>
          ) : (
            <EmptyState title="No history recorded." />
          ))}

        {tab === 'Impact' && <ImpactView entityId={e.id} />}
      </div>
    </>
  );
}

function RelationshipList({ entityId }: { entityId: string }) {
  const t = useT();
  const rels = relationsFor(entityId);
  if (!rels.length) return <EmptyState title="No relationships." hint="This entity isn't yet connected in the graph." />;
  return (
    <Section title={t('Relationships ({n})', { n: rels.length })} action={<Link to="/graph" className="text-2xs font-semibold text-brand-600 hover:underline">{t('Open graph →')}</Link>}>
      <ul>
        {rels.map((r) => (
          <li key={r.rel.id} className="flex items-center gap-2.5 border-b border-dashed border-line py-2.5 last:border-0 text-[13px]">
            <span className="text-2xs uppercase tracking-wide text-muted-2">{r.direction === 'out' ? '→' : '←'}</span>
            <span className="italic text-muted">{r.verb}</span>
            <Link to={`/entity/${r.other.id}`} className="font-semibold hover:text-brand-600 hover:underline">
              {r.other.name}
            </Link>
            <Badge value={t(getDomainConfig(r.other.domain)?.title ?? r.other.domain)} kind="plain" />
            <span className="ml-auto text-2xs text-muted-2">{r.rel.confidence}%</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ImpactView({ entityId }: { entityId: string }) {
  const t = useT();
  const rels = relationsFor(entityId);
  const affected = rels.map((r) => r.other);
  const byDomain = new Map<string, number>();
  affected.forEach((a) => byDomain.set(a.domain, (byDomain.get(a.domain) ?? 0) + 1));
  return (
    <>
      <div className="mb-3 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-[13px] text-brand-800">
        {t('Impact is computed by graph traversal from this node. A full regulatory-change blast radius is a later phase — this shows the directly connected nodes.')}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[...byDomain.entries()].map(([d, n]) => (
          <div key={d} className="card px-4 py-3">
            <div className="text-2xs text-muted">{t(getDomainConfig(d)?.title ?? d)}</div>
            <div className="text-2xl font-extrabold">{n}</div>
            <div className="text-2xs text-muted">{t('connected')}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function cap(s: string) {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
