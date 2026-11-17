import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactFlow, {
  Background, BaseEdge, ControlButton, Controls, MiniMap, MarkerType, Position, Handle,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { AlertTriangle, ArrowLeftRight, ExternalLink, Maximize2, Minimize2, Scale, X, Tag } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { Icon } from '@/config/icons';
import { IMPACT_COLUMNS, DOMAIN_ICON, DOMAIN_HEX as DOMAIN_COLOUR, type ImpactDomain } from '@/services/regImpact';
import { useImpactGraph, type ImpactApiNode, type ImpactGraph } from '@/services/regImpactApi';
import { MetricCard, Section, Avatar, type MetricTone } from '@/components/ui/primitives';
import { BarList, Donut, StackedBar } from '@/components/ui/charts';
import { cn } from '@/utils/ui';
import { useUi } from '@/app/store/ui';
import { tx, useT } from '@/i18n';

/**
 * Regulation impact — the propagation hierarchy.
 *
 * The regulation does not touch every entity directly. It lands on a process,
 * which uses a system, which stores data governed by a policy proved by
 * evidence. Those entity-to-entity edges ARE the impact: without them this is a
 * star diagram that says nothing about how an obligation travels.
 *
 * Layout notes:
 *   • eight domain columns in one row spans ~2000px and can never fit a pane,
 *     so they wrap into two bands of four — the left-to-right story survives
 *   • selecting a node highlights its whole upstream AND downstream path, which
 *     is the question a reviewer actually asks ("what else does this touch?")
 *   • the badge is the downstream count, so load-bearing nodes are visible
 *     before you click anything
 *   • the regulation does not draw a line to every record it reaches: one line
 *     runs along each band's column headers (down a single spine to the second
 *     band), and each column has a rail down its left edge with a short branch
 *     into each record reached directly. Forty records read as a tree, not as
 *     forty crossing curves
 *   • a long column shows its first six records and a "+N more" button
 */
// Impact type is not a compliance status, so it must not borrow the status reds
// and ambers: direct is brand blue, indirect violet, potential light slate.
const TYPE_COLOR: Record<string, string> = { Direct: '#2563eb', Indirect: '#8b5cf6', Potential: '#94a3b8' };
/** RISK_MANAGEMENT → "Risk management": raw codes read as words in node subtitles. */
const words = (s: string) => {
  // short all-caps acronyms (SOP, KPI, HIS) are left alone
  if (!s.includes('_') && !/^[A-Z][A-Z0-9 ]{4,}$/.test(s)) return s;
  const t = s.replace(/_/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
/** One colour per domain — column header, node stripe, legend, bar and minimap all agree. */
const DOMAIN_HEX: Record<string, string> = DOMAIN_COLOUR;
const domainHex = (d: string) => DOMAIN_HEX[d] ?? '#64748b';
/** the same hues, darkened until text on white (or white on them) passes AA */
const DOMAIN_INK: Record<string, string> = {
  departments: '#6d28d9', processes: '#4338ca', systems: '#1d4ed8', data: '#0f766e', policies: '#a16207',
  controls: '#047857', risks: '#b91c1c', evidence: '#be123c', people: '#15803d',
};
const domainInk = (d: string) => DOMAIN_INK[d] ?? '#475569';
const domainLabel = (d: string) => IMPACT_COLUMNS.find((c) => c.domain === d)?.label ?? words(d);
/** impact level keeps its one meaning: Critical red, High orange, Medium amber, Low slate */
const LEVEL_HEX: Record<string, string> = { Critical: '#dc2626', High: '#ea580c', Medium: '#f59e0b', Low: '#94a3b8' };
const LEVEL_INK: Record<string, string> = { Critical: '#b91c1c', High: '#c2410c', Medium: '#b45309', Low: '#64748b' };
const LEVEL_TONE: Record<string, MetricTone> = { Critical: 'red', High: 'orange', Medium: 'amber', Low: 'gray' };

// W node width · COL_START first column · COL_W column pitch (the 40px gap holds the rail)
// HEAD_H column header height · FIRST_GAP header to first record · CAP records shown per column
const PER_BAND = 4, W = 196, COL_START = 264, COL_W = 236, ROW_H = 84, HEAD_H = 28, FIRST_GAP = 20,
  BAND_GAP = 64, CAP = 6, SPINE = 230, RAIL = 18;
const LEVELS = ['All', 'Critical', 'High', 'Medium', 'Low'] as const;

/** The impact graph as a page (/regulation/:id/impact), or inside another page with `embedId`. */
export function RegulationImpactPage({ embedId, onChangeRegulation }: { embedId?: string; onChangeRegulation?: () => void } = {}) {
  // `t` below is each impact type in the toolbar, so the translate function is `tr` here
  const tr = useT();
  const params = useParams();
  const id = embedId ?? params.id ?? '';
  const navigate = useNavigate();
  const [minConf, setMinConf] = useState(0.6);
  const [domain, setDomain] = useState('all');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('All');
  const [showLabels, setShowLabels] = useState(true);
  const [selected, setSelected] = useState<string>('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const { data, isLoading, error } = useImpactGraph(id, minConf);

  const onSelect = useCallback((nid: string) => setSelected((s) => (s === nid ? '' : nid)), []);
  const onMore = useCallback((d: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(d)) next.delete(d); else next.add(d);
    return next;
  }), []);
  // full view: the graph over the whole window, every band in sight; Esc or the button closes it
  const [full, setFull] = useState(false);
  // the regulation box's Change button opens the page's regulation picker (leaving full view, which would cover it)
  const onChangeReg = useMemo(() => (onChangeRegulation ? () => { setFull(false); onChangeRegulation(); } : undefined), [onChangeRegulation]);
  const { nodes, edges, fit, extent } = useMemo(
    () => build(data, { domain, level, showLabels, selected, onSelect, open, onMore, onChangeReg }),
    [data, domain, level, showLabels, selected, onSelect, open, onMore, onChangeReg]);

  const rf = useRef<ReactFlowInstance | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  useEffect(() => {
    // after the box has its new size: everything in full view, the first band otherwise
    const t = window.setTimeout(() => rf.current?.fitView(
      full ? { padding: 0.04, maxZoom: 1 } : { padding: 0.06, maxZoom: 1, nodes: fitRef.current }), 60);
    return () => window.clearTimeout(t);
  }, [full]);

  const node = data?.nodes?.find((n) => n.id === selected) ?? null;
  const toolbar = data && (
          <span className="flex min-w-0 items-center gap-2.5">
            <Scale className="h-4 w-4 shrink-0 text-muted-2" />
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-bold leading-tight tracking-tight text-ink"
                    title={data.regulation.title}>
                {data.regulation.title}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 text-[11.5px] leading-tight text-muted">
                <b className="text-ink-2">{data.regulation.regulator_short}</b>
                <span>{data.regulation.regulation_type}</span>
                <span><b className="tabular-nums text-ink-2">{data.totals.entities}</b> {tr('entities')}</span>
                <span><b className="tabular-nums text-ink-2">{data.totals.propagation}</b> {tr('propagation links')}</span>
                {([tx('Direct'), tx('Indirect'), tx('Potential')] as const).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5">
                    <i className="inline-block h-2 w-3.5 rounded-sm" style={{ background: TYPE_COLOR[t] }} />
                    {tr(t)} {data.totals[t.toLowerCase() as 'direct']}
                  </span>
                ))}
              </span>
            </span>
          </span>
        );
  const actions = data && (
          <>
            {selected && (
              <button onClick={() => setSelected('')} className="btn btn-sm">{tr('Clear path')}</button>
            )}
            <select className="input h-8 w-[9.5rem] text-[12.5px]" value={domain}
                    aria-label={tr('Filter by domain')}
                    onChange={(e) => setDomain(e.target.value)}>
              <option value="all">{tr('All domains')}</option>
              {IMPACT_COLUMNS.map((c) => (
                <option key={c.domain} value={c.domain}>
                  {tr(c.label)}{data.byDomain[c.domain] ? ` (${data.byDomain[c.domain]})` : ''}
                </option>
              ))}
            </select>
            <select className="input h-8 w-[8rem] text-[12.5px]" value={level}
                    aria-label={tr('Filter by impact level')}
                    onChange={(e) => setLevel(e.target.value as typeof level)}>
              {LEVELS.map((l) => <option key={l} value={l}>{l === 'All' ? tr('All levels') : tr(l)}</option>)}
            </select>
            <select className="input h-8 w-[10rem] text-[12.5px]" value={minConf}
                    aria-label={tr('Minimum match confidence')}
                    onChange={(e) => setMinConf(Number(e.target.value))}>
              <option value={0}>{tr('All matches')}</option>
              <option value={0.6}>{tr('Confidence ≥ 0.6')}</option>
              <option value={0.85}>{tr('Direct only')}</option>
            </select>
            <button onClick={() => setShowLabels((v) => !v)}
                    aria-pressed={showLabels}
                    className={cn('btn btn-sm h-8', showLabels && 'border-brand-200 bg-brand-50 text-brand-700')}
                    title={tr('Show relationship labels on the selected path')}>
              <Tag className="h-3.5 w-3.5" /> {tr('Labels')}
            </button>
            <button onClick={() => setFull(true)} className="btn btn-sm h-8" title={tr('Full view')}>
              <Maximize2 className="h-3.5 w-3.5" /> {tr('Full view')}
            </button>
          </>
        );

  return (
    <>
      {/*
        The graph's own controls used to sit in the Topbar's action slot, where
        they competed with global search, the company badge and the user menu —
        four selects squeezed the regulation title down to "M…". They belong on
        the toolbar row below, which is about this graph and nothing else.
      */}
      {embedId ? (
        <div className="card mb-3 flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">{toolbar}</div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      ) : <Topbar
        title="Regulation impact"
        subtitle="How this regulation propagates through the company, and on what evidence"
        icon="GitBranch" tone="#2563eb"
        onBack={() => navigate(`/regulation/${id}`)} backLabel="Back to the regulation"
        // One line: on a graph screen, three lines of header is canvas taken
        // from the thing the page exists to show. The subtitle's explanation
        // lives in the footer note under the graph instead.
        dense
        toolbar={toolbar}
        actions={actions}
      />}

      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading && <div className="p-8 text-center text-[13px] text-muted">{tr('Building the propagation graph…')}</div>}
        {error && (
          <div className="card m-6 flex items-center gap-3 p-4 text-[13px] text-critical-600">
            <AlertTriangle className="h-4 w-4" /> {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <ImpactSummary data={data} domain={domain} onDomain={(d) => setDomain(domain === d ? 'all' : d)} />
            {data.totals.entities > 0 && (
              <Legend data={data} domain={domain} onDomain={(d) => setDomain(domain === d ? 'all' : d)} />
            )}
            {data.totals.entities === 0 ? (
              <div className="card m-6 py-16 text-center">
                <div className="text-sm font-semibold text-ink">{tr('No company entities matched')}</div>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted">
                  {tr("Nothing in the Company Brain matches this regulation's obligations at this threshold. Nothing is invented to fill the graph.")}
                </p>
              </div>
            ) : (
              // React Flow fills its box, so the box needs a real height. On its own page the
              // box stretches inside a fixed-height column; inside the Impact Cascade tab
              // nothing around it has a height, so it gets one of its own. Full view covers the window.
              <div className={cn('flex flex-col overflow-hidden bg-white',
                                 full ? 'fixed inset-0 z-[70]'
                                   : cn('relative mb-4 rounded-card border border-line shadow-card',
                                        embedId ? 'h-[72vh] min-h-[560px]' : 'mx-6 min-h-[600px] flex-1'))}
                   role={full ? 'dialog' : undefined} aria-modal={full || undefined}
                   aria-label={full ? data.regulation.title : undefined}>
                {full && (
                  <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5">
                    <div className="min-w-0 flex-1">{toolbar}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      {selected && (
                        <button onClick={() => setSelected('')} className="btn btn-sm">{tr('Clear path')}</button>
                      )}
                      <button onClick={() => setFull(false)} className="btn btn-sm h-8" autoFocus>
                        <Minimize2 className="h-3.5 w-3.5" /> {tr('Exit full view')}
                      </button>
                    </div>
                  </div>
                )}
                <div className="relative min-h-0 flex-1">
                  <ReactFlow
                    nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
                    onInit={(inst) => { rf.current = inst; }}
                    // open on the first band at a readable size; the wheel scrolls down to the second
                    fitView fitViewOptions={{ padding: 0.06, maxZoom: 1, nodes: fit }}
                    panOnScroll translateExtent={extent}
                    minZoom={0.2} maxZoom={1.75} proOptions={{ hideAttribution: true }}
                    onPaneClick={() => setSelected('')}
                  >
                    <Background color="#e6e8f1" gap={22} />
                    <Controls showInteractive={false}>
                      <ControlButton onClick={() => setFull((v) => !v)} title={full ? tr('Exit full view') : tr('Full view')}
                                     aria-label={full ? tr('Exit full view') : tr('Full view')}>
                        {full ? <Minimize2 /> : <Maximize2 />}
                      </ControlButton>
                    </Controls>
                    <MiniMap
                      pannable zoomable
                      nodeColor={(n) => {
                        const d = (n.data as { node?: ImpactApiNode }).node?.domain;
                        return d ? domainHex(d) : n.type === 'change' ? '#2563eb' : '#e2e8f0';
                      }}
                      className="!bottom-3 !right-3 !h-20 !w-32 overflow-hidden rounded-lg border border-line !bg-white shadow-pop"
                    />
                  </ReactFlow>
                  {node && <Inspector node={node} graph={data} onClose={() => setSelected('')} onSelect={onSelect} />}
                </div>
              </div>
            )}

            <p className="border-t border-line bg-surface px-6 py-2 text-[11.5px] text-muted-2">{data.note}</p>
          </>
        )}
      </div>
    </>
  );
}

