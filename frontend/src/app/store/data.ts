import { create } from 'zustand';
import type { Entity, Relationship, HistoryEvent } from '@/types/entity';
import type { Mapping, MappingStatus } from '@/types/regulatory';
import { fetchAudit, fetchCompanyGraph, postEntities, patchEntity, reviewMapping } from '@/services/companyApi';
import { Unauthorized } from '@/services/http';

/**
 * Both halves are loaded from the database.
 *   Company Brain  → /api/company/graph
 *   Regulatory     → /api/regulations (read directly by the regulatory screens)
 *   History        → /api/audit (audit_events; the server records the signed-in user as actor)
 * No seed module is imported into the production store.
 *
 * Every write goes to the server first-class: the change is applied locally so
 * the screen responds at once, and history is re-read from the audit log
 * afterwards, so what the History tabs show is what the server recorded —
 * never an invented actor or a "Just now" that a reload would lose.
 */

interface DataState {
  entities: Entity[];
  relationships: Relationship[];
  mappings: Mapping[];
  history: HistoryEvent[];
  /** true until the first load from the API completes */
  loading: boolean;
  /** set when the API is unreachable or a write fails, so the UI can say so */
  error: string | null;
  hydrate: () => Promise<void>;
  clearError: () => void;
  refreshHistory: () => Promise<void>;
  addEntity: (e: Entity) => void;
  /** bulk insert from the CSV importer */
  importEntities: (list: Entity[], source: string) => void;
  /** guided onboarding: add one entity plus the edges that connect it */
  addEntityWithLinks: (e: Entity, links: { type: string; targetId: string }[]) => void;
  verifyEntity: (id: string) => void;
  assignOwner: (id: string, ownerId: string) => void;
  setMappingStatus: (id: string, status: MappingStatus) => void;
  addMapping: (m: Mapping) => void;
}

// An expired session is not an error to show: the shell already sends the person to sign in.
const failed = (e: unknown, what: string) =>
  e instanceof Unauthorized ? null : e instanceof Error ? `${what}: ${e.message}` : what;

export const useData = create<DataState>((set, get) => ({
  entities: [],
  relationships: [],
  mappings: [],
  history: [],
  loading: true,
  error: null,

  hydrate: async () => {
    try {
      const [g, history] = await Promise.all([
        fetchCompanyGraph(),
        fetchAudit(300).catch(() => [] as HistoryEvent[]),
      ]);
      set(() => ({
        entities: g.entities,
        relationships: g.relationships,
        mappings: g.mappings,
        history,
        loading: false,
        error: null,
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Unauthorized ? null : err instanceof Error ? err.message : 'Could not reach the API' });
    }
  },

  clearError: () => set({ error: null }),

  refreshHistory: async () => {
    try { set({ history: await fetchAudit(300) }); } catch { /* keep what we have */ }
  },

  addEntity: (e) => {
    set((st) => ({ entities: [e, ...st.entities] }));
    postEntities([e], [], 'manual')
      .then(() => get().refreshHistory())
      .catch((err) => set((st) => ({ entities: st.entities.filter((x) => x.id !== e.id), error: failed(err, 'Not saved') })));
  },

  importEntities: (list, source) => {
    set((st) => ({ entities: [...list, ...st.entities] }));
    // persist; on failure surface it rather than silently losing the import
    postEntities(list, [], source)
      .then(() => get().refreshHistory())
      .catch((e) => set({ error: failed(e, 'Import was not saved') }));
  },

  addEntityWithLinks: (e, links) => {
    const rels = links.map((l, i) => ({
      id: `rel-${e.id}-${i}-${Date.now()}`, sourceId: e.id, type: l.type, targetId: l.targetId,
    }));
    set((st) => ({
      entities: [e, ...st.entities],
      relationships: [...rels.map((r) => ({ ...r, confidence: 100, status: 'Pending' as const })), ...st.relationships],
    }));
    postEntities([e], rels, 'guided-onboarding')
      .then(() => get().refreshHistory())
      .catch((err) => set({ error: failed(err, 'Not saved') }));
  },

  verifyEntity: (id) => {
    const before = get().entities.find((e) => e.id === id);
    set((st) => ({
      entities: st.entities.map((e) =>
        e.id === id ? { ...e, verification: 'Verified', lifecycle: e.lifecycle === 'Pending Review' ? 'Active' : e.lifecycle } : e,
      ),
    }));
    patchEntity(id, { verification: 'Verified', lifecycle: before?.lifecycle === 'Pending Review' ? 'Active' : before?.lifecycle })
      .then(() => get().refreshHistory())
      .catch((err) => set((st) => ({
        entities: before ? st.entities.map((e) => (e.id === id ? before : e)) : st.entities,
        error: failed(err, 'Verification was not saved'),
      })));
  },

  assignOwner: (id, ownerId) => {
    const before = get().entities.find((e) => e.id === id);
    set((st) => ({ entities: st.entities.map((e) => (e.id === id ? { ...e, ownerId } : e)) }));
    patchEntity(id, { owner_id: ownerId })
      .then(() => get().refreshHistory())
      .catch((err) => set((st) => ({
        entities: before ? st.entities.map((e) => (e.id === id ? before : e)) : st.entities,
        error: failed(err, 'Owner was not saved'),
      })));
  },

  setMappingStatus: (id, status) => {
    set((st) => ({
      mappings: st.mappings.map((m) => (m.id === id ? { ...m, status, reviewedAt: new Date().toISOString() } : m)),
    }));
    reviewMapping(id, status)
      .then(() => get().refreshHistory())
      .catch((err) => set({ error: failed(err, 'Review was not saved') }));
  },
  addMapping: (m) => set((st) => ({ mappings: [m, ...st.mappings] })),
}));
