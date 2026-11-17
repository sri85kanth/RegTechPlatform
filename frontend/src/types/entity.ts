import { txList } from '@/i18n';
// ============================================================
// Universal entity model — every Company Brain entity shares this
// foundation. Domain differences live in `attrs` + domain config.
// ============================================================

export type DomainId =
  | 'overview'
  | 'people'
  | 'processes'
  | 'systems'
  | 'data'
  | 'policies'
  | 'controls'
  | 'risks'
  | 'evidence';

/** Regulatory Brain domains — a SEPARATE nav area, external regulatory reality. */
export type RegDomainId =
  | 'reg-regulators'
  | 'reg-regulations'
  | 'reg-clauses'
  | 'reg-obligations'
  | 'reg-changes'
  | 'reg-sources';

/** Any entity domain (Company Brain or Regulatory Brain) — one shared graph. */
export type AnyDomain = DomainId | RegDomainId;

export const LIFECYCLE = txList([
  'Discovered',
  'Draft',
  'Pending Review',
  'Verified',
  'Active',
  'Under Review',
  'Superseded',
  'Archived',
] as const);
export type Lifecycle = (typeof LIFECYCLE)[number];

export type VerificationState = 'Verified' | 'Pending' | 'Needs Review' | 'Rejected';
export type Criticality = 'Critical' | 'High' | 'Medium' | 'Low';
export type SourceKind = 'Manual' | 'CSV' | 'Excel' | 'API' | 'Connector' | 'Document' | 'AI Extraction' | 'Seed';

/** Provenance carried by every important entity (spec §20). */
export interface Provenance {
  source: SourceKind;
  sourceReference?: string;
  confidence: number; // 0..100
  verifiedBy?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** The single, shared entity record. One id per real-world thing. */
export interface Entity {
  id: string;
  domain: AnyDomain;
  name: string;
  type?: string;
  description?: string;
  status?: string;
  ownerId?: string; // resolves to a People entity id
  criticality?: Criticality;
  lifecycle: Lifecycle;
  verification: VerificationState;
  provenance: Provenance;
  tags?: string[];
  /** Domain-specific fields, referenced by column/filter config. */
  attrs: Record<string, string | number | boolean | undefined>;
}

/** Generic, typed relationship — the graph edge. */
export interface Relationship {
  id: string;
  sourceId: string;
  type: string; // verb, e.g. 'owns', 'uses', 'stores', 'mitigates'
  targetId: string;
  confidence: number;
  status: VerificationState;
}

export interface HistoryEvent {
  id: string;
  entityId: string;
  action: string; // Created, Updated, Verified, Relationship Added, ...
  by: string;
  at: string;
  detail?: string;
}

/** AI-proposed item awaiting human review (spec §19). */
export interface ReviewItem {
  id: string;
  kind: 'entity' | 'relationship';
  title: string;
  domain: DomainId;
  source: SourceKind;
  confidence: number;
  proposed: string; // human-readable proposal (e.g. relationship)
  detail: string;
}
