/**
 * Facts to confirm — gate G2 (design §7). Values the system read from documents
 * or onboarding imports wait here, each with where it was read. Nothing uses
 * them until a person confirms, corrects or rejects them.
 */
import { useState } from 'react';
import { Check, FileSearch, Pencil, Sparkles, X } from 'lucide-react';
import { SidePanel, PanelHeader } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { can, useMe } from '@/services/authApi';
import { useDecideFact, useFacts, useProposeFacts, type Fact, type RecordKind } from '@/services/riskApi';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';
import { FieldRow, Pill } from './riskUi';
import { HISTORY_KIND_LABEL, METRIC_LABEL } from './labels';
import { RecordForm } from './RecordsTab';
import { KINDS } from './recordKinds';

const FACT_LABEL: Record<Fact['fact_key'], string> = {
  site: tx('Site'), licence: tx('Licence'), third_party: tx('Third party'), history: tx('History record'),
  'profile.beds': tx('Bed count'),
};
const FACT_KIND: Partial<Record<Fact['fact_key'], RecordKind>> = {
  site: 'sites', licence: 'licences', third_party: 'third_parties', history: 'history',
};
const STATUS_TONE: Record<Fact['status'], string> = {
  PROPOSED: 'bg-amber-50 text-amber-700', CONFIRMED: 'bg-emerald-50 text-emerald-700',
  CORRECTED: 'bg-sky-50 text-sky-700', REJECTED: 'bg-slate-100 text-slate-600',
};
const STATUS_LABEL: Record<Fact['status'], string> = {
  PROPOSED: tx('Waiting'), CONFIRMED: tx('Confirmed'), CORRECTED: tx('Corrected'), REJECTED: tx('Rejected'),
};

export function FactsTab() {
  const t = useT();
  const { data: me } = useMe();
  const [show, setShow] = useState<'PROPOSED' | 'ALL'>('PROPOSED');
  const { data, isLoading, error } = useFacts(show);
  const propose = useProposeFacts();
  const [panel, setPanel] = useState<{ fact: Fact; mode: 'correct' | 'reject' } | null>(null);
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
          {t('Values read from documents and imports wait here, each with where it was read. Nothing uses them until a person confirms, corrects or rejects them.')}
        </p>
        <SegmentedControl ariaLabel="Show" value={show} onChange={setShow}
                          options={[{ key: 'PROPOSED', label: tx('Waiting') }, { key: 'ALL', label: tx('All') }]} />
        {can(me, 'propose') && (
          <button type="button" className="btn" disabled={propose.isPending} onClick={() => propose.mutate()}>
            <Sparkles className="h-4 w-4" /> {t('Look in onboarding data')}
          </button>
        )}
      </div>
      {propose.data && (
        <p className="rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] text-brand-700">
          {propose.data.proposed
            ? t('{n} new facts proposed from onboarding data.', { n: propose.data.proposed })
            : t('Nothing new found in onboarding data.')}
        </p>
      )}
      {propose.error && <p role="alert" className="text-[12.5px] text-critical-600">{propose.error.message}</p>}

      {isLoading ? <Skeleton rows={4} />
        : error ? <p className="text-critical-600">{(error as Error).message}</p>
        : items.length === 0 ? (
          <div className="rounded-card border border-line bg-surface p-6 shadow-card">
            <EmptyState icon="FileSearch" title={show === 'PROPOSED' ? t('Nothing waiting for confirmation.') : t('No facts yet.')} />
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {items.map((f) => (
              <FactCard key={f.id} fact={f} canDecide={can(me, 'approve')}
                        onCorrect={() => setPanel({ fact: f, mode: 'correct' })}
                        onReject={() => setPanel({ fact: f, mode: 'reject' })} />
            ))}
          </ul>
        )}

      {panel && <DecidePanel {...panel} onClose={() => setPanel(null)} />}
    </div>
  );
}

function valueLines(f: Fact, v: Record<string, unknown>, t: (s: string) => string): [string, string][] {
  const kind = FACT_KIND[f.fact_key];
  if (!kind) return Object.entries(v).map(([k, x]) => [t(METRIC_LABEL[k] ?? k), String(x)]);
  return KINDS[kind].fields
    .filter((fd) => v[fd.key] != null && v[fd.key] !== '')
    .map((fd) => {
      const x = v[fd.key];
      const shown = fd.key === 'kind' && f.fact_key === 'history' ? t(HISTORY_KIND_LABEL[String(x)] ?? String(x))
        : Array.isArray(x) ? x.join(', ') : typeof x === 'object' ? JSON.stringify(x) : String(x);
      return [t(fd.label), shown];
    });
}

