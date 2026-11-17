// ============================================================
// The Regulation, in seven groups.
//
//   Identity · Scope · Structure · Legal Content · Relationships
//   · Versions · Provenance
//
// This is REGULATORY FACT — what the regulator actually said. Company impact is
// deliberately not here; it belongs to a different layer, and mixing them makes
// "our engine thinks this applies" look like "the regulation says this applies".
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface RegIdentity {
  id: string; title: string; shortTitle: string | null;
  regulator: string; regulatorShort: string | null; regulationType: string | null;
  notificationNumber: string | null; circularNumber: string | null; referenceNumber: string | null;
  issuingDepartment: string | null; issuingAuthority: string | null;
  issuedDate: string | null; publishedDate: string | null; effectiveDate: string | null;
  status: string | null; legalAuthority: string | null;
  enablingAct: string | null; enablingSection: string | null; language: string | null;
}

export interface ApplicabilityRule {
  entity_type: string | null; applicability: string | null; applicability_rule: string | null;
  source_clause: string | null; confidence: number | null; subject: string | null;
  jurisdiction: string | null; sector: string | null; review_status: string | null;
}

export interface Provision {
  id: string; section_id: string | null; section_number: string | null; section_title: string | null;
  actor: string | null; modality: string | null; action: string | null; object: string | null;
  is_prohibition: boolean; is_permission: boolean;
  source_text: string; review_status: string;
}

/**
 * A duty as the drafter structured it — one per clause carrying a modality.
 * Verbatim statement; the fields are only what the text itself named.
 * `review_status` is the regulatory-side review; company assessment is on the CRI.
 */
export interface Requirement {
  id: string; obligation_id: string; statement: string; source_clause: string | null;
  frequency: string | null; deadline: string | null; threshold: string | null;
  condition: string | null; responsible_role: string | null;
  confidence: number | null; review_status: string; derivation_method: string;
}

export interface RegulationDetail {
  identity: RegIdentity;
  scope: {
    jurisdiction: string | null; country: string | null; state: string | null;
    sector: string | null; subSector: string | null;
    regions: string[]; sectors: string[]; entityTypes: string[];
    products: null; services: null; channels: null; customerTypes: null;
    applicabilityRules: ApplicabilityRule[];
    /** named explicitly — an empty array would read as "the regulation names none" */
    notExtracted: string[];
  };
  structure: {
    sections: number; clauses: number; tables: number;
    tree: { id: string; section_number: string; section_title: string;
            parent_section_id: string | null; chars: number }[];
  };
  legal: {
    counts: Record<string, number>;
    modalityBreakdown: Record<string, number>;
    definitions: { id: string; term: string; definition_text: string; source_section_id: string | null }[];
    provisions: Provision[];
    conditions: { provision_id: string; condition_type: string; expression: string }[];
    exceptions: { provision_id: string; exception_type: string; expression: string }[];
    thresholds: { provision_id: string; metric: string; operator: string | null; value: string;
                  unit: string | null; currency: string | null; source_text: string }[];
    timingRules: { provision_id: string; rule_type: string; expression: string;
                   value: string | null; unit: string | null; source_text: string }[];
    reporting: unknown[]; records: unknown[]; disclosures: unknown[];
    /** Regulatory fact only: the duty as the drafter structured it. No company state here. */
    requirements: Requirement[];
  };
  relationships: {
    crossReferences: { source_reference: string | null; relation: string;
                       target_reference: string | null; target_regulation_id: string | null;
                       resolved: boolean; source_text: string | null }[];
    amendments: { reference: string; amended_on: string; operation: string | null;
                  section_number: string | null; raw: string; url: string | null }[];
    supersedes: unknown[]; supersededBy: unknown[];
  };
  versions: {
    changeStatus: { status: string; explanation: string; computedChanges: number };
    document: { source_url: string; document_hash: string; page_count: number;
                file_size: number; extraction_method: string; ocr_used: number;
                created_at: string } | null;
    versions: { id: number; captured_at: string; retrieved_at: string | null;
                retrieved_from: string | null; document_hash: string;
                page_count: number | null; section_count: number | null }[];
    changes: number;
  };
  provenance: {
    sourceUrl: string | null; officialDocumentUrl: string | null; sourceAuthority: string | null;
    sha256: string | null; pageCount: number | null; extractionMethod: string | null;
    ocrUsed: boolean | null; retrievedAt: string | null;
    sourceVerified: boolean; lastVerifiedAt: string | null;
    facts: number; avgExtractionConfidence: number | null;
  };
  note: string;
}

export const useRegulationDetail = (rid: string | undefined) =>
  useQuery<RegulationDetail>({
    queryKey: ['regulation-detail', rid],
    queryFn: () => api(`/api/regulation/${rid}?sample=120`),
    enabled: !!rid,
  });
