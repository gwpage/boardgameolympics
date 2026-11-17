# Architecture Decision Records

Non-obvious design decisions for Board Game Olympics, newest last. Each record says *why*, so whoever picks this up next year doesn't have to rediscover it.

Format: `~/.claude/rules/quality.md`. Open work that implements these lives in [`ISSUES.md`](./ISSUES.md).

---

## [ADR-001] Zero-dependency browser test harness + SQL ASSERT scripts

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** The development rules require tests to be written before implementation, and a passing suite before every PR. The spec forbids frameworks, npm, and build steps. The development machine has no Node, Deno, or psql installed, only Python 3 and Chrome. The app code is browser JavaScript that depends on the DOM, `document.cookie`, and image decoding, none of which Node provides without a third-party shim such as jsdom.
- **Decision:**
  - **JS tests** are ES modules in `tests/js/test_###_*.js`. They import source from `public/js/` and run in a real browser via a small hand-written harness: `tests/harness.js` (describe/it/assert, async support) and `tests/index.html` (registry and reporter).
  - **Headless runs:** `tests/run.sh` starts `tests/server.py`, a Python-stdlib static server, and opens `tests/index.html?report` in headless Chrome with a throwaway profile. The page POSTs its JSON results to the server, and `run.sh` waits for them **in real time**, then prints the report and exits non-zero on any failure, crash, or timeout. Chrome's `--dump-dom` was tried first: it only waits for async tests with `--virtual-time-budget`, and virtual time fast-forwards timers while work happens off the main thread. Image-decoding tests then timed out at random (amended 2026-11-13 during ISSUE-001).
  - **Isolation:** tests never touch the network; Supabase is replaced with fakes.
  - **DB tests** are plain SQL in `tests/db/test_###_*.sql`. Each wraps its assertions in `begin; … rollback;` using PL/pgSQL `ASSERT`, and simulates roles with `set local role` and `request.jwt.claims`. They are pasted into the Supabase SQL Editor and run against the **dev** project only.
  - **Deploy tests** (`tests/deploy/*.sh`) use only `bash` and `curl`.
- **Consequences:**
  - Nothing to install, and nothing to keep updated between yearly events.
  - Tests exercise the real browser runtime, so cookie, DOM, and image-decoding behaviour is genuinely tested.
  - Headless runs need Chrome (`CHROME_BIN` overrides its path). A full run takes a couple of seconds.
  - Every test file must be listed in the registry in `tests/index.html`. A missing or broken module is reported as a failed test, never silently skipped.
  - SQL tests are run by hand in the dashboard. That's acceptable at this project's size; `psql` can be added later without changing the test files. (Amended 2026-11-14: they can also run against a throwaway local Postgres, see ADR-013. The dashboard run on dev is still the acceptance check.)
  - There is no CI test run. The suite is run locally before each PR.

---

## [ADR-002] Invitations via a Supabase Edge Function; bulk emails via `mailto:`

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** The spec says invitations, RSVP follow-ups, and event reminders are all sent "via Supabase using Gmail SMTP". Supabase's custom SMTP setting, however, is only used by **Supabase Auth** for magic links, confirmations, and its built-in invite email. A static site has no way to send arbitrary email. Inviting a user through Auth requires a secret key (formerly the `service_role` key), which must never reach the browser. Supabase Edge Functions block outbound SMTP on ports 25 and 587, so hand-rolling Gmail SMTP inside a function isn't dependable.
- **Decision:**
  - **Invitations:** an `invite-user` Edge Function, deployed from the Supabase dashboard editor with no CLI, handles them.
    - It verifies that the caller's JWT belongs to an active admin.
    - It calls `auth.admin.inviteUserByEmail` with a redirect URL that carries the invite token.
    - Supabase then sends the Invite template through the configured Gmail SMTP.
    - The secret key (`sb_secret_…`) is read from the function's built-in `SUPABASE_SECRET_KEYS` environment variable and never leaves the server. (Amended 2026-11-14: originally the legacy `service_role` key, see ADR-014.) The function source is committed under `supabase/functions/invite-user/` as the reference copy.
  - **Bulk emails:** RSVP follow-ups and event reminders are built in the admin panel as a `mailto:` link, with recipients in BCC and the subject and body prefilled and editable. It opens the admin's own mail app, and the admin clicks Send. If the link exceeds safe URL length, the panel offers "copy recipients" and "copy body" instead.
- **Consequences:**
  - No new services or accounts. Invitations are sent automatically, as the spec requires.
  - Bulk sends stay manual, also as the spec requires, and go out from the admin's real Gmail.
  - `inviteUserByEmail` fails for emails that already have an Auth account. Returning users from previous years get no invite email; after **Start New Year** they are all `no_response`, so the RSVP follow-up serves as their annual invitation.
  - Supabase invite links are short-lived (≤24 h). Expiry is harmless, because membership is also granted when an invited email signs in later by Google, Facebook, or magic link.
  - The spec's Email section has been updated to match.

---

## [ADR-003] Site files under `public/` with a deploy-time `config.js`

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** The spec keeps Supabase settings in a gitignored `config.js` and auto-deploys from GitHub to Cloudflare Pages with no build step. Those two conflict: a git-based deploy never sees the gitignored file, so production would have no config. Separately, using the repo root as the Pages output directory would publicly serve `documentation/`, `db/`, `tests/`, and `scripts/`.
- **Decision:**
  - **Layout:** everything the browser loads lives in `public/` (`index.html`, `config.example.js`, `css/`, `js/`, `assets/`). Repo-only material stays at the root.
  - **Pages settings:**
    - Build command: `sh scripts/write-config.sh`, a few lines of POSIX shell with no npm.
    - Build output directory: `public/`.
    - Environment variables: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. (Amended 2026-11-14: originally `SUPABASE_ANON_KEY`, see ADR-014.)
  - **Config writer:** the script writes `public/config.js` and fails the build if either variable is missing.
  - **Local dev:** copy `public/config.example.js` to `public/config.js`. The existing `.gitignore` pattern `config.js` covers that path.
  - **Paths:** site code uses only relative paths, so it works at `/` in production and at `/public/` on a local server rooted at the repo. The test page needs the repo root as its server root to import `../public/js/*`.
