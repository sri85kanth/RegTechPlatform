// ============================================================
// Company Brain CSV import — parse, validate, map to Entity.
// Pure functions, no I/O, so the rules are testable and the UI
// can show exactly why a row was rejected.
// ============================================================
import type { Entity, AnyDomain, Criticality, Lifecycle } from '@/types/entity';

/** entity_type in the file → Company Brain domain */
export const TYPE_TO_DOMAIN: Record<string, AnyDomain> = {
  person: 'people', people: 'people', employee: 'people',
  department: 'people', team: 'people', role: 'people',
  process: 'processes', procedure: 'processes',
  system: 'systems', application: 'systems', service: 'systems',
  data_asset: 'data', dataset: 'data', data: 'data',
  policy: 'policies',
  control: 'controls',
  risk: 'risks',
  evidence: 'evidence', document: 'evidence',
  // company context — these populate the Overview tabs, which had UI but no intake
  legal_entity: 'overview', legalentity: 'overview', entity: 'overview',
  location: 'overview', site: 'overview', jurisdiction: 'overview',
  // 'service' deliberately NOT mapped here: it already means an IT service in
  // the systems domain, and silently re-pointing it would move existing imports.
  product: 'overview', offering: 'overview',
  business_activity: 'overview', activity: 'overview', licence: 'overview', license: 'overview',
  industry: 'overview', sector: 'overview', org_unit: 'overview',
};

/**
 * entity_type -> the display type the Overview tabs filter on.
 * Without this an imported legal entity lands in the overview domain but shows
 * on no tab, because every tab filters by an exact type string.
 */
const OVERVIEW_SUBTYPE: Record<string, string> = {
  legal_entity: 'Legal Entity', legalentity: 'Legal Entity', entity: 'Legal Entity',
  location: 'Location', site: 'Location', jurisdiction: 'Jurisdiction',
  product: 'Product', offering: 'Product',
  business_activity: 'Business Activity', activity: 'Business Activity',
  licence: 'License', license: 'License',
  industry: 'Industry', sector: 'Industry', org_unit: 'Org Unit',
};
/** entity_type values that stay a sub-type inside the people domain */
const PEOPLE_SUBTYPE: Record<string, string> = { department: 'Department', team: 'Team', role: 'Role' };

export const REQUIRED_COLUMNS = ['entity_type', 'name'] as const;
export const ALL_COLUMNS = ['entity_id', 'entity_type', 'name', 'description', 'owner', 'criticality', 'lifecycle', 'source'] as const;

const CRITICALITIES = ['Critical', 'High', 'Medium', 'Low'];
const LIFECYCLES = ['Discovered', 'Draft', 'Pending Review', 'Verified', 'Active', 'Under Review', 'Superseded', 'Archived'];

