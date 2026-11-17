/**
 * Auditor access — the hospital decides what each external auditor sees.
 *
 * An auditor account sees nothing by default. From here a compliance manager
 * sends it regulations (their impact cascade, read-only), documents on file,
 * or a file uploaded just for that auditor; can set a note and an end date;
 * revokes anything; and reads what the auditor opened. Every share, revocation
 * and download is in the audit trail.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Upload, UserPlus, X } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { Avatar, Callout, EmptyState, IconTile, MetricCard, Skeleton } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { can, useCreateUser, useMe } from '@/services/authApi';
import {
  REQUEST_STATUS, day, fileSize, useAuditorDetail, useAuditorOverview, useDecideRequest, useRevokeShare, useShare, useUploadForAuditor,
  type AuditorActivity, type AuditorOverview, type AuditorRequest, type Share,
} from '@/services/auditorApi';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

/** Put a link or button into a translated sentence at its {link} placeholder, so the word order stays the translator's. */
function linkIn(text: string, link: ReactNode): ReactNode {
  const i = text.indexOf('{link}');
  if (i < 0) return <>{text} {link}</>;
  return <>{text.slice(0, i)}{link}{text.slice(i + '{link}'.length)}</>;
}

type Tab = 'requests' | 'shared' | 'send' | 'activity';

