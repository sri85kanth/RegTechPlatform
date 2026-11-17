/**
 * Small pieces the three Add data tabs share, so the tabs read as one page:
 * a card heading, a figure tile and a ring. Motion lives in addData.css.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CountUp } from '@/components/ui/motion';
import './addData.css';

/** A card's heading: an icon tile in the card's colour, the title, an optional note and action. */
export function CardHead({ icon: I, hex, title, note, action }: {
  icon: LucideIcon; hex: string; title: string; note?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="ad-ic grid h-9 w-9 shrink-0 place-items-center rounded-xl"
            style={{ background: `color-mix(in srgb, ${hex} 13%, white)`, color: hex }}>
        <I className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
        {note && <p className="truncate text-[12px] text-muted">{note}</p>}
      </div>
      {action}
    </div>
  );
}

/** One figure: an icon tile, a label, the number counting up and a line under it. */
export function StatTile({ icon: I, hex, label, value, foot, index = 0, suffix }: {
  icon: LucideIcon; hex: string; label: string; value: number | null; foot?: ReactNode; index?: number; suffix?: ReactNode;
}) {
  return (
    <div className="ad-rise ad-card group min-w-0 rounded-2xl border border-line bg-white p-3.5"
         style={{ '--d': `${index * 70}ms` } as CSSProperties}>
      <div className="flex items-center gap-2">
        <span className="ad-ic grid h-7 w-7 shrink-0 place-items-center rounded-lg"
              style={{ background: `color-mix(in srgb, ${hex} 13%, white)`, color: hex }}>
          <I className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium text-ink-2">{label}</span>
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-none tracking-tight text-ink tabular-nums">
        {value == null ? <span className="text-muted">…</span> : <CountUp value={value} />}
        {suffix}
      </div>
      {foot && <div className="mt-1.5 truncate text-[11.5px] text-muted">{foot}</div>}
    </div>
  );
}

/** A ring: part of a whole, drawn in, with whatever goes in the middle. */
export function MiniRing({ part, whole, hex, size = 64, thickness = 7, children }: {
  part: number; whole: number; hex: string; size?: number; thickness?: number; children?: ReactNode;
}) {
  const r = (size - thickness) / 2, len = 2 * Math.PI * r;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f2f2f7" strokeWidth={thickness} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hex} strokeWidth={thickness} strokeLinecap="round"
                strokeDasharray={`${whole ? (Math.min(part, whole) / whole) * len : 0} ${len}`}
                className="ad-ring" style={{ '--len': len } as CSSProperties} />
      </svg>
      <span className="relative text-center leading-none">{children}</span>
    </span>
  );
}
