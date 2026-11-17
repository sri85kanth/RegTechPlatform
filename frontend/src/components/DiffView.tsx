import { useMemo } from 'react';
import { diffWords, diffLines } from 'diff';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

/**
 * Red / green diff rendering, backed by jsdiff.
 *
 * Three modes:
 *   words — inline, for a clause where wording moved
 *   split — old on the left, new on the right, aligned row by row
 *   lines — stacked: every removal, then every addition
 *
 * `split` is the default for whole sections. Stacking put forty removed lines
 * above forty added lines, so comparing any one of them meant scrolling between
 * two blocks and counting position — the reader did the alignment by hand.
 * Side by side puts the two versions of a line on the same row, and the words
 * that actually moved are highlighted within it.
 *
 * Removed text is red and struck through; added text is green and underlined,
 * so the meaning survives even without colour.
 */
type Row = { left: string | null; right: string | null; changed: boolean };

/** Pair the two sides up so each row holds one line of each version. */
function splitRows(parts: { value: string; added?: boolean; removed?: boolean }[]): Row[] {
  const lines = (v: string) => v.split('\n').filter((l) => l.trim());
  const rows: Row[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      lines(p.value).forEach((l) => rows.push({ left: l, right: l, changed: false }));
      continue;
    }
    if (p.removed) {
      const next = parts[i + 1];
      const l = lines(p.value);
      // A removal immediately followed by an addition is a replacement: zip the
      // two so the old and new wording of the same line sit on one row.
      const r = next?.added ? lines(next.value) : [];
      if (next?.added) i += 1;
      for (let k = 0; k < Math.max(l.length, r.length); k += 1) {
        rows.push({ left: l[k] ?? null, right: r[k] ?? null, changed: true });
      }
      continue;
    }
    lines(p.value).forEach((l) => rows.push({ left: null, right: l, changed: true }));
  }
  return rows;
}

/** Within a replaced row, show which words moved rather than flooding the line. */
function Intraline({ from, to, side }: { from: string; to: string; side: 'left' | 'right' }) {
  const bits = useMemo(() => diffWords(from, to), [from, to]);
  return (
    <>
      {bits.map((b, i) => {
        if (side === 'left' && b.added) return null;
        if (side === 'right' && b.removed) return null;
        const hit = side === 'left' ? b.removed : b.added;
        return (
          <span key={i} className={cn(hit && (side === 'left'
            ? 'rounded-[2px] bg-critical-500/20 font-semibold text-critical-600'
            : 'rounded-[2px] bg-success-500/20 font-semibold text-success-600'))}>
            {b.value}
          </span>
        );
      })}
    </>
  );
}

export function DiffView({
  oldText, newText, mode = 'words', location,
}: { oldText: string; newText: string; mode?: 'words' | 'lines' | 'split'; location?: string }) {
  const t = useT();
  const parts = useMemo(
    // split and lines both compare line by line; only the inline mode is word-level.
    () => (mode === 'words' ? diffWords(oldText, newText) : diffLines(oldText, newText)),
    [oldText, newText, mode],
  );

  const added = parts.filter((p) => p.added).reduce((n, p) => n + p.value.trim().split(/\s+/).filter(Boolean).length, 0);
  const removed = parts.filter((p) => p.removed).reduce((n, p) => n + p.value.trim().split(/\s+/).filter(Boolean).length, 0);

  if (mode === 'split') {
    const rows = splitRows(parts);
    return (
      <div className="rounded-card border border-line">
        <DiffHeader location={location} added={added} removed={removed} />
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className="grid grid-cols-2 divide-x divide-line border-b border-line bg-slate-50 text-[11px] font-semibold tracking-normal text-muted-2">
              <div className="px-3 py-1.5">{t('Previous version')}</div>
              <div className="px-3 py-1.5">{t('Current version')}</div>
            </div>
            <div className="divide-y divide-line font-mono text-[12px] leading-relaxed">
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-2 divide-x divide-line">
                  <div className={cn('px-3 py-1.5',
                    r.changed && r.left !== null && 'bg-critical-50 text-critical-600',
                    r.left === null && 'bg-slate-50/60')}>
                    {r.left !== null && (r.changed && r.right !== null
                      ? <Intraline from={r.left} to={r.right} side="left" />
                      : r.left)}
                  </div>
                  <div className={cn('px-3 py-1.5',
                    r.changed && r.right !== null && 'bg-success-50 text-success-600',
                    r.right === null && 'bg-slate-50/60')}>
                    {r.right !== null && (r.changed && r.left !== null
                      ? <Intraline from={r.left} to={r.right} side="right" />
                      : r.right)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'lines') {
    return (
      <div className="rounded-card border border-line">
        <DiffHeader location={location} added={added} removed={removed} />
        <div className="divide-y divide-line font-mono text-[12px] leading-relaxed">
          {parts.map((p, i) =>
            p.value.split('\n').filter((l) => l.trim()).map((line, j) => (
              <div
                key={`${i}-${j}`}
                className={cn('flex gap-3 px-3 py-1.5',
                  p.added ? 'bg-success-50' : p.removed ? 'bg-critical-50' : '')}
              >
                <span className={cn('w-3 shrink-0 select-none font-bold',
                  p.added ? 'text-success-600' : p.removed ? 'text-critical-600' : 'text-muted-2')}>
                  {p.added ? '+' : p.removed ? '−' : ''}
                </span>
                <span className={cn('min-w-0 flex-1',
                  p.added ? 'text-success-600' : p.removed ? 'text-critical-600 line-through decoration-critical-500/50' : 'text-ink-2')}>
                  {line}
                </span>
              </div>
            )),
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line">
      <DiffHeader location={location} added={added} removed={removed} />
      <p className="px-3.5 py-3 text-[13px] leading-relaxed">
        {parts.map((p, i) => (
          <span
            key={i}
            className={cn(
              p.added ? 'bg-success-50 text-success-600 underline decoration-success-500 decoration-2 underline-offset-2'
                : p.removed ? 'bg-critical-50 text-critical-600 line-through decoration-critical-500'
                : 'text-ink-2',
            )}
          >
            {p.value}
          </span>
        ))}
      </p>
    </div>
  );
}

function DiffHeader({ location, added, removed }: { location?: string; added: number; removed: number }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-slate-50 px-3.5 py-2">
      {location && <span className="font-mono text-[12px] font-semibold text-ink">{location}</span>}
      <span className="ml-auto flex items-center gap-2 font-mono text-[11px]">
        {removed > 0 && <span className="text-critical-600">−{removed}</span>}
        {added > 0 && <span className="text-success-600">+{added}</span>}
        {added === 0 && removed === 0 && <span className="text-muted-2">{t('no change')}</span>}
      </span>
    </div>
  );
}

/** Compact red/green bar — how much of a section moved, at a glance. */
export function DiffBar({ added, removed, width = 48 }: { added: number; removed: number; width?: number }) {
  const total = added + removed || 1;
  return (
    <span className="inline-flex h-1.5 overflow-hidden rounded-full bg-slate-100" style={{ width }}>
      <span className="h-full bg-critical-500" style={{ width: `${(removed / total) * 100}%` }} />
      <span className="h-full bg-success-500" style={{ width: `${(added / total) * 100}%` }} />
    </span>
  );
}
