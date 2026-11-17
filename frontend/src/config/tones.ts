// One source of truth for a domain's signature colour, so chips, graph nodes,
// page headers and drawers all read the same hue for the same domain.
export const DOMAIN_TONE: Record<string, string> = {
  overview: '#2563eb',
  people: '#16a34a',
  processes: '#6366f1',
  systems: '#2563eb',
  data: '#0d9488',
  policies: '#2563eb',
  controls: '#059669',
  risks: '#dc2626',
  evidence: '#e11d48',
  // regulatory
  'reg-regulators': '#7c3aed',
  'reg-regulations': '#2563eb',
  'reg-clauses': '#0d9488',
  'reg-obligations': '#d97706',
  'reg-changes': '#dc2626',
  'reg-sources': '#64748b',
};

export const toneFor = (domainId: string) => DOMAIN_TONE[domainId] ?? '#2563eb';