/* ---------------- layout ---------------- */
type Opts = {
  domain: string; level: string; showLabels: boolean; selected: string; onSelect: (id: string) => void;
  open: Set<string>; onMore: (domain: string) => void;
  /** set when the page can switch regulation: draws a Change button on the regulation box */
  onChangeReg?: () => void;
};

function build(data: ImpactGraph | undefined, o: Opts) {
  if (!data?.nodes || !data?.edges) {
    return { nodes: [] as Node[], edges: [] as Edge[], fit: [] as { id: string }[], extent: undefined };
  }

  const typeRank: Record<string, number> = { Direct: 0, Indirect: 1, Potential: 2 };
  const propagation = data.edges.filter((e) => e.kind === 'propagation');

  // upstream + downstream reachability from the selected node — "what else does
  // this touch?" is the question, and it is not answered by one hop
  const parents = new Map<string, string[]>(), children = new Map<string, string[]>();
  propagation.forEach((e) => {
    (children.get(e.source) ?? children.set(e.source, []).get(e.source)!).push(e.target);
    (parents.get(e.target) ?? parents.set(e.target, []).get(e.target)!).push(e.source);
  });
  const walk = (start: string, m: Map<string, string[]>) => {
    const seen = new Set<string>(), st = [start];
    while (st.length) {
      const c = st.pop()!;
      (m.get(c) ?? []).forEach((n) => { if (!seen.has(n)) { seen.add(n); st.push(n); } });
    }
    return seen;
  };
  const hi = o.selected ? new Set([o.selected, ...walk(o.selected, parents), ...walk(o.selected, children)]) : null;

  const pass = (n: ImpactApiNode) =>
    (o.level === 'All' || n.impactLevel === o.level) && (o.domain === 'all' || n.domain === o.domain);
  const linked = new Set(propagation.flatMap((e) => [e.source, e.target]));
  const hasParent = new Set(propagation.map((e) => e.target));

  // each column: records that pass the duty on first (they carry the story), then
  // direct before indirect, then the most depended-on; a long column is cut at CAP
  const cols = IMPACT_COLUMNS.filter((c) => data.nodes.some((n) => n.domain === c.domain)).map((c, ci) => {
    const all = data.nodes.filter((n) => n.domain === c.domain).sort((a, b) =>
      Number(linked.has(b.id)) - Number(linked.has(a.id))
      || typeRank[a.impactType] - typeRank[b.impactType]
      || b.downstream - a.downstream || b.confidence - a.confidence);
    const open = o.open.has(c.domain);
    const shown = open || all.length <= CAP ? all : [...all.slice(0, CAP), ...all.slice(CAP).filter((n) => hi?.has(n.id))];
    return { c, ci, band: Math.floor(ci / PER_BAND), x: COL_START + (ci % PER_BAND) * COL_W, all, shown, open, more: all.length > CAP,
             placed: [] as { n: ImpactApiNode; row: number }[] };
  });

  // rows: a linked record goes on the row of the record it links to (when that one is
  // already placed, column by column), so the link runs straight across instead of crossing others
  const near = new Map<string, string[]>();
  propagation.forEach((e) => {
    (near.get(e.source) ?? near.set(e.source, []).get(e.source)!).push(e.target);
    (near.get(e.target) ?? near.set(e.target, []).get(e.target)!).push(e.source);
  });
  const rowOf = new Map<string, number>();
  cols.forEach((k) => {
    const want = (n: ImpactApiNode) => {
      const r = (near.get(n.id) ?? []).map((m) => rowOf.get(m)).filter((v): v is number => v != null);
      return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
    };
    const keyed = k.shown.map((n, i) => ({ n, i, w: want(n) }))
      .sort((a, b) => (a.w ?? 1e9) - (b.w ?? 1e9) || a.i - b.i);
    let next = 0;
    keyed.forEach(({ n, w }) => {
      // a gap of up to two rows is worth a straight line; more and the column falls apart
      const row = w != null && Math.round(w) - next <= 2 ? Math.max(next, Math.round(w)) : next;
      next = row + 1;
      rowOf.set(n.id, row);
      k.placed.push({ n, row });
    });
  });
  const lastRow = (k: (typeof cols)[number]) => (k.placed.length ? k.placed[k.placed.length - 1].row : -1);

  const bands = Math.max(1, ...cols.map((k) => k.band + 1));
  const rows = (b: number) => Math.max(1, ...cols.filter((k) => k.band === b).map((k) => lastRow(k) + 1 + (k.more ? 1 : 0)));
  const top: number[] = [];
  let y = 0;
  for (let b = 0; b < bands; b++) { top.push(y); y += HEAD_H + FIRST_GAP + rows(b) * ROW_H + BAND_GAP; }
  const rowY = (b: number, i: number) => top[b] + HEAD_H + FIRST_GAP + i * ROW_H;

  // the regulation sits level with the first band's headers, so its line runs straight along them
  const ns: Node[] = [{ id: '__reg__', type: 'change', position: { x: 0, y: 0 },
                        data: { reg: data.regulation, status: data.changeStatus, totals: data.totals, onChange: o.onChangeReg }, draggable: false }];
  const where = new Map<string, { ci: number; band: number; x: number; y: number }>();
  cols.forEach((k) => {
    ns.push({
      id: `h-${k.c.domain}`, type: 'colhead', position: { x: k.x, y: top[k.band] },
      data: { header: k.c.label, domain: k.c.domain, count: k.all.length }, draggable: false, selectable: false,
    });
    k.placed.forEach(({ n, row }) => {
      where.set(n.id, { ci: k.ci, band: k.band, x: k.x, y: rowY(k.band, row) });
      ns.push({
        id: n.id, type: 'entity', position: { x: k.x, y: rowY(k.band, row) },
        data: { node: n, dim: (hi ? !hi.has(n.id) : false) || !pass(n),
                selected: o.selected === n.id, onClick: () => o.onSelect(n.id) },
        draggable: false,
      });
    });
    if (k.more) {
      ns.push({
        id: `more-${k.c.domain}`, type: 'more', position: { x: k.x, y: rowY(k.band, lastRow(k) + 1) },
        data: { n: k.all.length - k.shown.length, open: k.open, onClick: () => o.onMore(k.c.domain) },
        draggable: false, selectable: false,
      });
    }
  });

  const es: Edge[] = [];
  cols.forEach((k) => {
    const hex = domainHex(k.c.domain);
    const direct = k.shown.filter((n) => !hasParent.has(n.id));
    if (!direct.length) return;
    // regulation → column header: one line per column, all sharing one route
    const busOn = !!hi && direct.some((n) => hi.has(n.id));
    es.push({
      id: `bus-${k.c.domain}`, source: '__reg__', sourceHandle: 'r', target: `h-${k.c.domain}`, targetHandle: 'in',
      type: 'tree', data: { via: SPINE }, animated: busOn,
      style: { stroke: busOn ? '#2563eb' : '#a5b4fc', strokeWidth: busOn ? 2.5 : 2, opacity: hi && !busOn ? 0.15 : 1 },
    });
    // header → each record reached directly: a rail down the column's left edge
    direct.forEach((n) => {
      const on = !!hi && hi.has(n.id);
      es.push({
        id: `rail-${n.id}`, source: `h-${k.c.domain}`, sourceHandle: 'rail', target: n.id, targetHandle: 'l',
        type: 'tree', data: { via: k.x - RAIL }, animated: on,
        style: { stroke: hex, strokeWidth: on ? 2.25 : 1.5, opacity: hi ? (on ? 1 : 0.1) : pass(n) ? 0.6 : 0.18 },
      });
    });
    if (k.more) {
      es.push({
        id: `rail-more-${k.c.domain}`, source: `h-${k.c.domain}`, sourceHandle: 'rail', target: `more-${k.c.domain}`, targetHandle: 'l',
        type: 'tree', data: { via: k.x - RAIL },
        style: { stroke: hex, strokeWidth: 1.5, strokeDasharray: '3 4', opacity: hi ? 0.1 : 0.5 },
      });
    }
  });
  // record → record: the propagation itself, routed so no line hides behind a box:
  //   next column      → a curve across the gap
  //   back one column  → left edge to the other's right edge
  //   same column      → a bracket down the right side
  //   further, or into the other band → along the gap above the target's row ("lane")
  propagation.filter((e) => where.has(e.source) && where.has(e.target)).forEach((e) => {
    const s = where.get(e.source)!, tg = where.get(e.target)!;
    const same = s.ci === tg.ci, sameBand = s.band === tg.band;
    const back = !same && sameBand && tg.ci < s.ci;
    const lane = !same && (!sameBand || Math.abs(tg.ci - s.ci) >= 2);
    const onPath = hi ? hi.has(e.source) && hi.has(e.target) : false;
    const color = TYPE_COLOR[e.impactType ?? 'Indirect'];
    es.push({
      id: `p-${e.source}-${e.target}`, source: e.source, target: e.target,
      sourceHandle: back ? 'ls' : 'r', targetHandle: same || back ? 'rt' : 'l',
      type: same ? 'tree' : lane ? 'lane' : 'default',
      data: same ? { via: s.x + W + 12 }
        : lane ? (back ? { x1: s.x - 6, lane: tg.y - 10, x2: tg.x + W + 6 } : { x1: s.x + W + 6, lane: tg.y - 10, x2: tg.x - 6 })
        : undefined,
      // labels only along the highlighted path: on every edge they bury the graph
      label: o.showLabels && onPath ? e.relationship.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase()) : undefined,
      animated: onPath,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
      style: { stroke: color, strokeWidth: onPath ? 2.25 : 1.75, opacity: hi && !onPath ? 0.1 : 1 },
      labelStyle: { fontSize: 11, fontWeight: 500, fill: '#475569' },
      labelBgStyle: { fill: '#fff', fillOpacity: 0.9 }, labelBgPadding: [3, 1],
    });
  });

  const fit = (bands > 1 ? ns.filter((n) => n.position.y < top[1]) : ns).map((n) => ({ id: n.id }));
  // panning stops a screen's width past the graph, so it cannot be lost — and stays
  // wide enough for a zoomed-out view to sit centred instead of pinned to the left
  const extent: [[number, number], [number, number]] = [[-1200, -600], [COL_START + PER_BAND * COL_W + 1200, y - BAND_GAP + 600]];
  return { nodes: ns, edges: es, fit, extent };
}

