/**
 * The external auditor's whole app: two destinations and nothing else.
 *
 *   Shared with you   the regulations and documents the hospital sent, with download
 *   Impact Cascade    the cascade of the shared regulations, read-only
 *
 * The server is what enforces this (role 'auditor' inherits no capability but
 * 'audit'; /api/cascade serves only shared regulations to it). This shell only
 * makes sure an auditor is never shown a screen that would fail.
 */
import { useState } from 'react';
import { Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Brain, FileSpreadsheet, FileText, FileImage, Download, Lock } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { CascadePage } from '@/modules/cascade/CascadePage';
import { Callout, EmptyState, IconTile, Skeleton } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import {
  REQUEST_STATUS, day, downloadShare, fileSize, useCatalogue, useMakeRequest, useMyRequests, useSharedWithMe, useWithdrawRequest,
  type AuditorRequest, type Share, type SharedRegulation,
} from '@/services/auditorApi';
import { tx, useT } from '@/i18n';

/** Shown in place of the normal app when the signed-in user is an auditor. */
export function AuditorShell() {
  const { pathname } = useLocation();
  const onCascade = pathname.startsWith('/cascade');
  const onRequests = pathname === '/auditor/requests';
  if (!onCascade && !onRequests && pathname !== '/auditor') return <Navigate to="/auditor" replace />;
  return (
    <div className="flex min-h-screen">
      <AuditorSidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {onCascade ? <CascadePage /> : onRequests ? <AuditorRequestsPage /> : <AuditorHomePage />}
      </main>
    </div>
  );
}

function AuditorSidebar() {
  const t = useT();
  const { data } = useSharedWithMe();
  const reqs = useMyRequests();
  const waiting = (reqs.data?.items ?? []).filter((r) => r.status === 'PENDING').length;
  const items = [
    { to: '/auditor', label: 'Shared with you', icon: 'Inbox', n: (data?.documents.length ?? 0) + (data?.regulations.length ?? 0) },
    { to: '/cascade', label: 'Requirements check', icon: 'ClipboardCheck', n: data?.regulations.length ?? 0 },
    { to: '/auditor/requests', label: 'Requests', icon: 'ListChecks', n: waiting },
  ];
  return (
    <aside className="sticky top-0 flex h-screen w-[252px] shrink-0 flex-col border-r border-slate-200/80 bg-slate-50">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200/80 px-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-orange-400 via-amber-500 to-orange-600 shadow-[0_4px_12px_rgba(234,88,12,.35)]">
          <Brain className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="text-[16px] font-bold tracking-tight text-ink">Company Brain</div>
          <div className="text-[11.5px] font-medium text-orange-700">{t('Auditor portal')}</div>
        </div>
      </div>
      <nav aria-label={t('Auditor')} className="flex-1 space-y-px px-3 pt-4">
        <div className="mb-1 flex items-center gap-2 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-orange-500" aria-hidden="true" />{t('Your review')}
        </div>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end
            className={({ isActive }) => cn('group flex items-center gap-2.5 rounded-xl py-[3px] pl-[6px] pr-2.5 text-[13.5px] transition-all',
              isActive ? 'bg-white font-semibold text-ink shadow-[0_1px_3px_rgba(15,23,42,0.08),0_0_0_1px_rgba(15,23,42,0.04)]'
                : 'font-medium text-slate-600 hover:bg-white/70 hover:text-ink')}>
            {({ isActive }) => (<>
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg',
                isActive ? 'bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-sm' : 'text-slate-500 group-hover:bg-slate-100')}>
                <Icon name={i.icon} className="h-[17px] w-[17px]" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t(i.label)}</span>
              {i.n > 0 && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-orange-700">{i.n}</span>}
            </>)}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-slate-200/80 p-3">
        <div className="rounded-xl border border-orange-200 bg-white p-3 text-[12px] leading-relaxed text-slate-600">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-orange-700"><Lock className="h-3.5 w-3.5" /> {t('Read-only access')}</div>
          {data?.company
            ? t('{company} decides what you can see. Each document you open is recorded.', {
                company: data.company.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase()),
              })
            : t('The hospital decides what you can see. Each document you open is recorded.')}
        </div>
      </div>
    </aside>
  );
}