- **Consequences:**
  - Keys stay out of git, push-to-deploy still works, and only site files are publicly served.
  - There is technically a "build command", but it only writes one file: no bundling, transpiling, or dependencies.
  - Root-absolute URLs (`/css/…`) are not allowed in site code; ISSUE-001 adds a test for this.
  - The spec's Configuration and Project Structure sections have been updated to match.

---

## [ADR-004] GitHub Actions keep-alive ping for the free-tier Supabase project

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** Supabase pauses free-tier projects after 7 days without API traffic. Board Game Olympics is busy for one or two months a year and idle the rest, so without intervention the first visitor each season would see errors until the project is restored by hand. The spec rules out Cloudflare Workers and aims for free tiers.
- **Decision:**
  - `.github/workflows/keepalive.yml` runs on a schedule every 3 days, and on demand via `workflow_dispatch`.
  - It `curl`s the anonymous `get_public_event_info` RPC using `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, stored as repo secrets. The key goes in the `apikey` header only. (Amended 2026-11-14: originally `SUPABASE_ANON_KEY`, see ADR-014.)
  - A failed request fails the workflow, and GitHub emails the repo owner.
- **Consequences:**
  - Free, no code dependencies, and failures are visible.
  - The repository is **public**, and GitHub disables scheduled workflows in public repos after 60 days without repository activity. Between events the Boss will get an email roughly 2–3 times a year and must re-enable the workflow: Actions → keepalive → Enable workflow, then Run workflow once. This procedure is documented in SETUP_SUPABASE.md (ISSUE-031).
  - If the re-enable chore becomes annoying, the options are to make the repo private (the 60-day rule doesn't apply there) or to upgrade to Supabase Pro for the season.

---

## [ADR-005] Native ES modules with no build step; classic scripts only for globals

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** The spec rules out frameworks, bundlers and transpilation, and wants one JS file per feature. Functions have to be importable by the browser test page (ADR-001) without starting the app. Two pieces of setup must exist before any app code runs: the Supabase settings (`config.js`) and the Supabase client (a CDN bundle that defines a global).
- **Decision:**
  - App code in `public/js/` is native ES modules. `index.html` loads `js/app.js` with `<script type="module">`, and `app.js` imports the other feature modules.
  - `config.js` (defines the global `CONFIG`) and the Supabase UMD bundle (defines the global `supabase`) stay **classic** scripts with `defer`, placed before the module. Deferred classic scripts and module scripts run in document order, so both globals exist when `app.js` runs.
  - The theme bootstrap stays a small inline classic script in `<head>`, so the right theme paints first (COLORS.md).
  - `app.js` only calls `boot()` when the page is **not** marked `data-test-page`. The test page sets that attribute, so importing app modules never starts the real app.
- **Consequences:**
  - Zero tooling; what's in the repo is exactly what runs.
  - ES modules don't load from `file://`, so local development needs a static server (`python3 -m http.server`).
  - Each module is a separate request. That's negligible at this app's size, and Cloudflare serves them over HTTP/2.
  - Requires a modern evergreen browser (ES modules, top-level await in tests). This is acceptable for an invite-only site.

---

## [ADR-006] Supabase JS client pinned to an exact version with Subresource Integrity

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** The spec loads the Supabase JS client from a CDN. It is the project's only third-party code. A floating tag like `@2` could change behaviour under the app at any time, which is risky for a site that sits untouched for months. Separately, a compromised or altered CDN file would run with full access to users' sessions.
- **Decision:**
  - Load the UMD bundle from jsDelivr pinned to **`@supabase/supabase-js@2.118.0`** (published 2026-10-15; at least two weeks old when chosen): `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js`.
  - Add `integrity="sha384-…"` and `crossorigin="anonymous"`. jsDelivr sends `Access-Control-Allow-Origin: *`, so the integrity check works.
  - Upgrades are deliberate: follow the procedure in README.md (pick a version, recompute the hash, run the tests, check login on dev).
- **Consequences:**
  - The client never changes unless someone edits `index.html`. If the file's bytes ever change, the browser refuses to run it, and login fails loudly instead of running unknown code.
  - If jsDelivr is unreachable, the app can't talk to Supabase. That's accepted; vendoring a copy into `public/` is the fallback if it ever becomes a problem.
  - The production Content-Security-Policy (ISSUE-030) must allow `https://cdn.jsdelivr.net`.
  - A scaffold test checks that the URL is pinned to an exact `x.y.z` version and carries a sha384 hash.

---

## [ADR-007] User profiles are independent of Supabase Auth accounts

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** The spec has the admin "register a user on their behalf" for people who can't sign in themselves. It also seeds the admin and 20 test users who have never logged in. A Supabase Auth account (`auth.users`) only exists once someone signs in or is invited by email. If `users.id` were the Auth id, none of those profiles could exist (assumption A1).
- **Decision:**
  - `public.users.id` is the profile's own UUID.
  - `users.auth_user_id` is nullable and unique, and references `auth.users(id)` with `on delete set null`.
  - A profile is linked on sign-in by matching the sign-in email to `users.email`, ignoring case (`claim_membership`, ISSUE-012).
  - RLS policies and RPCs identify the caller with `current_member_id()`, which maps `auth.uid()` to the active profile's id. They never compare a row's owner with `auth.uid()` directly.
