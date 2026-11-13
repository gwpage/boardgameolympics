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

There is no npm, no Node, no bundler and no build step (ADR-001, ADR-005). The only third-party code is the Supabase JS client, loaded from a CDN and pinned to an exact version (ADR-006).

## Repository layout

```
public/          Everything the browser loads. Cloudflare Pages serves only this folder (ADR-003).
  index.html     The single page: landing page when logged out, dashboard when logged in.
  config.js      Your Supabase settings (gitignored; see below).
  js/  css/  assets/
db/              SQL migrations and seed data (from ISSUE-002).
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
   Fill in the **dev** project's URL and anon key, from the Supabase dashboard: Project Settings → API. `config.js` is gitignored. Never put the `service_role` key in it.

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

SQL tests live in `tests/db/test_###_*.sql` and run against the **dev** Supabase project. **Never run them against production.** Each file:

- wraps everything in `begin; … rollback;`, so it leaves no trace;
- checks expectations with PL/pgSQL `ASSERT` inside `do $$ … $$` blocks;
- simulates users with `set local role authenticated` plus `set local request.jwt.claims = '…'`.

To run one:

1. Apply the migrations first (see `db/`, from ISSUE-002).
2. Open the dev project in the Supabase dashboard and go to **SQL Editor** → **New query**.
3. Paste the whole test file and click **Run**.
4. **Pass:** no error ("Success. No rows returned").
   **Fail:** an error naming the failed `ASSERT`.

`psql` isn't required. If you install it later (`brew install libpq`), the same files run unchanged with `psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/<file>.sql`.

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

- **Build command:** `sh scripts/write-config.sh`. It writes `public/config.js` from the Pages environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- **Output directory:** `public/`.

Full setup is in [`SETUP_CLOUDFLARE.md`](./SETUP_CLOUDFLARE.md) and ADR-003. ISSUE-030 sets this up.

## Workflow

- Every change is an issue in ISSUES.md. One branch per issue, `issue/###-short-description`, cut from `master`.
- Commits look like `[ISSUE-###] What this commit does`.
- PRs target `master`. The Boss reviews and merges.

## Placeholder content

`meeple.svg`, `default-avatar.png`, `logo-small.png` and `favicon.ico` in `public/assets/` are placeholders made for development. Replace them, and the placeholder copy, as items in [`CONTENT_CHECKLIST.md`](./CONTENT_CHECKLIST.md) are delivered.
