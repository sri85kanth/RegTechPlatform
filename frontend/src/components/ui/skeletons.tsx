import { useEffect, useState } from 'react';
import { cn } from '@/utils/ui';

/**
 * Placeholders for content that is still loading.
 *
 * They are shown only once loading has lasted long enough to be noticed —
 * a fast answer should not make the page flash a grey skeleton first.
 */
export function useDelayedFlag(active: boolean, delay = 250): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return on;
}

const bar = 'animate-pulse rounded bg-slate-200/80';

export function SkeletonCards({ count = 3, lines = 4, className }: { count?: number; lines?: number; className?: string }) {
  return (
    <div className={cn('grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3', className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-4">
          <div className={cn(bar, 'h-4 w-1/2')} />
          <div className="mt-3 space-y-2">
            {Array.from({ length: lines }).map((_, j) => (
              <div key={j} className={cn(bar, 'h-3')} style={{ width: `${90 - j * 9}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card overflow-hidden p-0" aria-hidden>
      <div className="flex gap-4 border-b border-line bg-canvas px-3 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className={cn(bar, 'h-3 flex-1')} />
        ))}
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-4 px-3 py-3">
            {Array.from({ length: cols }).map((_, c) => (
              <div key={c} className={cn(bar, 'h-3 flex-1')} style={{ opacity: 1 - r * 0.07 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
