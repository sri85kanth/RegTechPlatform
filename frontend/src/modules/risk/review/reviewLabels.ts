/**
 * The words of the Risk review screens: verdicts, gates, priorities, treatment
 * options, control grades, lifecycle, and the facts the engine reads.
 */
import type { Gate, Grade, Lifecycle, Priority, ReviewTask, Treatment, Verdict } from '@/services/riskReviewApi';
import { tx } from '@/i18n';
import { BAND_LABEL } from '../labels';

export const VERDICT_LABEL: Record<Verdict, string> = {
  WITHIN_APPETITE: tx('Within appetite'), TREAT: tx('Treat'), ESCALATE: tx('Escalate'),
  INSUFFICIENT_EVIDENCE: tx("Can't score yet"), REVIEW_REQUIRED: tx('Needs review'),
};
export const VERDICT_TONE: Record<Verdict, string> = {
  WITHIN_APPETITE: 'bg-emerald-50 text-emerald-700', TREAT: 'bg-orange-50 text-orange-700',
  ESCALATE: 'bg-red-50 text-red-700', INSUFFICIENT_EVIDENCE: 'bg-slate-100 text-slate-700',
  REVIEW_REQUIRED: 'bg-sky-50 text-sky-700',
};

/** solid colours for the marks that carry a verdict or a band (readable white text on each, in both themes) */
export const VERDICT_HEX: Record<Verdict, string> = {
  ESCALATE: '#dc2626', TREAT: '#ea580c', INSUFFICIENT_EVIDENCE: '#64748b', REVIEW_REQUIRED: '#0284c7', WITHIN_APPETITE: '#059669',
};
export const VERDICT_ORDER: Verdict[] = ['ESCALATE', 'TREAT', 'INSUFFICIENT_EVIDENCE', 'REVIEW_REQUIRED', 'WITHIN_APPETITE'];
export const BAND_HEX: Record<string, string> = { LOW: '#059669', MEDIUM: '#d97706', HIGH: '#ea580c', CRITICAL: '#dc2626' };
export const PRIORITY_HEX: Record<Priority, string> = { P0: '#dc2626', P1: '#d97706', P2: '#94a3b8' };

export const GATE_LABEL: Record<Gate, string> = {
  G6: tx('Treatment'), G5: tx('Needs attention'), G7: tx('Second approval'), G4: tx('Claimed control'),
  G3: tx('Applicability'), G9: tx('Possible risk'), G8: tx('Rulebook'),
};
export const GATE_ORDER: Gate[] = ['G6', 'G5', 'G7', 'G4', 'G3', 'G9', 'G8'];

export const PRIORITY_LABEL: Record<Priority, string> = { P0: tx('Urgent'), P1: tx('Soon'), P2: tx('Routine') };
export const PRIORITY_TONE: Record<Priority, string> = {
  P0: 'bg-red-50 text-red-700', P1: 'bg-amber-50 text-amber-700', P2: 'bg-slate-100 text-slate-600',
};

export const TREATMENT_LABEL: Record<Treatment, [string, string]> = {
  MITIGATE: [tx('Mitigate'), tx('Reduce how likely or how bad it is, with actions')],
  ACCEPT: [tx('Accept'), tx('Keep it as it is, by informed decision, until a review date')],
  TRANSFER: [tx('Transfer'), tx('Share it through insurance or a contract')],
  AVOID: [tx('Avoid'), tx('Stop, or do not start, the activity')],
  ESCALATE: [tx('Escalate'), tx('Refer the decision to leadership')],
};

export const GRADE_LABEL: Record<Grade, [string, string]> = {
  TESTED: [tx('Tested'), tx('Approved, and tested or audited recently')],
  DOCUMENTED: [tx('Documented'), tx('An approved document, not yet tested')],
  CLAIMED: [tx('Self-declared'), tx('Someone says it exists; nothing shows it yet')],
  ABSENT: [tx('Absent'), tx('Confirmed not in place')],
};

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  IDENTIFIED: tx('Identified'), ASSESSED: tx('Assessed'), IN_TREATMENT: tx('In treatment'),
  ACCEPTED: tx('Accepted'), CLOSED: tx('Closed'), RETIRED: tx('Retired'),
};

