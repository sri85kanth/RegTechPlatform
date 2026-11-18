# Company Brain: technologies and techniques — what to keep, what to change, and why

*8 November 2026. This report combines 10 independent reviews of the Company Brain code, the backend and the server set-up. They were written in parallel, each with a different way of thinking. Where 8 or more of the 10 agreed, the point is listed as a recommendation. The key facts were then checked against the code by hand.*

---

## 1. The short answer

1. **Your technology choices are mostly right. Keep them.** React + Vite + TypeScript, FastAPI, PostgreSQL with pgvector, nginx and systemd on one server are the right size for one hospital, one owner and an AI coding agent. All 10 reviews said keep them.
2. **The real risks are in how the work is done and protected, not in the tools.**
   - Your code lives only on your laptop.
   - Your backups sit on the same disk as the database, and uploaded evidence files are not backed up at all.
   - Nothing clicks through the app automatically before a release.
   - The preview runs on made-up empty replies.
   - A deploy copies files over the live site with no one-step undo.
3. **About 4 working days fix the important things**, with no new server and almost no new cost.
4. **Only a few new tools earn a place:** a private git remote with CI, restic for off-site backups, Playwright for automatic click-through tests, a content security policy and login limits in nginx, and later a small job worker that uses PostgreSQL.
5. **Many popular suggestions would make things worse here**, for example Next.js, Kubernetes, Docker in production, microservices, a separate vector database, Elasticsearch, Redis as a cache, i18next, and big framework upgrades right now. Section 7 says why.

> **తెలుగులో క్లుప్తంగా:** మీరు ఎంచుకున్న technologies దాదాపు అన్నీ సరైనవే — వాటిని మార్చాల్సిన అవసరం లేదు. మార్చాల్సింది పని చేసే విధానం. ముందుగా: (1) code ని laptop బయట ఒక private git remote లో పెట్టండి, (2) database backups మరియు upload చేసిన files ని server బయట కూడా ఉంచండి, (3) ప్రతి deploy కి ముందు ఒకే command తో అన్ని checks మరియు click-through tests automatic గా నడవాలి, (4) deploy ని ఒక command తో వెనక్కి తీసుకునేలా చేయండి. ఇవి సుమారు 4 రోజుల పని.

---

## 2. Facts checked by hand

| Claim from the reviews | Checked | Result |
|---|---|---|
| All 11 "tolerated" type errors are in pages nothing uses | Ran `tsc`, then searched for imports | **True.** They are in `ActionsPage.tsx`, `ImpactEnginePage.tsx`, `RegulationPage.tsx` and `ReviewQueuePage.tsx`, and no file imports them. |
| The code history is only on the laptop | `git rev-list` | **True.** The app has 15 commits. The backend has 1 snapshot commit. Neither has a remote. |
| Uploaded files are not in the backup | Read `deploy/systemd/company-brain-backup.service` | **True.** It runs `pg_dump` for the two databases only, and writes to the same disk. |
| The whole app ships as one big file | Checked `dist/assets` | **True.** One 1.75 MB JavaScript file, about 500 KB compressed. `public/data` adds 31 MB of PDFs. |
| Some AI features point at a private address by default | Searched for `LOCAL_LLM_BASE_URL` | **True** in the code (`http://172.22.64.1:8081/v1` in `doc_intake.py` and others). Whether the server's settings override it is still to be **checked** on the server. |

---

## 3. Technologies: keep, change, add, drop