/** A path through the given corner points, each corner rounded. */
function roundedPath(pts: [number, number][], r = 10) {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.5);
  let d = `M ${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], [cx, cy] = p[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L ${bx - ((bx - ax) / l1) * rr},${by - ((by - ay) / l1) * rr} Q ${bx},${by} ${bx + ((cx - bx) / l2) * rr},${by + ((cy - by) / l2) * rr}`;
  }
  const last = p[p.length - 1];
  return `${d} L ${last[0]},${last[1]}`;
}

type LabelProps = Pick<EdgeProps, 'label' | 'labelStyle' | 'labelBgStyle' | 'labelBgPadding' | 'markerEnd' | 'style'>;
const labelOf = (p: LabelProps) => ({
  label: p.label, labelStyle: p.labelStyle, labelBgStyle: p.labelBgStyle, labelBgPadding: p.labelBgPadding,
  labelShowBg: true, markerEnd: p.markerEnd, style: p.style,
});

/** Turns once, at x = via: the regulation's spine, the column rails, a same-column bracket. */
function TreeEdge(p: EdgeProps<{ via: number }>) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = p;
  const via = p.data?.via ?? (sx + tx) / 2;
  const path = Math.abs(ty - sy) < 4 ? `M ${sx},${sy} L ${tx},${ty}`
    : roundedPath([[sx, sy], [via, sy], [via, ty], [tx, ty]]);
  return <BaseEdge path={path} labelX={via} labelY={(sy + ty) / 2} {...labelOf(p)} />;
}

