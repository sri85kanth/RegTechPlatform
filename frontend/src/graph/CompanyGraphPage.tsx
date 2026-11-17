import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position, MarkerType,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Building2, ChevronDown, ChevronRight, ExternalLink, FolderTree, Inbox, Maximize2, Search as SearchIcon, UserRound, X,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useCompanyProfile } from '@/services/regulationsApi';
import { usePeople, useStructure, type OrgNode, type Structure } from '@/services/structureApi';
import {
  childrenOf, countOf, groupWord, kindLabel, showValue, sourcesText, toneOf, unitWordText, TONE_CLASS, TONE_RANK, type Tone,
} from '@/modules/departments/model';
import { tx, useT } from '@/i18n';
import { accentAt, deptAccent, deptIcon, type Accent } from '@/modules/departments/accent';
import { Avatar } from '@/components/ui/primitives';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { NodeMeasurer } from './NodeMeasurer';
import { ReportingLines } from './ReportingLines';

/* ============================================================
   Company Graph — drawn from the company's own data.

   It used to be a fixed operating-model template: the same nine domain boxes
   (Departments, People, Processes, Systems, Data, Policies, Controls, Risks,
   Evidence) in the same two rows, joined by the same invented links ("Owns",
   "Runs On", "Governed By"…), with a default selection of an entity from the
   old demo data. It said the same thing about every company and most of it
   was zero.

   Now every box is something that exists:
     the company          — from Company Setup
     its departments      — the structure's top level, with the head a person
                            recorded (or "not recorded"), what was collected
                            there and the source's own status and criticality
     their units          — stacked beneath, indented by depth, largest first
     "No … given"         — records the source did not place, never hidden
     "Not filed yet"      — records in no department at all
   Nothing is drawn for a kind of record, an owner or a link the data does not
   contain.
   ============================================================ */

const ROOT_W = 320, ROOT_H = 96;
const DEPT_W = 312, DEPT_H = 176;
const UNIT_W = 236, UNIT_H = 60;
const COL_GAP = 72, ROW_GAP = 80, STACK_GAP = 10, FIRST_GAP = 44, INDENT = 20;
const PER_COLUMN = 6;        // units per column before the next column starts
const UNIT_COL_GAP = 40;     // the gutter each column's connector runs down
const MAX_ROW_W = 2600;      // departments wrap into rows past this width

type Kind = 'root' | 'dept' | 'unit' | 'own' | 'unfiled';

interface Flag { label: string; tone: Tone; n: number }
interface NData {
  kind: Kind;
  id: string;
  label: string;
  sub?: string;
  head?: string | null;
  headRole?: string | null;
  /** the head comes from an organisation chart the company shared, not from Edit structure */
  headFromChart?: boolean;
  moreHeads?: number;
  total: number;
  types?: number;
  units?: number;
  collected?: { label: string; n: number }[];
  flags: Flag[];
  from?: string;
  collapsed?: boolean;
  dim?: boolean;
  selected?: boolean;
  /** the department's colour — its card, its units and the lines between them */
  accent?: Accent;
  onSelect: (id: string) => void;
  onToggle?: (id: string) => void;
  onOpen?: (id: string) => void;
}

/* ---------------- handles: explicit, so every edge picks its side ---------------- */
function Handles({ stackFrom = 18 }: { stackFrom?: number }) {
  const dot = '!h-1.5 !w-1.5 !border-0 !bg-slate-300';
  return (
    <>
      <Handle id="t" type="target" position={Position.Top} className={dot} />
      <Handle id="l" type="target" position={Position.Left} className={dot} />
      <Handle id="b" type="source" position={Position.Bottom} className={dot} />
      {/* bottom-left: where a stacked list of units hangs from */}
      <Handle id="bl" type="source" position={Position.Bottom} className={dot} style={{ left: stackFrom }} />
    </>
  );
}

function FlagChips({ flags, max = 3 }: { flags: Flag[]; max?: number }) {
  return (
    <span className="flex flex-wrap gap-1">
      {flags.slice(0, max).map((f) => (
        <span key={f.label} className={cn('rounded-full px-2 py-px text-[11px] font-semibold', TONE_CLASS[f.tone])}>
          {f.label} {f.n}
        </span>
      ))}
    </span>
  );
}

const TONE_DOT: Record<Tone, string> = {
  high: 'bg-notcov-500', danger: 'bg-critical-500', warn: 'bg-warning-500', ok: 'bg-success-500', neutral: 'bg-slate-400', muted: 'bg-slate-300',
};

