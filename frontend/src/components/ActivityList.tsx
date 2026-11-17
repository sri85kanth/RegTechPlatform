import type { HistoryEvent } from '@/types/entity';
import { IconTile } from '@/components/ui/primitives';
import { activityStyle } from '@/modules/overview/activityStyle';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

// other screens (record drawer, record lists) read an action's icon and colour from here
export { activityStyle };

/**
 * Audit trail list — one look for the Overview activity tab and each record
 * list's History tab. Events are grouped under day headers; each carries a
 * coloured icon for what kind of change it was, and the timestamp sits inline
 * after the actor in muted text.
 *
 * `at` arrives already formatted ("5 min ago", "2 days ago", "3 Oct 2026"),
 * so groups are derived from that text.
 */
function groupOf(at: string): string {
  const s = at.trim().toLowerCase();
  if (!s || s === 'just now' || /\b(min|hour)s?\b ago$/.test(s)) return tx('Last 24 hours');
  if (/^1 day ago$/.test(s)) return tx('Yesterday');
  if (/^\d+ days ago$/.test(s)) return tx('Earlier this week');
  return at;
}

export function ActivityList({ items, className, wide }: { items: HistoryEvent[]; className?: string; /** fill the column instead of a reading width */ wide?: boolean }) {
  const t = useT();
  const groups: { label: string; rows: HistoryEvent[] }[] = [];
  for (const h of items) {
    const label = groupOf(h.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(h);
    else groups.push({ label, rows: [h] });
  }

  return (
    <div className={cn('card px-5 py-4', !wide && 'max-w-4xl', className)}>
      {groups.map((g, gi) => (
        <section key={`${g.label}-${gi}`} className={cn(gi > 0 && 'mt-5')}>
          <h3 className="mb-2.5 flex items-center gap-2">
            <span className="sec-eyebrow">{t(g.label)}</span>
            <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold tabular-nums text-ink-2">{g.rows.length}</span>
            <span className="h-px flex-1 bg-line" aria-hidden="true" />
          </h3>
          <ol className="space-y-3">
            {g.rows.map((h) => {
              const s = activityStyle(h.action);
              return (
                <li key={h.id} className="flex items-center gap-3">
                  <IconTile icon={s.icon} tone={s.tone} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-ink first-letter:uppercase">{h.action}</div>
                    <div className="text-xs text-muted">
                      {h.by}
                      {h.detail ? <> · {h.detail}</> : null}
                      {h.at ? <> · <time>{h.at}</time></> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
