// ============================================================
// Reading the company's structure as departments.
//
// Nothing here knows what a hospital is. A department's summary, its tree,
// its columns and its filters all come from the records that were collected
// into it, so a finance team's folder of policies and a biomedical equipment
// register get the same page, each explained by what it actually holds.
// ============================================================
import { DOMAINS } from '@/config/domains';
import type { FiledRecord, NodeSource, OrgNode } from '@/services/structureApi';
import { currentDateLocale, tNow, tx, type TFunction } from '@/i18n';

/**
 * The date locale for the chosen language, read when called, since these
 * helpers are not components. Every caller draws during render with useT(), so
 * it redraws when the language changes. English keeps the Indian format these
 * dates always had ("6 Nov 2026, 11:34 am").
 */
function dateLocale(): string {
  return currentDateLocale('en-IN');
}

// ------------------------------------------------------------ keys and words
/** Keys that say how a record was collected rather than what it is. They are
 *  shown under "Source" in a record's details, never as a field of it. */
export const PROVENANCE_KEYS = new Set([
  'evidence', 'evidenceCount', 'collectionContext', 'extraction', 'file', 'format', 'bytes',
]);

/** Short words registers write in capitals: "GRN no", "PO number", "Asset ID". */
const ACRONYMS = /\b(id|url|ip|po|grn|dc|srf|amc|cmc|pms|gst|pan|hod|sop|capa|mrn|dob)\b/gi;

export const isDetailKey = (k: string) => !PROVENANCE_KEYS.has(k) && !k.endsWith('__alternatives');

/** serialNo -> "Serial no", assetId -> "Asset ID". */
export function humanise(key: string): string {
  // "is_head" -> "Head", "is_returnable" -> "Returnable": the flag, not the question
  const spaced = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().replace(/^is\s+(?=\S)/i, '');
  const s = spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  return s.replace(ACRONYMS, (m) => m.toUpperCase());
}