/** Out to x1, along the gap at y = lane, down at x2: a link that would otherwise run behind other boxes. */
function LaneEdge(p: EdgeProps<{ x1: number; lane: number; x2: number }>) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = p;
  const { x1, lane, x2 } = p.data ?? { x1: sx, lane: sy, x2: tx };
  const path = roundedPath([[sx, sy], [x1, sy], [x1, lane], [x2, lane], [x2, ty], [tx, ty]]);
  return <BaseEdge path={path} labelX={(x1 + x2) / 2} labelY={lane} {...labelOf(p)} />;
}
const EDGE_TYPES = { tree: TreeEdge, lane: LaneEdge };


/* ---------------- nodes ---------------- */
/** connection points are invisible: the lines say where they join */
const HIDE = '!h-1 !min-h-0 !w-1 !min-w-0 !border-0 !bg-transparent';
function SideHandles() {
  return (
    <>
      <Handle id="l" type="target" position={Position.Left} className={HIDE} />
      <Handle id="r" type="source" position={Position.Right} className={HIDE} />
      <Handle id="ls" type="source" position={Position.Left} className={HIDE} />
      <Handle id="rt" type="target" position={Position.Right} className={HIDE} />
    </>
  );
}

function ColHead({ data }: NodeProps<{ header: string; domain?: string; count?: number }>) {
  const t = useT();
  const hex = data.domain ? domainHex(data.domain) : '#2563eb';
  const ink = data.domain ? domainInk(data.domain) : '#1d4ed8';
  return (
    <div className="flex h-7 w-[196px] items-center gap-1.5 rounded-lg px-2.5"
         style={{ background: `color-mix(in srgb, ${hex} 12%, white)`, color: ink }}>
      <Handle id="in" type="target" position={Position.Left} className={HIDE} />
      <Handle id="rail" type="source" position={Position.Left} className={HIDE} />
      <Icon name={data.domain ? DOMAIN_ICON[data.domain as ImpactDomain] ?? 'CircleDot' : 'Scale'} className="h-3.5 w-3.5" />
      <span className="text-xs font-semibold">{t(words(data.header))}</span>
      {data.count != null && (
        <span className="ml-auto rounded-md px-1.5 text-xs font-bold tabular-nums text-white" style={{ background: ink }}>{data.count}</span>
      )}
    </div>
  );
}