- **Consequences:**
  - Seeded and admin-created profiles work, and are claimed automatically the first time their owner signs in with that email.
  - Emails must be unique ignoring case, enforced by the unique index on `lower(email)`.
  - One Auth account maps to at most one profile.
  - Deleting an Auth account from the dashboard unlinks the profile instead of deleting it, so the person can sign in again and be re-linked.
  - Every ownership check goes through `current_member_id()`. A policy that compares `user_id` with `auth.uid()` is a bug.

---

## [ADR-008] Yearly archive via `event_year` and `current_event_year()`

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** "Start New Year" must hide the previous year's messages, country claims and invitations while keeping them in the database. The spec's data model has no year marker (assumption A2).
- **Decision:**
  - `messages`, `country_claims` and `invitations` have `event_year integer not null`, defaulting to `current_event_year()`.
  - `current_event_year()` is the highest `event_settings.year`.
  - On a fresh install, before any `event_settings` row exists, it falls back to the calendar year, so rows always get a year.
  - `event_year` is deliberately not a foreign key, so posting doesn't depend on a settings row existing.
  - Likes need no year of their own; they belong to their message.
  - The UI and RLS policies show only the current year.
- **Consequences:**
  - Start New Year (ISSUE-028) inserts one `event_settings` row and resets profiles. Nothing is moved, copied or deleted, and the archive stays queryable by year.
  - Rows created before the first settings row are stamped with the calendar year. If the admin then creates settings for a different year, those early rows become "archived". That can only happen on a fresh install. ISSUE-030's production checklist has the admin set the event date (creating the first settings row) before inviting anyone.
  - ISSUE-003's insert policies must require `event_year = current_event_year()`. Otherwise a client could post into a past or future year.

---

## [ADR-009] Invitations: `revoked` status, multi-use links, database-generated tokens

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** The spec wants revocable invitations and "one-time-use (or limited-use)" links, but its model has only `pending`/`accepted` and no use count (assumption A3). Link tokens are the only thing standing between the public and registration, so they must be unguessable.
- **Decision:**
  - `status` also allows `revoked`, with `revoked_at` set exactly when the status is `revoked`.
  - `max_uses` defaults to 1 and is always 1 for email invitations. `use_count` runs from 0 to `max_uses`.
  - Status becomes `accepted` when `use_count` reaches `max_uses`. `accepted_at` records the first use.
  - The token is generated by the column default, never in the browser: two v4 UUIDs concatenated without hyphens. That gives 64 lowercase hex characters carrying 244 bits from Postgres's cryptographic RNG. A CHECK constraint enforces the format.
- **Consequences:**
  - No `pgcrypto` extension is needed: `gen_random_uuid()` is built in and uses the server's strong random source.
  - The client can reject a malformed `?invite=` value before calling the server (`parseInviteToken`, ISSUE-012).
  - An accepted invitation can still be revoked. Removing a user does this, which frees their email for a fresh invitation (ADR-010).

---

## [ADR-010] Removing a user deactivates them; history is never deleted

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** The spec says "Remove a user: deactivates their account and frees up their invitation". Deleting the row would erase their messages, likes and claims, which the yearly archive is meant to keep (assumption A4).
- **Decision:**
  - `users.is_active` and `users.deactivated_at` change together; a CHECK keeps them consistent.
  - A deactivated user fails `is_member()` and `is_admin()`, so RLS gives them nothing. That includes a deactivated admin.
  - Removal revokes the invitation recorded in `users.invitation_id`, so the same email can be invited again (ISSUE-024).
  - Every foreign key to `users` is `on delete restrict`. A hard delete of a user with any history fails loudly instead of cascading.
- **Consequences:**
  - The admin can undo a removal by reactivating the profile.
  - The removed user's messages stay on the board. Members can no longer read the author's profile, so the board shows "Former member" (decided in ISSUE-003, ADR-017; amended 2026-11-15).
  - Tidying up test users means deactivating them, or deleting them only when they have no history.

---

## [ADR-011] Country claims are written only by a database trigger

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** The activity feed shows "Alex claimed Genovia" entries from `country_claims`. If clients could insert claims, a member could forge claims for other people or flood the feed. SETUP_SUPABASE.md originally said "users can create their own" (assumption A10).
- **Decision:**
  - An `AFTER INSERT OR UPDATE OF country` trigger on `users` inserts a claim whenever a user's country becomes a new non-null value.
  - Re-saving the same value or clearing the country records nothing.
  - The trigger function is `SECURITY DEFINER`, because no role gets an INSERT policy on `country_claims` (ISSUE-003).
  - The admin editing someone's country also records a claim.
- **Consequences:**
  - Saving a profile is one write; the claim follows automatically and always matches the profile.
  - Start New Year clears every country without creating claims.
  - Seed data with historical claim dates (ISSUE-005) inserts the user with their country, which creates the claim, then updates that claim's `claimed_at`. The seed runs as the table owner, so RLS doesn't apply.

---

## [ADR-012] Schema conventions

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** The schema will be read and changed by someone who last saw it a year ago, through the Supabase dashboard rather than an ORM. Supabase also exposes every table and function through a public API.
- **Decision:**
  - **Enumerations** are `text` columns with `CHECK (… in (…))`, not Postgres enum types. They're easier to change, and they read naturally through the API.
  - **Limits** live in CHECK constraints (listed in the header of `001_schema.sql`). The UI checks the same limits first, for friendly messages.
    - Lengths are `char_length`, i.e. Unicode code points, which match the client's code-point counting.
    - "Not blank" means the value matches `[^[:space:]]`. `btrim()` only strips spaces, so it would let newline-only text through.
  - **`flag_url` must be `https://`**, so a profile can't point other members' browsers at `javascript:`, `data:` or tracking URLs over plain http.
  - **RLS is enabled when a table is created**, with no policies, so new tables deny all API access by default.
  - **`SECURITY DEFINER` functions** use `set search_path = ''` and fully qualified names. EXECUTE is revoked from PUBLIC and `anon` (Supabase grants it by default) and granted only to the roles that need it.
  - **Migrations** are numbered and run in one transaction. They are written to be re-runnable (`if not exists`, `create or replace`, `drop trigger if exists`) and are never edited once applied to production; changes go in a new migration.
  - **`comment on`** documents every table, every function and every column the spec didn't list. The comments appear in the Supabase dashboard.
