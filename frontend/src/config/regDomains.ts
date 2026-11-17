import type { RegDomainId } from '@/types/entity';
import type { DomainConfig, ColumnDef, ColumnKind } from './domains';

const C = (key: string, label: string, kind: ColumnKind, sortable = false): ColumnDef => ({ key, label, kind, sortable });

// Regulatory Brain — external regulatory reality. Rendered by the SAME
// universal EntityListPage / EntityDetailPage, but shown in a separate nav area.
export const REG_DOMAINS: Record<RegDomainId, DomainConfig> = {
  'reg-regulators': {
    id: 'reg-regulators',
    title: 'Regulators',
    entityNoun: 'Regulator',
    icon: 'Landmark',
    accent: 'violet',
    description: 'The authorities that issue regulations the company must comply with.',
    columns: [
      C('name', 'Authority', 'name', true),
      C('code', 'Code', 'pill'),
      C('domainCat', 'Regulatory Domain', 'text'),
      C('jurisdiction', 'Jurisdiction', 'text'),
      C('status', 'Status', 'status'),
    ],
    filters: ['domainCat', 'jurisdiction'],
    subtabs: [
      { id: 'directory', label: 'Regulators', kind: 'entities' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  'reg-regulations': {
    id: 'reg-regulations',
    title: 'Regulations',
    entityNoun: 'Regulation',
    icon: 'Scale',
    accent: 'blue',
    description: 'Acts, Rules, Circulars, Notifications and Master Directions — the instruments.',
    columns: [
      C('name', 'Regulation', 'name', true),
      C('regType', 'Type', 'pill'),
      C('regulator', 'Regulator', 'text'),
      C('effective', 'Effective', 'text'),
      C('version', 'Version', 'text'),
      C('status', 'Status', 'status'),
    ],
    filters: ['regType', 'regulator', 'status'],
    subtabs: [
      { id: 'library', label: 'Library', kind: 'entities' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  'reg-clauses': {
    id: 'reg-clauses',
    title: 'Clauses',
    entityNoun: 'Clause',
    icon: 'FileText',
    accent: 'teal',
    description: 'Clauses / sections of a regulation — the granularity at which obligations arise.',
    columns: [
      C('name', 'Clause', 'name', true),
      C('regulation', 'Regulation', 'text'),
      C('subject', 'Subject', 'text'),
      C('status', 'Status', 'status'),
    ],
    filters: ['regulation', 'status'],
    subtabs: [
      { id: 'library', label: 'Clauses', kind: 'entities' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  'reg-obligations': {
    id: 'reg-obligations',
    title: 'Obligations',
    entityNoun: 'Obligation',
    icon: 'Gavel',
    accent: 'amber',
    description: 'Structured requirements extracted from clauses — the unit that maps to the company.',
    columns: [
      C('name', 'Obligation', 'name', true),
      C('regulator', 'Regulator', 'pill'),
      C('frequency', 'Frequency', 'text'),
      C('applicability', 'Applicability', 'status'),
      C('coverage', 'Coverage', 'status'),
      C('verification', 'Verification', 'verification'),
    ],
    filters: ['regulator', 'frequency', 'applicability'],
    subtabs: [
      { id: 'library', label: 'Obligations', kind: 'entities' },
      { id: 'verification', label: 'Verification', kind: 'verification' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  'reg-changes': {
    id: 'reg-changes',
    title: 'Regulatory Changes',
    entityNoun: 'Change',
    icon: 'RefreshCw',
    accent: 'red',
    description: 'Amendments to regulations — the trigger for impact analysis on the company.',
    columns: [
      C('name', 'Change', 'name', true),
      C('regulation', 'Regulation', 'text'),
      C('changeType', 'Type', 'pill'),
      C('severity', 'Severity', 'criticality'),
      C('effective', 'Effective', 'text'),
      C('status', 'Status', 'status'),
    ],
    filters: ['changeType', 'severity', 'status'],
    subtabs: [
      { id: 'library', label: 'Changes', kind: 'entities' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
  'reg-sources': {
    id: 'reg-sources',
    title: 'Source Registry',
    entityNoun: 'Source',
    icon: 'Plug',
    accent: 'emerald',
    description: 'Where regulations are ingested from — primary sources of truth first.',
    columns: [
      C('name', 'Source', 'name', true),
      C('sourceType', 'Type', 'pill'),
      C('tier', 'Tier', 'text'),
      C('frequency', 'Frequency', 'text'),
      C('lastFetch', 'Last Fetch', 'text'),
      C('status', 'Status', 'status'),
    ],
    filters: ['sourceType', 'tier', 'status'],
    subtabs: [
      { id: 'registry', label: 'Registry', kind: 'entities' },
      { id: 'history', label: 'History', kind: 'history' },
    ],
  },
};

export const REG_ORDER: RegDomainId[] = [
  'reg-regulators',
  'reg-regulations',
  'reg-clauses',
  'reg-obligations',
  'reg-changes',
  'reg-sources',
];
