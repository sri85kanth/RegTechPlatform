/**
 * Controls — the measures covering this regulation's duties, and what backs them.
 *
 * COVERAGE IS DERIVED, NOT STORED
 * -------------------------------
 * There is no "status" column on a control. What exists is the chain: evidence
 * attached, a test run, a finding open. Coverage is read off the deepest link
 * that exists, so the label always has a reason behind it:
 *
 *   open finding        → Gap
 *   evidence + a pass   → In place
 *   evidence, no pass   → Partial
 *   nothing attached    → No evidence
 *
 * "No evidence" is deliberately not called a gap. A gap is something measured
 * and found wanting; nothing attached means nobody has looked yet, and those
 * are different conversations with a compliance officer.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Search, ShieldCheck, X } from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

const COVERAGE: Record<string, { label: string; cls: string; tile: string }> = {
  IN_PLACE: { label: 'In place', cls: 'bg-success-50 text-success-600', tile: 'text-success-600' },
  PARTIAL: { label: 'Partial', cls: 'bg-warning-50 text-warning-600', tile: 'text-warning-600' },
  GAP: { label: 'Gap', cls: 'bg-critical-50 text-critical-600', tile: 'text-critical-600' },
  NO_EVIDENCE: { label: 'No evidence', cls: 'bg-canvas text-muted', tile: 'text-muted' },
};
const SEV_CLS: Record<string, string> = {
  CRITICAL: 'bg-critical-50 text-critical-600',
  HIGH: 'bg-notcov-50 text-notcov-600',
  MEDIUM: 'bg-warning-50 text-warning-600',
  LOW: 'bg-canvas text-muted',
};
const role = (o?: string | null) =>
  o ? String(o).replace(/^peo-role-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;

export function ControlsGridTab({ id }: { id: string }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<any>({
    queryKey: ['reg-controls-grid', id, page, query],
    queryFn: () => api(`/api/regulation/${id}/controls?page=${page}&size=25`
      + (query ? `&q=${encodeURIComponent(query)}` : '')),
    staleTime: 30_000,
  });
  const { data: detail } = useQuery<any>({
    queryKey: ['reg-control-detail', id, openId],
    queryFn: () => api(`/api/regulation/${id}/controls/${openId}`),
    enabled: !!openId,
  });
  // `t` below is the coverage tally, so the translate function is `tr` here
  const tr = useT();

  if (isLoading) return <p className="p-5 text-sm text-muted">{tr('Counting…')}</p>;
  if (!data) return <p className="p-5 text-sm text-muted">{tr('No controls cover this regulation.')}</p>;

  const t = data.tally || {};
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const tiles = [
    { label: 'Controls', value: data.total, cls: 'text-brand-600', icon: ShieldCheck },
    { label: 'In place', value: t.IN_PLACE, cls: COVERAGE.IN_PLACE.tile },
    { label: 'Partial', value: t.PARTIAL, cls: COVERAGE.PARTIAL.tile },
    { label: 'With a gap', value: t.GAP, cls: COVERAGE.GAP.tile },
    { label: 'Nothing attached', value: t.NO_EVIDENCE, cls: COVERAGE.NO_EVIDENCE.tile },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((k) => (
          <div key={k.label} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-2">
              {k.icon && <k.icon size={12} className="text-brand-500" />}{tr(k.label)}
            </div>
            <div className={cn('mt-1 text-2xl font-semibold tabular-nums', k.cls)}>
              {n(k.value)}
            </div>
            {data.total > 0 && k.label !== 'Controls' && (
              <div className="text-xs text-muted">
                {Math.round(((k.value || 0) / data.total) * 100)}%
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={cn('flex gap-4', openId && 'items-start')}>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="relative max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-2" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                   placeholder={tr('Search controls…')}
                   className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm" />
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-[11px] uppercase tracking-wide text-muted-2">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{tr('Control')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Type')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Department')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{tr('Duties')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{tr('Coverage')}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{tr('Owner')}</th>
                </tr>
              </thead>
              <tbody>
                {(data.items ?? []).map((c: any) => {
                  const cov = COVERAGE[c.coverage] || COVERAGE.NO_EVIDENCE;
                  return (
                    <tr key={c.id} onClick={() => setOpenId(c.id)}
                        className={cn('cursor-pointer border-t border-line hover:bg-canvas/70',
                          openId === c.id && 'bg-brand-50/60')}>
                      <td className="max-w-[320px] px-4 py-2.5">
                        <div className="truncate font-medium text-ink">{c.name}</div>
                        {c.description && (
                          <div className="truncate text-xs text-muted">{c.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted">{c.control_type || '—'}</td>
                      <td className="px-3 py-2.5 text-muted">{c.department || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                        {n(c.linked_requirements)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn('rounded px-2 py-0.5 text-[11px] font-medium', cov.cls)}>
                          {tr(cov.label)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted">{role(c.owner_id) || '—'}</td>
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
                  <span className="tabular-nums text-muted-2">{page} / {pages}</span>
                  <button disabled={page >= pages} onClick={() => setPage(page + 1)}
                          className="rounded border border-line px-2.5 py-1 disabled:opacity-40">→</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {openId && (
          <aside className="w-[360px] shrink-0 rounded-xl border border-line bg-surface shadow-pop">
            <header className="flex items-start justify-between gap-2 border-b border-line p-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold leading-snug text-ink">
                  {detail?.name || openId}
                </h3>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted">
                  {detail?.control_type && <span>{detail.control_type}</span>}
                  {detail?.frequency && <span>· {detail.frequency}</span>}
                  {role(detail?.owner_id) && <span>· {role(detail?.owner_id)}</span>}
                </div>
              </div>
              <button onClick={() => setOpenId(null)}
                      className="shrink-0 rounded p-1 text-muted hover:bg-canvas hover:text-ink"
                      aria-label={tr('Close')}>
                <X size={15} />
              </button>
            </header>

            <div className="max-h-[66vh] space-y-4 overflow-y-auto p-4 text-sm">
              {detail?.description && <p className="leading-relaxed text-ink-2">{detail.description}</p>}

              {(detail?.findings?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-critical-200 bg-critical-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-critical-600">
                    {(detail.findings?.length ?? 0) > 1
                      ? tr('{n} open findings', { n: n(detail.findings?.length) })
                      : tr('{n} open finding', { n: n(detail.findings?.length) })}
                  </div>
                  <ul className="space-y-1.5">
                    {detail.findings.slice(0, 5).map((f: any) => (
                      <li key={f.id} className="flex items-start gap-2 text-xs">
                        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                          SEV_CLS[f.severity] || SEV_CLS.LOW)}>{f.severity}</span>
                        <span className="min-w-0 flex-1 text-ink-2">{f.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                  {tr('Duties covered ({n})', { n: n(detail?.linkedRequirements?.length) })}
                </div>
                <ul className="space-y-2">
                  {(detail?.linkedRequirements || []).slice(0, 15).map((r: any) => (
                    <li key={r.id} className="flex items-start gap-2 text-xs">
                      <span className="shrink-0 tabular-nums text-muted-2">{r.source_clause}</span>
                      <span className="min-w-0 flex-1 leading-relaxed text-ink-2">{r.statement}</span>
                    </li>
                  ))}
                </ul>
                {(detail?.linkedRequirements?.length ?? 0) > 15 && (
                  <p className="mt-2 text-[11px] text-muted-2">
                    {tr('and {n} more', { n: n((detail.linkedRequirements?.length ?? 0) - 15) })}
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
                  <p className="text-xs leading-relaxed text-muted">
                    {tr('Nothing attached. The duty cannot be tested until something is, so this control reads as unassessed rather than failing.')}
                  </p>
                )}
              </div>

              {(detail?.tests?.length ?? 0) > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                    {tr('Tests ({n})', { n: n(detail.tests?.length) })}
                  </div>
                  <ul className="space-y-1.5">
                    {detail.tests.slice(0, 5).map((t: any) => (
                      <li key={t.id} className="flex items-center gap-2 text-xs">
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium',
                          t.result === 'PASS' ? 'bg-success-50 text-success-600'
                            : t.result === 'FAIL' ? 'bg-critical-50 text-critical-600'
                              : 'bg-canvas text-muted')}>{t.result}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">
                          {t.result_notes || t.performed_at?.slice(0, 10) || ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
