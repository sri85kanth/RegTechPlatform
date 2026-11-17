# Company Brain — User Journey & Screen Guide

A complete, detailed walkthrough of the React application: every screen, every tab, every sub-tab, what each one shows, and how a user moves through the product.

> **Scope is frozen (Company Brain only).** Nine domains, one entity model, one config source (`src/config/companyBrain.ts`). Regulatory Brain / Mapping / CAPA are **out of scope and hidden** (see §7). Authoritative model: `COMPANY_BRAIN_DATA_DICTIONARY.md`.

> **Core idea:** the Company Brain is **one connected graph** of People · Processes · Systems · Data · Policies · Controls · Risks · Evidence. Each real-world thing exists **once** (one ID) and appears in many screens by *relationship* — never duplicated. Every page is just a **view of that graph**.

- **Run:** `cd company-brain-app && npm install && npm run dev` → http://localhost:5180
- **Demo tenant:** Bajaj Finance Limited. Company graph = 58 entities / 64 relationships; plus ~60 Overview records (company profile, legal entities, licenses…) and extended People records (job functions, certifications, training, access, externals).

---

## 0. Screen map (counts at a glance)

| Area | Count | What |
|---|---|---|
| **Sidebar — Company** | 1 + 8 | Overview (17 sub-tabs) + 8 domain modules |
| **Sidebar — Platform** | 5 | Company Graph, Review Queue, Search, Activity, Settings |
| **Domain sub-tabs (secondary nav)** | 70+ total | Overview 17 · People 12 · 6–8 per other domain |
| **Entity detail drawer tabs** | 7 | Overview · Properties · Relationships · Owners · Evidence · Sources · Verification |
| **Modals / forms** | 1 | Add {Entity} (validated) |

So the app is: **Overview (dashboard + 17 sub-tabs) + 8 Company domains + a graph + a review queue + search/activity/settings + a universal slide-over entity detail drawer.** Every domain is rendered by **one** config-driven list page; every entity opens in **one** universal drawer. Regulatory Brain / Mapping are out of scope and hidden (§7).

---

## 1. Global layout (every screen)

```
┌───────────────┬───────────────────────────────────┬───────────┐
│  SIDEBAR      │  TOPBAR (title·search·alerts·user) │           │
│  (dark)       ├───────────────────────────────────┤  DETAIL   │
│  Company →    │  SECONDARY NAV (domain sub-tabs)   │  DRAWER   │
│               ├───────────────────────────────────┤ (slides   │
│  Platform →   │  PAGE CONTENT                      │  in on a  │
│  [Collapse]   │  (KPIs · toolbar · table / graph)  │  row click)│
└───────────────┴───────────────────────────────────┴───────────┘
```

**Sidebar** — two groups. **Company:** Overview, People, Processes, Systems, Data, Policies, Controls, Risks, Evidence. **Platform:** Company Graph, Review Queue (badge 6), Search, Activity, Settings. A **Collapse** button shrinks it to icons. The company switcher shows *Bajaj Finance Limited · ● Active*.

**Topbar** — page icon + title + subtitle, a global search box, notifications, help, and the signed-in user (Priya Sharma · Compliance Manager). On list pages it also shows **Export** and **+ Add {Entity}**.

**Detail drawer** — clicking any row, graph node, search hit or mapping target **slides a detail panel in from the right** (backdrop dims the page, `Esc` or the backdrop closes it). It's the same universal drawer for every entity in either brain — see §5.

---

## 2. Overview — route `/` and `/overview/:subtab` (the company itself)

Overview is the company-level "meta" domain: it describes **the company itself** — profile, structure, footprint and regulatory exposure. It has its own **17 sub-tabs**. The first, **Summary**, is the executive dashboard; the rest are data tables and computed views. Overview records live in the shared graph (`domain = 'overview'`) so each row opens the drawer, but they're kept **out** of the 8-domain company graph and completeness maths (like Regulatory Brain records).

