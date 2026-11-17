/**
 * One upload, sorted: what was found, where each document went, and the ones
 * waiting for a person. Every decision shows its evidence ("code NUR-SOP-11",
 * "the folder Nursing", "Approved by: …"). A correction can be remembered and is
 * applied to the rest of this upload and to the next one.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Undo2, X } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { Callout, EmptyState, MetricCard, Skeleton } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { useUi } from '@/app/store/ui';
import { can, useMe } from '@/services/authApi';
import {
  DOC_TYPES, STATUS_UI, fileName, useCorrectItem, useIntakeBatch, useIntakeDepartments, useIntakeItem, useSaveItems,
  useSkipItems, useUndoBatch, type DocType, type IntakeItem, type ItemStatus,
} from '@/services/intakeApi';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';

type View = 'review' | 'filed' | 'record' | 'other' | 'all';
const VIEWS: { id: View; label: string; has: ItemStatus[] }[] = [
  { id: 'review', label: 'Needs review', has: ['REVIEW', 'READY'] },
  { id: 'filed', label: 'Filed', has: ['SAVED'] },
  { id: 'record', label: 'Already on record', has: ['ON_RECORD'] },
  { id: 'other', label: 'Duplicates & left out', has: ['DUPLICATE', 'SKIPPED', 'UNDONE'] },
  { id: 'all', label: 'All', has: [] },
];
const TYPE_TONE: Partial<Record<DocType, string>> = {
  Policy: 'bg-purple-50 text-purple-700', SOP: 'bg-brand-50 text-brand-700', Form: 'bg-teal-50 text-teal-700',
  Register: 'bg-teal-50 text-teal-700', Plan: 'bg-indigo-50 text-indigo-700', Manual: 'bg-slate-100 text-slate-700',
  Licence: 'bg-amber-50 text-amber-800', 'Job description': 'bg-pink-50 text-pink-700', Minutes: 'bg-slate-100 text-slate-700',
};
const NEW_DEPT = '__new__';

export function IntakeBatchPage() {
  const t = useT();
  const locale = useDateLocale();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data: me } = useMe();
  const allowed = can(me, 'approve');
  const q = useIntakeBatch(id);
  const save = useSaveItems();
  const skip = useSkipItems();
  const undo = useUndoBatch();
  const [view, setView] = useState<View | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [note, setNote] = useState('');
  const [confirmUndo, setConfirmUndo] = useState(false);

  const d = q.data;
  const b = d?.batch;
  const items = useMemo(() => d?.items ?? [], [d]);
  const count = (v: View) => (v === 'all' ? items.length : items.filter((i) => VIEWS.find((x) => x.id === v)!.has.includes(i.status)).length);
  // open on what needs a person; otherwise on what was filed
  useEffect(() => {
    if (!view && b && b.status !== 'RUNNING') setView(count('review') ? 'review' : 'filed');
  }, [b, view]);   // eslint-disable-line react-hooks/exhaustive-deps
  const v = view ?? 'review';
  const shown = v === 'all' ? items : items.filter((i) => VIEWS.find((x) => x.id === v)!.has.includes(i.status));
  const pickable = shown.filter((i) => i.status === 'REVIEW' || i.status === 'READY');
  const chosen = [...sel].filter((x) => pickable.some((i) => i.id === x));

  if (q.isLoading) return <div><Topbar title="Document intake" icon="Files" /><div className="p-6"><div className="card"><Skeleton rows={8} /></div></div></div>;
  if (q.error || !d || !b || !d.summary) {
    return (
      <div><Topbar title="Document intake" icon="Files" />
        <div className="p-6"><Callout tone="red" title={t('This upload could not be loaded')}>{(q.error as Error)?.message ?? t('Not found')}</Callout></div>
      </div>
    );
  }
  const running = b.status === 'RUNNING';
  const proposed = d.summary.departments.filter((x) => x.status === 'proposed');

  return (
    <div>
      <Topbar title={b.label} icon="Files" subtitle={running ? tx('Sorting — this page updates by itself.') : b.message} />
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" onClick={() => nav('/intake')}><ArrowLeft className="h-3.5 w-3.5" /> {t('All uploads')}</button>
          <span className="text-xs text-muted">
            {t(b.integration_id ? 'From a connected folder by {who}' : 'Uploaded by {who}', { who: b.created_by.replace(/^integration:/, `${t('connection')} `) })} ·
            {' '}{new Date(b.created_at).toLocaleString(locale)}
          </span>
          <span className="flex-1" />
          {allowed && !running && b.status !== 'UNDONE' && d.summary.status.SAVED > 0 && (
            confirmUndo ? (
              <span className="flex items-center gap-2 rounded-lg border border-critical-200 bg-critical-50 px-3 py-1.5 text-[12.5px] text-critical-700">
                {d.summary.status.SAVED === 1
                  ? t('Remove the 1 record this upload filed? Records already verified are kept.')
                  : t('Remove the {n} records this upload filed? Records already verified are kept.', { n: d.summary.status.SAVED.toLocaleString() })}
                <button className="btn btn-sm btn-danger" disabled={undo.isPending}
                        onClick={() => undo.mutate(b.id, { onSuccess: (r) => { setConfirmUndo(false); setNote(r.kept_verified
                          ? t('{removed} records removed, {kept} verified kept.', { removed: r.removed, kept: r.kept_verified })
                          : t('{removed} records removed.', { removed: r.removed })); } })}>
                  {t('Undo upload')}
                </button>
                <button className="btn btn-sm" onClick={() => setConfirmUndo(false)}>{t('Cancel')}</button>
              </span>
            ) : (
              <button className="btn btn-sm btn-outline" onClick={() => setConfirmUndo(true)}><Undo2 className="h-3.5 w-3.5" /> {t('Undo this upload')}</button>
            )
          )}
        </div>

        {running && (
          <div className="card p-5">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium text-ink">{b.message}</span>
              <span className="tabular-nums text-muted">{t('{done} / {total} files', { done: b.files_done, total: b.files_total || '…' })}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-brand-500 transition-all"
                   style={{ width: `${b.files_total ? Math.max(4, (b.files_done / b.files_total) * 100) : 4}%` }} />
            </div>
          </div>
        )}
        {b.status === 'FAILED' && <Callout tone="red" title={t('Sorting stopped')}>{b.message}</Callout>}
        {note && <Callout tone="green" icon="CheckCircle2" title={note} />}

        {!running && (<>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label={t('Documents found')} value={items.length} tone="brand" icon="Files"
                        foot={new Set(items.map((i) => i.file)).size === 1 ? t('in 1 file') : t('in {n} files', { n: new Set(items.map((i) => i.file)).size.toLocaleString() })} onClick={() => setView('all')} active={v === 'all'} />
            <MetricCard label={t('Filed automatically')} value={items.filter((i) => i.status === 'SAVED' && i.saved_how === 'auto').length}
                        tone="green" icon="CheckCircle2" foot={t('verification pending')} onClick={() => setView('filed')} active={v === 'filed'} />
            <MetricCard label={t('Need a person')} value={count('review')} tone="amber" icon="ListChecks"
                        foot={count('review') ? t('reason shown on each') : t('nothing waiting')} onClick={() => setView('review')} active={v === 'review'} />
            <MetricCard label={t('Already on record')} value={count('record')} tone="gray" icon="FileCheck"
                        foot={t('not filed twice')} onClick={() => setView('record')} active={v === 'record'} />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="card p-4">
              <div className="sec-eyebrow">{t('What it found')}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.summary.types.map((ty) => (
                  <span key={ty.type} className={cn('pill', TYPE_TONE[ty.type] ?? 'bg-slate-100 text-slate-700')}>{t(ty.type)} · {ty.count}</span>
                ))}
              </div>
            </div>
            <div className="card p-4">
              <div className="sec-eyebrow">{t('Departments')}</div>
              <ul className="mt-2 space-y-1 text-[12.5px]">
                {d.summary.departments.slice(0, 7).map((x) => (
                  <li key={x.name || '—'} className="flex items-center gap-2">
                    <span className={cn('min-w-0 flex-1 truncate', !x.name && 'italic text-muted')}>{x.name || t('No department found')}</span>
                    {x.status === 'proposed' && <span className="pill bg-amber-50 text-amber-800">{t('new')}</span>}
                    <span className="tabular-nums text-muted">{x.count}</span>
                  </li>
                ))}
              </ul>
              {proposed.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {t('“new” departments are not in your structure; one is created only when you file a document into it.')}
                </p>
              )}
            </div>
            <div className="card p-4">
              <div className="sec-eyebrow">{t('People named')}</div>
              <div className="mt-2 text-[13px] text-ink-2">
                <b className="text-success-600">{d.summary.people.matched}</b> {t('matched to your employee directory')} ·{' '}
                <b className="text-ink">{d.summary.people.unmatched}</b> {t('not matched')}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {t('Unmatched are mostly roles (“Nursing Superintendent”) — kept as written on the record, never guessed.')}
              </p>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 pt-2">
              {VIEWS.map((x) => (
                <button key={x.id} onClick={() => { setView(x.id); setSel(new Set()); }}
                        className={cn('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium',
                          v === x.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}>
                  {t(x.label)} <span className="ml-0.5 tabular-nums text-xs text-muted">{count(x.id)}</span>
                </button>
              ))}
              <span className="flex-1" />
              {allowed && v === 'review' && (
                <label className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-2" title={t('A corrected department for a code prefix or folder, or a corrected type for a code token, is applied to the next upload too')}>
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  {t('Remember my corrections')}
                </label>
              )}
            </div>

            {allowed && chosen.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-50/60 px-4 py-2 text-[13px]">
                <b>{t('{n} selected', { n: chosen.length.toLocaleString() })}</b>
                <button className="btn btn-primary btn-sm" disabled={save.isPending}
                        onClick={() => save.mutate(chosen, { onSuccess: (r) => { setSel(new Set()); setNote(t('{n} filed into the company structure.', { n: r.saved })); } })}>
                  <Check className="h-3.5 w-3.5" /> {t('File into the structure')}
                </button>
                <button className="btn btn-sm" disabled={skip.isPending}
                        onClick={() => skip.mutate(chosen, { onSuccess: (r) => { setSel(new Set()); setNote(t('{n} left out.', { n: r.skipped })); } })}>
                  <X className="h-3.5 w-3.5" /> {t('Leave out')}
                </button>
              </div>
            )}

            {shown.length === 0 ? (
              <EmptyState icon={v === 'review' ? 'CheckCircle2' : 'Inbox'}
                          title={t(v === 'review' ? 'Nothing waiting for review' : 'Nothing here')}
                          hint={v === 'review' ? t('Every document in this upload was filed, recognised or left out.') : undefined} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-slate-50/80 text-left text-xs font-semibold text-muted">
                      {allowed && v !== 'filed' && v !== 'record' && (
                        <th className="w-9 px-3 py-2.5">
                          <input type="checkbox" aria-label={t('Select all')}
                                 checked={pickable.length > 0 && chosen.length === pickable.length}
                                 onChange={(e) => setSel(new Set(e.target.checked ? pickable.map((i) => i.id) : []))} />
                        </th>
                      )}
                      <th className="px-3 py-2.5">{t('Document')}</th>
                      <th className="px-3 py-2.5">{t('Type')}</th>
                      <th className="px-3 py-2.5">{t('Department')}</th>
                      <th className="px-3 py-2.5">{t('Owner / approver')}</th>
                      <th className="px-3 py-2.5">{t(v === 'review' ? 'Why it waits' : 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((it) => (
                      <ItemRow key={it.id} it={it} editable={allowed && (it.status === 'REVIEW' || it.status === 'READY')}
                               selectable={allowed && v !== 'filed' && v !== 'record'}
                               checked={sel.has(it.id)} remember={remember}
                               onCheck={(c) => setSel((s) => { const n = new Set(s); if (c) n.add(it.id); else n.delete(it.id); return n; })}
                               onOpen={() => setOpen(it.id)} onLearned={setNote} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>)}
      </div>
      {open && <ItemPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ItemRow({ it, editable, selectable, checked, remember, onCheck, onOpen, onLearned }: {
  it: IntakeItem; editable: boolean; selectable: boolean; checked: boolean; remember: boolean;
  onCheck: (c: boolean) => void; onOpen: () => void; onLearned: (s: string) => void;
}) {
  const t = useT();
  const fix = useCorrectItem();
  const depts = useIntakeDepartments();
  const [newDept, setNewDept] = useState<string | null>(null);
  const change = (body: { doc_type?: DocType; department?: string }) =>
    fix.mutate({ id: it.id, ...body, remember }, {
      onSuccess: (r) => {
        if (r.learned.length) {
          const items = r.learned.map((l) => t('{kind} “{key}” → {value}', {
            kind: t(l.kind === 'type_token' ? 'code type' : l.kind === 'prefix_department' ? 'code prefix' : 'folder'), key: l.key, value: l.value,
          })).join('; ');
          onLearned(r.applied
            ? t('Remembered: {items} — applied to {n} more in this upload.', { items, n: r.applied })
            : t('Remembered: {items}. Applied to future uploads.', { items }));
        }
      },
    });
  const st = STATUS_UI[it.status];
  return (
    <tr className={cn('border-b border-line align-top last:border-0', checked && 'bg-brand-50/40')}>
      {selectable && (
        <td className="px-3 py-3">
          {editable && <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={t('Select {name}', { name: it.title })} />}
        </td>
      )}
      <td className="max-w-[340px] px-3 py-3">
        <button onClick={onOpen} className="block text-left font-medium text-ink hover:text-brand-700 hover:underline">
          {it.title || fileName(it.file)}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {it.code && <span className="font-mono text-[11.5px] text-ink-2">{it.code}</span>}
          <span className="truncate" title={it.file}>{fileName(it.file)}{it.parts > 1 ? ` · ${t('part {n} of {total}', { n: it.part, total: it.parts })}` : ''}</span>
          {it.ocr ? <span className="pill bg-slate-100 text-slate-600">{t('read by OCR')}</span> : null}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        {editable ? (
          <select className="input h-8 w-[150px] text-[12.5px]" value={it.doc_type} disabled={fix.isPending}
                  onChange={(e) => change({ doc_type: e.target.value as DocType })}>
            {DOC_TYPES.map((o) => <option key={o} value={o}>{t(o)}</option>)}
          </select>
        ) : (
          <span className={cn('pill', TYPE_TONE[it.doc_type] ?? 'bg-slate-100 text-slate-700')}>{t(it.doc_type)}</span>
        )}
        <div className="mt-1 text-[11.5px] text-muted" title={it.type_evidence}>
          {it.type_method === 'person' ? t('set by a person') : `${it.type_confidence}% · ${t(it.type_method === 'ai' ? 'local AI' : 'rules')}`}
        </div>
      </td>
      <td className="px-3 py-3">
        {editable ? (
          newDept !== null ? (
            <span className="flex items-center gap-1">
              <input className="input h-8 w-[150px] text-[12.5px]" autoFocus value={newDept} placeholder={t('New department name')}
                     onChange={(e) => setNewDept(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter' && newDept.trim()) { change({ department: newDept.trim() }); setNewDept(null); } if (e.key === 'Escape') setNewDept(null); }} />
              <button className="btn btn-sm" onClick={() => { if (newDept.trim()) change({ department: newDept.trim() }); setNewDept(null); }}>{t('OK')}</button>
            </span>
          ) : (
            <select className={cn('input h-8 w-[180px] text-[12.5px]', it.department_status !== 'matched' && 'border-warning-500')}
                    value={it.department_status === 'matched' ? it.department : it.department ? `p:${it.department}` : ''}
                    disabled={fix.isPending}
                    onChange={(e) => { const x = e.target.value; if (x === NEW_DEPT) setNewDept(''); else change({ department: x.replace(/^p:/, '') }); }}>
              <option value="">{t('— none —')}</option>
              {it.department_status === 'proposed' && it.department && <option value={`p:${it.department}`}>{it.department} ({t('new')})</option>}
              {(depts.data?.items ?? []).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
              <option value={NEW_DEPT}>{t('+ New department…')}</option>
            </select>
          )
        ) : (
          <span className={cn(!it.department && 'italic text-muted')}>
            {it.department || t('none')}{it.department_status === 'proposed' && <span className="pill ml-1 bg-amber-50 text-amber-800">{t('new')}</span>}
          </span>
        )}
        {it.department_evidence && <div className="mt-1 max-w-[220px] truncate text-[11.5px] text-muted" title={it.department_evidence}>{it.department_evidence}</div>}
      </td>
      <td className="max-w-[200px] px-3 py-3 text-[12.5px]">
        {it.owner_text ? <div className="truncate" title={it.owner_text}>{it.owner_text}{it.owner_id && <Icon name="BadgeCheck" className="ml-1 inline h-3.5 w-3.5 text-success-600" />}</div> : <span className="text-muted-2">—</span>}
        {it.approver_text && <div className="truncate text-xs text-muted" title={it.approver_text}>{t('approved:')} {it.approver_text}</div>}
      </td>
      <td className="max-w-[260px] px-3 py-3">
        {it.status === 'REVIEW' || it.status === 'READY' ? (
          it.reasons.length ? (
            <ul className="space-y-0.5 text-[12.5px] text-warning-700">{it.reasons.map((r) => <li key={r}>• {r}</li>)}</ul>
          ) : <span className="text-[12.5px] text-success-600">{t('resolved — ready to file')}</span>
        ) : (
          <>
            <span className={cn('pill', st.cls)} title={t(st.hint)}>{t(st.label)}</span>
            {it.reasons[0] && <div className="mt-1 text-[11.5px] text-muted">{it.reasons[0]}</div>}
          </>
        )}
      </td>
    </tr>
  );
}

function ItemPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const q = useIntakeItem(id);
  const openEntity = useUi((s) => s.openEntity);
  const it = q.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside className="flex h-full w-full max-w-[560px] flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="sec-eyebrow">{it ? `${t(it.doc_type)}${it.code ? ` · ${it.code}` : ''}` : t('Document')}</div>
            <h3 className="mt-0.5 text-base font-semibold text-ink">{it?.title ?? '…'}</h3>
            {it && <div className="mt-0.5 break-all text-xs text-muted">{it.file}{it.parts > 1 ? ` · ${t('part {n} of {total}', { n: it.part, total: it.parts })}` : ''}</div>}
          </div>
          <button className="btn btn-sm" onClick={onClose} aria-label={t('Close')}><X className="h-4 w-4" /></button>
        </div>
        {!it ? <Skeleton rows={8} /> : (
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('pill', STATUS_UI[it.status].cls)}>{t(STATUS_UI[it.status].label)}</span>
              {it.entity && (
                <button className="btn btn-sm btn-outline" onClick={() => openEntity(it.entity!.id)}>
                  {t('Open the filed record')} <Icon name="ArrowUpRight" className="h-3.5 w-3.5" />
                </button>
              )}
              {it.existing && (
                <button className="btn btn-sm btn-outline" onClick={() => openEntity(it.existing!.id)}>
                  {t('Open the record already on file')} <Icon name="ArrowUpRight" className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {it.reasons.length > 0 && (it.status === 'REVIEW' || it.status === 'READY') && (
              <Callout tone="amber" title={t('Why it waits for a person')}>{it.reasons.join('; ')}</Callout>
            )}
            <Why label="Why this type" value={`${t(it.doc_type)} · ${it.type_method === 'person' ? t('set by a person') : `${it.type_confidence}%`}`} because={it.type_evidence} />
            <Why label="Why this department" value={it.department || t('none found')} because={it.department_evidence || t('nothing in the document, its code or its folder names one')} />
            {it.people.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted">{t('People named')}</div>
                <ul className="mt-1 space-y-1">
                  {it.people.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-[110px] shrink-0 text-muted">{p.label}</span>
                      <span className="min-w-0 flex-1">
                        {p.value}
                        {p.entity_id ? (
                          <button onClick={() => openEntity(p.entity_id!)} className="ml-1 text-xs font-medium text-success-600 hover:underline">✓ {t('in directory')}</button>
                        ) : <span className="ml-1 text-xs text-muted">({p.note === 'role' ? t('a role') : p.note})</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Small label="Version" v={it.version} /><Small label="Effective" v={it.effective_date} /><Small label="Review by" v={it.review_date} />
            </div>
            {it.refs.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted">{t('Other documents it names')}</div>
                <div className="mt-1 flex flex-wrap gap-1">{it.refs.map((r) => <span key={r} className="pill bg-slate-100 font-mono text-[11.5px] text-slate-700">{r}</span>)}</div>
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-muted">
                {it.ocr ? t('What was read (by OCR from a scan)') : t('What was read')} · {t('{n} characters', { n: it.chars.toLocaleString() })}
              </div>
              <pre className="mt-1 max-h-[340px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 p-3 font-sans text-[12px] leading-relaxed text-ink-2">
                {it.text || t('No text could be read from this file.')}
              </pre>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function Why({ label, value, because }: { label: string; value: string; because: string }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-muted">{t(label)}</span>
        <span className="font-medium text-ink">{value}</span>
      </div>
      <div className="mt-1 text-[12.5px] text-ink-2">{because}</div>
    </div>
  );
}

function Small({ label, v }: { label: string; v: string }) {
  const t = useT();
  return (
    <div>
      <div className="text-xs text-muted">{t(label)}</div>
      <div className="font-medium text-ink">{v || '—'}</div>
    </div>
  );
}
