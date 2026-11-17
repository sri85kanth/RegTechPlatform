import type { DomainId, RegDomainId } from '@/types/entity';

export type ColumnKind =
  | 'name'
  | 'person'
  | 'status'
  | 'criticality'
  | 'verification'
  | 'text'
  | 'pill'
  | 'date';

export interface ColumnDef {
  key: string; // entity base field or attr key (resolved by getField)
  label: string;
  kind: ColumnKind;
  sortable?: boolean;
}

export type SubtabKind = 'entities' | 'related' | 'verification' | 'history' | 'ownership';

export type ContentDomain = Exclude<DomainId, 'overview'>;
/** Any domain that renders through the universal list/detail pages. */
export type AnyContentDomain = ContentDomain | RegDomainId;

export interface Subtab {
  id: string;
  label: string;
  kind: SubtabKind;
  filterType?: string; // for kind 'entities'
  relatedDomain?: ContentDomain; // for kind 'related'
  /** Optional per-subtab columns — overrides the domain's default columns
   *  when a subtab lists a different entity type (e.g. Certifications). */
  columns?: ColumnDef[];
}

export interface DomainConfig {
  id: AnyContentDomain;
  title: string;
  entityNoun: string;
  icon: string; // lucide key (see registry)
  accent: string; // tailwind text/bg color base, e.g. 'emerald'
  description: string;
  columns: ColumnDef[];
  /** attr/field keys used to build filter dropdowns */
  filters: string[];
  subtabs: Subtab[];
}

const C = (key: string, label: string, kind: ColumnKind, sortable = false): ColumnDef => ({
  key,
  label,
  kind,
  sortable,
});