/** Shared with you — for the auditor, or a staff preview of one auditor's view (previewId). */
export function AuditorHomePage({ previewId }: { previewId?: string }) {
  const navigate = useNavigate();
  const t = useT();
  const { data, isLoading, error } = useSharedWithMe(previewId);
  const company = data?.company ? data.company.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase()) : t('The hospital');
  const latest = [...(data?.regulations ?? []), ...(data?.documents ?? [])].map((s) => s.shared_at).sort().pop();

  return (
    <div>
      <Topbar
        title={previewId ? t('Preview: what {name} sees', { name: data?.auditor?.name ?? t('this auditor') }) : t('Shared with you')}
        subtitle={t('{company} has shared these for your review. Access is read-only.', { company })}
        onBack={previewId ? () => navigate('/auditor-access') : undefined}
        backLabel="Back to Auditor access"
        meta={data ? [
          { icon: 'GitBranch', label: 'Regulations', value: data.regulations.length },
          { icon: 'Paperclip', label: 'Documents', value: data.documents.length },
          ...(latest ? [{ icon: 'Calendar', label: 'Last shared', value: day(latest) }] : []),
        ] : undefined}
      />
      <div className="space-y-5 p-6">
        {isLoading && <div className="card"><Skeleton rows={5} /></div>}
        {error && <Callout tone="red" title="Could not load what was shared">{(error as Error).message}</Callout>}
        {data && (<>
          <Callout tone="amber" icon="Lock" title="Read-only access">
            {t('You see only what {company} has shared with you. Each document you download and each cascade you open is recorded in the hospital’s audit trail.', { company })}
          </Callout>
          {!previewId && (
            <div className="card flex flex-wrap items-center gap-4 p-4">
              <IconTile icon="ListChecks" tone="orange" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink">{t('Need another regulation or a document?')}</div>
                <div className="text-[13px] text-muted">{t('Ask the hospital for it. In the requirements check, each requirement also has an Ask for files button.')}</div>
              </div>
              <button className="btn btn-primary" onClick={() => navigate('/auditor/requests')}>{t('Make a request')} <Icon name="ArrowRight" className="h-4 w-4" /></button>
            </div>
          )}

          <section>
            <div className="mb-3 flex items-center gap-2.5">
              <IconTile icon="GitBranch" tone="purple" size="sm" />
              <h2 className="text-[17px] font-semibold text-ink">{t('Impact cascade')}</h2>
              <span className="text-[13px] text-muted">{t('Each obligation traced to the risk, policy, control and owner behind it')}</span>
            </div>
            {data.regulations.length === 0 ? (
              <div className="card"><EmptyState title="No regulation has been shared with you yet" hint="When the hospital shares one, its impact cascade appears here." icon="GitBranch" /></div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.regulations.map((r) => <RegulationCard key={r.id} r={r} preview={!!previewId} onOpen={() => navigate(`/cascade?reg=${encodeURIComponent(r.ref)}`)} />)}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2.5">
              <IconTile icon="Paperclip" tone="teal" size="sm" />
              <h2 className="text-[17px] font-semibold text-ink">{t('Documents')}</h2>
              <span className="text-[13px] text-muted">{t('Policies, manuals, registers and files sent to you')}</span>
            </div>
            <div className="card overflow-hidden">
              {data.documents.length === 0
                ? <EmptyState title="No document has been shared with you yet" hint="Files the hospital sends you appear here, ready to download." icon="Paperclip" />
                : <DocumentTable rows={data.documents} />}
            </div>
          </section>
        </>)}
      </div>
    </div>
  );
}

