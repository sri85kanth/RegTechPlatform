/**
 * Shared pieces for the regulation detail tabs — data hooks over endpoints that
 * already exist, the status vocabulary, and the table / filter / side-panel
 * language every tab uses. Nothing here invents a value: every helper derives
 * from rows an endpoint returned.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Search, SlidersHorizontal, Download } from 'lucide-react';
import { api } from '@/services/http';
import { Pager } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { cn, toneClass, type Tone } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import type { CascadeGraph, CascadeItem, CascadeRegulation } from '@/modules/cascade/cascadeTypes';
import '@/components/ui/premium.css';

/* ======================================================================
 * data hooks
 * ==================================================================== */

/** GET /api/reg-overview/:id — the Overview tab's sections, from rows that exist. */
export interface RegOverview {
  about: string; assessed: boolean;
  totals: Record<'total' | 'applicable' | 'met' | 'partial' | 'gap' | 'not_covered' | 'not_applicable' | 'critical' | 'high' | 'medium' | 'low', number>
    & { not_assessed?: number };
  sections: { name: string; requirements: number; unmet: number }[];
  departments: { name: string; requirements: number; unmet: number }[];
  impact: { score: number | null; level: string | null; factors: { label: string; score: number; note: string | null }[] };
  updates: { kind: string; date: string | null; title: string; detail: string | null }[];
  documents: { title: string; kind: string; url: string | null; search?: boolean }[];
  related: { id: string; title: string; regulator: string; same_regulator: boolean }[];
  counts: { sections: number; obligations: number };
}
export const useRegOverview = (id: string) =>
  useQuery<RegOverview>({
    queryKey: ['reg-overview', id], enabled: !!id,
    queryFn: () => api(`/api/reg-overview/${encodeURIComponent(id)}`), staleTime: 120_000,
  });

/**
 * The document-based gap assessment for one regulation (GET /api/cascade/regulations/:id).
 * A 404 means "not assessed", so it is not retried — the tabs fall back to the
 * extracted obligations instead.
 */
export const useGapAssessment = (id: string) =>
  useQuery<CascadeRegulation>({
    queryKey: ['cascade', 'reg', id], enabled: !!id, retry: false,
    queryFn: () => api(`/api/cascade/regulations/${encodeURIComponent(id)}`), staleTime: 300_000,
  });

/** The hospital's own policies, SOPs, forms, controls and risk register (GET /api/cascade/graph). */
export const useCascadeGraph = (enabled = true) =>
  useQuery<CascadeGraph>({
    queryKey: ['cascade', 'graph'], enabled,
    queryFn: () => api('/api/cascade/graph'), staleTime: 300_000,
  });

/** Control detail (GET /api/controls/:id) — same shape the Controls page reads. */
export interface ControlDetail {
  id: string; name: string; description?: string | null;
  owner_id?: string | null; owner_name?: string | null; entity_name?: string | null;
  control_type?: string | null; frequency?: string | null;
  regulations_list?: { id: string; title: string; duties: number; unmet: number }[];
  requirements?: {
    id: string; regulation_id: string; source_clause: string | null; statement: string;
    compliance_status: string | null; risk: string | null; gap: string | null;
  }[];
  evidence_list?: { evidence_id: string; name: string | null; type: string | null }[];
}
export const useControlDetail = (id: string | null) =>
  useQuery<ControlDetail>({
    queryKey: ['control', id], enabled: !!id,
    queryFn: () => api(`/api/controls/${encodeURIComponent(id!)}`), staleTime: 60_000,
  });

