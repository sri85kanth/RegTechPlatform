/**
 * Risk appetite — gate G1 (design §7). Leadership says, per category, how much
 * residual risk it accepts (appetite) and how much it tolerates before a risk is
 * escalated (tolerance). A compliance manager drafts; an admin, or someone an
 * admin named, approves or returns it. Every approved version is kept, with who
 * approved it and from when it applied.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, RotateCcw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { SidePanel, PanelHeader } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { Callout, Skeleton } from '@/components/ui/primitives';
import { can, useMe, type User } from '@/services/authApi';
import { api } from '@/services/http';
import {
  useAppetite, useApproveAppetite, useGrantGovernor, useReturnAppetite, useRevokeGovernor, useRiskMeta,
  useSaveAppetiteDraft, type AppetiteContent, type Band, type Category,
} from '@/services/riskApi';
import { cn } from '@/utils/ui';
import { useDateLocale, useT } from '@/i18n';
import { FieldRow } from './riskUi';
import { BAND_LABEL, BAND_TONE, CATEGORY_LABEL } from './labels';

const BANDS: Band[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RANK: Record<Band, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const clone = (c: AppetiteContent): AppetiteContent => JSON.parse(JSON.stringify(c));

export function AppetiteTab() {
  const t = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();
  const { data: st, isLoading, error } = useAppetite();
  const { data: meta } = useRiskMeta();
  const save = useSaveAppetiteDraft();
  const [content, setContent] = useState<AppetiteContent | null>(null);
  const [panel, setPanel] = useState<'approve' | 'return' | null>(null);
  const canDraft = can(me, 'approve');
  const source = st?.draft?.content ?? st?.approved?.content ?? st?.default;

  useEffect(() => {
    if (source && !content) setContent(clone(source));
  }, [source, content]);

  if (isLoading || !content || !st) return error ? <p className="text-critical-600">{(error as Error).message}</p> : <Skeleton rows={6} />;

  const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const categories = (meta?.categories ?? Object.keys(content.categories)) as Category[];
  const badRows = categories.filter((c) => RANK[content.categories[c].tolerance] < RANK[content.categories[c].appetite]);
  const setCat = (c: Category, patch: Partial<AppetiteContent['categories'][Category]>) =>
    setContent({ ...content, categories: { ...content.categories, [c]: { ...content.categories[c], ...patch } } });
  const draft = st.draft;
  const ownMatrix = !!content.matrix;

  return (
    <div className="space-y-4">
      {/* where it stands */}
      {draft?.status === 'DRAFT' ? (
        <Callout tone="amber" icon="Clock" title={t('Draft version {v} is waiting for approval', { v: draft.version })}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {st.canGovern ? t('Review the answers below, then approve or return them.') : t('Leadership approves it: an admin, or someone an admin named below.')}
            </span>
            {st.canGovern && (
              <>
                <button type="button" className="btn" onClick={() => setPanel('return')}><RotateCcw className="h-4 w-4" /> {t('Return')}</button>
                <button type="button" className="btn btn-primary" onClick={() => setPanel('approve')}><Check className="h-4 w-4" /> {t('Approve')}</button>
              </>
            )}
          </div>
        </Callout>
      ) : draft?.status === 'RETURNED' ? (
        <Callout tone="red" icon="AlertTriangle" title={t('Version {v} was returned', { v: draft.version })}>
          {draft.note} {t('Change it and save the draft again.')}
        </Callout>
      ) : st.approved ? (
        <Callout tone="green" icon="ShieldCheck" title={t('Version {v} is in force', { v: st.approved.version })}>
          {t('Approved by {name}, {designation}, on {date}.', {
            name: st.approved.approver_name ?? '—', designation: st.approved.approver_designation ?? '—', date: date(st.approved.valid_from) })}
        </Callout>
      ) : (
        <Callout tone="blue" icon="Info" title={t('No risk appetite is approved yet')}>
          {t('Until leadership approves one, risks are scored but none is judged against appetite: each says "review required".')}
        </Callout>
      )}

      {/* categories */}
      <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <header className="border-b border-line px-5 py-4">
          <h3 className="text-[15px] font-semibold text-ink">{t('Appetite and tolerance by category')}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {t('Appetite: the residual risk accepted without action. Tolerance: the most accepted before it is escalated. Zero tolerance escalates anything above appetite.')}
          </p>
        </header>
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50/70 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted">
            <tr><th className="px-5 py-2.5">{t('Category')}</th><th className="px-3 py-2.5">{t('Appetite')}</th>
              <th className="px-3 py-2.5">{t('Tolerance')}</th><th className="px-3 py-2.5">{t('Zero tolerance')}</th></tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const v = content.categories[c];
              const [label, hint] = CATEGORY_LABEL[c] ?? [c, ''];
              return (
                <tr key={c} className="border-t border-line/70 align-top">
                  <td className="px-5 py-3">
                    <div className="font-semibold text-ink">{t(label)}</div>
                    <div className="text-[12px] text-muted">{t(hint)}</div>
                    {badRows.includes(c) && <div className="mt-1 text-[12px] font-medium text-critical-600">{t('Tolerance cannot be below appetite.')}</div>}
                  </td>
                  <td className="px-3 py-3"><BandSelect value={v.appetite} disabled={!canDraft} onChange={(b) => setCat(c, { appetite: b })} label={`${t(label)} — ${t('Appetite')}`} /></td>
                  <td className="px-3 py-3"><BandSelect value={v.tolerance} disabled={!canDraft} onChange={(b) => setCat(c, { tolerance: b })} label={`${t(label)} — ${t('Tolerance')}`} /></td>
                  <td className="px-3 py-3">
                    <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={v.zero_tolerance} disabled={!canDraft}
                           onChange={(e) => setCat(c, { zero_tolerance: e.target.checked })} aria-label={`${t(label)} — ${t('Zero tolerance')}`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* thresholds */}
      <section className="grid gap-4 rounded-card border border-line bg-surface p-5 shadow-card md:grid-cols-2">
        <FieldRow label="Confidence threshold" hint="A risk inside appetite but scored with less confidence than this goes to a person to review.">
          <input type="number" min={0} max={100} className="input w-28 tabular-nums" disabled={!canDraft}
                 value={content.confidence_threshold}
                 onChange={(e) => setContent({ ...content, confidence_threshold: Number(e.target.value) })} />
        </FieldRow>
        <FieldRow label="Escalate to" hint="Who receives a risk beyond tolerance: a person, or a committee.">
          <input className="input w-full" disabled={!canDraft} value={content.escalation_to}
                 onChange={(e) => setContent({ ...content, escalation_to: e.target.value })} placeholder={t('Risk committee of the board')} />
        </FieldRow>
        <div className="md:col-span-2">
          <div className="mb-1 text-[12px] font-semibold text-ink-2">{t('Review every … days, by residual band')}</div>
          <div className="flex flex-wrap gap-2">
            {BANDS.slice().reverse().map((b) => (
              <label key={b} className={cn('flex items-center gap-2 rounded-xl px-3 py-1.5', BAND_TONE[b])}>
                <span className="text-[12.5px] font-semibold">{t(BAND_LABEL[b])}</span>
                <input type="number" min={1} max={730} className="input h-8 w-20 bg-white text-right tabular-nums" disabled={!canDraft}
                       value={content.review_cadence_days[b]}
                       onChange={(e) => setContent({ ...content, review_cadence_days: { ...content.review_cadence_days, [b]: Number(e.target.value) } })} />
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* own matrix */}
      <section className="rounded-card border border-line bg-surface p-5 shadow-card">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" disabled={!canDraft || !meta} checked={ownMatrix}
                 onChange={(e) => setContent({ ...content, matrix: e.target.checked && meta ? JSON.parse(JSON.stringify(meta.matrix)) : null })} />
          <span>
            <span className="block text-[14px] font-semibold text-ink">{t('Use our own risk matrix')}</span>
            <span className="block text-[12.5px] text-muted">
              {t('Impact and likelihood stay scored by the rulebook; your matrix only decides which band each pair falls in. Without one, the rulebook matrix applies.')}
            </span>
          </span>
        </label>
        {(ownMatrix || meta) && (
          <MatrixGrid matrix={(content.matrix ?? meta?.matrix ?? {}) as Record<string, Band[]>} editable={canDraft && ownMatrix}
                      onChange={(m) => setContent({ ...content, matrix: m })} />
        )}
      </section>

      {canDraft && (
        <div className="flex flex-wrap items-center gap-3">
          {save.error && <span role="alert" className="text-[12.5px] text-critical-600">{save.error.message}</span>}
          {save.isSuccess && !save.isPending && <span className="text-[12.5px] text-emerald-700">{t('Draft saved. Leadership can now approve it.')}</span>}
          <button type="button" className="btn btn-primary ml-auto" disabled={save.isPending || badRows.length > 0}
                  onClick={() => save.mutate(content)}>
            {t('Save draft for approval')}
          </button>
        </div>
      )}

      {can(me, 'administer') && <Governors />}

      {st.history.length > 0 && (
        <section className="rounded-card border border-line bg-surface p-5 shadow-card">
          <h3 className="mb-2 text-[14px] font-semibold text-ink">{t('Approved versions')}</h3>
          <ul className="divide-y divide-line/70 text-[13px]">
            {st.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-semibold text-ink">{t('Version {v}', { v: h.version })}</span>
                <span className="text-muted">{h.approver_name}, {h.approver_designation}</span>
                <span className="ml-auto tabular-nums text-muted">{date(h.valid_from)} → {h.valid_to ? date(h.valid_to) : t('now')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {panel && <DecisionPanel kind={panel} me={me} onClose={() => setPanel(null)} />}
    </div>
  );
}

function BandSelect({ value, onChange, disabled, label }: { value: Band; onChange: (b: Band) => void; disabled?: boolean; label: string }) {
  const t = useT();
  return (
    <select aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as Band)}
            className={cn('input h-9 w-36 font-semibold', BAND_TONE[value])}>
      {BANDS.map((b) => <option key={b} value={b}>{t(BAND_LABEL[b])}</option>)}
    </select>
  );
}

/** Rows impact 5 → 1, columns likelihood 1 → 5. */
function MatrixGrid({ matrix, editable, onChange }: { matrix: Record<string, Band[]>; editable: boolean; onChange: (m: Record<string, Band[]>) => void }) {
  const t = useT();
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="text-[12px]">
        <thead>
          <tr><th className="pr-2 text-left font-semibold text-muted">{t('Impact ↓ · Likelihood →')}</th>
            {[1, 2, 3, 4, 5].map((l) => <th key={l} className="px-1 pb-1 text-center font-semibold text-muted">{l}</th>)}</tr>
        </thead>
        <tbody>
          {[5, 4, 3, 2, 1].map((i) => (
            <tr key={i}>
              <th className="pr-2 text-right font-semibold text-muted">{i}</th>
              {[0, 1, 2, 3, 4].map((l) => {
                const b = matrix[String(i)]?.[l] ?? 'LOW';
                return (
                  <td key={l} className="p-0.5">
                    {editable ? (
                      <select value={b} aria-label={t('Impact {i}, likelihood {l}', { i, l: l + 1 })}
                              onChange={(e) => {
                                const row = [...(matrix[String(i)] ?? [])] as Band[];
                                row[l] = e.target.value as Band;
                                onChange({ ...matrix, [String(i)]: row });
                              }}
                              className={cn('h-8 w-24 rounded-lg border-0 px-1 text-center text-[11.5px] font-semibold', BAND_TONE[b])}>
                        {BANDS.map((x) => <option key={x} value={x}>{t(BAND_LABEL[x])}</option>)}
                      </select>
                    ) : (
                      <span className={cn('grid h-8 w-24 place-items-center rounded-lg text-[11.5px] font-semibold', BAND_TONE[b])}>{t(BAND_LABEL[b])}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Approve (with the approver's name and designation) or return (with what must change). */
function DecisionPanel({ kind, me, onClose }: { kind: 'approve' | 'return'; me?: User | null; onClose: () => void }) {
  const t = useT();
  const approve = useApproveAppetite();
  const ret = useReturnAppetite();
  const [name, setName] = useState(me?.name ?? '');
  const [designation, setDesignation] = useState('');
  const [note, setNote] = useState('');
  const m = kind === 'approve' ? approve : ret;
  const submit = () => (kind === 'approve'
    ? approve.mutate({ approverName: name, designation, note: note || undefined }, { onSuccess: onClose })
    : ret.mutate({ note }, { onSuccess: onClose }));
  return (
    <SidePanel onClose={onClose} labelledBy="appetite-decision">
      <PanelHeader id="appetite-decision" eyebrow={t('Risk appetite')} onClose={onClose}
                   title={kind === 'approve' ? t('Approve this appetite') : t('Return it with what must change')} />
      <div className={DRAWER.body}>
        {kind === 'approve' ? (
          <>
            <p className="text-muted">{t('Your name and designation are recorded with this version, as the leadership approval.')}</p>
            <FieldRow label="Name" required><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} /></FieldRow>
            <FieldRow label="Designation" required><input className="input w-full" value={designation} placeholder={t('Chief Executive Officer')} onChange={(e) => setDesignation(e.target.value)} /></FieldRow>
            <FieldRow label="Note" hint="For example, the board meeting that agreed it."><textarea className="input min-h-[80px] w-full py-2" value={note} onChange={(e) => setNote(e.target.value)} /></FieldRow>
          </>
        ) : (
          <FieldRow label="What must change" required><textarea className="input min-h-[120px] w-full py-2" value={note} onChange={(e) => setNote(e.target.value)} /></FieldRow>
        )}
        {m.error && <p role="alert" className="rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{m.error.message}</p>}
      </div>
      <div className={DRAWER.footer}>
        <button type="button" className="btn ml-auto" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={m.isPending || (kind === 'approve' ? !name.trim() || !designation.trim() : !note.trim())}
                onClick={submit}>
          {kind === 'approve' ? <><ShieldCheck className="h-4 w-4" /> {t('Approve')}</> : <><RotateCcw className="h-4 w-4" /> {t('Return')}</>}
        </button>
      </div>
    </SidePanel>
  );
}

/** Admins name the people, besides themselves, who may approve the appetite. */
function Governors() {
  const t = useT();
  const { data: st } = useAppetite();
  const { data: users } = useQuery<{ items: User[] }>({ queryKey: ['users'], queryFn: () => api('/api/auth/users') });
  const grant = useGrantGovernor();
  const revoke = useRevokeGovernor();
  const [userId, setUserId] = useState('');
  const [designation, setDesignation] = useState('');
  const nameOf = (id: string) => users?.items.find((u) => u.id === id)?.name ?? id;
  const govIds = new Set((st?.governors ?? []).map((g) => g.user_id));
  const candidates = (users?.items ?? []).filter((u) => u.role !== 'admin' && !govIds.has(u.id));

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <h3 className="text-[14px] font-semibold text-ink">{t('Who may approve')}</h3>
      <p className="mt-0.5 text-[12.5px] text-muted">{t('Admins always may. Name the leaders, such as the CEO or a board member, who may approve too.')}</p>
      <ul className="mt-3 space-y-1.5">
        {(st?.governors ?? []).map((g) => (
          <li key={g.user_id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-[13px]">
            <span className="font-semibold text-ink">{nameOf(g.user_id)}</span>
            <span className="text-muted">{g.designation}</span>
            <button type="button" className="ml-auto rounded-full p-1.5 text-muted hover:bg-critical-50 hover:text-critical-600"
                    aria-label={t('Remove')} title={t('Remove')} onClick={() => revoke.mutate(g.user_id)}>
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <FieldRow label="Person" className="min-w-[220px] flex-1">
          <select className="input w-full" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">—</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="Designation" className="min-w-[200px] flex-1">
          <input className="input w-full" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder={t('Chairman')} />
        </FieldRow>
        <button type="button" className="btn" disabled={!userId || grant.isPending}
                onClick={() => grant.mutate({ userId, designation: designation || undefined }, { onSuccess: () => { setUserId(''); setDesignation(''); } })}>
          <UserPlus className="h-4 w-4" /> {t('Add')}
        </button>
      </div>
      {grant.error && <p role="alert" className="mt-2 text-[12.5px] text-critical-600">{grant.error.message}</p>}
    </section>
  );
}
