import { useState } from 'react';
import { Check, X, HelpCircle, Sparkles, ChevronRight, ChevronDown, ArrowDown } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { MetricCard, Badge, Section } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { getDomainConfig } from '@/config/registry';
import type { DomainId, Entity } from '@/types/entity';
import type { Mapping } from '@/types/regulatory';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import {
  obligations, mappingRows, coverageFor, candidateMappings, coverageSummary,
  obligationLineage, mappedGroups, coverageGaps, obligationImpact, type MappingRow,
} from '@/services/regulatory';
import { applicabilityFor, applicabilitySummary } from '@/services/applicability';
import { cn } from '@/utils/ui';

/** Relationship label from an obligation to a mapped company entity (derived from domain). */
const REL_VERB: Record<string, string> = {
  processes: 'Applies to', systems: 'Runs on', data: 'Processes', policies: 'Governed by',
  controls: 'Implemented by', risks: 'Mitigates', people: 'Owned by', evidence: 'Evidenced by',
};

function coverageTone(level: string) {
  return level === 'Fully Covered' ? 'text-emerald-700 bg-emerald-50' : level === 'Partially Covered' ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50';
}
function applicabilityTone(result: string) {
  return result === 'Applicable' ? 'text-emerald-700 bg-emerald-50' : result === 'Needs Review' ? 'text-amber-700 bg-amber-50' : 'text-slate-600 bg-slate-100';
}
function statusMark(status: string) {
  if (status === 'Approved') return { m: '✓', c: 'text-emerald-600' };
  if (status === 'Rejected' || status === 'Not Applicable') return { m: '✕', c: 'text-red-500' };
  return { m: '⚠', c: 'text-amber-600' };
}

/** Standalone page (kept for deep links); the same engine is embedded in the Regulation Impact command center. */
export function MappingPage() {
  return (
    <>
      <Topbar title="Mapping Engine" subtitle="How each regulatory obligation reaches your company — AI proposes, a human approves" icon="Link2" />
      <div className="p-6"><MappingEngine /></div>
    </>
  );
}

/**
 * Mapping Engine — obligation → company entity mapping with human approval.
 * `regId` scopes it to one regulation's obligations (used inside Regulation Impact).
 */
