// ============================================================
// Risk inputs — what risk scoring needs to know about the company, leadership's
// risk appetite (gate G1) and the facts waiting for a person (gate G2).
// Backend: scraper/regulatory_ingestion/api_risk.py. Design: docs/risk-module-design.md §6–§7.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

export type RecordKind = 'sites' | 'licences' | 'third_parties' | 'history';
export type Band = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Category = 'regulatory' | 'safety' | 'data' | 'operational' | 'financial' | 'reputational';

export interface RiskMeta {
  pack: { name: string; version: string; hash: string; chain: string[] };
  historyKinds: string[];
  attestable: string[];
  criticality: string[];
  outcomes: string[];
  bands: Band[];
  categories: Category[];
  themes: { id: string; name: string }[];
  scaleMetrics: string[];
  historyWindowMonths: number;
  /** the rulebook's band matrix, rows impact "1".."5", each 5 bands for likelihood 1..5 */
  matrix: Record<string, Band[]>;
}

export interface ReadinessItem {
  key: 'sites' | 'scale' | 'history' | 'appetite' | 'licences' | 'third_parties' | 'facts';
  mandatory: boolean;
  done: boolean;
  count?: number;
  of?: number;
  metric?: string | null;
  missing?: string[];
  version?: number | null;
  draft?: string | null;
  unlocks: string;
}
export interface Readiness {
  pack: string;
  ready: boolean;
  items: ReadinessItem[];
  history: Record<string, { status: 'records' | 'attested' | null; count?: number; by?: string; on?: string; months?: number }>;
}

/** One record of any kind; the fields present depend on the kind. */
export interface IntakeRecord {
  id: string;
  status: 'PROPOSED' | 'CONFIRMED';
  source: string | null;
  fact_id: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
  [field: string]: unknown;
}

export interface Attestation {
  id: string; kind: string; months: number; site_id: string | null; statement: string;
  attested_by_name: string; designation: string; attested_on: string; recorded_at: string;
}

export interface AppetiteContent {
  categories: Record<Category, { appetite: Band; tolerance: Band; zero_tolerance: boolean }>;
  confidence_threshold: number;
  review_cadence_days: Record<Band, number>;
  escalation_to: string;
  matrix: Record<string, Band[]> | null;
}
export interface AppetiteVersion {
  id: string; version: number; status: 'DRAFT' | 'APPROVED' | 'RETURNED' | 'SUPERSEDED';
  content: AppetiteContent; note: string | null; created_by: string | null;
  approver_name: string | null; approver_designation: string | null;
  valid_from: string | null; valid_to: string | null; recorded_at: string;
}
export interface AppetiteState {
  approved: AppetiteVersion | null;
  draft: AppetiteVersion | null;
  history: AppetiteVersion[];
  default: AppetiteContent;
  canGovern: boolean;
  governors: { user_id: string; designation: string | null; granted_by: string; granted_at: string }[];
}

export interface Fact {
  id: string;
  fact_key: 'site' | 'licence' | 'third_party' | 'history' | 'profile.beds';
  value: Record<string, unknown>;
  corrected_value: Record<string, unknown> | null;
  status: 'PROPOSED' | 'CONFIRMED' | 'CORRECTED' | 'REJECTED';
  extracted_by: string;
  confidence: number | null;
  note: string | null;
  created_at: string;
  citations: { document_id: string | null; file_name: string | null; page: number | null; section: string | null; quote: string | null }[];
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const useRiskMeta = () =>
  useQuery<RiskMeta>({ queryKey: ['risk', 'meta'], queryFn: () => api('/api/risk/meta'), staleTime: 5 * 60_000 });

export const useReadiness = () =>
  useQuery<Readiness>({ queryKey: ['risk', 'readiness'], queryFn: () => api('/api/risk/readiness') });

export const useRecords = (kind: RecordKind) =>
  useQuery<{ items: IntakeRecord[] }>({ queryKey: ['risk', 'records', kind], queryFn: () => api(`/api/risk/records/${kind}`) });

export const useAttestations = () =>
  useQuery<{ items: Attestation[]; coverage: Readiness['history'] }>({
    queryKey: ['risk', 'attestations'], queryFn: () => api('/api/risk/attestations') });

export const useAppetite = () =>
  useQuery<AppetiteState>({ queryKey: ['risk', 'appetite'], queryFn: () => api('/api/risk/appetite') });

export const useFacts = (status: 'PROPOSED' | 'ALL' = 'PROPOSED') =>
  useQuery<{ items: Fact[] }>({ queryKey: ['risk', 'facts', status], queryFn: () => api(`/api/risk/facts?status=${status}`) });

/** Every write refreshes every risk-input view: readiness depends on all of them. */
function useRiskMutation<A, R = unknown>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({
    mutationFn: fn,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['risk'] }); },
  });
}

export const useSaveRecord = (kind: RecordKind) =>
  useRiskMutation<{ id?: string; data: Record<string, unknown> }, IntakeRecord>(({ id, data }) =>
    id ? api(`/api/risk/records/${kind}/${id}`, { method: 'PATCH', ...json(data) })
       : api(`/api/risk/records/${kind}`, { method: 'POST', ...json(data) }));

export const useRetireRecord = (kind: RecordKind) =>
  useRiskMutation<string, IntakeRecord>((id) => api(`/api/risk/records/${kind}/${id}`, { method: 'DELETE' }));

export const useAttest = () =>
  useRiskMutation<{ kind: string; months: number; name: string; designation: string; statement?: string; siteId?: string },
    Attestation>((b) => api('/api/risk/attestations', { method: 'POST', ...json(b) }));

export const useSaveAppetiteDraft = () =>
  useRiskMutation<AppetiteContent, AppetiteState>((c) => api('/api/risk/appetite/draft', { method: 'PUT', ...json(c) }));

export const useApproveAppetite = () =>
  useRiskMutation<{ approverName: string; designation: string; note?: string }, AppetiteState>((b) =>
    api('/api/risk/appetite/approve', { method: 'POST', ...json(b) }));

export const useReturnAppetite = () =>
  useRiskMutation<{ note: string }, AppetiteState>((b) => api('/api/risk/appetite/return', { method: 'POST', ...json(b) }));

export const useGrantGovernor = () =>
  useRiskMutation<{ userId: string; designation?: string }>((b) => api('/api/risk/governors', { method: 'POST', ...json(b) }));

export const useRevokeGovernor = () =>
  useRiskMutation<string>((id) => api(`/api/risk/governors/${encodeURIComponent(id)}`, { method: 'DELETE' }));

export const useProposeFacts = () =>
  useRiskMutation<void, { proposed: number; skipped: number }>(() => api('/api/risk/facts/propose', { method: 'POST' }));

export const useDecideFact = () =>
  useRiskMutation<{ id: string; decision: 'confirm' | 'correct' | 'reject'; value?: Record<string, unknown>; note?: string }, Fact>(
    ({ id, ...b }) => api(`/api/risk/facts/${id}/decide`, { method: 'POST', ...json(b) }));