/* ---------------- node types ---------------- */
function RootNode({ data }: NodeProps<NData>) {
  const t = useT();
  const depts = data.units ?? 0;
  return (
    <button onClick={() => data.onSelect(data.id)}
      className={cn('flex h-full w-full items-center gap-3 rounded-2xl border border-line border-t-4 border-t-brand-600 bg-gradient-to-br from-white to-brand-50 px-4 text-left text-ink shadow-md ring-2 transition',
        data.selected ? 'ring-brand-400' : 'ring-transparent', data.dim && 'opacity-40')}>
      <Handles />
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-sm"><Building2 className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-semibold leading-tight text-ink" title={data.label}>{data.label}</span>
        {data.sub && <span className="block truncate text-[11.5px] text-muted" title={data.sub}>{data.sub}</span>}
        <span className="mt-1 block text-[11px] text-muted">
          {depts === 1 ? t('1 department') : t('{n} departments', { n: depts })} · {data.total === 1 ? t('1 item') : t('{n} items', { n: data.total.toLocaleString() })}
        </span>
      </span>
    </button>
  );
}

function DeptNode({ data }: NodeProps<NData>) {
  const t = useT();
  const a = data.accent;
  return (
    <div onClick={() => data.onSelect(data.id)} onDoubleClick={() => data.onOpen?.(data.id)}
      className={cn('flex h-full w-full cursor-pointer flex-col rounded-2xl border border-t-[5px] bg-white px-3.5 py-3 text-left shadow-sm transition',
        a?.edge ?? 'border-t-brand-500',
        data.selected ? 'border-brand-500 shadow-md ring-2 ring-brand-500/30' : 'border-slate-200 hover:shadow-md', data.dim && 'opacity-35')}>
      <Handles />
      <div className="flex items-center gap-2">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', a?.tile ?? 'bg-brand-50 text-brand-600')}>
          <Icon name={deptIcon(data.label)} className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink" title={data.label}>{data.label}</span>
          <span className="block truncate text-[11px] text-muted">{data.sub}{data.from && ` · ${t('from {sources}', { sources: data.from })}`}</span>
        </span>
        <span className="text-right">
          <span className="block text-[18px] font-bold leading-none text-ink">{data.total.toLocaleString()}</span>
          <span className="text-[11px] text-muted">{data.total === 1 ? t('item') : t('items')}</span>
        </span>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[12px]"
        title={data.headFromChart ? t('As the organisation chart names the head') : undefined}>
        {data.head
          ? <Avatar name={data.head} size={20} />
          : <UserRound className="h-3.5 w-3.5 shrink-0 text-muted" />}
        {data.head
          ? <span className="min-w-0 truncate"><b className="font-semibold text-ink">{data.head}</b>{data.headRole && <span className="text-muted"> · {data.headRole}</span>}</span>
          : <span className="italic text-muted-2">{t('Head not recorded')}</span>}
        {data.moreHeads ? <span className="shrink-0 text-[11px] text-muted">+{data.moreHeads}</span> : null}
        {data.headFromChart && <span className="ml-auto shrink-0 rounded bg-slate-100 px-1 text-[11px] font-medium text-muted">{t('org chart')}</span>}
      </p>
      <p className="mt-1 truncate text-[11.5px] text-ink-2">
        {data.types ? <><b>{data.types}</b> {data.types === 1 ? t('type') : t('types')}</> : null}
        {data.types && data.units ? ' · ' : null}
        {data.units ? <><b>{data.units}</b> {data.units === 1 ? t('unit') : t('units')}</> : null}
        {data.collected?.length ? <>{data.types || data.units ? ' · ' : ''}{data.collected.map((c) => c.label).join(', ')}</> : null}
      </p>
      <div className="mt-1.5 min-h-[20px]"><FlagChips flags={data.flags} /></div>
      <div className="mt-auto flex items-center justify-between pt-1.5">
        {data.units ? (
          <button onClick={(e) => { e.stopPropagation(); data.onToggle?.(data.id); }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-muted hover:bg-slate-100 hover:text-ink">
            {data.collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {data.collapsed ? (data.units === 1 ? t('Show 1 unit') : t('Show {n} units', { n: data.units })) : t('Hide units')}
          </button>
        ) : <span />}
        <button onClick={(e) => { e.stopPropagation(); data.onOpen?.(data.id); }}
          className="inline-flex items-center gap-0.5 text-[11.5px] font-semibold text-brand-600 hover:underline">
          {t('Open')} <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function UnitNode({ data }: NodeProps<NData>) {
  const own = data.kind === 'own';
  const unfiled = data.kind === 'unfiled';
  return (
    <div onClick={() => data.onSelect(data.id)} onDoubleClick={() => data.onOpen?.(data.id)}
      className={cn('flex h-full w-full cursor-pointer flex-col justify-center rounded-xl border bg-white px-3 text-left transition',
        own || unfiled ? 'border-dashed border-slate-300 bg-slate-50' : 'border-line hover:border-slate-300 hover:shadow-sm',
        data.selected && 'border-brand-500 ring-2 ring-brand-500/20', data.dim && 'opacity-35')}
      style={own || unfiled ? undefined : { borderLeft: `4px solid ${data.accent?.hex ?? '#2563eb'}` }}>
      <Handles stackFrom={14} />
      <div className="flex items-center gap-2">
        {own || unfiled ? <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-2" /> : <span className={cn('h-2 w-2 shrink-0 rounded-full', data.accent?.dot ?? 'bg-brand-500')} />}
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px] font-semibold', own || unfiled ? 'italic text-muted' : 'text-ink')} title={data.label}>
          {data.label}
        </span>
        <span className={cn('rounded-full px-2 text-[11px] font-semibold', own || unfiled ? 'bg-slate-100 text-ink-2' : data.accent?.chip ?? 'bg-slate-100 text-ink-2')}>{data.total.toLocaleString()}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5">
        {data.head
          ? <span className="truncate text-[11px] text-ink-2"><UserRound className="-mt-0.5 mr-0.5 inline h-3 w-3 text-muted" />{data.head}</span>
          : null}
        <FlagChips flags={data.flags} max={2} />
      </div>
    </div>
  );
}

const nodeTypes = { root: RootNode, dept: DeptNode, unit: UnitNode, own: UnitNode, unfiled: UnitNode };

/* ---------------- what each node says, from the counts the server keeps ---------------- */
function flagsFor(counts: Structure['counts'] | undefined, id: string): Flag[] {
  const signals = counts?.signals?.[id];
  if (signals) {
    const flagged = signals.filter((x) => { const t = toneOf(x.value); return t === 'danger' || t === 'warn'; });
    // name the kind of record only when this node holds flags from more than one
    const kinds = new Set(flagged.map((x) => x.type ?? ''));
    return flagged.map((x) => ({
      label: `${kinds.size > 1 && x.type ? `${x.type}: ` : ''}${showValue(x.field, x.value)}`, tone: toneOf(x.value), n: x.n,
    })).sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
  }
  const out: Flag[] = [];
  for (const field of ['criticality', 'status'] as const) {
    for (const [v, n] of Object.entries(counts?.[field]?.[id] ?? {})) {
      const tone = toneOf(v);
      if (tone === 'danger' || tone === 'warn') out.push({ label: showValue(field, v), tone, n });
    }
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
}

/** A node's head: the one a person typed in, else the one(s) an organisation chart names. */
function headFor(node: OrgNode, counts: Structure['counts'] | undefined) {
  if (node.head_name) return { head: node.head_name, headRole: node.head_role };
  const chart = counts?.heads?.[node.id] ?? [];
  if (!chart.length) return {};
  return { head: chart[0].name, headRole: chart[0].role, headFromChart: true, moreHeads: chart.length - 1 };
}

/** "48 equipment items", "30 complaints", "5 people" — what a node holds, register by register */
function collectedFor(counts: Structure['counts'] | undefined, id: string) {
  return (counts?.collected?.[id] ?? []).map((k) => ({ label: countOf(kindLabel(k.domain, k.type), k.n), n: k.n }));
}

/** "88 types" says something about one register of equipment; across registers, or of people, it says nothing. */
function typesFor(counts: Structure['counts'] | undefined, id: string) {
  const kinds = counts?.collected?.[id] ?? [];
  return kinds.length === 1 && kinds[0].domain !== 'people' ? counts?.distinct_names?.[id] : undefined;
}

/* ============================================================ */
export function CompanyGraphPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data: structure, isLoading } = useStructure();
  const { data: profileRes } = useCompanyProfile();
  const profile = (profileRes?.profile ?? null) as Record<string, unknown> | null;

  const [params, setParams] = useSearchParams();
  const { data: peopleRes } = usePeople();
  const people = useMemo(() => peopleRes?.people ?? [], [peopleRes]);
  const hasChart = people.some((p) => p.isHead);
  const view = hasChart && params.get('view') === 'reporting' ? 'reporting' : 'departments';
  const setView = (v: 'departments' | 'reporting') => {
    const next = new URLSearchParams(params);
    if (v === 'reporting') next.set('view', v); else next.delete('view');
    setParams(next, { replace: true });
  };

  const [query, setQuery] = useState('');
  // "View in graph" from a record's drawer lands here with ?focus=; it selects
  // a department or unit when it names one, and otherwise simply opens the graph.
  const [selected, setSelected] = useState<string | null>(params.get('focus'));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);

  const flat = useMemo(() => structure?.flat ?? [], [structure]);
  const counts = structure?.counts;
  // largest first, so what holds the most is where the eye starts
  const roots = useMemo(() => flat.filter((n) => !n.parent_id)
    .sort((a, b) => (counts?.total?.[b.id] ?? 0) - (counts?.total?.[a.id] ?? 0) || a.name.localeCompare(b.name)), [flat, counts]);
  const unfiled = counts?.unfiled ?? 0;
  const filed = counts?.filed ?? 0;

  const companyName = String(profile?.legal_name ?? '').trim();
  const companySub = [profile?.entity_type, profile?.legal_form, profile?.hq_state]
    .map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ');

  // Highlights offered are only values that exist: the source's own
  // criticality and status values that ask for attention, and the kinds of
  // record collected — never a fixed list of domains.
  const highlights = useMemo(() => {
    const out: { key: string; label: string; n: number; tone: Tone; ids: Set<string> }[] = [];
    const add = (key: string, label: string, tone: Tone, per: Record<string, number> | undefined, total: number) => {
      const ids = new Set(Object.entries(per ?? {}).filter(([, n]) => n > 0).map(([id]) => id));
      if (total) out.push({ key, label, n: total, tone, ids });
    };
    if (counts?.signals) {
      // one chip per kind of record and value: "Equipment: Critical" and a
      // complaint's "Critical" priority are different things, never one count
      const totals = new Map<string, { type: string | null; field: 'status' | 'criticality'; value: string; n: number }>();
      for (const r of roots) {
        for (const x of counts.signals[r.id] ?? []) {
          const key = `${x.type ?? ''}|${x.field}|${x.value}`;
          const sum = totals.get(key);
          if (sum) sum.n += x.n; else totals.set(key, { ...x });
        }
      }
      const flagged = [...totals.entries()].filter(([, x]) => ['danger', 'warn'].includes(toneOf(x.value)));
      const kinds = new Set(flagged.map(([, x]) => x.type ?? ''));
      for (const [key, x] of flagged) {
        const per: Record<string, number> = {};
        for (const nd of flat) {
          per[nd.id] = (counts.signals[nd.id] ?? []).find((y) => y.type === x.type && y.field === x.field && y.value === x.value)?.n ?? 0;
        }
        add(key, `${kinds.size > 1 && x.type ? `${x.type}: ` : ''}${showValue(x.field, x.value)}`, toneOf(x.value), per, x.n);
      }
      return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
    }
    for (const field of ['criticality', 'status'] as const) {
      const values = new Map<string, number>();
      for (const r of roots) for (const [v, n] of Object.entries(counts?.[field]?.[r.id] ?? {})) values.set(v, (values.get(v) ?? 0) + n);
      for (const [v, n] of values) {
        const tone = toneOf(v);
        if (tone !== 'danger' && tone !== 'warn') continue;
        const per: Record<string, number> = {};
        for (const nd of flat) per[nd.id] = counts?.[field]?.[nd.id]?.[v] ?? 0;
        add(`${field}:${v}`, showValue(field, v), tone, per, n);
      }
    }
    return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
  }, [roots, flat, counts]);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node<NData>[] = [];
    const edges: Edge[] = [];
    const q = query.trim().toLowerCase();
    const lit = highlight ? highlights.find((h) => h.key === highlight)?.ids : undefined;
    const matches = (n: OrgNode) => !q || n.name.toLowerCase().includes(q) || (n.head_name ?? '').toLowerCase().includes(q)
      || (counts?.heads?.[n.id] ?? []).some((h) => h.name.toLowerCase().includes(q));
    const dimmed = (n: OrgNode) => (!!q && !matches(n)) || (!!lit && !lit.has(n.id));
    const open = (id: string) => navigate(`/departments/${id}`);
    const common = { onSelect: setSelected, onOpen: open };

    // Each department is a slot: its card, and beneath it its units in
    // columns of PER_COLUMN — an org chart, wide rather than one tall list that
    // fitting to the screen would shrink past reading.
    interface Row { node: OrgNode | null; level: number; parent: OrgNode; own?: number; word?: string }
    const rowsOf = (dept: OrgNode): Row[] => {
      const out: Row[] = [];
      const walk = (parent: OrgNode, level: number) => {
        const kids = childrenOf(flat, parent.id)
          .sort((a, b) => (counts?.total?.[b.id] ?? 0) - (counts?.total?.[a.id] ?? 0) || a.name.localeCompare(b.name));
        for (const c of kids) {
          out.push({ node: c, level, parent });
          walk(c, level + 1);
        }
        // records filed on the parent itself: the source gave no finer place
        const own = counts?.own?.[parent.id] ?? 0;
        if (own > 0 && kids.length) out.push({ node: null, level, parent, own, word: groupWord(kids) });
      };
      walk(dept, 0);
      return out;
    };
    const slots = roots.map((dept) => {
      const rows = collapsed.has(dept.id) ? [] : rowsOf(dept);
      const cols = Math.max(1, Math.ceil(rows.length / PER_COLUMN));
      const unitsW = rows.length ? cols * UNIT_W + (cols - 1) * UNIT_COL_GAP : 0;
      return { dept, rows, cols, width: Math.max(DEPT_W, unitsW), unitsW };
    });

    // Departments sit side by side under the company; past MAX_ROW_W they wrap
    // into further rows (an organisation chart can have forty), each row as
    // tall as its tallest department. Wrapped rows hang from no line of their
    // own — every department is the company's, and lines through the rows
    // above would only cross them.
    type Slot = (typeof slots)[number] | { unfiledSlot: true; width: number; rows: [] };
    const all: Slot[] = [...slots, ...(unfiled > 0 ? [{ unfiledSlot: true as const, width: DEPT_W, rows: [] as [] }] : [])];
    const lines: Slot[][] = [[]];
    let lineW = 0;
    for (const sl of all) {
      const cur = lines[lines.length - 1];
      if (cur.length && lineW + COL_GAP + sl.width > MAX_ROW_W) { lines.push([sl]); lineW = sl.width; }
      else { cur.push(sl); lineW += (cur.length > 1 ? COL_GAP : 0) + sl.width; }
    }
    const lineWidth = (line: Slot[]) => line.reduce((w, sl) => w + sl.width, 0) + Math.max(0, line.length - 1) * COL_GAP;
    const width = Math.max(ROOT_W, ...lines.map(lineWidth));
    const heightOf = (sl: Slot) => DEPT_H + (sl.rows.length
      ? FIRST_GAP + Math.min(sl.rows.length, PER_COLUMN) * (UNIT_H + STACK_GAP) : 0);
    const wrapped = lines.length > 1;

    // the company
    nodes.push({
      id: 'company', type: 'root', position: { x: (width - ROOT_W) / 2, y: 0 }, width: ROOT_W, height: ROOT_H,
      style: { width: ROOT_W, height: ROOT_H }, draggable: false,
      data: { kind: 'root', id: 'company', label: companyName || t('Company not set up yet'),
        sub: companyName ? companySub : t('Open Company Setup to name it'), total: filed + unfiled,
        units: roots.length, flags: [], selected: selected === 'company', ...common, onOpen: () => navigate('/company-setup') },
    });
    const edge = (source: string, target: string, from: 'b' | 'bl', to: 't' | 'l', color = '#94a3b8'): Edge => ({
      id: `${source}->${target}`, source, target, sourceHandle: from, targetHandle: to, type: 'smoothstep',
      style: { stroke: color, strokeWidth: 1.5 },
      ...(to === 't' ? { markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color } } : {}),
      pathOptions: { borderRadius: 8, offset: 14 },
    } as Edge);

    let deptY = ROOT_H + ROW_GAP;
    lines.forEach((line, lineNo) => {
      let cursor = (width - lineWidth(line)) / 2;
      line.forEach((sl) => {
        if ('unfiledSlot' in sl) {
          nodes.push({
            id: 'unfiled', type: 'unfiled', position: { x: cursor, y: deptY }, width: DEPT_W, height: UNIT_H,
            style: { width: DEPT_W, height: UNIT_H }, draggable: false,
            data: { kind: 'unfiled', id: 'unfiled', label: t('Not filed yet — in no department'), total: unfiled, flags: [],
              selected: selected === 'unfiled', dim: !!q || !!lit, ...common },
          });
          if (!wrapped || lineNo === 0) edges.push(edge('company', 'unfiled', 'b', 't', '#cbd5e1'));
          cursor += sl.width + COL_GAP;
          return;
        }
        const { dept, rows, width: slotW, unitsW } = sl;
        const deptX = cursor + (slotW - DEPT_W) / 2;
        const accent = deptAccent(flat, dept.id);
        nodes.push({
          id: dept.id, type: 'dept', position: { x: deptX, y: deptY }, width: DEPT_W, height: DEPT_H,
          style: { width: DEPT_W, height: DEPT_H }, draggable: false,
          data: { kind: 'dept', id: dept.id, label: dept.name, sub: dept.kind ? t(dept.kind) : t('Department'),
            ...headFor(dept, counts), total: counts?.total?.[dept.id] ?? 0,
            types: typesFor(counts, dept.id), units: flat.filter((n) => n.path.startsWith(`${dept.path}/`)).length,
            collected: collectedFor(counts, dept.id), flags: flagsFor(counts, dept.id), from: sourcesText(counts?.sources?.[dept.id]),
            collapsed: collapsed.has(dept.id), dim: dimmed(dept), selected: selected === dept.id, accent, ...common,
            onToggle: (id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }) },
        });
        if (!wrapped || lineNo === 0) edges.push(edge('company', dept.id, 'b', 't', accent.hex));

        const left = cursor + (slotW - unitsW) / 2;
        rows.forEach((row, i) => {
          const col = Math.floor(i / PER_COLUMN), rank = i % PER_COLUMN;
          const x = left + col * (UNIT_W + UNIT_COL_GAP) + INDENT * row.level;
          const y = deptY + DEPT_H + FIRST_GAP + rank * (UNIT_H + STACK_GAP);
          const w = UNIT_W - INDENT * row.level;
          // a top-level unit hangs from its department; a deeper one from its own parent
          const from = row.level === 0 ? dept.id : row.parent.id;
          const handle = row.level === 0 ? 'b' : 'bl';
          if (row.node) {
            const c = row.node;
            nodes.push({
              id: c.id, type: 'unit', position: { x, y }, width: w, height: UNIT_H, style: { width: w, height: UNIT_H },
              draggable: false,
              data: { kind: 'unit', id: c.id, label: c.name, ...headFor(c, counts), total: counts?.total?.[c.id] ?? 0,
                flags: flagsFor(counts, c.id), dim: dimmed(c), selected: selected === c.id, accent, ...common },
            });
            edges.push(edge(from, c.id, handle, 'l', `${accent.hex}99`));
          } else {
            const id = `own:${row.parent.id}`;
            nodes.push({
              id, type: 'own', position: { x, y }, width: w, height: UNIT_H, style: { width: w, height: UNIT_H }, draggable: false,
              data: { kind: 'own', id, label: t('No {unit} given', { unit: unitWordText(t, row.word ?? 'unit') }), total: row.own ?? 0, flags: [], selected: selected === id,
                dim: !!q || !!lit, ...common, onOpen: () => navigate(`/departments/${row.parent.id}?tab=units`) },
            });
            edges.push(edge(from, id, handle, 'l', '#cbd5e1'));
          }
        });
        cursor += slotW + COL_GAP;
      });
      deptY += Math.max(...line.map(heightOf)) + ROW_GAP;
    });
    return { nodes, edges };
  }, [roots, flat, counts, unfiled, filed, companyName, companySub, collapsed, selected, query, highlight, highlights, navigate, t]);

  // the view refits when the shape changes (a department opened or closed)
  const shape = nodes.map((n) => n.id).join('|');
  useEffect(() => {
    if (!rf) return;
    const timer = setTimeout(() => rf.fitView({ padding: 0.12, minZoom: 0.55, duration: 250 }), 60);
    return () => clearTimeout(timer);
  }, [rf, shape]);

  const selectedNode = selected ? nodes.find((n) => n.id === selected) : undefined;
  const allUnits = flat.filter((n) => n.parent_id).length;
  const sourceNames = new Set<string>(roots.flatMap((r) => Object.keys(counts?.sources?.[r.id] ?? {})));

  return (
    <>
      <Topbar
        title="Org chart"
        icon="Network"
        meta={[
          { icon: 'Building2', label: 'Company', value: companyName || t('Company not set up') },
          { icon: 'FolderTree', label: roots.length === 1 ? t('Department') : t('Departments'), value: roots.length },
          { icon: 'ListTree', label: allUnits === 1 ? t('Unit') : t('Units'), value: allUnits },
          { icon: 'FileText', label: filed + unfiled === 1 ? t('Item') : t('Items'), value: (filed + unfiled).toLocaleString() },
          ...(sourceNames.size > 0
            ? [{ icon: 'Plug', label: 'Collected from', value: sourcesText(Object.fromEntries([...sourceNames].map((s) => [s, 1]))) }]
            : []),
        ]}
        actions={<>
          <Link className="btn btn-sm btn-outline" to="/departments"><Icon name="LayoutGrid" className="h-3.5 w-3.5" /> {t('Departments')}</Link>
          <Link className="btn btn-sm" to="/structure"><Icon name="Pencil" className="h-3.5 w-3.5" /> {t('Edit structure')}</Link>
        </>}
      />

      {isLoading ? (
        <div className="p-6 text-[13px] text-muted">{t('Reading the structure…')}</div>
      ) : roots.length === 0 && unfiled === 0 ? (
        <div className="p-4 sm:p-6">
          <div className="card flex flex-col items-center px-6 py-14 text-center">
            <FolderTree className="h-8 w-8 text-brand-600" />
            <p className="mt-3 text-[14px] font-semibold text-ink">{t('Nothing to draw yet')}</p>
            <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">
              {t('The graph is drawn from your own data. Connect a folder or an API in Integrations and give it a department’s name, and that department — with its units and everything collected into it — appears here.')}
            </p>
            <div className="mt-4 flex gap-2">
              <Link className="btn btn-sm btn-primary" to="/integrations">{t('Go to Integrations')}</Link>
              <Link className="btn btn-sm" to="/company-setup">{t('Company Setup')}</Link>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-6 py-2.5">
            {hasChart && (
              <SegmentedControl
                ariaLabel="What the graph shows"
                options={[{ key: 'departments', label: 'Departments' }, { key: 'reporting', label: 'Reporting lines' }]}
                value={view}
                onChange={(v) => setView(v)}
              />
            )}
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-2" />
              <input className="input h-9 w-72 pl-8"
                placeholder={view === 'reporting' ? t('Find a person, designation or department…') : t('Find a department, unit or head…')}
                value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" data-lpignore="true" data-1p-ignore="true" />
            </div>
            {view === 'departments' && highlights.length > 0 && <span className="ml-2 text-[12px] text-muted">{t('Highlight')}</span>}
            {view === 'departments' && highlights.map((h) => (
              <button key={h.key} onClick={() => setHighlight((cur) => (cur === h.key ? null : h.key))} aria-pressed={highlight === h.key}
                className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 transition',
                  highlight === h.key ? cn(TONE_CLASS[h.tone], 'ring-current') : 'bg-surface text-ink-2 ring-line hover:bg-slate-50')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[h.tone])} aria-hidden="true" />
                {h.label} <span className="tabular-nums text-muted">{h.n}</span>
              </button>
            ))}
            {view === 'departments' && <div className="ml-auto flex items-center gap-2">
              <button className="btn btn-sm" onClick={() => setCollapsed(new Set())}>{t('Show all units')}</button>
              <button className="btn btn-sm" onClick={() => setCollapsed(new Set(roots.map((r) => r.id)))}>{t('Departments only')}</button>
              <button className="btn btn-sm gap-1.5" onClick={() => rf?.fitView({ padding: 0.12, minZoom: 0.55, duration: 250 })}>
                <Maximize2 className="h-4 w-4" /> {t('Fit view')}
              </button>
            </div>}
          </div>

          <div className="flex min-h-[560px] flex-1 overflow-hidden">
            {view === 'reporting' ? <ReportingLines people={people} query={query} flat={flat} /> : <>
            <div className="relative flex-1">
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setRf} fitView
                fitViewOptions={{ padding: 0.12, minZoom: 0.55 }} minZoom={0.15} maxZoom={1.6} nodesConnectable={false}
                proOptions={{ hideAttribution: true }} onPaneClick={() => setSelected(null)}>
                <NodeMeasurer ids={nodes.map((n) => n.id)} />
                <Background color="#e6e8f1" gap={22} />
                <Controls showInteractive={false} position="top-left"
                  className="!m-3 overflow-hidden rounded-lg border border-line !shadow-sm" />
                <MiniMap pannable zoomable
                  nodeColor={(n) => (n.type === 'root' ? '#1d4ed8' : (n.type === 'dept' || n.type === 'unit')
                    ? ((n.data as NData | undefined)?.accent?.hex ?? '#2563eb') : '#cbd5e1')}
                  nodeBorderRadius={6} maskColor="rgba(241, 245, 249, 0.7)"
                  style={{ width: 176, height: 112, backgroundColor: '#ffffff' }}
                  className="!m-3 overflow-hidden rounded-lg border border-line shadow-md" />
              </ReactFlow>
              <Legend roots={roots} flat={flat} counts={counts} open={legendOpen} onToggle={() => setLegendOpen((o) => !o)}
                onPick={(id) => { setSelected(id); rf?.fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1.1, duration: 300 }); }} />
            </div>
            {selectedNode && (
              <DetailPanel node={selectedNode.data} flat={flat} counts={counts} profile={profile}
                onClose={() => setSelected(null)} onOpen={(id) => navigate(id === 'company' ? '/company-setup' : `/departments/${id.replace(/^own:/, '')}`)} />
            )}
            </>}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- the key: which colour is which department, and what the shapes mean ---------------- */