/** A gap row flattened with its chapter, ready for tables. */
export interface GapRow extends CascadeItem {
  key: string; chapter: string; unit: string; unitTitle: string; dept: string; depts: string[];
}
export function flattenGap(reg: CascadeRegulation | undefined): GapRow[] {
  if (!reg) return [];
  const out: GapRow[] = [];
  reg.units.forEach((u) => u.items.forEach((it, i) => {
    const depts = deptsOf(it.who);
    out.push({
      ...it, key: it.rid ?? `${u.u}:${it.c}:${i}`,
      chapter: chapterName(u.g || u.u), unit: u.u, unitTitle: u.ut, dept: depts[0], depts,
    });
  }));
  return out;
}
/** "Part A · AAC Access, Assessment…" → the last segment, the chapter's own name. */
export const chapterName = (g: string) => (g || tx('General')).split(' · ').slice(-1)[0];

/**
 * What a gap row is linked to in the hospital's documents — the same join the
 * Impact Cascade page draws: documents the assessment cited, the controls those
 * documents run, the policies governing them, and the register risks the
 * controls mitigate.
 */
export interface Links { ctrls: string[]; pols: string[]; risks: string[]; docs: string[] }
export function useLinkResolver(graph: CascadeGraph | undefined) {
  return useMemo(() => {
    const docs = graph?.docs ?? {};
    const ctrlsOf: Record<string, string[]> = {};
    Object.entries(docs).forEach(([c, d]) => {
      if (d.k === 'Control') {
        (d.sops ?? []).forEach((s) => (ctrlsOf[s] ??= []).push(c));
        (d.forms ?? []).forEach((f) => (ctrlsOf[f] ??= []).push(c));
      }
    });
    const cache = new Map<string, Links>();
    return (it: CascadeItem & { key?: string }): Links => {
      const k = it.key ?? `${it.c}|${(it.by ?? []).join(',')}`;
      const hit = cache.get(k);
      if (hit) return hit;
      const ctrls = new Set<string>(), pols = new Set<string>();
      (it.by ?? []).forEach((code) => {
        const d = docs[code]; if (!d) return;
        if (d.k === 'Control') ctrls.add(code);
        if (d.k === 'Policy') { pols.add(code); (d.sops ?? []).forEach((s) => (ctrlsOf[s] ?? []).forEach((c) => ctrls.add(c))); }
        if (d.k === 'SOP') { (ctrlsOf[code] ?? []).forEach((c) => ctrls.add(c)); (d.pol ?? []).forEach((p) => pols.add(p)); }
        if (d.k === 'Form') { (ctrlsOf[code] ?? []).forEach((c) => ctrls.add(c)); (d.sops ?? []).forEach((s) => (docs[s]?.pol ?? []).forEach((p) => pols.add(p))); }
      });
      [...ctrls].forEach((c) => (docs[c]?.sops ?? []).forEach((s) => (docs[s]?.pol ?? []).forEach((p) => { if (!pols.size) pols.add(p); })));
      const rs = new Set<string>();
      [...ctrls].forEach((c) => (docs[c]?.risks ?? []).forEach((r) => rs.add(r)));
      // risk-mitigating controls first, as the cascade diagram orders them
      const ctl = [...ctrls].sort((a, b) => (docs[b]?.risks?.length ? 1 : 0) - (docs[a]?.risks?.length ? 1 : 0));
      const out = { ctrls: ctl, pols: [...pols], risks: [...rs], docs: (it.by ?? []).filter((c) => docs[c]) };
      cache.set(k, out);
      return out;
    };
  }, [graph]);
}

/* ======================================================================
 * departments — the same keyword map /api/reg-overview uses, so a row's
 * department here agrees with the Overview's "departments affected".
 * ==================================================================== */
