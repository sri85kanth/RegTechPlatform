export type Status = 'MET' | 'PARTIAL' | 'GAP' | 'NOT_COVERED' | 'NOT_APPLICABLE';
export type Risk = 'Critical' | 'High' | 'Medium' | 'Low' | 'None';

export interface CascadeItem {
  rid?: string;
  c: string;      // element / clause code
  t: string;      // requirement text as the regulator wrote it
  cat: string;    // NABH category (CORE, COMMITMENT...) or ''
  st: Status;
  rk: Risk;
  ob: string;     // rewritten obligation
  rq: string;     // testable requirement
  who: string;
  by: string[];   // hospital document codes that cover it
  gap: string;
  fix: string;
  why: string;
  /** NABH guidebook: the requirements the interpretation breaks this element into */
  subs?: GuidebookReq[];
  interp?: string;   // guidebook interpretation text
  gbp?: number | null;
  /** NABH asterisk (*): a written, approved document is mandatory for this element */
  doc?: boolean;
}
export interface GuidebookReq {
  n: number; rq: string; ev: string; src: string; who: string; freq: string;
  st: Status; by: string[]; gap: string; fix: string; risk: Risk;
}
export interface CascadeUnit { g: string; u: string; ut: string; items: CascadeItem[] }
export interface CascadeRegulation {
  id: string; title: string; short?: string | null; regulator?: string | null; url?: string | null;
  regulator_full?: string | null; regulation_type?: string | null; jurisdiction?: string | null;
  effective_from?: string | null; status?: string | null;
  impact_score?: number | null; impact_level?: string | null;
  applicability?: string | null; applicability_reason?: string | null;
  not_applicable?: number;
  units: CascadeUnit[];
}
export interface RegulationSummary {
  id: string; title: string; short_title?: string | null; regulator?: string | null; url?: string | null;
  total: number; applicable: number; met: number; partial: number; gap: number; not_covered: number;
  critical: number; high: number;
}
export interface CascadeDoc {
  k: 'Policy' | 'SOP' | 'Form' | 'Control';
  t: string; o?: string; f?: string; std?: string; freq?: string; test?: string;
  sops?: string[]; pol?: string[]; forms?: string[]; risks?: string[];
  x?: [string, string[]][];
}
export interface CascadeRisk { t: string; rating?: string; res?: string; o?: string; ctrls: string[] }
export interface CascadeGraph { docs: Record<string, CascadeDoc>; risks: Record<string, CascadeRisk>; updated_at?: string }
