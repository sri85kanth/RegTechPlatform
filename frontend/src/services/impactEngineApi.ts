// ============================================================
// Impact Engine + Source Watcher.
//
// Everything the engine returns is a PROPOSAL. The UI must never present it as
// a decision, and must always show which route produced it — a deterministic
// fallback answer and a reasoning-model answer carry very different weight.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

const get = <T,>(p: string): Promise<T> => api<T>(p);
const post = <T,>(p: string): Promise<T> => api<T>(p, { method: 'POST' });

export interface EngineStatus {
  models: { available: boolean; chain: string[]; usable: string[]; missingKeys: string[]; note: string | null };
  memory: { backend: string; mem0Configured: boolean; items: number; note: string };
  confidenceFloor: number;
  edgeCases: Record<string, string>;
  runs: number;
  orchestration: string;
}

export interface ImpactItem {
  entity_id: string;
  obligation_id?: string | null;
  section_number?: string | null;
  impact_type: string;
  severity: string;
  confidence: number;
  rationale: string;
  needs_human_review?: boolean;
  disputed_by_critique?: boolean;
}

export interface ImpactRun {
  regulation_id: string;
  status: string;
  route: 'llm' | 'deterministic' | 'none';
  fallbackReason?: string;
  applicability?: { applies: string; confidence: number; reasoning: string };
  impacts: ImpactItem[];
  actions: { title: string; entity_id: string; action_type: string; priority: string; rationale: string }[];
  critique?: { overall: string; missing_evidence: string[] } | null;
  notes: string[];
  trace?: { stage: string; ok: boolean; model: string; latency_s: number }[];
  validation?: { dropped: { reason: string }[]; hallucinationRate: number };
  disclaimer: string;
  persisted?: { runId: number; proposalsWritten: number };
}

export const useEngineStatus = () =>
  useQuery<EngineStatus>({ queryKey: ['engine-status'], queryFn: () => get('/api/impact-engine/status') });

export const useAnalyse = () => {
  const qc = useQueryClient();
  return useMutation<ImpactRun, Error, string>({
    mutationFn: (rid) => post(`/api/impact-engine/analyse/${rid}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['engine-status'] });
      qc.invalidateQueries({ queryKey: ['actions'] });
    },
  });
};

export const useEvals = () =>
  useMutation<{ passed: number; failed: number; skipped: number; modelKeyPresent: boolean;
                results: { case: string; property: string; result: string; detail: string }[] }, Error, void>({
    mutationFn: () => post('/api/impact-engine/evals'),
  });

/* ---------- runs paused at the human gate ---------- */
export interface PendingImpact {
  entity_id: string;
  obligation_id?: string | null;
  impact_type: string;
  severity: string;
  confidence: number;
  rationale: string;
}
export interface PendingRun {
  run_id: number;
  regulation_id: string;
  thread_id: string;
  pending: PendingImpact[];
  route: string;
  model: string;
  since: string;
}
export type ReviewDecision = { entity_id: string; outcome: 'approve' | 'reject'; note?: string };

export const usePendingRuns = () =>
  useQuery<{ items: PendingRun[] }>({
    queryKey: ['agent-pending'],
    queryFn: () => get('/api/impact-engine/pending'),
    refetchInterval: 30_000,
  });

export const useResumeRun = () => {
  const qc = useQueryClient();
  return useMutation<ImpactRun, Error, { threadId: string; decisions: ReviewDecision[] }>({
    mutationFn: ({ threadId, decisions }) =>
      api<ImpactRun>(`/api/impact-engine/resume/${threadId}`, { method: 'POST', body: JSON.stringify(decisions) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['agent-pending'] });
      qc.invalidateQueries({ queryKey: ['engine-status'] });
      qc.invalidateQueries({ queryKey: ['actions'] });
    },
  });
};

/* ---------- source watcher ---------- */
export interface WatcherStatus {
  totalChecks: number;
  byOutcome: Record<string, number>;
  dueNow: number;
  changesDetected: number;
  recent: { regulation_id: string; checked_at: string; outcome: string; note: string }[];
  note: string;
}
export const useWatcherStatus = () =>
  useQuery<WatcherStatus>({ queryKey: ['watcher'], queryFn: () => get('/api/watcher/status') });

export const useCheckSource = () => {
  const qc = useQueryClient();
  return useMutation<{ outcome: string; detail: string }, Error, string>({
    mutationFn: (rid) => post(`/api/watcher/check/${rid}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['watcher'] }),
  });
};
