// ============================================================
// What a node's counts say — read from the counts the server keeps for the
// structure, so a list of departments needs no records fetched.
// ============================================================
import type { OrgNode, Structure } from '@/services/structureApi';
import { showValue, toneOf, TONE_RANK, type Tone } from './model';

export interface Flag { label: string; tone: Tone; n: number }

/** The source's own status / criticality values that ask for attention, worst first. */
export function flagsFor(counts: Structure['counts'] | undefined, id: string): Flag[] {
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

/** Every status / criticality value under a node, toned — for a status-mix bar. */
export function mixFor(counts: Structure['counts'] | undefined, id: string): Flag[] {
  const signals = counts?.signals?.[id];
  const out = new Map<string, Flag>();
  const add = (label: string, tone: Tone, n: number) => {
    const f = out.get(label);
    if (f) f.n += n; else out.set(label, { label, tone, n });
  };
  if (signals) {
    // status only: an item's criticality and its status would count it twice
    for (const x of signals) if (x.field === 'status') add(showValue(x.field, x.value), toneOf(x.value), x.n);
  } else {
    for (const [v, n] of Object.entries(counts?.status?.[id] ?? {})) add(showValue('status', v), toneOf(v), n);
  }
  return [...out.values()].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
}

/** A node's head: the one a person typed in, else the one(s) an organisation chart names. */
export function headFor(node: OrgNode, counts: Structure['counts'] | undefined):
  { head?: string; headRole?: string | null; headFromChart?: boolean; moreHeads?: number } {
  if (node.head_name) return { head: node.head_name, headRole: node.head_role };
  const chart = counts?.heads?.[node.id] ?? [];
  if (!chart.length) return {};
  return { head: chart[0].name, headRole: chart[0].role, headFromChart: true, moreHeads: chart.length - 1 };
}
