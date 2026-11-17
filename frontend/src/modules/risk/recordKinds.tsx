/**
 * Each kind of risk-input record: its fields (the form) and its columns (the table).
 */
import type { ReactNode } from 'react';
import type { IntakeRecord, RecordKind, RiskMeta } from '@/services/riskApi';
import { tx, type TFunction } from '@/i18n';
import { Pill } from './riskUi';
import { CRITICALITY_LABEL, HISTORY_KIND_LABEL, METRIC_LABEL, OUTCOME_LABEL, validity } from './labels';

export type FieldType = 'text' | 'textarea' | 'date' | 'select' | 'site' | 'yesno' | 'list' | 'scale' | 'theme';
export interface FieldDef {
  key: string; label: string; type: FieldType; required?: boolean; hint?: string; placeholder?: string;
  options?: (meta: RiskMeta) => { value: string; label: string }[];
  wide?: boolean;
}
export interface KindConfig {
  singular: string; plural: string; icon: string; intro: string; empty: string;
  fields: FieldDef[];
  columns: { label: string; render: (r: IntakeRecord, ctx: Ctx) => ReactNode; className?: string }[];
}
export interface Ctx { t: TFunction; date: (s?: unknown) => string; siteName: (id?: unknown) => string }

const opts = (labels: Record<string, string>) => (keys: string[]) => keys.map((k) => ({ value: k, label: labels[k] ?? k }));
const SITE_TYPES = [tx('Hospital'), tx('Clinic'), tx('Laboratory'), tx('Pharmacy'), tx('Office'), tx('Warehouse'),
  tx('Plant'), tx('Data centre')];

