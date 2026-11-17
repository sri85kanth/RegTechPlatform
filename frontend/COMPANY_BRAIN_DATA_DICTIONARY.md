# Company Brain — Data Dictionary & Reconciled Architecture

The authoritative reconciliation of the Company Brain information model. It is derived from, and kept in sync with, the single configuration source **`src/config/companyBrain.ts`**. Where the hierarchy (`../company-brain/hierarchy.html`, `data.js`) and this app disagreed, this document records the intended role of each concept.

> **Scope:** Company Brain only. Regulatory Brain, Regulatory Mapping, Obligations, and CAPA are **out of scope** and are not part of this model. (Legacy reg code remains on disk but is unrouted and unlinked.)

---

## 1. Top-level domains (frozen)

Exactly nine. No more, no fewer.

| # | Domain | Entity noun | Route |
|---|---|---|---|
| 1 | **Overview** | Record | `/` |
| 2 | **People** | Person | `/people` |
| 3 | **Processes** | Process | `/processes` |
| 4 | **Systems** | System | `/systems` |
| 5 | **Data** | Data Asset | `/data` |
| 6 | **Policies** | Policy | `/policies` |
| 7 | **Controls** | Control | `/controls` |
| 8 | **Risks** | Risk | `/risks` |
| 9 | **Evidence** | Evidence | `/evidence` |

---

## 2. Universal entity model

One record shape for every entity (`src/types/entity.ts`). One entity = one stable **id**; the same id is reused across every view — never duplicated.

| Field | Meaning |
|---|---|
| `id` | Stable unique identifier |
| `domain` | One of the 9 domains |
| `name` | Display name |
| `type` | Entity type within the domain (e.g. Person, Department, Application, Database) |
| `status` | Free-form operational status |
| `ownerId` | → a People entity id (accountability) |
| `criticality` | Critical / High / Medium / Low |
| `lifecycle` | see §4 |
| `verification` | see §5 |
| `provenance` | see §6 |
| `attrs` | Domain-specific fields, referenced by column/filter/detail config |

Relationships are **separate, typed edges** (`{ sourceId, type, targetId, confidence, status }`) — the graph. See §7.

---

## 3. Concept classification (the A–J roles)

Every concept in the hierarchy is exactly **one** of these roles (encoded in `companyBrain.ts › CONCEPT_ROLES`). This is why the app is not 160 sidebar pages.

| Role | Meaning | Rendered as |
|---|---|---|
| **A** | Top-level domain | Sidebar item |
| **B** | Primary module nav | Domain's default records list (first sub-tab) |
| **C** | Secondary module nav | A within-domain tab |
| **D** | Entity type | A filtered records list (a sub-tab) |
| **E** | Relationship view | A graph lens — related entities of another domain |
| **F** | Entity detail section | A section inside the entity drawer |
| **G** | Filter / attribute | A filter dropdown / a column |
| **H** | Computed / analytical | A derived view (Completeness, Data Quality…) |
| **I** | Verification / lifecycle | The Verification sub-tab / drawer tab |
| **J** | Provenance / source | The Sources drawer tab |

### 3.1 People
| Concept | Role |
|---|---|
| Directory | B (primary list, type Person) |
| Departments, Teams, Roles, Job Functions, Certifications, Training, Access & Identity, External Personnel | D (entity types → sub-tabs) |
| Reporting, Responsibilities, Critical Personnel | E / G (relationship & filtered views) |
| Ownership | E (Person → owns → entity) |
| Sources | J · Verification | I · History | H |

### 3.2 Processes
| Concept | Role |
|---|---|
| Process Library | B · Business Processes / Sub-Processes | D |
| Owners | E · Systems, Data, Controls, Policies, Risks, Evidence, Customers, Suppliers, Dependencies | E (relationship sections) |
| Hierarchy, Activities, Inputs, Outputs, Performance, Documentation | F (entity detail sections) |
| Criticality | G · Sources | J · Verification | I · History | H |

