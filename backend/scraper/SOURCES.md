# Official Regulation Sources — Research & Crawl Inventory

Research date: 13 Aug 2026. Every "probe" figure below is from an actual
crawl4ai fetch run from this machine, not an assumption. Ratings:
**EASY** = static/table HTML, parser is straightforward · **MEDIUM** = JS-heavy
or link-soup, needs a tailored parser · **HARD** = form/search-driven, blocked,
or state-fragmented.

## The two universal channels (any company, any sector)

| Source | What it is | URL | Probe | Status |
|---|---|---|---|---|
| **India Code** | THE official repository of all in-force central legislation — every act across labour, corporate, tax, environment, IT, criminal law | indiacode.nic.in `/handle/123456789/1362/browse` | 200 · paginated table | ✅ **Implemented — 845 acts** |
| **e-Gazette of India** | The *authoritative* publication channel: nothing becomes law without Gazette notification. Covers ALL subordinate legislation (rules, notifications, amendments) from every ministry | egazette.gov.in | 302 → form/search-driven portal | ⏳ HARD — needs search-driven crawling with session handling; highest authority, do when change-detection matters |

India Code bonus (verified working): `browse?type=ministry&value=Labour+and+Employment`
lets us tag every act with its **owning ministry** — cheap enrichment pass.

## Financial sector regulators

| Regulator | Scope | Index | Probe | Status |
|---|---|---|---|---|
| **RBI** — Master Directions | Banking, NBFC | rbi.org.in `BS_ViewMasDirections.aspx` | 200 · clean table | ✅ **Implemented — 383** |
| **RBI** — FEMA notifications | Forex / cross-border | rbi.org.in `BS_viewfemanewnotification.aspx` | 200 · **174 table rows, 456 links** | 🟢 EASY — recommended next |
| **SEBI** — Regulations | Securities, listed cos | sebi.gov.in listing `sid=1&ssid=3` | 200 · table (only p1 fresh via GET) | ✅ **Implemented — 42** |
| **IRDAI** — Consolidated regulations | Insurance | irdai.gov.in consolidated page | 200 · table + PDFs | ✅ **Implemented — 20** |
| **PFRDA** — Regulations | Pensions (NPS) | pfrda.org.in `/regulatory-framework/regulations` | 200 · Liferay link-list, no tables | 🟡 MEDIUM |

## Tax

| Authority | Scope | Index | Probe | Status |
|---|---|---|---|---|
| **CBIC** — GST acts | Indirect tax | cbic-gst.gov.in `gst-acts.html` | 200 · PDF anchors | ✅ **Implemented — 5** |
| **CBDT** — Income-tax acts/rules | Direct tax | incometaxindia.gov.in `/all-acts` | 200 but JS app (0 tables) | 🟡 MEDIUM — needs JS-rendered parse or their acts API |
| CBIC — Customs acts/rules | Customs | cbic.gov.in | not probed | 🟡 |

## Corporate / legal / competition

| Authority | Scope | Index | Probe | Status |
|---|---|---|---|---|
| **MCA** — Acts & Rules e-books | Companies Act 2013, LLP Act + all rules | mca.gov.in `/acts-rules/ebooks.html` | 200 · **359 links** | 🟢 EASY–MEDIUM — recommended next |
| **CCI** — Act + regulations | Competition law (any large company) | cci.gov.in `/legal-framwork/act` (+ `/regulations`) | 200 · small link list | 🟢 EASY (small set) |
| IBBI — Insolvency regulations | IBC | ibbi.gov.in | not probed | 🟡 |

## Labour & employment

| Authority | Scope | Index | Probe | Status |
|---|---|---|---|---|
| Labour codes (the 4 acts) | All employers | — | — | ✅ Already captured via India Code |
| **Ministry of Labour** — rules under codes | Central rules | labour.gov.in | 200 but **0 links extracted** (JS/blocked) | 🔴 HARD via site; rules arrive via e-Gazette; PDF handbook exists |
| EPFO / ESIC | PF & state insurance | epfindia.gov.in / esic.gov.in | not probed | 🟡 acts already in India Code; schemes = PDFs |
| State Shops & Establishments | Per-state | 28+ state portals | — | 🔴 HARD — state-fragmented, phase last |

## Data / IT / telecom

| Authority | Scope | Index | Probe | Status |
|---|---|---|---|---|
| **MeitY** — DPDP Act + Rules 2025, IT Act | Data protection (every company) | meity.gov.in `/data-protection` | 200 · 41 links (small doc set) | 🟢 EASY (few, high-value docs) |
| **TRAI** — Regulations | Telecom/QoS (relevant to comms usage) | trai.gov.in `/release-publication/regulations` | 200 · **211 links, 30 PDFs** | 🟢 EASY–MEDIUM — recommended next |
| CERT-In directions | Cyber incident reporting | cert-in.org.in | not probed | 🟡 |

## Environment / food / trade

| Authority | Scope | Index | Probe | Status |
|---|---|---|---|---|
| MoEFCC / CPCB | Environment acts & rules | cpcbenvis.nic.in legislation page | **timeout/down** | 🔴 acts already in India Code; rules via e-Gazette |
| **FSSAI** — Regulations | Food businesses | fssai.gov.in `/cms/regulations.php` | 200 but 14 kb menu page | 🟡 MEDIUM — real list one level deeper |
| DGFT — Foreign Trade Policy | Import/export | dgft.gov.in | not probed (JS portal) | 🟡 |

## Implementation status (13 Aug 2026 — all tiers attempted)

**Live: 15 sources → 1,758 regulations across 13 authorities.**

| Tier | Source | Result |
|---|---|---|
| 0 | India Code 845 · RBI MD 383 · SEBI 42 · IRDAI 20 · CBIC GST 5 | ✅ |
| 1 | RBI FEMA 48 · TRAI 351 (titles from download `aria-label`, 12-page deep crawl) · CCI 2 (titles from URL slugs) · MeitY 3 (client-rendered, `wait_for` crawl) | ✅ |
| 1 | India Code **ministry enrichment** — 843/845 acts tagged via the ministry facet (51 ministries); merged from cached `output/ministry_map.json` | ✅ |
| 1 | MCA acts-rules e-books | ❌ JS application (XHR content) — acts covered via India Code |
| 2 | FSSAI 26 · DGFT FTP 10 · PFRDA 10 · CERT-In 8 | ✅ |
| 2 | IBBI | ⚠️ HTTP 500 to headless crawlers — kept registered; failure visible in Source Monitor daily |
| 2 | EPFO (empty page to headless) · CBDT (302/JS app) | ❌ honest skips; acts covered via India Code |
| 3 | CPCB 5 (incl. the Pollution Control Law "Green Book" compendium) | ✅ via redirect target |
| 3 | CLC labour-law (menu shell) · e-Gazette (session-gated search portal) · state-level regimes | ❌ documented for a later phase |

## Principles

- Only official government/regulator domains — never aggregators (cleartax,
  taxguru, lexology etc. are research aids, not sources).
- Acts (primary legislation) come from India Code once — don't re-scrape the
  same act from each ministry site; ministry sites add *subordinate* rules.
- Every source records `httpStatus`/`error` in output; failures are visible.
- A company's applicable subset = universal base (India Code core + DPDP + CCI
  + labour codes + tax) **plus** sector regulators chosen by its profile
  (finance → RBI/SEBI/IRDAI/PFRDA; food → FSSAI; telecom → TRAI …).
