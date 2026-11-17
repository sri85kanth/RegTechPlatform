// ============================================================
// The organisation structure the company defines for itself.
//
// Nothing here ships a default department list. An empty company shows an
// empty tree and one input, which is the point: the previous intake assumed
// every company has the same eleven domains, and a hospital does not have the
// departments a bank has.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface OrgNode {
  id: string;
  parent_id: string | null;
  name: string;
  kind: string | null;
  /** What belongs here, in the user's words. The classifier embeds THIS, not
   *  the name — which is why the form asks for it and explains why. */
  description: string | null;
  position: number;
  path: string;
  depth: number;
  created_at: string;
  updated_at: string;
  /** who heads it — typed in by a person, never inferred; null means not recorded */
  head_name?: string | null;
  head_role?: string | null;
  children?: OrgNode[];
}

export interface TaxonomyTerm {
  id: string; taxonomy_id: string; name: string; description: string | null; position: number;
}
export interface Taxonomy {
  id: string; name: string; description: string | null;
  multi_valued: boolean; terms: TaxonomyTerm[];
}

export interface StructureCounts {
  /** filed directly on this node */
  own: Record<string, number>;
  /** this node plus everything below it — collapsing a parent must not make its
   *  records appear to vanish */
  total: Record<string, number>;
  /** records with no node yet. Not an error state, and never hidden: these are
   *  real records collected before the structure existed. */
  unfiled: number;
  filed: number;
  /** what kind of record sits under each node, largest first — rolled up like
   *  `total`, so a department can say "Equipment 315" without fetching them */
  collected?: Record<string, CollectedKind[]>;
  /** where the records under each node came from: source -> count */
  sources?: Record<string, Record<string, number>>;
  /** the source's own status and criticality values, counted, rolled up */
  status?: Record<string, Record<string, number>>;
  criticality?: Record<string, Record<string, number>>;
  /** how many different things (by name) sit under each node */
  distinct_names?: Record<string, number>;
  /** who a source (an organisation chart) says heads each node — its own words, nothing inferred */
  heads?: Record<string, SourceHead[]>;
  /** status and criticality per kind of record — a complaint's priority and an item's criticality kept apart */
  signals?: Record<string, { type: string | null; field: 'status' | 'criticality'; value: string; n: number }[]>;
}

export interface SourceHead {
  name: string;
  role: string | null;
  reportsTo: string | null;
  reportsToDepartment: string | null;
  inferred: boolean;
  origin: string | null;
}

/** One person as the company's sources name them — no contact details are ever shared. */
export interface Person {
  id: string;
  ref: string | null;
  name: string;
  nodeId: string | null;
  designation: string | null;
  department: string | null;
  branch: string | null;
  isHead: boolean;
  reportsToRef: string | null;
  reportsTo: string | null;
  reportsToDepartment: string | null;
  inferred: boolean;
  origin: string | null;
}

export function usePeople() {
  return useQuery({
    queryKey: ['structure', 'people'],
    queryFn: () => api<{ people: Person[]; count: number }>('/api/structure/people'),
    staleTime: 60_000,
  });
}

export interface CollectedKind {
  domain: string;
  type: string | null;
  n: number;
}

export interface Structure {
  tree: OrgNode[];
  flat: OrgNode[];
  taxonomies: Taxonomy[];
  counts: StructureCounts;
}

export interface FiledRecord {
  id: string; domain: string; name: string; type: string | null;
  description: string | null; criticality: string | null;
  /** the source's own status when it sent one ("ACTIVE", "UNDER_MAINTENANCE") */
  status: string | null;
  lifecycle: string | null; verification: string | null;
  org_node_id: string | null;
  attrs: Record<string, unknown>;
  source: string | null; source_reference: string | null;
  created_at?: string; updated_at?: string;
}

/** A connection that records under a node came from. Never carries its secret. */
export interface NodeSource {
  id: string;
  label: string;
  connector: string;
  /** "API endpoint", "Local or mounted folder" */
  kind: string;
  /** the API's host, or the folder's name */
  where: string;
  lastSyncAt: string | null;
  records: number;
  /** what the connection's owner has said about a field's reliability, by field name */
  caveats?: Record<string, string>;
  /** each register's own name and columns, by record type — [our key, the source's name] */
  layouts?: Record<string, { label: string; fields: [string, string][] }>;
}

