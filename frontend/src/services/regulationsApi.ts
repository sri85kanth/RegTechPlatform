// ============================================================
// The ONLY source of regulatory data for the production UI.
//
// Everything here comes from the database via FastAPI, which is populated
// exclusively by the scraper. There is no static-file path, no seed import and
// no fallback: an empty database yields an empty list, never invented content.
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';
import { tx } from '@/i18n';

export { API_BASE } from '@/services/http';

/** Explicit change states — a footnote is never presented as a detected change. */
export type ChangeStatusCode =
  | 'NOT_CHECKED'
  | 'INSUFFICIENT_HISTORY'
  | 'CHECKED_UNCHANGED'
  | 'CHANGE_DETECTED'
  | 'SOURCE_CHANGED_UNVERIFIED'
  | 'AMENDMENT_MENTIONED';

export interface RegulationRow {
  /** Sections whose WORDING moved. Renumbering is excluded — see change_class. */
  wording_changes?: number;
  changed_at?: string | null;
  id: string; title: string; regulator: string; regulator_short: string;
  regulation_type: string | null; sector: string | null; ministry: string | null;
  issued_on: string | null; status: string | null; ingestion_status: string;
  /** When this row first appeared in THIS system — not when it was issued. */
  added_on: string | null;
  impact_level: string | null; impact_score: number | null;
  source_url: string | null; official_document_url: string | null;
  reference_number: string | null; created_at: string | null;
  page_count: number | null; document_hash: string | null;
  obligations: number; amendments: number;
  /**
   * THIS COMPANY's applicability verdict, materialised onto the row by
   * materialise_applicability.py from the same evaluate() the detail page runs.
   * null means no applicability rule was extracted, which is not "does not apply".
   */
  applicability?: string | null;
}

export interface Provenance {
  source_name: string | null; source_url: string | null; document_url: string | null;
  document_id: string | null; document_hash: string | null; file_size: number | null;
  page_count: number | null; retrieved_at: string | null; last_checked_at: string | null;
  source_verified: number | null; document_downloaded: boolean;
}

export interface ChangeStatus {
  status: ChangeStatusCode; message: string;
  versionsCaptured: number; computedChanges: number;
  amendmentsMentionedInSource: number; canCompare: boolean;
}

export interface RegulationDetail extends Record<string, unknown> {
  id: string; title: string; regulator: string; regulator_short: string;
  provenance: Provenance; changeStatus: ChangeStatus;
  counts: { sections: number; obligations: number; amendments: number };
}

async function get<T>(path: string): Promise<T> {
  return api<T>(path);
}

/**
 * The filter selection. Multi-value filters are arrays; the query string joins
 * them with commas, which is what the backend's _multi() splits on.
 */
export interface RegulationFilters {
  q: string;
  jurisdiction: string;          // All | India | State | Union Territory
  state_ut: string[];
  sector: string[];
  regulator: string[];
  regulation_type: string[];
  collection_status: string[];
  importance: string[];
  applicability: string[];
  source_verification: string;   // '' | Verified | Not Verified
  issued_from: string;
  issued_to: string;
  has_impact: string;
  sort: string;
}

export const EMPTY_FILTERS: RegulationFilters = {
  q: '', jurisdiction: 'All', state_ut: [], sector: [], regulator: [],
  regulation_type: [], collection_status: [], importance: [], applicability: [],
  source_verification: '', issued_from: '', issued_to: '', has_impact: '', sort: 'created',
};

/** Only what is actually set reaches the URL, so a clean page has a clean link. */
export function filtersToParams(f: RegulationFilters): URLSearchParams {
  const qs = new URLSearchParams();
  const put = (k: string, v: string | string[]) => {
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s && s !== 'All') qs.set(k, s);
  };
  put('q', f.q); put('jurisdiction', f.jurisdiction); put('state_ut', f.state_ut);
  put('sector', f.sector); put('regulator', f.regulator);
  put('regulation_type', f.regulation_type); put('collection_status', f.collection_status);
  put('importance', f.importance); put('applicability', f.applicability);
  put('source_verification', f.source_verification);
  put('issued_from', f.issued_from); put('issued_to', f.issued_to);
  if (f.has_impact) qs.set('has_impact', f.has_impact);
  if (f.sort && f.sort !== 'created') qs.set('sort', f.sort);
  return qs;
}

export function paramsToFilters(sp: URLSearchParams): RegulationFilters {
  const arr = (k: string) => (sp.get(k) ? sp.get(k)!.split(',').filter(Boolean) : []);
  return {
    ...EMPTY_FILTERS,
    q: sp.get('q') ?? '',
    jurisdiction: sp.get('jurisdiction') ?? 'All',
    state_ut: arr('state_ut'), sector: arr('sector'), regulator: arr('regulator'),
    regulation_type: arr('regulation_type'), collection_status: arr('collection_status'),
    importance: arr('importance'), applicability: arr('applicability'),
    source_verification: sp.get('source_verification') ?? '',
    issued_from: sp.get('issued_from') ?? '', issued_to: sp.get('issued_to') ?? '',
    has_impact: sp.get('has_impact') ?? '',
    sort: sp.get('sort') ?? 'created',
  };
}

