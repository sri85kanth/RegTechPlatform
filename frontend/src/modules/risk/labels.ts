/**
 * The words for each value on the Risk inputs screens.
 */
import { tx } from '@/i18n';

export const HISTORY_KIND_LABEL: Record<string, string> = {
  INSPECTION: tx('Inspection'), OBSERVATION: tx('Observation'), CAPA: tx('CAPA'), INCIDENT: tx('Incident'),
  RECALL: tx('Recall'), COMPLAINT: tx('Complaint'), LITIGATION: tx('Litigation'), PENALTY: tx('Penalty'),
  WARNING_LETTER: tx('Warning letter'), ALL: tx('All kinds'),
};

export const CATEGORY_LABEL: Record<string, [string, string]> = {
  regulatory: [tx('Regulatory'), tx('Penalties, prosecution, licence action')],
  safety: [tx('Safety'), tx('Harm to patients, staff or the public')],
  data: [tx('Data'), tx('Personal data and information security')],
  operational: [tx('Operational'), tx('Services stopping or degrading')],
  financial: [tx('Financial'), tx('Money lost, fined or spent recovering')],
  reputational: [tx('Reputational'), tx('Trust of patients, regulators and the public')],
};

export const BAND_LABEL: Record<string, string> = {
  LOW: tx('Low'), MEDIUM: tx('Medium'), HIGH: tx('High'), CRITICAL: tx('Critical'),
};
export const BAND_TONE: Record<string, string> = {
  LOW: 'bg-emerald-50 text-emerald-700', MEDIUM: 'bg-amber-50 text-amber-700',
  HIGH: 'bg-orange-50 text-orange-700', CRITICAL: 'bg-red-50 text-red-700',
};

export const OUTCOME_LABEL: Record<string, string> = {
  clean: tx('Clean'), observations: tx('With observations'), adverse: tx('Adverse'),
};

export const CRITICALITY_LABEL: Record<string, string> = {
  Critical: tx('Critical'), High: tx('High'), Medium: tx('Medium'), Low: tx('Low'),
};

/** "beds" → "Beds", "ipd_per_year" → "IPD per year" */
export const METRIC_LABEL: Record<string, string> = {
  beds: tx('Beds'), employees: tx('Employees'), ots: tx('Operating theatres'), ipd_per_year: tx('In-patients a year'),
};

/** "Expired 12 days ago" / "Expires in 40 days" / "Valid" for a validity date. */
export function validity(until: string | null | undefined, t: (s: string, v?: Record<string, string | number>) => string):
  { text: string; tone: string } | null {
  if (!until) return null;
  const days = Math.round((new Date(until).getTime() - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { text: t('Expired {n} days ago', { n: (-days).toLocaleString() }), tone: 'bg-red-50 text-red-700' };
  if (days <= 90) return { text: t('Expires in {n} days', { n: days.toLocaleString() }), tone: 'bg-amber-50 text-amber-700' };
  return { text: t('Valid'), tone: 'bg-emerald-50 text-emerald-700' };
}
