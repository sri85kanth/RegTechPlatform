-- Puts back the reading from before 004: the gap review's statuses as stored,
-- and the regulation's verdict on every requirement. v_requirement_assessments
-- becomes a plain pass-through so the code that reads it keeps working.
DROP VIEW IF EXISTS v_company_requirements;
CREATE VIEW v_company_requirements AS
SELECT
  cri.id AS cri_id, cri.company_id, rq.id AS requirement_id, rq.regulation_id, rq.statement,
  rq.source_clause, rq.frequency, rq.deadline, rq.responsible_role,
  rq.review_status AS requirement_review_status,
  ar.verdict AS applicability, ar.confidence AS applicability_confidence,
  ar.reason AS applicability_reason, ar.missing_facts, ar.scope_type AS verdict_scope,
  cri.effective_from, cri.compliance_deadline, cri.compliance_status, cri.compliance_reason,
  cri.owner_id, cri.review_status AS instance_review_status,
  ar.verdict AS regulation_applicability, cri.compliance_status AS assessed_compliance_status,
  NULL::text AS applicability_rule
FROM company_requirement_instances cri
JOIN requirements rq ON rq.id = cri.requirement_id
LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id;

CREATE OR REPLACE VIEW v_requirement_assessments AS
SELECT g.requirement_id, g.regulation_id, g.unit_group, g.unit_code, g.unit_title, g.item_code,
       g.requirement_text, g.category, g.status, g.risk, g.obligation, g.testable_requirement,
       g.responsible, g.frequency, g.covered_by, g.gap, g.fix, g.consequence, g.position,
       g.assessed_at, g.sub_requirements, g.interpretation, g.source_page,
       g.status AS assessed_status, NULL::text AS requirement_applicability,
       NULL::text AS requirement_applicability_reason
  FROM gap_assessments g;
