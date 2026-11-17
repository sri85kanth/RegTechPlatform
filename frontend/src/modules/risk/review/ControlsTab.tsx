/**
 * Controls in bulk. A risk cannot be scored until its controls are known, and
 * typing them one risk at a time is where a first register stalls. Two ways in:
 *
 *   From your controls   the controls the company already records, matched to
 *                        each risk's typical controls by the words they share.
 *                        Each match proposes a grade from that record's own
 *                        state and says why; nothing is written until chosen.
 *   The workbook         every risk and its controls in one Excel file. Fill
 *                        grade, evidence and date; upload; every row is checked
 *                        as if typed in; apply the rows that pass.
 *
 * The same rules hold either way: documented and tested need a compliance
 * manager, the evidence and its date.
 */
import { useMemo, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, Link2, Upload } from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { can, useMe } from '@/services/authApi';
import { downloadFile } from '@/modules/cascade/remediationApi';
import {
  useApplyMatches, useApplyWorkbook, useCheckWorkbook, useControlMatches, useRegister,
  type ControlMatch, type ImportCheck,
} from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import { Pill } from '../riskUi';
import { GRADE_LABEL } from './reviewLabels';

const GRADE_TONE: Record<string, string> = {
  TESTED: 'bg-emerald-50 text-emerald-700', DOCUMENTED: 'bg-sky-50 text-sky-700',
  CLAIMED: 'bg-amber-50 text-amber-700', ABSENT: 'bg-red-50 text-red-700',
};
/** the store's reasons for a proposed grade, in the reader's language */
const WHY: Record<string, string> = {
  'a recorded test passed': tx('a recorded test passed'),
  'tested and found not working': tx('tested and found not working'),
  'marked effective, with a test date and evidence': tx('marked effective, with a test date and evidence'),
  'evidence on file, no passed test': tx('evidence on file, no passed test'),
  'recorded as a control, but nothing on file shows it works': tx('recorded as a control, but nothing on file shows it works'),
};
const key = (m: Pick<ControlMatch, 'riskId' | 'controlKey' | 'sourceId'>) => `${m.riskId}|${m.controlKey}|${m.sourceId}`;

