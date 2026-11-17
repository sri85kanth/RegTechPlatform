import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactFlow, {
  Background, Controls, Handle, MarkerType, Position, type Edge, type Node, type NodeProps,
} from 'reactflow';
import dagre from 'dagre';
import type { OrgNode, Person } from '@/services/structureApi';
import { Avatar } from '@/components/ui/primitives';
import { accentForName, deptAccent, type Accent } from '@/modules/departments/accent';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import { NodeMeasurer } from './NodeMeasurer';

const W = 236, H = 70;
// More direct reports than FAN, none with reports of their own, hang in
// columns of FAN under their manager rather than in one row thirty wide.
const FAN = 6, COL_GAP = 40, STACK = 10, FIRST = 36;

interface PData {
  person: Person;
  reports: number;
  dim: boolean;
  /** the colour of the department the person is filed in — the org chart's own */
  accent?: Accent;
  onOpen: (p: Person) => void;
}

function PersonNode({ data }: NodeProps<PData>) {
  const t = useT();
  const p = data.person;
  // a person carries their department's colour; no department, no colour
  const a = data.accent;
  return (
    <button onClick={() => data.onOpen(p)} title={p.nodeId ? (p.department ? t('Open {name}', { name: p.department }) : t('Open the department')) : undefined}
      className={cn('flex h-full w-full items-center gap-2.5 rounded-xl border bg-white px-2.5 text-left shadow-sm transition hover:border-brand-400 hover:shadow-md',
        p.isHead ? 'border-slate-200' : 'border-dashed border-slate-300', data.dim && 'opacity-30')}
      style={{ borderLeft: `4px solid ${a?.hex ?? '#cbd5e1'}` }}>
      <Handle type="target" id="t" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-slate-300" />
      <Handle type="target" id="l" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-slate-300" />
      <Avatar name={p.name} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-bold text-ink" title={p.name}>{p.name}</span>
          {data.reports > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-brand-50 px-1.5 text-[11px] font-semibold text-brand-700" title={data.reports === 1 ? t('1 direct report') : t('{n} direct reports', { n: data.reports })}>{data.reports}</span>
          )}
        </span>
        <span className="truncate text-[11.5px] text-ink-2" title={p.designation ?? ''}>{p.designation ?? t('Designation not given')}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted" title={p.department ?? ''}>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', a?.dot ?? 'bg-slate-300')} />
          <span className="truncate">{p.department ?? t('Department not given')}</span>
        </span>
      </span>
      <Handle type="source" id="b" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-slate-300" />
    </button>
  );
}

const nodeTypes = { person: PersonNode };

/**
 * Who reports to whom among the people the organisation chart names as heads
 * — and the people those heads report to, so the chain reaches its top.
 *
 * Only the chart's own reporting lines are drawn. A line the chart marks as
 * inferred is dashed; a head whose manager the chart does not name starts a
 * chain of its own rather than being attached to anyone. A loop in the data
 * is drawn as it is and cannot hang the layout.
 */
