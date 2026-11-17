// ============================================================
// Integrations — connecting the systems the customer already runs.
//
// Data path:  Frontend → FastAPI /api/integrations → PostgreSQL (company_brain)
//
// Secrets are write-only: they are sent on create and never come back, so
// nothing in this file can display a credential.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, Unauthorized, api, authHeaders, setToken } from '@/services/http';
import { tx } from '@/i18n';

export type ConnStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'FAILED' | 'NEEDS_CREDENTIALS';

export interface Connector {
  id: string;
  name: string;
  category: string;
  auth: 'token' | 'path';
  /** true when this build can actually exercise the connector today */
  ready: boolean;
  /** which Company Brain domains it populates */
  domains: string[];
  /** set when the connector signs in rather than taking a pasted credential */
  gives: string;
  needs: string;
}

export interface SyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  outcome: 'OK' | 'FAILED' | 'PARTIAL' | null;
  detail: string | null;
  items_seen: number;
  entities_written: number;
  documents_written: number;
  skipped: number;
}

export interface Integration {
  id: string;
  connector: string;
  connector_name: string;
  label: string;
  config: Record<string, string>;
  has_secret: boolean;
  status: ConnStatus;
  status_detail: string | null;
  last_tested_at: string | null;
  last_sync_at: string | null;
  syncs?: SyncRun[];
  /**
   * True when this "folder" is a copy the browser upload left on the server,
   * not a live directory. Syncing re-reads that frozen copy, so files added to
   * the original folder afterwards can never appear — the UI must say so
   * rather than offer a button that cannot succeed.
   */
  is_upload_snapshot?: boolean;
}

const get = <T,>(p: string): Promise<T> => api<T>(p);
const send = <T,>(p: string, method: string, body?: unknown): Promise<T> =>
  api<T>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface AuthScheme {
  id: 'bearer' | 'basic' | 'prefix' | 'header' | 'none';
  hint: string;
}

export const useCatalogue = () =>
  useQuery<{ connectors: Connector[]; readyNow: string[]; note: string; authSchemes: AuthScheme[] }>({
    queryKey: ['int-catalogue'],
    queryFn: () => get('/api/integrations/catalogue'),
    staleTime: Infinity,
  });

export const useIntegrations = () =>
  useQuery<{ items: Integration[]; total: number }>({
    queryKey: ['integrations'],
    queryFn: () => get('/api/integrations'),
  });

/** All mutations invalidate the list, so status on screen is always the server's. */
function useRefetching<TArgs, TRes>(fn: (a: TArgs) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TArgs>({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  });
}

export const useCreateIntegration = () =>
  useRefetching((b: { connector: string; label: string; config: Record<string, unknown>; secret?: string }) =>
    send<Integration>('/api/integrations', 'POST', b));

export const useTestIntegration = () =>
  useRefetching((id: string) => send<Integration>(`/api/integrations/${id}/test`, 'POST'));

export const useSyncIntegration = () =>
  useRefetching((id: string) => send<{ run: SyncRun; integration: Integration }>(`/api/integrations/${id}/sync`, 'POST'));

export const useDeleteIntegration = () =>
  useRefetching((id: string) => send<{ deleted: string }>(`/api/integrations/${id}`, 'DELETE'));

/** Replace a connection's key. Write-only: the response never carries it. */
export const useChangeIntegrationKey = () =>
  useRefetching((v: { id: string; secret: string }) =>
    send<Integration>(`/api/integrations/${v.id}/secret`, 'POST', { secret: v.secret }));

export const STATUS_LABEL: Record<ConnStatus, string> = {
  NOT_CONNECTED: tx('Not connected'),
  CONNECTED: tx('Connected'),
  FAILED: tx('Connection failed'),
  NEEDS_CREDENTIALS: tx('Needs credentials'),
};

export interface UploadResult {
  /** Absolute path on the server where the folder landed. */
  path: string;
  files: number;
  bytes: number;
  skipped: string[];
  note: string;
  /** Files overwritten because the same relative path was uploaded again. */
  replaced?: number;
  /** Set when the size ceiling stopped the upload, naming the file it stopped at. */
  stoppedAt?: string | null;
  sizeLimitMb?: number;
}

/**
 * Upload a picked folder and get back the server path it was written to.
 *
 * Deliberately not routed through `api()`: that helper sets a JSON content-type,
 * and multipart needs the browser to set its own boundary. Everything else —
 * bearer token, 401 handling — is mirrored so this behaves like every other call.
 */
/**
 * Upload a folder in batches.
 *
 * It used to be one multipart request for the whole folder. 414 files over a
 * slow uplink to a loaded host meant a single connection held open for minutes,
 * and when it dropped nginx logged 499 — the client closing the connection —
 * and every file was lost. Nothing partial survived, so a retry started over.
 *
 * Batching changes the failure from total to local: the first batch creates the
 * folder on the server, each later one names it, and a batch that fails is
 * retried on its own. Files already written stay written.
 */
