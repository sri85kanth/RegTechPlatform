import { txList } from '@/i18n';
// ============================================================
// Company regulatory profile → which authorities bind this company.
// Deterministic rules over declared licences, sectors and activities.
// Every rule states the reason, so the answer is explainable — the
// same discipline the impact engine follows.
// ============================================================

export interface CompanyProfile {
  legalName: string;
  registrationNo: string;
  /** what kind of organisation it is — "Hospital — multispecialty". Applicability runs on this. */
  entityType: string;
  /** how it is constituted, as the register states it — "Private Limited Company" */
  legalForm: string;
  registeredAddress: string;
  /** Legal Entity Identifier, when the company was found in the public LEI register */
  lei: string;
  incorporated: string;
  hqState: string;
  jurisdictions: string[];
  sectors: string[];
  licences: string[];
  employees: string;
  turnoverCr: string;
  customers: string;
  listed: boolean;
  handlesPersonalData: boolean;
  importsExports: boolean;
}

/**
 * What kind of entity this is.
 *
 * Two things live here, deliberately: the CONSTITUTION (how it is incorporated)
 * and the REGULATED KIND (what it does that a regulator cares about). A profile
 * derived from documents answers the first — "private company limited by
 * shares" is what a Legal Entity & Statutory Identifiers page states — while
 * applicability is decided mostly by the second.
 *
 * Every list here was financial. A hospital could not describe itself at all:
 * its stored constitution matched no option, so the field rendered as unset and
 * the only honest choice available was "Other private limited company".
 *
 * The constitutional forms must match derive_company_profile.py's TYPE_RE
 * output exactly, or a derived value cannot be displayed. A test asserts that.
 */
export const ENTITY_TYPES = txList([
  // constitution — what the incorporation documents say
  'Private company limited by shares', 'Public company limited by shares',
  'Limited Liability Partnership', 'Partnership firm', 'Sole proprietorship',
  'Trust', 'Society', 'Section 8 (not-for-profit) company',
  // healthcare providers
  'Hospital — multispecialty', 'Hospital — single specialty', 'Nursing home / clinic',
  'Day-care / ambulatory surgery centre', 'Dental clinic', 'Eye hospital',
  'Ayush hospital / clinic', 'Telemedicine provider', 'Ambulance service provider',
  // diagnostics and laboratories
  'Diagnostic centre', 'Pathology / clinical laboratory', 'Imaging / radiology centre',
  'Blood centre (blood bank)', 'Genetic counselling centre / genetic clinic',
  'ART clinic / ART bank',
  // pharma, devices and research
  'Pharmacy — retail', 'Pharmacy — hospital', 'Pharmaceutical manufacturer',
  'Pharmaceutical distributor / wholesaler', 'Medical device manufacturer',
  'Medical device importer', 'Clinical research organisation (CRO)',
  'Biotechnology / life sciences', 'Biomedical waste treatment facility',
  // health cover
  'Health insurer', 'Third-party administrator (TPA)',
  // financial
  'NBFC — Investment & Credit Company', 'Bank — Commercial', 'Bank — Small Finance',
  'Insurance company', 'Insurance broker', 'Stock broker / intermediary',
  'Asset management company', 'Pension fund intermediary', 'Payment system operator',
  // other industry
  'Manufacturing', 'IT / software services', 'Telecom service provider',
  'Food business operator', 'Other private limited company',
]);

/**
 * The constitutional forms at the head of ENTITY_TYPES. The setup form now asks
 * for the legal form separately — the public register answers it — so a stored
 * entity_type that is one of these is a legal form, not an organisation type.
 */
export const CONSTITUTIONS = ENTITY_TYPES.slice(0, ENTITY_TYPES.indexOf('Hospital — multispecialty'));

/** What kind of organisation it is: every entity type that is not a legal form. */
export const ORGANISATION_TYPES = ENTITY_TYPES.filter((t) => !CONSTITUTIONS.includes(t));