| Area | Used now | Verdict | Why |
|---|---|---|---|
| Frontend core | React 18, Vite 5, TypeScript (strict), Tailwind 3, TanStack Query, React Router 6, zustand, react-hook-form + zod | **Keep.** Upgrade majors (React 19, Router 7, Tailwind 4, Vite 7) later, one at a time, only after automatic tests exist. | They are standard, fast and well known to AI agents. Upgrading now changes many files and gives your users nothing. |
| Page loading | Every page in one 1.75 MB file | **Change:** load each page only when it opens (`React.lazy` in the router). Remove the 31 MB `public/data` PDFs from the app. | Hospital Wi-Fi and auditors on slow links download only what they open. The first screen loads several times faster. |
| Diagram library | reactflow 11 + dagre | **Change, when next touched:** the maintained `@xyflow/react` package. | reactflow 11 is no longer the maintained line. Same API family, small move. |
| Cascade diagram | Raw HTML/SVG strings inside a React page | **Keep for now, with automatic escaping.** Move it to React at its next redesign. | Hand-built HTML strings can let untrusted text run as code. Escaping fixes the risk without a rewrite. |
| Backend | FastAPI, uvicorn, psycopg 3 | **Keep.** | Right tool, well supported, fast enough for one hospital. |
| SQL layer | `pgdb.py` rewrites SQLite-style SQL into PostgreSQL with regular expressions | **Change, step by step:** write PostgreSQL SQL directly, one module at a time. | Regex rewriting breaks on unusual queries and hides real PostgreSQL features. |
| Database changes | Ad-hoc scripts | **Add numbered migrations**, either a small runner or Alembic in SQL-only mode. | You can see and repeat exactly what changed in the database, in order, on any copy. |
| API types | Hand-written TypeScript types | **Add over time:** response models in FastAPI, and generate the TypeScript types from them. | The crashes found last week ("cannot read … of undefined") came from the frontend guessing the reply shape. Generated types catch that at build time. |
| Background work | Threads inside the API, plus a clean-up job | **Keep for now. Later, add a job worker** that uses a PostgreSQL table as its queue (`SELECT … FOR UPDATE SKIP LOCKED`, or the Procrastinate library), run with a lower CPU priority. | Long AI drafting and document intake stop slowing the API on a 4-core box. Nothing new to run: PostgreSQL is already there. |
| Search | PostgreSQL full-text + pgvector, English model `bge-base-en-v1.5`, MiniLM re-ranker, 150-question test set | **Keep the design.** Add a text-search index, and test a multilingual model (`BAAI/bge-m3`) on the test set plus Hindi and Telugu questions. Switch only if it wins. | One database for records and search is simpler and cheaper than a separate vector database. A multilingual model only matters if staff search in Indian languages. |
| AI models | Local `gpt-oss-120b` → DeepSeek → OpenAI fallback | **Keep the fallback idea. Check** that the local model is reachable from the server, and **write down which data may go to outside AI services.** | Today the order of the fallbacks decides where hospital data goes. That should be your decision, written down. |
| Impact agent | Two versions: plain Python and LangGraph | **Keep one.** | Two engines double the work and drift apart. |
| Tracing | Langfuse (self-hosted, production) + LangSmith (development) | **Keep Langfuse for production; check its RAM use.** Keep LangSmith off production data. | Traces contain names and clause text, so they should stay on your server. The Langfuse stack is heavy for a 15 GB box. |
| Redis | Runs on the server; Company Brain does not use it | **Do not add it as a cache.** | TanStack Query on the client and PostgreSQL on the server already cover caching. |
| Translation library | Own small i18n module, English sentence as the key, 8 languages | **Keep.** Do not move to i18next or FormatJS. | It already does what you need. Moving would touch about 3,700 strings and every page. |
| Web server and hosting | nginx + certbot, one VPS, `187-77-188-114.sslip.io` | **Keep nginx and the VPS. Buy a real domain.** | sslip.io is a free third-party service built from today's IP address. A real domain is more trustworthy for a hospital and its auditors. |
| Video | HyperFrames + Kokoro voice + puppeteer screenshots | **Keep HyperFrames and Kokoro.** Capture screenshots from the preview with a saved script. | Repeatable, free and offline, and no production data in the video pipeline. |

### New tools worth adding

