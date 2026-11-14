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
  - SQL tests are run by hand in the dashboard. That's acceptable at this project's size; `psql` can be added later without changing the test files.
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