- **Consequences:**
  - Invalid data can't get in even if a client skips validation.
  - A forgotten policy fails closed: no access, rather than open access.
  - Supabase's Security Advisor will list "RLS enabled, no policy" for every table until ISSUE-003 lands. That is expected.

---

## [ADR-013] Optional local Postgres for running SQL tests

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** ADR-001 made the Supabase SQL Editor the only place SQL tests run. Each SQL mistake then cost a manual round trip through the dashboard, and tests couldn't be shown to pass before a PR. The Boss approved installing Homebrew `postgresql@17` as a development tool.
- **Decision:**
  - `tests/db/run_local.sh` creates a throwaway cluster (Unix socket only) and applies `tests/db/supabase_stub.sql`, which provides Supabase's API roles, default privileges, `auth.users` and `auth.uid()`.
  - It applies every migration **twice**, proving they can be re-run, then the seeds, then the tests.
  - Migrations and tests run as a non-superuser `postgres` role, like the SQL Editor, so permission mistakes aren't masked.
  - The stub refuses to run on a real Supabase database.
  - A passing run in the Supabase dev SQL Editor is still the acceptance check before merging.
- **Consequences:**
  - A full run takes about two seconds. That is quick enough to run constantly, and to check by deliberately breaking the migration that each test actually fails.
  - The stub can drift from real Supabase. When the two disagree, fix the stub.
  - Only the Supabase features the stub imitates can be tested locally. ISSUE-004 will extend it with the storage schema.
  - Nothing in the site or the database depends on these tools. Without them, the SQL Editor workflow from ADR-001 still works.

---

## [ADR-014] Publishable and secret API keys; legacy keys deactivated

- **Date:** 2026-11-14
- **Status:** Accepted
- **Context:** Supabase is deprecating the legacy JWT-based `anon` and `service_role` API keys "by the end of 2026". Their replacements are the publishable key (`sb_publishable_…`) and secret keys (`sb_secret_…`). Neither new key is a JWT. ADR-002, ADR-003 and ADR-004, the spec and the setup guide were all written around the legacy keys, and `config.example.js` named its key `SUPABASE_ANON_KEY`. No code read the config yet, so switching cost only renames.
- **Decision:**
  - The **browser**, the **Pages build** and the **keep-alive ping** use the publishable key. The `CONFIG` property, the Pages environment variable and the GitHub repo secret are all named `SUPABASE_PUBLISHABLE_KEY`.
  - The **`invite-user` Edge Function** reads the secret key from Supabase's built-in `SUPABASE_SECRET_KEYS` environment variable, a JSON object keyed by key name (`default`). The secret key is never copied anywhere else.
  - Hand-written HTTP calls send the key in the `apikey` header only. `Authorization: Bearer` carries only a signed-in user's access token.
  - The legacy keys are **deactivated** on both projects (SETUP_SUPABASE.md Step 3).
  - The Postgres roles are unchanged. A publishable-key request runs as `anon` when signed out and as `authenticated` when signed in. A secret-key request runs as `service_role`. RLS policies and grants need no change.
- **Consequences:**
  - Nothing breaks when Supabase removes the legacy keys.
  - A leaked secret key can be revoked on its own. Rotating the legacy `service_role` key meant rotating the JWT secret, which signed every user out.
  - Supabase's gateway check, `verify_jwt`, doesn't understand the new keys, and Supabase now recommends checking callers inside the function. The `invite-user` function has to verify the caller's access token and admin role itself anyway (ADR-002). ISSUE-022 decides the `verify_jwt` setting.
  - Supabase's docs suggest an `@supabase/server` helper for Edge Functions. It would be a new dependency, so it is adopted only if ISSUE-022 justifies it.
  - User access tokens are still signed by the legacy JWT secret. Moving to JWT signing keys is a separate migration and isn't part of this decision.

---

## [ADR-015] Explicit table grants; column-level grants hide email; admins read emails through an RPC

- **Date:** 2026-11-15
- **Status:** Accepted
- **Context:**
  - Supabase serves every table in `public` through its REST API, and the publishable key is public. GRANTs and RLS are the only security boundary.
  - ISSUE-003 assumed Supabase grants ALL on new tables to `anon` and `authenticated`. On our dev project, `information_schema.role_table_grants` showed only TRUNCATE, REFERENCES and TRIGGER for both roles, with no SELECT, INSERT, UPDATE or DELETE. Projects created at different times evidently get different defaults.
  - The spec says members "can read all profiles", but that would expose every email address (assumption A5).
  - Admins and members both run as `authenticated`. Postgres can grant a column to a role, but not to some users of a role.