export function ReportingLines({ people, query, flat = [] }: { people: Person[]; query: string; /** the structure, so a person takes their department's colour */ flat?: OrgNode[] }) {
  const t = useT();
  const navigate = useNavigate();
  const [focus, setFocus] = useState<string | null>(null);

  const { nodes, edges, shown, heads } = useMemo(() => {
    const byRef = new Map(people.filter((p) => p.ref).map((p) => [p.ref as string, p]));
    const heads = people.filter((p) => p.isHead);
    // every head, and the chain above each — stopping at a loop
    const keep = new Map<string, Person>();
    for (const h of heads) {
      let at: Person | undefined = h;
      const seen = new Set<string>();
      while (at && !seen.has(at.id)) {
        seen.add(at.id);
        keep.set(at.id, at);
        at = at.reportsToRef ? byRef.get(at.reportsToRef) : undefined;
      }
    }
    const shown = [...keep.values()];
    const reportsTo = (p: Person) => (p.reportsToRef ? byRef.get(p.reportsToRef) : undefined);
    const direct = new Map<string, number>();
    for (const p of people) {
      const m = reportsTo(p);
      if (m) direct.set(m.id, (direct.get(m.id) ?? 0) + 1);
    }

    // who reports to whom among those drawn — a line to oneself is not one
    const managerOf = new Map<string, Person>();
    for (const p of shown) {
      const m = reportsTo(p);
      if (m && m.id !== p.id && keep.has(m.id)) managerOf.set(p.id, m);
    }
    const kids = new Map<string, Person[]>();
    for (const [pid, m] of managerOf) {
      const list = kids.get(m.id) ?? [];
      list.push(keep.get(pid)!);
      kids.set(m.id, list);
    }
    const fanned = new Map<string, Person[]>();          // manager -> leaves hung in columns
    for (const [mid, list] of kids) {
      const leaves = list.filter((k) => !kids.has(k.id)).sort((a, b) => a.name.localeCompare(b.name));
      if (leaves.length > FAN) fanned.set(mid, leaves);
    }
    const inFan = new Set([...fanned.values()].flat().map((p) => p.id));

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 64, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const p of shown) if (!inFan.has(p.id)) g.setNode(p.id, { width: W, height: H });
    for (const [mid, leaves] of fanned) {
      const cols = Math.ceil(leaves.length / FAN);
      g.setNode(`fan:${mid}`, { width: cols * W + (cols - 1) * COL_GAP, height: FIRST + Math.min(leaves.length, FAN) * (H + STACK) });
      g.setEdge(mid, `fan:${mid}`);
    }
    for (const [pid, m] of managerOf) if (!inFan.has(pid)) g.setEdge(m.id, pid);
    dagre.layout(g);

    const at = new Map<string, { x: number; y: number }>();
    for (const p of shown) if (!inFan.has(p.id)) { const n = g.node(p.id); at.set(p.id, { x: n.x - W / 2, y: n.y - H / 2 }); }
    for (const [mid, leaves] of fanned) {
      const b = g.node(`fan:${mid}`);
      const left = b.x - b.width / 2, top = b.y - b.height / 2 + FIRST;
      leaves.forEach((p, i) => at.set(p.id, {
        x: left + Math.floor(i / FAN) * (W + COL_GAP), y: top + (i % FAN) * (H + STACK),
      }));
    }
    const lines: Edge[] = [...managerOf].map(([pid, m]) => ({
      id: `${m.id}->${pid}`, source: m.id, target: pid, sourceHandle: 'b', targetHandle: inFan.has(pid) ? 'l' : 't',
      type: 'smoothstep', pathOptions: { borderRadius: 8, offset: 14 },
      style: { stroke: '#94a3b8', strokeWidth: 1.4, strokeDasharray: keep.get(pid)!.inferred ? '5 4' : undefined },
      ...(inFan.has(pid) ? {} : { markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: '#94a3b8' } }),
    } as Edge));

    const q = query.trim().toLowerCase();
    const hit = (p: Person) => !q || [p.name, p.designation, p.department].some((v) => (v ?? '').toLowerCase().includes(q));
    const open = (p: Person) => { if (p.nodeId) navigate(`/departments/${p.nodeId}?tab=person`); else setFocus(p.id); };
    const nodes: Node<PData>[] = shown.map((p) => {
      return {
        id: p.id, type: 'person', position: at.get(p.id)!, draggable: false,
        width: W, height: H, style: { width: W, height: H },
        data: { person: p, reports: direct.get(p.id) ?? 0, dim: !hit(p) || (!!focus && focus !== p.id), onOpen: open,
          accent: p.nodeId && flat.some((n) => n.id === p.nodeId) ? deptAccent(flat, p.nodeId) : p.department ? accentForName(p.department) : undefined },
      };
    });
    return { nodes, edges: lines, shown, heads };
  }, [people, query, focus, navigate, flat]);

  if (!heads.length) {
    return (
      <div className="grid flex-1 place-items-center p-10 text-center text-[13px] text-muted">
        <p className="max-w-md">
          {t('No source names anyone as a head yet. Reporting lines appear here once an organisation chart is collected — from the people it marks as heads and whom each reports to.')}
        </p>
      </div>
    );
  }
  const above = shown.length - heads.length;
  const named = above > 0
    ? (heads.length === 1
      ? t('1 head and {m} above them, as the organisation chart names them.', { m: above })
      : t('{n} heads and {m} above them, as the organisation chart names them.', { n: heads.length, m: above }))
    : (heads.length === 1
      ? t('1 head, as the organisation chart names them.')
      : t('{n} heads, as the organisation chart names them.', { n: heads.length }));
  return (
    <div className="relative flex-1">
      <div className="absolute left-4 top-3 z-10 max-w-[560px] rounded-xl border border-line bg-surface/95 px-3 py-2 text-[12px] text-muted shadow-sm">
        <p>
          {named} {t('Dashed: a line the chart marks as inferred. Click a person to open their department.')}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          <span className="inline-flex items-center gap-1.5"><svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="#94a3b8" strokeWidth="1.6" /></svg> {t('Reports to')}</span>
          <span className="inline-flex items-center gap-1.5"><svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="#94a3b8" strokeWidth="1.6" strokeDasharray="5 4" /></svg> {t('Inferred line')}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-1 rounded-sm bg-violet-500" /> {t('Department colour')}</span>
          <span className="inline-flex items-center gap-1.5"><span className="rounded-full bg-brand-50 px-1.5 text-[11px] font-semibold text-brand-700">n</span> {t('Direct reports')}</span>
        </p>
      </div>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.1 }}
        minZoom={0.1} maxZoom={1.6} nodesConnectable={false} proOptions={{ hideAttribution: true }}
        onPaneClick={() => setFocus(null)}>
        <NodeMeasurer ids={nodes.map((n) => n.id)} />
        <Background color="#e6e8f1" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
