import type { AnyDomain } from './entity';

// ------------------------------------------------------------
// Mapping Engine — connects Regulatory Brain (Obligation) to
// Company Brain entities. AI proposes; a human approves.
// ------------------------------------------------------------

export type MappingStatus =
  | 'Proposed'
  | 'Approved'
  | 'Partial'
  | 'Rejected'
  | 'Not Applicable'
  | 'Needs Review';

export interface Mapping {
  id: string;
  obligationId: string; // reg-obligations entity id
  targetId: string; // company entity id (Policy/Process/Control/Data/Risk/Person/Team/Evidence)
  targetDomain: AnyDomain;
  status: MappingStatus;
  confidence: number; // 0..100 (AI recommendation strength)
  reason: string;
  source: 'AI Extraction' | 'Manual' | 'Connector';
  createdBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

export type CoverageLevel =
  | 'Fully Covered'
  | 'Partially Covered'
  | 'Not Covered'
  | 'Conflict'
  | 'Needs Review'
  | 'Not Applicable';

export interface CoverageResult {
  level: CoverageLevel;
  risk: 'High' | 'Medium' | 'Low' | 'None';
  /** per company target-domain: '✓' approved, '⚠' proposed/partial, '✕' none */
  pillars: { domain: AnyDomain; label: string; mark: '✓' | '⚠' | '✕' }[];
}

export type Applicability = 'Applicable' | 'Not Applicable' | 'Needs Review';

/** A matched company-context signal, referencing an EXISTING company entity by id. */
export interface ApplicabilityMatch {
  dimension: 'Jurisdiction' | 'Legal Entity' | 'License' | 'Business Activity' | 'Industry' | 'Regulatory Scope';
  entityId: string; // existing Company Brain / Overview entity id — never a duplicate
  entityName: string;
}

/** The result of evaluating whether an obligation applies to THIS company. */
export interface ApplicabilityResult {
  result: Applicability;
  reason: string;
  matches: ApplicabilityMatch[];
  confidence: number; // 0..100
}