- **Decision:**
  - `002_rls.sql` first **revokes all** privileges on every table from PUBLIC, `anon`, `authenticated` and `service_role`, then grants exactly what each role needs. `tests/db/test_003_rls.sql` compares the complete grant list with the expected one, so a missing or extra grant fails the test.
  - **`anon`** gets nothing on any table. Its only door is `get_public_event_info()` (ADR-016).
  - **`service_role`** (the secret key, server side only) gets SELECT, INSERT, UPDATE and DELETE on every table, but not TRUNCATE.
  - **`authenticated`** gets table-level grants where every column is fine to expose, and column-level grants where it isn't:
    - `users`: SELECT only `id, name, country, flag_url, rsvp, role, created_at`, and UPDATE only `name, country, flag_url, rsvp`. No INSERT: profiles are created by `SECURITY DEFINER` RPCs (ISSUE-012, ISSUE-024).
    - `messages` and `message_likes`: INSERT only the author/liker and content columns, so `event_year` and `created_at` always come from defaults. No UPDATE.
    - `invitations`: INSERT only `type, email, max_uses`, so the database owns the token, status, use count and year. UPDATE only `status, revoked_at`. No DELETE.
    - `event_settings`: INSERT `year, event_date, theme_title, theme_desc`. UPDATE everything except `year`. No DELETE.
    - `country_claims`: SELECT only. The trigger is the only writer (ADR-011).
  - The admin reads emails and the account-management columns through **`admin_list_users()`**, a `SECURITY DEFINER` function that raises 42501 unless `is_admin()`.
- **Consequences:**
  - The same migration gives the same result on any project, whatever its defaults, including a prod project created later.
  - A forged `event_year`, `created_at`, invitation token or use count is refused by the database, not just by the UI.
  - **Clients must name columns when reading `users`.** PostgREST's `select=*` asks for every column, and Postgres refuses the whole query. Embeds must list columns too, e.g. `author:users(id,name,flag_url)`.
  - A member's own email isn't readable from `users` either. The profile page shows the email from the Auth session (ISSUE-014).
  - Admin changes to `role`, `email`, `is_active` and links go through RPCs that can enforce rules such as "an admin can't deactivate themselves" (ISSUE-024). A plain UPDATE of those columns is refused, even for the admin.
  - Supabase's Security Advisor may flag `admin_list_users()` as a `SECURITY DEFINER` function exposed through the API. That is intended: it checks the caller itself.

---

## [ADR-016] Signed-out visitors get the event date from a narrow RPC

- **Date:** 2026-11-15
- **Status:** Accepted
- **Context:** The public landing page shows the event date, and the keep-alive ping (ADR-004) needs something anonymous to call. But `anon` can read no table (ADR-015), and opening `event_settings` to `anon` would also expose the theme and every past year (assumption A6).
- **Decision:**
  - `get_public_event_info()` returns `TABLE(year integer, event_date date)`: one row for the current event (the highest `year`), or no row before any event exists.
  - It is `SECURITY DEFINER` with an empty `search_path`, `stable`, and executable by `anon` and `authenticated` only.
  - A test pins the result type, so adding a column needs a deliberate test change.
- **Consequences:**
  - The landing page (ISSUE-010) makes exactly one anonymous call, and shows "Date TBA" on no row or an error.
  - Anything else the landing page shows (location, description) is static copy, not database data.

---

## [ADR-017] Policy model: membership gate, current-year archive, admin-only deletes, "Former member"

- **Date:** 2026-11-15
- **Status:** Accepted
- **Context:**
  - RLS must turn invitation-only access into concrete per-row rules.
  - The spec doesn't say whether members may delete their own messages (assumption A7).
  - Archived years must vanish from the app without being deleted (ADR-008).
  - A removed user's messages stay (ADR-010), but members can only see active profiles (A5).
- **Decision:**
  - **Membership gate.** Every policy starts from `is_member()` or `is_admin()`, both of which require an *active* profile linked to the caller's Auth account. Signed-in strangers and deactivated users see nothing and change nothing.
  - **Ownership** is always `… = current_member_id()`, never `auth.uid()` (ADR-007).
  - **Current year only.** `messages` and `country_claims` are readable only where `event_year = current_event_year()`, for the admin too. Likes are readable and addable only when their message is readable: the policy's `EXISTS` subquery on `messages` runs under messages' own policy. Earlier years stay in the database and are reachable only from the Supabase dashboard. Invitations aren't year-filtered (the admin sees all; the UI filters), and neither are `event_settings`, which members read for the sidebar.
  - **Deletes (A7).** Only the admin deletes messages, including a member's own. Members delete only their own likes. Nobody deletes profiles, invitations, claims or event settings through the API.
  - **Profiles.** Members read active profiles only. The admin also reads deactivated ones.
  - **Removed authors.** A message by a deactivated author stays visible to members, but joining it to `users` returns no author. The UI shows **"Former member"** with the default avatar. The admin still sees the real name.
  - Policies call helpers as `(select public.is_member())`, so Postgres evaluates each one once per statement rather than once per row.
- **Consequences:**
  - The message board, activity feed and likes need no year filter for correctness; RLS supplies it. They should still filter on `event_year` so queries use the `(event_year, created_at desc, id desc)` indexes.
  - The board (ISSUE-016) and activity feed (ISSUE-018) must use a **left** join or embed to the author, and render a null author as "Former member". An inner join would make removed users' items disappear.
  - Like counts include likes from removed users, but "who liked it" can't name them (ISSUE-017).
  - Members can't tidy up their own posts; they ask the host. That matches the spec's moderation model.

---

## [ADR-018] Flag storage: public bucket with no public SELECT policy; per-member folders keyed on profile id

- **Date:** 2026-11-15
- **Status:** Accepted
- **Context:**
  - Flags are members' avatars. Everyone who sees a message or profile must be able to load them, and the spec calls for "public read access and authenticated upload" (SPEC § File Storage).
  - The old setup guide built the bucket and its policies by clicking in the dashboard, so they couldn't be reproduced or tested. It also allowed any signed-in user to upload anywhere, and added a public SELECT policy.
  - On a public bucket, the Storage API serves public URLs with no policy check. A SELECT policy for everyone adds only the ability to **list** the bucket, which Supabase's Security Advisor warns about. The API still needs SELECT to remove or overwrite a file.
  - Storage tables belong to Supabase. The API roles hold ALL on `storage.objects`, with RLS on. The Storage API runs as those roles and depends on those grants.
  - The dev project already had a hand-made `flags` bucket when this was written.