export function MappingEngine({ regId, compact }: { regId?: string; compact?: boolean }) {
  const { setMappingStatus, addMapping } = useData();
  const all = obligations();
  const obls = regId ? all.filter((o) => obligationLineage(o.id).regulation?.id === regId) : all;
  const [selectedId, setSelectedId] = useState<string>(obls[0]?.id ?? '');
  const selected = obls.find((o) => o.id === selectedId) ?? obls[0];
  const summary = coverageSummary();
  const appSummary = applicabilitySummary();
  // scoped KPIs — computed from the obligations actually shown
  const scoped = {
    total: obls.length,
    fully: obls.filter((o) => coverageFor(o.id).level === 'Fully Covered').length,
    partially: obls.filter((o) => coverageFor(o.id).level === 'Partially Covered').length,
    not: obls.filter((o) => coverageFor(o.id).level === 'Not Covered').length,
    applicable: obls.filter((o) => applicabilityFor(o.id).result === 'Applicable').length,
    review: obls.filter((o) => applicabilityFor(o.id).result === 'Needs Review').length,
  };
  const kpi = regId
    ? { total: scoped.total, Fully: scoped.fully, Partially: scoped.partially, Not: scoped.not, Applicable: scoped.applicable, Review: scoped.review }
    : { total: summary.total, Fully: summary.Fully, Partially: summary.Partially, Not: summary.Not, Applicable: appSummary.Applicable, Review: appSummary['Needs Review'] };

  if (obls.length === 0) {
    return <div className="rounded-xl border border-dashed border-line bg-white py-10 text-center text-[13px] text-muted">No obligations extracted for this regulation yet — nothing to map.</div>;
  }

  return (
      <div className={cn('space-y-4', compact && 'space-y-3')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <MetricCard label="Obligations" value={kpi.total} />
          <MetricCard label="Applicable" value={kpi.Applicable} tone="green" foot={`${kpi.Review} need review`} />
          <MetricCard label="Fully Covered" value={kpi.Fully} tone="green" />
          <MetricCard label="Partially Covered" value={kpi.Partially} tone="amber" />
          <MetricCard label="Not Covered" value={kpi.Not} tone="red" />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          {/* obligation list */}
          <div className="card h-fit overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 text-2xs font-semibold uppercase tracking-wide text-muted">Obligations</div>
            <ul>
              {obls.map((o) => {
                const cov = coverageFor(o.id);
                return (
                  <li key={o.id}>
                    <button
                      onClick={() => setSelectedId(o.id)}
                      className={cn('flex w-full items-start gap-2 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-brand-50/40', o.id === selected?.id && 'bg-brand-50/70')}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{o.name}</div>
                        <div className="text-2xs text-muted">{String(o.attrs.regulator)} · {String(o.attrs.clause)}</div>
                      </div>
                      <span className={cn('pill', coverageTone(cov.level))}>{cov.level.replace(' Covered', '')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {selected && <ObligationDetail obligation={selected} onSet={setMappingStatus} onAdd={addMapping} />}
        </div>
      </div>
  );
}

function ObligationDetail({ obligation, onSet, onAdd }: { obligation: Entity; onSet: (id: string, s: Mapping['status']) => void; onAdd: (m: Mapping) => void }) {
  const openEntity = useUi((s) => s.openEntity);
  const rows = mappingRows(obligation.id);
  const cov = coverageFor(obligation.id);
  const candidates = candidateMappings(obligation.id);
  const app = applicabilityFor(obligation.id);
  const lineage = obligationLineage(obligation.id);
  const groups = mappedGroups(obligation.id);
  const gaps = coverageGaps(obligation.id);
  const impact = obligationImpact(obligation.id);
  const loc: { chapter?: { no: string; title: string }; section?: { no: string } } = {};
  const [showTable, setShowTable] = useState(false);

  const counts = rows.reduce((a, m) => { a[m.status] = (a[m.status] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const proposed = rows.filter((m) => m.status === 'Proposed' || m.status === 'Needs Review');
  const nextAction = gaps.length
    ? `Map ${gaps.join(' & ')} to reach full coverage.`
    : proposed.length
      ? `Review ${proposed.length} proposed mapping${proposed.length > 1 ? 's' : ''}.`
      : 'Fully mapped and approved.';

  function accept(entityId: string, entityDomain: DomainId, confidence: number, reason: string) {
    onAdd({ id: `map-${Date.now()}`, obligationId: obligation.id, targetId: entityId, targetDomain: entityDomain, status: 'Approved', confidence, reason, source: 'Manual', createdBy: 'Priya Sharma', reviewedBy: 'Priya Sharma', reviewedAt: 'Just now', createdAt: 'Just now' });
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-extrabold tracking-tight">{obligation.name}</h2>
            <div className="mt-0.5 text-[13px] text-muted">{String(obligation.attrs.regulator)} · {String(obligation.attrs.clause)} · {String(obligation.attrs.frequency)}</div>
            <p className="mt-1.5 text-[13px] text-ink-2"><b>Requires:</b> {String(obligation.attrs.action)} — {String(obligation.attrs.object)} ({String(obligation.attrs.condition)}).</p>
          </div>
          <span className={cn('pill shrink-0', applicabilityTone(app.result))}>{app.result}</span>
        </div>
      </div>

      {/* regulatory context — compact horizontal chain */}
      <div className="card px-5 py-3.5">
        <div className="mb-2.5 text-2xs font-semibold uppercase tracking-wide text-muted">Regulatory context</div>
        <div className="flex flex-wrap items-stretch gap-2">
          <RegChip label="Regulator" entity={lineage.regulator} onOpen={openEntity} />
          <ChainArrow verb="issues" />
          <RegChip label="Regulation" entity={lineage.regulation} onOpen={openEntity} />
          {loc.chapter && (<><ChainArrow verb="chapter" /><StaticChip label="Chapter" title={loc.chapter.no === '—' ? loc.chapter.title : `Ch. ${loc.chapter.no} · ${loc.chapter.title}`} /></>)}
          {loc.section && (<><ChainArrow verb="section" /><StaticChip label="Section" title={`Sec ${loc.section.no}`} /></>)}
          <ChainArrow verb="contains" />
          <RegChip label="Clause" entity={lineage.clause} onOpen={openEntity} />
          <ChainArrow verb="creates" />
          <RegChip label="Obligation" entity={obligation} onOpen={openEntity} highlight />
        </div>
      </div>

      {/* COMPANY MAPPING & IMPACT — every affected entity, on one page */}
      <div className="card px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted">Company mapping &amp; impact — {impact.total} affected {impact.total === 1 ? 'entity' : 'entities'}</div>
          <span className={cn('pill', coverageTone(cov.level))}>{cov.level}</span>
        </div>
        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line py-8 text-center text-[13px] text-muted">No company entities mapped yet — accept an AI recommendation below.</div>
        ) : (
          <>
            <div className="mb-1.5 hidden grid-cols-[minmax(0,1fr)_28px_minmax(0,1.3fr)_28px_minmax(0,1.15fr)] gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2 md:grid">
              <div>Company Brain entity</div><div /><div>Mapped to</div><div /><div>Impact on change</div>
            </div>
            <div className="space-y-1.5">
              {groups.flatMap((g) => g.rows.map((m) => <MappingImpactRow key={m.id} domain={g.domain} m={m} onOpen={openEntity} />))}
            </div>
          </>
        )}
      </div>

      {/* compact intelligence row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="card px-4 py-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted">Applicability</div>
            <span className={cn('pill', applicabilityTone(app.result))}>{app.result}</span>
          </div>
          <div className="text-2xs text-muted">{app.confidence}% confidence</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {app.matches.map((m) => (
              <button key={m.entityId} onClick={() => openEntity(m.entityId)} className="rounded-md bg-slate-100 px-2 py-0.5 text-2xs hover:bg-brand-50 hover:text-brand-600" title={m.dimension}>{m.entityName}</button>
            ))}
          </div>
        </div>

        <div className="card px-4 py-3.5">
          <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Coverage · Risk {cov.risk}</div>
          <ul className="space-y-1">
            {cov.pillars.map((p) => (
              <li key={String(p.domain)} className="flex items-center justify-between text-[13px]">
                <span className={p.mark === '✓' ? 'text-ink' : 'text-muted'}>{p.label}</span>
                <span className={cn('font-bold', p.mark === '✓' ? 'text-emerald-600' : p.mark === '⚠' ? 'text-amber-600' : 'text-red-500')}>{p.mark}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card px-4 py-3.5">
          <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Impact by domain</div>
          <div className="flex flex-wrap gap-1">
            {['processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence', 'people'].filter((d) => impact.byDomain[d]).map((d) => (
              <span key={d} className="pill bg-slate-100 text-slate-700">{getDomainConfig(d)?.title}: <b className="ml-0.5">{impact.byDomain[d]}</b></span>
            ))}
            {impact.total === 0 && <span className="text-2xs text-muted-2">No connected entities yet.</span>}
          </div>
        </div>

        <div className="card px-4 py-3.5">
          <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Mapping status</div>
          <div className="mb-2 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-lg font-extrabold text-emerald-600">{counts['Approved'] ?? 0}</div><div className="text-2xs text-muted">Approved</div></div>
            <div><div className="text-lg font-extrabold text-amber-600">{(counts['Proposed'] ?? 0) + (counts['Needs Review'] ?? 0)}</div><div className="text-2xs text-muted">Proposed</div></div>
            <div><div className="text-lg font-extrabold text-red-500">{counts['Rejected'] ?? 0}</div><div className="text-2xs text-muted">Rejected</div></div>
          </div>
          <div className="rounded-lg bg-brand-50/70 px-2.5 py-1.5 text-2xs text-brand-800"><b>Next:</b> {nextAction}</div>
        </div>
      </div>

      {/* AI recommendations */}
      <Section title="AI recommendations" action={<span className="inline-flex items-center gap-1.5 text-2xs text-muted"><Sparkles className="h-3.5 w-3.5 text-brand-500" /> proposed · not authoritative</span>}>
        {candidates.length === 0 ? (
          <div className="py-4 text-center text-2xs text-muted">No further candidates — all strong matches are already mapped.</div>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
            {candidates.map((c) => (
              <li key={c.entity.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px]">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-muted"><Icon name={getDomainConfig(c.entity.domain)?.icon ?? 'Box'} className="h-3.5 w-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{c.entity.name}</div>
                  <div className="truncate text-2xs text-muted">{getDomainConfig(c.entity.domain)?.title} · {c.reason}</div>
                </div>
                <span className="text-2xs font-semibold text-brand-600">{c.confidence}%</span>
                <button className="btn btn-sm h-7" onClick={() => accept(c.entity.id, c.entity.domain as DomainId, c.confidence, c.reason)}>Approve</button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* detailed table — secondary */}
      <div className="card overflow-hidden">
        <button onClick={() => setShowTable((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold hover:bg-slate-50">
          {showTable ? <ChevronDown className="h-4 w-4 text-muted-2" /> : <ChevronRight className="h-4 w-4 text-muted-2" />}
          Detailed mapping table ({rows.length})
        </button>
        {showTable && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-t border-line text-[13px]">
              <thead>
                <tr className="border-b border-line bg-slate-50/70 text-left">
                  {['Company Entity', 'Domain', 'Relationship', 'Status', 'Conf.', 'Reason', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">{m.target ? <button onClick={() => openEntity(m.target!.id)} className="font-semibold hover:text-brand-600 hover:underline">{m.target.name}</button> : m.targetId}</td>
                    <td className="px-3 py-2"><Badge value={getDomainConfig(m.targetDomain)?.title ?? String(m.targetDomain)} kind="plain" /></td>
                    <td className="px-3 py-2 text-2xs text-muted">{REL_VERB[m.targetDomain] ?? '—'}</td>
                    <td className="px-3 py-2"><Badge value={m.status} kind="status" /></td>
                    <td className="px-3 py-2 text-2xs text-muted">{m.confidence}%</td>
                    <td className="px-3 py-2 text-2xs text-muted">{m.reason}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-sm h-7 px-2 text-emerald-700" onClick={() => onSet(m.id, 'Approved')} title="Approve"><Check className="h-3.5 w-3.5" /></button>
                        <button className="btn btn-sm h-7 px-2 text-amber-700" onClick={() => onSet(m.id, 'Needs Review')} title="Needs review"><HelpCircle className="h-3.5 w-3.5" /></button>
                        <button className="btn btn-sm h-7 px-2 text-red-600" onClick={() => onSet(m.id, 'Rejected')} title="Reject"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- small building blocks ---- */
function RegChip({ label, entity, onOpen, highlight }: { label: string; entity?: Entity; onOpen: (id: string) => void; highlight?: boolean }) {
  if (!entity) return null;
  return (
    <button
      onClick={() => onOpen(entity.id)}
      className={cn('min-w-0 rounded-lg border px-3 py-1.5 text-left transition', highlight ? 'border-brand-500 bg-brand-500 text-white' : 'border-brand-200 bg-brand-50/60 hover:border-brand-400')}
    >
      <div className={cn('text-[10px] font-semibold uppercase tracking-wide', highlight ? 'text-white/70' : 'text-brand-500')}>{label}</div>
      <div className="truncate text-[13px] font-bold">{entity.name}</div>
    </button>
  );
}
function StaticChip({ label, title }: { label: string; title: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-slate-50 px-3 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">{label}</div>
      <div className="truncate text-[13px] font-bold text-ink-2">{title}</div>
    </div>
  );
}
function ChainArrow({ verb }: { verb: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-2">{verb}</span>
      <ChevronRight className="h-4 w-4 text-muted-2" />
    </div>
  );
}
/* Node-mapping row: [Company Brain entity type] → maps to → [mapped entity] → [impact on change] */
const PILLAR_SUB: Record<string, string> = {
  processes: 'What is done', systems: 'Where it is done', data: 'What data is used',
  policies: 'What governs it', controls: 'How it is controlled', risks: 'What risk it addresses',
  evidence: 'Proof of compliance', people: 'Who is responsible',
};
function deriveImpact(e: Entity | undefined, status: string): { level: 'High' | 'Medium' | 'Low'; note: string } {
  const high = !!e && (e.criticality === 'Critical' || e.criticality === 'High');
  const level: 'High' | 'Medium' | 'Low' = status !== 'Approved' ? 'High' : high ? 'High' : 'Medium';
  const note =
    status === 'Proposed' || status === 'Needs Review' ? 'Mapping needs human review'
      : status === 'Rejected' ? 'Rejected — coverage gap'
        : high ? 'High-criticality — changes ripple here'
          : 'Monitor when the regulation changes';
  return { level, note };
}
function impactTone(level: string) {
  return level === 'High' ? 'border-red-200 bg-red-50 text-red-700' : level === 'Medium' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-line bg-slate-50 text-slate-600';
}
function FlowArrow() {
  return (
    <div className="flex items-center justify-center py-0.5 md:py-0">
      <ChevronRight className="hidden h-4 w-4 text-muted-2 md:block" />
      <ArrowDown className="h-4 w-4 text-muted-2 md:hidden" />
    </div>
  );
}
function MappingImpactRow({ domain, m, onOpen }: { domain: string; m: MappingRow; onOpen: (id: string) => void }) {
  const cfg = getDomainConfig(domain);
  const s = statusMark(m.status);
  const imp = deriveImpact(m.target, m.status);
  return (
    <div className="grid grid-cols-1 items-stretch gap-2 rounded-xl md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1.3fr)_28px_minmax(0,1.15fr)]">
      {/* entity type */}
      <div className="flex items-center gap-2 rounded-lg border border-line bg-slate-50/70 px-3 py-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-muted"><Icon name={cfg?.icon ?? 'Box'} className="h-4 w-4" /></span>
        <div className="min-w-0"><div className="text-[13px] font-semibold">{cfg?.title ?? domain}</div><div className="text-2xs text-muted">{PILLAR_SUB[domain] ?? ''}</div></div>
      </div>
      <FlowArrow />
      {/* mapped entity */}
      <button onClick={() => m.target && onOpen(m.target.id)} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-left transition hover:border-brand-300 hover:shadow-sm">
        <span className={cn('text-base font-bold', s.c)}>{s.m}</span>
        <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-bold">{m.target?.name ?? m.targetId}</div><div className="text-2xs text-muted">{m.status} · {m.confidence}%</div></div>
      </button>
      <FlowArrow />
      {/* impact */}
      <div className={cn('rounded-lg border px-3 py-2', impactTone(imp.level))}>
        <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-current" /><span className="text-[13px] font-bold">{imp.level} impact</span></div>
        <div className="text-2xs opacity-80">{imp.note}</div>
      </div>
    </div>
  );
}

export default MappingPage;
