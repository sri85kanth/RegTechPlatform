# Company Brain — React Application

Production-scaffold React + TypeScript + Vite + Tailwind app converted from the HTML prototype.
The Company Brain is a **connected graph** (People · Processes · Systems · Data · Policies · Controls · Risks · Evidence); pages are views of that graph.

## Run

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # type-check + production build
npm run typecheck
```

## Stack
React 18 · TypeScript (strict) · Vite · Tailwind CSS · React Router · TanStack Query · Zustand · React Hook Form · Zod · Lucide · React Flow.

## Architecture (config-driven — not 9 separate CRUDs)
```
src/
├── app/            router · providers (React Query) · store (Zustand: ui, data)
├── layouts/        AppShell · Sidebar · Topbar
├── config/         domains.ts (per-domain columns/filters/sub-tabs) · icons
├── types/          entity.ts (universal Entity + Relationship model)
├── data/           seed.ts (one demo company as a single graph, shared IDs)
├── services/       entities.ts (graph-backed data access, relationship resolution)
├── components/     ui · tables (DataTable) · forms (Add + Zod)
├── modules/        EntityListPage (all domains) · EntityDetailPage · Overview · Search
├── graph/          CompanyGraphPage (React Flow)
└── review/         ReviewQueuePage (AI proposes · human approves)
```

Every domain renders from `DOMAINS` config through one `EntityListPage` + one `EntityDetailPage`.
Each real-world entity has exactly **one id** and appears in many views by relationship — never duplicated.

## Implemented (Phases 1–5)
App shell · universal table/detail/forms · all 9 Company Brain domains · relationship graph (React Flow) · verification/review queue · provenance & lifecycle · global search.

## Next phases (structured, not yet built)
6 — FastAPI + PostgreSQL + SQLAlchemy backend (replace in-memory Zustand store; keep the same service API).
7–9 — Regulatory Brain · Mapping Engine · Impact/Blast-radius (kept conceptually separate; the graph + provenance model is ready to connect).
