// ============================================================
// The compliance chain, read from the API that joins persisted rows:
//   REGULATION → CLAUSE → OBLIGATION → REQUIREMENT → APPLICABILITY
//             → CONTROL → EVIDENCE → ASSESSMENT → COMPLIANCE RESULT
//
// Every state below is a value the database returned. A missing link arrives
// as a named state (UNMAPPED, ABSENT, MISSING, NOT_ASSESSED) and must be shown
// as such — never smoothed into a blank or an optimistic default.
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';

const get = <T,>(p: string): Promise<T> => api<T>(p);

export interface RequirementRow {
  id: string;
  regulation_id: string;
  obligation_id: string | null;
  statement: string;
  source_clause: string | null;
  source_excerpt: string | null;
  frequency: string | null;
  deadline: string | null;
  responsible_role: string | null;
  confidence: number | null;
  review_status: string | null;
  derivation_method: string | null;
  regulation_title: string | null;
  regulator_short: string | null;
  obligation_title: string | null;
  section_id: string | null;
  clause_id: string | null;
  /** the requirement's own verdict; falls back to its regulation's */
  applicability: string;
  /** one sentence saying why, from the requirement's own words */
  applicability_reason?: string | null;
  /** what kind of sentence decided it: OURS, NOT_A_DUTY, AUTHORITY, OTHER_TYPE, AMBIGUOUS_TYPE, SITUATION, INHERITS… */
  applicability_kind?: string | null;
  regulation_applicability?: string | null;
  compliance_status: string;
  control_count: number;
  evidence_count: number;
  control_status: 'MAPPED' | 'UNMAPPED';
  evidence_status: 'PRESENT' | 'ABSENT';
  assessment_result: string;
  /** NABH guidebook criteria under this requirement's element (they are not rows of their own) */
  criteria_count?: number;
  is_criterion?: boolean;
}

/** A guidebook assessment criterion, shown under its objective element. */
export interface RequirementCriterion {
  id: string; statement: string; test_method: string | null; responsible_role: string | null;
  frequency: string | null; compliance_status: string | null;
}

export interface RequirementList {
  page: number; size: number; total: number; items: RequirementRow[]; note: string;
}

export interface RequirementMetrics {
  totalRequirements: number;
  regulationsWithRequirements: number;
  regulationsWithoutRequirements: number;
  mappedRegulations: number;
  requirementsWithControls: number;
  requirementsWithoutControls: number;
  requirementsRequiringReview: number;
  controlMappingsAwaitingReview: number;
  note: string;
}

export interface RequirementDetail {
  isCriterion?: boolean;
  criteria?: RequirementCriterion[];
  requirement: Record<string, unknown> & { id: string; statement: string };
  lineage: {
    regulation: { id: string; title: string | null; regulator: string | null;
                  regulatorShort: string | null; sourceUrl: string | null; documentUrl: string | null };
    chapter: string | null;
    section: { id: string; section_number: string; section_title: string; section_text: string } | null;
    clause: { id: string; clause_number: string; clause_text: string; clause_path: string | null;
              depth: number | null } | null;
    clauseAncestors: { id: string; clause_number: string; clause_text: string }[];
    obligation: (Record<string, unknown> & { id: string; title: string | null }) | null;
  };
  provenance: {
    originalLegalText: { text: string | null; citation: string | null; page: number | null;
                         kind: string | null; note: string };
    extractedObligation: { method: string | null; confidence: number | null;
                           reviewStatus: string | null; note: string };
    derivedRequirement: { method: string | null; confidence: number | null;
                          reviewStatus: string | null; note: string };
    aiInterpretation: null | Record<string, unknown>;
    systemClassification: { obligationType: string | null };
  };
}

export interface ChainStep {
  step: string;
  state: 'PRESENT' | 'MISSING';
  detail: string | number | null;
  reason: string | null;
}

export interface EvidenceRow {
  id: string; name: string; evidence_type: string | null; owner_id: string | null;
  owner_name?: string | null; source_system: string | null; valid_from: string | null;
  valid_until: string | null; status: string | null; content_hash: string | null;
  verification_status: string | null; last_verified_at: string | null;
  evidenceState: string; relationship_type?: string; link_rationale?: string | null;
  control_count?: number;
}

