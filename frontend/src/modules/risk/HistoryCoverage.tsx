/**
 * History coverage: for each kind of history, whether the last 36 months are
 * covered by records, by a signed attestation that there were none, or not at
 * all. "No records collected" is not "a clean history" (design §2.6): a kind
 * with neither blocks scoring.
 */
import { useState } from 'react';
import { CheckCircle2, CircleAlert, PenLine } from 'lucide-react';
import { SidePanel, PanelHeader } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { can, useMe } from '@/services/authApi';
import { useAttest, useAttestations, useRiskMeta } from '@/services/riskApi';
import { cn } from '@/utils/ui';
import { useDateLocale, useT } from '@/i18n';
import { FieldRow } from './riskUi';
import { HISTORY_KIND_LABEL } from './labels';

export function HistoryCoverage() {
  const t = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();
  const { data } = useAttestations();
  const { data: meta } = useRiskMeta();
  const [attest, setAttest] = useState<string | null>(null);
  const months = meta?.historyWindowMonths ?? 36;
  const cov = data?.coverage ?? {};
  const kinds = meta?.historyKinds ?? Object.keys(cov);
  const uncovered = kinds.filter((k) => !cov[k]?.status);
  const canAttest = can(me, 'approve');

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">{t('Is the last {n} months covered?', { n: months })}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {t('Each kind needs its records, or a signed statement that there were none. No records is not the same as a clean history.')}
          </p>
        </div>
        {canAttest && uncovered.length > 1 && (
          <button type="button" className="btn" onClick={() => setAttest('ALL')}>
            <PenLine className="h-4 w-4" /> {t('Attest none of any kind')}
          </button>
        )}
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {kinds.map((k) => {
          const c = cov[k] ?? { status: null };
          return (
            <li key={k} className={cn('flex items-start gap-2.5 rounded-xl px-3 py-2.5',
              c.status ? 'bg-emerald-50/70' : 'bg-amber-50/80')}>
              {c.status ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
              <div className="min-w-0 flex-1 text-[12.5px]">
                <div className="font-semibold text-ink">{t(HISTORY_KIND_LABEL[k] ?? k)}</div>
                <div className="text-muted">
                  {c.status === 'records' ? t('{n} recorded', { n: c.count ?? 0 })
                    : c.status === 'attested' ? t('None, attested by {name} on {date}', {
                      name: c.by ?? '—', date: c.on ? new Date(c.on).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—' })
                    : t('Not covered: blocks scoring')}
                </div>
              </div>
              {canAttest && !c.status && (
                <button type="button" className="text-[12px] font-semibold text-brand-600 hover:text-brand-700" onClick={() => setAttest(k)}>
                  {t('Attest none')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {attest && <AttestPanel kind={attest} months={months} onClose={() => setAttest(null)} defaultName={me?.name ?? ''} />}
    </section>
  );
}

function AttestPanel({ kind, months: defaultMonths, onClose, defaultName }: { kind: string; months: number; onClose: () => void; defaultName: string }) {
  const t = useT();
  const attest = useAttest();
  const [months, setMonths] = useState(defaultMonths);
  const [name, setName] = useState(defaultName);
  const [designation, setDesignation] = useState('');
  const title = kind === 'ALL' ? t('Nothing of any kind happened')
    : t('There was no {what}', { what: t(HISTORY_KIND_LABEL[kind] ?? kind).toLowerCase() });
  return (
    <SidePanel onClose={onClose} labelledBy="attest-title">
      <PanelHeader id="attest-title" eyebrow={t('Attestation')} title={title} onClose={onClose} />
      <div className={DRAWER.body}>
        <p className="text-muted">
          {t('A signed statement that nothing of this kind happened. It is refused if a record already says otherwise, and it is kept with your name.')}
        </p>
        <FieldRow label="Months covered" hint="Scoring needs at least 36.">
          <input type="number" min={1} max={120} className="input w-28 tabular-nums" value={months} onChange={(e) => setMonths(Number(e.target.value))} />
        </FieldRow>
        <FieldRow label="Name" required><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></FieldRow>
        <FieldRow label="Designation" required><input className="input w-full" value={designation} placeholder={t('Medical Superintendent')} onChange={(e) => setDesignation(e.target.value)} /></FieldRow>
        {attest.error && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{attest.error.message}</p>}
      </div>
      <div className={DRAWER.footer}>
        <button type="button" className="btn ml-auto" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={attest.isPending || !name.trim() || !designation.trim() || !months}
                onClick={() => attest.mutate({ kind, months, name, designation }, { onSuccess: onClose })}>
          <PenLine className="h-4 w-4" /> {t('Sign the attestation')}
        </button>
      </div>
    </SidePanel>
  );
}