function ChangeNode({ data }: NodeProps<{ reg: ImpactGraph['regulation']; status: ImpactGraph['changeStatus']; totals: ImpactGraph['totals']; onChange?: () => void }>) {
  const t = useT();
  return (
    <div className="w-[196px] overflow-hidden rounded-card border-2 border-brand-500 bg-white shadow-pop">
      <div className="flex items-center gap-1.5 bg-gradient-to-r from-brand-600 to-indigo-600 px-3 py-1.5 text-white">
        <Scale className="h-3.5 w-3.5" />
        <span className="text-[11px] font-bold">{data.reg.regulator_short}</span>
        <span className="ml-auto text-[11px] font-semibold tabular-nums text-white/85">{t('{n} reached', { n: data.totals.entities.toLocaleString() })}</span>
      </div>
      <div className="px-3 py-2">
        <div className="line-clamp-4 text-[11.5px] font-semibold leading-snug text-ink">{data.reg.title}</div>
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-1.5 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate">{data.status.status.replace(/_/g, ' ').toLowerCase()}</span>
          {data.onChange && (
            // same as the cascade's regulation box: opens the picker to switch regulation
            <button type="button" title={t('Change regulation')}
                    onClick={(e) => { e.stopPropagation(); data.onChange?.(); }}
                    className="nodrag nopan inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_2px_6px_rgba(0,113,227,0.35)] transition hover:bg-brand-700 active:scale-95">
              <ArrowLeftRight className="h-3 w-3" />{t('Change')}
            </button>
          )}
        </div>
      </div>
      {/* level with the column headers (28px tall), so the line along them runs straight */}
      <Handle id="r" type="source" position={Position.Right} style={{ top: 14 }} className="!h-2 !w-2 !border-0 !bg-brand-500" />
    </div>
  );
}