const DEPTS: [string, RegExp][] = [
  [tx('Nursing'), /nurs|cno|ward/],
  [tx('Medical / Clinical'), /medical director|doctor|consultant|clinical|anaesth|physician|surgeon|hod|medical superintendent/],
  [tx('Quality'), /quality|patient safety|accreditation/],
  [tx('Administration'), /management|governing|administrat|board|ceo|director(?! of nursing)|leadership/],
  [tx('HR'), /\bhr\b|human resource|training|personnel/],
  [tx('Biomedical / Engineering'), /bme|biomedical|engineering|maintenance/],
  [tx('Pharmacy'), /pharm|drug/],
  [tx('Laboratory'), /lab|patholog|blood bank|transfusion/],
  [tx('Radiology'), /radiolog|imaging|x-ray|nuclear/],
  [tx('Infection Control'), /infection/],
  [tx('Facilities & Safety'), /facilit|fire|disaster|safety officer|security|housekeeping|engineer/],
  [tx('Medical Records & IT'), /record|\bit\b|information|mrd/],
];
export function deptsOf(who: string | null | undefined): string[] {
  const w = (who ?? '').toLowerCase();
  const hits = DEPTS.filter(([, re]) => re.test(w)).map(([n]) => n);
  return hits.length ? hits : [tx('Others')];
}
/** Categorical colour per department — never a status colour. */
export const DEPT_UI: Record<string, { icon: string; cls: string; hex: string }> = {
  Nursing: { icon: 'HeartPulse', cls: 'bg-pink-50 text-pink-600', hex: '#ec4899' },
  'Medical / Clinical': { icon: 'Stethoscope', cls: 'bg-brand-50 text-brand-600', hex: '#2563eb' },
  Quality: { icon: 'BadgeCheck', cls: 'bg-emerald-50 text-emerald-600', hex: '#10b981' },
  Administration: { icon: 'Building2', cls: 'bg-indigo-50 text-indigo-600', hex: '#6366f1' },
  HR: { icon: 'Users', cls: 'bg-amber-50 text-amber-600', hex: '#f59e0b' },
  'Biomedical / Engineering': { icon: 'Wrench', cls: 'bg-sky-50 text-sky-600', hex: '#0ea5e9' },
  Pharmacy: { icon: 'Pill', cls: 'bg-violet-50 text-violet-600', hex: '#8b5cf6' },
  Laboratory: { icon: 'Microscope', cls: 'bg-teal-50 text-teal-600', hex: '#14b8a6' },
  Radiology: { icon: 'Radar', cls: 'bg-indigo-50 text-indigo-600', hex: '#818cf8' },
  'Infection Control': { icon: 'ShieldAlert', cls: 'bg-emerald-50 text-emerald-700', hex: '#059669' },
  'Facilities & Safety': { icon: 'Siren', cls: 'bg-amber-50 text-amber-700', hex: '#d97706' },
  'Medical Records & IT': { icon: 'Database', cls: 'bg-sky-50 text-sky-700', hex: '#0284c7' },
  Others: { icon: 'LayoutGrid', cls: 'bg-slate-100 text-slate-500', hex: '#94a3b8' },
};
export const deptUi = (d: string) => DEPT_UI[d] ?? DEPT_UI.Others;

/** A department name with its coloured icon. */
export function DeptLabel({ name, size = 'sm', title }: { name: string; size?: 'sm' | 'md'; title?: string }) {
  const t = useT();
  const u = deptUi(name);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2" title={title}>
      <span className={cn('grid shrink-0 place-items-center rounded-md', size === 'sm' ? 'h-6 w-6' : 'h-8 w-8 rounded-lg', u.cls)}>
        <Icon name={u.icon} className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </span>
      <span className="truncate">{t(name)}</span>
    </span>
  );
}

/* ======================================================================
 * status vocabulary — one colour per meaning
 * ==================================================================== */
export interface StatusUi { label: string; ob: string; tone: Tone; hex: string; icon: string }
// MET reads "Documented": the verdict comes from the hospital's documents, not
// from sampled records of what was done, so it must not claim the duty is met.
export const GAP_UI: Record<string, StatusUi> = {
  MET: { label: 'Documented', ob: tx('Fully documented'), tone: 'green', hex: '#16a34a', icon: 'CheckCircle2' },
  PARTIAL: { label: 'Partial', ob: tx('Partly documented'), tone: 'amber', hex: '#f59e0b', icon: 'AlertTriangle' },
  GAP: { label: 'Gap', ob: tx('Not addressed'), tone: 'red', hex: '#dc2626', icon: 'XCircle' },
  NOT_COVERED: { label: 'Not covered', ob: tx('Not covered'), tone: 'orange', hex: '#f97316', icon: 'FileWarning' },
  NOT_APPLICABLE: { label: 'Not applicable', ob: tx('Not applicable'), tone: 'gray', hex: '#94a3b8', icon: 'MinusCircle' },
};
export const gapUi = (s: string | null | undefined) => GAP_UI[s ?? ''] ?? GAP_UI.NOT_APPLICABLE;
export const UNMET = new Set(['PARTIAL', 'GAP', 'NOT_COVERED']);

