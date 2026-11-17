# Company workspaces

One installation serves many companies, at **one address with one sign-in**. Each company
has its own database schema, database role, Linux user and API service; the regulation
library (regulations, sections, obligations, requirements, AI search passages) is shared.
The first company (Premier) stays where it always was and is the "main company".

## How people move between companies

- Everybody signs in on the main installation. The sidebar's company menu lists the
  companies they may work in; choosing one sends `X-Company: <slug>` with every request.
- nginx (snippet written by `tenantctl.py setup-routing`) asks the main API
  (`/api/auth/gate`) whether the session may work in that company, then passes the request
  to the company's API port (`conf.d/company-brain-companies.conf`, written by `routes`).
  Sign-in (`/api/auth/`) and company management (`/api/workspaces/`) stay on the main API.
- An admin of the main company is admin in every company. Anybody else is added on the
  Users screen while that company is open (`workspace_members`). An account with role
  "No access" in the main company works only in the companies it was added to.

## Add a company

On the **Companies** screen (main-company admins): Add new company → name, sector, short
name. The `company-brain-workspaces.timer` creates it within a minute and it appears in
the company menu. From the command line instead:

```bash
cd /srv/company-brain
sudo .venv/bin/python deploy/tenancy/tenantctl.py create <slug> "<Company name>" --sector NBFC
```

- `slug`: 2–24 lowercase letters or digits, starting with a letter. Used inside the
  system only (schema, service, Linux user), never as an address.
- Then fill in **Company Setup** with that company open, and run its applicability:

```bash
sudo .venv/bin/python deploy/tenancy/tenantctl.py run <slug> materialise_applicability.py --apply
sudo .venv/bin/python deploy/tenancy/tenantctl.py run <slug> materialise_cri.py --apply
```

`run` executes any `scraper/*.py` script as that company. It sees only that company's
data and the shared library.

## Once per server

```bash
sudo .venv/bin/python deploy/tenancy/tenantctl.py setup-routing /etc/nginx/sites-enabled/<site serving the app>...
```

Creates `CB_GATE_SECRET` (in `/etc/company-brain/env`, inherited by every company), the
nginx snippet and an empty company map, and includes the snippet beside each site's
`location /api/`. nginx is tested before reload; a refused change is put back.

## Check, update, remove

```bash
tenantctl.py list                 # every workspace, its name and user count
tenantctl.py check  <slug>        # isolation proof; every list must be empty
tenantctl.py sync   <slug>        # after a release that added company tables or columns
tenantctl.py remove <slug> --yes  # deletes the workspace and ALL its data
tenantctl.py routes               # rewrite the nginx company map from the env files
```

`check` must show `readable_first_company_tables: []`. That is the database itself
refusing the workspace any other company's tables.

## How the separation works

`scraper/regulatory_ingestion/tenancy.py` lists every table as **company** or
**library**. A workspace's schema holds empty copies of the company tables. Its role's
search path is `co_<slug>, public`, so the same SQL finds the company's own tables first
and the shared library second. The role is granted only the listed library tables. A
table nobody classified is refused, not shared, and `check` names it.

- `regulations` is shared but stores three values worked out from one company's profile
  (applicability, impact score and level). Each workspace keeps those in its own
  `regulation_state` table behind a `regulations` view, so verdicts never cross companies.
- AI search: each workspace's company passages live in its own table. Regulation
  passages, including uploads, are shared.
- Uploaded files go to `/srv/company-brain/companies/<slug>/`.
- `pgdb.py` skips runtime schema changes to library tables in a workspace process, so
  module start-up never creates an empty copy of a shared table inside a company schema.

## When code changes

- **New company table:** add it to `COMPANY_TABLES` in `tenancy.py`, deploy, restart
  the main service (it creates the table in `public`), then `tenantctl.py sync <slug>`
  for each workspace and restart `company-brain@<slug>`.
- **New library table:** add it to `LIBRARY_TABLES` and run `sync` (it re-grants).
- **Restart everything:** `systemctl restart company-brain 'company-brain@*'`.
