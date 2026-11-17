// ============================================================
// External auditors: what the hospital shares with each one (/api/auditor).
//
// An auditor account sees only its own shares — the impact cascade of the
// shared regulations and the shared documents. Compliance managers and admins
// manage the shares; every share, revocation and auditor download is logged.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_BASE, authHeaders } from '@/services/http';
import { downloadFile } from '@/modules/cascade/remediationApi';
import { currentDateLocale } from '@/i18n';

export type ShareKind = 'regulation' | 'document' | 'file';

export interface Share {
  id: string; kind: ShareKind; ref: string; title: string; note: string | null;
  file_name: string | null; file_size: number | null; content_type: string | null;
  shared_by_name: string | null; shared_at: string; expires_at: string | null; revoked_at: string | null;
  /** documents and files: whether the file is on this server */
  available?: boolean;
}

export interface SharedRegulation extends Share {
  regulation: { id: string; title: string; short_title: string | null; regulator: string; applicable: number; unmet: number } | null;
}

export interface SharedWithMe {
  auditor: { id: string; name: string; email: string };
  company: string | null;
  regulations: SharedRegulation[];
  documents: Share[];
  preview: boolean;
}

export interface AuditorRow {
  id: string; name: string; email: string; active: number; last_login_at: string | null; created_at: string;
  regulations: number; documents: number; pending: number;
}

/** What an auditor asked for: a regulation's cascade, the documents behind one obligation, or anything else. */
export type RequestKind = 'regulation' | 'document' | 'other';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
export interface AuditorRequest {
  id: string; auditor_id: string; kind: RequestKind; ref: string | null; title: string; message: string | null;
  status: RequestStatus; created_at: string; decided_at: string | null; decided_by_name: string | null;
  decision_note: string | null; share_id: string | null;
  context: {
    regulation_id?: string; regulator?: string; item_code?: string; obligation?: string;
    codes?: string[]; files?: { id: string; name: string; file: string }[];
    /** a regulation the auditor named that the hospital's library did not have */
    not_in_library?: boolean; reference?: string;
  };
  auditor_name?: string; auditor_email?: string;
  /** staff only, for a not-in-library request: regulations in the library now that look like it */
  suggestions?: LibraryMatch[];
}
export interface LibraryMatch { id: string; title: string; regulator: string; added: string | null; ready: boolean; score: number }
export interface CatalogueItem { id: string; title: string; regulator: string; shared: boolean; requested: boolean }

export interface AuditorOverview {
  auditors: AuditorRow[];
  regulations: { id: string; title: string; short_title: string | null; regulator: string; applicable: number; unmet: number }[];
  documents: { id: string; name: string; kind: string | null; document_type: string | null; status: string | null;
               source: string | null; version: string | null; uploaded_at: string | null; available: boolean }[];
  limits: { maxUploadMb: number; types: string[] };
}

export interface AuditorActivity {
  action: string; entity_id: string; actor: string; at: string;
  detail: Record<string, unknown> | string;
}

export interface AuditorDetail {
  auditor: { id: string; name: string; email: string; active: number; last_login_at: string | null; created_at: string };
  shares: Share[];
  activity: AuditorActivity[];
  requests: AuditorRequest[];
}

/** The calling auditor's shares — or, for a compliance manager, a preview of one auditor's view. */
export const useSharedWithMe = (previewId?: string) =>
  useQuery<SharedWithMe>({
    queryKey: ['auditor', 'shared', previewId ?? 'me'],
    queryFn: () => api<SharedWithMe>(`/api/auditor/shared${previewId ? `?auditor_id=${encodeURIComponent(previewId)}` : ''}`)
      // the page counts and lists both; a reply missing either reads as nothing shared, not a crash
      .then((d) => ({ ...d, regulations: d?.regulations ?? [], documents: d?.documents ?? [] })),
    staleTime: 30_000,
  });

export const downloadShare = (share: Pick<Share, 'id' | 'file_name' | 'title'>) =>
  downloadFile(`/api/auditor/shared/${encodeURIComponent(share.id)}/download`, {}, share.file_name ?? share.title);

export const useAuditorOverview = (enabled = true) =>
  useQuery<AuditorOverview>({ queryKey: ['auditor', 'overview'], queryFn: () => api('/api/auditor/admin/overview'), enabled });

export const useAuditorDetail = (uid: string | null) =>
  useQuery<AuditorDetail>({
    queryKey: ['auditor', 'detail', uid], enabled: !!uid,
    queryFn: () => api(`/api/auditor/admin/auditors/${encodeURIComponent(uid!)}`),
  });