/** Compliance status on a requirement instance (mapped from the gap verdicts). */
export const COMPLIANCE_UI: Record<string, { label: string; tone: Tone; hex: string }> = {
  COMPLIANT: { label: 'Documented', tone: 'green', hex: '#16a34a' },
  MET: { label: 'Documented', tone: 'green', hex: '#16a34a' },
  PARTIALLY_COMPLIANT: { label: 'Partial', tone: 'amber', hex: '#f59e0b' },
  PARTIAL: { label: 'Partial', tone: 'amber', hex: '#f59e0b' },
  NON_COMPLIANT: { label: 'Gap', tone: 'red', hex: '#dc2626' },
  GAP: { label: 'Gap', tone: 'red', hex: '#dc2626' },
  EVIDENCE_MISSING: { label: 'Evidence missing', tone: 'orange', hex: '#f97316' },
  NOT_COVERED: { label: 'Not covered', tone: 'orange', hex: '#f97316' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'gray', hex: '#94a3b8' },
  NOT_ASSESSED: { label: 'Not assessed', tone: 'gray', hex: '#cbd5e1' },
};
export const complianceUi = (s: string | null | undefined) =>
  COMPLIANCE_UI[(s ?? '').toUpperCase()] ?? { label: s ? words(s) : '—', tone: 'gray' as Tone, hex: '#cbd5e1' };

export const RISK_ORDER: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, None: 4 };
export const RISK_HEX: Record<string, string> = { Critical: '#dc2626', High: '#f97316', Medium: '#f59e0b', Low: '#94a3b8' };
const RISK_TONE: Record<string, Tone> = { Critical: 'red', High: 'orange', Medium: 'amber', Low: 'gray' };
export const riskKey = (v: string | null | undefined) => {
  const t = (v ?? '').trim().toLowerCase();
  return t === 'critical' ? 'Critical' : t === 'high' ? 'High' : t === 'medium' ? 'Medium' : t === 'low' ? 'Low' : 'None';
};

