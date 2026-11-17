import { api } from '@/services/http';
// ============================================================
// The Company Brain now lives in the database, not in seed modules.
// This is the only place the frontend talks to it.
// ============================================================
import type { Entity, Relationship, HistoryEvent } from '@/types/entity';
import type { Mapping } from '@/types/regulatory';

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

interface ApiEntity {
  id: string; domain: string; name: string; type?: string; description?: string;
  owner_id?: string; criticality?: string; lifecycle?: string; status?: string;
  verification?: string; attrs?: Record<string, unknown>;
  source?: string; source_reference?: string; created_at?: string; updated_at?: string;
}
interface ApiRel { id: string; source_id: string; type: string; target_id: string; confidence?: number; status?: string }
interface ApiMapping {
  id: string; obligation_id: string; target_id: string; target_domain?: string; status?: string;
  confidence?: number; reason?: string; source?: string; created_by?: string;
  reviewed_by?: string; reviewed_at?: string; created_at?: string;
}

const toEntity = (e: ApiEntity): Entity => ({
  id: e.id,
  domain: e.domain as Entity['domain'],
  name: e.name,
  type: e.type ?? undefined,
  description: e.description ?? undefined,
  status: e.status ?? 'Active',
  ownerId: e.owner_id ?? undefined,
  criticality: (e.criticality ?? undefined) as Entity['criticality'],
  lifecycle: (e.lifecycle ?? 'Discovered') as Entity['lifecycle'],
  verification: (e.verification ?? 'Pending') as Entity['verification'],
  provenance: {
    source: (e.source ?? 'Manual') as Entity['provenance']['source'],
    sourceReference: e.source_reference ?? undefined,
    confidence: 100,
    createdAt: e.created_at ?? '',
    updatedAt: e.updated_at ?? '',
  },
  attrs: (e.attrs ?? {}) as Entity['attrs'],
});

const toRel = (r: ApiRel): Relationship => ({
  id: r.id, sourceId: r.source_id, type: r.type, targetId: r.target_id,
  confidence: r.confidence ?? 100,
  status: (r.status ?? 'Pending') as Relationship['status'],
});

const toMapping = (m: ApiMapping): Mapping => ({
  id: m.id, obligationId: m.obligation_id, targetId: m.target_id,
  targetDomain: (m.target_domain ?? 'processes') as Mapping['targetDomain'],
  status: (m.status ?? 'Proposed') as Mapping['status'],
  confidence: m.confidence ?? 0, reason: m.reason ?? '',
  source: (m.source ?? 'Manual') as Mapping['source'],
  createdBy: m.created_by ?? 'system', reviewedBy: m.reviewed_by ?? undefined,
  reviewedAt: m.reviewed_at ?? undefined, createdAt: m.created_at ?? '',
});

export interface CompanyGraph {
  entities: Entity[];
  relationships: Relationship[];
  mappings: Mapping[];
  profile: Record<string, unknown> | null;
}

/** Load the whole Company Brain in one call. */
export async function fetchCompanyGraph(): Promise<CompanyGraph> {
  const d = await api<{
    entities?: ApiEntity[]; relationships?: ApiRel[]; mappings?: ApiMapping[];
    profile?: CompanyGraph['profile'];
  }>(`/api/company/graph`);
  return {
    entities: (d.entities ?? []).map(toEntity),
    relationships: (d.relationships ?? []).map(toRel),
    mappings: (d.mappings ?? []).map(toMapping),
    profile: d.profile ?? null,
  };
}

/**
 * The real activity feed, from audit_events — every write this system makes is
 * logged there with its actor. The Overview page used to render a fixed list
 * of invented events instead, which meant "Recent Activity" said the same
 * thing on a database that had never been touched.
 */
/** audit_events stores an ISO instant; the UI reads a sentence. */
function whenText(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export async function fetchAudit(limit = 100): Promise<HistoryEvent[]> {
  const d = await api<{ items: Record<string, unknown>[] }>(`/api/audit?limit=${limit}`);
  return (d.items ?? []).map((r) => ({
    id: String(r.id),
    entityId: String(r.entity_id ?? ''),
    action: String(r.action ?? 'changed'),
    // the server records who did it; never substitute a plausible name
    by: String(r.actor ?? '') || 'system',
    at: whenText(String(r.at ?? '')),
    detail: readable(r.detail),
  }));
}

/** Changes are logged as JSON ({"verification":"Verified"}); show them as words. */
function readable(detail: unknown): string | undefined {
  const s = String(detail ?? '').trim();
  if (!s) return undefined;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      return Object.entries(o)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k.replace(/_id$/, '').replace(/_/g, ' ')}: ${String(v)}`)
        .join(' · ') || undefined;
    } catch { /* not JSON after all */ }
  }
  return s;
}

/** Persist newly onboarded entities (and any edges) to the database. */
export async function postEntities(
  entities: Entity[],
  relationships: { id: string; sourceId: string; type: string; targetId: string }[] = [],
  source = 'onboarding',
): Promise<{ created: number; relationships: number }> {
  return api(`/api/company/entities`, {
    method: 'POST', body: JSON.stringify({ entities, relationships, source }),
  });
}

export async function patchEntity(id: string, patch: Record<string, unknown>) {
  return api(`/api/company/entities/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function reviewMapping(id: string, status: string, rationale = '') {
  // reviewedBy is NOT sent: the server takes the reviewer from the authenticated
  // session. A client-supplied approver name is worth nothing in an audit trail.
  return api(`/api/company/mappings/${id}/review`, {
    method: 'POST', body: JSON.stringify({ status, rationale }),
  });
}

/** Save the company profile — of the company open now, or of the one named (a company just added). */
export async function saveProfile(profile: Record<string, unknown>, company?: string) {
  return api(`/api/company/profile`, {
    method: 'PUT', body: JSON.stringify(profile), headers: company ? { 'X-Company': company } : undefined,
  });
}

export async function apiHealth(): Promise<{ ok: boolean; companyEntities: number } | null> {
  try {
    return await api(`/api/health`);
  } catch { return null; }
}

// ------------------------------------------------------------------ public records
/** One match while a company name is typed — from the public LEI register. */
export interface CompanySuggestion {
  lei: string;
  name: string;
  registrationNo: string | null;
  registrationKind: 'CIN' | 'GSTIN' | null;
  city: string | null;
  state: string | null;
  status: string | null;
}

/** What the public record says about one entity, mapped onto the profile. */
export interface PublicRecord {
  lei: string;
  legalName: string;
  otherNames: string[];
  registrationNo: string | null;
  registrationKind: 'CIN' | 'GSTIN' | null;
  registrationAuthority: string | null;
  legalForm: string | null;
  status: string | null;
  incorporated: string | null;
  registeredAddress: string | null;
  headOfficeAddress: string | null;
  hqState: string | null;
  listed: boolean | null;
  cin: {
    listed: boolean; industryCode: string; stateCode: string; state: string | null;
    year: number; kindCode: string; kind: string | null; serial: string;
  } | null;
  /** disagreements and warnings the register itself raises */
  notes: string[];
  source: {
    name: string; licence: string; about: string; record: string;
    lastUpdated: string | null; corroboration: string | null; fetchedAt: string;
  };
}

export async function lookupCompany(q: string): Promise<CompanySuggestion[]> {
  const d = await api<{ results: CompanySuggestion[] }>(`/api/company/lookup?q=${encodeURIComponent(q)}`);
  return d.results ?? [];
}

export async function lookupCompanyRecord(lei: string): Promise<PublicRecord> {
  return api<PublicRecord>(`/api/company/lookup/${encodeURIComponent(lei)}`);
}