/**
 * The applicability verdicts that mean "this reaches us".
 *
 * CONDITIONAL is included deliberately. The engine only awards APPLICABLE when
 * every mandatory condition has been evaluated, and thresholds are not modelled
 * yet — so a regulation whose entity type, jurisdiction and regulator all match
 * this company still lands on CONDITIONAL. Excluding it would hide the entire
 * set of regulations that demonstrably reach us, which is the opposite of what
 * "show only applicable" is asked to do. Both are shown; the screen says which
 * is which.
 */
export const APPLIES_TO_US: string[] = ['APPLICABLE', 'CONDITIONAL'];

export const isAppliesToUs = (f: RegulationFilters): boolean =>
  f.applicability.length === APPLIES_TO_US.length &&
  APPLIES_TO_US.every((v) => f.applicability.includes(v));

/** The company this installation is configured for — drives the button's wording. */
export const useCompanyProfile = () =>
  useQuery<{ configured: boolean; profile: Record<string, unknown> | null }>({
    queryKey: ['company-profile'],
    queryFn: () => get('/api/company/profile'),
    staleTime: 300_000,
  });

export const useRegulations = (params: { page?: number; size?: number } & Partial<RegulationFilters>) => {
  const qs = filtersToParams({ ...EMPTY_FILTERS, ...params } as RegulationFilters);
  qs.set('page', String(params.page ?? 1));
  qs.set('size', String(params.size ?? 50));
  return useQuery<{ page: number; size: number; total: number; items: RegulationRow[] }>({
    queryKey: ['regulations', qs.toString()],
    queryFn: () => get(`/api/regulations?${qs}`),
    staleTime: 60_000,
  });
};

export interface FacetValue { value: string; count: number; kind?: string }

/** Whether the database can answer a given filter at all. */
export interface FilterAvailability {
  records: number;
  coveragePct: number | null;
  distinctValues: number | null;
  available: boolean;
  note: string | null;
}

export interface RegulationFacets {
  regulators: FacetValue[];
  regulationTypes: FacetValue[];
  sectors: FacetValue[];
  collectionStatuses: FacetValue[];
  /** Same values under their original key — WorkflowStrip reads this. */
  statuses: FacetValue[];
  importance: FacetValue[];
  applicability: FacetValue[];
  regions: FacetValue[];
  allIndiaCount: number;
  scoredForImpact: number;
  matched: number;
  total: number;
  library: {
    discovered: number; withSourceUrl: number;
    documentsExtracted: number; structured: number; mapped: number;
  };
  availability: Record<string, FilterAvailability> & { _total?: number };
  vocabulary: { states: string[]; unionTerritories: string[]; sectors: string[] };
}

/**
 * Counts are computed under the CURRENT selection, so they change as filters
 * are applied — the number beside an option is what pressing it returns.
 */
export const useRegulationFacets = (f?: Partial<RegulationFilters>) => {
  const qs = filtersToParams({ ...EMPTY_FILTERS, ...(f ?? {}) } as RegulationFilters);
  qs.delete('sort');
  return useQuery<RegulationFacets>({
    queryKey: ['regulation-facets', qs.toString()],
    queryFn: () => get(`/api/regulations/facets?${qs}`),
    staleTime: 60_000,
  });
};

/** One regulation, under the ['regulation', id] cache key, which every reader shares. */
export const fetchRegulation = (id: string) =>
  // a reply that is not a regulation (no id) is a regulation that was not found
  get<RegulationDetail>(`/api/regulations/${id}`).then((d) => {
    if (!d || typeof d !== 'object' || !('id' in d) || !d.id) throw new Error('Regulation not found');
    return d;
  });

export const useRegulation = (id: string | undefined) =>
  useQuery<RegulationDetail>({
    queryKey: ['regulation', id], enabled: !!id,
    queryFn: () => fetchRegulation(id!),
  });

export const useRegulationSections = (id: string | undefined) =>
  useQuery<{ items: { id: string; section_number: string; section_title: string; section_text: string }[] }>({
    queryKey: ['regulation-sections', id], queryFn: () => get(`/api/regulations/${id}/sections`), enabled: !!id,
  });

export const useRegulationObligations = (id: string | undefined) =>
  useQuery<{ items: Record<string, unknown>[] }>({
    queryKey: ['regulation-obligations', id], queryFn: () => get(`/api/regulations/${id}/obligations`), enabled: !!id,
  });

