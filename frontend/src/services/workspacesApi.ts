import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './http';

/**
 * Companies on this installation (scraper/regulatory_ingestion/api_workspaces.py).
 * An admin of the home company adds them; a root timer creates each one within
 * a minute, and it then appears in the company switcher.
 */
export type CompanyStatus = 'APPROVED' | 'CREATING' | 'READY' | 'FAILED' | 'PENDING' | 'DELETING' | 'REMOVING';
export interface CompanyRow {
  id: number; company_name: string; slug: string; sector: string | null;
  status: CompanyStatus; message: string | null; created_at: string;
  decided_by: string | null; finished_at: string | null; members: number;
}
/** slug is optional: the server makes one from the name */
export interface NewCompany { company_name: string; slug?: string; sector: string }

export const useCompanyOptions = (enabled = true) =>
  useQuery<{ sectors: string[] }>({ queryKey: ['ws-options'], queryFn: () => api('/api/workspaces/options'), enabled, staleTime: Infinity });

export const useSlugCheck = (slug: string) =>
  useQuery<{ available: boolean; reason: string | null }>({
    queryKey: ['ws-slug', slug],
    queryFn: () => api(`/api/workspaces/slug-check?slug=${encodeURIComponent(slug)}`),
    enabled: slug.length >= 2, staleTime: 10_000,
  });

export const useCompanies = (enabled = true) =>
  useQuery<{ home: string; home_team: number; admins: number; items: CompanyRow[] }>({
    queryKey: ['ws-companies'], queryFn: () => api('/api/workspaces/companies'), enabled,
    // while one is being set up, follow it until it is ready
    refetchInterval: (q) => (q.state.data?.items.some((r) => ['APPROVED', 'CREATING', 'DELETING', 'REMOVING'].includes(r.status)) ? 4000 : false),
  });

export const useAddCompany = () => {
  const qc = useQueryClient();
  return useMutation<{ id: number; slug: string; status: CompanyStatus }, Error, NewCompany>({
    mutationFn: (b) => api('/api/workspaces/companies', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws-companies'] }),
  });
};

/** Delete a company and all its data; the company's name is typed back to confirm. */
export const useDeleteCompany = () => {
  const qc = useQueryClient();
  return useMutation<{ id: number; status: CompanyStatus }, Error, { id: number; confirm_name: string }>({
    mutationFn: ({ id, confirm_name }) => api(`/api/workspaces/companies/${id}/delete`, { method: 'POST', body: JSON.stringify({ confirm_name }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws-companies'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
};