/** Requests — ask for another regulation's cascade, or anything else; and follow every request. */
function AuditorRequestsPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const cat = useCatalogue(q);
  const mine = useMyRequests();
  const make = useMakeRequest();
  const withdraw = useWithdrawRequest();
  const [asking, setAsking] = useState<{ id: string; title: string } | null>(null);
  const [why, setWhy] = useState('');
  const [other, setOther] = useState({ title: '', message: '' });
  const [unlisted, setUnlisted] = useState<{ title: string; regulator: string; reference: string; message: string } | null>(null);
  const [sent, setSent] = useState('');
  const items = mine.data?.items ?? [];
  const send = (body: Parameters<typeof make.mutate>[0], label: string) =>
    make.mutate(body, { onSuccess: () => { setSent(label); setAsking(null); setWhy(''); setOther({ title: '', message: '' }); setUnlisted(null); } });
  const openUnlisted = () => { setSent(''); setUnlisted({ title: q.trim(), regulator: '', reference: '', message: '' }); };

  return (
    <div>
      <Topbar title="Requests" subtitle="Ask the hospital for another regulation’s cascade, or any document or record you need. They approve or decline each one." />
      <div className="space-y-5 p-6">
        {sent && <Callout tone="green" icon="CheckCircle2" title="Request sent">{t('“{title}” is with the hospital. Its status is below.', { title: sent })}</Callout>}
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="card p-5">
            <div className="mb-3 flex items-center gap-2.5">
              <IconTile icon="GitBranch" tone="purple" size="sm" />
              <h2 className="text-[16px] font-semibold text-ink">{t('Ask for a regulation')}</h2>
            </div>
            <input className="input w-full" placeholder={t('Search by name or regulator, e.g. NABL, biomedical waste, fire…')} value={q}
                   onChange={(e) => setQ(e.target.value)} aria-label={t('Search regulations')} />
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
              {q.trim().length < 2 && <li className="px-3 py-6 text-center text-[13px] text-muted">{t('Type at least two letters.')}</li>}
              {q.trim().length >= 2 && cat.isLoading && <li className="px-3 py-6 text-center text-[13px] text-muted">{t('Searching…')}</li>}
              {q.trim().length >= 2 && cat.data && cat.data.items.length === 0 && (
                <li className="px-3 py-6 text-center text-[13px] text-muted">
                  {t('Not in the hospital’s library.')}{' '}
                  <button className="font-semibold text-brand-600 hover:underline" onClick={openUnlisted}>{t('Ask them to add it')}</button>
                </li>
              )}
              {(cat.data?.items ?? []).map((r) => (
                <li key={r.id} className="px-3 py-2.5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium leading-snug text-ink">{r.title}</div>
                      <div className="text-xs text-muted">{r.regulator}</div>
                    </div>
                    {r.shared ? <span className="pill bg-success-50 text-success-700">{t('Shared with you')}</span>
                      : r.requested ? <span className="pill bg-amber-50 text-amber-700">{t('Requested')}</span>
                        : <button className="btn btn-outline btn-sm" onClick={() => { setAsking({ id: r.id, title: r.title }); setWhy(''); setSent(''); }}>{t('Request')}</button>}
                  </div>
                  {asking?.id === r.id && (
                    <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2.5">
                      <textarea className="input h-[70px] w-full py-2 text-[13px]" maxLength={1000} value={why} onChange={(e) => setWhy(e.target.value)}
                                placeholder={t('Why you need it (optional)')} aria-label={t('Why you need it')} />
                      <div className="flex justify-end gap-2">
                        <button className="btn btn-sm" onClick={() => setAsking(null)}>{t('Cancel')}</button>
                        <button className="btn btn-primary btn-sm" disabled={make.isPending}
                                onClick={() => send({ kind: 'regulation', ref: r.id, message: why }, r.title)}>{t('Send request')}</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!!cat.data?.more && <p className="mt-1.5 text-xs text-muted">{t('{n} more match; narrow the search.', { n: cat.data.more.toLocaleString() })}</p>}
            {!unlisted ? (
              <p className="mt-2.5 text-xs text-muted">
                {t('Not in the list?')}{' '}
                <button className="font-semibold text-brand-600 hover:underline" onClick={openUnlisted}>{t('Ask for a regulation the hospital hasn’t added')}</button>
              </p>
            ) : (
              <form className="mt-3 space-y-2.5 rounded-xl border border-line bg-slate-50 p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send({ kind: 'regulation', title: unlisted.title, regulator: unlisted.regulator, reference: unlisted.reference,
                             message: unlisted.message }, unlisted.title);
                    }}>
                <div className="text-[13px] font-semibold text-ink">{t('A regulation that isn’t in the hospital’s library')}</div>
                <p className="text-xs text-muted">{t('The hospital adds it, assesses what it means for them, and then shares its impact cascade with you.')}</p>
                <label className="block"><span className="field-label">{t('Name of the regulation, act or standard')}</span>
                  <input className="input w-full" required minLength={3} maxLength={200} value={unlisted.title}
                         onChange={(e) => setUnlisted({ ...unlisted, title: e.target.value })}
                         placeholder={t('e.g. Bio-Medical Waste Management Rules, 2016')} /></label>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <label className="block"><span className="field-label">{t('Issued by (optional)')}</span>
                    <input className="input w-full" maxLength={120} value={unlisted.regulator}
                           onChange={(e) => setUnlisted({ ...unlisted, regulator: e.target.value })} placeholder={t('e.g. MoEFCC, NABH, CPCB')} /></label>
                  <label className="block"><span className="field-label">{t('Link or reference (optional)')}</span>
                    <input className="input w-full" maxLength={300} value={unlisted.reference}
                           onChange={(e) => setUnlisted({ ...unlisted, reference: e.target.value })} placeholder={t('URL, notification no., clause')} /></label>
                </div>
                <label className="block"><span className="field-label">{t('Why you need it (optional)')}</span>
                  <textarea className="input h-[64px] w-full py-2 text-[13px]" maxLength={1000} value={unlisted.message}
                            onChange={(e) => setUnlisted({ ...unlisted, message: e.target.value })} /></label>
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn btn-sm" onClick={() => setUnlisted(null)}>{t('Cancel')}</button>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={make.isPending}>{t('Send request')}</button>
                </div>
              </form>
            )}
          </section>

          <section className="card p-5">
            <div className="mb-3 flex items-center gap-2.5">
              <IconTile icon="Paperclip" tone="teal" size="sm" />
              <h2 className="text-[16px] font-semibold text-ink">{t('Ask for anything else')}</h2>
            </div>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); send({ kind: 'other', title: other.title, message: other.message }, other.title); }}>
              <label className="block"><span className="field-label">{t('What you need')}</span>
                <input className="input w-full" required minLength={3} maxLength={200} value={other.title} onChange={(e) => setOther({ ...other, title: e.target.value })}
                       placeholder={t('e.g. Fire NOC, BMW authorisation, training records for Q3')} /></label>
              <label className="block"><span className="field-label">{t('Details or reason (optional)')}</span>
                <textarea className="input h-[96px] w-full py-2 text-[13px]" maxLength={1000} value={other.message}
                          onChange={(e) => setOther({ ...other, message: e.target.value })} placeholder={t('Period, department, or what would satisfy you')} /></label>
              <button type="submit" className="btn btn-primary" disabled={make.isPending}>{t('Send request')}</button>
            </form>
            <p className="mt-3 text-xs text-muted">{t('For the documents behind one requirement, use Ask for files in the requirements check.')}</p>
          </section>
        </div>
        {make.error && <Callout tone="red" title="Not sent">{make.error.message}</Callout>}

        <section className="card overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
            <IconTile icon="ListChecks" tone="orange" size="sm" />
            <h2 className="flex-1 text-[16px] font-semibold text-ink">{t('Your requests')}</h2>
            <span className="text-xs text-muted">{t('{n} waiting', { n: items.filter((r) => r.status === 'PENDING').length.toLocaleString() })}</span>
          </div>
          {items.length === 0
            ? <EmptyState title="No requests yet" hint="What you ask for, and the hospital’s answer, appear here." icon="ListChecks" />
            : <ul className="divide-y divide-line">{items.map((r) => <RequestRow key={r.id} r={r} onWithdraw={() => withdraw.mutate(r.id)} />)}</ul>}
        </section>
      </div>
    </div>
  );
}