/** what the engine reads, in words a reviewer can act on */
export const FACT_LABEL: Record<string, string> = {
  theme: tx('Which theme it belongs to'), applicability: tx('Whether the duty applies (Requirements page)'),
  controls: tx('What controls are in place'), 'history.status': tx('History, or a signed "none"'),
  'exposure.sites': tx('The sites it covers'), 'exposure.scale_index': tx('The size of each site'),
  'node.criticality': tx('How critical it is'), 'node.personal_data': tx('Whether it holds personal data'),
  'node.hosting': tx('Where it is hosted'), 'node.uses_ai': tx('Whether it uses AI'),
  'org.has_systems': tx('Whether there are IT systems'), 'org.develops_software': tx('Whether software is built in-house'),
  'org.markets_to_customers': tx('Whether it sells to customers'), 'org.develops_products': tx('Whether products are developed'),
  'org.physical_goods': tx('Whether goods are handled'), 'org.runs_projects': tx('Whether projects are run'),
  'org.remote_work': tx('Whether people work remotely'), 'org.has_website': tx('Whether there is a public website'),
  'org.has_vendors': tx('Whether vendors are used'),
  'org.employees': tx('How many people it employs'), 'org.listed': tx('Whether it is listed'),
  'org.imports_exports': tx('Whether it imports or exports'), 'node.residency_outside_india': tx('Whether data is kept outside India'),
};

export const QUESTION_LABEL: Record<string, string> = {
  has_systems: tx('Does the organisation run IT systems or applications?'),
  develops_software: tx('Does it build or change software itself?'),
  has_vendors: tx('Does it rely on vendors or outsourced services?'),
  markets_to_customers: tx('Does it market or sell to customers?'),
  develops_products: tx('Does it design or develop products?'),
  physical_goods: tx('Does it make, store or move physical goods?'),
  runs_projects: tx('Does it run projects for clients or for itself?'),
  remote_work: tx('Do people work remotely?'),
  has_website: tx('Does it run a public website or app?'),
  imports_exports: tx('Does it import or export?'),
  listed: tx('Is it listed on a stock exchange?'),
  employees: tx('How many people does it employ?'),
};

/** what each question means, with examples that fit any kind of organisation */
export const QUESTION_HINT: Record<string, string> = {
  has_systems: tx('Any software it runs: email, billing, ERP, a core business system, payroll.'),
  develops_software: tx('Writes code, or configures and customises its own applications, rather than only using bought software.'),
  has_vendors: tx('Work it hands to others: IT support, cleaning, waste, payroll, logistics, cloud services.'),
  markets_to_customers: tx('Advertises, sells or runs campaigns to customers or the public.'),
  develops_products: tx('Designs or develops products of its own, physical or digital.'),
  physical_goods: tx('Makes, stocks, stores or ships goods: inventory, a warehouse, consumables, parts.'),
  runs_projects: tx('Delivers work as projects with budgets and deadlines, for clients or internally.'),
  remote_work: tx("Some people work from home or away from the organisation's sites."),
  has_website: tx('Runs a public website, portal or mobile app.'),
  imports_exports: tx('Buys from, or sells to, other countries.'),
  listed: tx('Its shares trade on a stock exchange.'),
  employees: tx('An approximate headcount is enough.'),
};