const KEY = ['structure'];

export function useStructure() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<Structure>('/api/structure'),
    staleTime: 30_000,
  });
}

/** The API answers a bad name with the user's own words — "'Recruitment'
 *  already exists here" — so the message is surfaced verbatim rather than
 *  replaced with a generic failure. */
function message(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^\d{3}:\s*/, '') || 'That could not be saved.';
}

export function useStructureMutations() {
  const qc = useQueryClient();
  const done = { onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) };

  const addNode = useMutation({
    mutationFn: (v: { name: string; parentId?: string | null; kind?: string; description?: string;
      headName?: string; headRole?: string }) =>
      api<OrgNode>('/api/structure/nodes', { method: 'POST', body: JSON.stringify(v) }),
    ...done,
  });

  const editNode = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; kind?: string; description?: string;
      headName?: string; headRole?: string }) =>
      api<OrgNode>(`/api/structure/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    ...done,
  });

  const moveNode = useMutation({
    mutationFn: (v: { id: string; parentId: string | null; position?: number }) =>
      api<OrgNode>(`/api/structure/nodes/${v.id}/move`, {
        method: 'POST', body: JSON.stringify({ parentId: v.parentId, position: v.position }),
      }),
    ...done,
  });

  const reorder = useMutation({
    mutationFn: (v: { parentId: string | null; ids: string[] }) =>
      api<{ ok: boolean }>('/api/structure/reorder', { method: 'POST', body: JSON.stringify(v) }),
    ...done,
  });

  const removeNode = useMutation({
    mutationFn: (id: string) =>
      api<{ count: number }>(`/api/structure/nodes/${id}`, { method: 'DELETE' }),
    ...done,
  });

  const seedTaxonomies = useMutation({
    mutationFn: () => api<{ taxonomies: number; terms: number }>(
      '/api/structure/taxonomies/seed', { method: 'POST' }),
    ...done,
  });

  const addTerm = useMutation({
    mutationFn: (v: { taxonomyId: string; name: string; description?: string }) =>
      api<TaxonomyTerm>(`/api/structure/taxonomies/${v.taxonomyId}/terms`, {
        method: 'POST', body: JSON.stringify({ name: v.name, description: v.description }),
      }),
    ...done,
  });

  const removeTerm = useMutation({
    mutationFn: (termId: string) =>
      api<{ ok: boolean }>(`/api/structure/taxonomies/terms/${termId}`, { method: 'DELETE' }),
    ...done,
  });

  const fileRecords = useMutation({
    mutationFn: (v: { nodeId: string; ids: string[] }) =>
      api<{ moved: number }>(`/api/structure/nodes/${v.nodeId}/file`, {
        method: 'POST', body: JSON.stringify({ ids: v.ids }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['structure'] }),
  });

  return { addNode, editNode, moveNode, reorder, removeNode, seedTaxonomies,
           addTerm, removeTerm, fileRecords, message };
}

/** How many nodes a delete would take with it — asked BEFORE the confirm, so
 *  the warning names a number instead of saying "and its children". */
export async function deleteImpact(id: string): Promise<number> {
  const r = await api<{ descendants: number }>(`/api/structure/nodes/${id}/impact`);
  return r.descendants;
}

/** The endpoint stops at 500 by default, which would cut a large register
 *  short without saying so; the page asks for more and still compares what
 *  arrived with the node's count. */
export const RECORDS_LIMIT = 5000;

export function useNodeRecords(nodeId: string | null) {
  return useQuery({
    queryKey: ['structure', 'records', nodeId],
    queryFn: () => api<{ records: FiledRecord[]; count: number; sources?: NodeSource[] }>(
      `/api/structure/nodes/${nodeId}/records?limit=${RECORDS_LIMIT}`),
    enabled: !!nodeId,
    staleTime: 15_000,
  });
}

/** Flatten for a parent picker: every node, indented by depth. */
export function asOptions(flat: OrgNode[]): { id: string; label: string; depth: number }[] {
  return flat.map((n) => ({ id: n.id, label: n.name, depth: n.depth }));
}
