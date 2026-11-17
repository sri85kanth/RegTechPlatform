// ============================================================
// COMPANY BRAIN — single source of truth (reconciled architecture)
//
// This module is the ONE place the Company Brain's architecture is
// declared. Sidebar, secondary navigation, entity detail, graph
// filters and search grouping all derive from what is exported here.
//
// It intentionally re-exports the existing domain/overview config so
// there is a single import surface and NO contradictory copies:
//   - the 9 top-level domains + their sub-tabs      → ./domains
//   - the Overview meta-domain (17 sub-tabs)         → ./overviewDomain
//   - lifecycle / verification / provenance model    → @/types/entity
//
// Scope note: Regulatory Brain / Mapping are OUT OF SCOPE for the
// Company Brain product and are intentionally not referenced here.
// ============================================================

import { LIFECYCLE } from '@/types/entity';
import type { DomainId, VerificationState, SourceKind } from '@/types/entity';
import {
  DOMAINS,
  DOMAIN_ORDER,
  REL_LABELS,
  type DomainConfig,
  type Subtab,
  type SubtabKind,
  type ColumnDef,
  type ColumnKind,
  type ContentDomain,
} from './domains';
import { OV_TABS, OVERVIEW_DOMAIN, type OverviewTab, type OverviewTabKind } from './overviewDomain';

// ---- re-exported canonical config (import these from here) ----
export {
  DOMAINS,
  DOMAIN_ORDER,
  REL_LABELS,
  OV_TABS,
  OVERVIEW_DOMAIN,
  LIFECYCLE,
};
export type {
  DomainConfig,
  Subtab,
  SubtabKind,
  ColumnDef,
  ColumnKind,
  ContentDomain,
  OverviewTab,
  OverviewTabKind,
  DomainId,
};

// The 9 top-level Company Brain domains, in canonical order.
export const COMPANY_DOMAINS: DomainId[] = ['overview', ...DOMAIN_ORDER];

// ------------------------------------------------------------
// Shared vocabularies (single definition — nothing else redefines these)
// ------------------------------------------------------------
export const VERIFICATION_STATES: VerificationState[] = ['Verified', 'Pending', 'Needs Review', 'Rejected'];
export const SOURCE_KINDS: SourceKind[] = ['Manual', 'CSV', 'Excel', 'API', 'Connector', 'Document', 'AI Extraction', 'Seed'];
/** The provenance fields every important entity carries (spec §20). */
export const PROVENANCE_FIELDS = ['source', 'sourceReference', 'confidence', 'verifiedBy', 'verifiedAt', 'createdAt', 'updatedAt'] as const;