/** RFC-4180-ish parser: handles quoted fields, embedded commas/newlines, CRLF, BOM. */
/** Excel exports "CSV" with , ; tab or | depending on locale — detect from the header line. */
export function detectDelimiter(text: string): string {
  const line = text.replace(/^\ufeff/, '').split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => ({ d, n: line.split(d).length - 1 }));
  const best = counts.sort((a, b) => b.n - a.n)[0];
  return best && best.n > 0 ? best.d : ',';
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const DELIM = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === DELIM) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export interface ParsedRow {
  line: number;
  raw: Record<string, string>;
  entity?: Entity;
  errors: string[];
  warnings: string[];
}
export interface ParseResult {
  headers: string[];
  missingColumns: string[];
  rows: ParsedRow[];
  validCount: number;
  errorCount: number;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Validate a parsed CSV against the Company Brain schema.
 * `existingIds` lets the UI flag collisions with data already in the graph.
 */
export function buildEntities(text: string, existingIds: Set<string>, defaultType?: string): ParseResult {
  const table = parseCsv(text);
  if (table.length === 0) {
    return { headers: [], missingColumns: [...REQUIRED_COLUMNS], rows: [], validCount: 0, errorCount: 0 };
  }
  const headers = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  // when a section fixes the type (People, Processes…) the file only needs `name`
  const required: string[] = defaultType ? ['name'] : [...REQUIRED_COLUMNS];
  const missingColumns = required.filter((c) => !headers.includes(c));
  const seenInFile = new Set<string>();
  const rows: ParsedRow[] = [];

  table.slice(1).forEach((cells, i) => {
    const raw: Record<string, string> = {};
    headers.forEach((h, ci) => { raw[h] = (cells[ci] ?? '').trim(); });

    const errors: string[] = [], warnings: string[] = [];
    const name = raw.name ?? '';
    const typeKey = (raw.entity_type || defaultType || '').toLowerCase().replace(/\s+/g, '_');

    if (!name) errors.push('name is required');
    if (!typeKey) errors.push('entity_type is required');
    else if (!TYPE_TO_DOMAIN[typeKey]) errors.push(`unknown entity_type "${raw.entity_type || typeKey}"`);

    const crit = raw.criticality ? titleCase(raw.criticality) : '';
    if (crit && !CRITICALITIES.includes(crit)) { warnings.push(`criticality "${raw.criticality}" not recognised — set to Medium`); }

    const life = raw.lifecycle ? raw.lifecycle.split(' ').map(titleCase).join(' ') : '';
    if (life && !LIFECYCLES.includes(life)) { warnings.push(`lifecycle "${raw.lifecycle}" not recognised — set to Discovered`); }

    let id = raw.entity_id || '';
    if (!id) {
      id = `imp-${typeKey || 'entity'}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}`;
      warnings.push('no entity_id — generated from name');
    }
    if (seenInFile.has(id)) errors.push(`duplicate entity_id "${id}" in this file`);
    else seenInFile.add(id);
    if (existingIds.has(id)) errors.push(`entity_id "${id}" already exists in the graph`);

    const domain = TYPE_TO_DOMAIN[typeKey];
    const entity: Entity | undefined = errors.length || !domain ? undefined : {
      id,
      domain,
      name,
      type: PEOPLE_SUBTYPE[typeKey] ?? OVERVIEW_SUBTYPE[typeKey] ?? titleCase(typeKey.replace(/_/g, ' ')),
      description: raw.description || undefined,
      status: 'Active',
      criticality: (CRITICALITIES.includes(crit) ? crit : 'Medium') as Criticality,
      lifecycle: (LIFECYCLES.includes(life) ? life : 'Discovered') as Lifecycle,
      verification: 'Pending',
      provenance: {
        source: 'CSV',
        sourceReference: raw.source || 'Manual CSV import',
        confidence: 100,
        createdAt: 'Just now',
        updatedAt: 'Just now',
      },
      attrs: {
        ...(raw.owner ? { ownerName: raw.owner } : {}),
        ...(raw.description ? { purpose: raw.description } : {}),
        importedFrom: raw.source || 'CSV upload',
      },
    };

    rows.push({ line: i + 2, raw, entity, errors, warnings });
  });

  return {
    headers,
    missingColumns,
    rows,
    validCount: rows.filter((r) => r.entity).length,
    errorCount: rows.filter((r) => r.errors.length).length,
  };
}

/**
 * The template offered for download — one placeholder row per domain.
 *
 * It used to ship nine complete rows of invented people and systems ("Priya
 * Sharma, Compliance Manager", "Core Banking System"). A template is imported
 * as-is more often than not, so those rows were one click away from becoming
 * entities in a real company's brain, owned by people who do not exist.
 * The columns still document themselves; the values are yours to supply.
 */
export const CSV_TEMPLATE = [
  ALL_COLUMNS.join(','),
  'PRC-001,process,<process name>,<what it does>,<owner full name>,High,Active,<where this came from>',
  'SYS-001,system,<system name>,<what it does>,<owner full name>,Critical,Active,<CMDB / spreadsheet / …>',
  'POL-001,policy,<policy name>,<what it governs>,<owner full name>,High,Active,<policy library>',
  'CTL-001,control,<control name>,<what it enforces>,<owner full name>,High,Active,<control register>',
  'RSK-001,risk,<risk name>,<the exposure>,<owner full name>,Critical,Active,<risk register>',
  'DAT-001,data_asset,<data asset name>,<what it holds>,<owner full name>,Critical,Active,<data catalogue>',
  'EVD-001,evidence,<evidence name>,<what it proves>,<owner full name>,Medium,Active,<evidence store>',
  'DPT-001,department,<department name>,<what it does>,<head full name>,High,Active,<HRIS>',
  'PPL-001,person,<full name>,<job title>,,High,Active,<HRIS>',
].join('\n');

/** Template for one section — the type is implied by the step, so the file stays short. */
export function templateFor(examples: string[][]): string {
  // The on-screen examples are hints beside an input; a downloaded file is
  // something people fill in and upload back. Shipping the hints as rows meant
  // the fictional names in them could be imported verbatim, so the file gets
  // the same number of placeholder rows instead of the examples themselves.
  return ['entity_id,name,description,owner,criticality',
    ...examples.map(() => ',<name>,<description>,<owner full name>,<High / Medium / Low>')].join('\n');
}


/* ============================================================
   Column mapping — the real-world blocker. A customer's file says
   "Process Name / Dept / Owner Email / Risk Rating"; ours wants
   name / description / owner / criticality. Rather than demand they
   rename columns, map theirs onto ours.
   ============================================================ */

export type FieldKey = 'name' | 'description' | 'owner' | 'criticality' | 'entity_id';

export const MAPPABLE_FIELDS: { key: FieldKey; label: string; required: boolean; hint: string }[] = [
  { key: 'name', label: 'Name', required: true, hint: 'What the thing is called' },
  { key: 'description', label: 'Description', required: false, hint: 'What it does' },
  { key: 'owner', label: 'Owner', required: false, hint: 'Person or team responsible' },
  { key: 'criticality', label: 'Criticality', required: false, hint: 'Critical / High / Medium / Low' },
  { key: 'entity_id', label: 'Reference ID', required: false, hint: 'Your own identifier, if you have one' },
];

/** Synonyms seen in real registers, used to pre-fill the mapping. */
const SYNONYMS: Record<FieldKey, string[]> = {
  name: ['name', 'title', 'process_name', 'system_name', 'policy_title', 'control_name', 'risk_name', 'label'],
  description: ['description', 'purpose', 'summary', 'detail', 'objective', 'what_it_does', 'scope'],
  owner: ['owner', 'responsible', 'accountable', 'custodian', 'process_owner', 'owner_name', 'owner_email', 'manager', 'department'],
  criticality: ['criticality', 'critical', 'priority', 'severity', 'risk_rating', 'rating', 'importance', 'tier'],
  entity_id: ['id', 'entity_id', 'ref', 'reference', 'code', 'identifier', 'number'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Best-guess mapping from the file's headers to our fields.
 *
 * Scores every (field, header) pair and assigns the strongest matches first,
 * rather than letting whichever field is checked first grab a column. Without
 * this, a header like "Policy Ref" wins `name` (it contains "policy") and the
 * real title column is left unmapped.
 */
export function suggestMapping(headers: string[]): Record<FieldKey, string> {
  const score = (field: FieldKey, header: string): number => {
    const n = norm(header);
    let best = 0;
    for (const sy of SYNONYMS[field]) {
      if (n === sy) best = Math.max(best, 4);                        // exact
      else if (n.split('_').includes(sy)) best = Math.max(best, 3);  // whole word
      else if (n.startsWith(sy) || n.endsWith(sy)) best = Math.max(best, 2);
      else if (n.includes(sy)) best = Math.max(best, 1);             // loose substring
    }
    // an id-ish column should never win `name`
    if (field === 'name' && /(^|_)(id|ref|code|no|number)(_|$)/.test(n)) best = Math.min(best, 1);
    return best;
  };

  const pairs: { field: FieldKey; header: string; s: number }[] = [];
  (Object.keys(SYNONYMS) as FieldKey[]).forEach((f) =>
    headers.forEach((h) => { const sc = score(f, h); if (sc > 0) pairs.push({ field: f, header: h, s: sc }); }),
  );
  pairs.sort((a, b) => b.s - a.s);

  const out = {} as Record<FieldKey, string>;
  (Object.keys(SYNONYMS) as FieldKey[]).forEach((f) => { out[f] = ''; });
  const takenHeaders = new Set<string>();
  for (const p of pairs) {
    if (out[p.field] || takenHeaders.has(p.header)) continue;
    out[p.field] = p.header;
    takenHeaders.add(p.header);
  }
  return out;
}

/** Rewrite a parsed table so its header row uses our field names. */
export function applyMapping(text: string, mapping: Record<FieldKey, string>): string {
  const table = parseCsv(text);
  if (!table.length) return text;
  const headers = table[0];
  const cols = (Object.keys(mapping) as FieldKey[]).filter((k) => mapping[k]);
  const idx = cols.map((k) => headers.indexOf(mapping[k]));
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    cols.join(','),
    ...table.slice(1).map((row) => idx.map((i) => esc(i >= 0 ? (row[i] ?? '') : '')).join(',')),
  ].join('\n');
}

/** Headers of a file, for the mapping UI. */
export function readHeaders(text: string): string[] {
  const t = parseCsv(text);
  return t.length ? t[0].map((h) => h.trim()).filter(Boolean) : [];
}
