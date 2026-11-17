import { create } from 'zustand';

/** The dated fact a record was opened for (a calendar item): shown first in the drawer. */
export interface EntityFocus {
  /** YYYY-MM-DD */
  date: string;
  /** what the date means, e.g. "Registration expires" */
  label: string;
  /** true for things that lapse: a past date is overdue */
  lapses?: boolean;
}

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  // slide-over entity detail drawer (universal detail — one drawer for every domain)
  openEntityId: string | null;
  entityFocus: EntityFocus | null;
  openEntity: (id: string, focus?: EntityFocus) => void;
  closeEntity: () => void;
}

/** callers pass openEntity straight to onClick-style props; only a real focus object counts */
const isFocus = (f: unknown): f is EntityFocus =>
  !!f && typeof f === 'object' && typeof (f as EntityFocus).date === 'string' && typeof (f as EntityFocus).label === 'string';

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openEntityId: null,
  entityFocus: null,
  openEntity: (id, focus) => set({ openEntityId: id, entityFocus: isFocus(focus) ? focus : null }),
  closeEntity: () => set({ openEntityId: null, entityFocus: null }),
}));
