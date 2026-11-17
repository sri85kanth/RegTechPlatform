// ============================================================
// Retrieval over Company Brain + Regulatory knowledge.
//
//   PostgreSQL company_brain (source of truth) --> pgvector index (derived) --> here
//
// This returns PASSAGES WITH CITATIONS, not generated answers. Every hit names
// the table and row it came from, so nothing on screen is unattributable.
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface RagHit {
  id: number;
  corpus: 'regulatory' | 'company';
  source_table: string;
  source_id: string;
  regulation_id: string | null;
  entity_id: string | null;
  domain: string | null;
  title: string | null;
  section_number: string | null;
  content: string;
  url: string | null;
  app_path: string | null;
  score: number;
  similarity: number;
  /** which retrieval arms matched: vector | keyword | reference (fused) */
  matched_by: string;
}

export interface RagResult {
  query: string;
  count: number;
  items: RagHit[];
  provenance: { index: string; source_of_truth: string; model: string; retrieval: string };
}

const get = <T,>(p: string): Promise<T> => api<T>(p);

export const useRagSearch = (q: string, opts?: { corpus?: string; k?: number }) =>
  useQuery<RagResult>({
    queryKey: ['rag', q, opts?.corpus, opts?.k],
    queryFn: () => {
      const p = new URLSearchParams({ q, k: String(opts?.k ?? 10) });
      if (opts?.corpus) p.set('corpus', opts.corpus);
      return get(`/api/rag/search?${p}`);
    },
    enabled: q.trim().length > 1,
    staleTime: 60_000,
  });

export interface AnswerQuote {
  text: string; regulation_id: string | null; section: string | null;
  title: string | null; source: string | null; app_path: string | null;
}
export interface AnswerPassage {
  rank: number; regulation_id: string | null; section: string | null;
  title: string | null; text: string; app_path: string | null;
}
export interface RagAnswer {
  query: string;
  mode: 'extractive' | 'synthesised' | 'no_evidence';
  answer: string | null;
  model?: string;
  quotes: AnswerQuote[];
  passages: AnswerPassage[];
  note: string;
}
export const useRagAnswer = (q: string, opts?: { corpus?: string }) =>
  useQuery<RagAnswer>({
    queryKey: ['rag-answer', q, opts?.corpus ?? ''],
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    queryFn: () => {
      const p = new URLSearchParams({ q });
      if (opts?.corpus) p.set('corpus', opts.corpus);
      return get(`/api/rag/answer?${p}`);
    },
  });

export interface VisualStatus {
  available: boolean; reason?: string | null; model?: string;
  pages?: number; patches?: number; documents?: number;
}
export interface RagStatus {
  available: boolean;
  visual?: VisualStatus;
  chunks?: number;
  byCorpus?: Record<string, number>;
  bySourceTable?: Record<string, number>;
  model?: string;
  reason?: string;
  hint?: string;
}
export const useRagStatus = () =>
  useQuery<RagStatus>({ queryKey: ['rag-status'], queryFn: () => get('/api/rag/status') });

/* ---------- visual route (ColSmol late interaction) ----------
   Returns PAGES matched from the page image. There is no text in a hit —
   this route works on scanned documents the text pipeline cannot read, but it
   can only point at a page, never quote it. */
export interface VisualHit {
  page_id: number;
  regulation_id: string;
  page_no: number;
  title: string | null;
  url: string | null;
  app_path: string | null;
  patches: number;
  maxsim: number;
  normalised: number;
  matched_by: string;
}
export const useVisualSearch = (q: string, enabled: boolean, k = 5) =>
  useQuery<{ query: string; count: number; items: VisualHit[];
             provenance: { model: string; scoring: string; note: string } }>({
    queryKey: ['rag-visual', q, k],
    queryFn: () => get(`/api/rag/visual?${new URLSearchParams({ q, k: String(k) })}`),
    enabled: enabled && q.trim().length > 1,
    staleTime: 60_000,
    retry: false,
  });
