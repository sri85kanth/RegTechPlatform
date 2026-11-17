/**
 * Upload a regulation and follow it live.
 *
 * The file goes to /api/reg-uploads; a queue runner on the server
 * (scraper/regulatory_ingestion/reg_upload.py) reads it (OCR for scans), has the
 * local LLM extract every duty on the hospital as an obligation + testable
 * requirement, embeds the text for search, and checks each requirement against
 * the hospital's own policies, SOPs, forms and controls. Rows are written as
 * each step finishes, so the regulation, its requirements and the Impact
 * Cascade fill in while this panel shows the progress.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, FileText, FileType, FileCode, File as FileIcon, RotateCcw, Trash2, ScrollText, ArrowUpRight, X,
} from 'lucide-react';
import { API_BASE, api, authHeaders } from '@/services/http';
import { IconTile } from '@/components/ui/primitives';
import { StackedBar } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { cn, readable } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';

interface UploadJob {
  id: string; regulation_id: string; attach: number; filename: string; title: string | null;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'; stage: string; done: number; total: number;
  message: string | null; created_at: string; updated_at: string; finished_at: string | null;
  counts: Partial<Record<'pages' | 'chars' | 'requirements' | 'not_applicable' | 'rag_chunks' | 'assessed' | 'met' |
    'partial' | 'gap' | 'not_covered' | 'critical', number>> & { applicability?: string };
  log: string[];
}

/**
 * The five working stages, each with its own colour and icon, then "Live".
 * The colours are categorical (which step), not status — a failed step turns
 * red and a finished one carries a green tick, whatever its hue.
 */
const STAGES: { key: string; label: string; icon: string; tile: string; hex: string }[] = [
  { key: 'extract', label: 'Read text', icon: 'FileText', tile: 'bg-blue-50 text-blue-600', hex: '#2563eb' },
  { key: 'profile', label: 'Identify & applicability', icon: 'Target', tile: 'bg-violet-50 text-violet-600', hex: '#8b5cf6' },
  { key: 'structure', label: 'Obligations & requirements', icon: 'ListTree', tile: 'bg-amber-50 text-amber-600', hex: '#f59e0b' },
  { key: 'embed', label: 'Embed for search', icon: 'Database', tile: 'bg-teal-50 text-teal-600', hex: '#14b8a6' },
  { key: 'assess', label: 'Gap check vs hospital documents', icon: 'ClipboardCheck', tile: 'bg-pink-50 text-pink-600', hex: '#ec4899' },
];
const stageIndex = (s: string) => (s === 'ocr' ? 0 : s === 'queued' ? -1 : s === 'done' ? STAGES.length : STAGES.findIndex(({ key }) => key === s));

const inputCls = 'input';
/** Job status in words: "DONE" → "Done". */
const JOB_LABEL: Record<UploadJob['status'], string> = { QUEUED: tx('Queued'), RUNNING: tx('Running'), DONE: tx('Done'), FAILED: tx('Failed') };
const JOB_TONE: Record<UploadJob['status'], string> = {
  DONE: 'bg-success-50 text-success-600', FAILED: 'bg-critical-50 text-critical-600',
  RUNNING: 'bg-brand-50 text-brand-700', QUEUED: 'bg-slate-100 text-slate-600',
};

/** The accepted formats, each with its own colour — the dropzone shows them as tiles. */
const FILE_KINDS: { ext: string[]; label: string; tile: string; Icon: typeof FileText }[] = [
  { ext: ['pdf'], label: 'PDF', tile: 'bg-red-50 text-red-700', Icon: FileText },
  { ext: ['docx'], label: 'DOCX', tile: 'bg-blue-50 text-blue-700', Icon: FileType },
  { ext: ['txt'], label: 'TXT', tile: 'bg-slate-100 text-slate-600', Icon: FileIcon },
  { ext: ['md'], label: 'MD', tile: 'bg-violet-50 text-violet-700', Icon: FileIcon },
  { ext: ['html', 'htm'], label: 'HTML', tile: 'bg-orange-50 text-orange-700', Icon: FileCode },
];
const kindOf = (name: string) => {
  const e = name.split('.').pop()?.toLowerCase() ?? '';
  return FILE_KINDS.find((k) => k.ext.includes(e)) ?? { ext: [e], label: e.toUpperCase() || 'FILE', tile: 'bg-slate-100 text-slate-600', Icon: FileIcon };
};

