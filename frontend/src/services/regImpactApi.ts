// ============================================================
// Regulation impact graph — served from the API, built from real records.
//
// Replaces the retired seed-based builder. Every node here is a Company Brain
// entity that exists, every edge names the obligation that connects it, and the
// impact type is derived from match confidence rather than asserted.
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';
import type { ImpactLevel, ImpactType, ImpactDomain } from '@/services/regImpact';

export interface ImpactApiNode {
  id: string;
  entityId: string;
  name: string;
  domain: ImpactDomain;
  type: string | null;
  criticality: string | null;
  owner: string | null;
  ownerId: string | null;
  confidence: number;
  obligations: { id: string; title: string | null; type: string | null }[];
  /** how many entities depend on this one — the badge on the node */
  downstream: number;
  reason: string | null;
  impactType: ImpactType;
  impactLevel: ImpactLevel;
}

export interface ImpactApiEdge {
  source: string;
  target: string;
  relationship: string;
  /** 'obligation' = the regulation reaching an entity; 'propagation' = entity → entity */
  kind: 'obligation' | 'propagation';
  confidence: number;
  impactType?: ImpactType;
  reason: string | null;
}

export interface PenaltyProvision {
  section_number: string | null;
  kind: 'FIXED_FINE' | 'PER_DAY' | 'MULTIPLIER_OF_SUM' | 'IMPRISONMENT' | 'SUSPENSION_CANCELLATION' | 'UNQUANTIFIED';
  amount_min: number | null;
  amount_max: number | null;
  per_day_amount: number | null;
  multiplier: number | null;
  multiplier_basis: string | null;
  imprisonment_months: number | null;
  basis_text: string;
  amount_min_fmt: string | null;
  amount_max_fmt: string | null;
  per_day_fmt: string | null;
}
export interface PenaltyExposure {
  provisions: PenaltyProvision[];
  summary: {
    maxFixed: number | null; maxFixedFmt: string | null;
    maxPerDay: number | null; maxPerDayFmt: string | null;
    multipliers: { multiplier: number; basis: string | null }[];
    maxImprisonmentMonths: number | null;
    unquantified: number;
    suspension: boolean;
  } | null;
  applicability: string;
  note: string;
}

export interface ImpactGraph {
  regulation: {
    id: string; title: string; regulator: string; regulator_short: string;
    regulation_type: string | null; issued_on: string | null; status: string | null;
    source_url: string | null; impact_level: string | null; impact_score: number | null;
    document_hash: string | null; page_count: number | null;
  };
  changeStatus: { status: string; message: string; versionsCaptured: number; computedChanges: number };
  nodes: ImpactApiNode[];
  edges: ImpactApiEdge[];
  byDomain: Record<string, number>;
  totals: { entities: number; edges: number; propagation: number;
            direct: number; indirect: number; potential: number };
  computedChanges: {
    section_number: string; change_type: string;
    old_text: string | null; new_text: string | null;
    words_added: number; words_removed: number;
  }[];
  amendments: { reference: string; amended_on: string; raw: string; url: string | null }[];
  /** What this regulation's own text says failure costs. */
  penalties: PenaltyExposure;
  /** The score taken apart into the terms that produced it. Null when unscored. */
  score: {
    score: number; level: string; computedAt: string | null;
    terms: {
      kind: 'domain' | 'obligations' | 'criticality';
      label: string; count: number | null; counted: number | null;
      weight: number | null; points: number; capped: boolean;
    }[];
    subtotal: number;
    applicabilityMultiplier: number;
    cappedAt100: boolean;
    formula: string | null;
    bands: { level: string; from: number }[];
  } | null;
  note: string;
}

export const useImpactGraph = (rid: string | undefined, minConfidence = 0.6) =>
  useQuery<ImpactGraph>({
    queryKey: ['impact-graph', rid, minConfidence],
    queryFn: () => api<ImpactGraph>(`/api/regulations/${rid}/impact?min_confidence=${minConfidence}&limit=800`).then((d) => {
      // a reply without the graph's lists is a failed load, not an empty graph to draw
      if (!Array.isArray(d?.nodes) || !Array.isArray(d?.edges)) throw new Error('The impact map came back incomplete.');
      return d;
    }),
    enabled: !!rid,
  });
