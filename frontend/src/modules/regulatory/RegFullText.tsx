/**
 * Full Text — the regulation as extracted, section by section, with the
 * requirement sentences the gap assessment checked highlighted by verdict.
 *
 * Nothing is rendered that the extraction did not store: the "page" is the
 * stored section text (not a PDF render), and a highlight appears only where a
 * requirement's own wording — or its clause code — is found in that section.
 * Unmatched requirements are simply not highlighted; the counts say how many
 * were placed.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Search, Download, FileText, Table2,
  CheckCircle2, Flag, AlertCircle, FileWarning, CircleDot,
} from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { StackedBar } from '@/components/ui/charts';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Icon } from '@/config/icons';
import { useRegulationSections, useRegulationTables } from '@/services/regulationsApi';
import { useRequirements } from '@/services/complianceApi';
import { cn, readable } from '@/utils/ui';
import { useDateLocale, useT } from '@/i18n';
import {
  useGapAssessment, useCascadeGraph, useLinkResolver, flattenGap, useRegOverview, GAP_UI, gapUi, UNMET,
  RISK_ORDER, riskKey, RiskPill, GapPill, fmtDay, Pill, type GoTab,
} from './regShared';

interface Sec { id: string; section_number: string; section_title: string; section_text: string }
/** A requirement placed in the text: its code, its verdict, and the words to find. */
interface Mark { key: string; code: string; text: string; raw: string; status: string; risk: string; needle: string; dept: string[]; ctrls: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** "AAC.2" < "AAC.13" — numbers compared as numbers. */
const natCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
/** "Access, Assessment and Continuity of Care — AAC.6" → "Access, Assessment and Continuity of Care". */
const chapterFromTitle = (t: string) => t.match(/^(.*?)\s+[—–-]\s+[A-Za-z]{2,6}[.\s]?\d[\w.]*\s*$/)?.[1]?.trim() ?? null;
/** Codes are compared without case. */
const isChildOf = (code: string, parent: string) => !!parent && code.toUpperCase().startsWith(`${parent.toUpperCase()}.`);
/** The first eight words of a requirement — enough to find it, short enough to survive reflow. */
const needleOf = (t: string) => { const w = norm(t).split(' ').slice(0, 8).join(' '); return w.length >= 18 ? w : ''; };
const codeKey = (s: string) => s.toUpperCase().replace(/[\s.:-]+$/g, '').replace(/\s+/g, '');

/** Verdict wash for a highlighted sentence: green met, amber partial, red gap, orange not covered, blue not assessed. */
const HL: Record<string, { cls: string; ic: string; Glyph: typeof CheckCircle2 }> = {
  MET: { cls: 'bg-success-50 border-success-500', ic: 'text-success-600', Glyph: CheckCircle2 },
  PARTIAL: { cls: 'bg-warning-100/70 border-warning-500', ic: 'text-warning-600', Glyph: Flag },
  GAP: { cls: 'bg-critical-50 border-critical-500', ic: 'text-critical-600', Glyph: AlertCircle },
  NOT_COVERED: { cls: 'bg-notcov-50 border-notcov-500', ic: 'text-notcov-600', Glyph: FileWarning },
  NONE: { cls: 'bg-brand-50 border-brand-400', ic: 'text-brand-600', Glyph: CircleDot },
};
const hl = (s: string) => HL[s] ?? HL.NONE;
function StatusGlyph({ status, className }: { status: string; className?: string }) {
  const h = hl(status);
  return <h.Glyph className={cn(className, h.ic)} aria-hidden="true" />;
}

export function FullTextTab({ id, go, sourceUrl, lastUpdated }: { id: string; go: GoTab; sourceUrl?: string; lastUpdated?: string | null }) {
  // `t` is a section title inside labelOf below, so the translate function is `tr` here
  const tr = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sections = useRegulationSections(id);
  const tables = useRegulationTables(id);
  const gap = useGapAssessment(id);
  const rows = useMemo(() => flattenGap(gap.data), [gap.data]);
  const graph = useCascadeGraph(rows.length > 0);
  const resolve = useLinkResolver(graph.data);
  const { data: ov } = useRegOverview(id);
  // not assessed: place the first page of extracted requirements instead (verdict "not assessed")
  const reqs = useRequirements({ regulation_id: id, size: 200, page: 1 });
  const [view, setView] = useState<'text' | 'tables'>('text');
  const [secId, setSecId] = useState<string | null>(params.get('sec'));
  const [find, setFind] = useState('');
  const [outlineQ, setOutlineQ] = useState('');
  const [zoom, setZoom] = useState(100);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [panelTab, setPanelTab] = useState('details');

  const secs: Sec[] = useMemo(() => sections.data?.items ?? [], [sections.data]);

  const marks: Mark[] = useMemo(() => {
    if (rows.length) {
      return rows.map((r) => ({ key: r.key, code: r.c, text: r.ob || r.t, raw: r.t || r.ob, status: r.st, risk: riskKey(r.rk), needle: needleOf(r.t), dept: r.depts, ctrls: resolve(r).ctrls }));
    }
    return (reqs.data?.items ?? []).map((r) => ({
      key: r.id, code: r.source_clause ?? '', text: r.statement, raw: r.source_excerpt ?? r.statement, status: 'NONE', risk: 'None',
      needle: needleOf(r.source_excerpt ?? r.statement), dept: [], ctrls: [],
    }));
  }, [rows, reqs.data, resolve]);

  /** Which section each requirement belongs to: its clause code first, then its own words. */
  const placed = useMemo(() => {
    const bySec = new Map<string, Mark[]>();
    if (!secs.length) return bySec;
    const byCode = new Map<string, string>();
    secs.forEach((s) => { if (s.section_number) byCode.set(codeKey(s.section_number), s.id); });
    // one normalised copy of the document, with each section's start offset, for word matching
    const starts: number[] = []; let doc = '';
    secs.forEach((s) => { starts.push(doc.length); doc += norm(`${s.section_title ?? ''} ${s.section_text ?? ''}`) + ' | '; });
    const secAt = (off: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return secs[lo].id; };
    const tooBig = doc.length > 4_000_000 || marks.length > 5000;
    marks.forEach((m) => {
      // the clause code, then its nearest parent code ("AAC.1.b" → "AAC.1"), and only then the words
      let sid = m.code ? byCode.get(codeKey(m.code)) : undefined;
      if (!sid && m.code) {
        const parts = m.code.split('.');
        for (let i = parts.length - 1; i > 0 && !sid; i--) sid = byCode.get(codeKey(parts.slice(0, i).join('.')));
      }
      if (!sid && m.needle && !tooBig) { const at = doc.indexOf(m.needle); if (at >= 0) sid = secAt(at); }
      if (sid) { const a = bySec.get(sid) ?? []; a.push(m); bySec.set(sid, a); }
    });
    return bySec;
  }, [secs, marks]);

  /** True when nearly every section carries its own number; otherwise the numbers are not worth showing. */
  const numbered = useMemo(() => {
    const nums = secs.map((s) => (s.section_number ?? '').trim()).filter(Boolean);
    return nums.length >= secs.length * 0.9 && new Set(nums).size >= secs.length * 0.9;
  }, [secs]);

  /** Chapters: an alphabetic code prefix (AAC, COP…) or a leading number, when it actually groups. */
  const chapters = useMemo(() => {
    const keyOf = (s: Sec) => {
      const n = (s.section_number ?? '').trim();
      const a = n.match(/^([A-Za-z]{2,6})(?=[.\s\-\d]|$)/); if (a) return a[1].toUpperCase();
      const d = n.match(/^(\d+)\./); if (d) return d[1];
      return '';
    };
    const keys = secs.map(keyOf);
    const distinct = new Set(keys.filter(Boolean));
    const grouped = distinct.size >= 2 && distinct.size <= Math.max(2, secs.length / 2) && keys.filter(Boolean).length >= secs.length * 0.6;
    // chapters in the order the assessment walks them (document order), else first appearance
    const rank = new Map<string, number>();
    rows.forEach((r, i) => { const k = (r.c.match(/^([A-Za-z]{2,6})/)?.[1] ?? '').toUpperCase(); if (k && !rank.has(k)) rank.set(k, i); });
    const out: { key: string; title: string; name: string | null; first: number; secs: Sec[] }[] = [];
    secs.forEach((s, i) => {
      const k = grouped ? (keys[i] || 'Other') : 'all';
      let ch = out.find((c) => c.key === k);
      if (!ch) {
        const named = rows.find((r) => r.unit.toUpperCase().startsWith(k) || r.c.toUpperCase().startsWith(`${k}.`));
        const name = grouped ? (chapterFromTitle(s.section_title ?? '') ?? named?.chapter ?? null) : null;
        ch = { key: k, name, title: grouped ? (name ? `${k} · ${name}` : tr('Chapter {key}', { key: k })) : tr('Sections'), first: rank.get(k) ?? 100_000 + i, secs: [] };
        out.push(ch);
      }
      ch.secs.push(s);
    });
    // natural order inside a chapter (AAC.1, AAC.2 … AAC.13); a flat list only when every section has its own number —
    // a table extracted row by row repeats "1", "2", "3", and sorting those would shuffle the document
    const allNumbered = numbered && secs.every((s) => /^\d/.test((s.section_number ?? '').trim()));
    if (grouped || allNumbered) out.forEach((c) => c.secs.sort((a, b) => natCmp(a.section_number ?? '', b.section_number ?? '')));
    return out.sort((a, b) => a.first - b.first);
  }, [secs, rows, tr, numbered]);
  /** Sections in reading order — what ‹ › steps through. */
  const ordered = useMemo(() => chapters.flatMap((c) => c.secs), [chapters]);
  /** Each section's place in reading order, shown instead of its number when the numbers repeat. */
  const pos = useMemo(() => new Map(ordered.map((s, i) => [s.id, i + 1])), [ordered]);
  const numOf = (s: Sec) => (numbered ? (s.section_number ?? '').trim() : String(pos.get(s.id) ?? ''));

  /** The row label: the standard's own sentence when the stored title only repeats the chapter and code. */
  const labelOf = (s: Sec) => {
    const t = (s.section_title ?? '').trim();
    const txt = (s.section_text ?? '').trim();
    const redundant = !t || (!!s.section_number && t.toUpperCase().includes(s.section_number.toUpperCase())) || !!chapterFromTitle(t);
    return redundant && txt && txt.length <= 400 ? txt : (t || txt.slice(0, 90) || '—');
  };
  /** Assessed elements that sit under a standard ("AAC.6.a" under "AAC.6"), in clause order. */
  const elementsOf = (s: Sec) => (placed.get(s.id) ?? []).filter((m) => isChildOf(m.code, s.section_number)).sort((a, b) => natCmp(a.code, b.code));
  /** A short standard with its elements listed in the assessment — rendered as a numbered clause list. */
  const isStandard = (s: Sec) => (s.section_text ?? '').length <= 600 && elementsOf(s).length > 0;

  const current = ordered.find((s) => s.id === secId) ?? ordered[0];
  const idx = current ? ordered.indexOf(current) : -1;
  useEffect(() => { setFind(''); setPanelTab('details'); }, [current?.id]);
  const here = current ? (placed.get(current.id) ?? []) : [];
  const chapterOf = (s: Sec) => chapters.find((c) => c.secs.includes(s));
  const placedTotal = [...placed.values()].reduce((a, m) => a + m.length, 0);
  // a chapter page when the chapter's standards carry assessed elements (NABH-style); otherwise the section text as stored
  const docMode = !!current && chapters.length > 1 && (current.section_text ?? '').length <= 600 && (chapterOf(current)?.secs.some(isStandard) ?? false);
  // bring the picked standard into view on the chapter page (not on first paint of a chapter's first standard)
  const firstPaint = useRef(true);
  useEffect(() => {
    if (!current || !docMode) return;
    const first = chapterOf(current)?.secs[0]?.id === current.id;
    if (firstPaint.current && first) { firstPaint.current = false; return; }
    firstPaint.current = false;
    document.getElementById(`std-${current.id}`)?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, docMode]);
  // keep the open section in sight in the outline when ‹ › step past its edge (the outline scrolls, the page does not)
  const outlineBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = outlineBox.current;
    const el = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !el) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop - 8;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 8;
  }, [current?.id]);

  if (sections.isLoading) return <div className="card"><Skeleton rows={10} /></div>;

  const pdf = !!sourceUrl && /\.pdf($|[?#])/i.test(sourceUrl);
  const tablesLabel = tables.data?.total ? tr('Tables ({n})', { n: tables.data.total.toLocaleString() }) : tr('Tables');
  // `wide`: the toolbar has the whole card to itself. Beside the outline and the details panel on a
  // 1280–1535px screen (most Windows laptops) the page column is narrow, so labels give way to icons
  // there and the toolbar stays on one line.
  const narrow = (wide: boolean) => (wide ? '' : 'xl:max-2xl:hidden');
  const toolbar = (wide: boolean) => (
    <div className="sticky top-[112px] z-10 flex flex-wrap items-center gap-1.5 rounded-t-xl border-b border-line bg-white px-3 py-2">
      <SegmentedControl size="sm" ariaLabel="Full text view" value={view} onChange={setView} options={[
        { key: 'text', title: 'Text', label: <><FileText className="h-3.5 w-3.5" /><span className={narrow(wide)}>{tr('Text')}</span></> },
        { key: 'tables', title: 'Tables', label: <><Table2 className="h-3.5 w-3.5" /><span className={narrow(wide)}>{tablesLabel}</span></> },
      ]} />
      {view === 'text' && current && (<>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <div className="flex items-center">
          <button className="btn btn-sm h-7 w-7 px-0" aria-label={tr('Previous section')} title={tr('Previous section')} disabled={idx <= 0} onClick={() => setSecId(ordered[idx - 1].id)}><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[64px] px-1 text-center text-[12.5px] tabular-nums text-ink-2" title={tr('Section {i} / {n}', { i: (idx + 1).toLocaleString(), n: ordered.length.toLocaleString() })}>
            {(idx + 1).toLocaleString()} / {ordered.length.toLocaleString()}
          </span>
          <button className="btn btn-sm h-7 w-7 px-0" aria-label={tr('Next section')} title={tr('Next section')} disabled={idx >= ordered.length - 1} onClick={() => setSecId(ordered[idx + 1].id)}><ChevronRight className="h-4 w-4" /></button>
        </div>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <div className="flex items-center">
          <button className="btn btn-sm h-7 w-7 px-0" aria-label={tr('Smaller text')} title={tr('Smaller text')} disabled={zoom <= 80} onClick={() => setZoom((z) => z - 10)}><Minus className="h-4 w-4" /></button>
          <span className={cn('w-10 text-center text-[12.5px] tabular-nums text-ink-2', narrow(wide))}>{zoom}%</span>
          <button className="btn btn-sm h-7 w-7 px-0" aria-label={tr('Larger text')} title={tr('Larger text')} disabled={zoom >= 150} onClick={() => setZoom((z) => z + 10)}><Plus className="h-4 w-4" /></button>
        </div>
        {/* last, so if the column is ever too narrow it is the search box that takes a line of its own */}
        <div className="relative ml-auto min-w-[120px] flex-1 sm:max-w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1.5 h-4 w-4 text-muted-2" aria-hidden="true" />
          <input className="input h-7 pl-8 text-[12.5px]" placeholder={tr('Find in section')} aria-label={tr('Find in this section')} value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
      </>)}
      {/* beside the details panel the source is one of its quick actions; alone, the toolbar offers it */}
      {wide && sourceUrl && (
        <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm ml-auto"><Download className="h-3.5 w-3.5" /> {tr(pdf ? 'Download PDF' : 'Open source')}</a>
      )}
    </div>
  );

  if (view === 'tables' || !secs.length) {
    return (
      <div className="card overflow-hidden">
        {toolbar(true)}
        <div className="p-4">
          {view === 'tables' ? <TablesView id={id} /> : (
            <EmptyState title={tr('No sections have been extracted for this document')} icon="FileText"
                        hint={tables.data?.total ? tr('Its tables are available — switch to Tables above.') : undefined} />
          )}
        </div>
      </div>
    );
  }

  const count = (s: string) => here.filter((m) => m.status === s).length;
  const worst = here.filter((m) => UNMET.has(m.status)).reduce<string>((w, m) => (RISK_ORDER[m.risk] < RISK_ORDER[w] ? m.risk : w), 'None');
  const depts = [...new Set(here.flatMap((m) => m.dept))];
  const ctrls = [...new Set(here.flatMap((m) => m.ctrls))];
  const ch = chapterOf(current);
  const words = (current.section_text ?? '').split(/\s+/).filter(Boolean).length;
  // the heading once: a body that only repeats it is not printed again, and a body that opens with it starts after it
  const heading = chapterFromTitle(current.section_title ?? '') ?? (current.section_title || labelOf(current));
  const rawText = (current.section_text ?? '').trim();
  const onlyHeading = !!rawText && norm(rawText) === norm(heading);
  const body = !onlyHeading && norm(heading).length >= 8 && rawText.toLowerCase().startsWith(heading.trim().toLowerCase())
    ? rawText.slice(heading.trim().length).replace(/^[\s:;.,–—-]+/, '')
    : rawText;
  const prev = idx > 0 ? ordered[idx - 1] : null;
  const next = idx < ordered.length - 1 ? ordered[idx + 1] : null;

  return (
    // three columns from 1280px — the width of most Windows laptops — so the details panel stays beside the page
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_272px] 2xl:grid-cols-[272px_minmax(0,1fr)_320px] 2xl:gap-4">
      {/* ---------------- outline ---------------- */}
      <nav aria-label={tr('Document outline')} className="card overflow-hidden lg:sticky lg:top-[124px]">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold text-ink">{tr('Document outline')}</h3>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-2" aria-hidden="true" />
            <input className="input pl-8 text-[13px]" placeholder={tr('Search sections')} aria-label={tr('Search sections')} value={outlineQ} onChange={(e) => setOutlineQ(e.target.value)} />
          </div>
          {marks.length > 0 && (
            <p className="mt-2 text-[11.5px] text-muted">
              {rows.length
                ? tr('{placed} of {total} assessed requirements placed in the text', { placed: placedTotal.toLocaleString(), total: marks.length.toLocaleString() })
                : tr('{placed} of {total} requirements placed in the text', { placed: placedTotal.toLocaleString(), total: marks.length.toLocaleString() })}
              {!rows.length && reqs.data && reqs.data.total > reqs.data.items.length
                && ` ${tr('(the first {n} of {total})', { n: reqs.data.items.length.toLocaleString(), total: reqs.data.total.toLocaleString() })}`}
            </p>
          )}
        </div>
        <div ref={outlineBox} className="relative max-h-[calc(100vh-280px)] overflow-y-auto py-1">
          {chapters.map((c) => {
            const list = c.secs.filter((s) => !outlineQ || `${s.section_number} ${s.section_title} ${labelOf(s)}`.toLowerCase().includes(outlineQ.toLowerCase()));
            if (!list.length) return null;
            const isClosed = closed.has(c.key) && !outlineQ;
            const n = c.secs.reduce((a, s) => a + (placed.get(s.id)?.length ?? 0), 0);
            return (
              <div key={c.key}>
                {chapters.length > 1 && (
                  <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-semibold text-ink hover:bg-slate-50"
                          aria-expanded={!isClosed}
                          onClick={() => setClosed((s) => { const x = new Set(s); if (x.has(c.key)) x.delete(c.key); else x.add(c.key); return x; })}>
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted transition', isClosed && '-rotate-90')} />
                    <span className="min-w-0 flex-1 truncate" title={c.title}>{c.title}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] tabular-nums text-slate-600">{n || c.secs.length}</span>
                  </button>
                )}
                {!isClosed && (
                  <ul>
                    {list.map((s) => {
                      const m = placed.get(s.id) ?? [];
                      const bad = m.some((x) => x.status === 'GAP' || x.status === 'NOT_COVERED');
                      const part = m.some((x) => x.status === 'PARTIAL');
                      const badge = !m.length ? 'bg-slate-100 text-slate-500' : bad ? 'bg-critical-50 text-critical-600' : part ? 'bg-warning-50 text-warning-700' : rows.length ? 'bg-success-50 text-success-600' : 'bg-brand-50 text-brand-700';
                      const active = s.id === current.id;
                      return (
                        <li key={s.id}>
                          <button onClick={() => setSecId(s.id)} aria-current={active ? 'true' : undefined}
                                  className={cn('relative flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[12.5px] hover:bg-slate-50',
                                    chapters.length > 1 ? 'pl-8' : 'pl-4',
                                    active && 'bg-brand-50 font-medium text-brand-700 before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-r-full before:bg-brand-600 hover:bg-brand-50')}>
                            <span className={cn('shrink-0 tabular-nums', active ? 'text-brand-600' : 'text-muted', !numbered && 'min-w-[3ch] text-right text-[11.5px]')}>{numOf(s)}</span>
                            <span className="min-w-0 flex-1 truncate" title={labelOf(s)}>{labelOf(s)}</span>
                            {m.length > 0 && <span className={cn('rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums', badge)}>{m.length}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* ---------------- the page ---------------- */}
      <div className="card min-w-0">
        {toolbar(false)}
        <div className="min-h-[calc(100vh-260px)] rounded-b-xl bg-canvas p-3 sm:p-5 xl:max-2xl:p-3">
          <article className="mx-auto max-w-[820px] rounded-lg border border-line bg-white px-6 py-7 shadow-card sm:px-10 xl:max-2xl:px-7" style={{ fontSize: `${(zoom / 100) * 14}px` }}>
            {ch && chapters.length > 1 && <span className="pill bg-brand-50 text-brand-700">{(ch.key === 'Other' ? tr('Other') : tr('Chapter {key}', { key: ch.key })).toUpperCase()}</span>}
            {docMode && ch ? (<>
              {/* a chapter page: the chapter name once, then every standard with its numbered elements */}
              <h2 className="mt-3 text-[1.6em] font-bold leading-tight tracking-tight text-ink">{ch.name ?? ch.title}</h2>
              <Legend marks={ch.secs.flatMap((s) => placed.get(s.id) ?? [])} assessed={rows.length > 0} />
              <div className="mt-4 divide-y divide-line">
                {ch.secs.map((s) => (
                  <StandardBlock key={s.id} s={s} label={labelOf(s)} chapterKey={ch.key} elements={elementsOf(s)}
                                 others={(placed.get(s.id) ?? []).filter((m) => !isChildOf(m.code, s.section_number))}
                                 active={s.id === current.id} find={find} onPick={() => setSecId(s.id)}
                                 onMark={(m) => { if (rows.length) go('Obligations', { ob: m.code }); }} />
                ))}
              </div>
            </>) : (<>
              <h2 className="mt-3 text-[1.5em] font-bold leading-tight tracking-tight text-ink [overflow-wrap:anywhere]">
                {numbered && current.section_number && <span className="mr-2 text-brand-600">{current.section_number}</span>}
                {markTerm(heading, find)}
              </h2>
              <Legend marks={here} assessed={rows.length > 0} />
              <div className="mt-4 space-y-2.5 leading-relaxed text-ink-2">
                {onlyHeading
                  ? <p className="text-[13px] text-muted">{tr('This section holds only its heading.')}</p>
                  : <SectionBody text={body} marks={here} find={find} onMark={(m) => { if (rows.length) go('Obligations', { ob: m.code }); }} />}
              </div>
              {/* read on without going back to the outline */}
              {(prev || next) && (
                <div className="mt-8 grid grid-cols-2 gap-2 border-t border-line pt-4">
                  {prev ? (
                    <button type="button" onClick={() => setSecId(prev.id)} className="group min-w-0 rounded-xl border border-line px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
                      <span className="flex items-center gap-1 text-[11.5px] text-muted"><ChevronLeft className="h-3.5 w-3.5" />{tr('Previous section')}</span>
                      <span className="mt-0.5 block truncate text-[13px] font-medium text-ink group-hover:text-brand-700">{labelOf(prev)}</span>
                    </button>
                  ) : <span />}
                  {next && (
                    <button type="button" onClick={() => setSecId(next.id)} className="group min-w-0 rounded-xl border border-line px-3 py-2 text-right transition hover:border-brand-300 hover:bg-brand-50/40">
                      <span className="flex items-center justify-end gap-1 text-[11.5px] text-muted">{tr('Next section')}<ChevronRight className="h-3.5 w-3.5" /></span>
                      <span className="mt-0.5 block truncate text-[13px] font-medium text-ink group-hover:text-brand-700">{labelOf(next)}</span>
                    </button>
                  )}
                </div>
              )}
            </>)}
          </article>
        </div>
      </div>

      {/* ---------------- section details ---------------- */}
      <aside aria-label={tr('Section details')} className="card overflow-hidden lg:col-span-2 xl:sticky xl:top-[124px] xl:col-span-1">
        {/* the count sits in a small badge so the three tabs fit the 272px panel of a 1280px screen */}
        <div role="tablist" aria-label={tr('Section panels')} className="flex gap-0.5 overflow-x-auto border-b border-line px-2 [scrollbar-width:none]">
          {([['details', tr('Details'), null], ['reqs', tr('Requirements'), here.length], ['related', tr('Related'), null]] as const).map(([k, l, n]) => (
            <button key={k} role="tab" aria-selected={panelTab === k} onClick={() => setPanelTab(k)}
                    className={cn('tab inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-2.5 text-[12.5px]', panelTab === k && 'tab-active')}>
              {l}
              {n !== null && <span className={cn('rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums', n ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500')}>{n.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        <div className="max-h-[calc(100vh-200px)] space-y-5 overflow-y-auto p-4">
          {panelTab === 'details' && (<>
            <section>
              <h4 className="mb-2 text-[13px] font-semibold text-ink">{tr('Section details')}</h4>
              <dl className="divide-y divide-dashed divide-line text-[13px]">
                {/* the page heading already shows a section's title; a chapter page shows many standards, so name the open one */}
                {docMode && (
                  <div className="py-1.5">
                    <dt className="text-muted">{tr('Standard')}</dt>
                    <dd className="mt-0.5 font-medium leading-snug text-ink-2">{labelOf(current)}</dd>
                  </div>
                )}
                <KV k={tr('Section')} v={numbered ? (current.section_number || '—') : `${(idx + 1).toLocaleString()} / ${ordered.length.toLocaleString()}`} />
                {ch && chapters.length > 1 && <KV k={tr('Chapter')} v={<span title={ch.title}>{ch.key}{ch.name ? ` · ${ch.name}` : ''}</span>} />}
                {!docMode && <KV k={tr('Length')} v={words === 1 ? tr('1 word') : tr('{n} words', { n: words.toLocaleString() })} />}
                <KV k={tr(docMode ? 'Elements' : 'Requirements')} v={here.length.toLocaleString()} />
                {rows.length > 0 && here.length > 0 && (
                  <div className="py-1.5">
                    <dt className="text-muted">{tr('Status mix')}</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {(['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] as const).filter((s) => count(s)).map((s) => (
                        <Pill key={s} tone={GAP_UI[s].tone}>{count(s)} {tr(GAP_UI[s].label).toLowerCase()}</Pill>
                      ))}
                    </dd>
                  </div>
                )}
                {rows.length > 0 && <KV k={tr('Controls linked')} v={ctrls.length.toLocaleString()} />}
                {rows.length > 0 && <KV k={tr('Risk level')} v={<RiskPill risk={worst} />} />}
                {depts.length > 0 && (
                  <div className="py-1.5">
                    <dt className="text-muted">{tr('Departments')}</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">{depts.map((d) => <Pill key={d} tone="blue">{tr(d)}</Pill>)}</dd>
                  </div>
                )}
                <KV k={tr('Last updated')} v={fmtDay(lastUpdated, locale)} />
              </dl>
            </section>
            {here.length > 0 && rows.length > 0 && (
              <section className="rounded-xl border border-violet-100 bg-violet-50 p-3">
                <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-violet-700"><Icon name="Sparkles" className="h-3.5 w-3.5" /> {tr('At a glance')}</h4>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                  {here.length === 1
                    ? tr('1 requirement sits in this section: {met} documented, {partial} partial, {gap} not addressed.', {
                      met: count('MET').toLocaleString(), partial: count('PARTIAL').toLocaleString(), gap: (count('GAP') + count('NOT_COVERED')).toLocaleString(),
                    })
                    : tr('{n} requirements sit in this section: {met} documented, {partial} partial, {gap} not addressed.', {
                      n: here.length.toLocaleString(), met: count('MET').toLocaleString(), partial: count('PARTIAL').toLocaleString(),
                      gap: (count('GAP') + count('NOT_COVERED')).toLocaleString(),
                    })}
                  {worst !== 'None' ? ` ${tr('The worst unmet one is rated {level}.', { level: tr(worst).toLowerCase() })}` : ''}
                  {depts.length ? ` ${depts.length > 3
                    ? tr('Responsibility falls on {depts} and others.', { depts: depts.slice(0, 3).map((d) => tr(d)).join(', ') })
                    : tr('Responsibility falls on {depts}.', { depts: depts.map((d) => tr(d)).join(', ') })}` : ''}
                </p>
                <StackedBar className="mt-2" legend={false} height={8}
                            data={(['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] as const).map((s) => ({ label: tr(GAP_UI[s].label), value: count(s), color: GAP_UI[s].hex }))} />
              </section>
            )}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-[13px] font-semibold text-ink">{tr('Key requirements in this section')}</h4>
                {here.length > 5 && <button className="text-xs font-medium text-brand-600" onClick={() => setPanelTab('reqs')}>{tr('View all')} →</button>}
              </div>
              {here.length ? (
                <ul className="space-y-2">
                  {[...here].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || natCmp(a.code, b.code)).slice(0, 5).map((m) => (
                    <li key={m.key} className="flex items-start gap-2 text-[12.5px]">
                      <StatusGlyph status={m.status} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 leading-snug text-ink-2"><b className="text-ink">{m.code}</b> <span className="line-clamp-2">{m.raw}</span></span>
                      {m.risk !== 'None' && <RiskPill risk={m.risk} />}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[12.5px] text-muted">{tr('No requirement was placed in this section.')}</p>}
            </section>
            <section>
              <h4 className="mb-2 text-[13px] font-semibold text-ink">{tr('Quick actions')}</h4>
              {/* one action per row: labels never wrap inside a half-width button */}
              <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                <QuickAction icon="ListChecks" label="View requirements" onClick={() => go('Requirements', numbered && current.section_number ? { q: current.section_number } : undefined)} />
                <QuickAction icon="ShieldCheck" label="View controls" onClick={() => go('Controls', rows.length ? { view: 'docs' } : undefined)} />
                <QuickAction icon="GitBranch" label="Impact cascade" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(id)}`)} />
                {sourceUrl
                  ? <QuickAction icon={pdf ? 'Download' : 'ExternalLink'} label={pdf ? 'Download PDF' : 'Open source'} href={sourceUrl} />
                  : <QuickAction icon="ClipboardList" label="View obligations" onClick={() => go('Obligations')} />}
              </div>
            </section>
          </>)}
          {panelTab === 'reqs' && (here.length ? (
            <ul className="space-y-2">
              {[...here].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]).map((m) => (
                <li key={m.key}>
                  <button className="w-full rounded-xl border border-line p-3 text-left hover:border-brand-300 disabled:cursor-default"
                          disabled={!rows.length} onClick={() => go('Obligations', { ob: m.code })}>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink"><b>{m.code}</b> {m.raw}</span>
                      {rows.length ? <GapPill status={m.status} /> : null}
                    </div>
                    {m.risk !== 'None' && <div className="mt-1.5"><RiskPill risk={m.risk} /></div>}
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyState title={tr('No requirement placed here')} icon="ListChecks" />)}
          {panelTab === 'related' && (<>
            <section>
              <h4 className="mb-2 text-[13px] font-semibold text-ink">{tr('In this document')}</h4>
              <ul className="space-y-1.5 text-[13px]">
                <li className="flex justify-between"><span className="text-muted">{tr('Sections')}</span><b className="tabular-nums">{secs.length.toLocaleString()}</b></li>
                <li className="flex justify-between"><span className="text-muted">{tr('Tables')}</span>
                  <button className="font-semibold text-brand-600 hover:underline" onClick={() => setView('tables')}>{(tables.data?.total ?? 0).toLocaleString()}</button></li>
                {ch && chapters.length > 1 && <li className="flex justify-between"><span className="text-muted">{tr('Sections in this chapter')}</span><b className="tabular-nums">{ch.secs.length}</b></li>}
              </ul>
            </section>
            <section>
              <h4 className="mb-2 text-[13px] font-semibold text-ink">{tr('Related regulations')}</h4>
              {ov?.related.length ? (
                <ul className="space-y-2">
                  {ov.related.map((x) => (
                    <li key={x.id}>
                      <button onClick={() => navigate(`/regulation/${encodeURIComponent(x.id)}`)} className="flex w-full items-center gap-2 text-left text-[12.5px] hover:text-brand-600">
                        <Icon name="Landmark" className="h-4 w-4 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate">{x.title}</span>
                        <span className="shrink-0 text-xs text-muted">{x.regulator}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[12.5px] text-muted">{tr('None from the same regulator or sector reach the hospital.')}</p>}
            </section>
          </>)}
        </div>
      </aside>
    </div>
  );
}

/** Counts per verdict, with the same glyphs the page uses. */
function Legend({ marks, assessed }: { marks: Mark[]; assessed: boolean }) {
  const t = useT();
  if (!marks.length) return null;
  const keys = assessed ? ['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] : ['NONE'];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
      {keys.filter((k) => marks.some((m) => m.status === k)).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <StatusGlyph status={k} className="h-3.5 w-3.5" />
          {t(k === 'NONE' ? 'Requirement (not assessed)' : GAP_UI[k].label)} <b className="font-semibold tabular-nums text-ink-2">{marks.filter((m) => m.status === k).length}</b>
        </span>
      ))}
    </div>
  );
}

/**
 * One standard on the chapter page: its code and sentence, then its assessed
 * elements as numbered clauses ("6.a …"), each washed in its verdict colour.
 */
function StandardBlock({ s, label, chapterKey, elements, others, active, find, onPick, onMark }: {
  s: Sec; label: string; chapterKey: string; elements: Mark[]; others: Mark[]; active: boolean; find: string;
  onPick: () => void; onMark: (m: Mark) => void;
}) {
  const t = useT();
  const local = (code: string) => (code.toUpperCase().startsWith(`${chapterKey.toUpperCase()}.`) ? code.slice(chapterKey.length + 1) : code);
  const txt = (s.section_text ?? '').trim();
  return (
    <section id={`std-${s.id}`} className={cn('scroll-mt-[190px] py-5', active && '-mx-4 rounded-xl bg-brand-50/40 px-4 ring-1 ring-brand-200')}>
      <button type="button" onClick={onPick} aria-current={active ? 'true' : undefined} className="group flex w-full items-baseline gap-3 text-left">
        <span className="shrink-0 text-[1.1em] font-bold tabular-nums text-brand-600">{s.section_number}</span>
        <span className="text-[1.1em] font-semibold leading-snug text-ink group-hover:text-brand-700">{markTerm(label, find)}</span>
      </button>
      {txt && label !== txt && <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-ink-2">{markTerm(txt, find)}</p>}
      {elements.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {elements.map((m) => (
            <li key={m.key} className="flex items-start gap-2.5">
              <button type="button" onClick={() => onMark(m)} className="mt-1 shrink-0 rounded-full"
                      aria-label={t('{code}: {status} — open in Obligations', { code: m.code, status: m.status === 'NONE' ? t('not assessed') : t(gapUi(m.status).label) })}>
                <StatusGlyph status={m.status} className="h-[18px] w-[18px]" />
              </button>
              <span className="w-11 shrink-0 pt-1 font-semibold tabular-nums text-ink">{local(m.code)}</span>
              <p className={cn('min-w-0 flex-1 rounded-r-md border-l-[3px] px-3 py-1 leading-relaxed text-ink-2', hl(m.status).cls)}
                 title={`${m.code} · ${m.status === 'NONE' ? t('not assessed') : t(gapUi(m.status).label)}`}>
                {markTerm(m.raw, find)}
              </p>
              {m.risk !== 'None' && <span className="shrink-0 pt-1"><RiskPill risk={m.risk} /></span>}
            </li>
          ))}
        </ol>
      )}
      {others.length > 0 && (
        <p className="mt-2 text-xs text-muted">{others.length === 1
          ? t('1 more requirement matched to this standard by wording.')
          : t('{n} more requirements matched to this standard by wording.', { n: others.length.toLocaleString() })}</p>
      )}
    </section>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-ink-2">{v}</dd>
    </div>
  );
}

function QuickAction({ icon, label, onClick, href }: { icon: string; label: string; onClick?: () => void; href?: string }) {
  const t = useT();
  const cls = 'group flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium text-ink-2 transition hover:bg-brand-50/60 hover:text-brand-700';
  const body = (<>
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon name={icon} className="h-4 w-4" /></span>
    <span className="min-w-0 flex-1 truncate">{t(label)}</span>
    <ChevronRight className="h-4 w-4 shrink-0 text-muted-2 transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
  </>);
  return href
    ? <a href={href} target="_blank" rel="noreferrer" className={cls}>{body}</a>
    : <button className={cls} onClick={onClick}>{body}</button>;
}

/**
 * The section text as paragraphs (or sentences, when the extraction stored one
 * block), each highlighted when a placed requirement's words are found in it.
 */
function SectionBody({ text, marks, find, onMark }: { text: string; marks: Mark[]; find: string; onMark: (m: Mark) => void }) {
  const t = useT();
  const parts = useMemo(() => {
    const paras = text.split(/\n\s*\n|\n(?=\s*(?:\(?[a-z0-9]{1,4}[.)]|[•\-–]))/i).map((p) => p.trim()).filter(Boolean);
    const list = paras.length > 1 ? paras : text.split(/(?<=[.;:])\s+(?=[A-Z(0-9])/).map((p) => p.trim()).filter(Boolean);
    const used = new Set<string>();
    return list.map((p) => {
      const n = norm(p);
      const m = marks.find((x) => !used.has(x.key) && x.needle && n.includes(x.needle));
      if (m) used.add(m.key);
      return { p, m };
    });
  }, [text, marks]);
  if (!text.trim()) return <p className="text-muted">{t('This section has no stored text.')}</p>;
  return (
    <>
      {parts.map(({ p, m }, i) => m ? (
        <div key={i} className={cn('group relative -mx-3 rounded-r-md border-l-[3px] px-3 py-1.5', hl(m.status).cls)}
             title={`${m.code} · ${m.status === 'NONE' ? t('requirement, not assessed') : t(gapUi(m.status).label)}${m.risk !== 'None' ? ` · ${t('{level} risk', { level: t(m.risk) })}` : ''}`}>
          <button type="button" onClick={() => onMark(m)}
                  aria-label={t('Requirement {code}: {status}', { code: m.code, status: m.status === 'NONE' ? t('not assessed') : t(gapUi(m.status).label) })}
                  className="absolute -left-8 top-1.5 hidden rounded-full bg-white sm:block xl:max-2xl:-left-7">
            <StatusGlyph status={m.status} className="h-[18px] w-[18px]" />
          </button>
          <p className="whitespace-pre-wrap">{markTerm(p, find)}</p>
        </div>
      ) : (
        <p key={i} className="whitespace-pre-wrap">{markTerm(p, find)}</p>
      ))}
    </>
  );
}

function markTerm(text: string, term: string): ReactNode {
  const t = term.trim();
  if (t.length < 2) return text;
  const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return text.split(re).map((chunk, i) => (i % 2 ? <mark key={i} className="rounded bg-yellow-200 px-0.5 text-ink">{chunk}</mark> : <Fragment key={i}>{chunk}</Fragment>));
}

/* ---------------- tables (high-fidelity extraction only) ---------------- */
export function TablesView({ id }: { id: string }) {
  // `t` is each table in the list below, so the translate function is `tr` here
  const tr = useT();
  const { data, isLoading } = useRegulationTables(id);
  if (isLoading) return <Skeleton rows={4} />;
  // An empty list here means "not extracted yet", NOT "this document has no
  // tables" — the fast pass cannot produce tables at all, so say which it is.
  if (!data?.extracted) return <EmptyState title={tr('Tables not extracted yet')} hint={data?.note ?? undefined} icon="Layers" />;
  if (!data.total) return <EmptyState title={tr('The high-fidelity pass found no tables in this document.')} icon="Layers" />;
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted">{data.total === 1
        ? tr('1 table lifted from the source document with rows intact.')
        : tr('{n} tables lifted from the source document with rows intact.', { n: data.total.toLocaleString() })}</p>
      {data.items.map((t) => (
        <div key={t.table_index} className="overflow-hidden rounded-xl border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-slate-50/80 px-4 py-2 text-[12px]">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-50 text-brand-600"><Table2 className="h-3.5 w-3.5" /></span>
            <span className="font-semibold text-ink">{tr('Table {n}', { n: (t.table_index + 1).toLocaleString() })}</span>
            {t.caption && <span className="truncate text-ink-2">{t.caption}</span>}
            <span className="text-muted">{tr('{rows} rows × {cols} cols', { rows: t.row_count, cols: t.col_count })}</span>
            <span className="ml-auto text-[11px] text-muted">{t.extraction_method ? readable(String(t.extraction_method)) : null}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <tbody>
                {t.rows.slice(0, 40).map((row, ri) => (
                  <tr key={ri} className={cn('border-b border-line/60', ri === 0 && 'bg-slate-50 font-medium text-ink')}>
                    {row.map((cell, ci) => <td key={ci} className="px-3 py-1.5 align-top text-ink-2">{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {t.rows.length > 40 && <div className="px-4 py-1.5 text-xs text-muted">{tr('Showing first 40 of {n} rows', { n: t.rows.length.toLocaleString() })}</div>}
        </div>
      ))}
    </div>
  );
}


