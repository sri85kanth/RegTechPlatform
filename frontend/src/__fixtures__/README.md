# Fixtures — NOT production code

Nothing in this folder may be imported by the application. It exists only so the
old hand-authored records remain inspectable in version control.

`regSeed.fixture.ts` contains the regulatory demo data that used to reach the UI:

- `reg-pmla`, `reg-dpdp`, `reg-cyber`, `reg-digilend` — invented regulations
- "KYC Direction — Amendment (06 Nov 2024)" — invented change
- "STR filing window reduced 15 → 7 days" — invented change
- "DPDP consent record made mandatory" — invented change

The production regulatory path is:

    government source → scraper → regintel.db → FastAPI → frontend

A lint rule (eslint `no-restricted-imports`) blocks any import from this folder.
