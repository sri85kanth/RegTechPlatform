import { useRef, type ReactNode } from 'react';
import { cn } from '@/utils/ui';
import { tMaybe, useT } from '@/i18n';
import { useLiquidPill } from './motion';

export interface SegmentOption<K extends string = string> {
  key: K;
  label: ReactNode;
  /** Names the segment for screen readers and on hover, when the label is only an icon. */
  title?: string;
  disabled?: boolean;
}

/** A small two-to-four way switch: slate track, the chosen segment raised in white. */
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
  size = 'md',
}: {
  options: SegmentOption<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // the raised thumb flows from the old choice to the new one
  const pill = useLiquidPill(box, '[aria-checked="true"]', 'x', [value, options.length]);
  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label={ariaLabel && t(ariaLabel)}
      className={cn('relative inline-flex items-center gap-0.5 rounded-[10px] bg-black/[0.05] p-0.5', className)}
    >
      <span aria-hidden="true" className="liquid-pill top-0.5 bottom-0.5 rounded-lg bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.06)]" style={pill} />
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title && t(o.title)}
            aria-label={o.title && t(o.title)}
            disabled={o.disabled}
            onClick={() => onChange(o.key)}
            className={cn(
              'relative z-[1] inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
              on ? 'text-ink' : 'text-muted hover:text-ink',
            )}
          >
            {tMaybe(t, o.label)}
          </button>
        );
      })}
    </div>
  );
}
