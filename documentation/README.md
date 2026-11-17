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
db/              SQL: migrations/ (the schema, applied in order) and seed/ (the admin everywhere; 2025 test data on dev only).
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

Until the app is built out (ISSUE-009 onward), the page shows only the header, with its theme toggle, and "Loading…". If it shows **"Board Game Olympics can't start"** instead, `config.js` is missing or wrong; the box says what to fix (see [Supabase client and sessions](#supabase-client-and-sessions)).

---

## Running tests

Tests are written **before** the code they test (see the Tests section of each issue in ISSUES.md). The suite must pass before any PR.

### JavaScript tests (browser)

Headless, from anywhere in the repo:

```sh
tests/run.sh
```

It runs the whole suite three times: in your machine's time zone, then at UTC+14 and at UTC−12 (ADR-022). Date code that depends on where it runs gets a day wrong in at least one of them. The first run prints every test; the other two print only failures. Each run ends with a summary such as `PASS — n/n tests passed [time zone: Pacific/Kiritimati]` or `FAIL — …`. The exit code is 0 only if all three runs pass, 1 on any failure, crash or timeout, and 2 if Chrome or Python is missing. Options: `CHROME_BIN=/path/to/chrome` and `TEST_TIMEOUT_S=300` (per run).

To debug a test that fails in only one zone, start a separate Chrome in that zone (with the repo root served as above):

```sh
TZ=Etc/GMT+12 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$(mktemp -d)" http://localhost:8000/tests/
```

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

It creates a throwaway Postgres (Unix socket only, nothing on the network) and applies `tests/db/supabase_stub.sql`, a minimal stand-in for Supabase's roles, `auth.users`, `auth.uid()` and the `storage` tables. Its `flags` bucket starts out private and unlimited, as if it had been made by hand, so every run checks that `003_storage.sql` corrects an existing bucket. Then it applies every migration **twice** (to prove they're safe to re-run), applies the seed files twice (to prove a re-run duplicates nothing), runs the tests, prints `PASS`/`FAIL`, and deletes the database. A run takes a second or two. Exit codes: 0 pass, 1 failure, 2 setup problem. Set `PG_BIN` if the tools aren't in the Homebrew location.

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
- Don't create tables in a test file, not even temporary ones. The Supabase SQL Editor flags any `CREATE TABLE` without RLS and offers a fix that breaks the script. To share ids between `do` blocks, store them in transaction-local settings with `set_config('t###.name', value, true)`, like the `remember`/`fx` helpers in `test_003_rls.sql`.
- To test what an API caller may do, copy the helpers at the top of `tests/db/test_003_rls.sql`. `exec_as`, `value_as`, `expect_rows` and `expect_error_as` run one statement the way PostgREST would, as `anon` or as a signed-in `authenticated` user, then switch back to `postgres`. A refused GRANT and a row rejected by a policy both raise SQLSTATE `42501`. A blocked UPDATE or DELETE raises nothing and affects 0 rows, so assert the row count.
- **Storage tests** (`test_004_storage.sql`) simulate Storage API calls as SQL on `storage.objects`: an upload is an INSERT of `(bucket_id, name)` and a removal is a DELETE. Only metadata rows are created, never files. Supabase refuses DELETE on storage tables unless the transaction sets `storage.allow_delete_query = 'true'`, as the Storage API does, so the test sets it at the top. Never delete storage rows by SQL outside a rolled-back test, because that orphans the files.
- **UPDATE and DELETE policies hide behind SELECT.** Postgres also applies a table's SELECT policy to an UPDATE or DELETE whose WHERE or RETURNING reads a column. A check like `delete … where id = …` therefore passes even if the DELETE policy is broken, as long as the SELECT policy is right. To check the UPDATE or DELETE policy on its own, use a statement with no WHERE that reads no column (`delete from t`, `update t set c = 'constant'`), inside a savepoint you roll back straight away. See `[policy-alone]` in `test_004_storage.sql`.
- Add the new file to the Tests section of its issue in ISSUES.md.

### Applying migrations

The schema lives in `db/migrations/` as numbered files (`001_schema.sql`, `002_…`). To set up a Supabase project, paste each file into **SQL Editor** → **New query** and click **Run**, in number order. Each file runs in one transaction, so it applies completely or not at all. Re-running one is harmless.

To change the schema later, **add a new numbered migration**. Never edit one that has already been applied to production, because production would never see the change. Write the SQL test first, then check it passes with `tests/db/run_local.sh` before trying it on dev.

### Seed data

After the migrations, apply `db/seed/` in number order: `001_admin.sql` on every project, and `002_test_data_2025.sql` on **dev only**. Step 7 of [SETUP_SUPABASE.md](./SETUP_SUPABASE.md) has the details.

Seeds follow one rule ([ADR-019](./DECISIONS.md)): **add what's missing, never change or delete an existing row**. That way they're safe to re-run on a dev database that's in use. A new seed must follow the rule too. `run_local.sh` applies the seeds twice, so a seed that duplicates rows fails the exact counts in `test_005_seed.sql`.

To change the 2025 test data, change these three together:
- `SEED_DATA_2025.md`;
- `002_test_data_2025.sql`;
- the expected data at the top of `test_005_seed.sql`.

The test keeps its own copy on purpose, so a typo in one copy fails the test.

---

## Colours and themes

There are two themes: light, and dark ("Game Night Mode"). Their colours are CSS custom properties defined once, at the top of `public/css/styles.css`. Everything else uses `var(--token)` (ADR-020).

- **To change a colour:** change [`COLORS.md`](./COLORS.md) first, then the same token in `styles.css`. `tests/js/test_006_theme.js` fails if the two disagree, or if a hex colour appears anywhere outside the two token blocks.
- **How the theme is chosen:** a saved choice (localStorage key `theme`), otherwise the OS setting, which is followed live until the toggle is first clicked.
- **To go back to following the OS:** delete the `theme` key in the browser's dev tools (Application → Local Storage) and reload.
- **The inline script in `index.html`'s `<head>`** repeats `resolveTheme()` from `public/js/theme.js`, because it must run before the first paint. Keep the two in sync; the test runs the inline script and compares. Editing it also changes the hash production's Content-Security-Policy allows (ISSUE-030).

---

## Supabase client and sessions

`public/js/supabase.js` creates the app's one Supabase client (ADR-021). Get it with `getSupabase()`; never call `supabase.createClient()` anywhere else.

- **Where the session lives:** in cookies, not localStorage, so it survives browser restarts. They're named `sb-<project-ref>-auth-token`, or `…-auth-token.0`, `.1`, … when the session is too big for one cookie. To inspect them or sign out by hand, open DevTools → Application → Cookies.
- **How long it lasts:** the cookies are set for a year, and every visit renews them. Safari cuts cookies set from JavaScript to 7 days, so a Safari user who stays away longer than that signs in again.
- **If cookies are blocked:** signing in still works, but only until the page is closed or reloaded. The console shows a "Session storage" warning.
- **Auth flow:** implicit, not PKCE, so a magic link works even when opened in a different browser or a mail app's built-in browser.

**"Board Game Olympics can't start"** means the client couldn't be created. The box lists each problem; the same text goes to the console. The usual causes:

| Message mentions | Fix |
|------------------|-----|
| `config.js didn't load` | Locally: `cp public/config.example.js public/config.js` and fill it in. On Pages: check the build command is `sh scripts/write-config.sh`. |
| `placeholder` | `config.js` was copied but not filled in. Use the values from the dashboard's **Connect** button. |
| `SECRET key` | A `sb_secret_…` key is in `config.js`. Replace it with the publishable key, and if it was ever deployed, revoke it in the dashboard (Project Settings → API Keys). |
| `legacy anon or service_role key` / `not a publishable key` | Use the `sb_publishable_…` key (ADR-014). |
| `https://` | `SUPABASE_URL` must be the `https://…supabase.co` project URL. |
| `cdn.jsdelivr.net` | The Supabase library didn't load: offline, blocked by a content blocker, or `index.html`'s version and integrity hash don't match (see below). |

---

## Shared UI helpers

`public/js/util.js` (ADR-022) holds what the feed, message board, sidebar and admin all need. Use these rather than writing your own:

| Need | Use |
|------|-----|
| Put database text into an HTML string | `escapeHtml(text)`, or set `textContent` |
| "5 minutes ago", "yesterday", "Feb 8" | `formatRelativeTime(row.created_at)` |
| The full date and time, for hover text | `formatFullTimestamp(row.created_at)` |
| The event date, "Saturday, February 15, 2025" | `formatEventDate(settings.event_date)`. Never `new Date('2025-02-15')`: that's the day before in the Americas. |
| A member's picture | `avatarUrl(user.flag_url)`: their flag, or the default avatar |
| Newest-first pages of 20 | `applyKeysetPage(query, { after: lastRow })` |
| Load more on scroll | `createInfiniteScroll({ sentinel, loadBatch, renderBatch })` |

A list with infinite scroll looks like this:

```js
const scroller = createInfiniteScroll({
  sentinel,   // an empty element right after the list; it also shows "Loading…", errors and "Try again"
  loadBatch: async (lastRow, batchSize) => {
    const query = client.from('messages').select('id,text,created_at').eq('event_year', year);
    const { data, error } = await applyKeysetPage(query, { after: lastRow, limit: batchSize });
    if (error) throw error;  // shown with a Try again button
    return data;
  },
  renderBatch: (rows) => list.append(...rows.map(renderMessage)),
  text: { empty: 'No messages yet.' },
});
scroller.start();
// When leaving the view: scroller.destroy();
```

Timestamps must be passed exactly as Supabase returns them. They're ISO strings with microseconds, and the pager needs those microseconds to avoid skipping or repeating rows.

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