function MoreNode({ data }: NodeProps<{ n: number; open: boolean; onClick: () => void }>) {
  const t = useT();
  return (
    <button type="button" onClick={data.onClick}
            className="nodrag w-[196px] rounded-card border border-dashed border-line-2 bg-white px-3 py-1.5 text-left text-[11.5px] font-semibold text-brand-700 transition hover:border-brand-300 hover:bg-brand-50">
      <Handle id="l" type="target" position={Position.Left} className={HIDE} />
      {data.open ? t('Show fewer') : t('+{n} more', { n: data.n.toLocaleString() })}
    </button>
  );
}

function EntityNode({ data }: NodeProps<{ node: ImpactApiNode; dim: boolean; selected: boolean; onClick: () => void }>) {
  const t = useT();
  const n = data.node;
  const hex = domainHex(n.domain);
  return (
    <div
      onClick={data.onClick}
      className={cn('w-[196px] cursor-pointer rounded-card border bg-white py-1.5 pl-2 pr-2.5 shadow-sm transition',
        data.selected ? 'border-brand-500 ring-2 ring-brand-200' : 'border-line hover:border-brand-300 hover:shadow-pop')}
      style={{ opacity: data.dim ? 0.22 : 1, borderLeft: `4px solid ${hex}` }}
    >
      <SideHandles />
      <div className="flex items-center gap-1.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md" style={{ background: `${hex}1f`, color: domainInk(n.domain) }}>
          <Icon name={DOMAIN_ICON[n.domain] ?? 'CircleDot'} className="h-3 w-3" />
        </span>
        <span className="truncate text-[11.5px] font-semibold text-ink">{n.name}</span>
        {n.downstream > 0 && (
          <span title={t('{n} entities depend on this', { n: n.downstream.toLocaleString() })}
                className="ml-auto shrink-0 rounded px-1 text-[11px] font-bold text-white" style={{ background: domainInk(n.domain) }}>
            {n.downstream}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
        <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_COLOR[n.impactType] }} title={t('{type} impact', { type: t(n.impactType) })} />
        <span className="truncate">{words(n.type || n.domain)}</span>
        {n.impactLevel && (
          <span className="shrink-0 font-semibold" style={{ color: LEVEL_INK[n.impactLevel] ?? '#64748b' }}>{t(n.impactLevel)}</span>
        )}
        <span className="ml-auto tabular-nums text-muted">{(n.confidence * 100).toFixed(0)}%</span>
      </div>
      {n.owner && <div className="truncate text-[11px] text-muted">{n.owner}</div>}
    </div>
  );
}

/* ---------------- summary above the graph ---------------- */

/**
 * The numbers behind the graph, read off the same response: how many records
 * the regulation reaches and how, which domains carry it, how hard it lands,
 * and who has to act. Nothing here is fetched separately.
 */