function Legend({ roots, flat, counts, open, onToggle, onPick }: {
  roots: OrgNode[]; flat: OrgNode[]; counts: Structure['counts'] | undefined;
  open: boolean; onToggle: () => void; onPick: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="absolute bottom-3 left-3 z-10 max-w-[300px] rounded-xl border border-line bg-white/95 shadow-md backdrop-blur">
      <button onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold text-ink">
        <Icon name="Info" className="h-3.5 w-3.5 text-brand-600" /> {t('Legend')}
        {open ? <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted" /> : <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted" />}
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-line px-3 pb-3 pt-2">
          <ul className="max-h-[180px] space-y-1 overflow-y-auto pr-1">
            {roots.map((r) => {
              const a = deptAccent(flat, r.id);
              return (
                <li key={r.id}>
                  <button onClick={() => onPick(r.id)} title={t('Show {name}', { name: r.name })}
                    className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[12px] hover:bg-slate-50">
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', a.dot)} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{r.name}</span>
                    <span className="tabular-nums text-muted">{(counts?.total?.[r.id] ?? 0).toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="space-y-1 border-t border-line pt-2 text-[11.5px] text-muted">
            <p className="flex items-center gap-2"><span className="h-3 w-5 rounded-sm border border-slate-300 border-t-[3px] border-t-brand-500 bg-white" /> {t('Department')}</p>
            <p className="flex items-center gap-2"><span className="h-3 w-5 rounded-sm border border-slate-300 border-l-[3px] border-l-violet-500 bg-white" /> {t('Unit inside it')}</p>
            <p className="flex items-center gap-2"><span className="h-3 w-5 rounded-sm border border-dashed border-slate-300 bg-slate-50" /> {t('Not placed by the source')}</p>
            <p className="flex items-center gap-2">
              <span className="rounded-full bg-critical-50 px-1.5 text-[11px] font-semibold text-critical-600">{t('Red')}</span>
              <span className="rounded-full bg-warning-50 px-1.5 text-[11px] font-semibold text-warning-600">{t('Amber')}</span>
              {t('the source’s own status asking for attention')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- the panel beside the graph ---------------- */
/** The field a source's value was read from, as the panel names it. */
const FIELD_WORD: Record<string, string> = { status: tx('status'), criticality: tx('criticality') };

function DetailPanel({ node, flat, counts, profile, onClose, onOpen }: {
  node: NData; flat: OrgNode[]; counts: Structure['counts'] | undefined; profile: Record<string, unknown> | null;
  onClose: () => void; onOpen: (id: string) => void;
}) {
  const t = useT();
  const org = flat.find((n) => n.id === node.id);
  const path = org ? org.path.split('/').length > 1 ? flat.filter((n) => org.path.startsWith(`${n.path}/`)).map((n) => n.name) : [] : [];
  const status = Object.entries(counts?.status?.[node.id] ?? {});
  const crit = Object.entries(counts?.criticality?.[node.id] ?? {});
  // per kind of record when the server says it: "Equipment · criticality", "Complaint · status"
  const perKind = new Map<string, { field: string; values: [string, number][] }>();
  for (const x of counts?.signals?.[node.id] ?? []) {
    const key = `${x.type ?? t('Records')} · ${t(FIELD_WORD[x.field] ?? x.field)}`;
    const g = perKind.get(key) ?? { field: x.field, values: [] };
    g.values.push([x.value, x.n]);
    perKind.set(key, g);
  }
  const groups: [string, [string, number][], string][] = counts?.signals
    ? [...perKind.entries()].map(([label, g]) => [label, g.values, g.field])
    : [[tx('Criticality'), crit, 'criticality'], [tx('Status'), status, 'status']];
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
      <span className="text-muted">{label}</span><span className="text-right font-medium text-ink">{value}</span>
    </div>
  );

  return (
    <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-surface p-4">
      <div className="flex items-start gap-2.5">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl',
          node.kind === 'root' ? 'bg-gradient-to-br from-brand-500 to-violet-500 text-white'
            : node.kind === 'own' || node.kind === 'unfiled' ? 'bg-warning-50 text-warning-600' : node.accent?.tile ?? 'bg-brand-50 text-brand-600')}>
          <Icon name={node.kind === 'root' ? 'Building2' : node.kind === 'own' || node.kind === 'unfiled' ? 'Inbox' : deptIcon(node.label)} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          {path.length > 0 && <p className="truncate text-[11px] text-muted">{path.join(' › ')}</p>}
          <h2 className="text-[15px] font-bold leading-tight text-ink">{node.label}</h2>
          {node.sub && <p className="text-[12px] text-muted">{node.sub}</p>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-slate-100 hover:text-ink" aria-label={t('Close')}><X className="h-4 w-4" /></button>
      </div>

      {node.kind === 'root' ? (
        <div className="mt-3 divide-y divide-line">
          {row(t('Registration'), String(profile?.registration_no ?? '') || t('not recorded'))}
          {row(t('Legal form'), String(profile?.legal_form ?? '') || t('not recorded'))}
          {row(t('Head office'), String(profile?.hq_state ?? '') || t('not recorded'))}
          {row(t('Departments'), node.units ?? 0)}
          {row(t('Items collected'), node.total.toLocaleString())}
        </div>
      ) : (
        <>
          {(node.kind === 'dept' || node.kind === 'unit') && (
            <div className="mt-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
              <p className="text-xs font-medium text-muted">{t('Head')}</p>
              {node.head ? (
                <p className="mt-0.5 text-[13px] text-ink"><b>{node.head}</b>{node.headRole && <span className="text-muted"> · {node.headRole}</span>}
                  {node.moreHeads ? <span className="text-muted"> {t('and {n} more', { n: node.moreHeads })}</span> : null}
                  {node.headFromChart && <span className="mt-0.5 block text-[11.5px] text-muted">{t('As the organisation chart names the head.')}</span>}</p>
              ) : (
                <p className="mt-0.5 text-[12.5px] text-muted">
                  {t('Not recorded. Nothing here names one, and none is invented —')}{' '}
                  <Link to="/structure" className="font-medium text-brand-600 hover:underline">{t('add it in Edit structure')}</Link>.
                </p>
              )}
            </div>
          )}
          <div className="mt-3 divide-y divide-line">
            {row(t('Items'), node.total.toLocaleString())}
            {node.types ? row(t('Different types'), node.types) : null}
            {node.units ? row(t('Units inside'), node.units) : null}
            {node.from ? row(t('Collected from'), node.from) : null}
          </div>
          {(node.collected?.length ?? 0) > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted">{t('Collected')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {node.collected!.map((c, i) => <span key={c.label} className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-medium', accentAt(i + 1).chip)}>{c.label}</span>)}
              </div>
            </div>
          )}
          {groups.map(([label, vals, field]) => (
            vals.length > 0 && (
              <div key={label} className="mt-3">
                <p className="text-xs font-medium text-muted">{t('{field}, as the source reports it', { field: t(label) })}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {[...vals].sort((a, b) => TONE_RANK[toneOf(a[0])] - TONE_RANK[toneOf(b[0])]).map(([v, n]) => (
                    <span key={v} className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TONE_CLASS[toneOf(v)])}>{showValue(field, v)} {n}</span>
                  ))}
                </div>
              </div>
            )
          ))}
        </>
      )}

      {node.kind !== 'unfiled' && (
        <button onClick={() => onOpen(node.id)} className="btn btn-sm btn-primary mt-4 w-full">
          {node.kind === 'root' ? t('Open Company Setup') : t('Open its page')} <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
      {node.kind === 'unfiled' && (
        <Link to="/departments/unfiled" className="btn btn-sm mt-4 w-full">{t('Open Not filed yet')}</Link>
      )}
    </aside>
  );
}

export default CompanyGraphPage;
