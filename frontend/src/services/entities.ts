import type { DomainId, Entity, Relationship } from '@/types/entity';
import { useData } from '@/app/store/data';
import { REL_LABELS, type Subtab, type AnyContentDomain } from '@/config/domains';
import { getDomainConfig } from '@/config/registry';

// Services read the live client store so runtime additions/verification reflect everywhere.
const S = () => useData.getState();
const mapById = () => new Map(S().entities.map((e) => [e.id, e]));

export function entityById(id: string): Entity | undefined {
  return mapById().get(id);
}
export function ownerName(e: Entity): string | undefined {
  return e.ownerId ? mapById().get(e.ownerId)?.name : undefined;
}

export interface ResolvedRel {
  rel: Relationship;
  direction: 'out' | 'in';
  verb: string;
  other: Entity;
}

export function relationsFor(id: string): ResolvedRel[] {
  const byId = mapById();
  const out: ResolvedRel[] = [];
  for (const r of S().relationships) {
    if (r.sourceId === id) {
      const other = byId.get(r.targetId);
      if (other) out.push({ rel: r, direction: 'out', verb: REL_LABELS[r.type] ?? r.type, other });
    } else if (r.targetId === id) {
      const other = byId.get(r.sourceId);
      if (other) out.push({ rel: r, direction: 'in', verb: REL_LABELS[r.type] ?? r.type, other });
    }
  }
  return out;
}

export function ownershipRelations() {
  const byId = mapById();
  return S()
    .relationships.filter((r) => r.type === 'owns')
    .map((r) => {
      const person = byId.get(r.sourceId);
      const target = byId.get(r.targetId);
      return person && target ? { person, verb: 'owns', target, rel: r } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export function entitiesForSubtab(domainId: AnyContentDomain, subtab: Subtab): Entity[] {
  const entities = S().entities;
  const relationships = S().relationships;
  if (subtab.kind === 'entities') {
    return entities.filter(
      (e) => e.domain === domainId && (subtab.filterType ? e.type === subtab.filterType : true),
    );
  }
  if (subtab.kind === 'verification') {
    return entities.filter((e) => e.domain === domainId && e.verification !== 'Verified');
  }
  if (subtab.kind === 'related' && subtab.relatedDomain) {
    const domainIds = new Set(entities.filter((e) => e.domain === domainId).map((e) => e.id));
    const relatedIds = new Set<string>();
    for (const r of relationships) {
      if (domainIds.has(r.sourceId)) relatedIds.add(r.targetId);
      if (domainIds.has(r.targetId)) relatedIds.add(r.sourceId);
    }
    return entities.filter((e) => e.domain === subtab.relatedDomain && relatedIds.has(e.id));
  }
  return [];
}

/** For a related entity, the verb that links it back to the viewing domain. */
export function relatedContext(domainId: AnyContentDomain, relatedId: string): string | undefined {
  const domainIds = new Set(S().entities.filter((e) => e.domain === domainId).map((e) => e.id));
  for (const r of S().relationships) {
    if (r.targetId === relatedId && domainIds.has(r.sourceId)) return REL_LABELS[r.type] ?? r.type;
    if (r.sourceId === relatedId && domainIds.has(r.targetId)) return REL_LABELS[r.type] ?? r.type;
  }
  return undefined;
}

export function historyForDomain(domainId: AnyContentDomain) {
  const ids = new Set(S().entities.filter((e) => e.domain === domainId).map((e) => e.id));
  return S().history.filter((h) => ids.has(h.entityId));
}

export function domainKpis(domainId: AnyContentDomain) {
  const list = S().entities.filter((e) => e.domain === domainId);
  return {
    total: list.length,
    verified: list.filter((e) => e.verification === 'Verified').length,
    pending: list.filter((e) => e.verification !== 'Verified').length,
    critical: list.filter((e) => e.criticality === 'Critical' || e.criticality === 'High').length,
    noun: getDomainConfig(domainId)?.entityNoun ?? 'Entity',
  };
}

export function graphModel(filterDomains?: Set<DomainId>) {
  const nodes = S().entities.filter((e) => !filterDomains || filterDomains.has(e.domain as DomainId));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = S().relationships.filter((r) => nodeIds.has(r.sourceId) && nodeIds.has(r.targetId));
  return { nodes, edges };
}