export function AuditorAccessPage() {
  const t = useT();
  const { data: me } = useMe();
  const allowed = can(me, 'approve');
  const ov = useAuditorOverview(allowed);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const auditors = ov.data?.auditors ?? [];
  // open on the auditor whose requests are waiting, if any
  useEffect(() => { if (!sel && auditors.length) setSel((auditors.find((a) => a.pending) ?? auditors[0]).id); }, [auditors, sel]);
  const totals = useMemo(() => ({
    regs: auditors.reduce((a, x) => a + x.regulations, 0), docs: auditors.reduce((a, x) => a + x.documents, 0),
    pending: auditors.reduce((a, x) => a + (x.pending ?? 0), 0),
  }), [auditors]);

  return (
    <div>
      <Topbar title="Auditor access" icon="UserCheck"
              subtitle="Share the impact cascade and documents with external auditors. They see only what you send, read-only, and every download is recorded." />
      <div className="space-y-4 p-6">
        {!allowed && (
          <Callout tone="amber" icon="Lock" title="Compliance managers and admins only">
            {t('Sending documents outside the hospital needs the compliance manager role.')}
          </Callout>
        )}
        {allowed && ov.isLoading && <div className="card"><Skeleton rows={6} /></div>}
        {allowed && ov.error && <Callout tone="red" title="Could not load auditor access">{(ov.error as Error).message}</Callout>}
        {allowed && ov.data && (<>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Auditor accounts" value={auditors.length} tone="orange" icon="UserCheck" />
            <MetricCard label="Regulations shared" value={totals.regs} tone="purple" icon="GitBranch" foot={t('cascade, read-only')} />
            <MetricCard label="Documents shared" value={totals.docs} tone="teal" icon="Paperclip" />
            <MetricCard label="Requests waiting" value={totals.pending} tone="amber" icon="ListChecks"
                        foot={t(totals.pending ? 'approve or decline under Requests' : 'nothing to decide')}
                        onClick={totals.pending ? () => { const a = auditors.find((x) => x.pending); if (a) setSel(a.id); } : undefined} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="card self-start p-4">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="flex-1 text-[15px] font-semibold text-ink">{t('Auditors')}</h3>
                <button className="btn btn-outline btn-sm" onClick={() => setAdding((a) => !a)}>
                  <UserPlus className="h-3.5 w-3.5" /> {t('Add auditor')}
                </button>
              </div>
              {adding && <AddAuditor admin={can(me, 'administer')} onDone={(id) => { setAdding(false); if (id) setSel(id); }} />}
              {auditors.length === 0 && !adding && (
                <EmptyState title="No auditor accounts yet" hint="Add one to start sharing. An auditor sees nothing until you send it something." icon="UserCheck" />
              )}
              <ul className="space-y-1.5">
                {auditors.map((a) => (
                  <li key={a.id}>
                    <button onClick={() => setSel(a.id)}
                            className={cn('flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition',
                              sel === a.id ? 'border-orange-300 bg-orange-50/60 ring-1 ring-orange-200' : 'border-line hover:border-orange-200 hover:bg-slate-50')}>
                      <Avatar name={a.name} size={34} />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold text-ink">
                          <span className="truncate">{a.name}</span>{!a.active && <span className="text-xs font-normal text-muted">{t('(deactivated)')}</span>}
                          {!!a.pending && <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">{t('{n} waiting', { n: a.pending.toLocaleString() })}</span>}
                        </span>
                        <span className="block truncate text-xs text-muted">{a.email}</span>
                        <span className="mt-1 block text-xs text-ink-2">
                          {a.regulations === 1 ? t('1 regulation') : t('{n} regulations', { n: a.regulations.toLocaleString() })} · {a.documents === 1 ? t('1 document') : t('{n} documents', { n: a.documents.toLocaleString() })}
                          <span className="text-muted"> · {a.last_login_at ? t('signed in {date}', { date: day(a.last_login_at) }) : t('never signed in')}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {sel ? <AuditorPanel uid={sel} overview={ov.data} />
              : <div className="card"><EmptyState title="Pick an auditor" hint="Their shares, what to send and what they opened appear here." icon="UserCheck" /></div>}
          </div>
        </>)}
      </div>
    </div>
  );
}

/** A new auditor account. Only an admin can create accounts; the admin sets the first password and gives it to the auditor. */
function AddAuditor({ admin, onDone }: { admin: boolean; onDone: (id?: string) => void }) {
  const t = useT();
  const create = useCreateUser();
  const [f, setF] = useState({ name: '', email: '', password: '' });
  if (!admin) {
    return <Callout tone="blue" icon="Info" title="Ask an admin">{t('An admin creates the auditor’s account (Users, role “Auditor”). It then appears here.')}</Callout>;
  }
  return (
    <form className="mb-4 space-y-2.5 rounded-xl border border-orange-200 bg-orange-50/40 p-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate({ ...f, role: 'auditor' }, { onSuccess: (u) => onDone(u.id) }); }}>
      <label className="block"><span className="field-label">{t('Name')}</span>
        <input className="input w-full" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('e.g. Dr A. Rao, NABH assessor')} /></label>
      <label className="block"><span className="field-label">{t('Email (their sign-in)')}</span>
        <input className="input w-full" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="block"><span className="field-label">{t('First password')}</span>
        <input className="input w-full" type="password" required minLength={12} autoComplete="new-password" value={f.password}
               onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      <p className="text-xs text-muted">{t('At least 12 characters with a letter and a digit. Give it to the auditor securely. The account sees nothing until you share.')}</p>
      {create.error && <p className="text-xs text-critical-600">{create.error.message}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={create.isPending}>{t(create.isPending ? 'Creating…' : 'Create auditor')}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone()}>{t('Cancel')}</button>
      </div>
    </form>
  );
}

function AuditorPanel({ uid, overview }: { uid: string; overview: AuditorOverview }) {
  const navigate = useNavigate();
  const t = useT();
  const d = useAuditorDetail(uid);
  const [tab, setTab] = useState<Tab>('shared');
  const waiting = (d.data?.requests ?? []).filter((r) => r.status === 'PENDING').length;
  // open on what needs a decision
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!d.data || opened.current === uid) return;
    opened.current = uid;
    setTab(waiting ? 'requests' : 'shared');
  }, [uid, d.data, waiting]);
  const active = (d.data?.shares ?? []).filter((s) => !s.revoked_at && !(s.expires_at && s.expires_at < new Date().toISOString()));
  const past = (d.data?.shares ?? []).filter((s) => !active.includes(s));
  const regTitle = useMemo(() => new Map(overview.regulations.map((r) => [r.id, r.short_title || r.title])), [overview]);

  if (d.isLoading || !d.data) return <div className="card"><Skeleton rows={6} /></div>;
  const a = d.data.auditor;
  const tabs: [Tab, string][] = [['requests', waiting
      ? t('Requests ({n} waiting)', { n: waiting.toLocaleString() })
      : t('Requests ({n})', { n: d.data.requests.length.toLocaleString() })],
    ['shared', t('Shared now ({n})', { n: active.length.toLocaleString() })], ['send', t('Send to auditor')],
    ['activity', t('Activity ({n})', { n: d.data.activity.length.toLocaleString() })]];
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-gradient-to-r from-orange-50 to-amber-50/40 px-5 py-4">
        <Avatar name={a.name} size={44} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[16px] font-semibold text-ink">{a.name}</div>
          <div className="text-[13px] text-muted">{a.email} · {a.last_login_at ? t('last signed in {date}', { date: day(a.last_login_at) }) : t('has not signed in yet')}</div>
        </div>
        <span className="pill bg-orange-100 text-orange-700"><Icon name="Lock" className="h-3.5 w-3.5" />{t('Auditor · read-only')}</span>
        <button className="btn btn-outline btn-sm" onClick={() => navigate(`/auditor-access/preview/${encodeURIComponent(uid)}`)}>
          <Icon name="Eye" className="h-3.5 w-3.5" /> {t('Preview their view')}
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-4" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={cn('-mb-px border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition',
                    tab === k ? 'border-orange-500 text-ink' : 'border-transparent text-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'requests' && <RequestList items={d.data.requests} onSend={() => setTab('send')} />}
        {tab === 'shared' && <SharedList active={active} past={past} onSend={() => setTab('send')} />}
        {tab === 'send' && <SendForm uid={uid} name={a.name} overview={overview} active={active} onSent={() => setTab('shared')} />}
        {tab === 'activity' && <ActivityList items={d.data.activity} regTitle={regTitle} />}
      </div>
    </div>
  );
}