const useRefresh = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['auditor'] });
};

export const useShare = () => {
  const refresh = useRefresh();
  return useMutation<{ created: number; skipped_already_shared: number }, Error,
    { uid: string; kind: 'regulation' | 'document'; refs: string[]; note?: string; expires_on?: string }>({
    mutationFn: ({ uid, ...body }) =>
      api(`/api/auditor/admin/auditors/${encodeURIComponent(uid)}/shares`, { method: 'POST', body: JSON.stringify(body) }),
    onSettled: refresh,
  });
};

/** A file sent to one auditor only. Multipart, so it does not go through api(), which sends JSON. */
export const useUploadForAuditor = () => {
  const refresh = useRefresh();
  return useMutation<{ id: string; file_name: string; file_size: number }, Error,
    { uid: string; file: File; note?: string; expires_on?: string }>({
    mutationFn: async ({ uid, file, note, expires_on }) => {
      const fd = new FormData();
      fd.append('file', file);
      if (note) fd.append('note', note);
      if (expires_on) fd.append('expires_on', expires_on);
      const headers = authHeaders();
      const res = await fetch(`${API_BASE}/api/auditor/admin/auditors/${encodeURIComponent(uid)}/files`,
        { method: 'POST', body: fd, headers });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail ?? detail; } catch { /* keep status */ }
        throw new Error(String(detail));
      }
      return res.json();
    },
    onSettled: refresh,
  });
};

export const useRevokeShare = () => {
  const refresh = useRefresh();
  return useMutation<unknown, Error, string>({
    mutationFn: (sid) => api(`/api/auditor/admin/shares/${encodeURIComponent(sid)}/revoke`, { method: 'POST' }),
    onSettled: refresh,
  });
};

/* ---------------- the auditor asks ---------------- */

/** Regulations the auditor may ask for (title and regulator), once two letters are typed. */
export const useCatalogue = (q: string) =>
  useQuery<{ items: CatalogueItem[]; more?: number; note?: string }>({
    queryKey: ['auditor', 'catalogue', q], enabled: q.trim().length >= 2,
    queryFn: () => api(`/api/auditor/catalogue?q=${encodeURIComponent(q.trim())}`), staleTime: 30_000,
  });

export const useMyRequests = (enabled = true) =>
  useQuery<{ items: AuditorRequest[] }>({ queryKey: ['auditor', 'my-requests'], queryFn: () => api('/api/auditor/requests'), enabled, staleTime: 15_000 });

export const useMakeRequest = () => {
  const refresh = useRefresh();
  return useMutation<AuditorRequest, Error, {
    kind: RequestKind; ref?: string; title?: string; message?: string; regulator?: string; reference?: string;
  }>({
    mutationFn: (body) => api('/api/auditor/requests', { method: 'POST', body: JSON.stringify(body) }),
    onSettled: refresh,
  });
};

export const useWithdrawRequest = () => {
  const refresh = useRefresh();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => api(`/api/auditor/requests/${encodeURIComponent(id)}/withdraw`, { method: 'POST' }),
    onSettled: refresh,
  });
};

/* ---------------- the hospital decides ---------------- */

export const usePendingRequests = (enabled: boolean) =>
  useQuery<{ pending: number }>({ queryKey: ['auditor', 'pending'], queryFn: () => api('/api/auditor/admin/pending'), enabled, staleTime: 60_000, refetchInterval: 120_000 });

export const useDecideRequest = () => {
  const refresh = useRefresh();
  return useMutation<unknown, Error, {
    id: string; decision: 'approve' | 'decline'; note?: string; expires_on?: string; regulation_id?: string;
  }>({
    mutationFn: ({ id, decision, ...body }) =>
      api(`/api/auditor/admin/requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: JSON.stringify(body) }),
    onSettled: refresh,
  });
};

export const REQUEST_STATUS: Record<RequestStatus, { label: string; cls: string }> = {
  PENDING: { label: 'Waiting for the hospital', cls: 'bg-amber-50 text-amber-700' },
  APPROVED: { label: 'Approved', cls: 'bg-success-50 text-success-700' },
  DECLINED: { label: 'Declined', cls: 'bg-critical-50 text-critical-700' },
  WITHDRAWN: { label: 'Withdrawn', cls: 'bg-slate-100 text-slate-600' },
};

/** 1536 → "1.5 KB" */
export function fileSize(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "2026-10-13T11:46:34+00:00" → "13 Oct 2026" */
export function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(currentDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}