const KIND_WORD: Record<string, string> = { regulation: tx('Regulation'), document: tx('Documents'), other: tx('Other') };

function RequestRow({ r, onWithdraw }: { r: AuditorRequest; onWithdraw: () => void }) {
  const t = useT();
  const s = REQUEST_STATUS[r.status];
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{r.title}</span>
          <span className="pill bg-slate-100 text-slate-600">{t(KIND_WORD[r.kind])}</span>
          <span className={cn('pill', s.cls)}>{t(s.label)}</span>
          {r.context.not_in_library && r.status === 'PENDING' && (
            <span className="pill bg-violet-50 text-violet-700" title={t('The hospital has to add it to its library and assess it before it can be shared')}>
              {t('to be added by the hospital')}
            </span>
          )}
        </div>
        {r.context.not_in_library && (r.context.regulator || r.context.reference) && (
          <div className="mt-0.5 text-xs text-muted">{[r.context.regulator, r.context.reference].filter(Boolean).join(' · ')}</div>
        )}
        {r.kind === 'document' && r.context.obligation && <div className="mt-0.5 text-xs text-muted">{r.context.obligation}</div>}
        {r.message && <div className="mt-1 text-[12.5px] text-ink-2">{t('You wrote: “{message}”', { message: r.message })}</div>}
        {r.decision_note && (
          <div className={cn('mt-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]', r.status === 'DECLINED' ? 'bg-critical-50 text-critical-700' : 'bg-success-50 text-success-700')}>
            {r.decided_by_name ?? t('The hospital')}: “{r.decision_note}”
          </div>
        )}
        <div className="mt-1 text-xs text-muted">
          {t('Asked {date}', { date: day(r.created_at) })}{r.decided_at && r.status !== 'WITHDRAWN' ? ` · ${t('{status} {date}', { status: t(s.label).toLowerCase(), date: day(r.decided_at) })}` : ''}
          {r.status === 'APPROVED' && r.share_id ? ` · ${t('now under Shared with you')}` : ''}
        </div>
      </div>
      {r.status === 'PENDING' && <button className="btn btn-sm" onClick={onWithdraw}>{t('Withdraw')}</button>}
    </li>
  );
}

