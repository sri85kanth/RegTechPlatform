// ============================================================
// Regulatory impact index — for every Company Brain entity, which
// regulations reach it. Two evidence sources, kept distinct:
//   • Company Brain mappings  (obligation → entity; approved / proposed by humans)
//   • Pipeline analysis       (obligation ↔ entity matches from official documents;
//                              AI-proposed, unverified — high-confidence ones count)
// Nothing is invented: an entity with no evidence simply has no entry.
// ============================================================
import type { Mapping } from '@/types/regulatory';
import { obligationLineage } from '@/services/regulatory';
import type { IntelEntities } from '@/services/regIntel';

export interface RegRef {
  id: string;
  name: string;
  regulator?: string;
  /** how we know: a curated mapping, or the document pipeline */
  source: 'mapping' | 'analysis';
  /** mapping status (mapping source) */
  status?: string;
  /** 0..1 (analysis source) */
  confidence?: number;
  obligations: number;
}
export interface EntityRegImpact {
  /** counted on the node badge: curated mappings ∪ high-confidence analysis */
  regs: RegRef[];
  /** lower-confidence analysis matches — pending review, not counted on the badge */
  pending: RegRef[];
}

export const ANALYSIS_BADGE_MIN_CONFIDENCE = 0.9;

export function buildRegImpactIndex(mappings: Mapping[], intel: IntelEntities | undefined): Map<string, EntityRegImpact> {
  const out = new Map<string, EntityRegImpact>();
  const get = (id: string) => { if (!out.has(id)) out.set(id, { regs: [], pending: [] }); return out.get(id)!; };

  // 1) curated Company Brain mappings
  const byEntity = new Map<string, Map<string, RegRef>>();
  mappings.filter((m) => m.status !== 'Rejected').forEach((m) => {
    const lin = obligationLineage(m.obligationId);
    const reg = lin.regulation; if (!reg) return;
    if (!byEntity.has(m.targetId)) byEntity.set(m.targetId, new Map());
    const bucket = byEntity.get(m.targetId)!;
    const cur = bucket.get(reg.id);
    if (cur) { cur.obligations += 1; if (m.status === 'Approved') cur.status = 'Approved'; }
    else bucket.set(reg.id, { id: reg.id, name: reg.name, regulator: lin.regulator?.name, source: 'mapping', status: m.status, obligations: 1 });
  });
  byEntity.forEach((bucket, eid) => get(eid).regs.push(...bucket.values()));

  // 2) pipeline analysis (only regulations not already covered by a curated mapping)
  if (intel) {
    Object.entries(intel.entities).forEach(([eid, v]) => {
      const e = get(eid);
      const have = new Set(e.regs.map((r) => r.id));
      v.regulations.forEach((r) => {
        if (have.has(r.id)) return;
        const ref: RegRef = { id: r.id, name: r.title, regulator: r.regulator, source: 'analysis', confidence: r.confidence, obligations: r.links };
        (r.confidence >= ANALYSIS_BADGE_MIN_CONFIDENCE ? e.regs : e.pending).push(ref);
      });
      if (e.regs.length === 0 && e.pending.length === 0) out.delete(eid);
    });
  }
  return out;
}

/** distinct regulations across a set of entities (for group / company roll-ups) */
export function distinctRegs(index: Map<string, EntityRegImpact>, ids: string[]): number {
  const s = new Set<string>();
  ids.forEach((id) => index.get(id)?.regs.forEach((r) => s.add(r.id)));
  return s.size;
}
