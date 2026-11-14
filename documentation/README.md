# Board Game Olympics — Developer Guide

An invitation-only event site for an annual board game gathering: registration, country claims, and a message board. Static HTML/CSS/vanilla JS on Cloudflare Pages, with Supabase for the database, auth, storage and email.

This project sits untouched for up to a year at a time. Start here, then read:

| Doc | What it's for |
|-----|---------------|
| [`SPEC.md`](./SPEC.md) | What the app does: the source of truth |
| [`ISSUES.md`](./ISSUES.md) | What's built, in progress, and next |
| [`DECISIONS.md`](./DECISIONS.md) | Why things are the way they are (ADRs) |
| [`SETUP_SUPABASE.md`](./SETUP_SUPABASE.md) | Supabase project, auth, storage, SMTP |
| [`SETUP_CLOUDFLARE.md`](./SETUP_CLOUDFLARE.md) | Hosting, domain, deploys |
| [`COLORS.md`](./COLORS.md) | Theme colour tokens |
| [`SEED_DATA_2025.md`](./SEED_DATA_2025.md) | Test data for the dev database |
| [`CONTENT_CHECKLIST.md`](./CONTENT_CHECKLIST.md) | Copy and art still to be supplied |

---

## Requirements

- **Python 3** for the local web server and test server. macOS ships with it.
- **Google Chrome** for headless test runs.
- **git.**
- **PostgreSQL command-line tools** (optional), to run the SQL tests locally: `brew install postgresql@17`. They are a development tool only; neither the site nor the database depends on them (ADR-013).

There is no npm, no Node, no bundler and no build step (ADR-001, ADR-005). The only third-party code is the Supabase JS client, loaded from a CDN and pinned to an exact version (ADR-006).

## Repository layout

```
public/          Everything the browser loads. Cloudflare Pages serves only this folder (ADR-003).
  index.html     The single page: landing page when logged out, dashboard when logged in.
  config.js      Your Supabase settings (gitignored; see below).
  js/  css/  assets/
db/              SQL: migrations/ (the schema, applied in order) and seed/ (seed data, from ISSUE-005).
tests/           Test harness, test page, and tests: js/, db/, deploy/.
scripts/         Deploy helpers (from ISSUE-030).
documentation/   You are here.
```

Site code uses **relative paths only** (no leading `/`), so the site works at `/` in production and at `/public/` locally. A test enforces this.

---

## Local development

