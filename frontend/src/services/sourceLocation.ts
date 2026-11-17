/**
 * Where a record came from, in words a person can follow back: the connection
 * (or document) it was read from, that source's address, the record's own id
 * there, and when it was last collected. Read from the record's provenance and
 * the connections list — nothing is guessed; a part that is not known is left out.
 */
import type { Entity } from '@/types/entity';
import { useIntegrations, type Integration } from '@/services/integrationsApi';
import { tx } from '@/i18n';

export interface SourceLocation {
  kind: 'connection' | 'document' | 'manual' | 'other';
  /** the connection's name, the document's file name, or "Entered by hand" */
  name: string;
  /** how it is reached: "API endpoint", "Local or mounted folder" */
  via?: string;
  /** host + path of the API, or the folder path — no query string, no credentials */
  address?: string;
  /** the record's own id in that source */
  reference?: string;
  /** the register it was filed under */
  filedUnder?: string;
  /** when the connection last collected it */
  collectedAt?: string;
  /** when the source itself last changed the record */
  sourceUpdatedAt?: string;
}

/** "http://host:8000/api/v1/x?limit=5000" -> "host:8000/api/v1/x" */
function addressOf(i: Integration): string | undefined {
  const url = i.config?.url;
  if (url) {
    try { const u = new URL(url); return `${u.host}${u.pathname}`.replace(/\/$/, ''); } catch { return url.split('?')[0]; }
  }
  return i.config?.path || undefined;
}

export function sourceLocationOf(e: Entity, integrations: Integration[] | undefined): SourceLocation {
  const raw = String(e.provenance.source ?? '').trim();
  const reference = e.provenance.sourceReference || undefined;
  const filedUnder = e.attrs.collectionContext ? String(e.attrs.collectionContext) : undefined;
  const sourceUpdatedAt = e.attrs.updatedAt ? String(e.attrs.updatedAt) : undefined;
  const base = { reference, filedUnder, sourceUpdatedAt };

  const m = /^integration:(.+)$/i.exec(raw);
  if (m) {
    const connector = m[1];
    const same = (integrations ?? []).filter((i) => i.connector === connector);
    const hit = same.find((i) => filedUnder && i.config?.collection_context === filedUnder) ?? (same.length === 1 ? same[0] : undefined);
    if (hit) {
      return { kind: 'connection', name: hit.label, via: hit.connector_name, address: addressOf(hit), collectedAt: hit.last_sync_at ?? undefined, ...base };
    }
    return { kind: 'connection', name: same[0]?.connector_name ?? connector.replace(/_/g, ' '), ...base };
  }
  const doc = /^(document|file|upload):(?!\/\/)(.+)$/i.exec(raw);
  if (doc) return { kind: 'document', name: doc[2].replace(/_/g, ' '), ...base };
  if (!raw || /^manual$/i.test(raw)) return { kind: 'manual', name: tx('Entered by hand'), ...base };
  return { kind: 'other', name: raw.replace(/^[a-z]+:(?!\/\/)/i, '').replace(/_/g, ' '), ...base };
}

export function useSourceLocation(e: Entity | undefined): SourceLocation | undefined {
  const integrations = useIntegrations();
  return e ? sourceLocationOf(e, integrations.data?.items) : undefined;
}