// ------------------------------------------------------------
// Entity detail — which related domains surface as their own section
// in the Universal Entity Drawer, and in what order (Role E).
// The drawer shows a section ONLY when the entity actually has related
// entities of that domain (progressive disclosure, data-only).
// ------------------------------------------------------------
export const RELATED_SECTION_ORDER: Record<Exclude<DomainId, 'overview'>, Exclude<DomainId, 'overview'>[]> = {
  people: ['processes', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence'],
  processes: ['people', 'systems', 'data', 'policies', 'controls', 'risks', 'evidence'],
  systems: ['data', 'processes', 'controls', 'risks', 'policies', 'systems', 'people'],
  data: ['systems', 'processes', 'policies', 'controls', 'risks', 'people'],
  policies: ['processes', 'data', 'controls', 'risks', 'people'],
  controls: ['risks', 'processes', 'systems', 'data', 'policies', 'evidence', 'people'],
  risks: ['controls', 'processes', 'systems', 'data', 'evidence', 'people'],
  evidence: ['controls', 'processes', 'policies', 'risks', 'people'],
};

// Role-F attribute sections: entity-type-specific detail that lives on the
// entity's own `attrs` (not relationships). Rendered ONLY when the entity has
// values for the listed keys — dormant until such data exists in the graph.
export interface AttrSection {
  label: string;
  attrKeys: string[];
}
export const DETAIL_ATTR_SECTIONS: Partial<Record<Exclude<DomainId, 'overview'>, AttrSection[]>> = {
  processes: [
    { label: 'Activities', attrKeys: ['activities'] },
    { label: 'Inputs', attrKeys: ['inputs'] },
    { label: 'Outputs', attrKeys: ['outputs'] },
    { label: 'Performance', attrKeys: ['sla', 'throughput', 'performance'] },
  ],
  systems: [
    { label: 'Environments', attrKeys: ['environment', 'environments'] },
    { label: 'Security', attrKeys: ['security', 'encryption'] },
    { label: 'Availability', attrKeys: ['availability', 'uptime', 'rto', 'rpo'] },
    { label: 'Lifecycle', attrKeys: ['lifecycleStage', 'eol'] },
  ],
  data: [
    { label: 'Flows & Processing', attrKeys: ['flows', 'processing'] },
    { label: 'Retention & Disposal', attrKeys: ['retention', 'disposal'] },
    { label: 'Privacy', attrKeys: ['privacy', 'sensitive'] },
    { label: 'Lineage', attrKeys: ['lineage'] },
  ],
  controls: [
    { label: 'Testing', attrKeys: ['testing', 'lastTested'] },
    { label: 'Effectiveness', attrKeys: ['effectiveness'] },
  ],
};

// ------------------------------------------------------------
// Registry visuals — presentation only. How each record domain is drawn in
// the registries, the record drawer and the add-record modal: its icon tile,
// its categorical colour, and which of its own fields the chart strip may
// break the records down by. Nothing here changes what a domain holds; the
// chart strip uses the first listed field that actually carries values.
// ------------------------------------------------------------
/** Tones the shared FlowSteps chart understands. */
export type FlowTone = 'blue' | 'red' | 'green' | 'amber' | 'orange' | 'purple' | 'teal' | 'gray';

export interface RegistryVisual {
  /** icon name from the shared icon registry */
  icon: string;
  /** tile classes — tinted background + icon colour */
  tile: string;
  /** the same hue for SVG charts */
  hex: string;
  /** nearest FlowSteps tone */
  flow: FlowTone;
  /** fields to break records down by, best first ('ownerId' = by owner) */
  breakdown: string[];
  /** draw a risk heat grid in the chart strip */
  heat?: boolean;
}

export const REGISTRY_VISUALS: Record<Exclude<DomainId, 'overview'>, RegistryVisual> = {
  people: {
    icon: 'Users', tile: 'bg-violet-50 text-violet-600', hex: '#8b5cf6', flow: 'purple',
    breakdown: ['department', 'role', 'jobTitle', 'subDepartment', 'location', 'type'],
  },
  processes: {
    icon: 'Workflow', tile: 'bg-indigo-50 text-indigo-600', hex: '#6366f1', flow: 'blue',
    breakdown: ['department', 'category', 'ownerId', 'type'],
  },
  systems: {
    icon: 'Server', tile: 'bg-sky-50 text-sky-600', hex: '#0ea5e9', flow: 'blue',
    breakdown: ['type', 'department', 'environment', 'make', 'location', 'ownerId'],
  },
  data: {
    icon: 'Database', tile: 'bg-teal-50 text-teal-600', hex: '#14b8a6', flow: 'teal',
    breakdown: ['classification', 'domainCat', 'type', 'ownerId'],
  },
  policies: {
    icon: 'FileText', tile: 'bg-brand-50 text-brand-600', hex: '#2563eb', flow: 'blue',
    breakdown: ['category', 'department', 'ownerId', 'type'],
  },
  controls: {
    icon: 'ShieldCheck', tile: 'bg-emerald-50 text-emerald-600', hex: '#10b981', flow: 'green',
    breakdown: ['category', 'department', 'frequency', 'type', 'ownerId'],
  },
  risks: {
    icon: 'AlertTriangle', tile: 'bg-critical-50 text-critical-500', hex: '#dc2626', flow: 'red',
    breakdown: ['category', 'department', 'ownerId', 'type'], heat: true,
  },
  evidence: {
    icon: 'Paperclip', tile: 'bg-pink-50 text-pink-600', hex: '#ec4899', flow: 'orange',
    breakdown: ['type', 'freshness', 'ownerId'],
  },
};

const FALLBACK_VISUAL: RegistryVisual = {
  icon: 'LayoutGrid', tile: 'bg-slate-100 text-slate-500', hex: '#64748b', flow: 'gray', breakdown: ['type', 'ownerId'],
};

/** Visual config for any domain id — regulatory and unknown domains get a neutral look. */
export function registryVisual(domain: string | undefined): RegistryVisual {
  return (domain && REGISTRY_VISUALS[domain as Exclude<DomainId, 'overview'>]) || FALLBACK_VISUAL;
}

// ------------------------------------------------------------
// The reconciled classification: every recurring hierarchy concept
// is assigned exactly one role. This is documentation-as-code — it
// records intent so the UI never drifts back into "every item = a page".
// ------------------------------------------------------------
export type ConceptRole =
  | 'A-domain'          // top-level domain
  | 'B-primary-nav'     // a domain's default records list
  | 'C-secondary-nav'   // a within-domain tab
  | 'D-entity-type'     // a distinct entity type (a filtered list)
  | 'E-relationship'    // a graph lens onto related entities
  | 'F-detail-section'  // a section inside the entity drawer
  | 'G-filter'          // a filter / attribute
  | 'H-computed'        // a computed / analytical view
  | 'I-verification'    // verification / lifecycle view
  | 'J-provenance';     // provenance / source view

export const CONCEPT_ROLES: Record<string, ConceptRole> = {
  // A — top-level domains
  Overview: 'A-domain', People: 'A-domain', Processes: 'A-domain', Systems: 'A-domain',
  Data: 'A-domain', Policies: 'A-domain', Controls: 'A-domain', Risks: 'A-domain', Evidence: 'A-domain',
  // B/D — primary lists & entity types
  Directory: 'B-primary-nav', 'Process Library': 'B-primary-nav', 'Risk Register': 'B-primary-nav',
  Applications: 'D-entity-type', Databases: 'D-entity-type', 'Data Assets': 'D-entity-type',
  Departments: 'D-entity-type', Teams: 'D-entity-type', Roles: 'D-entity-type', 'Job Functions': 'D-entity-type',
  Infrastructure: 'D-entity-type', Cloud: 'D-entity-type', SaaS: 'D-entity-type', APIs: 'D-entity-type',
  Certifications: 'D-entity-type', Training: 'D-entity-type', 'Access & Identity': 'D-entity-type', 'External Personnel': 'D-entity-type',
  // E — relationship views
  Owners: 'E-relationship', Ownership: 'E-relationship', Dependencies: 'E-relationship',
  Vendors: 'E-relationship', Suppliers: 'E-relationship', Customers: 'E-relationship',
  Users: 'E-relationship', Stewards: 'E-relationship', Integrations: 'E-relationship',
  // F — entity detail sections
  Activities: 'F-detail-section', Inputs: 'F-detail-section', Outputs: 'F-detail-section',
  Hierarchy: 'F-detail-section', 'Sub-Processes': 'F-detail-section', Performance: 'F-detail-section',
  Documentation: 'F-detail-section', Environments: 'F-detail-section', Security: 'F-detail-section',
  Availability: 'F-detail-section', Flows: 'F-detail-section', Processing: 'F-detail-section',
  Retention: 'F-detail-section', Disposal: 'F-detail-section', Privacy: 'F-detail-section',
  'Sensitive Data': 'F-detail-section', Lineage: 'F-detail-section', Locations: 'F-detail-section',
  Testing: 'F-detail-section', Attestations: 'F-detail-section',
  // G — filters / attributes
  Criticality: 'G-filter', Classification: 'G-filter', Freshness: 'G-filter',
  Effectiveness: 'G-filter', Frequency: 'G-filter',
  // H — computed / analytical
  Completeness: 'H-computed', 'Data Quality': 'H-computed', Quality: 'H-computed', Lifecycle: 'H-computed',
  // I / J
  Verification: 'I-verification', Sources: 'J-provenance', History: 'H-computed', Activity: 'H-computed',
};