/** "Due in 3 days" / "Overdue by 2 days" */
export function dueText(at: string, t: (s: string, v?: Record<string, string | number>) => string): { text: string; late: boolean } {
  const days = Math.ceil((new Date(at).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: t('Overdue by {n} days', { n: -days }), late: true };
  if (days === 0) return { text: t('Due today'), late: false };
  return { text: days === 1 ? t('Due tomorrow') : t('Due in {n} days', { n: days }), late: false };
}

export function roleLabel(role: string | null, t: (s: string) => string): string {
  if (role === 'governor') return t('Leadership');
  if (role === 'admin') return t('Admins');
  return t('Compliance managers');
}

type Tr = (s: string, v?: Record<string, string | number>) => string;

const CONDITION_LABEL: Record<string, string> = {
  residual_critical: tx('the residual is critical'), above_tolerance: tx('it is above tolerance'),
  low_confidence: tx('confidence is below the threshold'),
};

/** A task's reason in the reader's language, from its structured detail; the stored English as the fallback. */
export function taskText(task: ReviewTask, t: Tr): string {
  const d = (task.detail ?? {}) as Record<string, unknown>;
  const facts = ((d.facts as string[] | undefined) ?? []).map((f) => t(FACT_LABEL[f] ?? f)).join(', ');
  const word = (field: unknown, v: unknown) =>
    field === 'verdict' ? t(VERDICT_LABEL[v as Verdict] ?? String(v)) : t(BAND_LABEL[String(v)] ?? String(v));
  switch (task.reason_code) {
    case 'CANDIDATE':
      return facts ? t('Might apply. Not known yet: {facts}.', { facts }) : t('Might apply: nothing decides it yet.');
    case 'APPLICABILITY':
      return t('Does it apply to {what}? Not known: {facts}.', { what: String(d.label ?? ''), facts: facts || '—' });
    case 'THEME_NEEDED':
      return Number(d.duties) === 1
        ? t('Which theme does {regulation} belong to? 1 applicable duty waits on it before it can be scored.', { regulation: String(d.regulation ?? '') })
        : t('Which theme does {regulation} belong to? {n} applicable duties wait on it before they can be scored.',
          { regulation: String(d.regulation ?? ''), n: Number(d.duties ?? 0) });
    case 'CLAIMED_ON_HIGH':
      return t('“{control}” is only self-declared on a {band} risk. Validate it with evidence, or record it as absent.',
        { control: String(d.label ?? ''), band: t(BAND_LABEL[String(d.band)] ?? String(d.band)).toLowerCase() });
    case 'ROUTED':
      return t('Assessment v{n}: {why}. Acknowledge it, or open the review it needs.', {
        n: Number(d.seq ?? 0), why: ((d.conditions as string[] | undefined) ?? []).map((c) => t(CONDITION_LABEL[c] ?? c)).join(', ') });
    case 'TREATMENT_NEEDED':
    case 'ACCEPTANCE_EXPIRED':
      return [
        task.reason_code === 'ACCEPTANCE_EXPIRED' ? t('The acceptance has expired.') : '',
        t('Verdict: {v}. Decide how to treat it.', { v: t(VERDICT_LABEL[d.verdict as Verdict] ?? String(d.verdict)) }),
        d.owner === false ? t('It has no owner yet.') : '',
      ].filter(Boolean).join(' ');
    case 'ESCALATED':
      return t('{who} referred this risk to leadership: {why}', { who: String(d.name ?? ''), why: String(d.rationale ?? '') });
    case 'OVERRIDE_STALE':
      return t('An override to {value} no longer matches the inputs. Renew it, or let the computed value stand.', { value: word(d.field, d.value) });
    case 'SECOND_APPROVER':
      return t('{who} proposes {from} → {to}, lower than computed. A second approver must agree. Their reason: {why}', {
        who: String(d.who ?? ''), from: word(d.field, d.computed), to: word(d.field, d.value), why: String(d.reason ?? '') });
    case 'PUBLISH':
      return t('Rulebook {name} {v}: {n} of {m} verdicts would change. An admin and a governor must approve.', {
        name: String(d.name ?? ''), v: String(d.version ?? ''), n: Number(d.changes ?? 0), m: Number(d.risks ?? 0) });
    default:
      return task.reason;
  }
}

/** Where a risk came from: the risk library, the regulations that apply, or a person. */
export type RiskSource = 'library' | 'regulations' | 'person';
export const SOURCE_LABEL: Record<RiskSource, string> = {
  library: tx('From the risk library'), regulations: tx('From regulations'), person: tx('Added by a person'),
};
export function sourceOf(r: { group_key?: string | null; origin?: string | null }): RiskSource {
  if (String(r.group_key ?? '').startsWith('obligation:')) return 'regulations';
  if (r.origin === 'manual') return 'person';
  return 'library';
}

/** "₹250 crore", "₹50 thousand" — a statutory ceiling as people say it. */
export function inr(v: number | null | undefined): string {
  if (!v) return '';
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} crore`;
  if (v >= 100_000) return `₹${(v / 100_000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
  return `₹${v.toLocaleString('en-IN')}`;
}