/** NOT_COVERED → "Not covered". */
export const words = (v: string) => v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Filled tinted pill with an optional icon. */
export function Pill({ tone, children, icon, title, className }: { tone: Tone; children: ReactNode; icon?: string; title?: string; className?: string }) {
  return (
    <span title={title} className={cn('pill', toneClass(tone), className)}>
      {icon && <Icon name={icon} className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}
export function GapPill({ status, obligation }: { status: string | null | undefined; obligation?: boolean }) {
  const t = useT();
  const u = gapUi(status);
  return <Pill tone={u.tone}>{t(obligation ? u.ob : u.label)}</Pill>;
}
export function CompliancePill({ status }: { status: string | null | undefined }) {
  const t = useT();
  const u = complianceUi(status);
  return <Pill tone={u.tone}>{t(u.label)}</Pill>;
}
/**
 * NABH: every Core element must score at least 4, or the hospital is not
 * accredited — so a Core element that is anything short of documented is a
 * fail risk, whatever its risk band.
 */
export const coreFailRisk = (r: { cat?: string; st: string }) =>
  r.cat === 'CORE' && r.st !== 'MET' && r.st !== 'NOT_APPLICABLE';
export function CoreFailPill() {
  const t = useT();
  return <Pill tone="red" icon="Flame" title={t('Core element not yet documented. NABH requires every Core element to score 4 or more; one below 4 fails the assessment.')}>{t('Core · fail risk')}</Pill>;
}
/** The guidebook's asterisk (*): this element needs a written, approved, controlled document. */
export function DocRequiredPill({ short }: { short?: boolean }) {
  const t = useT();
  return (
    <Pill tone="purple" icon="FileText"
          title={t('NABH asterisk (*): a written, approved and controlled document is mandatory. If it is missing or weak, the score drops by one.')}>
      {short ? t('Doc *') : t('Documentation required *')}
    </Pill>
  );
}
export function RiskPill({ risk }: { risk: string | null | undefined }) {
  const t = useT();
  const k = riskKey(risk);
  if (k === 'None') return <span className="text-xs text-muted-2">—</span>;
  return <Pill tone={RISK_TONE[k]}>{t(k)}</Pill>;
}
/** A category chip (control type …) — only categorical tones, never a status colour. */
export function TypeChip({ children }: { children: string }) {
  let h = 0;
  for (let i = 0; i < children.length; i++) h = (h * 31 + children.charCodeAt(i)) >>> 0;
  return <Pill tone={(['blue', 'purple', 'teal'] as const)[h % 3]}>{children}</Pill>;
}
/** Document kind chip — Policy / SOP / Form / Control. */
const KIND_TONE: Record<string, Tone> = { [tx('Policy')]: 'blue', SOP: 'purple', [tx('Form')]: 'gray', [tx('Control')]: 'teal' };
export function KindChip({ kind }: { kind: string }) {
  const t = useT();
  return <Pill tone={KIND_TONE[kind] ?? 'gray'}>{t(kind)}</Pill>;
}

/* ======================================================================
 * layout pieces
 * ==================================================================== */

/** Search + labelled selects + a "More filters" toggle, as one bar. */
export function FilterBar({
  q, onQ, placeholder, children, more, right,
}: {
  q: string; onQ: (v: string) => void; placeholder: string;
  children?: ReactNode; more?: ReactNode; right?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" aria-hidden="true" />
          <input className="input pl-9" value={q} placeholder={placeholder} aria-label={placeholder}
                 onChange={(e) => onQ(e.target.value)} />
        </div>
        {children}
        {more && (
          <button type="button" className={cn('btn', open && 'border-brand-300 bg-brand-50 text-brand-700')}
                  aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <SlidersHorizontal className="h-4 w-4" /> {t('More filters')}
          </button>
        )}
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      {more && open && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-dashed border-line pt-3">{more}</div>}
    </div>
  );
}

export function FilterSelect({
  label, value, onChange, options, allLabel,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; allLabel?: string;
}) {
  const t = useT();
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-muted">
      <span className="whitespace-nowrap">{label}</span>
      <select className="input h-9 w-auto min-w-[104px] max-w-[200px] text-[13px]" value={value}
              onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel ?? t('All')}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Pager plus a "10 per page" switch. */
export function TableFooter({
  page, size, total, onPage, onSize, noun,
}: { page: number; size: number; total: number; onPage: (p: number) => void; onSize: (s: number) => void; noun: string }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="flex flex-wrap items-stretch">
      <div className="min-w-0 flex-1">
        {pages > 1
          ? <Pager page={page} pages={pages} total={total} size={size} onPage={onPage} />
          : <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-muted">{t('Showing {n} {noun}', { n: total.toLocaleString(), noun })}</div>}
      </div>
      <div className="flex items-center border-t border-slate-100 px-4 py-2">
        <select className="input h-8 w-auto text-[13px]" value={size} aria-label={t('Rows per page')}
                onChange={(e) => onSize(Number(e.target.value))}>
          {[10, 25, 50].map((n) => <option key={n} value={n}>{t('{n} per page', { n })}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Client-side paging over an already-filtered list. Resets to page 1 when `resetKey` changes. */
export function usePaging<T>(rows: T[], resetKey: string, initial = 10) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initial);
  useEffect(() => { setPage(1); }, [resetKey, size]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(page, pages);
  return {
    page: cur, size, setPage, setSize, total: rows.length,
    pageRows: rows.slice((cur - 1) * size, cur * size), offset: (cur - 1) * size,
  };
}

/** Row selection for the checkbox column — drives "Export selected". */
export function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  return {
    sel,
    has: (k: string) => sel.has(k),
    toggle: (k: string) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
    setMany: (keys: string[], on: boolean) => setSel((s) => { const n = new Set(s); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; }),
    clear: () => setSel(new Set()),
  };
}
export function HeaderCheckbox({ keys, selection }: { keys: string[]; selection: ReturnType<typeof useSelection> }) {
  const all = keys.length > 0 && keys.every((k) => selection.has(k));
  const some = !all && keys.some((k) => selection.has(k));
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return (
    <input ref={ref} type="checkbox" checked={all} aria-label={t('Select all rows on this page')}
           className="h-4 w-4 rounded border-slate-300 accent-brand-600"
           onChange={(e) => selection.setMany(keys, e.target.checked)} />
  );
}
export function RowCheckbox({ k, selection, label }: { k: string; selection: ReturnType<typeof useSelection>; label: string }) {
  const t = useT();
  return (
    <input type="checkbox" checked={selection.has(k)} aria-label={t('Select {label}', { label })}
           className="h-4 w-4 rounded border-slate-300 accent-brand-600"
           onClick={(e) => e.stopPropagation()} onChange={() => selection.toggle(k)} />
  );
}

/** Save rows as a CSV file in the browser. */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ExportButton({ count, onExport }: { count: number; onExport: () => void }) {
  const t = useT();
  return (
    <button type="button" className="btn btn-sm" onClick={onExport} title={t('Download the rows as a CSV file')}>
      <Download className="h-3.5 w-3.5" /> {count ? t('Export {n} selected', { n: count.toLocaleString() }) : t('Export CSV')}
    </button>
  );
}

/** The table header cell style. */
export const TH = 'px-3 py-2.5 text-left text-xs font-medium text-muted';
/** A body row that opens the side panel — keyboard reachable, blue when selected. */
export function rowProps(selected: boolean, open: () => void) {
  return {
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    'aria-selected': selected,
    className: cn('cursor-pointer border-b border-slate-100 align-top transition-colors last:border-0 hover:bg-slate-50 focus:outline-none focus-visible:bg-brand-50/60',
      selected && 'bg-brand-50/70 hover:bg-brand-50'),
  };
}

/** Bold title over a muted one-line description. */
export function TwoLine({ title, sub, clamp = 2 }: { title: ReactNode; sub?: ReactNode; clamp?: 1 | 2 }) {
  return (
    <div className="min-w-0">
      <p className={cn('font-semibold leading-snug text-ink', clamp === 2 ? 'line-clamp-2' : 'line-clamp-1')}>{title}</p>
      {sub && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{sub}</p>}
    </div>
  );
}

/**
 * Right-hand slide-over drawer for a selected row. Always fixed to the right
 * edge of the viewport, so it is visible wherever the row was in the list.
 * A light backdrop closes it on click; Esc closes it; focus moves into the
 * drawer on open and returns to the row that opened it on close.
 */
export function SidePanel({
  title, eyebrow, badge, onClose, tabs, tab, onTab, footer, children, labelId,
}: {
  title: ReactNode; eyebrow?: ReactNode; badge?: ReactNode; onClose: () => void;
  tabs?: { key: string; label: string }[]; tab?: string; onTab?: (k: string) => void;
  footer?: ReactNode; children: ReactNode; labelId: string;
}) {
  // the tab list below maps over `t`, so the translate function is `tr` here
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    const el = ref.current;
    el?.focus({ preventScroll: true });
    // a short slide-in, skipped for people who ask for less motion
    if (el && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.animate?.([{ transform: 'translateX(24px)' }, { transform: 'translateX(0)' }], { duration: 160, easing: 'ease-out' });
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <div className="pm-fade fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[3px]" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1}
           className="pm-sheet fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col overflow-hidden bg-white/95 shadow-drawer outline-none backdrop-blur-2xl sm:inset-y-3 sm:right-3 sm:rounded-[24px] sm:shadow-[0_30px_80px_-24px_rgba(0,0,0,0.38),0_0_0_0.5px_rgba(0,0,0,0.08)]">
        <div className="flex shrink-0 items-start gap-3 px-6 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            {eyebrow && <div className="mb-1 text-xs font-medium text-muted">{eyebrow}</div>}
            <h3 id={labelId} className="text-[15px] font-semibold leading-snug text-ink">{title}</h3>
            {badge && <div className="mt-2 flex flex-wrap items-center gap-1.5">{badge}</div>}
          </div>
          <button className="btn btn-ghost btn-sm h-8 w-8 shrink-0 px-0" onClick={onClose} aria-label={tr('Close details')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {tabs && tabs.length > 0 && (
          <div role="tablist" aria-label={tr('Detail sections')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 [scrollbar-width:none]">
            {tabs.map((t) => (
              <button key={t.key} role="tab" aria-selected={t.key === tab} onClick={() => onTab?.(t.key)}
                      className={cn('tab px-2.5 py-2 text-[13px]', t.key === tab && 'tab-active')}>{t.label}</button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-white px-5 py-3">{footer}</div>}
      </div>
    </>
  );
}

/** A small titled block inside the side panel. */
export function PanelBlock({ title, link, children }: { title: string; link?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
        {link && (
          <button onClick={link.onClick} className="text-xs font-medium text-brand-600 hover:text-brand-700">{link.label} →</button>
        )}
      </div>
      {children}
    </section>
  );
}

/** Coloured square icon tile with arbitrary colour classes (categorical palettes). */
export function Tile({ icon, cls, size = 'md' }: { icon: string; cls: string; size?: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'h-7 w-7 rounded-md', md: 'h-9 w-9 rounded-lg', lg: 'h-11 w-11 rounded-xl' }[size];
  const ic = { sm: 'h-3.5 w-3.5', md: 'h-[18px] w-[18px]', lg: 'h-5 w-5' }[size];
  return <span className={cn('grid shrink-0 place-items-center', box, cls)}><Icon name={icon} className={ic} /></span>;
}

/** A date-only "2025-01-01" is a calendar day, not UTC midnight — parse it locally so it never shifts a day. */
export function parseDay(v: string): Date {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
}

/**
 * "2025-03-14T09:12:00Z" → "14 Mar 2025". Non-dates are returned as written.
 * Pass `useDateLocale()` as `locale` so month names follow the chosen language.
 */
export function fmtDay(v?: string | null, locale = 'en-GB'): string {
  if (!v) return '—';
  const d = parseDay(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** The URL params the tabs use to hand a selection to one another. */
export const SUB_PARAMS = ['q', 'obl', 'ob', 'doc', 'view', 'sec', 'ctl'] as const;

export const REG_TABS = [tx('Overview'), tx('Applicability'), tx('Impact'), tx('Obligations'), tx('Requirements'), tx('Controls'),
  tx('Full Text'), tx('Updates')] as const;
export type RegTab = (typeof REG_TABS)[number];
/** Switch tab, optionally handing over a selection (?q=, ?ob=, ?doc= …). */
export type GoTab = (t: RegTab, params?: Record<string, string>) => void;

/** Display only: "(COMMITMENT)" → "(Commitment)". Codes like "AAC.10.a" are left as written. */
export function prettyCaps(s: string): string;
export function prettyCaps(s: string | null | undefined): string | null | undefined;
export function prettyCaps(s: string | null | undefined) {
  return s ? s.replace(/\(([A-Z][A-Z_ ]{2,})\)/g, (_, w: string) => `(${words(w)})`) : s;
}
