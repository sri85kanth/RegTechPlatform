-- Requirement-level applicability, read through views.
--
-- Each requirement's own verdict lives on its COMPANY row in
-- company_requirement_scopes (written by apply_requirement_applicability.py).
-- The gap review loaded 15,038 requirements as NOT_APPLICABLE with one
-- boilerplate reason, 868 of them reading "the hospital shall …". These views
-- keep a NOT_APPLICABLE only where the requirement's own verdict agrees, and
-- read every other one as NOT_ASSESSED: owed, not yet checked. Nothing stored
-- is rewritten, a re-load of the gap review cannot undo it, and
-- 004_requirement_applicability_rollback.sql puts the old reading back.

CREATE OR REPLACE VIEW v_requirement_assessments AS
SELECT g.requirement_id, g.regulation_id, g.unit_group, g.unit_code, g.unit_title, g.item_code,
       g.requirement_text, g.category,
       CASE WHEN g.status = 'NOT_APPLICABLE' AND COALESCE(s.applicability_status, '') <> 'NOT_APPLICABLE'
            THEN 'NOT_ASSESSED' ELSE g.status END             AS status,
       g.risk, g.obligation, g.testable_requirement, g.responsible, g.frequency, g.covered_by,
       g.gap, g.fix, g.consequence, g.position, g.assessed_at, g.sub_requirements, g.interpretation,
       g.source_page,
       g.status                                                AS assessed_status,
       s.applicability_status                                  AS requirement_applicability,
       s.reason                                                AS requirement_applicability_reason
  FROM gap_assessments g
  LEFT JOIN company_requirement_instances i ON i.requirement_id = g.requirement_id AND i.company_id = 1
  LEFT JOIN company_requirement_scopes s ON s.cri_id = i.id AND s.scope_type = 'COMPANY';

-- Same columns, same order as before; three appended at the end.
CREATE OR REPLACE VIEW v_company_requirements AS
SELECT
  cri.id                        AS cri_id,
  cri.company_id,
  rq.id                         AS requirement_id,
  rq.regulation_id,
  rq.statement,
  rq.source_clause,
  rq.frequency,
  rq.deadline,
  rq.responsible_role,
  rq.review_status              AS requirement_review_status,
  -- The requirement's own verdict, falling back to its regulation's.
  COALESCE(s.applicability_status, ar.verdict) AS applicability,
  ar.confidence                 AS applicability_confidence,
  COALESCE(s.reason, ar.reason) AS applicability_reason,
  ar.missing_facts,
  ar.scope_type                 AS verdict_scope,
  cri.effective_from,
  cri.compliance_deadline,
  CASE WHEN cri.compliance_status = 'NOT_APPLICABLE' AND COALESCE(s.applicability_status, '') <> 'NOT_APPLICABLE'
       THEN 'NOT_ASSESSED' ELSE cri.compliance_status END AS compliance_status,
  cri.compliance_reason,
  cri.owner_id,
  cri.review_status             AS instance_review_status,
  ar.verdict                    AS regulation_applicability,
  cri.compliance_status         AS assessed_compliance_status,
  s.source_rule_id              AS applicability_rule
FROM company_requirement_instances cri
JOIN requirements rq            ON rq.id = cri.requirement_id
LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id
LEFT JOIN company_requirement_scopes s ON s.cri_id = cri.id AND s.scope_type = 'COMPANY';