### 3.3 Systems
| Concept | Role |
|---|---|
| Applications, Infrastructure, Cloud, SaaS, Databases, APIs | D (entity types) |
| Integrations, Owners, Dependencies, Vendors, Data, Processes, Controls | E |
| Environments, Security, Availability, Lifecycle | F |
| Criticality | G · Sources | J · Verification | I · History | H |

### 3.4 Data
| Concept | Role |
|---|---|
| Data Assets | B · Domains, Categories | D |
| Owners, Stewards, Systems, Processes, Users, Vendors | E |
| Classification, Sensitive Data | G · Locations, Flows, Processing, Retention, Disposal, Privacy, Lineage | F |
| Quality | H · Sources | J · Verification | I · History | H |

### 3.5 Policies · Controls · Risks · Evidence
Follow the same pattern: a **Library / Register** (B), cross-domain **relationship sections** (E: Processes, Systems, Data, Controls, Risks, Evidence, Policies as applicable), entity-specific **detail sections** (F: Testing, Attestations, Effectiveness, Freshness/Expiry, Retention), **filters** (G: Criticality, Effectiveness, Frequency, Freshness), plus **Verification** (I), **Sources** (J), **History** (H).

---

## 4. Lifecycle (single model — do not fork)

`Discovered → Draft → Pending Review → Verified → Active → Under Review → Superseded → Archived`

Shown as a stepper in the entity drawer (current step highlighted).

---

## 5. Verification states

`Verified` · `Pending` · `Needs Review` · `Rejected`

Verification loop (unchanged): **AI / Import → Parse → Normalize → Entity Resolution → Relationship Detection → AI Proposal → Confidence → Human Review → Approve / Edit / Reject → Verified → Company Graph → History.** Nothing becomes trusted automatically.

---

## 6. Provenance (on every important entity)

`source` · `sourceReference` · `confidence` · `verifiedBy` · `verifiedAt` · `createdAt` · `updatedAt` — surfaced in the drawer's **Sources** tab.

Source kinds: Manual · CSV · Excel · API · Connector · Document · AI Extraction · Seed.

---

## 7. Relationship types (the graph edges)

Directional, typed, confidence-scored. Human labels from `companyBrain.ts › REL_LABELS`.

| Type | Reads as | Typical shape |
|---|---|---|
| `owns` | owns | Person → entity |
| `manages` / `member_of` / `performs` | manages / member of / performs | People ↔ org / process |
| `uses` | uses | Process → System |
| `stores` / `processes` | stores / processes | System/Process → Data |
| `governed_by` / `implements` | governed by / implements | Process/Data → Policy → Control |
| `mitigates` / `protects` | mitigates / protects | Control → Risk / System / Data |
| `affects` / `threatens` | affects / threatens | Risk → Process / System / Data |
| `evidenced_by` / `proves` / `supports` | evidenced by / proves / supports | entity ↔ Evidence |
| `depends_on` / `contains` | depends on / contains | System → System, Dept → Team |

The **entity drawer** groups an entity's relationships into **sections by related domain** (Role E), ordered per `RELATED_SECTION_ORDER`, showing only the groups that have data (progressive disclosure). The **Company Graph** renders the same edges as a contextual, navigable canvas.

---

## 8. Entity detail (drawer) — progressive disclosure

Universal tabs: **Overview · Properties · Relationships · Owners · Evidence · Sources · Verification.**
- **Relationships** = the Role-E sections above (grouped by domain).
- **Role-F sections** (Activities, Inputs, Outputs, Environments, Lineage…) are declared in `companyBrain.ts › DETAIL_ATTR_SECTIONS` and render **only when the entity has that data**. They are dormant until such data exists — no empty sections, no fabricated values.

---

## 9. Out of scope (frozen)

Not part of the Company Brain: **Regulation, Regulatory Brain, Regulatory Mapping, Obligations, CAPA, compliance workflows.** *Regulatory Scope* exists only as **company metadata** inside Overview, not as regulatory intelligence.
