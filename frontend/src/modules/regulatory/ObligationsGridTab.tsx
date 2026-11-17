/**
 * Obligations — the duties this instrument imposes, and how far each is discharged.
 *
 * "ADDRESSED" IS READ FROM THE ROW, NOT STORED
 * --------------------------------------------
 * There is no status column on an obligation. The label is derived from the
 * chain the row already shows — requirements owed, controls covering them,
 * requirements met — so the word never contradicts the numbers beside it. An
 * earlier version counted EVIDENCE_MISSING instances as "partially addressed",
 * which printed that label next to "0 controls, 0 evidence". True to the stored
 * status, unreadable as a row.
 *
 * NOT APPLICABLE IS NOT A FAILURE
 * -------------------------------
 * A duty whose instances are all NOT_APPLICABLE was evaluated and found not to
 * bind this company — a threshold unmet, an exemption that applies. It gets its
 * own bucket rather than being counted against the hospital.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, Search, ShieldCheck, X } from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

const STATUS: Record<string, { label: string; cls: string; tile: string }> = {
  FULLY_ADDRESSED: { label: 'Fully addressed', cls: 'bg-success-50 text-success-600', tile: 'text-success-600' },
  PARTIALLY_ADDRESSED: { label: 'Partial', cls: 'bg-warning-50 text-warning-600', tile: 'text-warning-600' },
  NOT_ADDRESSED: { label: 'Not addressed', cls: 'bg-critical-50 text-critical-600', tile: 'text-critical-600' },
  NOT_APPLICABLE: { label: 'Not applicable', cls: 'bg-canvas text-muted', tile: 'text-muted' },
};

const role = (o?: string | null) =>
  o ? String(o).replace(/^peo-role-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;

export function ObligationsGridTab({ id }: { id: string }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<any>({
    queryKey: ['reg-obligations', id, page, query],
    queryFn: () => api(`/api/regulation/${id}/obligations?page=${page}&size=25`
      + (query ? `&q=${encodeURIComponent(query)}` : '')),
    staleTime: 30_000,
  });
  const { data: detail } = useQuery<any>({
    queryKey: ['reg-obligation', id, openId],
    queryFn: () => api(`/api/regulation/${id}/obligations/${openId}`),
    enabled: !!openId,
  });
  // `t` below is the status tally, so the translate function is `tr` here
  const tr = useT();

  if (isLoading) return <p className="p-5 text-sm text-muted">{tr('Counting…')}</p>;
  if (!data) return <p className="p-5 text-sm text-muted">{tr('No obligations extracted.')}</p>;

  const t = data.tally || {};
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const tiles = [
    { label: 'Obligations', value: data.total, cls: 'text-brand-600', icon: FileText },
    { label: 'Fully addressed', value: t.FULLY_ADDRESSED, cls: STATUS.FULLY_ADDRESSED.tile },
    { label: 'Partial', value: t.PARTIALLY_ADDRESSED, cls: STATUS.PARTIALLY_ADDRESSED.tile },
    { label: 'Not addressed', value: t.NOT_ADDRESSED, cls: STATUS.NOT_ADDRESSED.tile },
    { label: 'Not applicable', value: t.NOT_APPLICABLE, cls: STATUS.NOT_APPLICABLE.tile },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((k) => (
          <div key={k.label} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-2">
              {k.icon && <k.icon size={12} className="text-brand-500" />}{tr(k.label)}
            </div>
            <div className={cn('mt-1 text-2xl font-semibold tabular-nums', k.cls)}>{n(k.value)}</div>
            {data.total > 0 && k.label !== 'Obligations' && (
              <div className="text-xs text-muted">
                {Math.round(((k.value || 0) / data.total) * 100)}%
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="relative max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-2" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                   placeholder={tr('Search obligations…')}
                   className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm" />
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-[11px] uppercase tracking-wide text-muted-2">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{tr('Duty')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Section')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Department')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{tr('Duties')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{tr('Controls')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Status')}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(data.items ?? []).map((o: any) => {
                  const st = STATUS[o.status] || STATUS.NOT_ADDRESSED;
                  return (
                    <tr key={o.id} onClick={() => setOpenId(o.id)}
                        className={cn('cursor-pointer border-t border-line align-top hover:bg-canvas/70',
                          openId === o.id && 'bg-brand-50/60')}>
                      <td className="max-w-[380px] px-4 py-2.5">
                        <span className="line-clamp-2 text-ink">{o.description || o.title}</span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted">{o.section_number || '—'}</td>
                      <td className="px-3 py-2.5 text-muted">{o.department || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink">{n(o.requirements)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink">{n(o.controls)}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn('rounded px-2 py-0.5 text-[11px] font-medium', st.cls)}>
                          {tr(st.label)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-2"><ChevronRight size={14} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
              <span className="text-muted">
                {data.total === 0 ? tr('none') :
                  tr('{from}–{to} of {total}', { from: n((page - 1) * data.size + 1), to: n(Math.min(page * data.size, data.total)), total: n(data.total) })}
              </span>
              {pages > 1 && (
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage(page - 1)}
                          className="rounded border border-line px-2.5 py-1 disabled:opacity-40">←</button>
                  <span className="tabular-nums text-muted-2">{page} / {n(pages)}</span>
                  <button disabled={page >= pages} onClick={() => setPage(page + 1)}
                          className="rounded border border-line px-2.5 py-1 disabled:opacity-40">→</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {openId && (
          <aside className="w-[380px] shrink-0 rounded-xl border border-line bg-surface shadow-pop">
            <header className="flex items-start justify-between gap-2 border-b border-line p-4">
              <p className="text-sm font-medium leading-relaxed text-ink">
                {detail?.description || detail?.title || openId}
              </p>
              <button onClick={() => setOpenId(null)}
                      className="shrink-0 rounded p-1 text-muted hover:bg-canvas hover:text-ink"
                      aria-label={tr('Close')}><X size={15} /></button>
            </header>

            <div className="max-h-[66vh] space-y-4 overflow-y-auto p-4 text-sm">
              <dl className="grid grid-cols-2 gap-3 text-xs">
                {[[tx('Section'), detail?.section?.section_number],
                  [tx('Type'), detail?.obligation_type],
                  [tx('Owed by'), detail?.responsible_entity],
                  [tx('Frequency'), detail?.frequency]].map(([k, v]) => (
                  <div key={k as string}>
                    <dt className="text-muted-2">{tr(k as string)}</dt>
                    <dd className="mt-0.5 truncate text-ink-2">{(v as string) || '—'}</dd>
                  </div>
                ))}
              </dl>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                  {tr('Requirements ({n})', { n: n(detail?.requirements?.length) })}
                </div>
                {detail?.requirements?.length ? (
                  <ul className="space-y-2">
                    {detail.requirements.slice(0, 12).map((r: any) => (
                      <li key={r.id} className="flex items-start gap-2 text-xs">
                        <span className="shrink-0 tabular-nums text-muted-2">{r.source_clause}</span>
                        <span className="min-w-0 flex-1 leading-relaxed text-ink-2">{r.statement}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">
                    {tr('No separately testable requirement was split from this duty.')}
                  </p>
                )}
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                  {tr('Controls ({n})', { n: n(detail?.controls?.length) })}
                </div>
                {detail?.controls?.length ? (
                  <ul className="space-y-1.5">
                    {(detail.controls ?? []).map((c: any) => (
                      <li key={c.id} className="flex items-start gap-2 text-xs">
                        <ShieldCheck size={12} className="mt-0.5 shrink-0 text-brand-500" />
                        <div className="min-w-0">
                          <div className="truncate text-ink-2">{c.name}</div>
                          <div className="truncate text-[11px] text-muted-2">
                            {[c.department, role(c.owner_id)].filter(Boolean).join(' · ') || c.control_type}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs leading-relaxed text-muted">
                    {tr('No control covers this duty, which is why it reads as not addressed.')}
                  </p>
                )}
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                  {tr('Evidence ({n})', { n: n(detail?.evidence?.length) })}
                </div>
                {detail?.evidence?.length ? (
                  <ul className="space-y-1.5">
                    {(detail.evidence ?? []).map((e: any) => (
                      <li key={e.id} className="flex items-center gap-2 text-xs">
                        <FileText size={12} className="shrink-0 text-muted-2" />
                        <span className="min-w-0 flex-1 truncate text-ink-2">{e.name}</span>
                        {e.valid_until && (
                          <span className="shrink-0 tabular-nums text-muted-2">{e.valid_until}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">{tr('Nothing attached.')}</p>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
