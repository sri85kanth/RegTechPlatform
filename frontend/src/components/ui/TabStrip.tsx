import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/utils/ui';
import { tMaybe, useT } from '@/i18n';
import { useLiquidPill } from './motion';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  /** optional count shown after the label */
  count?: number;
  disabled?: boolean;
}

/**
 * One tab strip for every page: `.tab` / `.tab-active` items in a horizontally
 * scrollable row. The active tab is scrolled into view when it changes, and a
 * soft fade on the right edge says "there is more" when the row overflows.
 */
export function TabStrip<K extends string>({
  tabs,
  active,
  onChange,
  className,
  ariaLabel,
  size = 'md',
}: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}) {
  const tr = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [fadeRight, setFadeRight] = useState(false);
  const [fadeLeft, setFadeLeft] = useState(false);

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    setFadeLeft(el.scrollLeft > 2);
  };

  useLayoutEffect(measure, [tabs.length]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [active]);

  // the underline flows from the old tab to the new one
  const pill = useLiquidPill(scroller, '[aria-selected="true"]', 'x', [active, tabs.length]);

  const mask =
    fadeRight || fadeLeft
      ? `linear-gradient(to right, ${fadeLeft ? 'transparent 0, #000 24px' : '#000 0'}, ${fadeRight ? '#000 calc(100% - 32px), transparent 100%' : '#000 100%'})`
      : undefined;

  return (
    <div
      ref={scroller}
      role="tablist"
      aria-label={ariaLabel && tr(ariaLabel)}
      onScroll={measure}
      className={cn('relative -mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      <span aria-hidden="true" className="liquid-pill bottom-0 h-[2.5px] rounded-full bg-brand-600" style={pill} />
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            aria-current={on ? 'page' : undefined}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const enabled = tabs.filter((x) => !x.disabled);
              const i = enabled.findIndex((x) => x.key === active);
              const next = enabled[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
              if (next) {
                onChange(next.key);
                requestAnimationFrame(() =>
                  scroller.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(),
                );
              }
            }}
            className={cn('tab shrink-0 disabled:opacity-50', size === 'sm' && 'px-2.5 py-2 text-[13px]', on && 'tab-active', 'border-b-transparent')}
          >
            {tMaybe(tr, t.label)}
            {t.count != null && (
              <span className={cn('ml-1.5 tabular-nums text-xs', on ? 'text-brand-600' : 'text-muted')}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
