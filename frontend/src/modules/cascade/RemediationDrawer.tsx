/**
 * The AI drafting drawer: the local model writes the record that closes one
 * gap (a policy, a register risk, a control or the evidence list), a person
 * edits it, then saves it as a Draft / Pending-review company record or
 * downloads it. It never changes the gap's status — the gap closes when the
 * assessment is re-run against the approved document.
 *
 * It asks before it writes: a short questionnaire (DraftQuestionnaire) comes
 * first, and the answers are facts the draft must use, so the draft states the
 * hospital's practice rather than [placeholders]. It can be skipped.
 *
 * Same right-side drawer as the Controls and Requirements panels (SidePanel).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/services/http';
import { Callout } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { entityById } from '@/services/entities';
import { cn, toneClass } from '@/utils/ui';
import { PanelHeader, SidePanel } from '@/modules/compliance/ui';
import { DRAWER, riskPhrase } from '@/modules/compliance/uiKit';
import { tx, useT } from '@/i18n';
import { MEANING } from './cascadeText';
import type { DraftRequest } from './renderCascade';
import {
  DRAFT_FORMATS, KIND_META, NEEDS_LLM, downloadFile, isRunning,
  type Answers, type DraftKind, type DraftRow, type DraftStatus, type DraftSummary, type LlmStatus,
} from './remediationApi';
import { AnswersUsed, DraftQuestionnaire, initialAnswers, missingRequired } from './DraftQuestionnaire';

type Json = Record<string, unknown>;

const STATUS_PILL: Record<DraftStatus | 'NONE', { label: string; tone: 'gray' | 'amber' | 'blue' | 'green' | 'red' }> = {
  NONE: { label: 'Not started', tone: 'gray' },
  QUESTIONS: { label: 'Questions', tone: 'blue' },
  QUEUED: { label: 'Drafting', tone: 'amber' },
  RUNNING: { label: 'Drafting', tone: 'amber' },
  READY: { label: 'Draft ready', tone: 'blue' },
  SAVED: { label: 'Saved', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
};
/** per kind of draft: whole phrases, so the noun can move when translated */
const KIND_TEXT: Record<DraftKind, { start: string; saved: string }> = {
  policy: { start: tx('Draft the policy with the local AI'), saved: tx('Saved to Policies as a draft — review and approve it there') },
  risk: { start: tx('Draft the risk with the local AI'), saved: tx('Saved to Risks as a draft — review and approve it there') },
  control: { start: tx('Draft the control with the local AI'), saved: tx('Saved to Controls as a draft — review and approve it there') },
  evidence: { start: tx('Draft the evidence with the local AI'), saved: tx('Saved to Evidence as a draft — review and approve it there') },
};

