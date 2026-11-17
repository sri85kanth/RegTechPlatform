// ============================================================
// Governance — who is accountable, and what evidence exists.
//
// Ownership, heads, approvers, delegations and the document register. This is
// the half of compliance an inspection actually opens with: not "what does the
// rule say" but "who is responsible, and show me the signed artefact".
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface OwnerCoverage {
  entities: number; withOwnerLink: number; withOwnerNameOnly: number; coveragePct: number;
}
export interface EdgeCoverage {
  edges: Record<string, number>;
  delegations: { total: number; active: number; openEnded: number; expired: number };
  departmentsWithHead: number; departmentsTotal: number;
}
export interface DocStats {
  total: number; byType: Record<string, number>;
  unlinked: number; withoutVersion: number; withoutApprover: number;
}

export const useGovernanceCoverage = () =>
  useQuery<{ owners: OwnerCoverage; edges: EdgeCoverage; documents: DocStats }>({
    queryKey: ['governance'],
    // a reply without the three sections is treated as a failed load, not drawn half-empty
    queryFn: () => api<{ owners: OwnerCoverage; edges: EdgeCoverage; documents: DocStats }>('/api/accountability/coverage').then((d) => {
      if (!d?.owners || !d?.edges?.delegations || !d?.documents) throw new Error('The coverage figures came back incomplete.');
      return d;
    }),
  });

export interface Delegation {
  id: number; from_person: string; to_person: string;
  from_name: string | null; to_name: string | null;
  scope: string | null; reason: string | null;
  valid_from: string; valid_until: string | null;
  status: 'active' | 'active_open_ended' | 'pending' | 'expired' | 'revoked';
}

export const useDelegations = (activeOnly = false) =>
  useQuery<{ items: Delegation[] }>({
    queryKey: ['delegations', activeOnly],
    queryFn: () => api(`/api/accountability/delegations?active_only=${activeOnly}`),
  });

export interface CompanyDoc {
  id: string; name: string; document_type: string | null; version: string | null;
  approved_by: string | null; approved_on: string | null;
  linked_entity_id: string | null; entity_name: string | null; entity_domain: string | null;
  source: string | null; source_reference: string | null; kind: string | null; size: number | null;
}

export const useDocuments = (type?: string) =>
  useQuery<{ items: CompanyDoc[]; stats: DocStats; types: string[] }>({
    queryKey: ['documents', type],
    queryFn: () => api(`/api/documents${type ? `?document_type=${encodeURIComponent(type)}` : ''}`),
  });

function useGov<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({
    mutationFn: fn,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['governance'] });
      qc.invalidateQueries({ queryKey: ['delegations'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export const useResolveOwners = () =>
  useGov((apply: boolean) => api(`/api/accountability/resolve-owners?apply=${apply}`, { method: 'POST' }));

export const useDeriveEdges = () =>
  useGov((apply: boolean) => api(`/api/accountability/derive?apply=${apply}`, { method: 'POST' }));

export const useSyncDocuments = () =>
  useGov(() => api('/api/documents/sync?apply=true', { method: 'POST' }));

export const useCreateDelegation = () =>
  useGov((b: Record<string, unknown>) =>
    api('/api/accountability/delegations', { method: 'POST', body: JSON.stringify(b) }));

export const useRevokeDelegation = () =>
  useGov((id: number) => api(`/api/accountability/delegations/${id}/revoke`, { method: 'POST' }));