/** What the auditor asked for. Approving a regulation or document request shares it; anything else is sent first, then marked done. */
function RequestList({ items, onSend }: { items: AuditorRequest[]; onSend: () => void }) {
  const t = useT();
  const decide = useDecideRequest();
  const [open, setOpen] = useState<{ id: string; decision: 'approve' | 'decline' } | null>(null);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [pick, setPick] = useState('');
  if (!items.length) return <EmptyState title="No requests from this auditor" hint="When the auditor asks for a regulation or a document, it appears here to approve or decline." icon="ListChecks" />;
  const pending = items.filter((r) => r.status === 'PENDING');
  const done = items.filter((r) => r.status !== 'PENDING');
  const unlisted = (r: AuditorRequest) => r.kind === 'regulation' && !r.ref && !!r.context.not_in_library;
  const what = (r: AuditorRequest) => unlisted(r)
    ? (r.suggestions?.some((x) => x.ready)
      ? t('This may already be in your library — choose it below and share it.')
      : t('Not in your library yet. Add it under Ingestion; once it has been assessed it appears here to share.'))
    : r.kind === 'regulation'
    ? t('Approving shares this regulation’s impact cascade (read-only).')
    : r.kind === 'document'
      ? (r.context.files?.length
        ? t(r.context.files.length === 1 ? 'Approving shares this file: {names}.' : 'Approving shares these files: {names}.', {
            names: r.context.files.map((f) => f.name).join(', '),
          })
        : t('No file on record holds these documents. Send something under “Send to auditor” first, then mark it done, or decline.'))
      : t('Send the item under “Send to auditor” first, then mark the request done.');
  const row = (r: AuditorRequest) => {
    const s = REQUEST_STATUS[r.status];
    const isOpen = open?.id === r.id;
    const approveLabel = r.kind === 'other' || (r.kind === 'document' && !r.context.files?.length) ? tx('Mark as sent') : tx('Approve and share');
    const needsPick = unlisted(r);
    return (
      <li key={r.id} className="py-3.5">
        <div className="flex flex-wrap items-start gap-3">
          <IconTile icon={r.kind === 'regulation' ? 'GitBranch' : r.kind === 'document' ? 'FileText' : 'Paperclip'}
                    tone={r.kind === 'regulation' ? 'purple' : r.kind === 'document' ? 'teal' : 'brand'} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{r.title}</span>
              <span className={cn('pill', s.cls)}>{r.status === 'PENDING' ? t('Waiting for you') : t(s.label)}</span>
            </div>
            {needsPick && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="pill bg-violet-50 text-violet-700">{t('Not in your library')}</span>
                {[r.context.regulator, r.context.reference].filter(Boolean).join(' · ')}
              </div>
            )}
            {r.kind === 'document' && (
              <div className="mt-0.5 text-xs text-muted">
                {r.context.obligation}{r.context.codes?.length ? ` · ${t('on record: {codes}', { codes: r.context.codes.join(', ') })}` : ` · ${t('no document on record')}`}
              </div>
            )}
            {r.message && <div className="mt-1 text-[13px] text-ink-2">“{r.message}”</div>}
            <div className="mt-1 text-xs text-muted">
              {t('Asked {date}', { date: day(r.created_at) })}{r.decided_at ? ` · ${r.decided_by_name
                ? t('{status} {date} by {name}', { status: t(s.label).toLowerCase(), date: day(r.decided_at), name: r.decided_by_name })
                : t('{status} {date}', { status: t(s.label).toLowerCase(), date: day(r.decided_at) })}` : ''}
            </div>
            {r.decision_note && r.status !== 'PENDING' && <div className="mt-1 text-[12.5px] text-ink-2">{t('Reply: “{note}”', { note: r.decision_note })}</div>}
            {r.status === 'PENDING' && <p className="mt-1.5 text-xs text-ink-2">{what(r)}</p>}
          </div>
          {r.status === 'PENDING' && !isOpen && (
            <div className="flex shrink-0 gap-2">
              {needsPick && (
                <a className="btn btn-outline btn-sm" href="/ingestion" target="_blank" rel="noreferrer">{t('Add it to the library')}</a>
              )}
              <button className="btn btn-primary btn-sm"
                      onClick={() => { setOpen({ id: r.id, decision: 'approve' }); setNote(''); setUntil(''); setPick(r.suggestions?.find((x) => x.ready)?.id ?? ''); }}>
                {needsPick ? t('Choose and share') : t(approveLabel)}
              </button>
              <button className="btn btn-sm text-critical-600 hover:bg-critical-50" onClick={() => { setOpen({ id: r.id, decision: 'decline' }); setNote(''); }}>{t('Decline')}</button>
            </div>
          )}
        </div>
        {isOpen && (
          <div className="ml-11 mt-2.5 space-y-2.5 rounded-xl border border-line bg-slate-50 p-3">
            {open.decision === 'approve' && needsPick && (
              <fieldset>
                <legend className="field-label">{t('Which regulation in your library is it?')}</legend>
                {(r.suggestions ?? []).length === 0 ? (
                  <p className="text-[12.5px] text-ink-2">
                    {linkIn(t('Nothing in your library looks like “{title}”. Add it under {link}; once it has been assessed it is listed here.', { title: r.title }),
                      <a className="font-semibold text-brand-600 hover:underline" href="/ingestion" target="_blank" rel="noreferrer">{t('Ingestion')}</a>)}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {r.suggestions!.map((x) => (
                      <li key={x.id}>
                        <label className={cn('flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]', x.ready ? 'cursor-pointer hover:bg-white' : 'opacity-60')}>
                          <input type="radio" name={`pick-${r.id}`} disabled={!x.ready} checked={pick === x.id} onChange={() => setPick(x.id)} className="mt-0.5" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-ink">{x.title}</span>
                            <span className="block text-xs text-muted">
                              {x.regulator}{x.added ? ` · ${t('added {date}', { date: day(x.added) })}` : ''}
                              {!x.ready && ` · ${t('not assessed yet, so it has no impact cascade to share')}`}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
            )}
            <label className="block"><span className="field-label">{t(open.decision === 'decline' ? 'Reason the auditor will read' : 'Note to the auditor (optional)')}</span>
              <textarea className="input h-[64px] w-full py-2 text-[13px]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {open.decision === 'approve' && approveLabel === 'Approve and share' && (
              <label className="block max-w-[220px]"><span className="field-label">{t('Access ends (optional)')}</span>
                <input className="input w-full" type="date" min={new Date().toISOString().slice(0, 10)} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
            )}
            {open.decision === 'approve' && approveLabel === 'Mark as sent' && (
              <p className="text-xs text-muted">{linkIn(t('Not sent yet? {link} first.'),
                <button type="button" className="font-semibold text-brand-600 hover:underline" onClick={onSend}>{t('Send it to the auditor')}</button>)}</p>
            )}
            {decide.error && <p className="text-xs text-critical-600">{decide.error.message}</p>}
            <div className="flex gap-2">
              <button className={cn('btn btn-sm', open.decision === 'decline' ? 'bg-critical-600 text-white hover:bg-critical-700' : 'btn-primary')}
                      disabled={decide.isPending || (open.decision === 'decline' && note.trim().length < 3)
                                || (open.decision === 'approve' && needsPick && !pick)}
                      onClick={() => decide.mutate({ id: r.id, decision: open.decision, note: note || undefined, expires_on: until || undefined,
                                                     regulation_id: open.decision === 'approve' && needsPick ? pick : undefined },
                        { onSuccess: () => setOpen(null) })}>
                {decide.isPending ? t('Saving…') : open.decision === 'decline' ? t('Decline request') : t(approveLabel)}
              </button>
              <button className="btn btn-sm" onClick={() => setOpen(null)}>{t('Cancel')}</button>
            </div>
          </div>
        )}
      </li>
    );
  };
  return (
    <div>
      {pending.length > 0 && <ul className="divide-y divide-line">{pending.map(row)}</ul>}
      {pending.length === 0 && <p className="pb-2 text-[13px] text-muted">{t('Nothing waiting for a decision.')}</p>}
      {done.length > 0 && (
        <details className="mt-3" open={pending.length === 0}>
          <summary className="cursor-pointer text-[13px] font-medium text-muted">{t('Decided: {n}', { n: done.length.toLocaleString() })}</summary>
          <ul className="divide-y divide-line">{done.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { regulation: tx('Cascade'), document: tx('Document'), file: tx('Uploaded file') };
const KIND_TONE: Record<string, string> = { regulation: 'bg-violet-50 text-violet-700', document: 'bg-teal-50 text-teal-700', file: 'bg-brand-50 text-brand-700' };

function SharedList({ active, past, onSend }: { active: Share[]; past: Share[]; onSend: () => void }) {
  const t = useT();
  const revoke = useRevokeShare();
  if (!active.length && !past.length) {
    return (
      <div className="text-center">
        <EmptyState title="Nothing shared yet" hint="This auditor sees an empty portal until you send a regulation or a document." icon="Inbox" />
        <button className="btn btn-primary" onClick={onSend}><Send className="h-4 w-4" /> {t('Send to auditor')}</button>
      </div>
    );
  }
  const row = (s: Share, live: boolean) => (
    <li key={s.id} className={cn('flex items-start gap-3 py-3', !live && 'opacity-60')}>
      <IconTile icon={s.kind === 'regulation' ? 'GitBranch' : s.kind === 'file' ? 'Paperclip' : 'FileText'}
                tone={s.kind === 'regulation' ? 'purple' : s.kind === 'file' ? 'brand' : 'teal'} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{s.title}</span>
          <span className={cn('pill', KIND_TONE[s.kind])}>{t(KIND_LABEL[s.kind])}</span>
          {s.available === false && <span className="pill bg-warning-50 text-warning-700" title={t('The file is not on this server')}>{t('File missing')}</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {[s.file_name && `${s.file_name}${s.file_size ? ` · ${fileSize(s.file_size)}` : ''}`,
            s.shared_by_name
              ? t('shared {date} by {name}', { date: day(s.shared_at), name: s.shared_by_name })
              : t('shared {date}', { date: day(s.shared_at) }),
            s.expires_at && (live ? t('until {date}', { date: day(s.expires_at) }) : t('expired {date}', { date: day(s.expires_at) })),
            s.revoked_at && t('revoked {date}', { date: day(s.revoked_at) })].filter(Boolean).join(' · ')}
        </div>
        {s.note && <div className="mt-1 text-[12.5px] text-ink-2">“{s.note}”</div>}
      </div>
      {live && (
        <button className="btn btn-sm text-critical-600 hover:bg-critical-50" disabled={revoke.isPending}
                onClick={() => { if (window.confirm(t('Stop sharing “{title}”? The auditor loses access at once.', { title: s.title }))) revoke.mutate(s.id); }}>
          <X className="h-3.5 w-3.5" /> {t('Revoke')}
        </button>
      )}
    </li>
  );
  return (
    <div>
      <ul className="divide-y divide-line">{active.map((s) => row(s, true))}</ul>
      {past.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-medium text-muted">{t('History: {n} revoked or expired', { n: past.length.toLocaleString() })}</summary>
          <ul className="divide-y divide-line">{past.map((s) => row(s, false))}</ul>
        </details>
      )}
    </div>
  );
}

function SendForm({ uid, name, overview, active, onSent }: {
  uid: string; name: string; overview: AuditorOverview; active: Share[]; onSent: () => void;
}) {
  const t = useT();
  const share = useShare();
  const upload = useUploadForAuditor();
  const [regs, setRegs] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [qr, setQr] = useState('');
  const [qd, setQd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sharedRefs = useMemo(() => new Set(active.map((s) => s.ref)), [active]);
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); setter(n);
  };
  const regRows = overview.regulations.filter((r) => `${r.title} ${r.short_title ?? ''} ${r.regulator}`.toLowerCase().includes(qr.toLowerCase()));
  // generated SOP drafts are unapproved machine text and are never offered to an auditor
  const docRows = overview.documents
    .filter((d) => !(d.source ?? '').startsWith('Generated'))
    .filter((d) => `${d.name} ${d.document_type ?? ''}`.toLowerCase().includes(qd.toLowerCase()));
  const count = regs.size + docs.size + (file ? 1 : 0);

  const send = async () => {
    setErr(''); setBusy(true);
    const extra = { note: note || undefined, expires_on: until || undefined };
    try {
      if (regs.size) await share.mutateAsync({ uid, kind: 'regulation', refs: [...regs], ...extra });
      if (docs.size) await share.mutateAsync({ uid, kind: 'document', refs: [...docs], ...extra });
      if (file) await upload.mutateAsync({ uid, file, ...extra });
      setRegs(new Set()); setDocs(new Set()); setFile(null); setNote(''); setUntil('');
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = 'max-h-[260px] overflow-y-auto rounded-xl border border-line';
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <IconTile icon="GitBranch" tone="purple" size="sm" />
            <h4 className="flex-1 text-[14px] font-semibold text-ink">{t('Regulations: impact cascade')}</h4>
            <input className="input h-8 w-40 text-[12.5px]" placeholder={t('Search…')} value={qr} onChange={(e) => setQr(e.target.value)} />
          </div>
          <ul className={box}>
            {regRows.map((r) => {
              const on = sharedRefs.has(r.id);
              return (
                <li key={r.id} className="border-b border-line last:border-0">
                  <label className={cn('flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[13px] hover:bg-slate-50', on && 'cursor-default opacity-60')}>
                    <input type="checkbox" className="mt-0.5" disabled={on} checked={on || regs.has(r.id)} onChange={() => toggle(regs, setRegs, r.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink" title={r.title}>{r.short_title || r.title}</span>
                      <span className="text-xs text-muted">{r.regulator} · {t('{n} obligations', { n: r.applicable.toLocaleString() })} · {t('{n} open', { n: r.unmet.toLocaleString() })}</span>
                    </span>
                    {on && <span className="pill bg-success-50 text-success-700">{t('Shared')}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-muted">{t('The auditor sees only these regulations’ cascades, and only the hospital documents they link to.')}</p>
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <IconTile icon="FileText" tone="teal" size="sm" />
            <h4 className="flex-1 text-[14px] font-semibold text-ink">{t('Hospital documents')}</h4>
            <input className="input h-8 w-40 text-[12.5px]" placeholder={t('Search…')} value={qd} onChange={(e) => setQd(e.target.value)} />
          </div>
          <ul className={box}>
            {docRows.map((d) => {
              const on = sharedRefs.has(d.id);
              return (
                <li key={d.id} className="border-b border-line last:border-0">
                  <label className={cn('flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[13px] hover:bg-slate-50', (on || !d.available) && 'cursor-default opacity-60')}
                         title={!d.available ? t('The file is not on this server') : undefined}>
                    <input type="checkbox" className="mt-0.5" disabled={on || !d.available} checked={on || docs.has(d.id)} onChange={() => toggle(docs, setDocs, d.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{d.name}</span>
                      <span className="text-xs text-muted">{[d.document_type || d.kind, d.status, d.version && `v${d.version}`].filter(Boolean).join(' · ')}</span>
                    </span>
                    {on && <span className="pill bg-success-50 text-success-700">{t('Shared')}</span>}
                    {!d.available && !on && <span className="pill bg-warning-50 text-warning-700">{t('No file')}</span>}
                  </label>
                </li>
              );
            })}
            {docRows.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">{t('No document matches.')}</li>}
          </ul>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <label className="block rounded-xl border border-dashed border-brand-300 bg-brand-50/30 p-3">
          <span className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-ink"><Upload className="h-4 w-4 text-brand-600" /> {t('Upload a file for {name}', { name: name.split(' ')[0] })}</span>
          <input type="file" accept={overview.limits.types.join(',')} className="block w-full text-[12.5px]"
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="mt-1 block text-xs text-muted">{file ? `${file.name} · ${fileSize(file.size)}` : t('Up to {n} MB: {types}', { n: overview.limits.maxUploadMb, types: overview.limits.types.join(' ') })}</span>
        </label>
        <label className="block"><span className="field-label">{t('Note to the auditor (optional)')}</span>
          <textarea className="input h-[84px] w-full py-2" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder={t('e.g. For the NABH pre-assessment, 20–22 Oct')} /></label>
        <label className="block"><span className="field-label">{t('Access ends (optional)')}</span>
          <input className="input w-full" type="date" min={new Date().toISOString().slice(0, 10)} value={until} onChange={(e) => setUntil(e.target.value)} />
          <span className="mt-1 block text-xs text-muted">{t('After this date the auditor can no longer open what you send now.')}</span></label>
      </div>

      {err && <Callout tone="red" title="Not sent">{err}</Callout>}
      <div className="flex items-center gap-3 border-t border-line pt-4">
        <button className="btn btn-primary" disabled={!count || busy} onClick={() => void send()}>
          <Send className="h-4 w-4" /> {busy ? t('Sending…')
            : count === 1 ? t('Send 1 item to {name}', { name: name.split(' ')[0] })
            : count ? t('Send {n} items to {name}', { n: count.toLocaleString(), name: name.split(' ')[0] })
            : t('Send items to {name}', { name: name.split(' ')[0] })}
        </button>
        <span className="text-xs text-muted">{t('Recorded in the audit trail with your name. You can revoke any item later.')}</span>
      </div>
    </div>
  );
}

const ACT: Record<string, { label: string; icon: string; tone: string }> = {
  auditor_share: { label: 'Shared', icon: 'Send', tone: 'bg-brand-50 text-brand-700' },
  auditor_revoke: { label: 'Revoked', icon: 'XCircle', tone: 'bg-critical-50 text-critical-700' },
  auditor_download: { label: 'Downloaded', icon: 'Download', tone: 'bg-success-50 text-success-700' },
  auditor_view_cascade: { label: 'Opened cascade', icon: 'GitBranch', tone: 'bg-violet-50 text-violet-700' },
  auditor_share_preview: { label: 'Staff preview', icon: 'Eye', tone: 'bg-slate-100 text-slate-600' },
  auditor_request: { label: 'Requested', icon: 'ListChecks', tone: 'bg-amber-50 text-amber-700' },
  auditor_request_approved: { label: 'Request approved', icon: 'CheckCircle2', tone: 'bg-success-50 text-success-700' },
  auditor_request_declined: { label: 'Request declined', icon: 'XCircle', tone: 'bg-critical-50 text-critical-700' },
  auditor_request_withdrawn: { label: 'Request withdrawn', icon: 'XCircle', tone: 'bg-slate-100 text-slate-600' },
};

function ActivityList({ items, regTitle }: { items: AuditorActivity[]; regTitle: Map<string, string> }) {
  const t = useT();
  if (!items.length) return <EmptyState title="No activity yet" hint="Shares, revocations and everything the auditor opens are listed here." icon="Activity" />;
  return (
    <ol className="space-y-2">
      {items.map((e, i) => {
        const m = ACT[e.action] ?? { label: e.action, icon: 'Activity', tone: 'bg-slate-100 text-slate-600' };
        const det = typeof e.detail === 'object' && e.detail ? e.detail as Record<string, string> : {};
        const what = det.title ?? det.file ?? regTitle.get(e.entity_id) ?? e.entity_id;
        return (
          <li key={`${e.at}-${i}`} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2 text-[13px]">
            <span className={cn('inline-flex min-w-[124px] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', m.tone)}>
              <Icon name={m.icon === 'Send' ? 'ArrowRight' : m.icon} className="h-3.5 w-3.5" />{t(m.label)}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink" title={what}>{what}</span>
            <span className="hidden truncate text-xs text-muted md:block">{e.actor}</span>
            <span className="whitespace-nowrap text-xs tabular-nums text-muted">{e.at.slice(0, 16).replace('T', ' ')} UTC</span>
          </li>
        );
      })}
    </ol>
  );
}