export const DOMAINS: Record<Exclude<DomainId, 'overview'>, DomainConfig> = {
  people: {
    id: 'people',
    title: 'People',
    entityNoun: 'Person',
    icon: 'Users',
    accent: 'emerald',
    description:
      'Everyone who works in, owns, manages or is responsible for anything — the accountability layer.',
    columns: [
      C('name', 'Name', 'name', true),
      C('role', 'Role', 'text'),
      C('department', 'Department', 'text'),
      C('location', 'Location', 'text'),
      C('criticality', 'Criticality', 'criticality'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['role', 'department', 'location', 'verification', 'criticality'],
    subtabs: [
      { id: 'directory', label: 'Directory', kind: 'entities', filterType: 'Person' },
      // An HR directory arrives as its own kind of record, with the source's own
      // columns: who someone is and where they work. Not their contact details —
      // a register is read by colleagues, so no email, phone or date of birth.
      {
        id: 'employees',
        label: 'Employees',
        kind: 'entities',
        filterType: 'Employee',
        columns: [
          C('name', 'Name', 'name', true),
          C('jobTitle', 'Designation', 'text', true),
          C('department', 'Department', 'text', true),
          C('subDepartment', 'Sub-department', 'text'),
          C('location', 'Location', 'text', true),
          C('dateJoined', 'Joined', 'text', true),
          C('status', 'Status', 'status', true),
        ],
      },
      { id: 'departments', label: 'Departments', kind: 'entities', filterType: 'Department' },
      { id: 'teams', label: 'Teams', kind: 'entities', filterType: 'Team' },
      { id: 'roles', label: 'Roles', kind: 'entities', filterType: 'Role' },
      {
        id: 'job-functions', label: 'Job Functions', kind: 'entities', filterType: 'Job Function',
        columns: [C('name', 'Job Function', 'name', true), C('area', 'Area', 'pill'), C('people', 'People', 'text'), C('processes', 'Processes', 'text'), C('criticality', 'Criticality', 'criticality'), C('verification', 'Verification', 'verification')],
      },
      {
        id: 'certifications', label: 'Certifications', kind: 'entities', filterType: 'Certification',
        columns: [C('name', 'Certification', 'name', true), C('holder', 'Holder', 'text'), C('issuer', 'Issuer', 'pill'), C('expiry', 'Expiry', 'text'), C('verification', 'Verification', 'verification')],
      },
      {
        id: 'training', label: 'Training', kind: 'entities', filterType: 'Training',
        columns: [C('name', 'Training', 'name', true), C('audience', 'Audience', 'text'), C('completion', 'Completion', 'text'), C('dueDate', 'Due Date', 'text'), C('verification', 'Verification', 'verification')],
      },
      {
        id: 'access-identity', label: 'Access & Identity', kind: 'entities', filterType: 'Access Profile',
        columns: [C('name', 'Access Profile', 'name', true), C('system', 'System', 'pill'), C('level', 'Level', 'text'), C('reviewedOn', 'Last Reviewed', 'text'), C('criticality', 'Criticality', 'criticality'), C('verification', 'Verification', 'verification')],
      },
      {
        id: 'external', label: 'External Personnel', kind: 'entities', filterType: 'External Person',
        columns: [C('name', 'External Party', 'name', true), C('organization', 'Organization', 'text'), C('engagement', 'Engagement', 'pill'), C('access', 'Access', 'text'), C('verification', 'Verification', 'verification')],
      },
      { id: 'ownership', label: 'Ownership', kind: 'ownership' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  processes: {
    id: 'processes',
    title: 'Processes',
    entityNoun: 'Process',
    icon: 'Workflow',
    accent: 'indigo',
    description:
      'How the organisation performs work — where risk arises and controls operate. The connective tissue.',
    columns: [
      C('name', 'Process', 'name', true),
      C('purpose', 'Purpose', 'text'),
      C('ownerId', 'Owner', 'person'),
      C('criticality', 'Criticality', 'criticality'),
      C('status', 'Status', 'status'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['criticality', 'status', 'verification'],
    subtabs: [
      { id: 'library', label: 'Process Library', kind: 'entities' },
      { id: 'systems', label: 'Systems', kind: 'related', relatedDomain: 'systems' },
      { id: 'data', label: 'Data', kind: 'related', relatedDomain: 'data' },
      { id: 'risks', label: 'Risks', kind: 'related', relatedDomain: 'risks' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  systems: {
    id: 'systems',
    title: 'Systems',
    entityNoun: 'System',
    icon: 'Server',
    accent: 'sky',
    description: 'Applications, infrastructure, databases, APIs and equipment — the systems and assets the company runs.',
    columns: [
      C('name', 'System', 'name', true),
      C('type', 'Type', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('environment', 'Environment', 'text'),
      C('criticality', 'Criticality', 'criticality'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['type', 'environment', 'criticality', 'verification'],
    subtabs: [
      { id: 'applications', label: 'Applications', kind: 'entities', filterType: 'Application' },
      { id: 'databases', label: 'Databases', kind: 'entities', filterType: 'Database' },
      // Physical assets are systems too. Their own columns, because a ward's
      // infusion pump has an asset ID, a make and a place — not an environment.
      {
        id: 'equipment',
        label: 'Equipment',
        kind: 'entities',
        filterType: 'Equipment',
        columns: [
          C('name', 'Equipment', 'name', true),
          C('assetId', 'Asset ID', 'text', true),
          C('make', 'Make', 'text', true),
          C('model', 'Model', 'text'),
          C('department', 'Department', 'text', true),
          C('location', 'Location', 'text'),
          C('criticality', 'Criticality', 'criticality', true),
          C('status', 'Status', 'status', true),
        ],
      },
      { id: 'data', label: 'Data', kind: 'related', relatedDomain: 'data' },
      { id: 'processes', label: 'Processes', kind: 'related', relatedDomain: 'processes' },
      { id: 'controls', label: 'Controls', kind: 'related', relatedDomain: 'controls' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  data: {
    id: 'data',
    title: 'Data',
    entityNoun: 'Data Asset',
    icon: 'Database',
    accent: 'teal',
    description: 'The information assets the company holds and must protect — with classification & lineage.',
    columns: [
      C('name', 'Data Asset', 'name', true),
      C('classification', 'Classification', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('domainCat', 'Domain', 'text'),
      C('criticality', 'Criticality', 'criticality'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['classification', 'domainCat', 'criticality', 'verification'],
    subtabs: [
      { id: 'assets', label: 'Data Assets', kind: 'entities' },
      { id: 'systems', label: 'Systems', kind: 'related', relatedDomain: 'systems' },
      { id: 'processes', label: 'Processes', kind: 'related', relatedDomain: 'processes' },
      { id: 'controls', label: 'Controls', kind: 'related', relatedDomain: 'controls' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  policies: {
    id: 'policies',
    title: 'Policies',
    entityNoun: 'Policy',
    icon: 'FileText',
    accent: 'amber',
    description: 'The rules that translate obligations into how the company must operate.',
    columns: [
      C('name', 'Policy', 'name', true),
      C('category', 'Category', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('version', 'Version', 'text'),
      C('status', 'Status', 'status'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['category', 'status', 'verification'],
    subtabs: [
      { id: 'library', label: 'Library', kind: 'entities' },
      { id: 'controls', label: 'Controls', kind: 'related', relatedDomain: 'controls' },
      { id: 'risks', label: 'Risks', kind: 'related', relatedDomain: 'risks' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  controls: {
    id: 'controls',
    title: 'Controls',
    entityNoun: 'Control',
    icon: 'ShieldCheck',
    accent: 'green',
    description: 'The mechanisms that mitigate risks and implement policies — the execution layer.',
    columns: [
      C('name', 'Control', 'name', true),
      C('category', 'Category', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('effectiveness', 'Effectiveness', 'status'),
      C('frequency', 'Frequency', 'text'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['category', 'effectiveness', 'frequency', 'verification'],
    subtabs: [
      { id: 'library', label: 'Library', kind: 'entities' },
      { id: 'risks', label: 'Risks', kind: 'related', relatedDomain: 'risks' },
      { id: 'policies', label: 'Policies', kind: 'related', relatedDomain: 'policies' },
      { id: 'systems', label: 'Systems', kind: 'related', relatedDomain: 'systems' },
      { id: 'evidence', label: 'Evidence', kind: 'related', relatedDomain: 'evidence' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  risks: {
    id: 'risks',
    title: 'Risks',
    entityNoun: 'Risk',
    icon: 'AlertTriangle',
    accent: 'red',
    description: 'What could go wrong — the risks the company must mitigate to stay compliant and resilient.',
    columns: [
      C('name', 'Risk', 'name', true),
      C('inherent', 'Inherent', 'criticality'),
      C('residual', 'Residual', 'criticality'),
      C('category', 'Category', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('status', 'Status', 'status'),
    ],
    filters: ['category', 'inherent', 'residual', 'status'],
    subtabs: [
      { id: 'register', label: 'Risk Register', kind: 'entities' },
      { id: 'processes', label: 'Processes', kind: 'related', relatedDomain: 'processes' },
      { id: 'data', label: 'Data', kind: 'related', relatedDomain: 'data' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  evidence: {
    id: 'evidence',
    title: 'Evidence',
    entityNoun: 'Evidence',
    icon: 'Paperclip',
    accent: 'rose',
    description: 'Proof that controls and policies actually operate — what an auditor asks for.',
    columns: [
      C('name', 'Evidence', 'name', true),
      C('type', 'Type', 'pill'),
      C('ownerId', 'Owner', 'person'),
      C('freshness', 'Freshness', 'status'),
      C('collected', 'Collected', 'text'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['type', 'freshness', 'verification'],
    subtabs: [
      { id: 'library', label: 'Library', kind: 'entities' },
      { id: 'policies', label: 'By Policy', kind: 'related', relatedDomain: 'policies' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
};

export const DOMAIN_ORDER: Exclude<DomainId, 'overview'>[] = [
  'people',
  'processes',
  'systems',
  'data',
  'policies',
  'controls',
  'risks',
  'evidence',
];

/** Human labels for relationship verbs (edge directionality display). */
export const REL_LABELS: Record<string, string> = {
  owns: 'owns',
  manages: 'manages',
  member_of: 'member of',
  performs: 'performs',
  uses: 'uses',
  stores: 'stores',
  processes: 'processes',
  governed_by: 'governed by',
  implements: 'implements',
  mitigates: 'mitigates',
  protects: 'protects',
  affects: 'affects',
  threatens: 'threatens',
  proves: 'proves',
  supports: 'supports',
  evidenced_by: 'evidenced by',
  depends_on: 'depends on',
  contains: 'contains',
};
