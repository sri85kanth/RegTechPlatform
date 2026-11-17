import type { Entity } from '@/types/entity';
import type { ApplicabilityResult, ApplicabilityMatch, Applicability } from '@/types/regulatory';
import { useData } from '@/app/store/data';
import { entityById } from '@/services/entities';

// ============================================================
// Applicability Engine (Phase 5)
//
// Answers "does this obligation apply to THIS company, and why?" —
// BEFORE any mapping. It evaluates each obligation against the
// company's ACTUAL context, which already exists as Overview entities
// with stable ids (Legal Entities, Jurisdictions, Licenses, Business
// Activities, Industries, Regulatory Scope). It references those ids —
// it never duplicates a company entity. Deterministic, no fabrication.
// ============================================================

const S = () => useData.getState();

/** Indian regulators — a company jurisdiction of India covers all of these. */
const INDIAN_REGULATORS = new Set(['RBI', 'FIU-IND', 'SEBI', 'MeitY', 'IRDAI', 'PFRDA', 'MCA']);

function overviewOfType(type: string): Entity[] {
  return S().entities.filter((e) => e.domain === 'overview' && e.type === type);
}

/** Map an obligation to the company's declared Regulatory Scope area (by id) if any. */
function matchRegulatoryScope(obl: Entity): Entity | undefined {
  const hay = `${obl.name} ${String(obl.attrs.clause ?? '')} ${String(obl.attrs.regulator ?? '')} ${String(obl.attrs.subject ?? '')}`.toLowerCase();
  const scope = overviewOfType('Regulatory Area');
  const rules: { id: string; test: RegExp }[] = [
    { id: 'ov-rs-kyc', test: /kyc|know your customer|cdd|due diligence/ },
    { id: 'ov-rs-aml', test: /str|pmla|money laundering|suspicious|aml/ },
    { id: 'ov-rs-dpdp', test: /dpdp|consent|personal data|privacy/ },
    { id: 'ov-rs-digital', test: /digital lending|cooling-?off|loan/ },
    { id: 'ov-rs-cyber', test: /mfa|cyber|authentication|critical system/ },
    { id: 'ov-rs-sebi', test: /sebi|securities/ },
  ];
  for (const r of rules) {
    if (r.test.test(hay)) {
      const s = scope.find((e) => e.id === r.id);
      if (s) return s;
    }
  }
  return undefined;
}

/**
 * Evaluate whether an obligation applies to the company, with the matched
 * company context (existing entity ids) and a reason built from real records.
 */
export function applicabilityFor(obligationId: string): ApplicabilityResult {
  const obl = entityById(obligationId);
  if (!obl) return { result: 'Needs Review', reason: 'Obligation not found.', matches: [], confidence: 0 };

  const regulator = String(obl.attrs.regulator ?? '');
  const subject = String(obl.attrs.subject ?? '').toLowerCase();
  const hay = `${obl.name} ${String(obl.attrs.clause ?? '')} ${subject} ${String(obl.attrs.object ?? '')}`.toLowerCase();
  const matches: ApplicabilityMatch[] = [];
  const add = (dimension: ApplicabilityMatch['dimension'], e?: Entity) => {
    if (e && !matches.some((m) => m.entityId === e.id)) matches.push({ dimension, entityId: e.id, entityName: e.name });
  };

  // 1) Jurisdiction — an Indian regulator is covered by the India jurisdiction.
  const jurisdictions = overviewOfType('Jurisdiction');
  const regulatorIsIndian = INDIAN_REGULATORS.has(regulator);
  const india = jurisdictions.find((j) => j.name === 'India' || String(j.attrs.regulator ?? '') === regulator);
  if (regulatorIsIndian) add('Jurisdiction', india);

  // 2) Legal entity — NBFC / reporting entity / data fiduciary → the NBFC legal entity.
  const legalEntities = overviewOfType('Legal Entity');
  const parent = legalEntities.find((l) => String(l.attrs.role ?? '') === 'Parent') ?? legalEntities[0];
  if (/nbfc|reporting entity|data fiduciary|regulated entit/.test(subject) || regulatorIsIndian) add('Legal Entity', parent);

  // 3) License — match a license whose authority is (or contains) the regulator.
  const licenses = overviewOfType('License');
  const lic = licenses.find((l) => String(l.attrs.authority ?? '').includes(regulator))
    ?? (regulator === 'RBI' ? licenses.find((l) => l.id === 'ov-lic-nbfc') : undefined);
  if (lic) add('License', lic);

  // 4) Business activity — lending/KYC/onboarding obligations touch the lending activities.
  const activities = overviewOfType('Business Activity');
  if (/kyc|cdd|onboard|loan|lending|customer|consent|suspicious|str/.test(hay)) {
    add('Business Activity', activities.find((a) => a.id === 'ov-ba-consumer') ?? activities[0]);
  }

  // 5) Regulatory scope — the company's own declared exposure area.
  const scope = matchRegulatoryScope(obl);
  add('Regulatory Scope', scope);

  // ---- decide the result from real signals ----
  const hasJurisdiction = matches.some((m) => m.dimension === 'Jurisdiction');
  const scopeApplicability = String(scope?.attrs.applicability ?? '');
  const flaggedNeedsReview = String(obl.attrs.applicability ?? '') === 'Needs Review';

  let result: Applicability;
  if (!hasJurisdiction) {
    result = 'Not Applicable';
  } else if (flaggedNeedsReview || scopeApplicability === 'Partial' || !scope) {
    result = 'Needs Review';
  } else {
    result = 'Applicable';
  }

  const confidence = Math.min(98, 46 + matches.length * 12 + (scope ? 6 : 0));

  // ---- reason built ONLY from matched records (no fabrication) ----
  const by = (d: ApplicabilityMatch['dimension']) => matches.find((m) => m.dimension === d)?.entityName;
  const reason = buildReason(result, regulator, {
    legal: by('Legal Entity'),
    jurisdiction: by('Jurisdiction'),
    license: by('License'),
    activity: by('Business Activity'),
    scope: by('Regulatory Scope'),
  });

  return { result, reason, matches, confidence };
}

function buildReason(
  result: Applicability,
  regulator: string,
  m: { legal?: string; jurisdiction?: string; license?: string; activity?: string; scope?: string },
): string {
  if (result === 'Not Applicable') {
    return `No company jurisdiction is regulated by ${regulator || 'this regulator'}, so the obligation does not apply.`;
  }
  const parts: string[] = [];
  if (m.legal && m.jurisdiction) parts.push(`${m.legal} operates in ${m.jurisdiction} under ${regulator}`);
  else if (m.jurisdiction) parts.push(`the company operates in ${m.jurisdiction} under ${regulator}`);
  if (m.license) parts.push(`holds the ${m.license}`);
  if (m.activity) parts.push(`conducts ${m.activity}`);
  if (m.scope) parts.push(`declares “${m.scope}” in its regulatory scope`);
  const body = parts.join(', ').replace(/,([^,]*)$/, ', and$1');
  return result === 'Needs Review'
    ? `Likely applies — ${body} — but a human should confirm (scope partial or flagged for review).`
    : `Applies: ${body}.`;
}

/** Portfolio applicability summary across all obligations. */
export function applicabilitySummary() {
  const obls = S().entities.filter((e) => e.domain === 'reg-obligations');
  const counts = { Applicable: 0, 'Not Applicable': 0, 'Needs Review': 0 } as Record<Applicability, number>;
  obls.forEach((o) => {
    counts[applicabilityFor(o.id).result]++;
  });
  return { total: obls.length, ...counts };
}