/** Amendments the DOCUMENT records — evidence, not a detected change. */
export const useRegulationAmendments = (id: string | undefined) =>
  useQuery<{
    evidenceType: string; note: string; total: number; circulars: number;
    timeline: { reference: string; amendedOn: string; actions: string[]; sections: string[]; sectionCount: number;
      /** link to the amending circular — recovered by the docling extraction pass */
      url?: string | null }[];
    items: { section_number: string; section_title: string; action: string; meaning: string;
      reference: string; amended_on: string; context: string;
      /** link to the amending circular — present once the docling pass has run */
      url?: string | null; extraction_method?: string | null }[];
  }>({
    queryKey: ['regulation-amendments', id], queryFn: () => get(`/api/regulations/${id}/amendments`), enabled: !!id,
  });

/** Computed changes only — empty until two versions have been compared. */
export const useRegulationChanges = (id: string | undefined) =>
  useQuery<ChangeStatus & {
    versions: { id: number; captured_at: string; document_hash: string; page_count: number | null;
                section_count: number | null; source_url: string | null;
                retrieved_from: string | null; retrieved_at: string | null }[];
    wordingChanges: number;
    numberingOnlyChanges: number;
    /** Which two copies this comparison is between — stated once, not per row. */
    comparison: {
      from: { capturedAt: string | null; retrievedAt: string | null;
              retrievedFrom: string | null; documentHash: string | null };
      to:   { capturedAt: string | null; retrievedAt: string | null;
              retrievedFrom: string | null; documentHash: string | null };
      sourceUrl: string | null;
      detectedAt: string | null;
      sectionsChanged: number;
    } | null;
    /** The document as originally ingested, independent of any version. */
    document: { source_url: string | null; document_hash: string | null;
                page_count: number | null; file_size: number | null;
                created_at: string | null } | null;
    items: { section_number: string; change_type: string; change_class: 'WORDING' | 'NUMBERING_ONLY';
             old_text: string; new_text: string; words_added: number; words_removed: number;
             detected_at: string | null;
             from_captured_at: string | null; to_captured_at: string | null;
             from_hash: string | null; to_hash: string | null; source_url: string | null }[];
  }>({
    queryKey: ['regulation-changes', id], queryFn: () => get(`/api/regulations/${id}/changes`), enabled: !!id,
  });

export const useRegulationDocuments = (id: string | undefined) =>
  useQuery<{ items: { id: string; file_name: string; file_size: number; source_url: string; document_hash: string; page_count: number; storage_path: string }[] }>({
    queryKey: ['regulation-documents', id], queryFn: () => get(`/api/regulations/${id}/documents`), enabled: !!id,
  });

export const CHANGE_STATUS_LABEL: Record<ChangeStatusCode, string> = {
  NOT_CHECKED: tx('Not checked'),
  INSUFFICIENT_HISTORY: tx('Insufficient history'),
  CHECKED_UNCHANGED: tx('Checked — unchanged'),
  CHANGE_DETECTED: tx('Change detected'),
  SOURCE_CHANGED_UNVERIFIED: tx('Source changed — content unreadable'),
  AMENDMENT_MENTIONED: tx('Amendment mentioned in source'),
};

/** Tables lifted from the document with their rows intact (docling pass only). */
export interface RegTable {
  table_index: number;
  caption: string | null;
  columns: string[];
  rows: string[][];
  row_count: number;
  col_count: number;
  extraction_method: string;
}
export const useRegulationTables = (id: string | undefined) =>
  useQuery<{ items: RegTable[]; total: number; extracted: boolean; note: string | null }>({
    queryKey: ['reg-tables', id],
    queryFn: () => get(`/api/regulations/${id}/tables`),
    enabled: !!id,
  });

/** Which extractor produced the structure on screen. */
export interface ExtractionRun {
  method: string; ocr_used: number; sections: number; tables: number;
  amendments: number; linked_amendments: number; chars: number; pages: number; ran_at: string;
}
export const useRegulationExtraction = (id: string | undefined) =>
  useQuery<{ runs: ExtractionRun[] }>({
    queryKey: ['reg-extraction', id],
    queryFn: () => get(`/api/regulations/${id}/extraction`),
    enabled: !!id,
  });

// ---------------------------------------------------------------- applicability
export type Verdict = 'APPLICABLE' | 'NOT_APPLICABLE' | 'CONDITIONAL' | 'REVIEW_REQUIRED';
export type CheckResult = 'MATCH' | 'NO_MATCH' | 'UNKNOWN';