export function plural(word: string, n: number): string {
  if (n === 1) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** "315 items", "1 item" */
export const items = (n: number) => (n === 1 ? tNow('1 item') : tNow('{n} items', { n: n.toLocaleString() }));

/**
 * A unit word as shown. Our own fallback "unit" is translated; a kind the
 * structure names ("department", "ward") is shown in the language when it is
 * a known word, and as given otherwise.
 */
export function unitWordText(t: TFunction, word: string, n = 1): string {
  if (word === 'unit') return n === 1 ? t('unit') : t('units');
  return t(plural(word, n));
}

/** "A", "A and B", "A, B and C" — in the chosen language. */
export function listText(t: TFunction, parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return t('{list} and {last}', { list: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

/** The name a kind of record goes by: its own type when the source gave one
 *  ("Equipment"), otherwise the domain it was placed in ("Policies"). */
export function kindLabel(domain: string, type?: string | null): string {
  if (type) return type;
  return (DOMAINS as Record<string, { title: string }>)[domain]?.title ?? domain;
}

export function sourceLabel(src: string): string {
  if (src === 'integration:http_csv') return tNow('an API');
  if (src === 'integration:folder') return tNow('a folder');
  if (!src) return tNow('an unrecorded source');
  return src.replace(/^integration:/, '').replace(/[_-]+/g, ' ');
}

/** "an API", "a folder and an API" */
export function sourcesText(srcs?: Record<string, number>): string {
  const entries = Object.entries(srcs ?? {}).sort((a, b) => b[1] - a[1]);
  // Many uploaded files read as a wall of file names; past three, say how many.
  const docs = entries.filter(([s]) => s.startsWith('document:'));
  if (docs.length > 3) {
    const rest = entries.filter(([s]) => !s.startsWith('document:')).map(([s]) => sourceLabel(s));
    const parts = [...rest, tNow('{n} documents', { n: docs.length.toLocaleString() })];
    return parts.length > 2 ? parts.join(', ') : listText(tNow, parts);
  }
  return listText(tNow, entries.map(([s]) => sourceLabel(s)));
}

// ------------------------------------------------------------ the org tree
export function byId(flat: OrgNode[]): Map<string, OrgNode> {
  return new Map(flat.map((n) => [n.id, n]));
}

/** root first, parent last — not including the node itself */
export function ancestorsOf(flat: OrgNode[], id: string): OrgNode[] {
  const m = byId(flat);
  const out: OrgNode[] = [];
  let cur = m.get(id);
  const seen = new Set<string>();
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    cur = m.get(cur.parent_id);
    if (cur) out.unshift(cur);
  }
  return out;
}

export function rootOf(flat: OrgNode[], id: string): string | undefined {
  const node = flat.find((n) => n.id === id);
  if (!node) return undefined;
  return ancestorsOf(flat, id)[0]?.id ?? node.id;
}

export function childrenOf(flat: OrgNode[], id: string): OrgNode[] {
  return flat.filter((n) => n.parent_id === id);
}

/** Does `node` sit at or below `under`? Paths are materialised, so a prefix says it. */
export function isWithin(node: OrgNode | undefined, under: OrgNode): boolean {
  return !!node && (node.id === under.id || node.path.startsWith(`${under.path}/`));
}

/**
 * What the sub-units of a node are called, from their own kind.
 *
 * Sub-units made from an API's "department" field are kind "Department", so
 * the breakdown reads "By department" — the equipment of Biomedical by the
 * department it is used in. Mixed or unnamed kinds fall back to "unit".
 */
export function groupWord(children: OrgNode[]): string {
  const kinds = new Set(children.map((c) => (c.kind ?? '').trim().toLowerCase()));
  const [only] = [...kinds];
  return kinds.size === 1 && only ? only : tx('unit');
}

// ------------------------------------------------------------ values
/**
 * How much attention a value asks for, read from its words.
 *
 * Only words the source itself used: "LIFE_SUPPORT" is red because it says
 * life support, not because this code decided which equipment matters.
 */
export type Tone = 'danger' | 'warn' | 'neutral' | 'ok' | 'muted' | 'high';

export function toneOf(value: string): Tone {
  const v = ` ${value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  // settled outcomes first, so "no complaint" is never read as "complaint"
  if (/ (no complaint|closed|resolved|completed|acknowledged|done) /.test(v)) return 'ok';
  if (/ (life support|breakdown|broken|out of service|failed|condemned|not working|expired) /.test(v)) return 'danger';
  if (/ (inactive|retired|disposed|decommissioned|archived) /.test(v)) return 'muted';
  if (/ non ?critical | (minor|low) /.test(v)) return 'muted';
  if (/ (critical) /.test(v)) return 'danger';
  if (/ (high) /.test(v)) return 'high';
  if (/ (under maintenance|maintenance|repair|overdue|due|pending|calibration due|open|awaiting|not visited|complaint) /.test(v)) return 'warn';
  if (/ (active|in service|working|operational|functional|ok|compliant|valid) /.test(v)) return 'ok';
  return 'neutral';
}

export const TONE_RANK: Record<Tone, number> = { danger: 0, high: 0.5, warn: 1, neutral: 2, ok: 3, muted: 4 };

export const TONE_CLASS: Record<Tone, string> = { high: 'bg-notcov-50 text-notcov-600',
  danger: 'bg-critical-50 text-critical-600',
  warn: 'bg-warning-50 text-warning-600',
  ok: 'bg-success-50 text-success-600',
  neutral: 'bg-slate-100 text-ink-2',
  muted: 'bg-slate-100 text-muted',
};

export const TONE_BAR: Record<Tone, string> = { high: 'bg-notcov-500',
  danger: 'bg-critical-500', warn: 'bg-warning-500', ok: 'bg-success-500',
  neutral: 'bg-brand-500/70', muted: 'bg-slate-400',
};

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function formatWhen(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return /[T ]\d{2}:\d{2}/.test(s)
    ? d.toLocaleString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

// Fields whose ALL-CAPS values are codes ("MAJOR"), not names ("MICU").
const CODE_FIELDS = new Set(['status', 'criticality', 'category', 'priority', 'severity', 'condition', 'state', 'risk',
  'finding', 'outcome', 'servicetype', 'invoicetype', 'handledby', 'coveragetype', 'repairroute', 'pendingreason',
  'equipmentcondition', 'type']);

/**
 * A value as a person reads it: "UNDER_MAINTENANCE" -> "Under maintenance",
 * "NON_CRITICAL" -> "Non-critical", an ISO timestamp -> "15 Sept 2026, 11:34 am".
 * Names are left exactly as the source typed them — "MICU" stays "MICU" — and
 * the record's details always keep the raw value too.
 */
export function showValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? tNow('Yes') : tNow('No');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v).trim();
  if (s === 'true' || s === 'false') return s === 'true' ? tNow('Yes') : tNow('No');
  if (/^\d{2}:\d{2}:00$/.test(s)) return s.slice(0, 5);                 // "13:30:00" -> "13:30"
  if (ISO.test(s)) return formatWhen(s);
  const bare = field.replace(/^attr\./, '').toLowerCase();
  const num = typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (!Number.isNaN(num) && /(amount|cost|price|value|total)$/.test(bare)) return rupees(num);
  if (!Number.isNaN(num) && /minutes$/.test(bare)) return duration(num);
  const code = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(s) || (CODE_FIELDS.has(bare) && /^[A-Z][A-Z0-9 ]*$/.test(s));
  if (!code) return s;
  const words = s.toLowerCase().replace(/_/g, ' ').replace(/^non /, 'non-');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 1800 -> "₹1,800", 1643689.5 -> "₹16,43,689.50" — Indian grouping, paise only when there are any. */
export function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** 80 -> "1 h 20 min", 45 -> "45 min", 2900 -> "2 d 0 h" */
export function duration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return tNow('{m} min', { m });
  if (m < 1440) return m % 60 ? tNow('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : tNow('{h} h', { h: Math.floor(m / 60) });
  return tNow('{d} d {h} h', { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60) });
}

/** "MINDRAY", "Mindray" and "mindray" are one make, counted once. */
export const keyOf = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');

function text(v: unknown): string | undefined {
  if (v === null || v === undefined || typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/** "A / B / C / D" -> ["A", "B", "C", "D"] */
export const partsOf = (v: string) => v.split(' / ').map((p) => p.trim()).filter(Boolean);

/** The part of a long path that identifies it: its last two parts. */
export function pathTail(v: string): string {
  const parts = partsOf(v);
  return parts.length > 2 ? parts.slice(-2).join(' / ') : v;
}

// ------------------------------------------------------------ fields
export interface FieldInfo {
  key: string;            // 'name' | 'status' | 'criticality' | 'attr.<key>'
  label: string;
  get: (r: FiledRecord) => string | undefined;
  present: number;
  missing: number;
}

// Our pipeline writes "Active" when a source says nothing about status, so a
// status that is "Active" on every record may be ours, not the source's.
const isDefaultStatus = (vals: Set<string>) => vals.size === 1 && vals.has('Active');

/** A register's own columns as its source sends them: [the key we read it by, the source's name for it]. */
export interface Layout {
  label: string;
  fields: [string, string][];
}

/**
 * Every field these records carry, with how many carry it — in the source's
 * own order and under its own names when a layout says them, so a complaint's
 * "priority" is not relabelled "criticality" just because that is where we
 * keep it.
 */
export function fieldsOf(rows: FiledRecord[], layout?: Layout): FieldInfo[] {
  const said = new Map((layout?.fields ?? []).map(([k, h], i) => [k, { h, i }]));
  const named = (key: string, fallback: string) => {
    const h = said.get(key)?.h;
    return h ? humanise(h) : fallback;
  };
  const defs: { key: string; label: string; get: (r: FiledRecord) => string | undefined }[] = [
    { key: 'name', label: 'Name', get: (r) => text(r.name) },
  ];
  const statuses = new Set(rows.map((r) => text(r.status)).filter(Boolean) as string[]);
  if (statuses.size && !isDefaultStatus(statuses)) defs.push({ key: 'status', label: named('status', tx('Status')), get: (r) => text(r.status) });
  if (rows.some((r) => text(r.criticality))) defs.push({ key: 'criticality', label: named('criticality', tx('Criticality')), get: (r) => text(r.criticality) });
  if (rows.some((r) => text(r.description))) defs.push({ key: 'description', label: named('description', tx('Description')), get: (r) => text(r.description) });
  // Each key a record adds is placed after the key it follows in that record,
  // so a field most records leave out still sits where the source puts it.
  const keys: string[] = [];
  for (const r of rows) {
    let at = -1;
    for (const k of Object.keys(r.attrs ?? {})) {
      if (!isDetailKey(k)) continue;
      const i = keys.indexOf(k);
      if (i >= 0) at = i; else keys.splice(++at, 0, k);
    }
  }
  for (const k of keys) defs.push({ key: `attr.${k}`, label: named(`attr.${k}`, humanise(k)), get: (r) => text(r.attrs?.[k]) });
  if (said.size) {
    // the name first; then the source's order; what it never listed, after
    const pos = (k: string) => (k === 'name' ? -1 : said.get(k)?.i ?? Number.MAX_SAFE_INTEGER);
    defs.sort((a, b) => pos(a.key) - pos(b.key));
  }
  return defs.map((d) => {
    const present = rows.filter((r) => d.get(r) !== undefined).length;
    return { ...d, present, missing: rows.length - present };
  });
}

/** The attribute that repeats the record's own reference (asset ID, employee ID…). */
export function referenceField(rows: FiledRecord[], fields: FieldInfo[]): FieldInfo | undefined {
  return fields.find((f) => f.key.startsWith('attr.') && rows.length > 0 &&
    rows.filter((r) => r.source_reference && f.get(r) === r.source_reference).length >= rows.length * 0.9);
}

// ------------------------------------------------------------ facets
export interface FacetValue {
  key: string;
  label: string;
  n: number;
  tone: Tone;
  /** every way the source spelled it, when there was more than one */
  spellings: [string, number][];
}

export interface Facet {
  key: string;                 // a field key, or 'units'
  label: string;               // "Department", "Location", "Equipment type"
  kind: 'units' | 'path' | 'value';
  toned: boolean;              // status / criticality: each value carries a tone
  values: FacetValue[];
  missing: number;
  /** path facets: the leading parts every value shares ("Hospital / Main Building") */
  prefix: string[];
  get: (r: FiledRecord) => string | undefined;
}

function countValues(rows: FiledRecord[], field: string, get: (r: FiledRecord) => string | undefined, toned: boolean) {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const v = get(r);
    if (v === undefined) continue;
    const k = keyOf(v);
    const sp = m.get(k) ?? new Map<string, number>();
    sp.set(v, (sp.get(v) ?? 0) + 1);
    m.set(k, sp);
  }
  const values: FacetValue[] = [...m.entries()].map(([k, sp]) => {
    const spellings = [...sp.entries()].sort((a, b) => b[1] - a[1]);
    const label = showValue(field, spellings[0][0]);
    return { key: k, label, n: spellings.reduce((s, [, n]) => s + n, 0),
      tone: toned ? toneOf(spellings[0][0]) : 'neutral', spellings: spellings.length > 1 ? spellings : [] };
  });
  values.sort((a, b) => (toned ? TONE_RANK[a.tone] - TONE_RANK[b.tone] : 0) || b.n - a.n || a.label.localeCompare(b.label));
  return values;
}

export interface Described {
  fields: FieldInfo[];
  facets: Facet[];             // ordered for "Organise by"
  names?: Facet;
  status?: Facet;
  criticality?: Facet;
  reference?: FieldInfo;
  /** fields whose values say how things stand — status, priority, a walk-through's finding */
  signals: Facet[];
}

/**
 * What a set of records is made of: which of its fields group it (a department,
 * a location, a make) and which merely identify one record (an asset ID).
 *
 * A field groups when its values repeat: 19 departments across 282 records
 * do, 315 asset IDs across 315 records do not. A field whose values are
 * mostly "A / B / C" is a place in a hierarchy and becomes a tree.
 */
export function describe(rows: FiledRecord[], opts: {
  kind: string; units?: { node: OrgNode; n: number }[]; unitWord?: string;
  unitOf?: (r: FiledRecord) => string | undefined; layout?: Layout;
}): Described {
  const fields = fieldsOf(rows, opts.layout);
  const reference = referenceField(rows, fields);
  const n = rows.length;
  const facets: Facet[] = [];

  let unitFacet: Facet | undefined;
  if (opts.units?.length && opts.unitOf) {
    const label = opts.unitWord ? opts.unitWord.charAt(0).toUpperCase() + opts.unitWord.slice(1) : tx('Unit');
    const counts = new Map<string, number>();
    let missing = 0;
    for (const r of rows) {
      const u = opts.unitOf(r);
      if (u) counts.set(u, (counts.get(u) ?? 0) + 1); else missing += 1;
    }
    const values = opts.units.filter((u) => counts.get(u.node.id))
      .map((u) => ({ key: u.node.id, label: u.node.name, n: counts.get(u.node.id) ?? 0, tone: 'neutral' as Tone, spellings: [] }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    // A register none of whose records sits in a sub-unit (invoices, say) has
    // no "by department" to offer — not one group called "not given".
    if (values.length) {
      unitFacet = { key: 'units', label, kind: 'units', toned: false, missing, prefix: [], get: opts.unitOf, values };
      facets.push(unitFacet);
    }
  }

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const make = (f: FieldInfo, label: string, toned: boolean): Facet => ({
    key: f.key, label, kind: 'value', toned, missing: f.missing, prefix: [], get: f.get,
    values: countValues(rows, f.key, f.get, toned),
  });

  const status = byKey.get('status') ? make(byKey.get('status')!, byKey.get('status')!.label, true) : undefined;
  const criticality = byKey.get('criticality') ? make(byKey.get('criticality')!, byKey.get('criticality')!.label, true) : undefined;

  const nameField = byKey.get('name')!;
  // display only (never compared), so translated here: "Equipment type"
  const nameFacet = make(nameField, tNow('{kind} type', { kind: opts.kind }), false);
  const names = nameFacet.values.length >= 2 && nameFacet.values.length < n * 0.8 ? nameFacet : undefined;

  const paths: Facet[] = [];
  const others: Facet[] = [];
  for (const f of fields) {
    if (!(f.key.startsWith('attr.') || f.key === 'description') || f === reference || f.present < 2) continue;
    // a count, an amount or a duration is measured, not grouped by; bookkeeping is neither
    if (MEASURE.test(f.key) || NOT_A_COLUMN.test(f.key)) continue;
    // the field the sub-units were made from would only repeat them
    if (unitFacet && f.label.toLowerCase() === unitFacet.label.toLowerCase()) continue;
    const vals = rows.map(f.get).filter(Boolean) as string[];
    if (vals.some((v) => ISO.test(v))) continue;                     // a timestamp names no group
    const isPath = vals.filter((v) => partsOf(v).length > 1 && v.includes(' / ')).length >= vals.length * 0.5;
    const facet = make(f, f.label, false);
    const distinct = facet.values.length;
    if (isPath) {
      // The leading parts every value shares — "Premier Hospital – Kokapet /
      // Main Building" — stated once, so a breakdown starts where values differ.
      const split = vals.map(partsOf);
      const prefix: string[] = [];
      for (let i = 0; ; i++) {
        const first = split[0]?.[i];
        if (first === undefined || !split.every((p) => p[i] === first)) break;
        if (!split.some((p) => p.length > i + 1)) break;          // nothing below it to group by
        prefix.push(first);
      }
      paths.push({ ...facet, kind: 'path', prefix });
    } else if (distinct >= 2 && distinct <= Math.max(12, f.present * 0.5)) {
      others.push(facet);
    }
  }
  others.sort((a, b) => (b.values.reduce((s, v) => s + v.n, 0) - a.values.reduce((s, v) => s + v.n, 0))
    || a.values.length - b.values.length);

  // Any other field whose values carry a verdict — a walk-through's finding,
  // a call's outcome — is a signal too. One value on every record is not, and
  // neither is free text: "Display not working" describes a complaint; only a
  // coded value the source chose from a list ("NOT_VISITED") is a verdict.
  for (const f of others) {
    const raw = rows.map(f.get).filter(Boolean) as string[];
    const coded = raw.filter((v) => CODED.test(v)).length >= raw.length * 0.9;
    const toned = f.values.filter((v) => toneOf(v.spellings[0]?.[0] ?? v.label) !== 'neutral');
    if (coded && f.values.length >= 2 && toned.length) {
      f.toned = true;
      for (const v of f.values) v.tone = toneOf(v.spellings[0]?.[0] ?? v.label);
      f.values.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
    }
  }
  facets.push(...paths);
  if (names) facets.push(names);
  if (criticality && criticality.values.length) facets.push(criticality);
  if (status && status.values.length) facets.push(status);
  facets.push(...others);
  const signals = [criticality, status, ...others.filter((f) => f.toned)]
    .filter((f): f is Facet => !!f && f.values.length >= 2);
  return { fields, facets, names, status, criticality, reference, signals };
}

const MEASURE = /(count|quantity|qty|minutes|amount|total|cost|price|value)$/i;
const CODED = /^[A-Z0-9]+(?:[_ ][A-Z0-9]+)*$/;

/** The value key a record has for a facet — what filters and trees compare. */
export function valueKey(facet: Facet, r: FiledRecord): string | undefined {
  if (facet.kind === 'units') return facet.get(r);
  const v = facet.get(r);
  return v === undefined ? undefined : keyOf(v);
}

/** The danger and warning values among some records: "Life support 3", "Under maintenance 1". */
export function flagsOf(records: FiledRecord[], d: Described): { label: string; tone: Tone; n: number }[] {
  const out: { label: string; tone: Tone; n: number }[] = [];
  for (const f of d.signals) {
    for (const v of f.values) {
      if (v.tone !== 'danger' && v.tone !== 'warn') continue;
      const n = records.filter((r) => valueKey(f, r) === v.key).length;
      if (n) out.push({ label: v.label, tone: v.tone, n });
    }
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.n - a.n);
}

// ------------------------------------------------------------ grouping into a tree
export interface Group {
  id: string;
  label: string;
  /** records sitting exactly at this group */
  items: FiledRecord[];
  groups: Group[];
  /** every record at or below this group */
  all: FiledRecord[];
  missing?: boolean;
}

/**
 * Records arranged by one facet. A path facet nests — Hospital > Building >
 * Floor > Area > Room — with each record placed where its own path ends. Any
 * other facet is one level. Records with no value are kept, in a group that
 * says so, never dropped.
 */
export function groupBy(rows: FiledRecord[], facet: Facet, missingLabel: string): Group[] {
  const top: Group[] = [];
  const missing: FiledRecord[] = [];
  if (facet.kind === 'path') {
    const root: Group = { id: facet.key, label: '', items: [], groups: [], all: [] };
    for (const r of rows) {
      const v = facet.get(r);
      if (v === undefined) { missing.push(r); continue; }
      let at = root;
      at.all.push(r);
      for (const part of partsOf(v)) {
        const id = `${at.id}/${keyOf(part)}`;
        let next = at.groups.find((g) => g.id === id);
        if (!next) { next = { id, label: part, items: [], groups: [], all: [] }; at.groups.push(next); }
        next.all.push(r);
        at = next;
      }
      at.items.push(r);
    }
    const sort = (g: Group) => { g.groups.sort((a, b) => b.all.length - a.all.length || a.label.localeCompare(b.label)); g.groups.forEach(sort); };
    sort(root);
    top.push(...root.groups);
  } else {
    const byKey = new Map<string, Group>();
    for (const v of facet.values) byKey.set(v.key, { id: `${facet.key}:${v.key}`, label: v.label, items: [], groups: [], all: [] });
    for (const r of rows) {
      const k = valueKey(facet, r);
      const g = k === undefined ? undefined : byKey.get(k);
      if (!g) { missing.push(r); continue; }
      g.items.push(r); g.all.push(r);
    }
    top.push(...[...byKey.values()].filter((g) => g.all.length));
  }
  if (missing.length) top.push({ id: `${facet.key}:-`, label: missingLabel, items: missing, groups: [], all: missing, missing: true });
  return top;
}

/** Break a long list of records into their types, so 81 items in one room read as 12 kinds. */
export function byName(records: FiledRecord[], prefix: string): Group[] {
  const m = new Map<string, Group>();
  const spell = new Map<string, Map<string, number>>();
  for (const r of records) {
    const k = keyOf(r.name);
    if (!m.has(k)) m.set(k, { id: `${prefix}~${k}`, label: r.name, items: [], groups: [], all: [] });
    const g = m.get(k)!;
    g.items.push(r); g.all.push(r);
    const sp = spell.get(k) ?? new Map<string, number>();
    sp.set(r.name, (sp.get(r.name) ?? 0) + 1);
    spell.set(k, sp);
  }
  for (const [k, g] of m) g.label = [...spell.get(k)!.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return [...m.values()].sort((a, b) => b.all.length - a.all.length || a.label.localeCompare(b.label));
}

// ------------------------------------------------------------ kinds of record
export interface KindGroup {
  /** stable across reloads, used in the URL */
  id: string;
  label: string;
  domain: string;
  rows: FiledRecord[];
  /** more than one type inside this domain, so the table shows a Type column */
  mixed: boolean;
}

/**
 * One register per kind of record — Complaint, Invoice, Equipment — each with
 * its own tab, so an invoice is never a row in the complaints' table.
 * Documents read from a folder can carry dozens of types; past a handful the
 * tabs fall back to one per domain, each with a Type column.
 */
export function groupByKind(rows: FiledRecord[]): KindGroup[] {
  const byType = new Map<string, FiledRecord[]>();
  for (const r of rows) {
    const k = `${r.domain}::${r.type ?? ''}`;
    const list = byType.get(k);
    if (list) list.push(r); else byType.set(k, [r]);
  }
  if (byType.size <= 8) {
    return [...byType.entries()]
      .map(([k, list]) => {
        const [domain, type] = k.split('::');
        const id = slugOf(`${type || domain}`);
        return { id: TAB_IDS.has(id) ? `${id}-register` : id, domain, rows: list, mixed: false,
          label: kindLabel(domain, type || null) };
      })
      .sort((a, b) => b.rows.length - a.rows.length);
  }
  const m = new Map<string, FiledRecord[]>();
  for (const r of rows) {
    const list = m.get(r.domain);
    if (list) list.push(r); else m.set(r.domain, [r]);
  }
  return [...m.entries()]
    .map(([domain, list]) => {
      const types = new Set(list.map((r) => r.type ?? ''));
      const mixed = types.size > 1;
      const [only] = [...types];
      return { id: domain, domain, rows: list, mixed, label: mixed ? kindLabel(domain) : kindLabel(domain, only) };
    })
    .sort((a, b) => b.rows.length - a.rows.length);
}

// A department page's own tabs; a register must never share one's id.
const TAB_IDS = new Set(['summary', 'structure', 'units']);

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'records';

/**
 * Registers in the order their connection reads them — the equipment list
 * first, then complaints, invoices… — not by size. Registers no connection
 * describes follow, largest first.
 */
export function inFeedOrder(kinds: KindGroup[], sources: NodeSource[]): KindGroup[] {
  const at = new Map<string, number>();
  for (const s of sources) for (const t of Object.keys(s.layouts ?? {})) if (!at.has(t)) at.set(t, at.size);
  const pos = (k: KindGroup) => (k.mixed ? undefined : at.get(k.rows[0]?.type ?? '')) ?? Number.MAX_SAFE_INTEGER;
  return [...kinds].sort((a, b) => pos(a) - pos(b) || b.rows.length - a.rows.length);
}

/**
 * The layout a register's source sent, and which connection sent it — found
 * by the type its records carry. A register mixing types has none.
 */
export function layoutFor(k: KindGroup, sources: NodeSource[]): { layout: Layout; from: NodeSource } | undefined {
  if (k.mixed) return undefined;
  const type = k.rows[0]?.type;
  if (!type) return undefined;
  for (const s of sources) {
    const layout = s.layouts?.[type];
    if (layout?.fields?.length) return { layout, from: s };
  }
  return undefined;
}

/**
 * What a register tab is called: the source's own name for it when it gave
 * one ("Invoice handover register", "Organisation chart"), else "Complaint
 * register", "People". A feed named only by its connection says nothing more.
 */
export function registerTitle(k: KindGroup, found?: { layout: Layout; from: NodeSource }): string {
  const own = found?.layout.label?.trim();
  if (own && own !== found?.from.label) return own;
  if (k.domain === 'people') return k.label === 'Person' ? tx('People') : k.label;
  return /register$/i.test(k.label) ? k.label : `${k.label} register`;
}

/** "invoices", "people", "equipment items" — what n records of a kind are called */
export function nounOf(label: string, n: number): string {
  const word = label.toLowerCase();
  if (word === 'person') return n === 1 ? 'person' : 'people';
  if (/^(equipment|evidence|data|information|software|hardware|staff|inventory)$/.test(word)) return `${word} ${plural('item', n)}`;
  return plural(word, n);
}

/** "65 invoices", "374 people", "315 equipment items" */
export const countOf = (label: string, n: number) => `${n.toLocaleString()} ${nounOf(label, n)}`;

/** The field a register is dated by — the first whose values are dates. */
export function dateFieldOf(fields: FieldInfo[], rows: FiledRecord[]): FieldInfo | undefined {
  return fields.find((f) => f.key.startsWith('attr.') && !/updated|created/i.test(f.key)
    && rows.slice(0, 30).some((r) => ISO.test(f.get(r) ?? '')));
}

/** The field a register's money is in, when it has one. */
export function amountFieldOf(fields: FieldInfo[]): FieldInfo | undefined {
  return fields.find((f) => /(^|\.)amount$/i.test(f.key));
}

/**
 * Did the source itself say this record was made by a demo loader rather than
 * imported? Read only from the source's own words — a partner API sends
 * "Demo: Excel installation database" as a record's origin — never guessed from
 * how a record looks.
 */
export function demoOrigin(r: FiledRecord): string | undefined {
  for (const k of ['recordOrigin', 'origin', 'sourceReference']) {
    const v = r.attrs?.[k];
    if (typeof v === 'string' && /^demo\b/i.test(v.trim())) return v.trim();
  }
  return undefined;
}

/**
 * Is the record's name only its other fields joined — "INV-104 · Medtronic",
 * "2026-09-01 · MICU"? Then the fields themselves are the columns, as on the
 * source's own page, and the joined name would only repeat them.
 */
export function nameIsComposed(rows: FiledRecord[], fields: FieldInfo[]): boolean {
  const sample = rows.slice(0, 200);
  if (!sample.length) return false;
  const others = fields.filter((f) => f.key !== 'name');
  const composed = sample.filter((r) => {
    const parts = r.name.split(' · ').map((p) => p.trim());
    return parts.length > 1 && parts.every((p) => / not recorded$/i.test(p) || others.some((f) => f.get(r) === p));
  }).length;
  return composed >= sample.length * 0.9;
}

export interface Column { key: string; label: string; field?: FieldInfo; numeric?: boolean }

// When a record was written or changed here, and where it was imported from,
// are details of the record, not columns of the register.
const NOT_A_COLUMN = /^attr\.(updatedAt|createdAt|syncedAt|lastSeenAt|recordOrigin)$/;
const MAX_COLUMNS = 12;

/**
 * A register's columns: the source's own fields in the source's own order,
 * as many as fit — its status and any amount always among them.
 *
 * Left out, and kept in each row's details: a joined name that only repeats
 * other columns, when a record was written, and a field that merely points at
 * another row of the same register (reports_to_id -> P-12) — the name it
 * points at is shown instead.
 */
export function registerColumns(k: KindGroup, d: Described): Column[] {
  const composed = nameIsComposed(k.rows, d.fields);
  const refs = new Set(k.rows.map((r) => r.source_reference).filter(Boolean) as string[]);
  const pointsAtRow = (f: FieldInfo) => {
    if (f === d.reference || !f.key.startsWith('attr.')) return false;
    const vals = k.rows.map(f.get).filter(Boolean) as string[];
    return vals.length > 0 && vals.filter((v) => refs.has(v)).length >= vals.length * 0.9;
  };
  const eligible = d.fields.filter((f) => f.present > 0 && !NOT_A_COLUMN.test(f.key)
    && !(composed && f.key === 'name') && !pointsAtRow(f));
  const must = (f: FieldInfo) => f.key === 'status' || f.key === 'criticality' || /amount$/i.test(f.key);
  const late = eligible.slice(MAX_COLUMNS).filter(must);
  const chosen = [...eligible.slice(0, MAX_COLUMNS - late.length), ...late];
  const cols: Column[] = chosen.map((f) => {
    const vals = k.rows.slice(0, 200).map(f.get).filter(Boolean) as string[];
    const numeric = vals.length > 0 && vals.every((v) => /^-?\d+(\.\d+)?$/.test(v));
    return { key: f.key, label: f.key === 'name' && !composed ? (k.domain === 'people' ? 'Name' : k.label) : f.label, field: f, numeric };
  });
  if (k.mixed) cols.splice(1, 0, { key: 'type', label: 'Type' });
  return cols;
}

/**
 * Several registers read as one — for the department's tree and its sub-unit
 * cards. It groups only by what they share: the department, the register
 * itself, and fields at least two registers carry (an asset ID, the equipment).
 * Status and criticality are left out on purpose: an equipment item's
 * "Critical" and a complaint's "Critical" priority are different things, and
 * one count of both would be wrong.
 */
export function describeAll(rows: FiledRecord[], kinds: KindGroup[], titles: Map<string, string>, opts: {
  units?: { node: OrgNode; n: number }[]; unitWord?: string; unitOf?: (r: FiledRecord) => string | undefined;
}): Described {
  const d = describe(rows, { kind: 'Record', ...opts });
  const kindOf = new Map<string, KindGroup>();
  for (const k of kinds) for (const r of k.rows) kindOf.set(r.id, k);
  const titleOf = (r: FiledRecord) => {
    const k = kindOf.get(r.id);
    return k ? titles.get(k.id) ?? k.label : undefined;
  };
  const register: Facet = {
    key: 'register', label: 'Register', kind: 'value', toned: false, missing: 0, prefix: [], get: titleOf,
    values: kinds.map((k) => {
      const label = titles.get(k.id) ?? k.label;
      return { key: keyOf(label), label, n: k.rows.length, tone: 'neutral' as Tone, spellings: [] };
    }),
  };
  const shared = d.facets.filter((f) => f.kind !== 'units' && f.key.startsWith('attr.')
    && kinds.filter((k) => k.rows.some((r) => f.get(r) !== undefined)).length >= 2);
  const unitFacet = d.facets.filter((f) => f.kind === 'units');
  return { ...d, facets: [...unitFacet, register, ...shared], names: undefined, status: undefined, criticality: undefined, signals: [] };
}

export function matches(r: FiledRecord, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (r.name.toLowerCase().includes(needle)) return true;
  if ((r.source_reference ?? '').toLowerCase().includes(needle)) return true;
  if ((r.status ?? '').toLowerCase().replace(/_/g, ' ').includes(needle)) return true;
  if ((r.criticality ?? '').toLowerCase().replace(/_/g, ' ').includes(needle)) return true;
  if ((r.description ?? '').toLowerCase().includes(needle)) return true;
  return Object.values(r.attrs ?? {}).some((v) =>
    (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(needle));
}