export const KINDS: Record<RecordKind, KindConfig> = {
  sites: {
    singular: tx('Site'), plural: tx('Sites'), icon: 'MapPin',
    intro: tx('Every place the company operates. Likelihood grows with the number of sites and their size, so each site needs its size.'),
    empty: tx('No sites yet. Add the places you operate from, with their size.'),
    fields: [
      { key: 'name', label: tx('Name'), type: 'text', required: true, placeholder: tx('Hyderabad main hospital') },
      { key: 'site_type', label: tx('Type'), type: 'select', options: () => SITE_TYPES.map((s) => ({ value: s, label: s })) },
      { key: 'scale', label: tx('Size'), type: 'scale', wide: true,
        hint: tx('The size measure your sector is scored on is required; the others help.') },
      { key: 'service_lines', label: tx('Services'), type: 'list', wide: true,
        placeholder: tx('Radiology, blood bank, dialysis'), hint: tx('Separate with commas. High-risk services decide which safety risks apply.') },
      { key: 'address', label: tx('Address'), type: 'textarea', wide: true },
      { key: 'city', label: tx('City'), type: 'text' },
      { key: 'state', label: tx('State'), type: 'text' },
    ],
    columns: [
      { label: tx('Site'), render: (r) => <span className="font-semibold text-ink">{String(r.name)}</span> },
      { label: tx('Type'), render: (r, { t }) => (r.site_type ? t(String(r.site_type)) : '—') },
      { label: tx('Size'), render: (r, { t }) => scaleText(r.scale, t) },
      { label: tx('State'), render: (r) => String(r.state ?? '—') },
    ],
  },
  licences: {
    singular: tx('Licence'), plural: tx('Licences'), icon: 'BadgeCheck',
    intro: tx('Licences and registrations as records, each with its site and validity. A duty that guards a licence carries the highest operational impact.'),
    empty: tx('No licences yet. Add each licence or registration with its number and validity.'),
    fields: [
      { key: 'kind', label: tx('Licence or registration'), type: 'text', required: true, placeholder: tx('Biomedical waste authorisation') },
      { key: 'site_id', label: tx('Site'), type: 'site' },
      { key: 'issuer', label: tx('Issued by'), type: 'text', placeholder: tx('Telangana State Pollution Control Board') },
      { key: 'number', label: tx('Number'), type: 'text' },
      { key: 'valid_from', label: tx('Valid from'), type: 'date' },
      { key: 'valid_until', label: tx('Valid until'), type: 'date', hint: tx('Leave blank when it does not expire.') },
      { key: 'conditions', label: tx('Conditions'), type: 'textarea', wide: true },
    ],
    columns: [
      { label: tx('Licence'), render: (r) => <span className="font-semibold text-ink">{String(r.kind)}</span> },
      { label: tx('Site'), render: (r, { siteName }) => siteName(r.site_id) },
      { label: tx('Number'), render: (r) => <span className="tabular-nums">{String(r.number ?? '—')}</span> },
      { label: tx('Valid until'), render: (r, { t, date }) => {
        const v = validity(r.valid_until as string | null, t);
        return r.valid_until
          ? <span className="inline-flex items-center gap-2">{date(r.valid_until)}{v && <Pill className={v.tone}>{v.text}</Pill>}</span>
          : '—';
      } },
    ],
  },
  third_parties: {
    singular: tx('Third party'), plural: tx('Third parties'), icon: 'Users',
    intro: tx('Vendors and outsourced services. Each critical one gets the third-party risks from the library: failure, concentration, data shared.'),
    empty: tx('No third parties yet. Add the vendors and agencies the company depends on.'),
    fields: [
      { key: 'name', label: tx('Name'), type: 'text', required: true },
      { key: 'service', label: tx('What they do for us'), type: 'text', placeholder: tx('Biomedical waste collection') },
      { key: 'criticality', label: tx('Criticality'), type: 'select', options: (m) => opts(CRITICALITY_LABEL)(m.criticality) },
      { key: 'personal_data', label: tx('Do they receive personal data?'), type: 'yesno' },
      { key: 'data_shared', label: tx('What data is shared'), type: 'text', wide: true },
      { key: 'contract_ref', label: tx('Contract'), type: 'text' },
      { key: 'contract_until', label: tx('Contract ends'), type: 'date' },
      { key: 'alternatives', label: tx('Who else could do it'), type: 'text', wide: true, hint: tx('Leave blank if nobody else could.') },
    ],
    columns: [
      { label: tx('Name'), render: (r) => <span className="font-semibold text-ink">{String(r.name)}</span> },
      { label: tx('Service'), render: (r) => String(r.service ?? '—') },
      { label: tx('Criticality'), render: (r, { t }) => (r.criticality ? t(CRITICALITY_LABEL[String(r.criticality)]) : '—') },
      { label: tx('Personal data'), render: (r, { t }) => (r.personal_data == null ? t('Not known') : r.personal_data ? t('Yes') : t('No')) },
      { label: tx('Contract ends'), render: (r, { date }) => (r.contract_until ? date(r.contract_until) : '—') },
    ],
  },
  history: {
    singular: tx('History record'), plural: tx('History'), icon: 'History',
    intro: tx('Inspections, observations, CAPAs, incidents, recalls, complaints, litigation and penalties from the last 36 months. They raise or lower likelihood.'),
    empty: tx('No history recorded. Add what happened, or attest below that nothing of a kind happened.'),
    fields: [
      { key: 'kind', label: tx('Kind'), type: 'select', required: true, options: (m) => opts(HISTORY_KIND_LABEL)(m.historyKinds) },
      { key: 'occurred_on', label: tx('Date'), type: 'date', required: true },
      { key: 'title', label: tx('What happened'), type: 'text', required: true, wide: true },
      { key: 'regulator', label: tx('Regulator or body'), type: 'text', placeholder: tx('NABH, SPCB, AERB…') },
      { key: 'site_id', label: tx('Site'), type: 'site' },
      { key: 'theme', label: tx('Area'), type: 'theme' },
      { key: 'outcome', label: tx('Inspection outcome'), type: 'select', options: (m) => opts(OUTCOME_LABEL)(m.outcomes) },
      { key: 'severity_as_recorded', label: tx('Severity, as the source wrote it'), type: 'text' },
      { key: 'state', label: tx('State'), type: 'select', options: () => [{ value: 'OPEN', label: tx('Open') }, { value: 'CLOSED', label: tx('Closed') }] },
      { key: 'due_on', label: tx('Due to close'), type: 'date' },
      { key: 'closed_on', label: tx('Closed on'), type: 'date' },
      { key: 'description', label: tx('Details'), type: 'textarea', wide: true },
    ],
    columns: [
      { label: tx('Date'), render: (r, { date }) => <span className="tabular-nums">{date(r.occurred_on)}</span> },
      { label: tx('Kind'), render: (r, { t }) => t(HISTORY_KIND_LABEL[String(r.kind)] ?? String(r.kind)) },
      { label: tx('What happened'), render: (r) => <span className="font-semibold text-ink">{String(r.title)}</span> },
      { label: tx('Regulator or body'), render: (r) => String(r.regulator ?? '—') },
      { label: tx('State'), render: (r, { t }) => (
        <Pill className={r.state === 'OPEN' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}>
          {r.state === 'OPEN' ? t('Open') : t('Closed')}
        </Pill>) },
    ],
  },
};

function scaleText(v: unknown, t: TFunction): string {
  const s = (v ?? {}) as Record<string, number>;
  const parts = Object.entries(s).map(([k, n]) => `${n.toLocaleString()} ${t(METRIC_LABEL[k] ?? k).toLowerCase()}`);
  return parts.length ? parts.join(' · ') : t('Not given');
}
