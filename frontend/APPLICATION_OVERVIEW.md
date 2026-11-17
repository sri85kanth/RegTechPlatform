# Company Brain — Application Overview

A single-page summary of **everything the application does today**, organised so you can react to each part and give feedback.

- **Run:** `cd company-brain-app && npm install && npm run dev` → http://localhost:5180
- **Demo tenant:** Bajaj Finance Limited (seed data)
- **Status legend:** ✅ built & working · 🟡 built (MVP / basic) · ⏭️ deferred to a later phase

---

> **Architecture is frozen.** Nine Company Brain domains, one entity model, one config source (`src/config/companyBrain.ts`). Regulatory Brain / Mapping are **out of scope** — hidden from the app (code kept on disk). See `COMPANY_BRAIN_DATA_DICTIONARY.md` for the authoritative model.

## 1. What it is (in one line)

The **Company Brain**: one connected graph of how a company actually operates — People · Processes · Systems · Data · Policies · Controls · Risks · Evidence. Every real-world thing exists **once** (one ID) and appears in many screens by relationship, never duplicated. AI proposes; humans verify.

---

## 2. The big picture

```
        COMPANY BRAIN                     REGULATORY BRAIN
  (what the company IS & DOES)        (the outside rules that apply)
  ┌────────────────────────┐          ┌────────────────────────┐
  │ Overview (17 sub-tabs) │          │ Regulators             │
  │ People                 │          │ Regulations            │
  │ Processes              │          │ Clauses                │
  │ Systems                │          │ Obligations (structured)│
  │ Data                   │          │ Changes                │
  │ Policies               │          │ Sources                │
  │ Controls               │          └───────────┬────────────┘
  │ Risks                  │                      │
  │ Evidence               │          ┌───────────▼────────────┐
  └───────────┬────────────┘          │     MAPPING ENGINE      │
              └─────────────────────► │  obligation → company   │
                one shared graph      │  AI proposes · you approve│
                one set of IDs        └─────────────────────────┘
```

Everything opens in **one universal slide-over drawer**, and there's a live **Company Graph** view of the whole thing.

---

## 3. Company Brain — Overview (the company itself) ✅

Route `/` and `/overview/:subtab`. **17 sub-tabs** describing the company.

| Sub-tab | Shows | Status |
|---|---|---|
| Summary | Dashboard: completeness, snapshot, activity, graph footer | ✅ |
| Company Profile | 12 attributes (Legal Name, CIN, PAN, HQ, Founded…) | ✅ |
| Business Activities | Lending lines with revenue share & segment | ✅ |
| Legal Entities | Parent + subsidiaries with jurisdiction & CIN | ✅ |
| Locations | HQ, offices, primary + DR data centres | ✅ |
| Jurisdictions | India (RBI), Singapore (MAS) | ✅ |
| Industries & Sectors | NBFC / Consumer / Housing finance codes | ✅ |
| Products & Services | Loans, deposits, cards | ✅ |
| Organization | Business units & functions with headcount | ✅ |
| Licenses & Registrations | NBFC, CIC, IRDAI, AMFI, GST, ISO 27001 + validity | ✅ |
| Regulatory Scope | Areas of exposure + obligation counts | ✅ |
| Critical Functions | KYC, Underwriting, Payments… with impact & owner | ✅ |
| Completeness | Per-domain verified-% bars (8 domains + Overview) | ✅ |
| Data Quality | Signal bars (unverified, missing owners, low confidence) | ✅ |
| Verification | Overview records still to verify | ✅ |
| Activity / History | Change-history timeline | ✅ |

---

## 4. Company Brain — the 8 operating domains ✅

All rendered by **one config-driven page**. Each has 4 KPI cards, search + filters, a sortable/paginated table, and sub-tabs.

| Domain | Route | Core sub-tabs | Status |
|---|---|---|---|
| **People** | `/people` | Directory, Departments, Teams, Roles, **Job Functions, Certifications, Training, Access & Identity, External Personnel**, Ownership, Verification, History | ✅ (12 tabs) |
| **Processes** | `/processes` | Library + related Systems/Data/Controls/Risks/Evidence | ✅ |
| **Systems** | `/systems` | Applications, Databases + related Data/Processes/Controls | ✅ |
| **Data** | `/data` | Data Assets + related Systems/Processes/Controls | ✅ |
| **Policies** | `/policies` | Library + related Processes/Controls/Risks | ✅ |
| **Controls** | `/controls` | Library + related Risks/Policies/Systems/Evidence | ✅ |
| **Risks** | `/risks` | Register (Inherent → Residual) + related Controls/Processes/Data/Evidence | ✅ |
| **Evidence** | `/evidence` | Library (freshness) + By Control/Process/Policy/Risk | ✅ |

