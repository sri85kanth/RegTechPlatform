/**
 * The quieter tabs of Risk review, and adding a risk of one's own:
 *
 *   Questions    the facts that decide whether a library risk applies (G9). One
 *                answer settles every possible risk that waits on it.
 *   Rulebook     publishing a rulebook version (G8): a dry run shows which
 *                verdicts would change; an admin and a governor approve.
 *   Add a risk   a risk no library foresaw (lens 5). The person picks its theme and
 *                impact basis; the rules score it like any other.
 */
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { SidePanel, PanelHeader } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { Callout, Skeleton } from '@/components/ui/primitives';
import { can, useMe } from '@/services/authApi';
import { useRiskMeta } from '@/services/riskApi';
import {
  useAddRisk, useAnswerQuestion, useDecidePublication, usePublication, useQuestions, useRequestPublication,
  type Question,
} from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';
import { FieldRow, Pill } from '../riskUi';
import { BAND_LABEL } from '../labels';
import { QUESTION_HINT, QUESTION_LABEL, VERDICT_LABEL } from './reviewLabels';

// ------------------------------------------------------------------ questions
/**
 * A short guided questionnaire, not a wall of cards: progress first, then the
 * questions still open — the one that settles the most possible risks on top —
 * then what is already answered, each changeable. Counts are distinct possible
 * risks (review.questions), so no question claims more risks than exist.
 */