- **Decision:**
  - `db/migrations/003_storage.sql` **upserts** the `flags` bucket as public, with `file_size_limit` 2,097,152 bytes and `allowed_mime_types` `image/jpeg` and `image/png`. Running it corrects a hand-made bucket.
  - Objects live at `{member_id}/{file}`, with the folder named after the profile id (`users.id`), not the auth id (ADR-007). Four policies (`flags_select`, `flags_insert`, `flags_update`, `flags_delete`), all `to authenticated`, apply one rule: `bucket_id = 'flags'` and either `is_admin()` or the first folder equals `current_member_id()`. UPDATE has the rule in both USING and WITH CHECK, so files can't be moved into another folder.
  - "Anyone can read" means the bucket's public URLs. Nobody gets a bucket-wide SELECT policy, so signed-out visitors and members can't list other members' files. Members can list only their own folder; the admin can list them all.
  - Grants on storage tables are left as Supabase sets them. That's an exception to ADR-015, which covers our own tables. RLS is the boundary here.
  - `test_004_storage.sql` requires that the policies on `storage.objects` are exactly these four. Postgres ORs permissive policies together, so a stray hand-made one would quietly widen access.
- **Consequences:**
  - Deactivated users and signed-in non-members can't write, even to their old folder: `current_member_id()` is null for them.
  - Flag files are public to anyone who has or guesses the URL. Paths contain a random profile id and a timestamp, and flags are meant to be shown, so that's acceptable.
  - Admin-made flags sit in the member's folder, so the member can later replace or remove them. Storage's `owner_id` column records whoever uploaded the file. Policies ignore it.
  - A future bucket needs its own policies, and an extension of test_004's exact-policy check.
  - Postgres also applies the SELECT policy to an UPDATE or DELETE that reads a column, which hides mistakes in the other policies. test_004 checks those policies with statements that read no column (see the README).
  - Supabase blocks direct SQL DELETE on storage tables unless `storage.allow_delete_query` is `'true'`, which the Storage API sets for its own deletes. SQL tests set it to simulate API deletes. Deleting a row by SQL would orphan its file, so real deletes always go through the Storage API.

---

## [ADR-019] Seed data: add-only, re-runnable, guarded against prod

- **Date:** 2026-11-16
- **Status:** Accepted
- **Context:**
  - ISSUE-005 needs two seeds: the admin for every project, and the 2025 test event for dev only. Both must be safe to run again.
  - Dev keeps being used after it's seeded, with sign-ins, likes and profile edits. A re-run must not undo those changes, and must not duplicate rows.
  - Country claims are written only by a trigger, stamped with `now()` (ADR-011). The test data needs claims dated in 2025.
  - SEED_DATA_2025.md gives dates but no times. Midnight UTC shows as the previous evening in US time zones.
  - Nothing in a Postgres database says whether it's the dev or prod project.
- **Decision:**
  - **Seeds only add.** Each one inserts what's missing and never updates or deletes an existing row. Rows are matched like this:
    - people by `lower(email)`;
    - event settings by year;
    - messages by author, text and time;
    - likes by message and liker.
  - **One exception.** A seeded person who has never claimed a country gets their seed country, RSVP and registration date. This applies only on the first run, and in practice only to the bare admin profile that `001_admin.sql` creates.
  - **`001_admin.sql` doesn't restore admin rights on a re-run.** The mutation check showed why. The local runner applies seeds twice, so a restoring re-run made a wrong first run look correct. Recovering from a lockout is a documented one-line UPDATE instead (SETUP_SUPABASE.md Step 7).
  - **Historical claims.** Each person is saved with their country, so the trigger writes the claim. Then any claim with `claimed_at = now()` gets the registration time instead. `now()` is fixed for the transaction, so that matches exactly the claims this run created.
  - **Times:**
    - people register at 12:00 UTC;
    - they post at 18:00 UTC, and the two posts on 30 January are an hour apart;
    - a like comes an hour after the later of the post and the liker registering.

    Every documented date then shows unchanged in UTC and in every mainland US time zone.
  - **Guards in `002_test_data_2025.sql`.** It has a DEV ONLY banner. It refuses to run, changing nothing:
    - unless `001_admin.sql` has been applied;
    - if any event after 2025 exists. The test data only makes sense while 2025 is the current year, and this also keeps it out of prod once a real event is set up.
  - **Tests.** `tests/db/run_local.sh` applies the seeds twice. `test_005_seed.sql` then checks exact counts, which proves that re-running duplicates nothing. The test writes out the expected data again on its own, and checks only the 21 seeded people and what they own.
  - **Seed data lives in `pg_temp` functions**, not temporary tables, which the SQL Editor would flag (see README). They're dropped at the end of the script.
- **Consequences:**
  - Re-seeding dev is always safe, but it doesn't reset changes made by hand. A "reset dev" script would need its own issue.
  - `test_005` fails once a seeded person's data changes on dev, say Wiley liking a message. Run it straight after seeding.
  - After Start New Year has been tried on dev (ISSUE-028), there's a 2026 event, so the 2025 seed refuses to run.
  - A brand-new prod project, with no events yet, isn't covered by the guard. The banner and SETUP_SUPABASE.md Step 7 are the safeguard there.
  - Changing the test data means changing SEED_DATA_2025.md, `002_test_data_2025.sql` and `test_005`'s expected data together.

---

