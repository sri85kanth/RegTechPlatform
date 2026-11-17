import type { ColumnDef, DomainConfig } from '@/config/domains';

const C = (key: string, label: string, kind: ColumnDef['kind']): ColumnDef => ({ key, label, kind });

/** How each Overview sub-tab renders. `table` tabs list overview entities of a
 *  given type; the others are computed/dashboard views handled in OverviewPage. */
export type OverviewTabKind = 'summary' | 'table' | 'completeness' | 'data-quality' | 'verification' | 'activity' | 'history';

export interface OverviewTab {
  id: string;
  label: string;
  kind: OverviewTabKind;
  filterType?: string; // for kind 'table'
  columns?: ColumnDef[]; // for kind 'table'
}

const VER = C('verification', 'Verification', 'verification');

export const OV_TABS: OverviewTab[] = [
  { id: 'summary', label: 'Summary', kind: 'summary' },
  {
    id: 'company-profile', label: 'Company Profile', kind: 'table', filterType: 'Attribute',
    columns: [C('name', 'Attribute', 'name'), C('value', 'Value', 'text'), C('category', 'Category', 'pill'), VER],
  },
  {
    id: 'business-activities', label: 'Business Activities', kind: 'table', filterType: 'Business Activity',
    columns: [C('name', 'Activity', 'name'), C('category', 'Category', 'pill'), C('revenue', 'Revenue Share', 'text'), C('segment', 'Segment', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'legal-entities', label: 'Legal Entities', kind: 'table', filterType: 'Legal Entity',
    columns: [C('name', 'Legal Entity', 'name'), C('role', 'Role', 'pill'), C('jurisdiction', 'Jurisdiction', 'text'), C('cin', 'CIN', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'locations', label: 'Locations', kind: 'table', filterType: 'Location',
    columns: [C('name', 'Location', 'name'), C('kind', 'Type', 'pill'), C('city', 'City', 'text'), C('country', 'Country', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'jurisdictions', label: 'Jurisdictions', kind: 'table', filterType: 'Jurisdiction',
    columns: [C('name', 'Jurisdiction', 'name'), C('regulator', 'Regulator', 'pill'), C('scope', 'Scope', 'text'), C('status', 'Status', 'status'), VER],
  },
  {
    id: 'industries', label: 'Industries & Sectors', kind: 'table', filterType: 'Industry',
    columns: [C('name', 'Industry', 'name'), C('code', 'Code', 'text'), C('sector', 'Sector', 'pill'), C('primary', 'Primary', 'text'), VER],
  },
  {
    id: 'products', label: 'Products & Services', kind: 'table', filterType: 'Product',
    columns: [C('name', 'Product', 'name'), C('category', 'Category', 'pill'), C('segment', 'Segment', 'text'), C('status', 'Status', 'status'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'organization', label: 'Organization', kind: 'table', filterType: 'Org Unit',
    columns: [C('name', 'Unit', 'name'), C('kind', 'Type', 'pill'), C('head', 'Head', 'text'), C('headcount', 'Headcount', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'licenses', label: 'Licenses & Registrations', kind: 'table', filterType: 'License',
    columns: [C('name', 'License', 'name'), C('authority', 'Authority', 'pill'), C('number', 'Number', 'text'), C('validTill', 'Valid Till', 'text'), C('status', 'Status', 'status'), VER],
  },
  {
    id: 'regulatory-scope', label: 'Regulatory Scope', kind: 'table', filterType: 'Regulatory Area',
    columns: [C('name', 'Regulatory Area', 'name'), C('regulator', 'Regulator', 'pill'), C('applicability', 'Applicability', 'text'), C('obligations', 'Obligations', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  {
    id: 'critical-functions', label: 'Critical Functions', kind: 'table', filterType: 'Critical Function',
    columns: [C('name', 'Function', 'name'), C('impact', 'Business Impact', 'text'), C('owner', 'Owner', 'text'), C('dependencies', 'Dependencies', 'text'), C('criticality', 'Criticality', 'criticality'), VER],
  },
  { id: 'completeness', label: 'Completeness', kind: 'completeness' },
  { id: 'data-quality', label: 'Data Quality', kind: 'data-quality' },
  { id: 'verification', label: 'Verification', kind: 'verification' },
  // one feed (audit_events); 'History' rendered the identical view and was dropped
  { id: 'activity', label: 'Activity', kind: 'activity' },
];

/** Registry entry — gives the drawer a title/icon/columns for overview entities. */
export const OVERVIEW_DOMAIN: DomainConfig = {
  id: 'overview' as DomainConfig['id'],
  title: 'Overview',
  entityNoun: 'Record',
  icon: 'LayoutGrid',
  accent: 'violet',
  description: 'The company itself — profile, structure, footprint and regulatory exposure.',
  columns: [C('name', 'Name', 'name'), C('value', 'Value', 'text'), C('category', 'Category', 'pill'), C('status', 'Status', 'status'), VER],
  filters: [],
  subtabs: [],
};
