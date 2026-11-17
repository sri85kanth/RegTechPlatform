/**
 * Plain helpers the compliance screens share (no components here, so the
 * component file keeps fast refresh): a categorical hue palette, status words,
 * date and share formatting, and CSV export of rows already on screen.
 */
import { readable } from '@/utils/ui';
import { tx, type TFunction } from '@/i18n';

/** Categorical hues: `hex` for fills and icons, `ink` (darker) for text on a tint (AA). */
export const HUES = {
  blue: { hex: '#2563eb', ink: '#1d4ed8' },
  violet: { hex: '#7c3aed', ink: '#6d28d9' },
  teal: { hex: '#0d9488', ink: '#0f766e' },
  amber: { hex: '#d97706', ink: '#b45309' },
  pink: { hex: '#db2777', ink: '#be185d' },
  sky: { hex: '#0284c7', ink: '#0369a1' },
  emerald: { hex: '#059669', ink: '#047857' },
  indigo: { hex: '#4f46e5', ink: '#4338ca' },
  orange: { hex: '#ea580c', ink: '#c2410c' },
  red: { hex: '#dc2626', ink: '#b91c1c' },
  slate: { hex: '#64748b', ink: '#475569' },
} as const;
export type Hue = keyof typeof HUES;
const CYCLE: Hue[] = ['blue', 'violet', 'teal', 'amber', 'pink', 'sky', 'emerald', 'indigo'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
/** The same text always gets the same hue. */
export const hueFor = (text: string): Hue => CYCLE[hash(text || '?') % CYCLE.length];
/** The n-th categorical hue, for ordered series. */
export const hueAt = (i: number): Hue => CYCLE[i % CYCLE.length];

/**
 * "NON_COMPLIANT" → "Non-compliant", "PARTIALLY_COMPLIANT" → "Partially compliant".
 * COMPLIANT reads "Documented": the verdict comes from documents, not sampled records.
 * Returns English (it also feeds chart colour keys); translate it where it is drawn.
 */
export function statusWord(v: string): string {
  if ((v ?? '').toUpperCase() === 'COMPLIANT') return tx('Documented');
  return readable(v).replace(/^Non compliant$/, tx('Non-compliant'));
}

/** "Critical risk", "High risk"…: one phrase per band, so the words can be reordered when translated. */
const RISK_PHRASE: Record<string, string> = {
  Critical: tx('Critical risk'), High: tx('High risk'), Medium: tx('Medium risk'), Low: tx('Low risk'),
};
/** A risk value ("CRITICAL", "High") as "Critical risk", translated with the caller's `t`. */
export function riskPhrase(t: TFunction, risk: string): string {
  const w = readable(risk);
  return RISK_PHRASE[w] ? t(RISK_PHRASE[w]) : `${w} risk`;
}

/** `locale`: pass `useDateLocale()` from the component so month names follow the interface language. */
export function fmtDate(s?: string | null, locale = 'en-GB'): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const pctOf = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

export const SIZES = [10, 25, 50];

/**
 * The right-side detail drawer, as class strings — shared by the React
 * SidePanel (Controls, Requirements) and the Impact Cascade's imperative panel,
 * so all three open, look and close the same way. A fixed slide-over at every
 * width; the page underneath keeps its full width.
 */
export const DRAWER = {
  backdrop: 'fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[3px] transition-opacity duration-300',
  panel: 'fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col overflow-hidden bg-white/95 shadow-drawer outline-none backdrop-blur-2xl transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] sm:inset-y-3 sm:right-3 sm:rounded-[24px] sm:shadow-[0_30px_80px_-24px_rgba(0,0,0,0.38),0_0_0_0.5px_rgba(0,0,0,0.08)]',
  header: 'flex items-start gap-3 px-6 pb-3 pt-5',
  eyebrow: 'text-[12px] font-semibold text-brand-600',
  title: 'mt-1 line-clamp-2 text-[19px] font-semibold leading-snug tracking-tight text-ink',
  badges: 'mt-2.5 flex flex-wrap items-center gap-1.5',
  close: 'grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/[0.05] text-ink-2 transition duration-200 hover:bg-black/[0.09] hover:text-ink active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
  body: 'pm-stagger flex-1 space-y-5 overflow-y-auto px-6 py-5 text-[13px]',
  footer: 'flex flex-wrap items-center gap-2 border-t border-black/[0.06] bg-white/80 px-6 py-3.5 backdrop-blur-xl',
  /** closed / open states toggled on the panel and the backdrop */
  panelClosed: 'translate-x-[calc(100%+24px)]',
  panelOpen: 'translate-x-0',
  backdropClosed: 'pointer-events-none opacity-0',
  backdropOpen: 'opacity-100',
} as const;

/** Keep Tab inside an open drawer. */
export function trapTab(panel: HTMLElement, ev: KeyboardEvent) {
  if (ev.key !== 'Tab') return;
  const f = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

/** Download rows already on screen as CSV — nothing is fetched. Column headers are data for spreadsheets and stay as given. */
export function downloadCsv(name: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
