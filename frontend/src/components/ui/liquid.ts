/**
 * The pointer-following highlight of the Liquid Glass surfaces.
 *
 * One listener for the whole app: while the pointer is over an element with
 * the `liquid` class (or a card or button, which get it automatically), its
 * position inside that element is written to the CSS variables --mx / --my,
 * which the element's highlight (index.css, `.liquid::before`) is centred on.
 * Updates are batched to one per animation frame, and nothing runs when the
 * person has asked for reduced motion or uses touch only.
 */
let installed = false;

export function installLiquidPointer() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover)').matches) return;
  } catch { /* old browser: carry on */ }

  // cards and buttons shimmer without each one having to opt in
  const tag = (root: ParentNode) => root.querySelectorAll?.('.card-int, .btn').forEach((el) => el.classList.add('liquid'));
  tag(document);
  new MutationObserver((records) => {
    records.forEach((r) => r.addedNodes.forEach((n) => {
      if (n instanceof HTMLElement) {
        if (n.matches('.card-int, .btn')) n.classList.add('liquid');
        tag(n);
      }
    }));
  }).observe(document.body, { childList: true, subtree: true });

  let frame = 0;
  let last: PointerEvent | null = null;
  const apply = () => {
    frame = 0;
    const ev = last;
    if (!ev) return;
    const el = (ev.target as Element | null)?.closest?.('.liquid') as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${ev.clientX - r.left}px`);
    el.style.setProperty('--my', `${ev.clientY - r.top}px`);
  };
  window.addEventListener('pointermove', (ev) => {
    last = ev;
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: true });
}
