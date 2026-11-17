"""
One workspace per company, sharing one regulation library.

HOW IT IS LAID OUT
------------------
The installation's first company keeps its tables where they have always been,
in the `public` schema, next to the regulation library. Every further company
gets its own schema, `co_<slug>`, holding empty copies of the COMPANY tables
below and nothing else, and its own database role whose search_path is
`co_<slug>, public`. An unqualified table name therefore finds the company's
own copy first and falls through to the shared library for everything else, so
the application's SQL needs no changes.

The role is granted the library and its own schema, and nothing on the first
company's tables. A company table missing from this list is not a silent leak:
the query reaches `public`, is refused, and fails loudly.

WHAT COUNTS AS A COMPANY TABLE
------------------------------
Anything a company creates or that is derived from its profile: its users and
sessions, records, documents, controls, applicability verdicts, gap results,
cascade, notifications and audit trail. The regulation library (regulations,
sections, obligations, requirements, the source register and so on) is shared:
uploads by one company join it for all, as decided when multi-company was
designed. Requirement and obligation review states are library curation and
stay shared too.

`regulations` is shared but carries three values derived from one company's
profile (applicability, impact_score, impact_level). Each company schema gets a
`regulation_state` table for those and a `regulations` view that overlays them
on the shared rows (tenantctl.py builds it), so one company's verdict is never
shown to, or overwritten by, another.

This module is imported by pgdb.py and by deploy/tenancy/tenantctl.py, so the
list lives in exactly one place.
"""
from __future__ import annotations

import os
import re

COMPANY_TABLES: tuple[str, ...] = (
    # people and access
    "users", "sessions", "oauth_states", "auditor_requests", "auditor_shares",
    "audit_events", "notifications",
    # the company itself
    "company_profile", "company_entities", "entity_relationships", "company_mappings",
    "company_documents", "org_nodes", "delegations",
    # controls, evidence and testing
    "controls", "control_requirements", "control_obligations", "compliance_tests",
    "control_evidence", "evidence", "evidence_links", "findings", "validations",
    # what applies and how the company stands against it
    "applicability_results", "company_requirement_instances", "company_requirement_scopes",
    "obligation_status", "assessments", "gap_assessments", "cascade_graph",
    "remediation_drafts", "impact_relationships", "impact_runs", "impact_scores",
    # work
    "actions", "action_events",
    # risk: what scoring needs to know, and who sets appetite (migration 005)
    "company_sites", "company_licences", "company_third_parties", "history_records",
    "history_attestations", "risk_appetite", "risk_governors", "extracted_facts", "fact_citations",
    # risk: the register, its assessments, review, overrides and treatment (migration 006)
    "risks", "risk_exposures", "risk_assessments", "risk_org_facts", "risk_control_ratings",
    "review_tasks", "risk_overrides", "treatment_decisions", "rulebook_publications", "risk_events",
    # risk: a person's theme for a regulation the rulebook cannot place (migration 007)
    "risk_theme_assignments",
    # getting data in
    "integrations", "integration_config", "integration_records", "integration_syncs",
    "intake_batches", "intake_items", "intake_rules", "reg_uploads",
    # the assistant's memory and conversation state
    "agent_memory", "checkpoints", "checkpoint_blobs", "checkpoint_writes",
    "checkpoint_migrations",
)
COMPANY_VIEWS: tuple[str, ...] = ("v_company_requirements",)

# The shared regulation library. Listed explicitly, not "everything else": a
# workspace role is granted exactly these, so a table nobody classified (a new
# one, or a company table missing above) is refused rather than shared, and
# tenantctl.py check names it.
LIBRARY_TABLES: tuple[str, ...] = (
    "regulations", "regulation_amendments", "regulation_regions", "regulation_sectors",
    "regulation_tables", "regulation_types", "regulation_versions",
    "sections", "section_changes", "section_snapshots", "clauses", "chapters",
    "legal_provisions", "provision_conditions", "provision_exceptions",
    "obligations", "obligation_events", "requirements", "applicability_rules",
    "definitions", "definition_usages", "cross_references", "thresholds", "timing_rules",
    "record_requirements", "reporting_requirements", "disclosures", "penalty_provisions",
    "enforcement_actions", "regulatory_analysis", "taxonomies", "taxonomy_terms",
    "documents", "document_versions", "provenance", "verification_records",
    "source_register", "source_register_portals", "source_checks", "source_cache",
    "discovered_regulations", "ingestion_jobs", "extraction_runs", "archive_backfill",
)
# The platform's own tables: kept by the main installation. A workspace is granted only
# company_members, a view that shows it its own members (workspaces.py).
PLATFORM_TABLES: tuple[str, ...] = ("workspace_requests", "workspace_members", "company_members")
# the RAG database: chunks is reached through each workspace's chunks view
RAG_LIBRARY_TABLES: tuple[str, ...] = ("chunks_staging", "visual_pages", "visual_patches", "index_runs")

# shared library tables whose listed columns are one company's own values
OVERLAY: dict[str, tuple[str, ...]] = {
    "regulations": ("applicability", "impact_score", "impact_level"),
}

# the RAG database: company passages live in the company schema, the
# regulatory corpus is shared (see tenantctl.py for the chunks view)
RAG_COMPANY_CORPUS = "company"

_SLUG = re.compile(r"^[a-z][a-z0-9]{1,23}$")


def valid_slug(slug: str) -> bool:
    return bool(_SLUG.match(slug or ""))


def schema_of(slug: str) -> str:
    if not valid_slug(slug):
        raise ValueError(f"invalid company slug {slug!r}: 2-24 lowercase letters/digits, starting with a letter")
    return f"co_{slug}"


def role_of(slug: str) -> str:
    schema_of(slug)
    return f"cb_{slug}"


def current() -> str | None:
    """The company this process serves, from CB_TENANT; None for the first company."""
    slug = (os.environ.get("CB_TENANT") or "").strip()
    return slug or None


def owns(name: str) -> bool:
    """True when `name` is a table or view each company keeps for itself."""
    n = (name or "").strip('"').lower()
    n = n.split(".")[-1]
    return n in COMPANY_TABLES or n in COMPANY_VIEWS or n == "regulation_state"
