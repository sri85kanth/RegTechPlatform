// ============================================================
// Regulatory Intelligence read models.
//
// Data path:  Frontend → FastAPI → PostgreSQL (company_brain)
//
// These used to read build-time files from /data/intel/*.json. They no longer
// do: every hook below hits the API, which counts real rows. There is no seed,
// no sample and no fallback — when a table is empty the screen shows empty.
// ============================================================
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/http';

export interface IngestionStats {
  generatedAt: string;
  bySource: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

const fetchJson = <T,>(path: string): Promise<T> => api<T>(path);

export const useIngestionStats = () =>
  useQuery<IngestionStats>({ queryKey: ['ingestion'], queryFn: () => fetchJson('/api/intel/ingestion'), staleTime: Infinity, retry: 1 });

/* ---------- entity-centric view: which regulations reference each Company Brain entity ---------- */
export interface EntityRegRef { id: string; title: string; regulator: string; impact: string | null; confidence: number; links: number;
  /** matching-engine rows are proposals until a human approves them */
  status?: string }
export interface IntelEntities { generatedAt: string; entities: Record<string, { name: string; domain: string; regulations: EntityRegRef[] }> }
export const useIntelEntities = () =>
  useQuery<IntelEntities>({ queryKey: ['intel-entities'], queryFn: () => fetchJson('/api/intel/entities'), staleTime: Infinity, retry: 1 });