export function ControlsTab() {
  const t = useT();
  const { data: reg } = useRegister();
  const c = reg?.controls;
  const scored = c && c.risks ? Math.round(((c.risks - c.waitingOnControls) / c.risks) * 100) : 0;
  return (
    <div className="space-y-4">
      {c && (
        <section className="card flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-ink">
              {c.waitingOnControls === 0
                ? t('Every risk has its controls recorded.')
                : t('{n} of {m} risks cannot be scored until their controls are known.', { n: c.waitingOnControls, m: c.risks })}
            </p>
            <p className="mt-0.5 text-[12.5px] text-muted">
              {t('An unknown control is never taken as absent or as working. Bring in what you already have, then fill the gaps in the workbook.')}
            </p>
          </div>
          <div className="w-full max-w-[260px]">
            <div className="flex justify-between text-[12px] text-muted"><span>{t('Scored')}</span><span className="tabular-nums">{scored}%</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700" style={{ width: `${scored}%` }} />
            </div>
          </div>
        </section>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Matches />
        <Workbook />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ from your controls
function Matches() {
  const t = useT();
  const { data: me } = useMe();
  const { data, isLoading, error } = useControlMatches();
  const apply = useApplyMatches();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const out = new Map<string, { title: string; items: ControlMatch[] }>();
    for (const m of data?.items ?? []) {
      const g = out.get(m.riskId) ?? { title: m.riskTitle, items: [] };
      g.items.push(m);
      out.set(m.riskId, g);
    }
    return [...out.values()];
  }, [data]);
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const strong = (data?.items ?? []).filter((m) => m.strength === 'strong');
  const chosen = (data?.items ?? []).filter((m) => picked.has(key(m)));

  return (
    <section className="card flex min-h-0 flex-col p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Link2 className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">{t('From the controls you already have')}</h3>
          <p className="text-[12.5px] text-muted">{t('Matched by the words they share. Each proposes a grade from the record itself — tests, evidence, effectiveness — and says why.')}</p>
        </div>
      </div>
      {isLoading ? <div className="mt-4"><Skeleton rows={4} /></div>
        : error || !data ? <p className="mt-4 text-critical-600">{(error as Error)?.message}</p>
        : data.existing === 0 ? (
          <div className="mt-4"><EmptyState icon="ShieldCheck" title={t('No controls recorded yet.')} hint={t('Add them on the Controls page or in Add data, or use the workbook.')} /></div>
        ) : data.items.length === 0 ? (
          <div className="mt-4"><EmptyState icon="Search" title={t('No match among your {n} controls.', { n: data.existing })} hint={t('Use the workbook for the rest.')} /></div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm" disabled={!strong.length} onClick={() => setPicked(new Set(strong.map(key)))}>
                {t('Select the strong matches')}
              </button>
              {picked.size > 0 && <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>{t('Clear')}</button>}
              <span className="ml-auto text-[12px] text-muted">{t('{n} matches for {m} controls not yet known', { n: data.items.length, m: data.unknownControls })}</span>
            </div>
            <ul className="mt-3 max-h-[560px] space-y-3 overflow-y-auto pr-1">
              {groups.map((g) => (
                <li key={g.title} className="rounded-xl border border-line p-3">
                  <p className="text-[12px] font-semibold text-ink-2">{g.title}</p>
                  <ul className="mt-2 space-y-2">
                    {g.items.map((m) => (
                      <li key={key(m)}>
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1.5 hover:bg-slate-50">
                          <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={picked.has(key(m))} onChange={() => toggle(key(m))} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] text-muted">{m.control}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span className="text-[13px] font-medium text-ink">↔ {m.sourceName}</span>
                              <Pill className={GRADE_TONE[m.grade]}>{t(GRADE_LABEL[m.grade][0])}</Pill>
                              <Pill className={m.strength === 'strong' ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600'}>
                                {m.strength === 'strong' ? t('Strong match') : t('Possible match')}
                              </Pill>
                            </span>
                            <span className="mt-0.5 block text-[11.5px] text-muted">
                              {t(WHY[m.why] ?? m.why)}{m.evidence ? ` · ${m.evidence}` : ''} · {t('shared words: {w}', { w: m.shared.join(', ') })}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {!can(me, 'approve') && (
              <p className="mt-3 text-[12px] text-muted">{t('Tested and documented grades need a compliance manager; as a reviewer you can apply self-declared and absent ones.')}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <button type="button" className="btn btn-primary" disabled={!chosen.length || apply.isPending}
                      onClick={() => apply.mutate({ items: chosen.map(({ riskId, controlKey, sourceId }) => ({ riskId, controlKey, sourceId })) },
                        { onSuccess: () => setPicked(new Set()) })}>
                <Check className="h-4 w-4" /> {apply.isPending ? t('Re-assessing…') : t('Apply {n} selected', { n: chosen.length })}
              </button>
              {apply.data && (
                <span className="text-[12.5px] text-emerald-700">
                  {t('Controls recorded: {n}. Risks re-scored: {m}.', { n: apply.data.applied, m: apply.data.rescored })}
                </span>
              )}
            </div>
            {apply.data?.problems.length ? (
              <ul className="mt-2 space-y-1 text-[12px] text-critical-700">
                {apply.data.problems.map((p) => <li key={key(p)}>{p.sourceName}: {p.message}</li>)}
              </ul>
            ) : null}
            {apply.error && <p role="alert" className="mt-2 text-[12.5px] text-critical-600">{apply.error.message}</p>}
          </>
        )}
    </section>
  );
}

// ------------------------------------------------------------------ the workbook
const STATUS_TONE: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700', unchanged: 'bg-slate-100 text-slate-600',
  skipped: 'bg-slate-100 text-slate-600', problem: 'bg-red-50 text-red-700',
};

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function Workbook() {
  const t = useT();
  const check = useCheckWorkbook();
  const apply = useApplyWorkbook();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ fileName: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const result: ImportCheck | undefined = apply.data ?? check.data;

  const download = async () => {
    setBusy(true);
    setDlError(null);
    try { await downloadFile('/api/risk/controls/workbook', {}, 'risk-controls.xlsx'); }
    catch (e) { setDlError((e as Error).message); }
    finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    apply.reset();
    const b = { fileName: f.name, content: await readBase64(f) };
    setFile(b);
    check.mutate(b);
  };

  return (
    <section className="card p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><FileSpreadsheet className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">{t('Fill in the workbook')}</h3>
          <p className="text-[12.5px] text-muted">{t('Every risk and its controls in one Excel file, with what is already known filled in. Control owners can fill their part.')}</p>
        </div>
      </div>
      <ol className="mt-4 space-y-3 text-[13px]">
        <li className="flex items-start gap-3">
          <Step n={1} />
          <div className="min-w-0 flex-1">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={download}><Download className="h-3.5 w-3.5" /> {t('Download the workbook')}</button>
            {dlError && <p role="alert" className="mt-1 text-[12px] text-critical-600">{dlError}</p>}
          </div>
        </li>
        <li className="flex items-start gap-3">
          <Step n={2} />
          <p className="min-w-0 flex-1 pt-0.5 text-ink-2">{t('Fill the yellow columns: grade, evidence and its date. Leave a grade blank if you do not know it yet.')}</p>
        </li>
        <li className="flex items-start gap-3">
          <Step n={3} />
          <div className="min-w-0 flex-1">
            <input ref={input} type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="btn btn-sm" disabled={check.isPending} onClick={() => input.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> {check.isPending ? t('Checking…') : t('Upload the filled workbook')}
            </button>
            <p className="mt-1 text-[11.5px] text-muted">{t('.xlsx or .csv. Every row is checked first; nothing is written until you apply.')}</p>
          </div>
        </li>
      </ol>
      {check.error && <p role="alert" className="mt-3 rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{check.error.message}</p>}
      {result && file && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <p className="truncate text-[12px] text-muted">{file.fileName}</p>
          <div className="flex flex-wrap gap-1.5">
            <Pill className={STATUS_TONE.ready}>{t('{n} ready', { n: result.counts.ready })}</Pill>
            <Pill className={STATUS_TONE.unchanged}>{t('{n} unchanged', { n: result.counts.unchanged })}</Pill>
            <Pill className={STATUS_TONE.skipped}>{t('{n} left blank', { n: result.counts.skipped })}</Pill>
            {result.counts.problem > 0 && <Pill className={STATUS_TONE.problem}>{t('{n} with a problem', { n: result.counts.problem })}</Pill>}
          </div>
          {result.counts.problem > 0 && (
            <ul className="max-h-[220px] space-y-1.5 overflow-y-auto rounded-xl bg-red-50/60 p-3 text-[12px]">
              {result.rows.filter((r) => r.status === 'problem').map((r) => (
                <li key={r.row}>
                  <span className="font-semibold text-ink">{t('Row {n}', { n: r.row })}</span>
                  <span className="text-muted"> · {r.risk || r.riskId}{r.control ? ` · ${r.control}` : ''}</span>
                  <span className="block text-red-700">{r.message}</span>
                </li>
              ))}
            </ul>
          )}
          {apply.data ? (
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
              {t('Controls recorded: {n}. Risks re-scored: {m}.', { n: apply.data.applied ?? 0, m: apply.data.rescored ?? 0 })}
            </p>
          ) : (
            <button type="button" className={cn('btn btn-primary')} disabled={!result.counts.ready || apply.isPending}
                    onClick={() => apply.mutate(file)}>
              <Check className="h-4 w-4" /> {apply.isPending ? t('Re-assessing…') : t('Apply {n} rows', { n: result.counts.ready })}
            </button>
          )}
          {apply.error && <p role="alert" className="text-[12.5px] text-critical-600">{apply.error.message}</p>}
        </div>
      )}
    </section>
  );
}

function Step({ n }: { n: number }) {
  return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-[12px] font-semibold tabular-nums text-ink-2">{n}</span>;
}
