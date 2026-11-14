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
- **Context:** The spec says invitations, RSVP follow-ups, and event reminders are all sent "via Supabase using Gmail SMTP". Supabase's custom SMTP setting, however, is only used by **Supabase Auth** for magic links, confirmations, and its built-in invite email. A static site has no way to send arbitrary email. Inviting a user through Auth requires the `service_role` key, which must never reach the browser. Supabase Edge Functions block outbound SMTP on ports 25 and 587, so hand-rolling Gmail SMTP inside a function isn't dependable.
- **Decision:**
  - **Invitations:** an `invite-user` Edge Function, deployed from the Supabase dashboard editor with no CLI, handles them.
    - It verifies that the caller's JWT belongs to an active admin.
    - It calls `auth.admin.inviteUserByEmail` with a redirect URL that carries the invite token.
    - Supabase then sends the Invite template through the configured Gmail SMTP.
    - `service_role` lives only in the function's secrets. The function source is committed under `supabase/functions/invite-user/` as the reference copy.
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
    - Environment variables: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
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
  - It `curl`s the anonymous `get_public_event_info` RPC using `SUPABASE_URL` and `SUPABASE_ANON_KEY`, stored as repo secrets.
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
  - The removed user's messages stay on the board. How the board shows an author whose profile members can no longer read is decided in ISSUE-003 and ISSUE-016.
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
