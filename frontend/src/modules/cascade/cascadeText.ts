/**
 * Plain-language meaning of each colour on the Impact Cascade, used in the
 * status key, the filter chips' tooltips, the KPI captions and the detail panel.
 *
 * The four statuses follow the gap assessment's own definitions
 * (scraper/nabh6_gap.py): MET — a document clearly covers what the duty
 * requires; PARTIAL — something relevant exists but a specific part is missing;
 * GAP — the topic is in an area the hospital documented, but this duty is not
 * addressed; NOT_COVERED — the duty belongs to an area for which no document
 * was provided.
 *
 * English text marked with tx(): translate where it is drawn — t(MEANING.GAP) in
 * React, tNow(MEANING.GAP) in renderCascade's HTML strings.
 */
import { tx } from '@/i18n';

export const MEANING = {
  MET: tx('Documented: our documents fully cover this duty (not yet checked against records)'),
  PARTIAL: tx('Covered, but something is missing'),
  GAP: tx('The area is documented, but this duty is not addressed'),
  NOT_COVERED: tx('No hospital document covers this area yet'),
  NOT_APPLICABLE: tx('This provision binds someone other than the hospital'),
  MISSING: tx('No policy / control / owner recorded for this duty'),
  // set by rule from the standard's category (nabh6_gap.py risk_for), not from the risk register
  RISK: tx('Priority: how serious the duty is if not met, set from the standard\'s category (Core, Commitment…)'),
} as const;
