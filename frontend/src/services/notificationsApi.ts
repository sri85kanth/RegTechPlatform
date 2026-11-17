// ============================================================
// Notifications.
//
// Every item here is derived from a real event — a source that changed, work
// that slipped its date, a proposal waiting on a human. There is no
// "engagement" content, so an empty inbox genuinely means nothing happened.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface Notification {
  id: number;
  // owner_impact: a regulation changed and reached records this owner looks after;
  // ops: the server's own health; discovery: a new item on a watched source (a lead,
  // not yet a regulation); enforcement: a penalty a regulator imposed
  kind: 'source_changed' | 'owner_impact' | 'action_overdue' | 'action_assigned' | 'awaiting_review'
    | 'ops' | 'discovery' | 'enforcement' | (string & {});
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  regulation_id: string | null;
  action_id: number | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
  /** the regulation it is about, joined by the list endpoint (absent from older servers) */
  regulation_title?: string | null;
  regulator_short?: string | null;
  regulation_applicability?: string | null;
}

export const useNotifications = (unreadOnly = false, enabled = true, limit = 50) =>
  useQuery<{ items: Notification[]; unread: number }>({
    queryKey: ['notifications', unreadOnly, limit],
    // the server lists critical before the rest, so a short page can hide newer news
    queryFn: () => api(`/api/notifications?unread_only=${unreadOnly}&limit=${limit}`),
    refetchInterval: 60_000,   // a change detected while the tab is open should surface
    enabled,                   // an external auditor has no inbox
  });

export const useUnreadCount = (enabled = true) =>
  useQuery<{ unread: number }>({
    queryKey: ['notif-count'],
    queryFn: () => api('/api/notifications/count'),
    refetchInterval: 60_000,
    enabled,
  });

function useNotifMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({
    mutationFn: fn,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notif-count'] });
    },
  });
}

export const useMarkRead = () =>
  useNotifMutation((ids?: number[]) =>
    api<{ marked: number }>('/api/notifications/read', {
      method: 'POST', body: JSON.stringify({ ids: ids ?? null }),
    }));

export const useDismiss = () =>
  useNotifMutation((id: number) =>
    api<{ dismissed: number }>(`/api/notifications/${id}/dismiss`, { method: 'POST' }));

/** Dismiss several at once — one change that reached several owners is one card. */
export const useDismissMany = () =>
  useNotifMutation((ids: number[]) =>
    Promise.all(ids.map((id) => api<{ dismissed: number }>(`/api/notifications/${id}/dismiss`, { method: 'POST' }))));
