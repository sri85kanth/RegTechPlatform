/**
 * Small components the compliance screens share: hue tiles and chips, the
 * status pill, the filter select, the table footer, and the right-hand detail
 * panel with its tabs. Plain helpers live in ./uiKit.
 *
 * Kept inside this module on purpose — the shared primitives are owned
 * elsewhere, and nothing here changes what any number means.
 *
 * Fixed words handed to these components (filter labels, option labels, tab
 * labels, block titles, the table noun) arrive in English and are translated
 * here; text that carries data (RowCheck's label, ActiveFilter's value, the
 * panel header's eyebrow and title) is translated by the caller.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Icon } from '@/config/icons';
import { Pager } from '@/components/ui/primitives';
import { cn, statusTone, toneClass } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import '@/components/ui/premium.css';
import { DRAWER, HUES, SIZES, statusWord, trapTab, type Hue } from './uiKit';

/* ---------------------------------------------------------------- colour */

/** A tinted icon tile in a categorical hue. */
export function HueTile({ icon, hue, size = 'md', className }: { icon: string; hue: Hue; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  const box = { xs: 'h-7 w-7 rounded-lg', sm: 'h-8 w-8 rounded-lg', md: 'h-10 w-10 rounded-xl', lg: 'h-12 w-12 rounded-xl' }[size];
  const ic = { xs: 'h-3.5 w-3.5', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size];
  const h = HUES[hue];
  return (
    <span className={cn('grid shrink-0 place-items-center', box, className)} style={{ background: `${h.hex}17`, color: h.hex }} aria-hidden="true">
      <Icon name={icon} className={ic} />
    </span>
  );
}

/** A tinted chip in a categorical hue, optionally with an icon. */
export function HueChip({ hue, icon, children, title, className }: { hue: Hue; icon?: string; children: ReactNode; title?: string; className?: string }) {
  const h = HUES[hue];
  return (
    <span className={cn('pill', className)} style={{ background: `${h.hex}14`, color: h.ink }} title={title}>
      {icon && <Icon name={icon} className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- words */

/** Filled status pill; one colour per meaning (Met green, Partial amber, Gap red, Not covered orange). */
export function StatusPill({ value, title, size = 'md' }: { value?: string | null; title?: string; size?: 'sm' | 'md' }) {
  const t = useT();
  if (!value) return <span className="text-muted-2">—</span>;
  const extra: Record<string, 'blue' | 'gray' | 'purple'> = { NOT_TESTED: 'blue', REVIEW_REQUIRED: 'blue', NOT_ASSESSED: 'gray' };
  const tone = extra[value] ?? statusTone(value);
  return (
    <span className={cn('pill', size === 'sm' && 'px-2 py-0.5 text-[11px]', toneClass(tone))} title={title}>
      {t(statusWord(value))}
    </span>
  );
}

/* ---------------------------------------------------------------- filters */

/** "Status [All ▾]" — a labelled select whose empty value means all. */
export function FilterSelect({
  label, value, onChange, options, allLabel = tx('All'),
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; allLabel?: string;
}) {
  const t = useT();
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-muted">
      <span className="whitespace-nowrap">{t(label)}</span>
      <select
        className={cn('input h-9 w-auto min-w-[7.5rem] max-w-[13rem] py-0 text-[13px]', value ? 'border-brand-400 font-medium text-brand-700' : 'text-ink')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t(allLabel)}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
      </select>
    </label>
  );
}

/** A removable chip naming one active filter. */
export function ActiveFilter({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  const t = useT();
  return (
    <span className="pill bg-brand-50 text-brand-700">
      <span className="text-brand-600/80">{t(label)}:</span> <span className="max-w-[16rem] truncate">{value}</span>
      <button type="button" onClick={onClear} aria-label={t('Remove {label} filter', { label: t(label) })}
              className="-mr-1 grid h-4 w-4 place-items-center rounded hover:bg-brand-100">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/* ---------------------------------------------------------------- table */

/** "Showing 1–10 of 320 ‹ 1 2 3 … 32 ›" with a per-page select. */
export function TableFooter({
  page, total, size, onPage, onSize, noun,
}: { page: number; total: number; size: number; onPage: (p: number) => void; onSize: (s: number) => void; noun: string }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="flex flex-wrap items-center border-t border-slate-100">
      <div className="min-w-0 flex-1 [&>div]:border-t-0">
        {pages > 1
          ? <Pager page={page} pages={pages} total={total} size={size} onPage={onPage} />
          : <div className="px-4 py-3 text-[13px] text-muted">{t('Showing {n} {noun}', { n: total.toLocaleString(), noun: t(noun) })}</div>}
      </div>
      <label className="flex items-center gap-2 px-4 py-2 text-[13px] text-muted">
        <select className="input h-8 w-auto py-0 text-[13px]" value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label={t('Rows per page')}>
          {SIZES.map((s) => <option key={s} value={s}>{t('{n} per page', { n: s })}</option>)}
        </select>
      </label>
    </div>
  );
}

/** Row checkbox — clicking it never opens the row. */
export function RowCheck({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean }) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded accent-[#2563eb]"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = !!indeterminate; }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

/* ---------------------------------------------------------------- panel */

/**
 * The right-side detail drawer: a fixed slide-over at every width, over a
 * backdrop that closes it, as does Esc. Focus moves into the drawer on open,
 * stays inside it while open, and returns to the row on close.
 */
/** `wide`: for a panel that holds a whole record to judge (a risk), not a short form. */
export function SidePanel({ onClose, labelledBy, children, wide = false }: { onClose: () => void; labelledBy: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    // a timer, not requestAnimationFrame: rAF never fires in a background tab, which left the drawer off-screen
    const t = window.setTimeout(() => setShown(true), 16);
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      else if (ref.current) trapTab(ref.current, e);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <div className={cn(DRAWER.backdrop, shown ? DRAWER.backdropOpen : DRAWER.backdropClosed)} onClick={onClose} aria-hidden="true" />
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
             className={cn(wide ? DRAWER.panel.replace('max-w-[480px]', 'max-w-[680px]') : DRAWER.panel, shown ? DRAWER.panelOpen : DRAWER.panelClosed)}>
        {children}
      </aside>
    </>
  );
}

export function PanelHeader({ id, eyebrow, title, badges, onClose }: { id: string; eyebrow: ReactNode; title: ReactNode; badges?: ReactNode; onClose: () => void }) {
  const t = useT();
  return (
    <div className={DRAWER.header}>
      <div className="min-w-0 flex-1">
        <div className={DRAWER.eyebrow}>{eyebrow}</div>
        <h2 id={id} className={DRAWER.title}>{title}</h2>
        {badges && <div className={DRAWER.badges}>{badges}</div>}
      </div>
      <button type="button" onClick={onClose} aria-label={t('Close panel')} title={t('Close (Esc)')} className={DRAWER.close}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function PanelTabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  // each tab is `t` below, so the translate function is `tr` here
  const tr = useT();
  return (
    <div className="border-b border-black/[0.06] px-6 pb-3">
      <div role="tablist" className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-black/[0.05] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} role="tab" type="button" aria-selected={on} onClick={() => onChange(t.key)}
                    className={cn('shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all duration-300 active:scale-95',
                      on ? 'bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]' : 'text-muted hover:text-ink')}>
              {tr(t.label)}{t.count !== undefined && <span className={cn('ml-1 tabular-nums', on ? 'text-muted' : 'text-muted-2')}>{t.count.toLocaleString()}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A titled block inside the panel, with an optional "View all →". */
export function PanelBlock({ title, link, children, icon }: { title: string; icon?: string; link?: { label?: string; onClick: () => void }; children: ReactNode }) {
  const t = useT();
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {icon && <Icon name={icon} className="h-4 w-4 text-muted-2" />}
        <h3 className="flex-1 text-[14px] font-semibold tracking-tight text-ink">{t(title)}</h3>
        {link && (
          <button type="button" onClick={link.onClick} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-600 hover:text-brand-700">
            {t(link.label ?? 'View all')} <Icon name="ArrowRight" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** A status filter chip: its colour, its name and how many rows are in it. */
export function StatusChip({ label, n, dot, on, onClick }: { label: string; n?: number; dot?: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
            className={cn('pm-press inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium',
              on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line-2 bg-white text-ink-2 hover:border-brand-300')}>
      {dot && <span className="pm-dot h-2 w-2 rounded-full" style={{ background: dot }} />}
      {label}
      {n != null && <span className="tabular-nums text-muted">{n.toLocaleString()}</span>}
    </button>
  );
}
