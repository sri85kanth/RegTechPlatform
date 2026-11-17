import type { Entity } from '@/types/entity';

/** Tailwind class combiner. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function plural(noun: string): string {
  if (noun === 'Person') return 'People';
  if (noun === 'Evidence') return 'Evidence';
  if (/[sxz]$|[cs]h$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Resolve a column/filter key to a value from an entity (base field or attr). */
export function getField(e: Entity, key: string): string | number | boolean | undefined {
  switch (key) {
    case 'name':
      return e.name;
    case 'type':
      return e.type;
    case 'status':
      return e.status;
    case 'criticality':
      return e.criticality;
    case 'verification':
      return e.verification;
    case 'lifecycle':
      return e.lifecycle;
    case 'ownerId':
      return e.ownerId;
    case 'updatedAt':
      return e.provenance.updatedAt;
    case 'createdAt':
      return e.provenance.createdAt;
    default:
      return e.attrs[key] ?? (FIELD_ALIAS[key] ? e.attrs[FIELD_ALIAS[key]] : undefined);
  }
}

/**
 * The same fact under the name a collector actually used. A licence read from
 * documents arrives as issuedBy / certificateNo / expiryDate; the tables ask for
 * authority / number / validTill, and showed "—" while the value sat right there.
 */
const FIELD_ALIAS: Record<string, string> = { authority: 'issuedBy', number: 'certificateNo', validTill: 'expiryDate' };

export type Tone = 'green' | 'amber' | 'red' | 'orange' | 'blue' | 'purple' | 'teal' | 'gray';

// Status colours have one meaning each across the product:
// green = met/compliant, amber = partial/medium, red = gap/critical,
// orange = not covered/high, slate = not applicable/low.
const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-success-50 text-success-600',
  amber: 'bg-warning-50 text-warning-600',
  red: 'bg-critical-50 text-critical-600',
  orange: 'bg-notcov-50 text-notcov-600',
  blue: 'bg-brand-50 text-brand-700',
  purple: 'bg-violet-50 text-violet-700',
  teal: 'bg-teal-50 text-teal-700',
  gray: 'bg-slate-100 text-slate-600',
};

const STATUS_TONE: Record<string, Tone> = {
  Verified: 'green', Active: 'green', Effective: 'green', Current: 'green', Approved: 'green', Completed: 'green', Mitigated: 'green', 'Within Appetite': 'green',
  Pending: 'amber', 'Needs Review': 'amber', 'Under Review': 'blue', 'Partially Effective': 'amber', 'Approaching Expiry': 'amber', Open: 'amber',
  Rejected: 'red', Expired: 'red', Ineffective: 'red', Overdue: 'red', Draft: 'gray', 'Not Tested': 'gray', Superseded: 'gray', Archived: 'gray', Discovered: 'purple',
  // gap-assessment verdicts and the compliance statuses they map to
  MET: 'green', Met: 'green', Documented: 'green', COMPLIANT: 'green',
  PARTIAL: 'amber', Partial: 'amber', PARTIALLY_COMPLIANT: 'amber',
  GAP: 'red', Gap: 'red', NON_COMPLIANT: 'red',
  NOT_COVERED: 'orange', 'Not covered': 'orange', EVIDENCE_MISSING: 'orange',
  NOT_APPLICABLE: 'gray', 'Not applicable': 'gray',
};

const CRIT_TONE: Record<string, Tone> = {
  Critical: 'red', High: 'orange', Medium: 'amber', Low: 'gray',
  CRITICAL: 'red', HIGH: 'orange', MEDIUM: 'amber', LOW: 'gray',
};

export function toneClass(tone: Tone): string {
  return TONE_CLASS[tone];
}
const title = (v: string) => v.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
/** Look a value up as written, Title Case and UPPER CASE — "ACTIVE" and "Active" are the same status. */
function lookup<T>(map: Record<string, T>, value?: string): T | undefined {
  const v = (value ?? '').trim();
  return map[v] ?? map[title(v)] ?? map[v.toUpperCase()] ?? map[v.replace(/\s+/g, '_').toUpperCase()];
}
export function statusTone(value?: string): Tone { return lookup(STATUS_TONE, value) ?? 'gray'; }
export function statusClass(value?: string): string {
  return TONE_CLASS[statusTone(value)];
}
export function critClass(value?: string): string {
  return TONE_CLASS[lookup(CRIT_TONE, value) ?? 'gray'];
}
/** Text colour only — for the quiet dot-and-word status style. */
export const TONE_TEXT: Record<Tone, string> = {
  green: 'text-success-600', amber: 'text-warning-600', red: 'text-critical-600', orange: 'text-notcov-600',
  blue: 'text-brand-700', purple: 'text-violet-700', teal: 'text-teal-700', gray: 'text-slate-500',
};
/** "NOT_COVERED" / "not covered" → "Not covered"; mixed-case values are left as written. */
export function readable(value: string): string {
  return /^[A-Z0-9_ -]+$/.test(value) || /^[a-z0-9_ -]+$/.test(value)
    ? value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
    : value;
}
