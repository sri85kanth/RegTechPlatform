// ============================================================
// Risk review — the register the rules build, and what people decide about it
// (design §7 gates G3–G9). Backend: scraper/regulatory_ingestion/api_risk.py
// (register, tasks, questions, rulebook routes) and risk/review.py.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';
import type { Band } from '@/services/riskApi';

export type Gate = 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';
export type Verdict = 'WITHIN_APPETITE' | 'TREAT' | 'ESCALATE' | 'INSUFFICIENT_EVIDENCE' | 'REVIEW_REQUIRED';
export type Lifecycle = 'IDENTIFIED' | 'ASSESSED' | 'IN_TREATMENT' | 'ACCEPTED' | 'CLOSED' | 'RETIRED';
export type Treatment = 'ACCEPT' | 'AVOID' | 'MITIGATE' | 'TRANSFER' | 'ESCALATE';
export type Grade = 'ABSENT' | 'CLAIMED' | 'DOCUMENTED' | 'TESTED';
export type Priority = 'P0' | 'P1' | 'P2';

export interface RegisterRow {
  id: string; title: string; theme: string | null; site_id: string | null; template_id: string | null;
  /** template:<id>@<site> (the risk library), obligation:<theme>@org (the regulations that apply), custom:<id> */
  group_key: string;
  origin: 'derived' | 'imported' | 'manual'; lifecycle: Lifecycle;
  owner_user: string | null; owner_name: string | null;
  assessment_id: string | null; seq: number | null; verdict: Verdict | null;
  inherent_band: Band | null; residual_band: Band | null; target_band: Band | null;
  confidence: number | null; provisional: number | null; assessed_at: string | null;
  effective_verdict: Verdict | null; effective_residual: Band | null; overridden: string[]; open_tasks: number;
}
export interface QueueSummary { open: number; overdue: number; urgent: number; byGate: Partial<Record<Gate, number>> }
export interface RegisterData {
  items: RegisterRow[]; queue: QueueSummary; appetite: boolean;
  /** risks that cannot be scored until their controls are known */
  controls: { risks: number; waitingOnControls: number };
  rulebook: { name: string; version: string; hash: string; published: boolean };
}

export interface ReviewTask {
  id: string; gate: Gate; reason_code: string; reason: string; risk_id: string | null;
  /** the facts behind `reason`, for the screen to word in the reader's language */
  detail: Record<string, unknown> | null;
  subject_kind: 'risk' | 'exposure' | 'control' | 'assessment' | 'override' | 'rulebook'; subject_id: string;
  assignee_user: string | null; assignee_role: string | null; priority: Priority; due_at: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED'; decision: string | null; note: string | null;
  decided_by: string | null; decided_at: string | null; created_by: string; created_at: string;
  risk_title?: string | null; risk_theme?: string | null; verdict?: Verdict | null; residual_band?: Band | null;
}