/**
 * Sectors. The healthcare entries must match derive_company_profile.py's
 * SECTOR_RE labels exactly — a derived sector absent from this list used to
 * render as nothing at all, so a hospital saw "Healthcare" unselected while its
 * profile actually held "Healthcare & Hospitals".
 */
export const SECTORS = txList([
  // healthcare and life sciences
  'Healthcare & Hospitals', 'Diagnostics & Laboratory', 'Pharmacy', 'Blood Bank',
  'Pharmaceuticals manufacturing', 'Medical devices', 'Clinical research',
  'Ayush / traditional medicine', 'Biotechnology', 'Health insurance / TPA',
  'Telemedicine', 'Biomedical waste management',
  // financial
  'Banking & Finance', 'Insurance', 'Capital markets', 'Pensions', 'Payments',
  // other
  'Information technology', 'Telecommunications', 'Manufacturing',
  'Food & beverages', 'Logistics & trade', 'Healthcare', 'Energy',
]);

/**
 * Licences. A licence is the strongest applicability signal there is — it binds
 * the holder directly — so a licence the company holds but this list does not
 * name was a licence the product could not reason about.
 */
export const LICENCES = txList([
  // healthcare establishment
  'Clinical Establishment Registration', 'NABH Accreditation',
  'NABL Accreditation (ISO 15189)', 'Fire NOC', 'Lift licence',
  'Boiler certificate', 'Pollution Control Board consent',
  'Biomedical Waste Authorisation', 'AERB Radiation Licence',
  'PNDT / PCPNDT Registration', 'ART / Surrogacy clinic registration',
  'Ayushman Bharat (PM-JAY) empanelment',
  // drugs, blood and devices
  'Drug Licence — retail', 'Drug Licence — wholesale',
  'Drug manufacturing licence', 'Blood Centre Licence',
  'Narcotic & psychotropic substances licence', 'Medical gas licence',
  'Medical device licence (MDR 2017)',
  // financial
  'RBI — NBFC Certificate of Registration', 'RBI — Banking licence', 'RBI — Payment Aggregator',
  'SEBI — Intermediary registration', 'IRDAI — Insurer / broker registration',
  'PFRDA — Point of Presence',
  // cross-industry
  'GST registration', 'IEC — Import Export Code',
  'TRAI / DoT — Telecom licence', 'FSSAI licence', 'Factory / pollution consent',
]);

export const JURISDICTIONS = txList([
  'India — all states', 'Maharashtra', 'Karnataka', 'Delhi NCR', 'Tamil Nadu',
  'Gujarat', 'West Bengal', 'Telangana', 'Cross-border / overseas branch',
]);

export interface AuthorityMatch {
  short: string;
  name: string;
  reason: string;
  basis: 'Licence' | 'Sector' | 'Activity' | 'Size' | 'Universal';
  /** other names the regulation library files this authority under, so its count is whole */
  aliases?: string[];
}

/** Authorities that bind essentially every incorporated Indian company. */
const UNIVERSAL: AuthorityMatch[] = [
  { short: 'India Code', name: 'Central Acts of India', reason: 'Companies Act and central statutes bind every incorporated entity', basis: 'Universal' },
  { short: 'CBIC', name: 'Central Board of Indirect Taxes & Customs', reason: 'GST applies to registered businesses', basis: 'Universal' },
  { short: 'CCI', name: 'Competition Commission of India', reason: 'Competition Act applies to all enterprises', basis: 'Universal' },
];

