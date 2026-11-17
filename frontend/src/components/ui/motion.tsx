import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DependencyList, type RefObject } from 'react';

/**
 * Position for a "liquid" selection pill: an absolutely placed element behind
 * the selected item of `container` (the first match of `selector`). When the
 * selection moves, the edge in the direction of travel moves fast and the other
 * follows slower, so the pill stretches towards its target and settles — the
 * way a drop of liquid moves. Pair with the `liquid-pill` class (index.css).
 *
 * `container` must be the pill's positioned parent. Works inside a scrolling
 * row or column, and re-measures when the container resizes.
 */
export function useLiquidPill(
  container: RefObject<HTMLElement>, selector: string, axis: 'x' | 'y', deps: DependencyList,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  const prev = useRef<number | null>(null);
  useLayoutEffect(() => {
    const box = container.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>(selector);
      if (!el) { prev.current = null; setStyle((s) => ({ ...s, opacity: 0 })); return; }
      const cb = box.getBoundingClientRect(), r = el.getBoundingClientRect();
      const a = axis === 'y' ? r.top - cb.top + box.scrollTop - box.clientTop : r.left - cb.left + box.scrollLeft - box.clientLeft;
      const size = axis === 'y' ? r.height : r.width;
      const b = (axis === 'y' ? box.clientHeight : box.clientWidth) - a - size;
      const p = prev.current;
      const reduce = prefersReducedMotion();
      const lead = '0.26s', trail = '0.52s';
      // first placement, or reduced motion: appear in place; afterwards the leading edge moves first
      const [ta, tb] = p === null || reduce ? ['0s', '0s'] : a > p ? [trail, lead] : [lead, trail];
      prev.current = a;
      setStyle(axis === 'y'
        ? { top: a, bottom: b, opacity: 1, transitionDuration: `${ta}, ${tb}, 0s, 0s, 0.2s` }
        : { left: a, right: b, opacity: 1, transitionDuration: `0s, 0s, ${ta}, ${tb}, 0.2s` });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return style;
}

/** True when the person has asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * A number that counts to its new value instead of jumping — on first show from
 * zero, afterwards from the value it had. Eases out, so it settles rather than
 * stops, and shows the final value at once when motion is reduced.
 */
export function useCountUp(value: number, duration = 650): number {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (!Number.isFinite(value)) return;
    if (prefersReducedMotion()) { setShown(value); from.current = value; return; }
    const start = from.current;
    if (start === value) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(start + (value - start) * eased);
      setShown(v);
      from.current = v;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return shown;
}

/** `useCountUp` as an element: the number, formatted for the reader's locale. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const n = useCountUp(value);
  return <span className={className}>{n.toLocaleString()}</span>;
}