export interface Traceability {
  requirement: { id: string; statement: string; source_clause: string | null;
                 regulation_id: string; regulation_title: string | null };
  instances: { cri_id: string; compliance_status: string | null; applicability: string | null;
               applicability_reason: string | null; owner_id: string | null }[];
  controls: { mapping_id: number | string; control_id: string; control_name: string | null;
              rationale: string | null; mapped_by: string | null; review_status: string | null;
              relationship_type: string | null; mapping_method: string | null;
              derived_from: string | null; evidence: EvidenceRow[] }[];
  assessments: { id: string; result: string; method: string; rationale: string;
                 review_status: string; assessed_at: string }[];
  chain: ChainStep[];
  chainComplete: boolean;
  note: string;
}

export interface Coverage {
  mappedRegulations: number;
  byStage: Record<string, { regulations: number; pct: number }>;
  requirements: { total: number; withControl: { n: number; pct: number };
                  withEvidence: { n: number; pct: number }; fullChain: { n: number; pct: number } };
  controls: { total: number; withEvidence: number; withoutEvidence: number };
  note: string;
}

export const useRequirements = (params: {
  regulation_id?: string; page?: number; size?: number; q?: string;
  control_status?: string; evidence_status?: string; applicability?: string; sort?: string;
}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, String(v)); });
  return useQuery<RequirementList>({
    queryKey: ['requirements', qs.toString()],
    queryFn: () => get(`/api/requirements?${qs}`),
    staleTime: 30_000,
  });
};

export const useRequirementMetrics = () =>
  useQuery<RequirementMetrics>({ queryKey: ['requirement-metrics'],
    queryFn: () => get('/api/requirements/metrics'), staleTime: 60_000 });

export const useRequirementDetail = (id: string | undefined) =>
  useQuery<RequirementDetail>({ queryKey: ['requirement', id], enabled: !!id,
    queryFn: () => get(`/api/requirements/${id}`) });

export const useTraceability = (id: string | undefined) =>
  useQuery<Traceability>({ queryKey: ['traceability', id], enabled: !!id,
    queryFn: () => get(`/api/requirements/${id}/traceability`) });

export const useControlEvidence = (cid: string | undefined) =>
  useQuery<{ control: { id: string; name: string }; items: EvidenceRow[]; state: string; note: string }>({
    queryKey: ['control-evidence', cid], enabled: !!cid,
    queryFn: () => get(`/api/controls/${cid}/evidence`) });

export const useCoverage = () =>
  useQuery<Coverage>({ queryKey: ['compliance-coverage'],
    queryFn: () => get('/api/compliance/coverage'), staleTime: 60_000 });

/**
 * Assessment and compliance state for one regulation.
 *
 * Every bucket the server sends is a real count, and a stage that has not run
 * arrives as its own named bucket (NOT_ASSESSED, NO_EVIDENCE,
 * INSUFFICIENT_EVIDENCE) rather than as a zero that would read like coverage.
 */
export interface RegulationCompliance {
  regulation: { id: string; title: string; regulator_short: string | null; ingestion_status: string | null };
  summary: {
    requirements: number;
    withApplicability: number;
    withControl: number;
    withEvidence: number;
    assessed: number;
    notAssessed: number;
    passed: number;
    compliantPct: number;
  };
  byApplicability: Record<string, number>;
  byResult: Record<string, number>;
  byComplianceStatus: Record<string, number>;
  assessments: {
    id: string;
    result: string;
    method: string;
    rationale: string | null;
    review_status: string;
    assessed_by: string | null;
    assessed_at: string | null;
    evidence_considered: number | null;
    requirement_id: string;
    statement: string;
    source_clause: string | null;
    control_id: string | null;
    control_name: string | null;
    evidence_count: number;
  }[];
  note: string;
}

export const useRegulationCompliance = (id: string) =>
  useQuery<RegulationCompliance>({
    queryKey: ['regulation-compliance', id],
    queryFn: () => get(`/api/regulations/${encodeURIComponent(id)}/compliance`),
    enabled: !!id,
    staleTime: 30_000,
  });