export function authoritiesFor(p: CompanyProfile): AuthorityMatch[] {
  const out: AuthorityMatch[] = [...UNIVERSAL];
  const add = (m: AuthorityMatch) => { if (!out.some((x) => x.short === m.short)) out.push(m); };
  const has = (src: string | string[], needle: string) =>
    (Array.isArray(src) ? src : [src]).some((v) => v.toLowerCase().includes(needle.toLowerCase()));

  if (has(p.licences, 'RBI') || has(p.entityType, 'NBFC') || has(p.entityType, 'Bank') || has(p.entityType, 'Payment'))
    add({ short: 'RBI', name: 'Reserve Bank of India', reason: 'Holds an RBI registration or operates as a regulated financial entity', basis: 'Licence' });

  if (has(p.licences, 'SEBI') || has(p.entityType, 'broker') || has(p.entityType, 'Asset management') || p.listed)
    add({ short: 'SEBI', name: 'Securities and Exchange Board of India', reason: p.listed ? 'Listed entity — SEBI LODR applies' : 'Registered market intermediary', basis: p.listed ? 'Activity' : 'Licence' });

  if (has(p.licences, 'IRDAI') || has(p.entityType, 'Insurance') || has(p.sectors, 'Insurance'))
    add({ short: 'IRDAI', name: 'Insurance Regulatory and Development Authority', reason: 'Insurance business or intermediary registration', basis: 'Licence' });

  if (has(p.licences, 'PFRDA') || has(p.sectors, 'Pensions'))
    add({ short: 'PFRDA', name: 'Pension Fund Regulatory and Development Authority', reason: 'Pension distribution or fund activity', basis: 'Licence' });

  if (has(p.licences, 'Telecom') || has(p.sectors, 'Telecom') || has(p.entityType, 'Telecom'))
    add({ short: 'TRAI', name: 'Telecom Regulatory Authority of India', reason: 'Telecom licence or service provision', basis: 'Licence' });

  if (has(p.licences, 'FSSAI') || has(p.sectors, 'Food') || has(p.entityType, 'Food'))
    add({ short: 'FSSAI', name: 'Food Safety and Standards Authority of India', reason: 'Food business operation', basis: 'Licence' });

  if (p.importsExports || has(p.licences, 'IEC') || has(p.sectors, 'Logistics'))
    add({ short: 'DGFT', name: 'Directorate General of Foreign Trade', reason: 'Cross-border trade activity', basis: 'Activity' });

  if (has(p.sectors, 'Manufacturing') || has(p.entityType, 'Manufacturing') || has(p.licences, 'pollution'))
    add({ short: 'CPCB', name: 'Central Pollution Control Board', reason: 'Manufacturing operations require environmental consent', basis: 'Sector' });

  if (p.handlesPersonalData)
    add({ short: 'MeitY', name: 'Ministry of Electronics and IT', reason: 'Processes personal data — IT Act and DPDP Act apply', basis: 'Activity' });

  if (p.handlesPersonalData || has(p.sectors, 'Information technology') || has(p.entityType, 'IT'))
    add({ short: 'CERT-In', name: 'Indian Computer Emergency Response Team', reason: 'Cyber incident reporting directions apply to body corporates', basis: 'Activity' });

  // ---- healthcare. Every short below is a regulator the library actually
  // tracks; the list used to stop at finance and industry, so a hospital with
  // an AERB licence and a biomedical-waste authorisation was told only about
  // the Companies Act, GST and competition law.
  const careProvider = ['Hospital', 'Nursing home', 'clinic', 'Day-care', 'Diagnostic', 'laboratory',
    'Imaging', 'Blood centre', 'Dental', 'Eye hospital', 'Ayush', 'ART clinic', 'Genetic']
    .some((w) => has(p.entityType, w)) || has(p.sectors, 'Healthcare') || has(p.sectors, 'Diagnostics');

  if (has(p.licences, 'Biomedical Waste') || careProvider) {
    add({ short: 'CPCB', name: 'Central Pollution Control Board', aliases: ['Central Pollution Control Board'],
      reason: 'Biomedical Waste Management Rules, 2016 bind every facility that generates biomedical waste',
      basis: has(p.licences, 'Biomedical Waste') ? 'Licence' : 'Sector' });
    // The state board issues the authorisation itself.
    for (const st of [p.hqState, ...p.jurisdictions].filter((j) => j && !/India|Cross-border|NCR/.test(j))) {
      add({ short: `${st} State Pollution Control Board`, name: `${st} State Pollution Control Board`,
        reason: `Issues the biomedical-waste authorisation and consents for facilities in ${st}`, basis: 'Licence' });
    }
  }

  if (has(p.licences, 'AERB') || has(p.entityType, 'Imaging'))
    add({ short: 'AERB', name: 'Atomic Energy Regulatory Board', aliases: ['Atomic Energy Regulatory Board'],
      reason: 'X-ray, CT, cath-lab and radiotherapy equipment is licensed under the Atomic Energy (Radiation Protection) Rules, 2004',
      basis: 'Licence' });

  if (['Drug Licence', 'Drug manufacturing', 'Blood Centre', 'Medical device', 'Narcotic'].some((w) => has(p.licences, w))
      || ['Pharmacy', 'Pharmaceutical', 'Medical device', 'Blood centre'].some((w) => has(p.entityType, w)))
    add({ short: 'CDSCO', name: 'Central Drugs Standard Control Organisation',
      reason: 'Drug, blood-centre and medical-device licences are held under the Drugs and Cosmetics Act and the Medical Devices Rules, 2017',
      basis: 'Licence' });

  if (careProvider)
    add({ short: 'NMC', name: 'National Medical Commission', aliases: ['National Medical Commission'],
      reason: 'Regulates the registered medical practitioners who treat patients here', basis: 'Sector' });

  if (has(p.licences, 'NABH'))
    add({ short: 'NABH', name: 'National Accreditation Board for Hospitals & Healthcare Providers',
      reason: 'Accredited — NABH standards and periodic assessments apply', basis: 'Licence' });

  if (has(p.sectors, 'Clinical research') || has(p.entityType, 'Clinical research'))
    add({ short: 'ICMR', name: 'Indian Council of Medical Research',
      reason: "Clinical research follows ICMR's National Ethical Guidelines", basis: 'Sector' });

  if (has(p.sectors, 'Pharmaceuticals') || has(p.entityType, 'Pharmaceutical manufacturer'))
    add({ short: 'National Pharmaceutical Pricing Authority', name: 'National Pharmaceutical Pricing Authority',
      reason: 'Fixes and monitors drug prices under the Drugs (Prices Control) Order, 2013', basis: 'Sector' });

  // ---- employers, by size. Statutory headcounts, not estimates.
  const staff = Number(p.employees);
  if (Number.isFinite(staff) && staff >= 10)
    add({ short: 'ESIC', name: "Employees' State Insurance Corporation",
      reason: 'The ESI Act covers establishments employing 10 or more people in implemented areas', basis: 'Size' });
  if (Number.isFinite(staff) && staff >= 20)
    add({ short: 'EPFO', name: "Employees' Provident Fund Organisation",
      reason: 'The EPF Act covers establishments employing 20 or more people', basis: 'Size' });

  return out;
}

/** Threshold triggers worth flagging — these change *which* rules bite, not just who regulates you. */
export function thresholdFlags(p: CompanyProfile): { label: string; note: string }[] {
  const flags: { label: string; note: string }[] = [];
  const cr = Number(p.turnoverCr);
  const emp = Number(p.employees);
  if (!Number.isNaN(cr) && cr >= 500) flags.push({ label: 'Turnover ≥ ₹500 Cr', note: 'Higher-tier reporting and board-committee requirements typically apply' });
  if (!Number.isNaN(cr) && cr >= 250) flags.push({ label: 'Turnover ≥ ₹250 Cr', note: 'CSR obligations under the Companies Act may be triggered' });
  if (!Number.isNaN(emp) && emp >= 100) flags.push({ label: '100+ employees', note: 'Standing orders and several labour-law thresholds engage' });
  if (p.listed) flags.push({ label: 'Listed entity', note: 'SEBI LODR continuous-disclosure obligations apply' });
  if (p.handlesPersonalData) flags.push({ label: 'Processes personal data', note: 'DPDP Act duties as a Data Fiduciary' });
  return flags;
}