export interface Point { impact: number; likelihood: number; product: number; band: Band }
export interface MissingInput { fact: string; mandatory: boolean; exposures: string[] }
export interface AssessmentResult {
  verdict: Verdict; verdict_rule: string; verdict_reason: string; floor_verdict: Verdict | null;
  category: string | null; inherent: Point | null; residual: Point | null; target: Point | null;
  provisional: boolean; confidence: { score: number; band: 'LOW' | 'MEDIUM' | 'HIGH'; deductions: Record<string, number> };
  bounds: { best: Point | null; worst: Point | null }; missing: MissingInput[]; rationale: string;
  /** set when the stored result keeps only the driver and the worst exposures */
  exposures_total?: number;
  appetite: { category: string; appetite: Band; tolerance: Band; zero_tolerance: boolean } | null;
  driver: string | null;
  exposures: { id: string; impact: { driving_dimension: string }; controls: { grade: string } }[];
  rulebook: { name: string; version: string; hash: string };
}
export interface Assessment {
  id: string; seq: number; verdict: Verdict; inherent_band: Band | null; residual_band: Band | null;
  target_band: Band | null; confidence: number; provisional: number; recorded_at: string; trigger: string | null;
  result: AssessmentResult; diff: Record<string, [unknown, unknown]> | null;
}
export interface Exposure {
  id: string; exposure_key: string; kind: string; label: string | null; node_ref: string | null; active: number;
  regulation_id: string | null; requirement_id: string | null;
  engine_applicability: string | null; decided_applicability: 'APPLICABLE' | 'NOT_APPLICABLE' | null;
  decision_reason: string | null; decided_by: string | null; missing: string[];
}
export interface ControlRating {
  id: string; control_key: string; label: string; kind: string; grade: Grade; evidence: string | null;
  evidence_on: string | null; interval_days: number | null; note: string | null; rated_by: string;
  /** person, workbook, or control:<id> / entity:<id> when mapped from the company's own records */
  source: string;
  rated_by_user: string | null; validated_by: string | null; recorded_at: string;
}
export interface Override {
  id: string; field: 'residual_band' | 'verdict'; computed_value: string; override_value: string;
  direction: 'raise' | 'lower'; reason: string; evidence: string | null; proposed_by: string;
  proposed_by_user: string | null; second_by: string | null;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'STALE' | 'REVOKED'; note: string | null; created_at: string;
}
export interface TreatmentDecision {
  id: string; decision: Treatment; rationale: string; decider_name: string; decider_designation: string;
  accept_until: string | null; transfer_to: string | null; instrument: string | null;
  action_ids: { id: number; kind: string }[]; status: 'ACTIVE' | 'SUPERSEDED' | 'EXPIRED'; created_at: string;
}
export interface RiskEvent { id: string; kind: string; actor: string; detail: string | null; at: string }
export interface RiskDetail {
  risk: RegisterRow & { description: string | null; created_at: string };
  assessment: Assessment | null;
  /** an obligation risk: the duty that drives it, its regulation, clause and statutory ceiling */
  driver: { label: string; regulationId: string | null; regulation: string | null; clause: string | null;
            penaltyInr: number | null; imprisonment: boolean; inheritedFrom: string | null; consequence: string[] } | null;
  /** the exposures list is a first page: these are the totals */
  exposureCounts: { total: number; pending: number; regulations: number; shown: number };
  effective: { verdict: Verdict | null; residual_band: Band | null; floor_verdict?: Verdict | null; overridden: string[] };
  history: { seq: number; verdict: Verdict; residual_band: Band | null; confidence: number; diff: Record<string, [unknown, unknown]> | null; trigger: string | null; recorded_at: string }[];
  exposures: Exposure[];
  controls: { typical: { key: string; text: string; interval_days: number | null }[]; ratings: ControlRating[] };
  template: { id: string; title: string; consequence: string | null; division: string | null; risk_type: string | null } | null;
  overrides: Override[];
  treatments: TreatmentDecision[];
  actions: { id: number; title: string; status: string; due_date: string | null; priority: string }[];
  tasks: ReviewTask[];
  events: RiskEvent[];
}