/** A form field with a visible label — a placeholder alone disappears once you type. */
function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <label className={cn('block min-w-0', className)}>
      <span className="field-label">{t(label)}{hint && <span className="font-normal text-muted"> · {t(hint)}</span>}</span>
      {children}
    </label>
  );
}

export function RegulationUpload() {
  // `t` below is a regulation type in the Type list, so the translate function is `tr` here
  const tr = useT();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [form, setForm] = useState({ title: '', regulator: '', regulation_type: '', jurisdiction: '', attach_to: '' });
  const [sending, setSending] = useState(0);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const jobs = useQuery<{ items: UploadJob[] }>({
    queryKey: ['reg-uploads'], queryFn: () => api('/api/reg-uploads'),
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 3000 : 30000),
  });
  const llm = useQuery<{ ok: boolean; detail: string }>({ queryKey: ['reg-uploads', 'llm'], queryFn: () => api('/api/reg-uploads/llm'), refetchInterval: 30000 });

  function submit() {
    if (!file) { setError(tr('Choose a PDF, DOCX or text file.')); return; }
    setError(''); setSending(1);
    const fd = new FormData();
    fd.append('file', file);
    Object.entries(form).forEach(([k, v]) => v.trim() && fd.append(k, v.trim()));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/reg-uploads`);
    authHeaders().forEach((v, k) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && setSending(Math.max(1, Math.round((e.loaded / e.total) * 100)));
    xhr.onload = () => {
      setSending(0);
      let body: { id?: string; detail?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        setFile(null); if (fileRef.current) fileRef.current.value = '';
        setForm({ title: '', regulator: '', regulation_type: '', jurisdiction: '', attach_to: '' });
        setOpen(body.id ?? null);
        qc.invalidateQueries({ queryKey: ['reg-uploads'] });
      } else setError(body.detail ?? tr('Upload failed (HTTP {status})', { status: xhr.status }));
    };
    xhr.onerror = () => { setSending(0); setError(tr('Could not reach the server.')); };
    xhr.send(fd);
  }

  async function act(j: UploadJob, what: 'retry' | 'delete') {
    if (what === 'delete' && !window.confirm(tr('Remove "{name}" and every requirement, finding and search chunk it added?', { name: j.title || j.filename }))) return;
    try {
      await api(`/api/reg-uploads/${j.id}${what === 'retry' ? '/retry' : ''}`, { method: what === 'retry' ? 'POST' : 'DELETE' });
    } catch (e) { window.alert((e as Error).message); }
    qc.invalidateQueries({ queryKey: ['reg-uploads'] });
    qc.invalidateQueries({ queryKey: ['cascade'] });
  }

  const items = jobs.data?.items ?? [];
  const byStatus = (s: UploadJob['status']) => items.filter((j) => j.status === s).length;
  const kind = file ? kindOf(file.name) : null;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------- the upload form */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <IconTile icon="UploadCloud" tone="brand" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">{tr('Upload a regulation')}</div>
            <div className="text-xs text-muted">{tr("Act, rules, circular, standard or guideline — read, split into obligations and requirements, checked against the hospital's documents, live as it goes.")}</div>
          </div>
          <span className={cn('pill', llm.data == null ? 'bg-slate-100 text-slate-600' : llm.data.ok ? 'bg-success-50 text-success-600' : 'bg-warning-50 text-warning-600')} title={llm.data?.detail}>
            <span className={cn('h-1.5 w-1.5 rounded-full bg-current', llm.data == null && 'animate-pulse')} aria-hidden="true" />
            {llm.data == null ? tr('Checking local LLM…') : llm.data.ok ? tr('Local LLM ready') : tr('Local LLM offline')}
          </span>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)]">
          <label
            className={cn('group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
              'focus-within:ring-2 focus-within:ring-brand-200',
              over ? 'border-brand-500 bg-brand-50' : file ? 'border-brand-300 bg-brand-50/50' : 'border-line-2 bg-gradient-to-b from-slate-50 to-white hover:border-brand-400 hover:bg-brand-50/40')}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
          >
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.html,.htm" className="sr-only"
              aria-label={tr('Choose a regulation file')}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && kind ? (
              <>
                <span className={cn('grid h-12 w-12 place-items-center rounded-xl', kind.tile)}>
                  <kind.Icon className="h-6 w-6" />
                </span>
                <span className="max-w-full truncate text-[13.5px] font-semibold text-ink" title={file.name}>{file.name}</span>
                <span className="text-xs text-muted">
                  <b className="font-semibold text-ink-2">{kind.label}</b> · {(file.size / 1024 / 1024).toFixed(1)} MB · {tr('click to choose another')}
                </span>
              </>
            ) : (
              <>
                <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-100 text-brand-600">
                  <Icon name="UploadCloud" className="h-6 w-6" />
                </span>
                <span className="text-[13.5px] font-semibold text-ink">{tr('Drop a file or click to choose')}</span>
                <span className="text-xs text-muted">{tr("Scanned PDFs are fine — they are OCR'd · up to 80 MB")}</span>
                <span className="mt-1 flex flex-wrap justify-center gap-1.5" aria-label={tr('Accepted formats')}>
                  {FILE_KINDS.map((k) => (
                    <span key={k.label} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-bold', k.tile)}>
                      <k.Icon className="h-3.5 w-3.5" aria-hidden="true" />{k.label}
                    </span>
                  ))}
                </span>
              </>
            )}
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Title" hint="optional">
              <input className={inputCls} placeholder={tr('Read from the document')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Regulator" hint="optional">
              <input className={inputCls} placeholder={tr('e.g. {example}', { example: 'NABH' })} value={form.regulator} onChange={(e) => setForm({ ...form, regulator: e.target.value })} />
            </Field>
            <Field label="Type">
              <select className={inputCls} value={form.regulation_type} onChange={(e) => setForm({ ...form, regulation_type: e.target.value })}>
                <option value="">{tr('Detect automatically')}</option>
                {[tx('Act'), tx('Rules'), tx('Regulations'), tx('Notification'), tx('Circular'), tx('Guidelines'), tx('Standard'), tx('Order')].map((t) => <option key={t} value={t}>{tr(t)}</option>)}
              </select>
            </Field>
            <Field label="Jurisdiction" hint="optional">
              <input className={inputCls} placeholder={tr('e.g. India, Telangana')} value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} />
            </Field>
            <Field label="Add to an existing regulation" hint="optional, regulation id" className="sm:col-span-2">
              <input className={inputCls} placeholder={tr('e.g. {example}', { example: 'nabh-hospital-6th-edition-2025' })} value={form.attach_to} onChange={(e) => setForm({ ...form, attach_to: e.target.value })} />
            </Field>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <button type="button" onClick={submit} disabled={!!sending} className="btn btn-primary disabled:opacity-60">
                <Icon name="UploadCloud" className="h-4 w-4" />
                {sending ? tr('Uploading {n}%', { n: sending }) : tr('Upload & process')}
              </button>
              {sending > 0 && (
                <span className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                  <span className="block h-full rounded-full bg-brand-600 transition-all" style={{ width: `${sending}%` }} />
                </span>
              )}
              {file && !sending && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>
                  <X className="h-3.5 w-3.5" /> {tr('Clear file')}
                </button>
              )}
              {error && <span role="alert" className="text-xs text-critical-600">{error}</span>}
              {!llm.data?.ok && llm.data && <span className="text-xs text-warning-700">{tr('The job will wait and fail with a Retry until the local LLM is running.')}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- live jobs */}
      {items.length > 0 && (
        <section>
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <h2 className="sec-title">{tr('Uploads')}</h2>
            <span className="text-[13px] text-muted">· {tr('{n} most recent', { n: items.length.toLocaleString() })}</span>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {(['RUNNING', 'QUEUED', 'DONE', 'FAILED'] as const).filter((s) => byStatus(s) > 0).map((s) => (
                <span key={s} className={cn('pill', JOB_TONE[s])}>
                  <b className="tabular-nums">{byStatus(s)}</b> {tr(JOB_LABEL[s]).toLowerCase()}
                </span>
              ))}
            </span>
          </div>
          <ul className="space-y-3">
            {items.map((j) => <JobCard key={j.id} j={j} open={open === j.id} onToggleLog={() => setOpen(open === j.id ? null : j.id)} onAct={(w) => act(j, w)} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ one job */
function JobCard({ j, open, onToggleLog, onAct }: {
  j: UploadJob; open: boolean; onToggleLog: () => void; onAct: (what: 'retry' | 'delete') => void;
}) {
  const t = useT();
  const locale = useDateLocale();
  const si = stageIndex(j.stage);
  const done = j.status === 'DONE';
  const failed = j.status === 'FAILED';
  const running = j.status === 'RUNNING' || j.status === 'QUEUED';
  const stagePct = done ? 100 : j.total ? Math.round((j.done / j.total) * 100) : 0;
  // overall: whole stages finished, plus the share of the one in progress
  const overall = done ? 100 : si < 0 ? 0 : Math.round(((Math.min(si, STAGES.length) + (j.total ? j.done / j.total : 0)) / STAGES.length) * 100);
  const c = j.counts;
  const kind = kindOf(j.filename);
  const cur = si >= 0 && si < STAGES.length ? STAGES[si] : null;

  return (
    <li className={cn('card overflow-hidden', failed && 'border-critical-200')}>
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', kind.tile)} aria-hidden="true">
          <kind.Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink" title={j.filename}>{j.title || j.filename}</div>
          <div className="text-xs text-muted">
            {kind.label} · {t('added {date}', { date: new Date(j.created_at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}
            {j.finished_at && <> · {t('finished {date}', { date: new Date(j.finished_at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</>}
          </div>
        </div>
        <span className={cn('pill', JOB_TONE[j.status])}>
          {running && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
          {done && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          {t(JOB_LABEL[j.status] ?? readable(String(j.status)))}
        </span>
      </div>

      {/* five-stage stepper */}
      <ol className="mt-4 grid grid-cols-5 gap-1 px-5" aria-label={t('Processing stages')}>
        {STAGES.map((s, i) => {
          const passed = done || i < si;
          const here = !done && i === si;
          const bad = here && failed;
          return (
            <li key={s.key} className="relative flex min-w-0 flex-col items-center text-center"
                aria-current={here ? 'step' : undefined}>
              {i > 0 && (
                <span className={cn('absolute right-1/2 top-[17px] h-0.5 w-full', passed || here ? 'bg-success-500' : 'bg-slate-200')}
                      aria-hidden="true" />
              )}
              <span className={cn('relative z-10 grid h-9 w-9 place-items-center rounded-xl ring-2 ring-white transition',
                bad ? 'bg-critical-50 text-critical-600' : passed || here ? s.tile : 'bg-slate-100 text-slate-400',
                here && !bad && 'ring-brand-200')}>
                <Icon name={s.icon} className="h-[18px] w-[18px]" />
                {passed && (
                  <span className="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-success-500 text-white ring-2 ring-white">
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                )}
              </span>
              <span className={cn('mt-1.5 line-clamp-2 text-[11px] leading-tight',
                here ? (bad ? 'font-semibold text-critical-600' : 'font-semibold text-ink') : passed ? 'text-ink-2' : 'text-muted')}>
                {t(s.label)}{s.key === 'extract' && j.stage === 'ocr' ? ' (OCR)' : ''}
              </span>
              {here && j.total > 0 && <span className="text-[11px] tabular-nums text-muted">{j.done}/{j.total}</span>}
            </li>
          );
        })}
      </ol>

      {/* progress */}
      {(running || failed) && (
        <div className="mt-3 flex items-center gap-3 px-5 text-xs">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <span className="block h-full rounded-full transition-all duration-700"
                  style={{ width: `${overall}%`, background: failed ? '#dc2626' : cur?.hex ?? '#2563eb' }} />
          </span>
          <span className="shrink-0 tabular-nums text-ink-2">
            {t('{n}% overall', { n: overall })}{cur && j.total ? ` · ${t('this stage {n}%', { n: stagePct })}` : ''}
          </span>
        </div>
      )}

      {/* what it found */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 text-[12.5px] text-muted">
        {j.message && <span className={failed ? 'font-medium text-critical-600' : 'text-ink-2'}>{j.message}</span>}
        {c.pages != null && <span><b className="tabular-nums text-ink">{c.pages.toLocaleString()}</b> {t('pages')}</span>}
        {c.applicability && <span>{t('Applicability')}: <span className="font-semibold text-ink">{t(readable(c.applicability))}</span></span>}
        {c.requirements != null && <span><b className="tabular-nums text-ink">{c.requirements.toLocaleString()}</b> {t('requirements')}{c.not_applicable ? ` (${t('{n} not applicable', { n: c.not_applicable.toLocaleString() })})` : ''}</span>}
        {c.rag_chunks != null && <span><b className="tabular-nums text-ink">{c.rag_chunks.toLocaleString()}</b> {t('search chunks')}</span>}
        {c.critical ? <span className="pill bg-critical-50 text-critical-600">{t('{n} critical', { n: c.critical.toLocaleString() })}</span> : null}
      </div>
      {c.assessed != null && (
        <div className="mt-2.5 px-5">
          <StackedBar
            height={8}
            data={[
              { label: t('Documented'), value: c.met ?? 0, color: '#16a34a' },
              { label: t('Partial'), value: c.partial ?? 0, color: '#f59e0b' },
              { label: t('Gap'), value: c.gap ?? 0, color: '#dc2626' },
              { label: t('Not covered'), value: c.not_covered ?? 0, color: '#f97316' },
            ]}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line bg-slate-50/50 px-5 py-2.5">
        {(c.requirements ?? 0) > 0 && <>
          <Link to={`/regulation/${encodeURIComponent(j.regulation_id)}`} className="btn btn-sm btn-outline h-7">
            {t('Regulation')} <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
          {(c.assessed ?? 0) > 0 && (
            <Link to={`/cascade?reg=${encodeURIComponent(j.regulation_id)}`} className="btn btn-sm btn-outline h-7">
              {t('Impact cascade')} <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </>}
        {failed && (
          <button type="button" onClick={() => onAct('retry')} className="btn btn-sm btn-primary h-7">
            <RotateCcw className="h-3.5 w-3.5" /> {t('Retry')}
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onToggleLog} aria-expanded={open} className="btn btn-sm btn-ghost h-7">
            <ScrollText className="h-3.5 w-3.5" /> {open ? t('Hide log') : t('Log')}
          </button>
          {!running && (
            <button type="button" onClick={() => onAct('delete')} className="btn btn-sm btn-ghost h-7 hover:text-critical-600">
              <Trash2 className="h-3.5 w-3.5" /> {t('Remove')}
            </button>
          )}
        </span>
      </div>
      {open && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-line bg-slate-50 px-5 py-3 text-[11px] leading-relaxed text-ink-2">{j.log.join('\n') || t('No log yet.')}</pre>
      )}
    </li>
  );
}