function FactCard({ fact, canDecide, onCorrect, onReject }: { fact: Fact; canDecide: boolean; onCorrect: () => void; onReject: () => void }) {
  const t = useT();
  const locale = useDateLocale();
  const decide = useDecideFact();
  const shown = fact.corrected_value ?? fact.value;
  return (
    <li className="flex flex-col rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-brand-600">{t(FACT_LABEL[fact.fact_key])}</span>
        <Pill className={STATUS_TONE[fact.status]}>{t(STATUS_LABEL[fact.status])}</Pill>
        <span className="ml-auto text-[11.5px] text-muted">
          {new Date(fact.created_at).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {valueLines(fact, shown, t).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>
        ))}
      </dl>
      {fact.corrected_value && (
        <p className="mt-2 text-[12px] text-muted">
          {t('Read as')}: {valueLines(fact, fact.value, t).map(([, v]) => v).join(' · ')}
        </p>
      )}
      {fact.citations.map((c, i) => (
        <figure key={i} className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[12.5px]">
          <figcaption className="flex flex-wrap items-center gap-1.5 font-semibold text-ink-2">
            <FileSearch className="h-3.5 w-3.5 text-muted" />
            {c.file_name ?? t('Unknown source')}
            {c.page != null && <span className="text-muted">· {t('page {n}', { n: c.page })}</span>}
            {c.section && <span className="text-muted">· {c.section}</span>}
          </figcaption>
          {c.quote && <blockquote className="mt-1 italic text-muted">“{c.quote}”</blockquote>}
        </figure>
      ))}
      <p className="mt-2 text-[11.5px] text-muted">
        {t('Read by {how}', { how: fact.extracted_by })}{fact.confidence != null && ` · ${t('confidence {n}', { n: fact.confidence })}`}
        {fact.note && ` · ${fact.note}`}
      </p>
      {canDecide && fact.status === 'PROPOSED' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
          <button type="button" className="btn btn-primary" disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: fact.id, decision: 'confirm' })}>
            <Check className="h-4 w-4" /> {t('Confirm')}
          </button>
          <button type="button" className="btn" onClick={onCorrect}><Pencil className="h-4 w-4" /> {t('Correct')}</button>
          <button type="button" className={cn('btn ml-auto text-critical-600')} onClick={onReject}><X className="h-4 w-4" /> {t('Reject')}</button>
          {decide.error && <p role="alert" className="w-full text-[12.5px] text-critical-600">{decide.error.message}</p>}
        </div>
      )}
    </li>
  );
}

function DecidePanel({ fact, mode, onClose }: { fact: Fact; mode: 'correct' | 'reject'; onClose: () => void }) {
  const t = useT();
  const decide = useDecideFact();
  const [note, setNote] = useState('');
  const [beds, setBeds] = useState(String((fact.value as { beds?: number }).beds ?? ''));
  const kind = FACT_KIND[fact.fact_key];
  const title = mode === 'reject' ? t('Reject this fact') : t('Correct this fact');
  return (
    <SidePanel onClose={onClose} labelledBy="fact-decide">
      <PanelHeader id="fact-decide" eyebrow={t(FACT_LABEL[fact.fact_key])} title={title} onClose={onClose} />
      {mode === 'correct' && kind ? (
        <RecordForm kind={kind} initial={fact.value} submitLabel={tx('Save the corrected value')} busy={decide.isPending}
                    error={decide.error?.message} onCancel={onClose}
                    onSubmit={(v) => decide.mutate({ id: fact.id, decision: 'correct', value: v }, { onSuccess: onClose })} />
      ) : (
        <>
          <div className={DRAWER.body}>
            {mode === 'correct' ? (
              <FieldRow label="Beds" required><input type="number" min={0} className="input w-32" value={beds} onChange={(e) => setBeds(e.target.value)} /></FieldRow>
            ) : (
              <FieldRow label="Why it is wrong" required>
                <textarea className="input min-h-[100px] w-full py-2" value={note} onChange={(e) => setNote(e.target.value)} />
              </FieldRow>
            )}
            {decide.error && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{decide.error.message}</p>}
          </div>
          <div className={DRAWER.footer}>
            <button type="button" className="btn ml-auto" onClick={onClose}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={decide.isPending || (mode === 'reject' ? !note.trim() : !beds)}
                    onClick={() => decide.mutate(
                      mode === 'reject' ? { id: fact.id, decision: 'reject', note } : { id: fact.id, decision: 'correct', value: { beds: Number(beds) } },
                      { onSuccess: onClose })}>
              {mode === 'reject' ? t('Reject') : t('Save the corrected value')}
            </button>
          </div>
        </>
      )}
    </SidePanel>
  );
}