export interface Question {
  key: string; question: string; value: boolean | number | null;
  source: 'answered' | 'records' | null; answeredBy: string | null; answeredAt: string | null; waiting: number;
}
export interface Publication {
  id: string; rulebook: string; version: string; rulebook_hash: string;
  status: 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'SUPERSEDED';
  diff: { risks: number; verdictChanges: number; changes: { risk: string; title: string; before: Verdict | null; after: Verdict }[];
          topMovers: { risk: string; title: string; before: Band; after: Band; move: number }[] } | null;
  requested_by: string; admin_by: string | null; governor_by: string | null; note: string | null;
  created_at: string; decided_at: string | null;
}
export interface PublicationState {
  rulebook: { name: string; version: string; hash: string; chain: string[] };
  published: Publication | null; pending: Publication | null; current: boolean; history: Publication[];
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const useRegister = () =>
  useQuery<RegisterData>({ queryKey: ['risk', 'register'], queryFn: () => api('/api/risk/register') });

export const useRiskDetail = (id: string | null) =>
  useQuery<RiskDetail>({ queryKey: ['risk', 'register', id], queryFn: () => api(`/api/risk/register/${id}`), enabled: !!id });

export const useTasks = (mine: boolean, gate: Gate | null) =>
  useQuery<{ items: ReviewTask[]; summary: QueueSummary }>({
    queryKey: ['risk', 'tasks', mine, gate],
    queryFn: () => api(`/api/risk/tasks?mine=${mine}${gate ? `&gate=${gate}` : ''}`),
  });

export const useQuestions = () =>
  // possible: distinct possible risks waiting on any answer (absent from servers before it was added)
  useQuery<{ items: Question[]; possible?: number }>({ queryKey: ['risk', 'questions'], queryFn: () => api('/api/risk/questions') });

export const usePublication = () =>
  useQuery<PublicationState>({ queryKey: ['risk', 'rulebook'], queryFn: () => api('/api/risk/rulebook') });

/** Every decision can move scores, tasks and the register: refresh all of risk. */
function useReviewMutation<A, R = unknown>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({ mutationFn: fn, onSuccess: () => { qc.invalidateQueries({ queryKey: ['risk'] }); } });
}

export const useRunRegister = () =>
  useReviewMutation<void, { created: number; retired: number; assessed: number; changed: number }>(() =>
    api('/api/risk/register/run', { method: 'POST' }));

export const useAddRisk = () =>
  useReviewMutation<{ title: string; theme: string; description?: string; seeds: Record<string, number>; base_likelihood: string },
    RegisterRow>((b) => api('/api/risk/register', { method: 'POST', ...json(b) }));

export const useSetOwner = () =>
  useReviewMutation<{ id: string; userId: string | null; name: string | null }>(({ id, ...b }) =>
    api(`/api/risk/register/${id}/owner`, { method: 'PUT', ...json(b) }));

export const useRecordControl = () =>
  useReviewMutation<{ id: string; control_key?: string; label: string; kind?: string; grade: Grade; evidence?: string;
    evidence_on?: string; interval_days?: number | null; note?: string }, ControlRating>(({ id, ...b }) =>
    api(`/api/risk/register/${id}/controls`, { method: 'POST', ...json(b) }));

export const useValidateControl = () =>
  useReviewMutation<{ ratingId: string; grade: Grade; evidence?: string; evidenceOn?: string; note?: string }>(({ ratingId, ...b }) =>
    api(`/api/risk/controls/${ratingId}/validate`, { method: 'POST', ...json(b) }));

export interface TreatmentInput {
  decision: Treatment; rationale: string; name: string; designation: string; acceptUntil?: string;
  transferTo?: string; instrument?: string; actions?: { title: string; dueDate?: string; kind: string }[];
}
export const useDecideTreatment = () =>
  useReviewMutation<{ id: string } & TreatmentInput, TreatmentDecision>(({ id, ...b }) =>
    api(`/api/risk/register/${id}/treatment`, { method: 'POST', ...json(b) }));

export const useProposeOverride = () =>
  useReviewMutation<{ id: string; field: 'residual_band' | 'verdict'; value: string; reason: string; evidence?: string }, Override>(
    ({ id, ...b }) => api(`/api/risk/register/${id}/overrides`, { method: 'POST', ...json(b) }));

export const useDecideOverride = () =>
  useReviewMutation<{ id: string; approve: boolean; note?: string }, Override>(({ id, ...b }) =>
    api(`/api/risk/overrides/${id}/decide`, { method: 'POST', ...json(b) }));