**Summary** (`/`) — the dashboard, unchanged in spirit:
- **6 KPI cards:** Brain Completeness (verified ÷ total, company-only), Processes, Systems, Data Assets, Controls, Open Risks.
- **Company Snapshot** (legal name, CIN, type, HQ, founded, employees) with *View company profile →*.
- **Brain Completeness by Domain** (a bar per company domain), **Recent Activity**, and the **connected-graph footer** (company-only counts) + **Open Company Graph**.

The other 16 sub-tabs:

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Company Profile** | table | 12 attributes — Legal Name, Trading Name, Company Type, CIN, PAN, Founded, Parent, Website, Employees, HQ, Listing, FYE — each with Value · Category · Verification. |
| **Business Activities** | table | Consumer/SME/Commercial/Rural Lending, Deposits, Wealth, Insurance — with revenue share, segment, criticality. |
| **Legal Entities** | table | Bajaj Finance Ltd (Parent), Housing Finance, Financial Securities, Auto Finance Division — role, jurisdiction, CIN. |
| **Locations** | table | HQ Pune, Mumbai/Delhi offices, Bengaluru tech centre, primary + DR data centres — type, city, country. |
| **Jurisdictions** | table | India (RBI), Singapore (MAS) — regulator, scope, status. |
| **Industries & Sectors** | table | NBFC, Consumer Finance, Housing Finance — NIC code, sector, primary flag. |
| **Products & Services** | table | Consumer Durable / Personal / Home / Business Loans, Fixed Deposits, EMI & co-branded cards — category, segment, status. |
| **Organization** | table | Business units & functions (Retail Lending, SME, Risk & Compliance, Technology, Operations, Finance) — head, headcount. |
| **Licenses & Registrations** | table | NBFC License, CIC, IRDAI, AMFI, GST, ISO 27001 — authority, number, valid-till, status (Valid / Renewal Due / Surveillance Due). |
| **Regulatory Scope** | table | Areas of exposure — RBI KYC, PMLA/AML, DPDP, Digital Lending, Cyber Framework, SEBI — regulator, applicability, obligation count. |
| **Critical Functions** | table | KYC, Underwriting, Payments, Collections, Fraud, Reporting, Grievance — business impact, owner, dependencies. |
| **Completeness** | computed | Per-domain verified-% bars (all 8 domains **+ Overview**) + what drives the score. |
| **Data Quality** | computed | Signal bars — unverified records, needs-review, missing owners, low-confidence provenance. |
| **Verification** | computed | Overview records still needing verification (click → drawer). |
| **Activity** / **History** | computed | The change-history timeline. |

---

## 3. The universal domain page (used by all 8 operating domains)

Every domain (People, Processes, Systems, Data, Policies, Controls, Risks, Evidence) is the **same page** driven by config. Layout, top to bottom:

