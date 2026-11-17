/**
 * The auditor's view of a shared regulation: one table, nothing else.
 *
 * An assessor walks the standard element by element and asks two questions —
 * what does the hospital have for this, and what is missing. So each row is a
 * requirement, the hospital documents that cover it, and the gap in plain
 * words. No dashboard, no diagram, no colour legend to learn. A row opens to
 * show the full requirement and, for NABH, the guidebook criteria under it.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import { tx, useT, type TFunction } from '@/i18n';
import type { CascadeGraph, CascadeItem, CascadeRegulation, RegulationSummary, Status } from './cascadeTypes';
import type { DocRequestInfo } from './renderCascade';

type View = 'all' | 'has' | 'partly' | 'missing';
const VIEW_OF: Record<Status, View> = { MET: 'has', PARTIAL: 'partly', GAP: 'missing', NOT_COVERED: 'missing', NOT_APPLICABLE: 'all' };
const STATUS_UI: Record<View, { label: string; cls: string }> = {
  has: { label: 'Documented', cls: 'bg-success-50 text-success-700' },
  partly: { label: 'Partly documented', cls: 'bg-warning-50 text-warning-700' },
  missing: { label: 'Missing', cls: 'bg-critical-50 text-critical-700' },
  all: { label: '', cls: '' },
};
const PAGE = 120;

interface Row extends CascadeItem { unit: string; unitTitle: string }

export function AuditorTable({ regs, active, onPick, reg, graph, loading, error, requested, onAsk }: {
  regs: RegulationSummary[]; active: string; onPick: (id: string) => void;
  reg?: CascadeRegulation; graph?: CascadeGraph; loading: boolean; error: unknown;
  requested: string[]; onAsk: (r: DocRequestInfo) => void;
}) {
  const t = useT();
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [chapter, setChapter] = useState('');
  const [coreOnly, setCoreOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setView('all'); setQ(''); setChapter(''); setCoreOnly(false); setOpen(null); }, [active]);
  useEffect(() => { setShown(PAGE); }, [view, q, chapter, coreOnly, active]);

  const rows: Row[] = useMemo(() => (reg?.units ?? []).flatMap((u) =>
    u.items.filter((i) => i.st !== 'NOT_APPLICABLE' && VIEW_OF[i.st])
      .map((i) => ({ ...i, by: i.by ?? [], unit: u.u, unitTitle: u.ut }))), [reg]);
  const chapters = useMemo(() => {
    const seen = new Map<string, string>();
    rows.forEach((r) => { const ch = chapterOf(r, t); if (!seen.has(ch.key)) seen.set(ch.key, ch.label); });
    return [...seen.entries()];
  }, [rows, t]);
  const hasCore = rows.some((r) => r.cat === 'CORE');

  const base = rows.filter((r) => (!chapter || chapterOf(r, t).key === chapter) && (!coreOnly || r.cat === 'CORE'));
  const count = (v: View) => (v === 'all' ? base.length : base.filter((r) => VIEW_OF[r.st] === v).length);
  const needle = q.trim().toLowerCase();
  const list = base.filter((r) => (view === 'all' || VIEW_OF[r.st] === view)
    && (!needle || `${r.c} ${r.t} ${r.ob} ${r.by.join(' ')} ${r.gap}`.toLowerCase().includes(needle)));
  const docName = (code: string) => graph?.docs[code]?.t;
  const sel = regs.find((x) => x.id === active);

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-[1_1_420px] flex-col">
            <span className="field-label">{t('Regulation shared with you')}</span>
            {regs.length > 1 ? (
              <select className="input w-full font-medium" value={active} onChange={(e) => onPick(e.target.value)}>
                {regs.map((i) => <option key={i.id} value={i.id}>{i.short_title || i.title}</option>)}
              </select>
            ) : (
              <div className="py-1.5 text-[15px] font-semibold text-ink">{sel ? sel.short_title || sel.title : '—'}</div>
            )}
          </label>
          {reg?.url && (
            <a className="btn btn-outline btn-sm" href={reg.url} target="_blank" rel="noreferrer">
              {t('Source document')} <Icon name="ExternalLink" className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      {Boolean(error) && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{(error as Error).message}</div>}
      {loading && <div className="text-sm text-muted">{t('Loading…')}</div>}

      {reg && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <div className="flex flex-wrap gap-1" role="tablist">
              {(['all', 'has', 'partly', 'missing'] as View[]).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
                        className={cn('rounded-lg px-3 py-1.5 text-[13px] font-medium',
                          view === v ? 'bg-ink text-white' : 'text-ink-2 hover:bg-slate-100')}>
                  {t(v === 'all' ? 'All' : STATUS_UI[v].label)} <span className={cn('ml-1 tabular-nums', view === v ? 'text-white/80' : 'text-muted')}>{count(v)}</span>
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {chapters.length > 1 && (
              <select className="input h-9 w-[230px] text-[13px]" value={chapter} onChange={(e) => setChapter(e.target.value)} aria-label={t('Chapter')}>
                <option value="">{t('All chapters')}</option>
                {chapters.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            )}
            {hasCore && (
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input type="checkbox" checked={coreOnly} onChange={(e) => setCoreOnly(e.target.checked)} /> {t('Core only')}
              </label>
            )}
            <input className="input h-9 w-[230px] text-[13px]" placeholder={t('Search code, text or document')} value={q}
                   onChange={(e) => setQ(e.target.value)} aria-label={t('Search requirements')} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-slate-50/80 text-left text-xs font-semibold text-muted">
                  <th className="w-[96px] px-4 py-2.5">{t('Ref')}</th>
                  <th className="w-[30%] min-w-[240px] px-3 py-2.5">{t('Requirement')}</th>
                  <th className="w-[130px] px-3 py-2.5">{t('Status')}</th>
                  <th className="w-[24%] px-3 py-2.5">{t('What the hospital has')}</th>
                  <th className="w-[22%] px-3 py-2.5">{t('What is missing')}</th>
                  <th className="w-[120px] px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {list.slice(0, shown).map((r, i) => {
                  const ch = chapterOf(r, t);
                  const newChapter = !chapter && !needle && (i === 0 || chapterOf(list[i - 1], t).key !== ch.key);
                  const v = VIEW_OF[r.st];
                  const isOpen = open === r.c;
                  const asked = requested.includes(r.c);
                  return (
                    <Fragment key={r.c}>
                      {newChapter && (
                        <tr className="border-b border-line bg-slate-50">
                          <td colSpan={6} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-2">{ch.label}</td>
                        </tr>
                      )}
                      <tr className={cn('border-b border-line align-top', isOpen && 'bg-brand-50/30')}>
                        <td className="px-4 py-3">
                          <button className="font-mono text-[12.5px] font-semibold text-ink hover:text-brand-700" onClick={() => setOpen(isOpen ? null : r.c)}
                                  aria-expanded={isOpen}>
                            {r.c}
                          </button>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.cat === 'CORE' && <span className="pill bg-critical-50 text-[10.5px] text-critical-700" title={t('NABH core element')}>{t('Core')}</span>}
                            {r.doc && <span className="pill bg-slate-100 text-[10.5px] text-slate-700" title={t('A written, approved document is mandatory')}>{t('Doc *')}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-ink">
                          <button className={cn('text-left leading-snug hover:text-brand-700', !isOpen && 'line-clamp-3')} onClick={() => setOpen(isOpen ? null : r.c)}>
                            {r.t || r.ob}
                          </button>
                        </td>
                        <td className="px-3 py-3"><span className={cn('pill whitespace-nowrap', STATUS_UI[v].cls)}>{t(STATUS_UI[v].label)}</span></td>
                        <td className="px-3 py-3">
                          {r.by.length ? (
                            <ul className="space-y-0.5">
                              {v === 'missing' && (
                                <li className="text-[11.5px] text-muted" title={t('These cover the area, but not this requirement')}>{t('Related, but not covering it')}:</li>
                              )}
                              {r.by.slice(0, isOpen ? 50 : 2).map((c) => (
                                <li key={c} className="leading-snug">
                                  <span className="font-mono text-[12px] font-semibold text-ink">{c}</span>
                                  {docName(c) && <span className="text-ink-2"> {docName(c)}</span>}
                                </li>
                              ))}
                              {!isOpen && r.by.length > 2 && (
                                <li><button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setOpen(r.c)}>{t('+{n} more', { n: r.by.length - 2 })}</button></li>
                              )}
                            </ul>
                          ) : <span className="text-muted">{t('Nothing on record')}</span>}
                        </td>
                        <td className="px-3 py-3 text-ink-2">
                          {v === 'has' ? <span className="text-muted">—</span>
                            : <span className={cn('leading-snug', !isOpen && 'line-clamp-3')}>{r.gap || t('No document covers this requirement')}</span>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {asked ? <span className="pill bg-amber-50 text-amber-700">{t('Asked')}</span> : (
                            <button className="btn btn-outline btn-sm whitespace-nowrap"
                                    onClick={() => onAsk({ regId: active, code: r.c, title: r.ob || r.t, codes: r.by })}>
                              {t(r.by.length ? 'Ask for files' : 'Ask for evidence')}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (r.subs?.length ?? 0) > 0 && (
                        <tr className="border-b border-line bg-brand-50/20">
                          <td />
                          <td colSpan={5} className="px-3 pb-3 pt-0">
                            <div className="text-xs font-semibold text-muted">{t('What the assessor checks under {code} (NABH guidebook)', { code: r.c })}</div>
                            <table className="mt-1 w-full text-[12.5px]">
                              <tbody>
                                {r.subs!.map((s) => {
                                  const sv = VIEW_OF[s.st] ?? 'all';
                                  return (
                                    <tr key={s.n} className="border-t border-line/70 align-top">
                                      <td className="w-6 py-1.5 pr-2 tabular-nums text-muted">{s.n}.</td>
                                      <td className="py-1.5 pr-3 text-ink">{s.rq}{s.ev && <div className="text-xs text-muted">{t('Evidence')}: {s.ev}</div>}</td>
                                      <td className="w-[130px] py-1.5 pr-3">{sv !== 'all' && <span className={cn('pill whitespace-nowrap', STATUS_UI[sv].cls)}>{t(STATUS_UI[sv].label)}</span>}</td>
                                      <td className="w-[26%] py-1.5 pr-3 font-mono text-[11.5px] text-ink-2">{(s.by ?? []).join(', ') || '—'}</td>
                                      <td className="w-[24%] py-1.5 text-ink-2">{sv === 'has' ? '—' : s.gap}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-muted">{t('No requirement matches.')}</p>}
          {list.length > shown && (
            <div className="border-t border-line px-4 py-3 text-center">
              <button className="btn btn-sm" onClick={() => setShown((n) => n + PAGE)}>
                {t('Show more ({n} left)', { n: (list.length - shown).toLocaleString() })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** NABH "COP.16.b" → chapter COP; anything else → its unit. The key is the code; the label is translated. */
function chapterOf(r: Row, t: TFunction): { key: string; label: string } {
  const m = /^([A-Z]{2,5})\./.exec(r.c);
  if (m) return { key: m[1], label: CHAPTERS[m[1]] ? `${m[1]} — ${t(CHAPTERS[m[1]])}` : m[1] };
  return { key: r.unit || 'other', label: r.unitTitle || r.unit || t('Other') };
}

const CHAPTERS: Record<string, string> = {
  AAC: tx('Access, Assessment and Continuity of Care'), COP: tx('Care of Patients'), MOM: tx('Management of Medication'),
  PRE: tx('Patient Rights and Education'), HIC: tx('Hospital Infection Control'), CQI: tx('Continuous Quality Improvement'),
  PSQ: tx('Patient Safety and Quality Improvement'), ROM: tx('Responsibilities of Management'), FMS: tx('Facility Management and Safety'),
  HRM: tx('Human Resource Management'), IMS: tx('Information Management System'),
};
