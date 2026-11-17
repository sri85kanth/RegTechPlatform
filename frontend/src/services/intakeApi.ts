// ============================================================
// Document intake (/api/intake): a folder of the hospital's documents, sorted
// into the company structure.
//
// Every document in an uploaded or connected folder is read (Word, PDF, scans
// by OCR, images, zips), split when one file holds several documents, typed
// (policy, SOP, form…), placed in its department and linked to the people it
// names. Confident ones are filed straight away; the rest wait here with the
// reason, for a person to confirm or correct.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';
import { useData } from '@/app/store/data';
import { currentDateLocale, txList } from '@/i18n';

export const DOC_TYPES = txList(['Policy', 'SOP', 'Form', 'Register', 'Plan', 'Manual', 'Job description', 'Licence',
  'Minutes', 'Contract', 'Training record', 'Report', 'Other'] as const);
export type DocType = (typeof DOC_TYPES)[number];

export type ItemStatus = 'SAVED' | 'REVIEW' | 'READY' | 'ON_RECORD' | 'DUPLICATE' | 'SKIPPED' | 'UNDONE';
export type BatchStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'UNDONE';

export interface IntakeBatch {
  id: string; integration_id: string | null; root: string; label: string; status: BatchStatus; stage: string;
  message: string; files_total: number; files_done: number; items: number; saved: number; review: number;
  on_record: number; created_by: string; created_at: string; updated_at: string; finished_at: string | null;
}

export interface PersonNamed { label: string; value: string; entity_id: string | null; note: string }

export interface IntakeItem {
  id: string; batch_id: string; file: string; part: number; parts: number; bytes: number | null;
  doc_type: DocType; type_confidence: number; type_evidence: string; type_method: 'rules' | 'ai' | 'person';
  code: string; code_written: string; title: string; version: string; effective_date: string; review_date: string;
  department: string; department_node_id: string | null; department_status: 'matched' | 'proposed' | 'unknown';
  department_evidence: string; owner_text: string; owner_id: string | null; approver_text: string;
  approver_id: string | null; people: PersonNamed[]; refs: string[]; excerpt: string; chars: number; ocr: number;
  status: ItemStatus; reasons: string[]; saved_how: string | null; entity_id: string | null;
  existing_entity_id: string | null; duplicate_of: string | null; decided_by: string | null;
}

export interface IntakeItemFull extends IntakeItem {
  text: string;
  entity?: { id: string; domain: string; name: string; verification: string } | null;
  existing?: { id: string; domain: string; name: string; verification: string } | null;
}

export interface BatchDetail {
  batch: IntakeBatch;
  items: IntakeItem[];
  summary: {
    types: { type: DocType; count: number }[];
    departments: { name: string; status: string; count: number }[];
    people: { matched: number; unmatched: number };
    status: Record<ItemStatus, number>;
  };
}

export const STATUS_UI: Record<ItemStatus, { label: string; cls: string; hint: string }> = {
  SAVED: { label: 'Filed', cls: 'bg-success-50 text-success-600', hint: 'in the company structure, verification pending' },
  REVIEW: { label: 'Needs review', cls: 'bg-warning-50 text-warning-600', hint: 'waiting for a person to confirm' },
  READY: { label: 'Ready', cls: 'bg-brand-50 text-brand-600', hint: 'sorted, not filed yet' },
  ON_RECORD: { label: 'Already on record', cls: 'bg-slate-100 text-slate-600', hint: 'the same document is already filed' },
  DUPLICATE: { label: 'Duplicate', cls: 'bg-slate-100 text-slate-500', hint: 'another copy in this upload' },
  SKIPPED: { label: 'Left out', cls: 'bg-slate-100 text-slate-500', hint: 'a person chose not to file it' },
  UNDONE: { label: 'Undone', cls: 'bg-slate-100 text-slate-500', hint: 'removed when the upload was undone' },
};

export const useIntakeBatches = (enabled = true) =>
  useQuery<{ items: IntakeBatch[] }>({
    queryKey: ['intake', 'batches'],
    queryFn: () => api('/api/intake/batches'),
    enabled,
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((b) => b.status === 'RUNNING') ? 3000 : false),
  });

export const useIntakeBatch = (id: string) =>
  useQuery<BatchDetail>({
    queryKey: ['intake', 'batch', id],
    queryFn: () => api(`/api/intake/batches/${encodeURIComponent(id)}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.batch?.status === 'RUNNING' ? 2500 : false),
  });

export const useIntakeItem = (id: string | null) =>
  useQuery<IntakeItemFull>({
    queryKey: ['intake', 'item', id],
    queryFn: () => api(`/api/intake/items/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  });

export const useIntakeDepartments = () =>
  useQuery<{ items: { id: string; name: string }[] }>({
    queryKey: ['intake', 'departments'],
    queryFn: () => api('/api/intake/departments'),
    staleTime: 60_000,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['intake'] });
    qc.invalidateQueries({ queryKey: ['structure'] });
    // filed records appear on the company pages without a reload
    void useData.getState().hydrate();
  };
}

export function useStartIntake() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (b: { path: string; label: string }) =>
      api<{ id: string }>('/api/intake/batches', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: done,
  });
}

export interface Correction {
  doc_type?: DocType; department?: string; title?: string; owner_id?: string | null; owner_text?: string;
  remember?: boolean;
}

export function useCorrectItem() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...b }: Correction & { id: string }) =>
      api<{ updated: boolean; learned: { kind: string; key: string; value: string }[]; applied: number; item: IntakeItem }>(
        `/api/intake/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: done,
  });
}

export function useSaveItems() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api<{ saved: number }>('/api/intake/items/save', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: done,
  });
}

export function useSkipItems() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api<{ skipped: number }>('/api/intake/items/skip', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: done,
  });
}

export function useUndoBatch() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ removed: number; kept_verified: number }>(`/api/intake/batches/${encodeURIComponent(id)}/undo`, { method: 'POST' }),
    onSuccess: done,
  });
}

/** "Nursing Dept/NURSING MANUAL.docx › part 2 of 3" → its file name. */
export const fileName = (f: string) => f.split(' › ').pop()!.split('/').pop()!;
export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(currentDateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