/** One batch. Small enough that a stall costs seconds, not the whole folder. */
const UPLOAD_BATCH_FILES = 25;
const UPLOAD_BATCH_BYTES = 12 * 1024 * 1024;
/** A batch that has not moved in this long is not going to. */
const UPLOAD_BATCH_TIMEOUT_MS = 180_000;

function batchFiles(files: File[]): File[][] {
  const out: File[][] = [];
  let cur: File[] = [];
  let bytes = 0;
  for (const f of files) {
    // A single file larger than the budget still goes in a batch of its own
    // rather than being split — the server writes whole files.
    if (cur.length && (cur.length >= UPLOAD_BATCH_FILES || bytes + f.size > UPLOAD_BATCH_BYTES)) {
      out.push(cur); cur = []; bytes = 0;
    }
    cur.push(f); bytes += f.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

function postBatch(
  files: File[], label: string, into: string,
  onBytes: (delta: number) => void,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('label', label);
  if (into) form.append('into', into);
  for (const f of files) {
    form.append('files', f);
    // webkitRelativePath preserves the folder shape ("Compliance/01-people.csv").
    // Sent alongside rather than relied on server-side, where it is sanitised.
    form.append('paths', (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  }
  const headers = authHeaders();
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/integrations/upload`);
    xhr.timeout = UPLOAD_BATCH_TIMEOUT_MS;
    headers.forEach((v, k) => xhr.setRequestHeader(k, v));
    let last = 0;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      onBytes(e.loaded - last);
      last = e.loaded;
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        setToken('');
        window.dispatchEvent(new CustomEvent('cb:signed-out'));
        reject(new Unauthorized());
        return;
      }
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
      else reject(new Error((body as { detail?: string })?.detail ?? `HTTP ${xhr.status}`));
    };
    xhr.ontimeout = () => reject(new Error(
      `a batch of ${files.length} file(s) stopped responding after ${UPLOAD_BATCH_TIMEOUT_MS / 1000}s`));
    // Name the URL it tried. "Could not reach the API" is true and useless: the
    // one time this fired for real, the bundle was calling http://localhost:8787
    // — the user's own machine — and the message gave no way to see that. The
    // address is the whole diagnosis.
    xhr.onerror = () => reject(new Error(
      `could not reach ${API_BASE || window.location.origin}/api/integrations/upload` +
      (API_BASE.includes('localhost')
        ? ' — this build is configured for a local API, not the server'
        : ' — the connection dropped mid-transfer')));
    xhr.send(form);
  });
}

/**
 * Upload a folder in batches.
 *
 * It used to be one multipart request for the whole folder. 414 files over a
 * slow uplink to a loaded host meant a single connection held open for minutes,
 * and when it dropped nginx logged 499 — the client closing the connection —
 * and every file was lost. Nothing partial survived, so a retry started over.
 *
 * Batching changes the failure from total to local: the first batch creates the
 * folder on the server, each later one names it, and a batch that fails is
 * retried on its own. Files already written stay written.
 */
export async function uploadFolder(
  files: File[],
  label: string,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  const batches = batchFiles(files);
  const totalBytes = files.reduce((n, f) => n + f.size, 0) || 1;
  let sent = 0;
  const bump = (delta: number) => {
    sent += delta;
    onProgress?.(Math.min(99, Math.round((sent / totalBytes) * 100)));
  };

  let into = '';
  const merged: UploadResult = {
    path: '', files: 0, bytes: 0, skipped: [], replaced: 0,
    stoppedAt: null, sizeLimitMb: 0, note: '',
  } as UploadResult;

  for (let i = 0; i < batches.length; i++) {
    let res: UploadResult | null = null;
    let lastErr: unknown = null;
    // One retry per batch. A dropped connection is usually transient, and
    // re-sending 25 files is cheap; the server overwrites a path it already
    // holds, so a partially-received batch cannot produce duplicates.
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await postBatch(batches[i], label, into, bump);
      } catch (e) {
        if (e instanceof Unauthorized) throw e;
        lastErr = e;
      }
    }
    if (!res) {
      throw new Error(
        `Upload stopped at batch ${i + 1} of ${batches.length} — ` +
        `${merged.files} file(s) were saved before it failed. ` +
        `${(lastErr as Error)?.message ?? 'unknown error'}`);
    }
    into = into || res.path;
    merged.path = res.path;
    merged.files += res.files;
    merged.bytes += res.bytes;
    merged.replaced = (merged.replaced ?? 0) + (res.replaced ?? 0);
    merged.skipped = [...merged.skipped, ...(res.skipped ?? [])];
    merged.sizeLimitMb = res.sizeLimitMb;
    merged.note = res.note;
  }
  onProgress?.(100);
  return merged;
}