## [ADR-020] Theme: explicit `data-theme`, a tested inline copy, and a static header toggle
- **Date:** 2026-11-16
- **Status:** Accepted
- **Context:** COLORS.md sketches the theme system: CSS tokens, an inline `<head>` script and a toggle. ISSUE-006 had to settle what the sketch leaves open:
  - The inline script must run before any module loads, so it can't import `resolveTheme()`. Two copies of the rule can drift apart.
  - `localStorage` can throw (blocked site data, old Safari private mode).
  - The toggle belongs in "the header", but the header was going to come with ISSUE-009's app shell.
  - When should the OS setting stop applying?
- **Decision:**
  - **`<html data-theme>` is always set, to `light` or `dark`.** It's never left off for light. The inline script sets it before the stylesheet loads, and `theme.js` takes over when `app.js` boots. `:root` alone is still the light theme, so the page is readable if scripts never run.
  - **The inline copy is checked by running it.** `test_006_theme.js` pulls the script out of `index.html` and runs it with a fake `window`, `document` and `localStorage`. It covers every combination of saved value (dark, light, none, junk, throwing storage) and OS setting (dark, light, no `matchMedia`). It fails if the script ever chooses differently from `resolveTheme()` and `initTheme()`. Comments alone wouldn't keep the copies in sync.
  - **Two states, with the OS as the default.** The choice is saved only when the toggle is clicked. Until then, live OS theme changes are followed. After a click, the choice sticks. There is no "back to automatic" option.
  - **Storage failures degrade.** If reading fails, the OS setting applies. If saving fails, the choice holds in memory for the rest of the visit. Either way a `console.warn` is logged.
  - **The toggle lives in a static `<header class="site-header">` in `index.html`, outside `#app`.** It's on every view: landing, loading and dashboard. Rendering a view never removes it. It ships `hidden` and empty, and `theme.js` draws its icon and label, then reveals it, so a page whose scripts failed has no dead button. ISSUE-009 adds the logo, nav and logout to this header instead of rendering its own.
  - The icon shows where a click goes: a moon in light mode, a sun in dark. The `aria-label` and tooltip say the same in words, and the icon is `aria-hidden`. The icons are inline SVG drawn in `theme.js`, coloured with `currentColor`.
  - Each token block sets `color-scheme`, so native scrollbars and form controls match the theme.
- **Consequences:**
  - Production's Content-Security-Policy (ISSUE-030) must allow the inline script by its `sha256-…` hash, not with `'unsafe-inline'`. Any edit to the script, even whitespace, changes the hash, and the CSP must be updated with it.
  - Someone who clicks the toggle once never follows the OS again in that browser, unless they clear site data.
  - Other open tabs pick up a new choice on their next load, not live.
  - Changing a colour means changing COLORS.md and `styles.css` together. The test compares them, and fails on any hex colour outside the two token blocks.

---

## [ADR-021] Session in chunked cookies, the implicit auth flow, and an on-page setup error
- **Date:** 2026-11-16
- **Status:** Accepted
- **Context:** SPEC § Session Management wants the session kept in a cookie that effectively never expires, with `persistSession` on. supabase-js keeps it in localStorage by default, but accepts any storage object with `getItem`, `setItem` and `removeItem`. ISSUE-007 had to settle:
  - **Size.** A Supabase session is JSON: two tokens plus the user's metadata and sign-in identities, usually 3–6 KB once encoded. Browsers keep at most 4096 bytes per cookie, and silently drop anything bigger.
  - **Lifetime (A11).** Chrome caps cookie lifetimes at 400 days. Safari caps cookies set from JavaScript at 7 days.
  - **Exposure.** Cookies can only be HttpOnly if a server sets them, and this site has none.
  - **Flow.** supabase-js offers PKCE or implicit.
  - **Failure.** If `config.js` is missing, still holds the placeholders, or has a secret key pasted in, or the CDN script is blocked, the page would sit on "Loading…" forever.
- **Decision:**
  - **Cookie storage** (`createCookieStorage()` in `public/js/supabase.js`):
    - Values are percent-encoded, so `;`, `=`, spaces and unicode are safe. They are then split into chunks of at most 3000 characters, which leaves room under 4096 bytes for the name and attributes.
    - A value that fits one cookie is stored under the storage key, `sb-<project-ref>-auth-token`. A bigger one is stored as `….0`, `….1`, ….
    - Every write deletes whichever of that key's cookies the new value doesn't use, so a shrinking session leaves no stale chunks. Chunks are joined before decoding.
    - Attributes: `Path=/; Max-Age=31536000; SameSite=Lax`, plus `Secure` on https. No `Domain`, so the cookies stay on this exact host. No `__Host-` prefix: it requires `Secure`, which doesn't work on `http://localhost`.
    - Every write is read back, because browsers drop refused cookies without an error. If the read-back fails (cookies blocked, or a chunk dropped), the partly written cookies are deleted, the value is kept in memory for the rest of the visit, and a warning is logged. A corrupted cookie reads as signed out, with a warning. Nothing throws into supabase-js.
  - **Implicit flow.** It's already the supabase-js default, but it's set explicitly so an upgrade can't quietly change it. PKCE keeps a verifier in the browser that started the sign-in, so a magic link opened in another browser fails. So does one opened in a mail app's built-in browser, which is common on phones.
  - **One client.** `getSupabase()` creates it on first use and returns the same one after. Nothing else calls `createClient()`. It reads the `CONFIG` and `supabase` globals by name, behind `typeof`, because `config.js`'s top-level `const CONFIG` is global but isn't a property of `window`. A test runs the module in an iframe that declares the globals exactly as the real scripts do.
  - **Validate first, and show problems on the page.** `validateConfig()` rejects:
    - a missing or blank `CONFIG`, URL or key;
    - `config.example.js`'s placeholders;
    - a URL that isn't `https://` (plain `http://` is allowed only for `localhost` and `127.0.0.1`);
    - a key that doesn't start with `sb_publishable_`, with specific messages for a legacy JWT key and the placeholder;
    - `sb_secret_` in any `CONFIG` field. Its message says to remove the key and revoke it.

    A missing supabase-js library and an error thrown by `createClient()` are setup problems too. `boot()` shows the problems in `#app` as a `role="alert"` box, inserted as text, never HTML, and logs them. Any other error is a bug and propagates as usual.