export const useRevokeOverride = () =>
  useReviewMutation<{ id: string; note?: string }, Override>(({ id, ...b }) =>
    api(`/api/risk/overrides/${id}/revoke`, { method: 'POST', ...json(b) }));

export const useDecideExposure = () =>
  useReviewMutation<{ id: string; decision: 'APPLICABLE' | 'NOT_APPLICABLE'; reason: string }>(({ id, ...b }) =>
    api(`/api/risk/exposures/${id}/decide`, { method: 'POST', ...json(b) }));

export const useTriage = () =>
  useReviewMutation<{ id: string; decision: 'ACCEPT' | 'DISMISS' | 'MERGE'; reason: string; mergeInto?: string }>(({ id, ...b }) =>
    api(`/api/risk/register/${id}/triage`, { method: 'POST', ...json(b) }));

export const useAnswerQuestion = () =>
  useReviewMutation<{ key: string; value: boolean | number | null; note?: string }, { items: Question[]; possible?: number }>(({ key, ...b }) =>
    api(`/api/risk/questions/${key}`, { method: 'PUT', ...json(b) }));

export const useAcknowledge = () =>
  useReviewMutation<{ id: string; note?: string; escalate?: boolean }, ReviewTask>(({ id, ...b }) =>
    api(`/api/risk/tasks/${id}/acknowledge`, { method: 'POST', ...json(b) }));

export const useRequestPublication = () =>
  useReviewMutation<void, PublicationState>(() => api('/api/risk/rulebook/publish', { method: 'POST' }));

export const useDecidePublication = () =>
  useReviewMutation<{ id: string; approve: boolean; note?: string }, PublicationState>(({ id, ...b }) =>
    api(`/api/risk/rulebook/publish/${id}/decide`, { method: 'POST', ...json(b) }));

// ------------------------------------------------------------------ controls in bulk
export interface ControlMatch {
  riskId: string; riskTitle: string; controlKey: string; control: string;
  sourceId: string; sourceName: string; strength: 'strong' | 'possible'; score: number; shared: string[];
  grade: Grade; evidence: string | null; evidence_on: string | null; why: string;
}
export interface ImportRow {
  row: number; riskId: string; risk: string; control: string; controlKey: string | null; grade?: Grade;
  status: 'ready' | 'unchanged' | 'skipped' | 'problem'; message?: string;
}
export interface ImportCheck {
  rows: ImportRow[]; counts: { ready: number; unchanged: number; skipped: number; problem: number };
  applied?: number; rescored?: number;
}

export const useControlMatches = () =>
  useQuery<{ existing: number; unknownControls: number; items: ControlMatch[] }>({
    queryKey: ['risk', 'control-matches'], queryFn: () => api('/api/risk/controls/matches') });

export const useApplyMatches = () =>
  useReviewMutation<{ items: Pick<ControlMatch, 'riskId' | 'controlKey' | 'sourceId'>[] },
    { applied: number; rescored: number; problems: (ControlMatch & { message: string })[] }>((b) =>
    api('/api/risk/controls/matches/apply', { method: 'POST', ...json(b) }));

/** Check a filled workbook without writing anything. */
export const useCheckWorkbook = () =>
  useMutation<ImportCheck, Error, { fileName: string; content: string }>({
    mutationFn: (b) => api('/api/risk/controls/import', { method: 'POST', ...json({ ...b, apply: false }) }) });

export const useApplyWorkbook = () =>
  useReviewMutation<{ fileName: string; content: string }, ImportCheck>((b) =>
    api('/api/risk/controls/import', { method: 'POST', ...json({ ...b, apply: true }) }));

/** G3: the theme of a regulation the rulebook cannot place; the register is rebuilt so its duties move. */
export const useAssignTheme = () =>
  useReviewMutation<{ regulationId: string; theme: string; note?: string }>(({ regulationId, ...b }) =>
    api(`/api/risk/themes/${encodeURIComponent(regulationId)}`, { method: 'PUT', ...json(b) }));
