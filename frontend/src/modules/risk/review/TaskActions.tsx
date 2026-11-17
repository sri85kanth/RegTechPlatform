/**
 * The quick decisions a review task allows where it is listed: acknowledge or
 * escalate (G5), accept or dismiss a possible risk (G9), decide applicability
 * (G3), choose the theme of a regulation the rulebook cannot place (G3),
 * approve or reject an override (G7). Treatment (G6) and controls (G4)
 * need the whole risk, so they are decided in its panel.
 *
 * A decision that needs a reason asks for it only once it is chosen.
 */
import { useState } from 'react';
import { Check, ChevronsUp, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { can, useMe } from '@/services/authApi';
import { useRiskMeta } from '@/services/riskApi';
import {
  useAcknowledge, useAssignTheme, useDecideExposure, useDecideOverride, useTriage, type ReviewTask,
} from '@/services/riskReviewApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

interface Choice { key: string; label: string; primary?: boolean; icon?: typeof Check; reason: 'needed' | 'optional' | 'none'; run: (note: string) => void }

export function TaskActions({ task, className }: { task: ReviewTask; className?: string }) {
  const t = useT();
  const { data: me } = useMe();
  const ack = useAcknowledge();
  const triage = useTriage();
  const exposure = useDecideExposure();
  const override = useDecideOverride();
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  const err = ack.error ?? triage.error ?? exposure.error ?? override.error;
  const busy = ack.isPending || triage.isPending || exposure.isPending || override.isPending;
  if (task.status !== 'OPEN') return null;
  if (task.gate === 'G8') {
    return <div className={className}><Link to="/risk-review/rulebook" className="btn btn-sm" onClick={(e) => e.stopPropagation()}>{t('Review the rulebook')}</Link></div>;
  }
  if (!can(me, 'approve') || task.gate === 'G6' || task.gate === 'G4') return null;
  if (task.reason_code === 'THEME_NEEDED') return <ThemePicker task={task} className={className} />;

  const rid = task.risk_id ?? '';
  const choices: Choice[] = task.gate === 'G5' ? [
    { key: 'ack', label: t('Acknowledge'), primary: true, icon: Check, reason: 'none', run: (n) => ack.mutate({ id: task.id, note: n }) },
    ...(task.assignee_role !== 'governor' ? [{ key: 'up', label: t('Escalate to leadership'), icon: ChevronsUp, reason: 'optional' as const,
      run: (n: string) => ack.mutate({ id: task.id, note: n, escalate: true }) }] : []),
  ] : task.gate === 'G9' ? [
    { key: 'yes', label: t('It applies'), primary: true, icon: Check, reason: 'needed', run: (n) => triage.mutate({ id: rid, decision: 'ACCEPT', reason: n }) },
    { key: 'no', label: t('Dismiss'), icon: X, reason: 'needed', run: (n) => triage.mutate({ id: rid, decision: 'DISMISS', reason: n }) },
  ] : task.gate === 'G3' ? [
    { key: 'yes', label: t('Applies'), primary: true, reason: 'needed', run: (n) => exposure.mutate({ id: task.subject_id, decision: 'APPLICABLE', reason: n }) },
    { key: 'no', label: t("Doesn't apply"), reason: 'needed', run: (n) => exposure.mutate({ id: task.subject_id, decision: 'NOT_APPLICABLE', reason: n }) },
  ] : task.gate === 'G7' ? [
    { key: 'yes', label: t('Approve'), primary: true, icon: Check, reason: 'none', run: (n) => override.mutate({ id: task.subject_id, approve: true, note: n }) },
    { key: 'no', label: t('Reject'), icon: X, reason: 'needed', run: (n) => override.mutate({ id: task.subject_id, approve: false, note: n }) },
  ] : [];
  if (!choices.length) return null;

  const pick = (c: Choice) => (c.reason === 'none' ? c.run('') : (setChosen(c), setNote('')));
  return (
    // the card around this opens the risk; a decision here must not
    <div className={cn('space-y-2', className)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="group" aria-label={t('Decide')}>
      {!chosen ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => {
            const Icon = c.icon;
            return (
              <button key={c.key} type="button" className={cn('btn btn-sm', c.primary && 'btn-primary')} disabled={busy} onClick={() => pick(c)}>
                {Icon && <Icon className="h-3.5 w-3.5" />} {c.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input autoFocus className="input h-8 min-w-[200px] flex-1 text-[12.5px]" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder={chosen.reason === 'needed' ? t('Why? (needed)') : t('Note (optional)')} aria-label={t('Reason')}
                 onKeyDown={(e) => { if (e.key === 'Enter' && (chosen.reason !== 'needed' || note.trim().length >= 3)) chosen.run(note); }} />
          <button type="button" className={cn('btn btn-sm', chosen.primary && 'btn-primary')} disabled={busy || (chosen.reason === 'needed' && note.trim().length < 3)}
                  onClick={() => chosen.run(note)}>{chosen.label}</button>
          <button type="button" className="btn btn-sm" onClick={() => setChosen(null)}>{t('Cancel')}</button>
        </div>
      )}
      {err && <p role="alert" className="text-[12.5px] text-critical-600">{err.message}</p>}
    </div>
  );
}

/** G3 for a regulation the rulebook cannot place: choose its theme; its duties move to that theme's risk. */
function ThemePicker({ task, className }: { task: ReviewTask; className?: string }) {
  const t = useT();
  const { data: meta } = useRiskMeta();
  const assign = useAssignTheme();
  const [theme, setTheme] = useState('');
  return (
    <div className={cn('space-y-2', className)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="group" aria-label={t('Choose a theme')}>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input h-8 min-w-[200px] flex-1 text-[12.5px]" aria-label={t('Theme')} value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="">{t('Choose a theme')}</option>
          {(meta?.themes ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button type="button" className="btn btn-sm btn-primary" disabled={!theme || assign.isPending}
                onClick={() => assign.mutate({ regulationId: task.subject_id, theme })}>
          <Check className="h-3.5 w-3.5" /> {assign.isPending ? t('Re-assessing…') : t('Set the theme')}
        </button>
      </div>
      {assign.error && <p role="alert" className="text-[12.5px] text-critical-600">{assign.error.message}</p>}
    </div>
  );
}
