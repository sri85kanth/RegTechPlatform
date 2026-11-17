import { tx } from '@/i18n';

/** One onboarding step per Company Brain domain — asked separately so the
 *  person doing the onboarding is never guessing what belongs where. */
export interface Section {
  id: string;
  label: string;
  /** singular noun for buttons — 'Processes' → 'process', not 'processe' */
  singular: string;
  /** entity_type injected into every row, so the CSV needs no type column */
  type: string;
  icon: string;
  /** this section's colour — its icon tile and step number on the Import Data screen */
  hex: string;
  question: string;
  help: string;
  examples: string[][];
  /** extra attributes worth capturing for this type, beyond name/owner/criticality */
  fields?: { key: string; label: string; placeholder: string; hint?: string }[];
  /**
   * The questions that build the graph. Each creates a real relationship from
   * this entity to entities in another domain — without these the graph has
   * no edges and impact cannot propagate.
   */
  links?: { verb: string; question: string; domain: string; hint: string }[];
}

export const SECTIONS: Section[] = [
  // ---- company context ----------------------------------------------------
  // These populate the Overview tabs (Legal Entities, Locations, Products…),
  // which existed in the UI but had no intake path at all — the screens were
  // there and permanently empty.
  {
    id: 'legal-entities', singular: tx('legal entity'), label: 'Legal Entities', type: 'legal_entity', icon: 'Building2', hex: '#6d28d9',
    question: tx('Which legal entities make up your group?'),
    help: tx('Regulations bind a legal entity, not a brand. A licence held by one subsidiary does not cover another, so this is what applicability is decided against.'),
    examples: [[tx('The parent company'), tx('the entity that holds the main licence')],
               [tx('A subsidiary'), tx('its own registration, its own obligations')]],
    fields: [
      { key: 'registrationNo', label: 'CIN / registration number', placeholder: 'L65910MH1987PLC042961' },
      { key: 'entityType', label: 'Entity type', placeholder: tx('NBFC-ICC / HFC / Bank'), hint: 'Drives which regulator applies' },
      { key: 'incorporated', label: 'Incorporated', placeholder: '1987' },
      { key: 'listed', label: 'Listed?', placeholder: tx('Yes / No'), hint: 'Listing brings SEBI obligations' },
    ],
    links: [
      { verb: 'holds', question: tx('Which licences does this entity hold?'), domain: 'overview', hint: 'A licence belongs to one entity' },
      { verb: 'operates in', question: tx('Which locations does it operate from?'), domain: 'overview', hint: '' },
    ],
  },
  {
    id: 'locations', singular: tx('location'), label: 'Locations & Jurisdictions', type: 'location', icon: 'MapPin', hex: '#c2410c',
    question: tx('Where do you operate, and under whose law?'),
    help: tx('Data-localisation and cross-border rules turn on where a thing physically is. State-level registrations depend on it too.'),
    examples: [[tx('Mumbai HQ'), tx('Maharashtra, India — head office')],
               [tx('Pune Data Centre'), tx('Maharashtra, India — primary hosting')]],
    fields: [
      { key: 'country', label: 'Country', placeholder: tx('India') },
      { key: 'state', label: 'State / region', placeholder: tx('Maharashtra') },
      { key: 'locationType', label: 'Type', placeholder: tx('Head office / Branch / Data centre') },
    ],
    links: [
      { verb: 'hosts', question: tx('Which systems run here?'), domain: 'systems', hint: 'Where a system sits decides residency rules' },
    ],
  },
  {
    id: 'products', singular: tx('product'), label: 'Products & Services', type: 'product', icon: 'Package', hex: '#be185d',
    question: tx('What do you actually sell?'),
    help: tx('Product-specific rules are the largest category of regulation. A lending product and an insurance product attract completely different obligations.'),
    examples: [[tx('Personal Loan'), tx('Unsecured retail lending')],
               [tx('Consumer Durable EMI'), tx('Point-of-sale finance')]],
    fields: [
      { key: 'productType', label: 'Product type', placeholder: tx('Lending / Deposit / Insurance / Payments') },
      { key: 'segment', label: 'Customer segment', placeholder: tx('Retail / SME / Corporate') },
      { key: 'launched', label: 'Launched', placeholder: '2019' },
    ],
    links: [
      { verb: 'delivered by', question: tx('Which processes deliver it?'), domain: 'processes', hint: 'Product rules land on the process' },
      { verb: 'uses', question: tx('Which customer data does it collect?'), domain: 'data', hint: '' },
    ],
  },
  {
    id: 'business-activities', singular: tx('business activity'), label: 'Business Activities & Licences', type: 'business_activity', icon: 'Briefcase', hex: '#0369a1',
    question: tx('Which regulated activities do you carry out, and under which licence?'),
    help: tx('The activity is what makes a regulator interested in you. Recording the licence alongside it is what lets applicability be evidenced rather than assumed.'),
    examples: [[tx('Retail lending'), tx('Under RBI NBFC Certificate of Registration')],
               [tx('Payment aggregation'), tx('Under RBI PA licence')]],
    fields: [
      { key: 'regulator', label: 'Regulator', placeholder: 'RBI / SEBI / IRDAI' },
      { key: 'licence', label: 'Licence / registration', placeholder: tx('NBFC Certificate of Registration') },
      { key: 'licenceNo', label: 'Licence number', placeholder: 'N-13.02234' },
      { key: 'validTill', label: 'Valid till', placeholder: tx('Perpetual / Mar 2027'), hint: 'Expiring licences are a live risk' },
    ],
    links: [
      { verb: 'carried out by', question: tx('Which legal entity carries this out?'), domain: 'overview', hint: '' },
    ],
  },
  {
    id: 'people', singular: tx('person'), label: 'People & Departments', type: 'person', icon: 'Users', hex: '#15803d',
    question: tx('Who works here, and which departments exist?'),
    help: tx('The people and teams who own things. Owners must exist before anything can be assigned to them, so this goes first.'),
    examples: [
      ['Priya Sharma', tx('Compliance Manager'), '', 'High'],
      ['Aarav Mehta', tx('Head of Risk'), '', 'High'],
      [tx('Compliance'), tx('Regulatory compliance department'), 'Priya Sharma', 'High'],
    ],
    fields: [
      { key: 'role', label: 'Role or title', placeholder: tx('Compliance Manager') },
      { key: 'department', label: 'Department', placeholder: tx('Compliance') },
      { key: 'email', label: 'Email', placeholder: 'priya.sharma@company.com' },
    ],
  },
  {
    id: 'processes', singular: tx('process'), label: 'Processes', type: 'process', icon: 'Workflow', hex: '#4338ca',
    question: tx('What does your company actually do, step by step?'),
    help: tx('Business procedures — onboarding a customer, disbursing a loan, screening a payment. This is the highest-weighted domain in impact scoring, so be generous here.'),
    examples: [
      [tx('Customer Onboarding'), tx('End-to-end account opening'), 'Meera Krishnan', 'Critical'],
      [tx('KYC Verification'), tx('Verify customer identity documents'), 'Priya Sharma', 'Critical'],
      [tx('Loan Origination'), tx('Assess and disburse credit'), 'Rajeev Jain', 'High'],
    ],
    fields: [
      { key: 'frequency', label: 'How often does it run?', placeholder: tx('Continuous / Daily / Quarterly') },
      { key: 'volume', label: 'Rough volume', placeholder: tx('12,000 per month'), hint: 'Helps size the impact of a change' },
    ],
    links: [
      { verb: 'uses', question: tx('Which systems does this process run on?'), domain: 'systems', hint: 'A rule about the process usually lands on its systems too' },
      { verb: 'processes', question: tx('Which data does it touch?'), domain: 'data', hint: 'Data-handling rules reach the process through this edge' },
      { verb: 'governed by', question: tx('Which policy governs it?'), domain: 'policies', hint: 'Policy changes propagate down to the process' },
      { verb: 'checked by', question: tx('Which controls check it?'), domain: 'controls', hint: 'Controls are how you evidence the process is compliant' },
    ],
  },
  {
    id: 'systems', singular: tx('system'), label: 'Systems', type: 'system', icon: 'Server', hex: '#1d4ed8',
    question: tx('Which applications and platforms run those processes?'),
    help: tx('Software, platforms and services — usually exportable from a CMDB or your IT asset list.'),
    examples: [
      [tx('Core Banking System'), tx('System of record for accounts'), 'Aarav Mehta', 'Critical'],
      [tx('AML Platform'), tx('Transaction monitoring engine'), 'Aarav Mehta', 'Critical'],
      ['Salesforce CRM', tx('Customer relationship management'), 'Meera Krishnan', 'Medium'],
    ],
    fields: [
      { key: 'hosting', label: 'Where is it hosted?', placeholder: tx('On-premise / AWS / Vendor SaaS'), hint: 'Cross-border hosting triggers data-localisation rules' },
      { key: 'vendor', label: 'Vendor', placeholder: tx('In-house / Temenos / Salesforce') },
    ],
    links: [
      { verb: 'stores', question: tx('Which data does this system hold?'), domain: 'data', hint: 'This is the edge data-protection rules travel along' },
      { verb: 'protected by', question: tx('Which controls protect it?'), domain: 'controls', hint: 'Access reviews, encryption, monitoring' },
    ],
  },
  {
    id: 'data', singular: tx('data asset'), label: 'Data Assets', type: 'data_asset', icon: 'Database', hex: '#0f766e',
    question: tx('What data do you hold and process?'),
    help: tx('Datasets, document stores and records — especially anything containing customer or personal data.'),
    examples: [
      [tx('KYC Documents'), tx('Identity documents and proofs'), 'Meera Krishnan', 'Critical'],
      [tx('Transaction Data'), tx('Payment and transfer records'), 'Aarav Mehta', 'Critical'],
      [tx('Credit Bureau Data'), tx('Third-party credit reports'), 'Rajeev Jain', 'High'],
    ],
    fields: [
      { key: 'personalData', label: 'Contains personal data?', placeholder: tx('Yes / No'), hint: 'Drives DPDP applicability' },
      { key: 'retention', label: 'Retention period', placeholder: tx('5 years after closure'), hint: 'Many rules set a minimum retention' },
      { key: 'residency', label: 'Stored where?', placeholder: tx('India / EU / US') },
    ],
    links: [
      { verb: 'governed by', question: tx('Which policy governs this data?'), domain: 'policies', hint: '' },
    ],
  },
  {
    id: 'policies', singular: tx('policy'), label: 'Policies', type: 'policy', icon: 'FileText', hex: '#a16207',
    question: tx('Which internal policies govern how you operate?'),
    help: tx('Your policy register — the documents that set the rules internally. Upload the register here; the PDFs come in a later step.'),
    examples: [
      [tx('KYC Policy'), tx('Customer identification standards'), 'Priya Sharma', 'High'],
      [tx('AML Policy'), tx('Anti-money-laundering standards'), 'Aarav Mehta', 'Critical'],
      [tx('Information Security Policy'), tx('Data protection standards'), 'Aarav Mehta', 'High'],
    ],
    fields: [
      { key: 'version', label: 'Current version', placeholder: 'v3.2' },
      { key: 'lastReviewed', label: 'Last reviewed', placeholder: tx('Mar 2026'), hint: 'Stale policies are the first thing a regulator asks about' },
      { key: 'approvedBy', label: 'Approved by', placeholder: tx('Board / Risk Committee') },
    ],
    links: [
      { verb: 'implemented by', question: tx('Which controls implement this policy?'), domain: 'controls', hint: 'A policy with no control behind it is a finding waiting to happen' },
    ],
  },
  {
    id: 'controls', singular: tx('control'), label: 'Controls', type: 'control', icon: 'ShieldCheck', hex: '#047857',
    question: tx('What checks and controls do you operate?'),
    help: tx('The mechanisms that enforce policy — approvals, reconciliations, monitoring rules. Usually the largest list, often from a GRC tool.'),
    examples: [
      [tx('KYC Verification Control'), tx('Verifies identity documents at onboarding'), 'Priya Sharma', 'High'],
      [tx('Transaction Monitoring'), tx('Flags suspicious payment patterns'), 'Aarav Mehta', 'Critical'],
      [tx('Access Review'), tx('Quarterly user access recertification'), 'Aarav Mehta', 'High'],
    ],
    fields: [
      { key: 'frequency', label: 'How often does it run?', placeholder: tx('Continuous / Daily / Quarterly') },
      { key: 'automated', label: 'Automated or manual?', placeholder: tx('Automated / Manual / Hybrid') },
      { key: 'lastTested', label: 'Last tested', placeholder: tx('Jun 2026') },
    ],
    links: [
      { verb: 'mitigates', question: tx('Which risk does this control reduce?'), domain: 'risks', hint: '' },
      { verb: 'evidenced by', question: tx('What evidence proves it ran?'), domain: 'evidence', hint: 'Without evidence you cannot demonstrate compliance' },
    ],
  },
  {
    id: 'risks', singular: tx('risk'), label: 'Risks', type: 'risk', icon: 'AlertTriangle', hex: '#b91c1c',
    question: tx('Which risks are you managing?'),
    help: tx('Your risk register. Regulatory changes usually alter risk treatment, so these connect directly to impact.'),
    examples: [
      [tx('AML / CFT Non-Compliance'), tx('Regulatory penalty exposure'), 'Aarav Mehta', 'Critical'],
      [tx('Customer Data Breach'), tx('Loss of personal data'), 'Aarav Mehta', 'Critical'],
      [tx('Credit Default'), tx('Borrower non-payment'), 'Rajeev Jain', 'High'],
    ],
    fields: [
      { key: 'inherent', label: 'Inherent rating', placeholder: tx('High / Medium / Low') },
      { key: 'residual', label: 'Residual rating', placeholder: tx('Medium'), hint: 'After controls are applied' },
      { key: 'appetite', label: 'Within appetite?', placeholder: tx('Yes / No') },
    ],
  },
  {
    id: 'evidence', singular: tx('evidence record'), label: 'Evidence', type: 'evidence', icon: 'Paperclip', hex: '#be123c',
    question: tx('What proves your controls actually ran?'),
    help: tx('Reports, logs, attestations and audit artefacts — what you would hand a regulator to demonstrate compliance.'),
    examples: [
      [tx('KYC Review Report'), tx('Quarterly review output'), 'Priya Sharma', 'Medium'],
      [tx('Transaction Monitoring Log'), tx('Daily alert disposition record'), 'Aarav Mehta', 'High'],
      [tx('Board Compliance Report'), tx('Quarterly report to the board'), 'Priya Sharma', 'High'],
    ],
    fields: [
      { key: 'frequency', label: 'Produced how often?', placeholder: tx('Daily / Monthly / Quarterly') },
      { key: 'retention', label: 'Retained for', placeholder: tx('8 years') },
      { key: 'location', label: 'Stored where?', placeholder: tx('SharePoint / GRC tool') },
    ],
  },
];
