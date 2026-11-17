import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardCheck, AlertTriangle, Clock, UserX, ChevronRight,
  CheckCircle2, XCircle, Loader2, Scale,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import {
  useActions, useAction, useTransition, STATUS_TONE,
  type ActionRow,
} from '@/services/actionsApi';
import { cn } from '@/utils/ui';

/**
 * Actions / CAPA — what happens after the engine proposes something.
 *
 * The lifecycle lives on the server. This screen only offers the transitions
 * the server says are legal for the current status, and shows the server's
 * refusal verbatim when a move is rejected — a UI that guessed would let people
 * believe work was closed when it was not.
 */
export function ActionsPage() {
  const [filter, setFilter] = useState<{ status?: string; overdue?: boolean }>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, isLoading, error } = useActions(filter);

  const s = data?.stats;

  return (
    <>
      <Topbar
        title="Actions"
        subtitle="Every regulatory change becomes owned, dated work — and closes with evidence"
        icon="ClipboardCheck"
        tone="#0d9488"
        section="Compliance"
      />

      <div className="space-y-4 p-4 sm:p-6">
        {s && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="Awaiting acceptance" n={s.awaitingAcceptance} tone="warning"
                 hint="proposed by the engine; a human must accept"
                 onClick={() => setFilter({ status: 'Proposed' })} />
            <Kpi label="Open" n={s.open} tone="brand" onClick={() => setFilter({ status: 'Open' })} />
            <Kpi label="Overdue" n={s.overdue} tone="critical" icon={Clock}
                 onClick={() => setFilter({ overdue: true })} />
            <Kpi label="Unowned" n={s.unowned} tone="critical" icon={UserX}
                 hint="no accountable person" />
            <Kpi label="Closed" n={s.byStatus?.Done ?? 0} tone="success"
                 onClick={() => setFilter({ status: 'Done' })} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setFilter({})}
                  className={cn('pill', !filter.status && !filter.overdue ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-600')}>
            All
          </button>
          {(data?.statuses ?? []).map((st) => (
            <button key={st} onClick={() => setFilter({ status: st })}
                    className={cn('pill', filter.status === st ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-600')}>
              {st}
            </button>
          ))}
        </div>

        {isLoading && <div className="card py-14 text-center text-[13px] text-muted">Loading…</div>}
        {error && (
          <div className="card flex items-center gap-3 p-4 text-[13px]">
            <AlertTriangle className="h-4 w-4 text-critical-600" />
            {(error as Error).message}
          </div>
        )}

        {data && data.items.length === 0 && (
          <div className="card flex flex-col items-center gap-2 py-14 text-center">
            <ClipboardCheck className="h-6 w-6 text-muted-2" />
            <div className="text-sm font-semibold text-ink">No actions here</div>
            <p className="max-w-md text-[12.5px] text-muted">
              Actions appear when the Impact Engine proposes them, or when you create one by hand.
              Nothing is invented to fill this list.
            </p>
          </div>
        )}

        <div className="space-y-2.5">
          {(data?.items ?? []).map((a) => (
            <Row key={a.id} a={a} onOpen={() => setOpenId(a.id)} />
          ))}
        </div>
      </div>

      {openId && <Drawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

const TONE: Record<string, string> = {
  warning: 'text-warning-600', brand: 'text-brand-600',
  critical: 'text-critical-600', success: 'text-success-600',
};

function Kpi({ label, n, tone, hint, icon: I, onClick }: {
  label: string; n: number; tone: string; hint?: string;
  icon?: typeof Clock; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} disabled={!onClick}
            className={cn('card px-4 py-3 text-left', onClick && 'card-int hover:border-brand-300')}>
      <div className={cn('flex items-center gap-1.5 text-2xl font-extrabold tabular-nums', TONE[tone])}>
        {I && <I className="h-4 w-4" />}{n}
      </div>
      <div className="mt-0.5 text-[12px] font-medium text-ink-2">{label}</div>
      {hint && <div className="text-[11px] text-muted-2">{hint}</div>}
    </button>
  );
}

const PRIORITY_TONE: Record<string, string> = {
  P0: 'bg-critical-50 text-critical-600', P1: 'bg-warning-50 text-warning-600',
  P2: 'bg-slate-100 text-slate-600',
};

function Row({ a, onOpen }: { a: ActionRow; onOpen: () => void }) {
  const navigate = useNavigate();
  const overdue = a.due_date && a.due_date < new Date().toISOString().slice(0, 10)
    && !['Done', 'Rejected', 'Cancelled'].includes(a.status);
  return (
    <div className="card card-int px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('pill shrink-0', PRIORITY_TONE[a.priority])}>{a.priority}</span>
        <button onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-ink hover:text-brand-600">
          {a.title}
        </button>
        <span className={cn('pill shrink-0', STATUS_TONE[a.status])}>{a.status}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        {a.regulation_id && (
          <button onClick={() => navigate(`/regulation/${a.regulation_id}`)}
                  className="inline-flex items-center gap-1 hover:text-brand-600">
            <Scale className="h-3.5 w-3.5" />
            <span className="max-w-64 truncate">{a.regulation_title || a.regulation_id}</span>
          </button>
        )}
        {a.entity_name && <span>affects <b className="font-medium text-ink-2">{a.entity_name}</b></span>}
        <span className={cn(a.owner_name ? '' : 'text-critical-600')}>
          {a.owner_name ? <>owner <b className="font-medium text-ink-2">{a.owner_name}</b></> : 'no owner'}
        </span>
        {a.due_date && (
          <span className={cn(overdue && 'font-semibold text-critical-600')}>
            due {a.due_date}{overdue ? ' · overdue' : ''}
          </span>
        )}
        {a.source && <span className="text-muted-2">via {a.source}</span>}
        <button onClick={onOpen} className="ml-auto inline-flex items-center gap-1 font-medium text-brand-600">
          Open <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Drawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: a } = useAction(id);
  const move = useTransition();
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');

  if (!a) return null;
  const needsEvidence = ['collect_evidence', 'add_control'].includes(a.action_type || '');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 border-b border-line bg-surface px-5 py-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold text-ink">{a.title}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={cn('pill', STATUS_TONE[a.status])}>{a.status}</span>
                <span className={cn('pill', PRIORITY_TONE[a.priority])}>{a.priority}</span>
                <span className="text-[11.5px] text-muted-2">{a.action_type}</span>
              </div>
            </div>
            <button onClick={onClose} className="btn btn-sm">Close</button>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          {a.description && <p className="text-[13px] leading-relaxed text-ink-2">{a.description}</p>}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
            <Meta k="Regulation" v={a.regulation_title || a.regulation_id} />
            <Meta k="Affects" v={a.entity_name} />
            <Meta k="Owner" v={a.owner_name} missing="unassigned" />
            <Meta k="Due" v={a.due_date} missing="no date" />
            <Meta k="Evidence" v={a.evidence_name} missing={needsEvidence ? 'required to close' : 'none'} />
            <Meta k="Source" v={a.source} />
          </dl>

          {a.closure_note && (
            <div className="rounded-lg border border-success-200 bg-success-50 px-3 py-2 text-[12.5px] text-success-700">
              <b>Closed:</b> {a.closure_note}
            </div>
          )}

          {/* only the transitions the SERVER says are legal */}
          {(a.allowedTransitions ?? []).length > 0 && (
            <div className="card space-y-2.5 p-4">
              <div className="text-[13px] font-bold text-ink">Move this action</div>
              <input className="input w-full" placeholder="Note — required to close"
                     value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <input className="input" placeholder="Owner entity id" value={owner} onChange={(e) => setOwner(e.target.value)} />
                <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
              {needsEvidence && (
                <input className="input w-full" placeholder="Evidence entity id — required to close this type"
                       value={evidence} onChange={(e) => setEvidence(e.target.value)} />
              )}
              <div className="flex flex-wrap gap-2">
                {a.allowedTransitions!.map((t) => (
                  <button key={t} disabled={move.isPending}
                          onClick={() => move.mutate({
                            id: a.id, to: t, actor: 'compliance.user', note,
                            evidence_id: evidence || undefined, owner_id: owner || undefined,
                            due_date: due || undefined,
                          })}
                          className={cn('btn btn-sm', t === 'Done' ? 'btn-primary' : '')}>
                    {move.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : t === 'Done' ? <CheckCircle2 className="h-3.5 w-3.5" />
                      : t === 'Rejected' ? <XCircle className="h-3.5 w-3.5" /> : null}
                    {t}
                  </button>
                ))}
              </div>
              {move.error && (
                // the server's refusal, verbatim — it explains what the lifecycle requires
                <div className="rounded-lg bg-critical-50 px-3 py-2 text-[12.5px] text-critical-600">
                  {(move.error as Error).message}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[13px] font-bold text-ink">History</div>
            <ol className="space-y-1.5">
              {(a.events ?? []).map((e, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                  <span className="font-medium text-ink-2">
                    {e.from_status ? `${e.from_status} → ` : ''}{e.to_status}
                  </span>
                  <span className="text-muted">{e.note}</span>
                  <span className="ml-auto text-muted-2">{e.actor} · {e.at.slice(0, 16).replace('T', ' ')}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ k, v, missing }: { k: string; v?: string | null; missing?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-2">{k}</dt>
      <dd className={cn('font-medium', v ? 'text-ink-2' : 'text-muted-2')}>{v || missing || '—'}</dd>
    </div>
  );
}

export default ActionsPage;