/** Staff route: /auditor-access/preview/:uid */
export function AuditorPreviewPage() {
  const { uid = '' } = useParams();
  return <AuditorHomePage previewId={uid} />;
}

function RegulationCard({ r, onOpen, preview }: { r: SharedRegulation; onOpen: () => void; preview: boolean }) {
  const t = useT();
  const g = r.regulation;
  const open = g ? Math.round((100 * g.unmet) / Math.max(1, g.applicable)) : 0;
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start gap-3">
        <IconTile icon="Landmark" tone="brand" />
        <div className="min-w-0 flex-1">
          {g?.regulator && <span className="pill bg-brand-50 text-brand-700">{g.regulator}</span>}
          <h3 className="mt-1.5 line-clamp-2 text-[15px] font-semibold leading-snug text-ink" title={r.title}>{g?.title ?? r.title}</h3>
        </div>
      </div>
      {g && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="text-ink-2"><b className="text-ink">{g.applicable.toLocaleString()}</b> {t('obligations')}</span>
            <span className="font-semibold text-critical-600">{t('{n} open', { n: g.unmet.toLocaleString() })}</span>
          </div>
          <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-success-100" title={t('{pct}% open', { pct: open })}>
            <span className="h-full bg-critical-500" style={{ width: `${open}%` }} />
          </div>
        </div>
      )}
      {r.note && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">“{r.note}”</p>}
      <div className="mt-3 text-xs text-muted">
        {r.shared_by_name
          ? t('Shared {date} by {name}', { date: day(r.shared_at), name: r.shared_by_name })
          : t('Shared {date}', { date: day(r.shared_at) })}
        {r.expires_at ? ` · ${t('until {date}', { date: day(r.expires_at) })}` : ''}
      </div>
      <button onClick={onOpen} disabled={preview} title={preview ? t('Open from the auditor’s own account') : undefined}
              className="btn btn-primary mt-4 self-start disabled:opacity-60">
        {t('Open requirements')} <Icon name="ArrowRight" className="h-4 w-4" />
      </button>
    </div>
  );
}

