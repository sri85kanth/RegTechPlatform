/**
 * Remediation — the local AI drafts the artefact that closes a gap (a policy,
 * a register risk, a control or the evidence list), a person edits it, and it
 * is saved as a Draft / Pending-review company record. Nothing here changes a
 * gap's status: the gap closes when the assessment is re-run against the
 * approved document. Backend: scraper/regulatory_ingestion/api_remediation.py.
 */
import { API_BASE, authHeaders } from '@/services/http';
import { tNow, tx } from '@/i18n';

export type DraftKind = 'policy' | 'risk' | 'control' | 'evidence';
/** QUESTIONS: the questionnaire is waiting for the hospital's answers; nothing is being written yet. */
export type DraftStatus = 'QUESTIONS' | 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'SAVED';

export interface DraftSummary {
  id: string; requirement_id: string; regulation_id: string | null; item_code: string | null;
  kind: DraftKind; status: DraftStatus; message: string | null; entity_id: string | null;
  created_at?: string; updated_at?: string;
}

/** One question asked before drafting. 'standard' questions are fixed per kind; 'ai' ones are written for this duty. */
export interface DraftQuestion {
  id: string; q: string; help?: string;
  type: 'text' | 'long' | 'choice' | 'multi' | 'number' | 'date' | 'person';
  options?: string[]; suggested?: string | number | string[]; required?: boolean; source: 'standard' | 'ai';
}
export interface Questionnaire {
  base: DraftQuestion[];
  specific: DraftQuestion[];
  /** the duty questions: still being written, written, or not available (standard ones still apply) */
  specific_status: 'PENDING' | 'READY' | 'FAILED';
  note?: string;
}
export type Answers = Record<string, string | string[]>;

export interface DraftRow extends DraftSummary {
  partial: string | null;
  draft: Record<string, unknown> | string | null;
  error: string | null;
  questions?: Questionnaire | null;
  answers?: Answers | null;
}
export interface LlmStatus { ok: boolean; message: string; model: string }

/**
 * What each kind of draft is called, where a saved one lands, and its icon.
 * The words are English (tx): translate them where they are drawn.
 */
export const KIND_META: Record<DraftKind, { action: string; noun: string; domain: string; domainLabel: string; icon: string }> = {
  policy: { action: tx('Write policy'), noun: tx('Policy'), domain: 'policies', domainLabel: tx('Policies'), icon: 'FileText' },
  risk: { action: tx('Add risk'), noun: tx('Risk'), domain: 'risks', domainLabel: tx('Risks'), icon: 'ShieldAlert' },
  control: { action: tx('Design control'), noun: tx('Control'), domain: 'controls', domainLabel: tx('Controls'), icon: 'ShieldCheck' },
  evidence: { action: tx('Collect evidence'), noun: tx('Evidence'), domain: 'evidence', domainLabel: tx('Evidence'), icon: 'Paperclip' },
};

export const NEEDS_LLM = tx('Needs the local AI model (runs on the workstation)');
export const isRunning = (s?: DraftStatus | null) => s === 'QUEUED' || s === 'RUNNING';
export const draftKey = (requirementId: string, kind: DraftKind) => `${requirementId}|${kind}`;

/** The newest draft per requirement + kind (the list arrives newest first). */
export function latestDrafts(items: DraftSummary[]): Map<string, DraftSummary> {
  const m = new Map<string, DraftSummary>();
  items.forEach((d) => { const k = draftKey(d.requirement_id, d.kind); if (!m.has(k)) m.set(k, d); });
  return m;
}

/**
 * Fetch a file from the API with the session token and save it under the name
 * the server gives in Content-Disposition.
 */
export async function downloadFile(path: string, init: RequestInit = {}, fallbackName = 'download'): Promise<string> {
  const headers = authHeaders(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.status === 401 ? tNow('your session has expired — sign in again') : `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep status */ }
    throw new Error(String(detail));
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

export const DRAFT_FORMATS: { fmt: 'docx' | 'pdf' | 'md'; label: string }[] = [
  { fmt: 'docx', label: 'Word (.docx)' }, { fmt: 'pdf', label: 'PDF (.pdf)' }, { fmt: 'md', label: 'Markdown (.md)' },
];