export interface ApplicabilityCheck {
  name: string;
  result: CheckResult;
  expected: unknown;
  found: unknown;
  detail: string;
  sourceClause: string | null;
  /** The words the verdict rests on — a clause label alone cannot be audited. */
  clauseText: string | null;
  /** The exact phrase in that clause that was compared against the company. */
  quoted: string | null;
  /** What this check is worth out of 100. The checks are not equal: Entity type 35, Sector 5. */
  weight?: number;
  /** How much of that weight it counts here (half for a licence-only entity match, 0 for a licence counted twice). */
  counts?: number;
  /** gate: can rule the regulation out on its own. support: adds confidence, never decides. */
  tier?: 'gate' | 'support';
  /** Why `counts` is less than `weight`, when it is. */
  weightNote?: string;
}

/** The weighted evidence for "this reaches us". The verdict is decided by the gates, never by this sum. */
export interface ApplicabilityStrength {
  confirmed: number;
  open: number;
  against: number;
  total: number;
  gates: { met: number; total: number };
  support: { met: number; total: number };
  /** checks whose input was never extracted, so they were never run */
  notChecked: string[];
}

export interface ApplicabilityRule {
  id: number | string;
  entity_type: string | null;
  applicability: string | null;
  applicability_rule: string | null;
  source_clause: string | null;
  confidence: number | null;
}

export interface ApplicabilityResponse {
  regulationId: string;
  entityTypes: string[];
  rules: ApplicabilityRule[];
  evaluation: {
    verdict: Verdict;
    confidence: 'High' | 'Medium' | 'Low';
    why: string;
    checks: ApplicabilityCheck[];
    matched: number;
    contradicted: number;
    unknown: number;
    /** absent from engines older than the weighting */
    strength?: ApplicabilityStrength;
    company: Record<string, unknown>;
    method: string;
    limits: string[];
  };
}

export const useRegulationApplicability = (id?: string) =>
  useQuery<ApplicabilityResponse>({
    queryKey: ['reg-applicability', id],
    queryFn: () => get(`/api/regulations/${id}/applicability`),
    enabled: !!id,
  });

export interface RegulationControl {
  id: string; name: string; description: string | null;
  control_type: string | null; frequency: string | null; automated: number | null;
  effectiveness: string | null; last_tested: string | null; next_test_due: string | null;
  owner_name: string | null; entity_name: string | null;
  obligations_covered: number;
}

export const useRegulationControls = (id?: string) =>
  useQuery<{
    items: RegulationControl[];
    obligationsTotal: number;
    obligationsCovered: number;
    obligationsUncovered: number;
  }>({
    queryKey: ['reg-controls', id],
    queryFn: () => get(`/api/regulations/${id}/controls`),
    enabled: !!id,
  });


// ---------------------------------------------------------------- obligations
export interface ObligationRow {
  id: string; title: string; description: string | null;
  obligation_type: string | null; mandatory_action: string | null;
  responsible_entity: string | null; frequency: string | null;
  evidence_required: string | null; source_reference: string | null;
  confidence: number | null; extraction_method: string | null; verified: number | null;
  /** 'duty' = an actionable obligation · 'scope' = title/commencement boilerplate */
  kind: 'duty' | 'scope';
  controls_mapped: number;
  control_name: string | null;
  control_effectiveness: string | null;
  control_owner: string | null;
  controlStatus: 'MAPPED' | 'NOT_MAPPED';
  evidenceStatus: 'STATED' | 'NOT_STATED';
}

export const useRegulationObligationChain = (id?: string) =>
  useQuery<{
    items: ObligationRow[];
    counts: {
      total: number; duties: number; scope: number;
      withControl: number; withoutControl: number;
      evidenceStated: number; verified: number;
    };
    extraction: { method: string; humanVerified: number; note: string };
  }>({
    queryKey: ['reg-obligation-chain', id],
    queryFn: () => get(`/api/regulations/${id}/obligations`),
    enabled: !!id,
  });

// ---------------------------------------------------------------- canonical metrics
/**
 * The single source of every number on the regulation page. Nothing in the UI
 * computes its own count, so a figure can never disagree with the list beneath it.
 */
export interface RegulationMetrics {
  regulationId: string;
  extraction: { sentencesExtracted: number; byKind: Record<string, number>; note: string };
  pipeline: { obligations: number; requirements: number; controls: number; evidence: number };
  coverage: {
    obligationsWithRequirement: number; obligationsWithoutRequirement: number;
    requirementCoveragePct: number;
    requirementsWithControl: number; requirementsWithoutControl: number;
    controlCoveragePct: number;
    evidenceLinked: number; evidenceCoveragePct: number;
  };
  review: { needsReview: number; accepted: number; unreviewed: number };
  change: { versionsCaptured: number; clauseChanges: number; comparable: boolean };
  legacy: { controlObligationLinks: number; note: string };
  gaps: string[];
}

export const useRegulationMetrics = (id?: string) =>
  useQuery<RegulationMetrics>({
    queryKey: ['reg-metrics', id],
    queryFn: () => get(`/api/regulations/${id}/metrics`),
    enabled: !!id,
  });