Sub-tabs behave as one of: **entities** (own records) · **related** (a graph lens onto another domain) · **ownership** · **verification** · **history**. Sub-tabs that list a different entity type carry their **own columns**.

---

## 5. Universal detail drawer ✅

Clicking any row, graph node or search hit **slides a detail panel in from the right** (backdrop dims; Esc closes). Same drawer for **every** Company Brain entity.

- **7 tabs:** Overview · Properties · Relationships · Owners · Evidence · Sources · Verification
- **Overview tab:** status badges, an 8-step **lifecycle stepper**, properties, and clickable relationship chips (hop to any connected entity without leaving the page).
- **Relationships tab:** entity-type-aware — related entities **grouped by domain** (Process → People / Systems / Data / Policies / Controls / Risks / Evidence), ordered per config, only where data exists.
- **Owners tab:** shows the owner and an **Assign / Reassign owner** control (logs to History).
- **Footer:** View in graph (focuses the Company Graph on this entity) · Full page (`/entity/:id`) · Verify.

---

## 6. Out of scope ⏭️

**Regulatory Brain, Regulatory Mapping, Obligations, and CAPA are out of scope** and are **hidden** from the app — no sidebar entries, no routes, excluded from search. The legacy code remains on disk (unrouted) but is not part of the product. *Regulatory Scope* survives only as **company metadata** inside Overview, not as regulatory intelligence.

---

## 8. Platform screens

| Screen | Route | What | Status |
|---|---|---|---|
| **Company Graph** | `/graph` | Live React-Flow canvas of the whole company; domain filter chips; click a node → neighbours highlight + side panel | ✅ |
| **Review Queue** | `/review` | AI/imported candidates with confidence → Approve / Reject | ✅ |
| **Search** | `/search` | One search across the whole graph, grouped by domain → opens the drawer | ✅ |
| **Activity** | `/activity` | Full change-history timeline | ✅ |
| **Add / Verify** | any domain | Validated add-entity modal; Verify advances lifecycle + logs history | ✅ |
| **Settings** | `/settings` | Config cards | 🟡 placeholder |

---

## 9. Principles honoured (the hard constraints)

- ✅ **One entity = one stable ID.** No duplication across modules — things appear by relationship.
- ✅ **AI proposes, humans approve.** Review-queue items are never auto-trusted.
- ✅ **No fabricated results.** Relationships, attention and coverage come only from the real graph/data.
- ✅ **One config, one architecture.** Every domain uses the same config-driven page + universal drawer, all deriving from `src/config/companyBrain.ts` — no competing second system.
- ✅ **Scope frozen.** Nine domains; no Regulation / Regulatory Brain / Mapping / CAPA.

---

## 10. Tech stack

React 18 · TypeScript (strict) · Vite · Tailwind · React Router · Zustand (client store) · React Flow (graph) · Lucide icons. Config-driven domains + a universal entity model with provenance / lifecycle / verification on every record.

**Quality gates:** `tsc` 0 errors · `eslint` 0 errors · production build ✓ · verified in-browser with no console errors.

---

## 11. What's deferred (later phases) ⏭️

- **Role-F detail data** — Activities / Inputs / Outputs / Lineage etc. are wired in config and render when data exists; the seed doesn't populate them yet.
- **Backend** — FastAPI + Postgres; the Zustand store is the swap-point, pages won't change.
- **Settings** — real configuration (users, verification rules, connectors).

*Out of scope (not deferred — excluded):* Regulation, Regulatory Brain, Mapping, Obligations, CAPA.

---

## 12. Companion docs

- **COMPANY_BRAIN_DATA_DICTIONARY.md** — the authoritative reconciled model (domains, entities, A–J roles, relationships, lifecycle, provenance).
- **USER_JOURNEY.md** — screen-by-screen walkthrough with guided journeys.
- **README.md** — setup & structure.

---

*Seed tenant Bajaj Finance Limited is illustrative. Please mark anything you want changed, added, or reprioritised — I'll take feedback per section.*
