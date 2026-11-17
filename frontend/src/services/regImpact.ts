// ============================================================
// Regulatory change impact — the model behind the propagation graph.
//
// Types and layout only. The DATA now comes from the API
// (GET /api/regulations/:id/impact), which builds the graph from
// impact_relationships and company_entities — real records with real ids.
// The previous version derived this from seed data, which is why it was retired.
// ============================================================
export type ImpactLevel = 'Critical' | 'High' | 'Medium' | 'Low';
export type ImpactType = 'Direct' | 'Indirect' | 'Potential';
export type ImpactDomain =
  | 'departments' | 'processes' | 'systems' | 'data'
  | 'policies' | 'controls' | 'risks' | 'evidence' | 'people';

export interface ImpactNode {
  id: string;
  entityId?: string;        // link to a real Company Brain entity id when one exists
  domain: ImpactDomain;
  code: string;             // e.g. PROC-102
  name: string;
  impactType: ImpactType;
  impactLevel: ImpactLevel;
  changeLabel: string;      // HOW it is affected, e.g. "Configuration update required"
  reason: string;           // WHY, one line
  owner?: string;
  ownerRole?: string;
  action?: string;
  people?: number;          // for department nodes
}

export interface ImpactEdge {
  source: string;
  target: string;
  relationship: string;     // "affects" | "governs" | "requires" ...
  impactType: ImpactType;   // drives edge colour (Direct=red, Indirect=amber, Potential=grey)
  impactReason?: string;
  changeType?: string;
}

export interface ChangedSection {
  id: string;
  code: string;             // Section 16
  title: string;
  status: 'Modified' | 'New';
  impact: ImpactLevel;
  oldText: string;
  newText: string;
  summary: string;
}

export interface RequiredAction {
  id: string;
  label: string;
  owner: string;
  due: string;
  priority: ImpactLevel;
  status: 'Not started' | 'In progress' | 'Done';
}

export interface RegChangeImpact {
  regId: string;
  regName: string;
  regulator: string;
  regType: string;
  version: string;
  prevVersion: string;
  docId: string;
  changedOn: string;
  effectiveFrom: string;
  changeType: string;
  businessImpact: ImpactLevel;
  status: string;
  changedSections: ChangedSection[];
  activeSectionId: string;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  actions: RequiredAction[];
}

// ---- ordered column layout for the propagation graph ----
export const IMPACT_COLUMNS: { domain: ImpactDomain; label: string }[] = [
  { domain: 'departments', label: 'Departments' },
  { domain: 'processes', label: 'Processes' },
  { domain: 'systems', label: 'Systems' },
  { domain: 'data', label: 'Data' },
  { domain: 'policies', label: 'Policies' },
  { domain: 'controls', label: 'Controls' },
  { domain: 'risks', label: 'Risks' },
  { domain: 'evidence', label: 'Evidence' },
];

export const DOMAIN_ICON: Record<ImpactDomain, string> = {
  departments: 'Landmark', processes: 'Workflow', systems: 'Server', data: 'Database',
  policies: 'FileText', controls: 'ShieldCheck', risks: 'AlertTriangle', evidence: 'Paperclip', people: 'Users',
};
export const DOMAIN_HEX: Record<ImpactDomain, string> = {
  departments: '#7c3aed', processes: '#6366f1', systems: '#2563eb', data: '#0d9488',
  policies: '#ca8a04', controls: '#059669', risks: '#dc2626', evidence: '#e11d48', people: '#16a34a',
};
export const LEVEL_HEX: Record<ImpactLevel, string> = { Critical: '#dc2626', High: '#ef4444', Medium: '#f59e0b', Low: '#64748b' };
export const TYPE_HEX: Record<ImpactType, string> = { Direct: '#dc2626', Indirect: '#f59e0b', Potential: '#64748b' };

// The 130 lines that used to sit here were a fully worked example impact graph
// for one RBI KYC amendment — invented departments, invented owners, invented
// due dates. Nothing imported it: ImpactTab and RegulationImpactPage both read
// GET /api/regulations/:id/impact, which builds the graph from
// impact_relationships and company_entities. It is deleted rather than left in
// place, because a named dataset shaped exactly like the real one is the sort
// of thing that gets wired back in as a "fallback" and then shipped as fact.
