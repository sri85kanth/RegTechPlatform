import type { Entity } from '@/types/entity';
import type { CoverageResult, Mapping } from '@/types/regulatory';
import { useData } from '@/app/store/data';
import { entityById, relationsFor } from '@/services/entities';

const S = () => useData.getState();

export function obligations(): Entity[] {
  return S().entities.filter((e) => e.domain === 'reg-obligations');
}

// ---- Traceability: walk the EXISTING reg relationships upward from an obligation ----
export interface Lineage {
  regulator?: Entity;
  regulation?: Entity;
  clause?: Entity;
}
export function obligationLineage(obligationId: string): Lineage {
  const clause = relationsFor(obligationId).find((r) => r.rel.type === 'creates' && r.direction === 'in')?.other;
  const regulation = clause ? relationsFor(clause.id).find((r) => r.rel.type === 'contains' && r.direction === 'in')?.other : undefined;
  const regulator = regulation ? relationsFor(regulation.id).find((r) => r.rel.type === 'issues' && r.direction === 'in')?.other : undefined;
  return { regulator, regulation, clause };
}

/** Mapped company entities grouped by pillar domain, in the canonical journey order. */
const PILLAR_ORDER = ['processes', 'systems', 'data', 'policies', 'controls', 'risks', 'people', 'evidence'] as const;
export function mappedGroups(obligationId: string): { domain: string; rows: MappingRow[] }[] {
  const rows = mappingRows(obligationId);
  return PILLAR_ORDER.map((d) => ({ domain: d, rows: rows.filter((m) => m.targetDomain === d) })).filter((g) => g.rows.length > 0);
}

/** Pillars that are not yet fully covered (for the "what's missing" message). */
export function coverageGaps(obligationId: string): string[] {
  return coverageFor(obligationId).pillars.filter((p) => p.mark !== '✓').map((p) => p.label);
}

const COMPANY_DOMAINS = new Set(['people', 'processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence']);
/**
 * Blast radius of an obligation across the Company Brain: the directly-mapped
 * company entities PLUS their immediate graph neighbours. Only real relationships
 * are followed — nothing is invented. Grouped by domain for the impact summary.
 */
export function obligationImpact(obligationId: string): { total: number; byDomain: Record<string, number>; entities: Entity[] } {
  const set = new Map<string, Entity>();
  const mapped = mappingsFor(obligationId).map((m) => entityById(m.targetId)).filter((e): e is Entity => Boolean(e));
  mapped.forEach((e) => set.set(e.id, e));
  // one hop out from each mapped entity, staying inside the Company Brain
  mapped.forEach((e) =>
    relationsFor(e.id).forEach((r) => {
      if (COMPANY_DOMAINS.has(r.other.domain)) set.set(r.other.id, r.other);
    }),
  );
  const entities = [...set.values()];
  const byDomain: Record<string, number> = {};
  entities.forEach((e) => { byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1; });
  return { total: entities.length, byDomain, entities };
}


export function mappingsFor(obligationId: string): Mapping[] {
  return S().mappings.filter((m) => m.obligationId === obligationId);
}

export interface MappingRow extends Mapping {
  target?: Entity;
}
export function mappingRows(obligationId: string): MappingRow[] {
  return mappingsFor(obligationId).map((m) => ({ ...m, target: entityById(m.targetId) }));
}

/** Coverage derived from APPROVED mappings across the key company pillars. */
export function coverageFor(obligationId: string): CoverageResult {
  const rows = mappingsFor(obligationId);
  const pillarDomains: { domain: 'policies' | 'processes' | 'controls' | 'evidence'; label: string }[] = [
    { domain: 'policies', label: 'Policy' },
    { domain: 'processes', label: 'Process' },
    { domain: 'controls', label: 'Control' },
    { domain: 'evidence', label: 'Evidence' },
  ];
  const pillars = pillarDomains.map((p) => {
    const rel = rows.filter((m) => m.targetDomain === p.domain);
    let mark: '✓' | '⚠' | '✕' = '✕';
    if (rel.some((m) => m.status === 'Approved')) mark = '✓';
    else if (rel.some((m) => ['Proposed', 'Partial', 'Needs Review'].includes(m.status))) mark = '⚠';
    return { domain: p.domain, label: p.label, mark };
  });
  const approved = pillars.filter((p) => p.mark === '✓').length;
  const partial = pillars.filter((p) => p.mark === '⚠').length;
  let level: CoverageResult['level'];
  let risk: CoverageResult['risk'];
  if (approved === pillars.length) {
    level = 'Fully Covered';
    risk = 'Low';
  } else if (approved > 0 || partial > 0) {
    level = 'Partially Covered';
    risk = 'Medium';
  } else {
    level = 'Not Covered';
    risk = 'High';
  }
  return { level, risk, pillars };
}

const STOP = new Set(['the', 'a', 'to', 'of', 'and', 'for', 'in', 'on', 'at', 'within', 'obtain', 'record', 'provide', 'file', 'enforce']);
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * Candidate company entities for an obligation — a deterministic
 * keyword/metadata match (the "AI recommendation"). Never auto-approved.
 */
export function candidateMappings(obligationId: string, limit = 6): { entity: Entity; confidence: number; reason: string }[] {
  const obl = entityById(obligationId);
  if (!obl) return [];
  const already = new Set(mappingsFor(obligationId).map((m) => m.targetId));
  const oblTokens = tokens(`${obl.name} ${String(obl.attrs.subject ?? '')} ${String(obl.attrs.object ?? '')}`);
  const companyDomains = new Set(['people', 'processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence']);

  const scored = S()
    .entities.filter((e) => companyDomains.has(e.domain) && !already.has(e.id))
    .map((e) => {
      const et = tokens(`${e.name} ${e.type ?? ''} ${Object.values(e.attrs).join(' ')}`);
      let overlap = 0;
      oblTokens.forEach((t) => {
        if (et.has(t)) overlap++;
      });
      const confidence = Math.min(95, 45 + overlap * 18);
      return { entity: e, confidence, reason: `${overlap} keyword match on ${e.type ?? e.domain}`, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
  return scored.map(({ entity, confidence, reason }) => ({ entity, confidence, reason }));
}

/** Portfolio coverage summary across all obligations. */
export function coverageSummary() {
  const obls = obligations();
  const counts = { Fully: 0, Partially: 0, Not: 0 };
  obls.forEach((o) => {
    const c = coverageFor(o.id).level;
    if (c === 'Fully Covered') counts.Fully++;
    else if (c === 'Partially Covered') counts.Partially++;
    else counts.Not++;
  });
  return { total: obls.length, ...counts };
}
