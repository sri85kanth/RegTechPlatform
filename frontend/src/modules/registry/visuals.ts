/**
 * Registry helpers — what the record registries, the record drawer and the
 * chart strips share: how a field value reads on a chart, and count helpers.
 * Everything is computed from records the page already holds; nothing here
 * fetches or invents a value.
 */
import type { Entity } from '@/types/entity';
import { CHART, hexFor } from '@/components/ui/charts';
import { getField, readable, statusTone, type Tone } from '@/utils/ui';
import { entityById } from '@/services/entities';
import { tx } from '@/i18n';

/** Filter token for "this field has no value" — an empty cell matches it. */
export const NONE = '(none)';

const TONE_HEX: Record<Tone, string> = {
  green: '#16a34a', amber: '#f59e0b', red: '#dc2626', orange: '#f97316',
  blue: '#2563eb', purple: '#8b5cf6', teal: '#14b8a6', gray: '#94a3b8',
};

/** Chart colour for a status word — its fixed meaning when it has one, else a series colour. */
export function statusHex(value: string, i = 0): string {
  const t = statusTone(value);
  return t !== 'gray' ? TONE_HEX[t] : hexFor(value, i);
}

export const CRIT_ORDER = ['Critical', 'High', 'Medium', 'Low'] as const;
export const CRIT_HEX: Record<string, string> = {
  Critical: '#dc2626', High: '#f97316', Medium: '#f59e0b', Low: '#94a3b8', 'Not rated': '#cbd5e1',
};
export const VERIF_HEX: Record<string, string> = {
  Verified: '#16a34a', Pending: '#f59e0b', 'Needs Review': '#f97316', Rejected: '#dc2626',
};

/** "subDepartment" → "Sub department", "ownerId" → "Owner". */
export function humanKey(key: string): string {
  if (key === 'ownerId') return tx('Owner');
  if (key === 'domainCat') return tx('Domain');
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export interface Bucket { label: string; value: number; filter: string }

/** How a record's field reads on a chart, and the filter value that selects it. */
function bucketOf(e: Entity, key: string): { label: string; filter: string } {
  if (key === 'ownerId') {
    if (!e.ownerId) return { label: tx('Unassigned'), filter: NONE };
    return { label: entityById(e.ownerId)?.name ?? e.ownerId, filter: e.ownerId };
  }
  const raw = getField(e, key);
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { label: tx('Not recorded'), filter: NONE };
  return { label: readable(s), filter: s };
}

/** Count records per value of one field, largest first. */
export function countBy(rows: Entity[], key: string): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const e of rows) {
    const b = bucketOf(e, key);
    const cur = m.get(b.filter);
    if (cur) cur.value += 1;
    else m.set(b.filter, { label: b.label, value: 1, filter: b.filter });
  }
  return [...m.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Whether any record carries a value for this field. */
export function hasField(rows: Entity[], key: string): boolean {
  return rows.some((e) => {
    if (key === 'ownerId') return Boolean(e.ownerId);
    const v = getField(e, key);
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}

/**
 * The best field to break these records down by: the first candidate with two
 * or more different values, else the first that has any value at all.
 */
export function pickBreakdown(rows: Entity[], candidates: string[]): { key: string; buckets: Bucket[] } | null {
  let fallback: { key: string; buckets: Bucket[] } | null = null;
  for (const key of candidates) {
    if (!hasField(rows, key)) continue;
    const buckets = countBy(rows, key);
    const real = buckets.filter((b) => b.filter !== NONE);
    if (real.length >= 2) return { key, buckets };
    if (!fallback) fallback = { key, buckets };
  }
  return fallback;
}

/** Keep the top N buckets and fold the rest into one "Other" bar. */
export function topN(buckets: Bucket[], n = 6): Bucket[] {
  if (buckets.length <= n) return buckets;
  const head = buckets.slice(0, n - 1);
  const rest = buckets.slice(n - 1).reduce((a, b) => a + b.value, 0);
  return [...head, { label: `Other (${buckets.length - n + 1})`, value: rest, filter: '' }];
}

export { CHART };

/**
 * "2025-01-14T09:30:00Z" → "14 Jan 2025"; anything unparseable is returned as written.
 * Pass the caller's `useDateLocale()` so month names follow the chosen language.
 */
export function shortDate(v?: string, locale?: string): string {
  if (!v) return '';
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  return new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