1. **Header** — domain icon, title, description, **Export**, **+ Add {Entity}**.
2. **Secondary nav (sub-tabs)** — the domain's own tabs (see §4). Clicking changes the view below.
3. **KPI row (4 cards)** — Total {Entities}, Verified (% of total), Pending Review, Critical & High.
4. **Toolbar** — a **Search** box, up to **4 filter dropdowns** (from the domain's config), a live **records count**, and **Clear all**.
5. **Data table** — the workhorse (see §3.1).

### 3.1 What the data table does
- **Columns** are configured per domain (e.g., Risks shows Risk · Category · Inherent · Residual · Owner · Status).
- **Row select** — checkboxes (per row + select-page). Selecting rows reveals a **bulk action bar**: Verify · Assign owner · Export · Clear.
- **Sort** — click a sortable column header (▲/▼).
- **Search + filters** — narrow the rows live; “Clear all” resets.
- **Pagination** — 10 / 25 / 50 per page, Prev/Next, “Showing 1–N of M”.
- **Export** — export the current view.
- **Click a row → slides the entity's detail drawer in from the right** (§5).
- **Per-sub-tab columns** — a sub-tab that lists a *different* entity type (e.g. People › Certifications, or the Overview tables) carries its **own column set**, so every tab shows the right fields rather than the domain default.

### 3.2 Sub-tab *kinds* (how each tab behaves)
Every sub-tab is one of these behaviours (no dead tabs):

| Kind | Behaviour | Example |
|---|---|---|
| **entities** | Lists the domain's own records (optionally filtered by a type). | People › *Directory* (Persons), *Departments*, *Teams*, *Roles* |
| **related** | A **graph lens** — shows entities of *another* domain that are connected to this domain, with a **Relationship** context column ("uses", "stores", "mitigates"…). | Processes › *Systems* = systems used by processes |
| **ownership** | The accountability view — **Person → owns → Entity** rows (relationships, not copies). | People › *Ownership* |
| **verification** | Only records whose verification ≠ Verified (the review backlog for this domain). | any domain › *Verification* |
| **history** | A change-history **timeline** for this domain's entities. | any domain › *History* |

---

## 4. Every domain and its sub-tabs

### 4.1 People — route `/people` (accountability layer)
**Columns:** Name · Role · Department · Location · Criticality · Verification. **Filters:** Role, Department, Location, Verification, Criticality.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Directory** | entities (Person) | All individuals — Priya Sharma, Rohit Verma, Neha Verma, Vikas Sharma, Aarav Mehta, Rajeev Jain, Meera Krishnan, Karan Malhotra. |
| **Departments** | entities (Department) | Compliance, IT Security, Risk Management, Operations, Technology (with head & member counts). |
| **Teams** | entities (Team) | KYC Operations, Fraud Monitoring, DevOps Platform (department, manager). |
| **Roles** | entities (Role) | Compliance Manager, CISO, Data Steward. |
| **Job Functions** | entities (Job Function) *own columns* | Compliance Oversight, Credit Underwriting, Access Management, Incident Response, Regulatory Reporting, Fraud Prevention — area, people, processes, criticality. |
| **Certifications** | entities (Certification) *own columns* | CISA, CISSP, CAMS, ISO 27001 LA, PMP — holder, issuer, expiry. |
| **Training** | entities (Training) *own columns* | AML/KYC, InfoSec Awareness, Code of Conduct, POSH, Data Privacy — audience, completion %, due date. |
| **Access & Identity** | entities (Access Profile) *own columns* | Admin/Read/Write/Approver profiles on Core Banking, DWH, CRM, GRC, Payment Gateway — system, level, last reviewed. |
| **External Personnel** | entities (External Person) *own columns* | Statutory auditor, pentest vendor, external counsel, collections agency — organization, engagement, access. |
| **Ownership** | ownership | Person → owns → Process/System/Data/Policy/Control/Risk. Click a row → the owned entity. |
| **Verification** | verification | People records still Pending / Needs Review. |
| **History** | history | People-related change events. |

### 4.2 Processes — route `/processes` (how work is done)
**Columns:** Process · Purpose · Owner · Criticality · Status · Verification. **Filters:** Criticality, Status, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Process Library** | entities | Customer Onboarding, KYC Verification, Loan Origination, AML Screening, Payment Processing, Collections. |
| **Systems** | related → systems | The systems each process *uses* (Core Banking, Salesforce CRM, AML Platform…). |
| **Data** | related → data | Data assets processes *handle/produce* (KYC Documents…). |
| **Controls** | related → controls | Controls operating in these processes. |
| **Risks** | related → risks | Risks arising in these processes. |
| **Evidence** | related → evidence | Evidence proving process execution. |
| **Verification / History** | verification / history | Backlog & timeline. |

### 4.3 Systems — route `/systems` (technology estate)
**Columns:** System · Type · Owner · Environment · Criticality · Verification. **Filters:** Type, Environment, Criticality, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Applications** | entities (Application) | Core Banking, Salesforce CRM, AML Platform, Loan Management, Payment Gateway, Data Warehouse. |
| **Databases** | entities (Database) | Customer Database, Transactions Database. |
| **Data** | related → data | Data stored/processed by systems. |
| **Processes** | related → processes | Processes each system supports. |
| **Controls** | related → controls | Controls protecting these systems. |
| **Verification / History** | verification / history | Backlog & timeline. |

### 4.4 Data — route `/data` (information assets)
**Columns:** Data Asset · Classification · Owner · Domain · Criticality · Verification. **Filters:** Classification, Domain, Criticality, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Data Assets** | entities | Customer Data, KYC Documents, Transaction Data, Credit Scores, Employee Data (with classification). |
| **Systems** | related → systems | Systems that store/process the data (lineage upstream). |
| **Processes** | related → processes | Processes that consume/generate the data. |
| **Controls** | related → controls | Controls protecting the data (Encryption at Rest…). |
| **Verification / History** | verification / history | Backlog & timeline. |

### 4.5 Policies — route `/policies` (the rules)
**Columns:** Policy · Category · Owner · Version · Status · Verification. **Filters:** Category, Status, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Library** | entities | KYC Policy, AML Policy, Information Security Policy, Data Retention Policy, Access Control Policy. |
| **Processes** | related → processes | Processes each policy governs. |
| **Controls** | related → controls | Controls that implement the policy. |
| **Risks** | related → risks | Risks the policy addresses. |
| **Verification / History** | verification / history | Backlog & timeline. |

### 4.6 Controls — route `/controls` (the execution layer)
**Columns:** Control · Category · Owner · Effectiveness · Frequency · Verification. **Filters:** Category, Effectiveness, Frequency, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Library** | entities | KYC Verification Control, Transaction Monitoring, MFA Enforcement, Access Review, Encryption at Rest. |
| **Risks** | related → risks | Risks each control mitigates. |
| **Policies** | related → policies | Policies each control implements. |
| **Systems** | related → systems | Systems each control protects. |
| **Evidence** | related → evidence | Evidence proving the control operates. |
| **Verification / History** | verification / history | Backlog & timeline. |

### 4.7 Risks — route `/risks` (what could go wrong)
**Columns:** Risk · Category · Inherent · Residual · Owner · Status. **Filters:** Category, Inherent, Residual, Status.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Risk Register** | entities | AML/CFT Non-Compliance, Customer Data Breach, Fraudulent Transactions, Credit Default, System Outage — with **Inherent → Residual** ratings. |
| **Existing Controls** | related → controls | Controls mitigating each risk. |
| **Processes** | related → processes | Processes where the risk arises. |
| **Data** | related → data | Data the risk threatens. |
| **Evidence** | related → evidence | Evidence supporting risk treatment. |
| **Verification / History** | verification / history | Backlog & timeline. |

*(Risk workflow reflected in the register + detail: Inherent Risk → Existing Controls → Effectiveness → Residual Risk → Treatment → Evidence → Review.)*

### 4.8 Evidence — route `/evidence` (proof the brain is real)
**Columns:** Evidence · Type · Owner · Freshness · Collected · Verification. **Filters:** Type, Freshness, Verification.

| Sub-tab | Kind | What's inside |
|---|---|---|
| **Library** | entities | KYC Review Report, Access Review Log, Transaction Monitoring Log, ISO 27001 Certificate, Penetration Test Report — with **Freshness** (Current / Approaching Expiry / Expired). |
| **By Control** | related → controls | Evidence grouped by the control it proves. |
| **By Process** | related → processes | Evidence proving process execution. |
| **By Policy** | related → policies | Evidence proving policy implementation. |
| **By Risk** | related → risks | Evidence supporting risk treatment. |
| **Verification / History** | verification / history | Backlog & timeline. |

---

## 5. Universal Entity Detail — the slide-over drawer

Clicking any row (or graph node, search result, or mapping target) **slides a detail drawer in from the right** over the current page — the backdrop dims, and `Esc` or a backdrop click closes it. It's the **same** drawer for every entity type in **either** brain. Header: entity icon, name, type · ID, and a **Close** ✕. Footer: **Full page** (opens the standalone `/entity/:id` route), **Verify**, **Edit**. Seven tabs:

| Tab | What it shows |
|---|---|
| **Overview** | **Status** badges (status · criticality · verification), a **Lifecycle stepper** (Discovered → Draft → Pending Review → Verified → Active → Under Review → Superseded → Archived, current highlighted), a compact **Properties** list, and clickable **relationship chips** (jump to any connected entity — the drawer re-loads in place). |
| **Properties** | The full property list — Id, Owner, and every configured column + free-form attribute for this entity. |
| **Relationships** | Every graph edge touching this entity — direction (→/←), **verb** (owns, uses, stores, mitigates, evidenced by…), the connected entity (click to re-centre the drawer on it), its domain, confidence %. |
| **Owners** | The accountability view — the entity's Owner and any *Person → owns →* records. |
| **Evidence** | Linked evidence entities (click → open that evidence in the drawer). |
| **Sources** | Full **provenance** — source, source reference, confidence, verified by/at, created/updated. |
| **Verification** | Verification state + the entity's change **history**. |

**This is what makes it a graph, not pages:** from any entity you can hop to any related entity, forever — without ever leaving the page you're on. (The full-page `/entity/:id` route still exists via **Full page** for deep-links and bookmarking.)

---

## 6. Company Graph — route `/graph` (the core asset)

A live **React Flow** canvas of the whole company.

- **Nodes** = entities, coloured/bordered by domain; **edges** = relationships.
- **Zoom / pan / fit** (controls bottom-left), **minimap** (bottom-right).
- **Domain filter chips** (top-left) — toggle People/Processes/Systems/… on/off.
- **Click a node** → it highlights and **dims everything except its neighbours**, edges to it animate and show their **verb**, and a **side panel** opens listing that node's relationships (each clickable to re-centre) + **Open detail →**.
- **Click empty space** → clears the selection.

> The graph shows the **8 operating domains** — Overview meta-records live in the same store but are filtered out of this canvas.

---

## 7. Out of scope — Regulatory Brain & Mapping

The **Regulatory Brain, Regulatory Mapping, Obligations and CAPA are out of scope** for the Company Brain product. They are **hidden** — no sidebar entries, no routes, and excluded from search (legacy code is kept on disk but unrouted). *Regulatory Scope* appears only as **company metadata** inside Overview, not as regulatory intelligence. See `COMPANY_BRAIN_DATA_DICTIONARY.md`.

---

## 9. Review Queue — route `/review` (AI proposes · humans approve)

Nothing machine-generated becomes trusted automatically. This screen shows AI/imported candidates.

- **KPIs:** Pending Review, Avg Confidence, Entities, Relationships.
- **Each item:** domain icon, title, kind (entity/relationship), the **proposed** relationships, **source** (Connector / AI Extraction / Document), **confidence %** (green ≥85, amber below), and **Approve / Edit / Reject** buttons. Approving/rejecting removes it from the queue (and the sidebar badge updates).

---

## 10. Search / Activity / Settings

- **Search** (`/search`) — one box searches the whole graph; results are **grouped by domain**; click any to open its detail **drawer**.
- **Activity** (`/activity`) — the full change-history timeline.
- **Settings** (`/settings`) — configuration cards (Company Profile, Users & Roles, Verification Rules, Connectors, Notifications) — marked *next phase*.

---

## 11. Add / Verify (write actions)

- **+ Add {Entity}** (on any domain page) → a modal with a **validated form** (React Hook Form + Zod): Name (required), Owner (from People), Criticality, Status, Verification, Description. On submit it's added to the graph (Pending Review) and appears in the list; a history event is logged.
- **Verify** (detail header or Verification tab) → sets the entity to Verified, advances its lifecycle, logs history — reflected instantly everywhere.

---

## 12. Guided user journeys

### Journey A — Explore the connected company (2 min)
1. Land on **Overview** → read completeness + snapshot.
2. Click **Open Company Graph** → see all 58 entities connected.
3. Click **Core Banking System** → panel shows *owned by Rohit*, *stores Customer Data*, *supports Customer Onboarding*, *protected by MFA*, *threatened by System Outage*.
4. **Open detail →** → Relationships tab → click **Customer Data** → you're now on the data asset, connected onward. You've traversed the graph.

### Journey B — Trace a data asset's full story
1. Sidebar → **Data** → **Data Assets** → open **Customer Data**.
2. **Overview:** classification Restricted, owner Neha Verma, lifecycle Active.
3. **Relationships:** *owned by* Neha, *stored in* Core Banking + Salesforce, *governed by* Data Retention Policy, *protected by* Encryption at Rest, *threatened by* Customer Data Breach — each chip re-centres the drawer on that entity.
4. **Sources:** source, confidence, verified-by/at. (For a domain-grouped blast-radius, **Full page → Impact**.)

### Journey C — Answer "who owns what?"
Sidebar → **People** → **Ownership** → a table of Person → owns → Entity across every domain, each linking to the owned entity. (Ownership is a relationship, never duplicated data.)

### Journey D — Review AI-detected data
Sidebar → **Review Queue** → inspect each AI proposal + confidence → **Approve** the ones you trust, **Reject** the rest. Only approved data is "real."

### Journey E — Add and verify a control
1. Sidebar → **Controls** → **+ Add Control** → fill the validated form → Add.
2. It appears (Pending Review). Open it → **Verify** → it becomes Verified/Active and logs to History.

### Journey F — Find anything fast
Topbar/​sidebar **Search** → type "KYC" → grouped results across People, Processes, Policies, Controls, Evidence → click → the detail **drawer** slides in.

### Journey G — Fix an attention item end-to-end
1. **Overview → Needs your attention** (or the **Data Quality** tab) → expand e.g. *Missing owner* / *Needs verification*.
2. Click an affected entity → its **drawer** slides in.
3. **Owners tab → Assign owner** (or footer **Verify**) → saves immediately and **logs to History**.
4. The item clears from attention and the domain's completeness updates — *AI proposed, you acted*.

---

## 13. Under the hood (why it scales)

- **One config source:** `src/config/companyBrain.ts` — the single place domains, sub-tabs, filters, relationship labels, detail sections, lifecycle, verification and provenance are declared (re-exporting `domains.ts` + `overviewDomain.ts`). Sidebar, secondary nav, drawer sections, graph filters and search grouping derive from it. Adding a sub-tab is a config change, **not** a new page.
- **One entity model:** `src/types/entity.ts` — every record shares name/owner/status/criticality/**provenance**/**lifecycle**/**verification** + free-form `attrs`.
- **One graph, shared IDs:** `src/data/seed.ts` + `overviewSeed.ts` + `peopleSeed.ts` — entities + typed relationships; the same ID is reused across every view (no duplicate records).
- **One universal drawer:** `src/components/EntityDrawer.tsx`, opened via `openEntityId` in `src/app/store/ui.ts` — every list, graph and search surface reuses it.
- **Live store:** `src/app/store/data.ts` (Zustand) — add/verify/assign-owner update the UI everywhere instantly. In a later phase this store is swapped for the FastAPI/Postgres backend without changing any page.

---

*Company Brain — React app. Seed tenant Bajaj Finance Limited is illustrative. **Built:** the 9 Company Brain domains, the universal detail drawer (entity-type-aware relationships), the connected Overview + attention system, the contextual Company Graph, review/verify and add/verify loops. **Out of scope (hidden):** Regulatory Brain, Mapping, CAPA. Authoritative model: `COMPANY_BRAIN_DATA_DICTIONARY.md`.*
