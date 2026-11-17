/**
 * Sites, licences, third parties and history: one list-and-panel screen,
 * driven by the field list of each kind. A person types a record in, or
 * confirms one the system read (Facts to confirm); either way it is a record
 * they can see, correct and remove.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SidePanel, PanelHeader } from '@/modules/compliance/ui';
import { DRAWER } from '@/modules/compliance/uiKit';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { can, useMe } from '@/services/authApi';
import {
  useRecords, useRetireRecord, useRiskMeta, useSaveRecord, type IntakeRecord, type RecordKind,
} from '@/services/riskApi';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';
import { FieldRow, Pill } from './riskUi';
import { METRIC_LABEL } from './labels';
import { KINDS, type Ctx, type FieldDef } from './recordKinds';

/** The table for one kind, with Add and a panel to edit or remove. */
export function RecordsTab({ kind, below }: { kind: RecordKind; below?: ReactNode }) {
  const t = useT();
  const locale = useDateLocale();
  const { data: me } = useMe();
  const cfg = KINDS[kind];
  const { data, isLoading, error } = useRecords(kind);
  const { data: sites } = useRecords('sites');
  const [open, setOpen] = useState<IntakeRecord | 'new' | null>(null);
  const items = data?.items ?? [];
  const ctx: Ctx = useMemo(() => ({
    t,
    date: (s) => (s ? new Date(String(s)).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
    siteName: (id) => (id ? String(sites?.items.find((x) => x.id === id)?.name ?? id) : t('All sites')),
  }), [t, locale, sites]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">{t(cfg.intro)}</p>
        {can(me, 'propose') && (
          <button type="button" className="btn btn-primary" onClick={() => setOpen('new')}>
            <Plus className="h-4 w-4" /> {t('Add {thing}', { thing: t(cfg.singular).toLowerCase() })}
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        {isLoading ? <div className="p-4"><Skeleton rows={4} /></div>
          : error ? <div className="p-6 text-[13px] text-critical-600">{(error as Error).message}</div>
          : items.length === 0 ? <div className="p-6"><EmptyState icon={cfg.icon} title={t(cfg.empty)} /></div>
          : (
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-slate-50/70 text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                <tr>{cfg.columns.map((c) => <th key={c.label} className="px-4 py-2.5">{t(c.label)}</th>)}<th className="w-24 px-4 py-2.5" /></tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(r)} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }}
                      className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-brand-50/40 focus:bg-brand-50/40 focus:outline-none">
                    {cfg.columns.map((c) => <td key={c.label} className="px-4 py-3 align-top text-ink-2">{c.render(r, ctx)}</td>)}
                    <td className="px-4 py-3 text-right align-top">
                      {r.fact_id && <Pill className="bg-violet-50 text-violet-700" title={String(r.source ?? '')}>{t('Confirmed fact')}</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {below}

      {open && (
        <RecordPanel kind={kind} record={open === 'new' ? null : open} onClose={() => setOpen(null)}
                     canEdit={can(me, 'propose')} canRemove={can(me, 'approve')} />
      )}
    </div>
  );
}

/** Add or edit one record. */
function RecordPanel({ kind, record, onClose, canEdit, canRemove }: {
  kind: RecordKind; record: IntakeRecord | null; onClose: () => void; canEdit: boolean; canRemove: boolean;
}) {
  const t = useT();
  const cfg = KINDS[kind];
  const save = useSaveRecord(kind);
  const retire = useRetireRecord(kind);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const title = record ? String(record.name ?? record.kind ?? record.title ?? '') : t('New {thing}', { thing: t(cfg.singular).toLowerCase() });
  const submit = (values: Record<string, unknown>) => save.mutate({ id: record?.id, data: values }, { onSuccess: onClose });

  return (
    <SidePanel onClose={onClose} labelledBy="risk-record-title">
      <PanelHeader id="risk-record-title" eyebrow={t(cfg.singular)} title={title} onClose={onClose}
                   badges={record?.source ? <span className="text-[12px] text-muted">{String(record.source)}</span> : undefined} />
      <RecordForm kind={kind} initial={record ?? {}} disabled={!canEdit} error={save.error?.message}
                  busy={save.isPending} onSubmit={submit} submitLabel={record ? tx('Save changes') : tx('Add')}
                  extra={record && canRemove ? (
                    <button type="button" disabled={retire.isPending}
                            onClick={() => (confirmRemove ? retire.mutate(record.id, { onSuccess: onClose }) : setConfirmRemove(true))}
                            className={cn('btn mr-auto', confirmRemove && 'bg-critical-50 text-critical-700')}>
                      <Trash2 className="h-4 w-4" /> {confirmRemove ? t('Click again to remove') : t('Remove')}
                    </button>
                  ) : undefined}
                  onCancel={onClose} />
    </SidePanel>
  );
}

/** The fields of one kind as a form; also used to correct a proposed fact. */
export function RecordForm({ kind, initial, onSubmit, onCancel, submitLabel, disabled, busy, error, extra }: {
  kind: RecordKind; initial: Record<string, unknown>; onSubmit: (v: Record<string, unknown>) => void; onCancel: () => void;
  submitLabel: string; disabled?: boolean; busy?: boolean; error?: string; extra?: ReactNode;
}) {
  const t = useT();
  const { data: meta } = useRiskMeta();
  const { data: sites } = useRecords('sites');
  const cfg = KINDS[kind];
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of cfg.fields) {
      const x = initial[f.key];
      v[f.key] = f.type === 'list' && Array.isArray(x) ? x.join(', ') : f.type === 'yesno' && typeof x === 'boolean' ? (x ? 'yes' : 'no') : x ?? '';
    }
    return v;
  });
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  const metrics = Array.from(new Set([...(meta?.scaleMetrics ?? []), 'employees']));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of cfg.fields) {
      const v = values[f.key];
      out[f.key] = f.type === 'yesno' ? (v === 'yes' ? true : v === 'no' ? false : null) : v === '' ? null : v;
    }
    onSubmit(out);
  };

  const control = (f: FieldDef) => {
    const v = values[f.key];
    const common = { disabled, id: `rf-${f.key}`, required: f.required };
    switch (f.type) {
      case 'textarea':
        return <textarea {...common} className="input min-h-[84px] w-full py-2" value={String(v ?? '')} placeholder={f.placeholder && t(f.placeholder)} onChange={(e) => set(f.key, e.target.value)} />;
      case 'date':
        return <input {...common} type="date" className="input w-full" value={String(v ?? '').slice(0, 10)} onChange={(e) => set(f.key, e.target.value)} />;
      case 'yesno':
        return (
          <select {...common} className="input w-full" value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)}>
            <option value="">{t('Not known')}</option><option value="yes">{t('Yes')}</option><option value="no">{t('No')}</option>
          </select>
        );
      case 'select': case 'site': case 'theme': {
        const options = f.type === 'site'
          ? (sites?.items ?? []).map((s) => ({ value: s.id, label: String(s.name) }))
          : f.type === 'theme' ? (meta?.themes ?? []).map((th) => ({ value: th.id, label: th.name }))
          : meta && f.options ? f.options(meta) : [];
        return (
          <select {...common} className="input w-full" value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)}>
            <option value="">{f.type === 'site' ? t('All sites') : '—'}</option>
            {options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          </select>
        );
      }
      case 'scale': {
        const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        return (
          <div className="grid grid-cols-2 gap-2">
            {metrics.map((m) => (
              <div key={m} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                  {t(METRIC_LABEL[m] ?? m)}{meta?.scaleMetrics.includes(m) && <span className="ml-0.5 text-critical-600">*</span>}
                </span>
                <input type="number" min={0} disabled={disabled} className="input h-8 w-24 text-right tabular-nums"
                       value={String(s[m] ?? '')} onChange={(e) => set(f.key, { ...s, [m]: e.target.value })} aria-label={t(METRIC_LABEL[m] ?? m)} />
              </div>
            ))}
          </div>
        );
      }
      default:
        return <input {...common} className="input w-full" value={String(v ?? '')} placeholder={f.placeholder && t(f.placeholder)} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      {/* DRAWER.body's vertical spacing would push every second column down: a grid of its own */}
      <div className="pm-stagger grid flex-1 grid-cols-2 content-start gap-x-3 gap-y-4 overflow-y-auto px-6 py-5 text-[13px]">
        {cfg.fields.map((f) => (
          <FieldRow key={f.key} label={f.label} hint={f.hint} required={f.required} className={f.wide || f.type === 'textarea' ? 'col-span-2' : ''}>
            {control(f)}
          </FieldRow>
        ))}
        {error && <p role="alert" className="col-span-2 rounded-xl bg-critical-50 px-3 py-2 text-[12.5px] text-critical-700">{error}</p>}
      </div>
      <div className={DRAWER.footer}>
        {extra}
        <button type="button" className="btn ml-auto" onClick={onCancel}>{t('Cancel')}</button>
        {!disabled && <button type="submit" className="btn btn-primary" disabled={busy}>{t(submitLabel)}</button>}
      </div>
    </form>
  );
}
