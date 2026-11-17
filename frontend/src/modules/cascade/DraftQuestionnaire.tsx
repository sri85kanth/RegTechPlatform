/**
 * The questions asked before the local AI writes a draft.
 *
 * Standard questions (fixed per kind) appear at once, pre-filled from what the
 * hospital already has on record; the questions the model writes for this one
 * duty arrive a little later and are added below. Every answer becomes a fact
 * the draft must use — so the draft states the hospital's real practice
 * instead of [placeholders].
 */
import { useMemo, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { useData } from '@/app/store/data';
import { ownerCandidates, personName, personRole } from '@/components/PeoplePicker';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import type { Answers, DraftQuestion, Questionnaire } from './remediationApi';

/**
 * Answers to start from: what was given before, else the suggestion from the
 * hospital's records. The model's own suggestions are never pre-filled — they
 * are offered, and a person has to take one, so a guess cannot reach the draft
 * as if it were the hospital's answer.
 */
export function initialAnswers(q: Questionnaire | null | undefined, given?: Answers | null): Answers {
  const out: Answers = {};
  [...(q?.base ?? []), ...(q?.specific ?? [])].forEach((x) => {
    const g = given?.[x.id];
    if (g !== undefined && g !== '' && !(Array.isArray(g) && !g.length)) { out[x.id] = g; return; }
    if (x.source === 'ai' || x.suggested === undefined || x.suggested === null || x.suggested === '') return;
    out[x.id] = Array.isArray(x.suggested) ? x.suggested.map(String) : String(x.suggested);
  });
  return out;
}

const asAnswer = (s: DraftQuestion['suggested']) => (Array.isArray(s) ? s.map(String) : String(s ?? ''));

export const answered = (v: Answers[string] | undefined) => (Array.isArray(v) ? v.length > 0 : !!(v ?? '').toString().trim());

export function missingRequired(q: Questionnaire | null | undefined, a: Answers): DraftQuestion[] {
  return [...(q?.base ?? []), ...(q?.specific ?? [])].filter((x) => x.required && !answered(a[x.id]));
}

export function DraftQuestionnaire({ questions, value, onChange, code }: {
  questions: Questionnaire; value: Answers; onChange: (a: Answers) => void; code: string;
}) {
  const t = useT();
  const entities = useData((s) => s.entities);
  // the people on record, as "Name — job title" suggestions for person questions
  const people = useMemo(() => ownerCandidates(entities).map((p) => {
    const role = personRole(p);
    return role ? `${personName(p)} — ${role}` : personName(p);
  }).sort(), [entities]);
  const all = [...questions.base, ...questions.specific];
  const done = all.filter((x) => answered(value[x.id])).length;
  const set = (id: string, v: string | string[]) => onChange({ ...value, [id]: v });

  return (
    <section className="space-y-4" aria-label={t('Questions before drafting')}>
      <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3.5 text-[12.8px] leading-relaxed text-ink-2">
        <div className="mb-1 flex items-center gap-2 font-semibold text-ink">
          <Sparkles className="h-4 w-4 text-brand-600" /> {t('A few questions first')}
        </div>
        {t('Your answers become facts in the draft, so it describes what the hospital actually does instead of [placeholders]. Answers marked “from records” are pre-filled from the hospital’s records: check them. The AI’s own suggestions are only offered, never filled in for you. Leave a question blank if you do not know; the draft keeps a placeholder there.')}
        <div className="mt-2 flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
            <span className="block h-full rounded-full bg-brand-500 transition-all" style={{ width: `${all.length ? (100 * done) / all.length : 0}%` }} />
          </span>
          <span className="text-xs font-semibold tabular-nums text-brand-700">{t('{n} of {total} answered', { n: done, total: all.length })}</span>
        </div>
      </div>

      <datalist id="rd-people">{people.map((p) => <option key={p} value={p} />)}</datalist>

      <div className="space-y-3.5">
        <div className="sec-eyebrow">{t('Standard questions')}</div>
        {questions.base.map((x, i) => <QuestionField key={x.id} n={i + 1} x={x} v={value[x.id]} onChange={(v) => set(x.id, v)} />)}
      </div>

      <div className="space-y-3.5">
        <div className="sec-eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-violet-600" />{t('About {code}: questions from the local AI', { code })}</div>
        {questions.specific_status === 'PENDING' && (
          <div className="flex items-center gap-2.5 rounded-xl border border-violet-100 bg-violet-50/50 px-3 py-2.5 text-[12.5px] text-violet-800" aria-live="polite">
            <i className="spin" aria-hidden="true" /> {t('The local AI is writing questions for this duty, usually within a minute. Start with the ones above.')}
          </div>
        )}
        {questions.specific_status === 'FAILED' && (
          <p className="text-[12.5px] text-muted">{questions.note || t('No questions were added for this duty.')} {t('The standard questions are enough to draft.')}</p>
        )}
        {questions.specific.map((x, i) => (
          <QuestionField key={x.id} n={questions.base.length + i + 1} x={x} v={value[x.id]} onChange={(v) => set(x.id, v)} />
        ))}
      </div>
    </section>
  );
}

function QuestionField({ n, x, v, onChange }: { n: number; x: DraftQuestion; v: Answers[string] | undefined; onChange: (v: string | string[]) => void }) {
  const t = useT();
  const ok = answered(v);
  const s = Array.isArray(v) ? '' : (v ?? '').toString();
  const hasSuggestion = x.suggested !== undefined && x.suggested !== null && x.suggested !== '';
  const isSuggested = hasSuggestion && JSON.stringify(v) === JSON.stringify(asAnswer(x.suggested));
  const ai = x.source === 'ai';
  // a records-based suggestion outside the offered options is still offered; the model's is offered below instead
  const options = useMemo(() => {
    const o = [...(x.options ?? [])];
    if (!ai) {
      const sug = Array.isArray(x.suggested) ? x.suggested.map(String) : x.suggested !== undefined ? [String(x.suggested)] : [];
      sug.forEach((y) => { if (y && !o.includes(y)) o.unshift(y); });
    }
    return o;
  }, [x.options, x.suggested, ai]);

  return (
    <div className={cn('rounded-xl border p-3 transition-colors', ok ? 'border-line bg-white' : 'border-dashed border-slate-300 bg-slate-50/50')}>
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold',
          ok ? 'bg-success-500 text-white' : 'bg-slate-200 text-slate-600')}>{ok ? <Check className="h-3 w-3" /> : n}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold leading-snug text-ink">
            {x.q}{x.required && <span className="text-critical-600" title={t('Needed to draft')}>*</span>}
            {ai && <span className="pill bg-violet-50 px-1.5 py-0 text-[10.5px] text-violet-700">{t('AI question')}</span>}
            {isSuggested && (ai
              ? <span className="pill bg-violet-50 px-1.5 py-0 text-[10.5px] text-violet-700" title={t("You took the AI's suggestion; check it is what the hospital does")}>{t('AI suggestion')}</span>
              : <span className="pill bg-amber-50 px-1.5 py-0 text-[10.5px] text-amber-700" title={t("Pre-filled from the hospital's records; change it if it is wrong")}>{t('from records')}</span>)}
          </div>
          {x.help && <p className="mt-0.5 text-xs leading-relaxed text-muted">{x.help}</p>}
          {ai && hasSuggestion && !ok && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-violet-50/70 px-2.5 py-1.5 text-[12px] text-violet-800">
              <span className="min-w-0">{t('AI suggestion, not from your records')}: <b>{Array.isArray(x.suggested) ? x.suggested.join(', ') : String(x.suggested)}</b></span>
              <button type="button" className="rounded-md border border-violet-200 bg-white px-2 py-0.5 text-[11.5px] font-semibold text-violet-700 hover:bg-violet-100"
                      onClick={() => onChange(asAnswer(x.suggested))}>{t('Use it')}</button>
            </div>
          )}
          <div className="mt-2">
            {x.type === 'long' ? (
              <textarea className="input min-h-[72px] w-full resize-y py-2 text-[13px]" value={s} aria-label={x.q}
                        onChange={(e) => onChange(e.target.value)} />
            ) : x.type === 'choice' ? (
              <Choice options={options} v={s} onChange={onChange} label={x.q} />
            ) : x.type === 'multi' ? (
              <Multi options={options} v={Array.isArray(v) ? v : s ? [s] : []} onChange={onChange} label={x.q} />
            ) : (
              <input className="input w-full text-[13px]" aria-label={x.q} value={s}
                     type={x.type === 'number' ? 'number' : x.type === 'date' ? 'date' : 'text'}
                     list={x.type === 'person' ? 'rd-people' : undefined}
                     placeholder={x.type === 'person' ? t('Type a name or role…') : undefined}
                     onChange={(e) => onChange(e.target.value)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One of a few options as chips, or your own words. */
function Choice({ options, v, onChange, label }: { options: string[]; v: string; onChange: (v: string) => void; label: string }) {
  const t = useT();
  const own = !!v && !options.includes(v);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={v === o} onClick={() => onChange(v === o ? '' : o)}
                  className={cn('rounded-full border px-2.5 py-1 text-[12.5px] transition',
                    v === o ? 'border-brand-500 bg-brand-600 text-white' : 'border-line bg-white text-ink-2 hover:border-brand-300 hover:bg-brand-50')}>
            {o}
          </button>
        ))}
      </div>
      <input className="input h-8 w-full text-[12.5px]" placeholder={t('…or type your own answer')} aria-label={t('{question}: own answer', { question: label })}
             value={own ? v : ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Several options: chips for a short list; a searchable picker for a long one (departments). */
function Multi({ options, v, onChange, label }: { options: string[]; v: string[]; onChange: (v: string[]) => void; label: string }) {
  const t = useT();
  const [q, setQ] = useState('');
  const toggle = (o: string) => onChange(v.includes(o) ? v.filter((x) => x !== o) : [...v, o]);
  if (options.length <= 10) {
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={v.includes(o)} onClick={() => toggle(o)}
                  className={cn('rounded-full border px-2.5 py-1 text-[12.5px] transition',
                    v.includes(o) ? 'border-brand-500 bg-brand-600 text-white' : 'border-line bg-white text-ink-2 hover:border-brand-300 hover:bg-brand-50')}>
            {v.includes(o) && <Check className="mr-1 inline h-3 w-3" />}{o}
          </button>
        ))}
      </div>
    );
  }
  const hits = options.filter((o) => !v.includes(o) && o.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  return (
    <div className="space-y-1.5">
      {v.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {v.map((o) => (
            <span key={o} className="inline-flex items-center gap-1 rounded-full bg-brand-600 py-1 pl-2.5 pr-1.5 text-[12.5px] text-white">
              {o}<button type="button" aria-label={t('Remove {name}', { name: o })} onClick={() => toggle(o)} className="rounded-full p-0.5 hover:bg-white/20"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <input className="input h-8 w-full text-[12.5px]" placeholder={t('Search departments to add…')} value={q} aria-label={label}
             onChange={(e) => setQ(e.target.value)} />
      {q && (
        <div className="flex flex-wrap gap-1.5">
          {hits.map((o) => (
            <button key={o} type="button" onClick={() => { toggle(o); setQ(''); }}
                    className="rounded-full border border-line bg-white px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-brand-300 hover:bg-brand-50">+ {o}</button>
          ))}
          {!hits.length && <span className="text-xs text-muted">{t('No match')}</span>}
        </div>
      )}
    </div>
  );
}

/** After drafting: the answers the draft was written from. */
export function AnswersUsed({ questions, answers }: { questions: Questionnaire; answers: Answers }) {
  const t = useT();
  const all = [...questions.base, ...questions.specific];
  const given = all.filter((x) => answered(answers[x.id]));
  return (
    <details className="rounded-xl border border-line bg-slate-50/60 px-3.5 py-2.5 text-[12.5px]">
      <summary className="cursor-pointer font-medium text-ink">
        {t('Written from your answers: {n} of {total} questions answered', { n: given.length, total: all.length })}
      </summary>
      <dl className="mt-2 space-y-1.5">
        {given.map((x) => {
          const a = answers[x.id];
          return (
            <div key={x.id}>
              <dt className="text-xs text-muted">{x.q}</dt>
              <dd className="text-ink">{Array.isArray(a) ? a.join(', ') : a}</dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