export function RemediationDrawer({ req, existing, llm, onClose, onChanged }: {
  req: DraftRequest; existing?: DraftSummary; llm?: LlmStatus | null; onClose: () => void; onChanged: () => void;
}) {
  // `t` is a timer in the elapsed-time effect below, so the translate function is `tr` here
  const tr = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const meta = KIND_META[req.kind];
  const [id, setId] = useState<string | null>(existing && existing.status !== 'FAILED' ? existing.id : null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<Json | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const llmDown = llm ? !llm.ok : false;

  const start = useMutation({
    mutationFn: (fresh: boolean) => api<DraftRow>('/api/remediation/drafts', {
      method: 'POST', body: JSON.stringify({ requirement_id: req.rid, kind: req.kind, fresh, questionnaire: true }),
    }),
    onSuccess: (row) => { setErr(''); setForm(null); setDirty(false); setAnswers({}); qc.setQueryData(['remediation-draft', row.id], row); setId(row.id); onChanged(); },
    onError: (e: Error) => setErr(e.message),
  });

  // opened from a chip with nothing drafted yet: open the questionnaire at once.
  // The standard questions need no model; the draft waits for it if it is still loading.
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    if (!id) start.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = useQuery<DraftRow>({
    queryKey: ['remediation-draft', id],
    queryFn: () => api(`/api/remediation/drafts/${encodeURIComponent(id!)}`),
    enabled: !!id,
    // poll while the model writes the draft, or while it writes the duty's questions
    refetchInterval: (query) => (isRunning(query.state.data?.status)
      || (query.state.data?.status === 'QUESTIONS' && query.state.data?.questions?.specific_status === 'PENDING') ? 2000 : false),
    // keep polling while the person looks at another tab — the draft takes 1–2 minutes
    refetchIntervalInBackground: true,
  });
  const row = q.data;
  const status: DraftStatus | 'NONE' = row?.status ?? (start.isPending ? 'QUEUED' : 'NONE');

  // the questionnaire: answers start from the last ones given, else the suggestions;
  // the duty's own questions are merged in when they arrive, without touching what was typed
  const [answers, setAnswers] = useState<Answers>({});
  const [editing, setEditing] = useState(false);
  const seenRow = useRef<string | null>(null);
  useEffect(() => {
    if (!row?.questions) return;
    const init = initialAnswers(row.questions, row.answers);
    if (seenRow.current !== row.id) { seenRow.current = row.id; setAnswers(init); return; }
    setAnswers((prev) => ({ ...init, ...prev }));
  }, [row?.id, row?.questions, row?.answers]);
  const asking = !!row?.questions && (row.status === 'QUESTIONS' || editing);
  const missing = row?.questions ? missingRequired(row.questions, answers) : [];

  const submit = useMutation({
    mutationFn: (skip: boolean) => api<DraftRow>(`/api/remediation/drafts/${encodeURIComponent(id!)}/answers`, {
      method: 'POST', body: JSON.stringify({ answers: skip ? {} : answers, skip }),
    }),
    onSuccess: (r) => { setErr(''); setEditing(false); setForm(null); setDirty(false); qc.setQueryData(['remediation-draft', r.id], r); onChanged(); },
    onError: (e: Error) => setErr(e.message),
  });

  // tell the page when a draft finishes, so its chip changes
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (row?.status && lastStatus.current && lastStatus.current !== row.status) onChanged();
    lastStatus.current = row?.status;
  }, [row?.status, onChanged]);

  // the editable copy: taken from the server until the person edits it
  useEffect(() => {
    if (row?.draft && typeof row.draft === 'object' && !dirty) setForm(structuredClone(row.draft as Json));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.draft]);

  // elapsed time while the model writes
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning(row?.status) && !start.isPending) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [row?.status, start.isPending]);
  const began = row?.created_at ? Date.parse(row.created_at) : NaN;
  const elapsed = Number.isFinite(began) ? Math.max(0, Math.round((now - began) / 1000)) : 0;

  const persist = async () => {
    if (!id || !form || !dirty) return;
    const r = await api<DraftRow>(`/api/remediation/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ draft: form }) });
    qc.setQueryData(['remediation-draft', id], r);
    setDirty(false);
  };
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setErr('');
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const save = () => run('save', async () => {
    await persist();
    await api<{ entity_id: string; domain: string }>(`/api/remediation/drafts/${encodeURIComponent(id!)}/save`, { method: 'POST' });
    await q.refetch();
    onChanged();
  });
  const download = (fmt: string) => run(`dl-${fmt}`, async () => {
    await persist();
    await downloadFile(`/api/remediation/drafts/${encodeURIComponent(id!)}/download?format=${fmt}`, {}, `${req.code}-${req.kind}-draft.${fmt}`);
  });
  // drafting again reuses the answers; a draft from before the questionnaire starts one
  const regenerate = () => {
    if (dirty && !window.confirm(tr('Discard your edits and draft it again with the local AI?'))) return;
    if (row?.questions) submit.mutate(!row.answers || !Object.keys(row.answers).length);
    else start.mutate(true);
  };
  const changeAnswers = () => {
    if (dirty && !window.confirm(tr('Your edits to this draft are replaced when it is drafted again. Continue?'))) return;
    setEditing(true);
  };
  const openRecord = async (entityId: string) => {
    onClose();
    // the new record is not in the client store until it reloads
    await useData.getState().hydrate();
    if (entityById(entityId)) useUi.getState().openEntity(entityId);
    else navigate(`/${meta.domain}`);
  };

  const pill = STATUS_PILL[status];
  const draftObj = form ?? (row?.draft && typeof row.draft === 'object' ? (row.draft as Json) : null);
  const unparsed = row?.status === 'READY' && typeof row.draft === 'string';
  const running = isRunning(row?.status) || submit.isPending || (start.isPending && !row);
  const loadingRow = !!id && !row && !q.error;

  return (
    <SidePanel onClose={onClose} labelledBy="rd-title">
      <PanelHeader
        id="rd-title"
        eyebrow={<span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-brand-600" />{tr('AI draft')} · {llm?.model ?? tr('local model')}</span>}
        title={`${tr(meta.action)} · ${req.code}`}
        badges={<span className={cn('pill px-2 py-0.5 text-[11px]', toneClass(pill.tone))}>{tr(pill.label)}</span>}
        onClose={onClose}
      />
      <div className={cn(DRAWER.body, 'border-t border-line')}>
        {/* what the draft is for */}
        <section className="rounded-xl border border-line bg-slate-50/70 p-3.5 text-[12.8px] leading-relaxed">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('pill px-2 py-0.5 text-[11px]', toneClass(req.item.st === 'MET' ? 'green' : req.item.st === 'PARTIAL' ? 'amber' : req.item.st === 'NOT_COVERED' ? 'orange' : 'red'))}
                  title={tr(MEANING[req.item.st])}>{tr(req.item.st.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))}</span>
            {req.item.rk && req.item.rk !== 'None' && <span className="pill bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{riskPhrase(tr, req.item.rk)}</span>}
          </div>
          <p className="mt-2 text-ink"><b className="font-semibold">{tr('Requirement')}:</b> {req.item.t}</p>
          {req.item.gap && <p className="mt-1 text-critical-700"><b className="font-semibold">{tr('What is missing')}:</b> {req.item.gap}</p>}
          {req.item.fix && <p className="mt-1 text-ink-2"><b className="font-semibold">{tr('Fix')}:</b> {req.item.fix}</p>}
        </section>

        {err && <Callout tone="red" title="That did not work">{err}</Callout>}

        {loadingRow && <p className="text-[13px] text-muted">{tr('Loading the draft…')}</p>}
        {q.error && <Callout tone="red" title="Could not load the draft">{(q.error as Error).message}</Callout>}
        {status === 'NONE' && !start.isPending && !loadingRow && (
          llmDown
            ? <Callout tone="amber" title={tr(NEEDS_LLM)}>{llm?.message ?? tr('The local AI model is not reachable from this server.')}</Callout>
            : <Callout tone="blue" title={tr(KIND_TEXT[req.kind].start)}>{tr("It asks a few questions first, then reads this duty, its gap, the hospital's documents and your answers, and writes a first draft for you to review.")}</Callout>
        )}

        {asking && row?.questions && (
          <DraftQuestionnaire questions={row.questions} value={answers} onChange={setAnswers} code={req.code} />
        )}

        {running && (
          <section aria-live="polite" className="space-y-2.5 rounded-xl border border-brand-100 bg-brand-50/40 p-3.5">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Sparkles className="h-4 w-4 text-brand-600" /> {row?.message || tr('Starting…')}
            </div>
            <div className="rd-indet" role="progressbar" aria-label={tr('Drafting in progress')} />
            <div className="flex flex-wrap gap-x-4 text-[12px] tabular-nums text-muted">
              <span>{tr('{n}s elapsed', { n: elapsed })}</span>
              <span>{tr('{n} characters written', { n: (row?.partial?.length ?? 0).toLocaleString() })}</span>
              <span>{tr('usually 1–2 minutes')}</span>
            </div>
            {row?.partial && (
              <Preview text={row.partial} />
            )}
            <p className="text-[11.5px] text-muted">{tr('You can close this panel — drafting continues and the button in the table shows when it is ready.')}</p>
          </section>
        )}

        {row?.status === 'FAILED' && (
          <Callout tone="red" title="The draft failed">{row.error || row.message || tr('The local AI did not return a draft.')}</Callout>
        )}

        {row?.status === 'SAVED' && row.entity_id && (
          <Callout tone="green" title={tr(KIND_TEXT[req.kind].saved)}>
            <span className="block">{tr("It is marked Draft / Pending review. The gap's status does not change until the assessment is re-run against the approved document.")}</span>
            <button type="button" className="btn btn-sm mt-2" onClick={() => void openRecord(row.entity_id!)}>
              <Icon name="ExternalLink" className="h-3.5 w-3.5" /> {tr('Open record')}
            </button>
          </Callout>
        )}

        {unparsed && (
          <Callout tone="amber" title="The model's answer could not be read as a form">
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11.5px]">{String(row?.draft)}</pre>
          </Callout>
        )}

        {draftObj && !running && !editing && (row?.status === 'READY' || row?.status === 'SAVED') && (<>
          {row.questions && <AnswersUsed questions={row.questions} answers={row.answers ?? {}} />}
          <DraftForm value={draftObj} onChange={(v) => { setForm(v); setDirty(true); }} />
        </>)}
      </div>

      <div className={DRAWER.footer}>
        {asking && !running ? (
          <>
            <button type="button" className="btn btn-primary" disabled={submit.isPending || missing.length > 0}
                    title={missing.length ? tr('Answer first: {questions}', { questions: missing.map((m) => m.q).join('; ') }) : tr('Write the draft with these answers')}
                    onClick={() => submit.mutate(false)}>
              <Sparkles className="h-4 w-4" /> {tr(editing ? 'Draft again with these answers' : 'Draft with my answers')}
            </button>
            {editing
              ? <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>{tr('Cancel')}</button>
              : <button type="button" className="btn btn-ghost" disabled={submit.isPending} onClick={() => submit.mutate(true)}
                        title={tr('Draft without answers. The draft keeps [placeholders] for everything the records do not say.')}>
                  {tr('Skip, use placeholders')}
                </button>}
            {llmDown && <span className="text-[11.5px] text-warning-700">{tr('The local AI is offline; drafting starts when it is running.')}</span>}
          </>
        ) : (row?.status === 'READY' || row?.status === 'SAVED') && draftObj ? (
          <>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={save}>
              {tr(busy === 'save' ? 'Saving…' : row.status === 'SAVED' ? 'Update draft record' : 'Save as draft record')}
            </button>
            <DownloadMenu busy={busy.startsWith('dl-')} onPick={download} />
            {row.questions && (
              <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={changeAnswers} title={tr('Change your answers and draft it again')}>
                {tr('Change answers')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={!!busy || llmDown} onClick={regenerate}
                    title={tr(llmDown ? NEEDS_LLM : row.questions ? 'Draft it again with the same answers' : 'Draft it again from scratch')}>
              <RefreshCw className="h-4 w-4" /> {tr('Regenerate')}
            </button>
          </>
        ) : row?.status === 'FAILED' || (status === 'NONE' && !start.isPending && !loadingRow) ? (
          <button type="button" className="btn btn-primary" disabled={start.isPending || submit.isPending}
                  onClick={() => (row?.status === 'FAILED' && row.questions ? setEditing(true) : start.mutate(row?.status === 'FAILED'))}>
            <Sparkles className="h-4 w-4" /> {tr(row?.status === 'FAILED' ? 'Try again' : 'Start: answer a few questions')}
          </button>
        ) : null}
        {dirty && <span className="text-[11.5px] text-muted">{tr('Unsaved edits — saved when you save or download')}</span>}
        <button type="button" className="btn ml-auto" onClick={onClose}>{tr('Close')}</button>
      </div>
    </SidePanel>
  );
}

/** The streamed text so far, scrolled to the newest line. */
function Preview({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <pre ref={ref} className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
      {text.slice(-1800)}
    </pre>
  );
}

function DownloadMenu({ busy, onPick }: { busy: boolean; onPick: (fmt: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn btn-outline" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}>
        <Download className="h-4 w-4" /> {t(busy ? 'Preparing…' : 'Download')} <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-10 mb-1.5 min-w-[180px] rounded-lg border border-line bg-white p-1.5 shadow-pop">
          {DRAFT_FORMATS.map((f) => (
            <button key={f.fmt} type="button" role="menuitem" className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-brand-50 hover:text-brand-700"
                    onClick={() => { setOpen(false); onPick(f.fmt); }}>{t(f.label)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the editable draft */

const LONG = new Set(['purpose', 'scope', 'policy_statement', 'monitoring', 'description', 'cause', 'consequence', 'objective',
  'test_procedure', 'pass_criteria', 'how_to_verify', 'sampling']);
/** the row shape for an empty list the model may leave out */
const TEMPLATES: Record<string, Json> = {
  definitions: { term: '', meaning: '' },
  responsibilities: { role: '', duty: '' },
  treatment_actions: { action: '', owner_role: '', due_in_days: 30 },
  items: { evidence: '', description: '', form_or_record: '', owner_role: '', frequency: '', retention: '' },
};
const human = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Renders whatever keys the model returned: text, long text, numbers, lists of text, lists of rows, nested objects. */
function DraftForm({ value, onChange }: { value: Json; onChange: (v: Json) => void }) {
  const t = useT();
  const keys = Object.keys(value).sort((a, b) => (a === 'title' ? -1 : b === 'title' ? 1 : 0));
  return (
    <section className="space-y-4" aria-label={t('Draft')}>
      <div className="sec-eyebrow">{t('The draft — edit anything before saving')}</div>
      {keys.map((k) => (
        <FieldEditor key={k} k={k} v={value[k]} title={k === 'title'} onChange={(nv) => onChange({ ...value, [k]: nv })} />
      ))}
    </section>
  );
}

function FieldEditor({ k, v, onChange, title = false, compact = false }: { k: string; v: unknown; onChange: (v: unknown) => void; title?: boolean; compact?: boolean }) {
  const t = useT();
  // the model's field names ("policy_statement") are keys; their readable English is translated
  const name = t(human(k));
  const label = <span className={cn('mb-1 block font-medium text-muted', compact ? 'text-[11px]' : 'text-xs')}>{name}</span>;
  if (Array.isArray(v)) {
    const rows = v.some((x) => isObj(x)) || (v.length === 0 && TEMPLATES[k]);
    return (
      <div>
        {label}
        {rows
          ? <RowsEditor k={k} list={v as Json[]} onChange={onChange} />
          : <ListEditor k={k} list={v.map((x) => (x == null ? '' : String(x)))} onChange={onChange} />}
      </div>
    );
  }
  if (isObj(v)) {
    return (
      <div>
        {label}
        <div className="space-y-2 rounded-lg border border-line p-2.5">
          {Object.keys(v).map((sk) => <FieldEditor key={sk} k={sk} v={v[sk]} compact onChange={(nv) => onChange({ ...v, [sk]: nv })} />)}
        </div>
      </div>
    );
  }
  if (typeof v === 'number') {
    return (
      <label className="block">
        {label}
        <input type="number" className="input h-8 text-[13px]" value={Number.isFinite(v) ? v : ''} aria-label={name}
               onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
      </label>
    );
  }
  const s = v == null ? '' : String(v);
  const long = !title && (LONG.has(k) || s.length > 90);
  return (
    <label className="block">
      {label}
      {long ? (
        <textarea className="input min-h-[84px] w-full resize-y py-2 text-[13px] leading-relaxed" value={s} aria-label={name}
                  rows={Math.min(10, Math.max(3, Math.ceil(s.length / 70)))} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cn('input', title ? 'h-10 text-[15px] font-semibold' : compact ? 'h-8 text-[12.5px]' : 'text-[13px]')} value={s}
               aria-label={name} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function ListEditor({ k, list, onChange }: { k: string; list: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const name = t(human(k));
  return (
    <div className="space-y-1.5">
      {list.map((item, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
          <textarea className="input min-h-[34px] flex-1 resize-y py-1.5 text-[13px]" rows={Math.min(5, Math.max(1, Math.ceil(item.length / 60)))}
                    value={item} aria-label={`${name} ${i + 1}`}
                    onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-critical-50 hover:text-critical-600"
                  aria-label={t('Remove {name}', { name: `${name} ${i + 1}` })} onClick={() => onChange(list.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...list, ''])}><Plus className="h-3.5 w-3.5" /> {t('Add')}</button>
    </div>
  );
}

function RowsEditor({ k, list, onChange }: { k: string; list: Json[]; onChange: (v: Json[]) => void }) {
  const t = useT();
  const first = list.find(isObj);
  const blank: Json = TEMPLATES[k] ?? (first ? Object.fromEntries(Object.entries(first).map(([kk, vv]) => [kk, typeof vv === 'number' ? 0 : ''])) : { text: '' });
  return (
    <div className="space-y-2">
      {list.map((item, i) => {
        const obj: Json = isObj(item) ? item : { text: item == null ? '' : String(item) };
        return (
          <div key={i} className="relative space-y-2 rounded-lg border border-line bg-white p-2.5 pr-10">
            {Object.keys(obj).map((sk) => (
              <FieldEditor key={sk} k={sk} v={obj[sk]} compact onChange={(nv) => onChange(list.map((x, j) => (j === i ? { ...obj, [sk]: nv } : x)))} />
            ))}
            <button type="button" className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-critical-50 hover:text-critical-600"
                    aria-label={t('Remove {name} row {n}', { name: t(human(k)), n: i + 1 })} onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...list, { ...blank }])}><Plus className="h-3.5 w-3.5" /> {t('Add row')}</button>
    </div>
  );
}