export function QuestionsTab() {
  const t = useT();
  const { data, isLoading, error } = useQuestions();
  const { data: me } = useMe();
  if (isLoading) return <Skeleton rows={6} />;
  if (error || !data) return <p className="text-critical-600">{(error as Error)?.message}</p>;
  const canAnswer = can(me, 'approve');
  const open = data.items.filter((q) => q.value == null).sort((a, b) => b.waiting - a.waiting);
  const answered = data.items.filter((q) => q.value != null);
  const possible = data.possible;

  return (
    <div className="max-w-5xl space-y-5">
      <section className="card flex flex-wrap items-center gap-5 p-5">
        <ProgressRing done={answered.length} total={data.items.length} />
        <div className="min-w-[240px] flex-1">
          <p className="text-[12px] font-semibold text-brand-600">{t('{n} of {m} answered', { n: answered.length, m: data.items.length })}</p>
          <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">{t('A few answers decide which library risks apply')}</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
            {t('The library serves every kind of organisation. Each answer settles every possible risk that depends on it; none is dropped without one.')}
          </p>
        </div>
        {possible != null && possible > 0 && (
          <div className="rounded-2xl bg-slate-50 px-5 py-3 text-right">
            <div className="text-[26px] font-semibold leading-none tabular-nums text-ink">{possible.toLocaleString()}</div>
            <div className="mt-1 text-[12px] text-muted">
              {possible === 1 ? t('possible risk waits on these answers') : t('possible risks wait on these answers')}
            </div>
          </div>
        )}
      </section>

      {open.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Still to answer')}</h3>
          <ul className="card divide-y divide-line overflow-hidden p-0">
            {open.map((q, i) => <QuestionRow key={q.key} q={q} canAnswer={canAnswer} top={i === 0 && q.waiting > 0} />)}
          </ul>
        </section>
      ) : (
        <Callout tone="green" icon="CheckCircle2" title={t('Every question is answered')}>
          {t('Change any answer below if it was wrong; the register follows.')}
        </Callout>
      )}

      {answered.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Answered')}</h3>
          <ul className="card divide-y divide-line overflow-hidden p-0">
            {answered.map((q) => <QuestionRow key={q.key} q={q} canAnswer={canAnswer} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 24, c = 2 * Math.PI * r;
  const part = total ? done / total : 0;
  return (
    <span className="relative grid h-16 w-16 shrink-0 place-items-center" aria-hidden="true">
      <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-100" />
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${part * c} ${c}`} className="text-brand-500 transition-[stroke-dasharray] duration-700" />
      </svg>
      <span className="text-[13px] font-semibold tabular-nums text-ink">{done}/{total}</span>
    </span>
  );
}

function QuestionRow({ q, canAnswer, top = false }: { q: Question; canAnswer: boolean; top?: boolean }) {
  const t = useT();
  const locale = useDateLocale();
  const answer = useAnswerQuestion();
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(q.value == null ? '' : String(q.value));
  const numeric = q.key === 'employees';
  const answered = q.value != null;
  const showControl = canAnswer && (!answered || editing);
  const send = (value: boolean | number) => answer.mutate({ key: q.key, value }, { onSuccess: () => setEditing(false) });
  const hint = QUESTION_HINT[q.key];
  const source = q.source === 'answered'
    ? t('Answered by {who}', { who: q.answeredBy ?? '' }) +
      (q.answeredAt ? ` · ${new Date(q.answeredAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}` : '')
    : q.source === 'records' ? t('From the company records') : null;

  return (
    <li className={cn('relative flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4', top && 'bg-brand-50/40')}>
      {top && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-brand-500" />}
      <div className="min-w-[260px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-semibold text-ink">{t(QUESTION_LABEL[q.key] ?? q.question)}</p>
          {top && <Pill className="bg-brand-100 text-brand-700">{t('Biggest effect')}</Pill>}
        </div>
        {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{t(hint)}</p>}
        {(source || q.waiting > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
            {source && <span className="text-muted">{source}</span>}
            {q.waiting > 0 && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 font-medium text-ink-2">
                {q.waiting === 1 ? t('Settles 1 possible risk') : t('Settles {n} possible risks', { n: q.waiting.toLocaleString() })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {answered && !editing && (
          <>
            <Pill className={numeric ? 'bg-slate-100 text-ink-2' : q.value ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}>
              {numeric ? t('{n} people', { n: Number(q.value).toLocaleString() }) : q.value ? <><Check className="h-3.5 w-3.5" /> {t('Yes')}</> : <><X className="h-3.5 w-3.5" /> {t('No')}</>}
            </Pill>
            {canAnswer && (
              <button type="button" className="rounded-full px-2.5 py-1 text-[12.5px] font-semibold text-brand-600 hover:bg-brand-50"
                      onClick={() => setEditing(true)}>
                {t('Change')}
              </button>
            )}
          </>
        )}
        {showControl && (numeric ? (
          <>
            <input type="number" min={0} className="input h-9 w-28 tabular-nums" value={n} onChange={(e) => setN(e.target.value)} aria-label={t('Number of people')} />
            <button type="button" className="btn btn-sm h-9" disabled={answer.isPending || n === ''} onClick={() => send(Number(n))}>{t('Save')}</button>
          </>
        ) : (
          <div role="radiogroup" aria-label={t(QUESTION_LABEL[q.key] ?? q.question)} className="inline-flex rounded-xl bg-black/[0.05] p-1">
            {([true, false] as const).map((v) => {
              const on = q.value === v;
              return (
                <button key={String(v)} type="button" role="radio" aria-checked={on} disabled={answer.isPending}
                        onClick={() => send(v)}
                        className={cn('h-9 min-w-[76px] rounded-lg px-4 text-[13px] font-semibold transition-all duration-200 active:scale-95 disabled:opacity-60',
                          on ? 'bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-ink-2 hover:bg-white/70')}>
                  {v ? t('Yes') : t('No')}
                </button>
              );
            })}
          </div>
        ))}
        {editing && (
          <button type="button" className="rounded-full px-2 py-1 text-[12.5px] text-muted hover:text-ink" onClick={() => setEditing(false)}>{t('Cancel')}</button>
        )}
      </div>
      {(answer.isPending || answer.error) && (
        <p role={answer.error ? 'alert' : 'status'} className={cn('w-full text-[12.5px]', answer.error ? 'text-critical-600' : 'text-muted')}>
          {answer.error ? answer.error.message : t('Re-assessing…')}
        </p>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ rulebook (G8)
export function RulebookTab() {
  const t = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();
  const { data, isLoading, error } = usePublication();
  const request = useRequestPublication();
  const decide = useDecidePublication();
  const [note, setNote] = useState('');
  if (isLoading) return <Skeleton rows={5} />;
  if (error || !data) return <p className="text-critical-600">{(error as Error)?.message}</p>;
  const p = data.pending;
  const date = (s: string) => new Date(s).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const err = request.error ?? decide.error;
  return (
    <div className="max-w-3xl space-y-4">
      <section className="card p-5">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('Rulebook in use')}</p>
        <p className="mt-1 text-[18px] font-semibold text-ink">{data.rulebook.name} {data.rulebook.version}</p>
        <p className="mt-0.5 font-mono text-[11.5px] text-muted">{data.rulebook.chain.join(' → ')} · {data.rulebook.hash.slice(7, 19)}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          {data.current
            ? t('Published on {d} by {admin} (admin) and {gov} (governor).', { d: date(data.published!.decided_at ?? data.published!.created_at), admin: data.published!.admin_by ?? '', gov: data.published!.governor_by ?? '' })
            : t('Not yet published. Scores are computed with it, and every one records its version and hash; publishing is the sign-off that it is the rulebook in force.')}
        </p>
        {!data.current && !p && can(me, 'approve') && (
          <button type="button" className="btn btn-primary mt-3" disabled={request.isPending} onClick={() => request.mutate()}>
            {request.isPending ? t('Running the dry run…') : t('Ask to publish')}
          </button>
        )}
      </section>
      {p && p.diff && (
        <section className="card space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-ink">{t('Waiting for approval')}</p>
            <Pill className="bg-amber-50 text-amber-700">{t('Asked by {who}', { who: p.requested_by })}</Pill>
          </div>
          <p className="text-[13px] text-ink-2">
            {t('Dry run: {n} of {m} verdicts would change.', { n: p.diff.verdictChanges, m: p.diff.risks })}
          </p>
          {p.diff.topMovers.length > 0 && (
            <ul className="space-y-1 text-[12.5px]">
              {p.diff.topMovers.map((m) => (
                <li key={m.risk} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <span className="text-muted">{t(BAND_LABEL[m.before])} → {t(BAND_LABEL[m.after])}</span></li>
              ))}
            </ul>
          )}
          {p.diff.changes.length > 0 && (
            <ul className="space-y-1 text-[12.5px]">
              {p.diff.changes.slice(0, 10).map((c) => (
                <li key={c.risk} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="text-muted">{c.before ? t(VERDICT_LABEL[c.before]) : '—'} → {t(VERDICT_LABEL[c.after])}</span></li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Approval label={t('Admin')} by={p.admin_by} />
            <Approval label={t('Governor')} by={p.governor_by} />
          </div>
          <FieldRow label="Note" hint="Needed to reject.">
            <input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </FieldRow>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, approve: true, note })}>
              <Check className="h-4 w-4" /> {t('Approve')}
            </button>
            <button type="button" className="btn" disabled={decide.isPending || !note.trim()} onClick={() => decide.mutate({ id: p.id, approve: false, note })}>
              <X className="h-4 w-4" /> {t('Reject')}
            </button>
          </div>
        </section>
      )}
      {err && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{err.message}</p>}
    </div>
  );
}

function Approval({ label, by }: { label: string; by: string | null }) {
  const t = useT();
  return (
    <div className={cn('rounded-xl border px-3 py-2', by ? 'border-emerald-200 bg-emerald-50/60' : 'border-line')}>
      <p className="text-[12px] font-semibold text-ink-2">{label}</p>
      <p className={cn('text-[12.5px]', by ? 'text-emerald-800' : 'text-muted')}>{by ?? t('Not yet')}</p>
    </div>
  );
}

// ------------------------------------------------------------------ add a risk (lens 5)
const DIMENSIONS: [string, string][] = [
  ['operational', tx('Operational')], ['financial', tx('Financial')], ['regulatory', tx('Regulatory')],
  ['reputational', tx('Reputational')], ['safety', tx('Safety')],
];
const HOW_OFTEN: [string, string][] = [['frequent', tx('Frequent')], ['occasional', tx('Occasional')], ['rare', tx('Rare')]];

export function AddRiskPanel({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const t = useT();
  const { data: meta } = useRiskMeta();
  const add = useAddRisk();
  const [title, setTitle] = useState('');
  const [theme, setTheme] = useState('');
  const [description, setDescription] = useState('');
  const [seeds, setSeeds] = useState<Record<string, string>>({});
  const [often, setOften] = useState('');
  const scored = Object.fromEntries(Object.entries(seeds).filter(([, v]) => v).map(([k, v]) => [k, Number(v)]));
  const ready = title.trim() && theme && often && Object.keys(scored).length > 0;
  return (
    <SidePanel onClose={onClose} labelledBy="add-risk">
      <PanelHeader id="add-risk" eyebrow={t('Risk review')} title={t('Add a risk')} onClose={onClose} />
      <div className={DRAWER.body}>
        <Callout tone="blue" icon="Info" title={t('For a risk the library did not foresee')}>
          {t('You classify it; the rules score it the same way as every other risk.')}
        </Callout>
        <FieldRow label="Title" required><input className="input w-full" value={title} onChange={(e) => setTitle(e.target.value)} /></FieldRow>
        <FieldRow label="Theme" required>
          <select className="input w-full" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="">{t('Choose')}</option>
            {(meta?.themes ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="What could happen"><textarea className="input min-h-[70px] w-full py-2" value={description} onChange={(e) => setDescription(e.target.value)} /></FieldRow>
        <fieldset>
          <legend className="mb-1 text-[12px] font-semibold text-ink-2">{t('How bad it would be, 1 to 5')}<span className="ml-0.5 text-critical-600">*</span></legend>
          <p className="mb-2 text-[11.5px] text-muted">{t('Score the kinds of impact that apply; leave the rest blank.')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DIMENSIONS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[13px]">
                <span className="w-28 text-ink-2">{t(label)}</span>
                <select className="input h-9 w-20" value={seeds[k] ?? ''} onChange={(e) => setSeeds({ ...seeds, [k]: e.target.value })}>
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
          </div>
        </fieldset>
        <FieldRow label="How often it could happen" required>
          <select className="input w-full" value={often} onChange={(e) => setOften(e.target.value)}>
            <option value="">{t('Choose')}</option>
            {HOW_OFTEN.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
          </select>
        </FieldRow>
        {add.error && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{add.error.message}</p>}
      </div>
      <div className={DRAWER.footer}>
        <button type="button" className="btn ml-auto" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!ready || add.isPending}
                onClick={() => add.mutate({ title, theme, description, seeds: scored, base_likelihood: often }, { onSuccess: (r) => onAdded(r.id) })}>
          {t('Add and score it')}
        </button>
      </div>
    </SidePanel>
  );
}
