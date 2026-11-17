// ============================================================
// Colour and icon for a department — presentation only.
//
// A department keeps one categorical colour everywhere it appears (the
// Departments list, its own page, the org chart), taken from its place among
// the top-level departments, so the first eight never share a colour. The
// icon is read from the department's own name; an unknown name gets the
// plain folder. Neither says anything about the department's state — status
// colours (green / amber / red / orange / slate) are never used here.
// ============================================================
import type { OrgNode } from '@/services/structureApi';
import { ancestorsOf, type Tone } from './model';

export interface Accent {
  hex: string;
  /** tinted icon tile: soft background + strong foreground */
  tile: string;
  /** a solid dot / bar */
  dot: string;
  /** coloured top edge of a card */
  edge: string;
  /** soft chip */
  chip: string;
}

/** blue, violet, teal, pink, sky, emerald, indigo, amber — the categorical set. */
export const ACCENTS: Accent[] = [
  { hex: '#2563eb', tile: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500', edge: 'border-t-blue-500', chip: 'bg-blue-50 text-blue-700' },
  { hex: '#8b5cf6', tile: 'bg-violet-50 text-violet-600', dot: 'bg-violet-500', edge: 'border-t-violet-500', chip: 'bg-violet-50 text-violet-700' },
  { hex: '#14b8a6', tile: 'bg-teal-50 text-teal-600', dot: 'bg-teal-500', edge: 'border-t-teal-500', chip: 'bg-teal-50 text-teal-700' },
  { hex: '#ec4899', tile: 'bg-pink-50 text-pink-600', dot: 'bg-pink-500', edge: 'border-t-pink-500', chip: 'bg-pink-50 text-pink-700' },
  { hex: '#0ea5e9', tile: 'bg-sky-50 text-sky-600', dot: 'bg-sky-500', edge: 'border-t-sky-500', chip: 'bg-sky-50 text-sky-700' },
  { hex: '#10b981', tile: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500', edge: 'border-t-emerald-500', chip: 'bg-emerald-50 text-emerald-700' },
  { hex: '#6366f1', tile: 'bg-indigo-50 text-indigo-600', dot: 'bg-indigo-500', edge: 'border-t-indigo-500', chip: 'bg-indigo-50 text-indigo-700' },
  { hex: '#f59e0b', tile: 'bg-amber-50 text-amber-600', dot: 'bg-amber-500', edge: 'border-t-amber-500', chip: 'bg-amber-50 text-amber-700' },
];

export const accentAt = (i: number): Accent => ACCENTS[((i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
/** A stable colour from a name alone — for lists that are not the org tree. */
export const accentForName = (name: string): Accent => ACCENTS[hash(name.trim().toLowerCase()) % ACCENTS.length];

/** The top-level departments in one fixed order: as placed in Edit structure, then by name. */
export function rootOrder(flat: OrgNode[]): OrgNode[] {
  return flat.filter((n) => !n.parent_id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
}

/** The colour of the department a node sits in (its top-level ancestor). */
export function deptAccent(flat: OrgNode[], id: string | undefined): Accent {
  if (!id) return ACCENTS[0];
  const node = flat.find((n) => n.id === id);
  if (!node) return ACCENTS[0];
  const root = ancestorsOf(flat, node.id)[0] ?? node;
  const i = rootOrder(flat).findIndex((r) => r.id === root.id);
  return i < 0 ? accentForName(root.name) : accentAt(i);
}

/** An icon read from the department's own name. */
const ICON_RULES: [RegExp, string][] = [
  [/nurs|ward/i, 'HeartPulse'],
  [/biomed|bme|equipment|engineer|maintenance/i, 'Wrench'],
  [/\bhr\b|human|personnel|people|staff|training/i, 'Users'],
  [/pharm|drug|medicine/i, 'Pill'],
  [/lab|patholog|blood/i, 'Microscope'],
  [/radiol|imaging|x-?ray|scan/i, 'Radar'],
  [/quality|accredit|nabh/i, 'BadgeCheck'],
  [/infection/i, 'ShieldAlert'],
  [/emergenc|casualty|icu|critical care|trauma/i, 'Siren'],
  [/finance|account|billing|revenue|invoice/i, 'Briefcase'],
  [/purchase|procure|store|supply|inventory/i, 'Package'],
  [/\bit\b|information|tech|digital|record|mrd/i, 'Cpu'],
  [/facilit|safety|fire|security|housekeep/i, 'Building2'],
  [/admin|management|board|director|office/i, 'Building'],
  [/clinic|medical|doctor|surg|physician|opd|ot\b|theat/i, 'Stethoscope'],
  [/diet|food|kitchen|nutrition/i, 'Leaf'],
  [/legal|compliance|regulat/i, 'Scale'],
];
export function deptIcon(name: string | undefined): string {
  const n = name ?? '';
  return ICON_RULES.find(([re]) => re.test(n))?.[1] ?? 'FolderTree';
}

/** Hex for a value's tone — the same meanings as the pills. */
export const TONE_HEX: Record<Tone, string> = {
  danger: '#dc2626', high: '#f97316', warn: '#f59e0b', ok: '#16a34a', neutral: '#2563eb', muted: '#94a3b8',
};