function ImpactSummary({ data, domain, onDomain }: { data: ImpactGraph; domain: string; onDomain: (d: string) => void }) {
  // `t` below is the totals object, so the translate function is `tr` here
  const tr = useT();
  const t = data.totals;
  const share = (n: number) => (t.entities > 0 ? Math.round((n / t.entities) * 100) : undefined);

  const domains = IMPACT_COLUMNS
    .map((c) => ({ domain: c.domain, label: c.label, n: data.byDomain[c.domain] ?? data.nodes.filter((x) => x.domain === c.domain).length }))
    .concat(Object.keys(data.byDomain).filter((d) => !IMPACT_COLUMNS.some((c) => c.domain === d))
      .map((d) => ({ domain: d as ImpactDomain, label: words(d), n: data.byDomain[d] })))
    .filter((d) => d.n > 0)
    .sort((a, b) => b.n - a.n);

  const levels = ['Critical', 'High', 'Medium', 'Low'].map((l) => ({
    label: tr(l), value: data.nodes.filter((n) => n.impactLevel === l).length, color: LEVEL_HEX[l],
  })).filter((l) => l.value > 0);

  const owned = data.nodes.filter((n) => n.owner).length;
  const owners = Object.entries(data.nodes.reduce<Record<string, number>>((m, n) => {
    if (n.owner) m[n.owner] = (m[n.owner] ?? 0) + 1;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4);

  const score = data.score;
  return (
    <div className="space-y-4 px-6 pb-4 pt-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard label={tr('Records reached')} value={t.entities.toLocaleString()} tone="brand" icon="Network"
                    foot={tr('{n} propagation links', { n: t.propagation.toLocaleString() })} />
        <MetricCard label={tr('Direct')} value={t.direct.toLocaleString()} tone="brand" icon="Target" pct={share(t.direct)}
                    foot={tr('named in a clause')} />
        <MetricCard label={tr('Indirect')} value={t.indirect.toLocaleString()} tone="purple" icon="GitBranch" pct={share(t.indirect)}
                    foot={tr('via another record')} />
        <MetricCard label={tr('Potential')} value={t.potential.toLocaleString()} tone="gray" icon="CircleDot" pct={share(t.potential)}
                    foot={tr('partial match')} />
        <MetricCard label={tr('Impact score')} value={score ? `${score.score}` : '—'}
                    tone={score ? LEVEL_TONE[score.level] ?? 'gray' : 'gray'} icon="Gauge"
                    foot={score ? (LEVEL_TONE[score.level] ? tr('{level} · out of 100', { level: tr(score.level) }) : tr('out of 100')) : tr('not scored yet')} />
      </div>

      {t.entities > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Section title={tr('Records reached by domain')} icon="Layers" tone="purple"
                   action={domain !== 'all' && (
                     <button type="button" onClick={() => onDomain(domain)} className="text-xs font-medium text-brand-600 hover:underline">
                       {tr('Show all')}
                     </button>
                   )}>
            <BarList data={domains.map((d) => ({
              label: tr(d.label), value: d.n, color: domainHex(d.domain), onClick: () => onDomain(d.domain),
            }))} />
          </Section>

          <Section title={tr('How hard it lands')} icon="Flame" tone="red">
            {levels.length ? (
              <Donut data={levels} size={128} thickness={18} center={t.entities.toLocaleString()} sub={tr('records')} />
            ) : <p className="py-6 text-center text-[12.5px] text-muted">{tr('No impact level recorded on these records.')}</p>}
          </Section>

          <Section title={tr('Who has to act')} icon="UserCheck" tone="green">
            <StackedBar height={10} data={[
              { label: tr('Owner recorded'), value: owned, color: '#16a34a' },
              { label: tr('No owner'), value: t.entities - owned, color: '#f97316' },
            ]} />
            {owners.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {owners.map(([name, n]) => (
                  <li key={name} className="flex items-center gap-2.5 text-[13px]">
                    <Avatar name={name} size={26} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
                    <span className="font-semibold tabular-nums text-ink">{n}</span>
                    <span className="text-xs text-muted">{n === 1 ? tr('record') : tr('records')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[12.5px] text-warning-700">{tr('None of the reached records has an owner recorded.')}</p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

/** Domain colours and edge types, in one strip above the graph. A domain chip filters the graph. */
function Legend({ data, domain, onDomain }: { data: ImpactGraph; domain: string; onDomain: (d: string) => void }) {
  const t = useT();
  const present = IMPACT_COLUMNS.filter((c) => data.nodes.some((n) => n.domain === c.domain));
  return (
    <div className="mx-6 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <span className="font-semibold text-muted">{t('Domains')}</span>
      {present.map((c) => {
        const on = domain === c.domain;
        const hex = domainHex(c.domain);
        const ink = domainInk(c.domain);
        return (
          <button key={c.domain} type="button" onClick={() => onDomain(c.domain)} aria-pressed={on}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition',
                    on ? 'text-white' : 'border-line bg-white text-ink-2 hover:border-line-2')}
                  style={on ? { background: ink, borderColor: ink } : undefined}>
            <span className="grid h-4 w-4 place-items-center rounded" style={on ? undefined : { background: `${hex}1f`, color: ink }}>
              <Icon name={DOMAIN_ICON[c.domain] ?? 'CircleDot'} className="h-3 w-3" />
            </span>
            {t(domainLabel(c.domain))}
            <span className="tabular-nums opacity-80">{data.nodes.filter((n) => n.domain === c.domain).length}</span>
          </button>
        );
      })}
      <span className="ml-auto inline-flex flex-wrap items-center gap-3 text-muted">
        {/* the dot on each record is how it is reached */}
        {(['Direct', 'Indirect', 'Potential'] as const).map((tp) => (
          <span key={tp} className="inline-flex items-center gap-1.5">
            <i className="h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[tp] }} />
            {t(tp)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="12" aria-hidden="true"><path d="M2 0 V6 Q2 10 6 10 H18" fill="none" stroke="#94a3b8" strokeWidth="1.75" /></svg>
          {t('Reached directly')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="24" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="17" y2="4" stroke={TYPE_COLOR.Indirect} strokeWidth="2" />
            <path d="M16 0.5 L23 4 L16 7.5 Z" fill={TYPE_COLOR.Indirect} />
          </svg>
          {t('Passes the duty on')}
        </span>
      </span>
    </div>
  );
}

const NODE_TYPES = { colhead: ColHead, change: ChangeNode, entity: EntityNode, more: MoreNode };

/* ---------------- inspector ---------------- */
function Inspector({ node, graph, onClose, onSelect }: {
  node: ImpactApiNode; graph: ImpactGraph; onClose: () => void; onSelect: (id: string) => void;
}) {
  const t = useT();
  const openEntity = useUi((s) => s.openEntity);
  const out = graph.edges.filter((e) => e.kind === 'propagation' && e.source === node.id);
  const inc = graph.edges.filter((e) => e.kind === 'propagation' && e.target === node.id);
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;

  // Plain words for the two things the panel used to state as jargon.
  // Each is the whole sentence, one clause and several, so a translation can
  // put the words in its own order.
  const WHY_TYPE: Record<string, [string, string]> = {
    Direct: [tx('This regulation reaches {name} because one of its clauses name this record directly.'),
      tx('This regulation reaches {name} because {n} of its clauses name this record directly.')],
    Indirect: [tx('This regulation reaches {name} because one of its clauses reach it through a record they name.'),
      tx('This regulation reaches {name} because {n} of its clauses reach it through a record they name.')],
    Potential: [tx('This regulation reaches {name} because one of its clauses partially match it — worth checking before acting.'),
      tx('This regulation reaches {name} because {n} of its clauses partially match it — worth checking before acting.')],
  };
  const WHY_OTHER: [string, string] = [tx('This regulation reaches {name} because one of its clauses match this record.'),
    tx('This regulation reaches {name} because {n} of its clauses match this record.')];
  const why = WHY_TYPE[node.impactType] ?? WHY_OTHER;
  const confidence = Math.round(node.confidence * 100);
  const howSure = confidence >= 95 ? tx('the clause contains this record’s full name')
    : confidence >= 80 ? tx('most of this record’s name appears in the clause')
    : tx('a partial name match — confirm before acting');

  return (
    <div className="absolute right-4 top-4 z-10 flex max-h-[calc(100%-2rem)] w-[380px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-xl">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold leading-snug text-ink">{node.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="pill bg-slate-100 text-slate-600">{node.type || node.domain}</span>
            {node.criticality && (
              <span className={cn('pill',
                node.criticality === 'Critical' ? 'bg-critical-50 text-critical-600'
                : node.criticality === 'High' ? 'bg-notcov-50 text-notcov-600'
                : node.criticality === 'Medium' ? 'bg-warning-50 text-warning-600'
                : 'bg-slate-100 text-slate-600')}>
                {t(node.criticality)}
              </span>
            )}
            <span className="pill" style={{ background: `${domainHex(node.domain)}1f`, color: domainInk(node.domain) }}>
              <Icon name={DOMAIN_ICON[node.domain] ?? 'CircleDot'} className="h-3 w-3" />
              {t(domainLabel(node.domain))}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-slate-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
          One sentence answering the question the panel exists for. It replaced
          three separate jargon chips — "Direct", "99%" and the raw matcher
          string — none of which said who is affected or what happens next.
        */}
        <p className="border-b border-line bg-canvas px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
          {node.obligations.length === 1
            ? t(why[0], { name: node.name })
            : t(why[1], { name: node.name, n: node.obligations.length.toLocaleString() })}
          {node.owner
            ? <> {t('{name} is accountable for it.', { name: node.owner })}</>
            : <> <span className="font-medium text-warning-600">{t('No one is recorded as accountable for it.')}</span></>}
        </p>

        {/* WHO ACTS */}
        <section className="border-b border-line px-4 py-3">
          <div className="text-[11px] font-bold tracking-normal text-muted-2">{t('Who has to act')}</div>
          {node.owner ? (
            <div className="mt-1.5 flex items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-[12px] font-bold text-brand-600">
                {node.owner.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink">{node.owner}</span>
                <span className="block text-[11.5px] text-muted">{t('owns this {type}', { type: node.type?.toLowerCase() || node.domain })}</span>
              </span>
            </div>
          ) : (
            <p className="mt-1.5 rounded-lg bg-warning-50 px-2.5 py-2 text-[12px] leading-relaxed text-warning-700">
              {t('This record has no owner, so a change here has nobody to route to. Assign one on the record before relying on this analysis.')}
            </p>
          )}
          {out.length > 0 && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
              {out.length === 1
                ? t('A change here also reaches 1 other record that depend on it — listed below.')
                : t('A change here also reaches {n} other records that depend on it — listed below.', { n: out.length.toLocaleString() })}
            </p>
          )}
        </section>

        {/* WHAT IT REQUIRES — full text, not a truncated fragment */}
        {node.obligations.length > 0 && (
          <section className="border-b border-line px-4 py-3">
            <div className="text-[11px] font-bold tracking-normal text-muted-2">
              {t('What the regulation requires ({n})', { n: node.obligations.length.toLocaleString() })}
            </div>
            <ul className="mt-1.5 space-y-2">
              {node.obligations.slice(0, 8).map((o) => (
                <li key={o.id} className="rounded-lg border border-line bg-canvas px-2.5 py-2">
                  {o.type && (
                    <span className="mb-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                      {o.type}
                    </span>
                  )}
                  {/* Was sliced at 88 characters, which cut clauses mid-word and
                      made the one thing a reviewer needs to read unreadable. */}
                  <p className="text-[12px] leading-relaxed text-ink-2">{o.title || o.id}</p>
                </li>
              ))}
            </ul>
            {node.obligations.length > 8 && (
              <p className="mt-1.5 text-[11.5px] text-muted-2">
                {t('and {n} more — see the Impact tab for the full list', { n: (node.obligations.length - 8).toLocaleString() })}
              </p>
            )}
          </section>
        )}

        {inc.length > 0 && <Chain title={t('Reached via')} items={inc.map((e) => `${name(e.source)} — ${e.relationship.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase())}`)} ids={inc.map((e) => e.source)} onSelect={onSelect} />}
        {out.length > 0 && <Chain title={t('A change here also affects ({n})', { n: out.length.toLocaleString() })} items={out.map((e) => `${name(e.target)} — ${e.relationship.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase())}`)} ids={out.map((e) => e.target)} onSelect={onSelect} />}

        {/* HOW WE KNOW — the match, stated rather than asserted */}
        <section className="px-4 py-3">
          <div className="text-[11px] font-bold tracking-normal text-muted-2">{t('How this was matched')}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <span className="block h-full rounded-full bg-brand-500" style={{ width: `${confidence}%` }} />
            </span>
            <span className="shrink-0 text-[12px] font-semibold tabular-nums text-ink-2">{confidence}%</span>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
            {t(howSure)}. {t('Matching is keyword-based, not a legal reading — the clause above is the evidence, and a wrong match should be rejected rather than actioned.')}
          </p>
        </section>
      </div>

      <div className="border-t border-line p-3">
        <button onClick={() => node.entityId && openEntity(node.entityId)} className="btn btn-sm btn-primary w-full justify-center">
          {t('Open this record')} <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Chain({ title, items, ids, onSelect }: { title: string; items: string[]; ids: string[]; onSelect: (id: string) => void }) {
  // Sits inside the panel's scroll column, so it carries the same section
  // padding and rule as its siblings rather than a bare top margin.
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="text-[11px] font-bold tracking-normal text-muted-2">{title}</div>
      <ul className="mt-1.5 space-y-1">
        {items.map((t, i) => (
          <li key={i}>
            <button onClick={() => onSelect(ids[i])}
                    className="text-left text-[12px] leading-snug text-muted hover:text-brand-600 hover:underline">
              → {t}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default RegulationImpactPage;