| Tool | What it does for you |
|---|---|
| **Private git remote (GitHub or GitLab) + CI** | Code survives a lost laptop. Every push runs the checks automatically, so a broken build can't slip through. |
| **restic** | Encrypted, deduplicated, off-site backups of the databases **and** uploaded files, with a restore you have actually tested. |
| **Playwright** | Opens every page and clicks the main actions automatically, in English and one Indian language, before every deploy. It replaces the hand-run crash sweep. |
| **A phone alert + an outside uptime check** (for example healthchecks.io) | When the server is down it can't tell anyone itself. An outside check can. |
| **nginx hardening** | A login rate limit, security headers on every page, and a content security policy (start in report-only mode). |

---

## 4. Techniques: how the work is done now, and what to do instead

| Step | Now | Suggested | Why it is better |
|---|---|---|---|
| Editing code | The agent edits with Python string-replace scripts and `sed` | Exact-match edits; renames through the TypeScript tools; show `git diff --stat` before each commit | Fewer silent half-edits. One of last week's slips was a replace that hit two places at once. |
| Checking before shipping | `tsc` with 11 old errors allowed, build, lint on changed files only | Delete the 4 unused pages (and 3 unused files that cause 20 lint errors), then **one command, `npm run check`, with zero errors**, run on every push and before every deploy | With 11 known errors, a 12th new one hides. Lint the whole app, because changing one file can break the files that use it. |
| Previewing | Mock server with fixtures in a temporary folder; missing fixtures return an empty "success" | Fixtures in a kept folder; **a missing fixture is a loud error**; later a demo hospital database for preview, tests and video | Last week's "crashes" on Governance, intake and auditor pages came from fake empty replies. An honest preview shows only real problems. |
| Testing | Screenshots and a JavaScript loop by hand | Playwright smoke tests in the repo, run by one command and by CI | The same check every time, in a minute, without anyone remembering to do it. |
| Translating | The agent writes 8 languages by hand in batches | Keep the agent, but give it a **fixed translation prompt file plus the glossary**, feed it only changed strings, and add a `--prune` step for unused strings. Have a native speaker review Telugu and Hindi now and then. | Terms stay the same across sessions, unchanged strings are never re-translated, and a person checks the meaning in the languages staff use most. |
| Version control | Git on the laptop only | Private remote; one commit per change; CI on push | History survives, and every deploy can be traced to a commit. |
| Deploying | Build, back up, `rsync` over the live folder, compare the hash | **One `deploy.sh`:** run the checks, build, upload into a new release folder, switch production to it in one step, verify, and **roll back with one command** | No half-copied site during upload, and undo takes seconds instead of a manual restore. |
| Design changes | Fast screenshot rounds; the Regulations page was redesigned 3 times in a day | Write the rules you keep repeating into a **`CLAUDE.md`** the agent reads every session, for example: "real data only", "no summary cards or tile rows", "one copy of each fact", "colour means status", "simple Apple style". For big changes, ask for 2 variants side by side first. | The agent gets it right the first time more often, and fewer redesigns are deployed and then undone. |
| Project docs | `README.md`, `APPLICATION_OVERVIEW.md` and `USER_JOURNEY.md` describe an older prototype | Replace with one page: what it is, how to run, how to check, how to deploy | The agent and any new person stop working from wrong instructions. |

---

## 5. Do these first