- **Consequences:**
  - Sessions survive browser restarts. supabase-js refreshes the session on every visit and rewrites the cookies, so anyone who visits at least once every 7 days stays signed in on every browser. A Safari user away longer signs in again. Safari applies the same 7-day limit to localStorage, so cookies lose nothing there.
  - Session tokens are readable by JavaScript, exactly as they would be in localStorage, so a cross-site scripting bug could steal them. Never render untrusted HTML. Use `textContent`, or ISSUE-008's `escapeHtml`.
  - The cookies, a few KB, ride along on every request to the site's own origin, which serves only static files. Nothing reads them there, and they're never sent to Supabase, which is a different site.
  - With the implicit flow, tokens arrive in the URL fragment (`#access_token=…`). Browsers never send fragments to servers, and supabase-js clears it from the address bar after reading it. ISSUE-009 must let Supabase consume it before routing.
  - Logout (ISSUE-011) calls `signOut()`, which calls `removeItem()`, which deletes every chunk.
  - Someone with cookies blocked can sign in, but is signed out when the page reloads.
  - Supabase's own cookie helper (`@supabase/ssr`) solves this for server-rendered apps. It's an npm dependency built around a server, so it isn't used.

---

## [ADR-022] Shared UI utilities: date handling, keyset pagination, and infinite scroll
- **Date:** 2026-11-16
- **Status:** Accepted
- **Context:** The feed, message board, sidebar and admin all show dates and times, and two of them page through long lists. ISSUE-008 puts the shared helpers in `public/js/util.js`, a file SPEC § Project Structure doesn't list; the spec allows splitting further when needed. Points that needed settling:
  - **Date-only values.** `new Date('2025-02-15')` means midnight UTC, which is February 14 anywhere west of Greenwich. Code that builds local midnight and formats it in UTC fails the opposite way, east of Greenwich. A test can't catch either in a browser that happens to run at UTC.
  - **Timestamp text.** Browsers agree on ISO 8601 with a "T" and an offset, which is what PostgREST sends (verified on Postgres 17: `2025-02-14T18:30:00.123456+00:00`). Other formats parse differently, or not at all, depending on the browser. For example, Chrome reads a space instead of the "T" and Safari doesn't.
  - **Paging.** Offset paging repeats or skips rows when posts arrive mid-scroll. Postgres timestamps carry microseconds and a JavaScript Date only milliseconds.
  - **Infinite scroll.** An IntersectionObserver reports only changes, so a batch that doesn't fill a tall screen leaves the sentinel visible with nothing more to report. Automatic retries after an error would hammer a dead connection.
- **Decision:**
  - **Language.** All formatting uses `en-US`, whatever the browser's language, because the site is in English.
  - **Event date** (`formatEventDate`): the `YYYY-MM-DD` text is checked, built with `Date.UTC`, and formatted with `timeZone: 'UTC'`, so no zone is involved at all.
  - **Timestamps** are moments, shown in the viewer's zone: `formatRelativeTime` ("just now" → minutes → hours under 24 h → "yesterday" / "N days ago" by calendar date → "Feb 8", with the year added if different) and `formatFullTimestamp` for hover text. Anything other than ISO 8601 with a "T" and an offset is rejected with an error, never guessed at. A date-only value gets an error pointing to `formatEventDate`. A future time (viewer's clock behind) reads "just now".
  - **The suite runs in three time zones.** `tests/run.sh` runs every test in the machine's own zone, then at UTC+14 (`Pacific/Kiritimati`) and UTC−12 (`Etc/GMT+12`), by setting `TZ` for headless Chrome and passing `?tz=`. A test fails if the browser isn't in the zone requested, so the extra runs can't silently repeat the first. A full run takes about 4 seconds.
  - **Keyset pagination** (`applyKeysetPage`): order by time desc, id desc, and after the first batch filter with `or=(t.lt."T",and(t.eq."T",id.lt."ID"))`. The cursor (`keysetCursor`) is the last row's time and id **as the strings PostgREST sent**, never passed through Date. Both are checked (an ISO timestamp, a uuid) because they're spliced into the filter. This matches the `(event_year, <time> desc, id desc)` indexes. The real supabase-js builder produced this query string, and dev PostgREST parsed it; a malformed control got `PGRST100`.
  - **Infinite scroll** (`createInfiniteScroll`): one sentinel element after the list both triggers loading and shows the status (loading, error with a Try again button, empty or end text). The first batch loads at once. After each batch the sentinel is unobserved and observed again, which makes the browser report its visibility afresh, so a tall screen keeps filling. One load at a time; a short batch ends the list. An error is logged and stops automatic loading until Try again. `destroy()` drops any batch still in flight.
  - **Avatars** (`avatarUrl`): only `https://` flag URLs are used, matching the database check (ADR-012). Anything else is logged and replaced by the default avatar, whose URL is resolved from `util.js`'s own location, so it's right at `/`, at `/public/`, and from the test page.
- **Consequences:**
  - Event dates read the same everywhere. Times read in each viewer's own zone, which is right for "posted 5 minutes ago" but means two people abroad may see different clock times on the same post.
  - A malformed timestamp throws instead of rendering "Invalid Date". Postgres can't produce one, so this only fires on a bug.
  - When the total is an exact multiple of 20, the last request returns nothing. One extra small request was preferred over fetching 21 rows to detect the end.
  - The whole test suite runs three times. Any future date code is tested in both extreme zones for free.
  - Retrying after a render bug can draw part of a batch twice. That only happens after a bug has already been logged.
