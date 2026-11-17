/**
 * The chart card the registry and governance pages draw their charts in.
 *
 * The summary strip that used to open every registry list (the count, a few
 * figures and a breakdown bar) was removed: it repeated the table under it.
 */
import type { ReactNode } from 'react';
import { IconTile, type MetricTone } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import { tMaybe, useT } from '@/i18n';

/** A chart card: small tinted icon, title, optional right-hand note. */
export function ChartCard({
  title, icon, tone = 'brand', note, children, className,
}: { title: string; icon: string; tone?: MetricTone; note?: ReactNode; children: ReactNode; className?: string }) {
  // titles and notes are interface text; an already translated string passes through unchanged
  const t = useT();
  return (
    <div className={cn('card flex min-w-0 flex-col p-5', className)}>
      <div className="mb-4 flex items-center gap-2.5">
        <IconTile icon={icon} tone={tone} size="sm" />
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{t(title)}</h3>
        {note && <span className="shrink-0 text-xs text-muted">{tMaybe(t, note)}</span>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