| # | Do this | Time | Why now |
|---|---|---|---|
| 1 | Push both repositories to a private remote; scan history for secrets first | 20 min | A lost or stolen laptop takes all history with it. The backend has one commit. |
| 2 | Off-site encrypted backups with restic, **databases and uploads**, plus a test restore | 1–2 h | One disk failure today loses the database, every backup and every evidence file. |
| 3 | Delete the 7 unused files, make `npm run check` the zero-error gate | 15–30 min | Turns "11 known errors" into "any error means real breakage". |
| 4 | Make the preview honest: kept fixtures, loud misses | 20 min | Stops false crashes and stops hiding real ones. |
| 5 | Playwright smoke test of every page and the main clicks | 1–2 h | Replaces the hand-run sweep with one command. |
| 6 | `deploy.sh` with release folders, one-step switch and one-command rollback | 1–2 h | Safer deploys; undo in seconds. |
| 7 | Phone alerts plus an outside uptime check | 30 min | You find out when the site is down before the hospital does. |
| 8 | nginx: login rate limit, security headers, CSP in report-only mode | 1 h | The site is public, and there is no limit on password guessing today. |
| 9 | Load pages on demand; remove the 31 MB `public/data` | 1 h | Much faster first load on hospital networks. |
| 10 | Find why sources show 0% reachable; score the applicable regulations that have no score | 1 h + run time | These are the numbers auditors notice first. |
| 11 | Check the local AI address on the server; write down what data may go to outside AI | 1 h | Some AI features may be running with no AI on the live site, and data flow should be your choice. |
| 12 | Buy a real domain | 30 min + DNS | Trust, and no dependence on a free third-party name. |

**Later, when you next touch that code:** move to `@xyflow/react`, numbered migrations, response models and generated types, a PostgreSQL job worker, one impact engine, the session in an HttpOnly cookie instead of localStorage, self-hosted fonts, and one framework upgrade at a time once the tests exist.

---

## 6. Why and how the suggestions are better

- **They protect what you can't rebuild.** The code history, the database and the uploaded evidence are the parts of Company Brain you can't recreate. A remote, off-site backups and a tested restore cover all three for a few hours of work and a few rupees a month.
- **They turn memory into machines.** Today, quality depends on someone remembering to run checks, sweep pages and back up before deploying. One check command, Playwright, CI and `deploy.sh` do the same steps the same way every time.
- **They make problems visible early.** A zero-error type check, honest preview replies and generated API types turn "the page crashed for a user" into "the build failed on my laptop".
- **They fit one server and one owner.** Every recommendation runs on the existing VPS with PostgreSQL, nginx and systemd. Nothing adds a cluster, a second database or a new paid platform to look after.
- **They save AI-agent time.** A `CLAUDE.md` with your design rules, a translation prompt file and exact-match edits mean fewer redesign rounds, consistent translations and fewer accidental edits.
- **They answer what auditors and hospitals will ask:** where the data goes, how it is backed up, who can log in and how often, and whether the numbers on screen are trustworthy (sources reachable, impact scores).

---

## 7. What not to do, and why

| Popular suggestion | Why not here |
|---|---|
| Next.js / server-side rendering | The app sits behind a login, so search engines don't matter. It would add a Node server to run and rewrite every page for no user benefit. |
| Kubernetes, microservices, Docker in production | One VPS and one owner. These add moving parts and failure points, and the systemd set-up already restarts and isolates services. |
| A separate vector database or Elasticsearch | pgvector and PostgreSQL full-text already do hybrid search in the database you back up. A second store doubles backups and RAM. |
| Redis as a cache | TanStack Query and PostgreSQL already cache. Another moving part, no gain. |
| An ORM rewrite (SQLAlchemy models everywhere) | A large rewrite with risk. Direct PostgreSQL SQL plus migrations gets the benefit gradually. |
| i18next / FormatJS | Your module already does what you use. Moving touches about 3,700 strings in 8 languages. |
| Celery | Needs a broker such as Redis. A PostgreSQL-backed queue does the same with what you have. |
| Upgrading React, Router, Tailwind and Vite now | No user benefit, many files changed, and no tests yet to catch breakage. Do it after Playwright exists, one at a time. |

---

## 8. Where the full reviews are

The 10 full reviews (4,700–12,700 words each, with ready-to-use scripts for backups, nginx, `deploy.sh`, Playwright, CI and the preview fix) are in:

`/Users/ramprasad/Documents/no brain/.arena/run-20261108-193226-s609376/r0/` — files `a001.md` to `a010.md`.

The run was stopped before the knockout rounds, so no single review was judged the best. This report is the common ground across all 10, with the key facts checked by hand.