function FileIcon({ name }: { name: string | null }) {
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return <span className="grid h-9 w-9 place-items-center rounded-lg bg-success-50 text-success-600"><FileSpreadsheet className="h-[18px] w-[18px]" /></span>;
  if (['png', 'jpg', 'jpeg'].includes(ext)) return <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-50 text-violet-600"><FileImage className="h-[18px] w-[18px]" /></span>;
  if (ext === 'pdf') return <span className="grid h-9 w-9 place-items-center rounded-lg bg-critical-50 text-critical-600"><FileText className="h-[18px] w-[18px]" /></span>;
  return <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-600"><FileText className="h-[18px] w-[18px]" /></span>;
}

function DocumentTable({ rows }: { rows: Share[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const get = async (s: Share) => {
    setBusy(s.id); setMsg(null);
    try { const name = await downloadShare(s); setMsg({ id: s.id, text: t('Downloaded {name}', { name }), ok: true }); }
    catch (e) { setMsg({ id: s.id, text: (e as Error).message, ok: false }); }
    finally { setBusy(null); }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line bg-slate-50/80 text-left text-xs font-semibold text-muted">
            <th className="px-4 py-2.5">{t('Document')}</th>
            <th className="px-4 py-2.5">{t('Note from the hospital')}</th>
            <th className="px-4 py-2.5">{t('Shared')}</th>
            <th className="px-4 py-2.5">{t('Available until')}</th>
            <th className="px-4 py-2.5 text-right">{t('Download')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-b border-line last:border-0 align-top">
              <td className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <FileIcon name={s.file_name} />
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{s.title}</div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {[s.file_name, fileSize(s.file_size), t(s.kind === 'file' ? 'sent to you' : 'from the hospital’s records')].filter(Boolean).join(' · ')}
                    </div>
                    {msg?.id === s.id && <div className={cn('mt-1 text-xs', msg.ok ? 'text-success-600' : 'text-critical-600')}>{msg.text}</div>}
                  </div>
                </div>
              </td>
              <td className="max-w-[320px] px-4 py-3 text-ink-2">{s.note ?? <span className="text-muted-2">—</span>}</td>
              <td className="whitespace-nowrap px-4 py-3 text-ink-2">{day(s.shared_at)}<div className="text-xs text-muted">{s.shared_by_name ?? ''}</div></td>
              <td className="whitespace-nowrap px-4 py-3 text-ink-2">{s.expires_at ? day(s.expires_at) : <span className="text-muted">{t('No end date')}</span>}</td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => void get(s)} disabled={busy === s.id || s.available === false}
                        title={s.available === false ? t('This file is not on the server — ask the hospital to share it again') : t('Download {name}', { name: s.file_name ?? s.title })}
                        className="btn btn-outline btn-sm disabled:opacity-50">
                  <Download className="h-3.5 w-3.5" /> {t(busy === s.id ? 'Preparing…' : 'Download')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
