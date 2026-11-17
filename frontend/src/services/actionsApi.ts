// ============================================================
// Actions / CAPA — the work that closes the loop on a regulatory change.
//
//   change → impact proposed → ACTION (owned, dated) → evidence → closed
//
// Transitions are validated server-side. This client never assumes a move is
// legal; it asks, and renders the refusal when the lifecycle forbids it.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

export type ActionStatus =
  | 'Proposed' | 'Open' | 'In Progress' | 'Blocked' | 'Done' | 'Rejected' | 'Cancelled';

export interface ActionRow {
  id: number;
  title: string;
  description: string | null;
  action_type: string | null;
  priority: 'P0' | 'P1' | 'P2';
  status: ActionStatus;
  regulation_id: string | null;
  regulation_title: string | null;
  obligation_id: string | null;
  entity_id: string | null;
  entity_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  evidence_id: string | null;
  evidence_name: string | null;
  due_date: string | null;
  closure_note: string | null;
  source: string | null;
  created_at: string;
  closed_at: string | null;
  allowedTransitions?: string[];
  events?: { from_status: string | null; to_status: string; note: string; actor: string; at: string }[];
}

export interface ActionStats {
  byStatus: Record<string, number>;
  total: number;
  open: number;
  awaitingAcceptance: number;
  overdue: number;
  unowned: number;
}

const get = <T,>(p: string): Promise<T> => api<T>(p);
const send = <T,>(p: string, method: string, body?: unknown): Promise<T> =>
  api<T>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const useActions = (f: { status?: string; regulation_id?: string; overdue?: boolean } = {}) =>
  useQuery<{ items: ActionRow[]; stats: ActionStats; statuses: ActionStatus[] }>({
    queryKey: ['actions', f],
    queryFn: () => {
      const p = new URLSearchParams();
      if (f.status) p.set('status', f.status);
      if (f.regulation_id) p.set('regulation_id', f.regulation_id);
      if (f.overdue) p.set('overdue', 'true');
      return get(`/api/actions?${p}`);
    },
  });

export const useAction = (id: number | null) =>
  useQuery<ActionRow>({ queryKey: ['action', id], queryFn: () => get(`/api/actions/${id}`), enabled: !!id });

function useMutating<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({
    mutationFn: fn,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['actions'] });
      qc.invalidateQueries({ queryKey: ['action'] });
    },
  });
}

export const useTransition = () =>
  useMutating((a: { id: number; to: string; actor: string; note?: string;
                    evidence_id?: string; owner_id?: string; due_date?: string }) =>
    send<ActionRow>(`/api/actions/${a.id}/transition`, 'POST', a));

export const useCreateAction = () =>
  useMutating((a: Record<string, unknown>) => send<ActionRow>('/api/actions', 'POST', a));

export const useActionsFromRun = () =>
  useMutating((runId: number) => send<{ created: number[]; skipped: unknown[] }>(`/api/actions/from-run/${runId}`, 'POST'));

export const STATUS_TONE: Record<ActionStatus, string> = {
  Proposed: 'bg-warning-50 text-warning-600',
  Open: 'bg-brand-50 text-brand-600',
  'In Progress': 'bg-brand-50 text-brand-600',
  Blocked: 'bg-critical-50 text-critical-600',
  Done: 'bg-success-50 text-success-600',
  Rejected: 'bg-slate-100 text-slate-600',
  Cancelled: 'bg-slate-100 text-slate-600',
};