1. **Configure Supabase** (once):
   ```sh
   cp public/config.example.js public/config.js
   ```
   Fill in the **dev** project's URL and publishable key (`sb_publishable_…`). The dashboard's **Connect** button shows both; see [SETUP_SUPABASE.md Step 3](./SETUP_SUPABASE.md#step-3-get-your-api-keys). `config.js` is gitignored. Never put a secret key (`sb_secret_…`) or a legacy `anon`/`service_role` key in it.

2. **Serve the repo root** (ES modules don't load from `file://`):
   ```sh
   python3 -m http.server 8000
   ```

3. Open the site at **http://localhost:8000/public/**.

Until the app is built out (ISSUE-009 onward), the page only shows "Loading…".

---

## Running tests

Tests are written **before** the code they test (see the Tests section of each issue in ISSUES.md). The suite must pass before any PR.

### JavaScript tests (browser)

Headless, from anywhere in the repo:

```sh
tests/run.sh
```

It prints every test and a `PASS — n/n tests passed` or `FAIL — …` summary. The exit code is 0 on pass, 1 on failure, crash or timeout, and 2 if Chrome or Python is missing. Options: `CHROME_BIN=/path/to/chrome` and `TEST_TIMEOUT_S=300`.

In a normal browser (handy for debugging with DevTools): serve the repo root as above and open **http://localhost:8000/tests/**.

How it works: `tests/run.sh` starts `tests/server.py` (Python standard library), opens `tests/index.html?report` in headless Chrome, and waits in real time for the page to POST its results back. See ADR-001 for why it doesn't use Chrome's `--dump-dom`.

**Adding a test file:**

1. Create `tests/js/test_###_description.js`. Use the issue number, and see the header of `tests/harness.js` for the API (`describe`, `it`, `assert`, `assertEqual`, `assertThrows`, `assertRejects`).
2. Add its path to `TEST_MODULES` in `tests/index.html`. A missing or broken module shows up as a failed test, never a silent skip.
3. Import app code from `../../public/js/…`. The test page sets `data-test-page`, so importing `app.js` doesn't start the app.

Rules:
- Tests run one at a time.
- Clean up any DOM, cookies or storage you touch.
- **Never call Supabase or any external service**: use fakes. Reading repo files from the local server with `fetch` is fine.

### Database tests (SQL)

SQL tests live in `tests/db/test_###_*.sql`. Each file:

- wraps everything in `begin; … rollback;`, so it leaves no trace and is safe to re-run;
- checks expectations with PL/pgSQL `ASSERT` inside `do $$ … $$` blocks, and expects errors with a small `pg_temp.expect_error(label, sql, sqlstate)` helper defined at the top of the file;
- simulates signed-in users by inserting throwaway `auth.users` rows and setting `request.jwt.claims`, which is what `auth.uid()` reads.

There are two ways to run them.

**Locally (fast, for development).** This needs the PostgreSQL tools (see Requirements):

```sh
tests/db/run_local.sh                                 # every tests/db/test_*.sql
tests/db/run_local.sh tests/db/test_002_schema.sql    # just one
```

It creates a throwaway Postgres (Unix socket only, nothing on the network) and applies `tests/db/supabase_stub.sql`, a minimal stand-in for Supabase's roles, `auth.users` and `auth.uid()`. Then it applies every migration **twice** (to prove they're safe to re-run), applies any seed files, runs the tests, prints `PASS`/`FAIL`, and deletes the database. A run takes a second or two. Exit codes: 0 pass, 1 failure, 2 setup problem. Set `PG_BIN` if the tools aren't in the Homebrew location.

**In Supabase (the real check, before merging).** Run against the **dev** project. **Never run tests against production.**

1. Apply the migrations first (see Applying migrations below).
2. Open the dev project in the Supabase dashboard and go to **SQL Editor** → **New query**.
3. Paste the whole test file and click **Run**.
4. **Pass:** no error ("Success. No rows returned").
   **Fail:** an error whose message starts with the `[label]` of the failed check.

The stub only imitates Supabase, so the Supabase run is what counts. If the two ever disagree, fix the stub.

`psql` against Supabase works too, if you prefer it to the dashboard: `psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/<file>.sql`. Use the direct connection string under Project Settings → Database, and keep it out of the repo.

**Writing a SQL test:**

- Copy the helper block from the top of an existing test file, so each file can still be pasted on its own.
- Start every assertion message with a `[label]`, so a failure points straight at the check.
- Use emails at `example.test` (a reserved domain) with a per-file prefix such as `t002-`, so test rows never collide with real or seeded users. Never assume a table is empty.
- Wrap destructive checks (deleting rows other tests rely on) in `savepoint …; … rollback to savepoint …;`.
- Add the new file to the Tests section of its issue in ISSUES.md.

### Applying migrations

The schema lives in `db/migrations/` as numbered files (`001_schema.sql`, `002_…`). To set up a Supabase project, paste each file into **SQL Editor** → **New query** and click **Run**, in number order. Each file runs in one transaction, so it applies completely or not at all. Re-running one is harmless.

To change the schema later, **add a new numbered migration**. Never edit one that has already been applied to production, because production would never see the change. Write the SQL test first, then check it passes with `tests/db/run_local.sh` before trying it on dev.

---

## Upgrading the Supabase JS client

`public/index.html` loads one exact version with a Subresource Integrity hash (ADR-006). The browser refuses the file if its contents ever change. To upgrade:

1. Choose a version on npm that's at least two weeks old (`@supabase/supabase-js`) and read its changelog for breaking changes.
2. Compute the new hash:
   ```sh
   V=2.118.0   # the version you chose
   curl -fsS "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@$V/dist/umd/supabase.js" \
     | openssl dgst -sha384 -binary | openssl base64 -A; echo
   ```
3. In `public/index.html`, update the version in the script `src` and set `integrity="sha384-<hash>"`.
4. Run `tests/run.sh`, then click through login on dev before deploying.

---

## Deploying

Pushing to `master` deploys automatically through Cloudflare Pages:

- **Build command:** `sh scripts/write-config.sh`. It writes `public/config.js` from the Pages environment variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
- **Output directory:** `public/`.

Full setup is in [`SETUP_CLOUDFLARE.md`](./SETUP_CLOUDFLARE.md) and ADR-003. ISSUE-030 sets this up.

## Workflow

- Every change is an issue in ISSUES.md. One branch per issue, `issue/###-short-description`, cut from `master`.
- Commits look like `[ISSUE-###] What this commit does`.
- PRs target `master`. The Boss reviews and merges.

## Placeholder content

`meeple.svg`, `default-avatar.png`, `logo-small.png` and `favicon.ico` in `public/assets/` are placeholders made for development. Replace them, and the placeholder copy, as items in [`CONTENT_CHECKLIST.md`](./CONTENT_CHECKLIST.md) are delivered.
