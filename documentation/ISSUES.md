# Board Game Olympics — Issue Tracker

Single source of truth for what is being built. Format and rules: `~/.claude/rules/issues.md`.
Spec: [`SPEC.md`](./SPEC.md). Decisions: [`DECISIONS.md`](./DECISIONS.md).

---

## Conventions

- **Branches:** `issue/###-short-description`, cut from `master` (this repo's default branch). PRs target `master`.
- **Layout:** every file the site serves lives in `public/` (`public/index.html`, `public/js/…`, `public/css/…`, `public/assets/…`), which is the Cloudflare Pages output dir. `db/`, `tests/`, `scripts/` and `documentation/` sit at the repo root and are never served. Site code uses **relative paths only**, so it works at `/` in prod and at `/public/` locally.
- **Local dev:** from the repo root, run `python3 -m http.server 8000`, then open `http://localhost:8000/public/` for the site or `http://localhost:8000/tests/` for the test page.
- **JS tests:** `tests/js/test_###_*.js`. These are ES modules that import source from `../../public/js/*.js` and run in a real browser via a small hand-written harness (`tests/index.html`), with no npm and no Node. `tests/run.sh` runs them in headless Chrome and exits non-zero on failure. Tests never touch the network; Supabase is replaced with fakes.
- **DB tests:** `tests/db/test_###_*.sql`. Plain SQL using `ASSERT` inside `begin; … rollback;`, run in the Supabase SQL Editor against the **dev** project (optionally via `psql`). Never run against prod. Roles are simulated with `set local role` plus `request.jwt.claims`.
- **Shell tests:** `tests/deploy/test_###_*.sh`. Use `curl`/`bash` only.
- **Two Supabase projects:** `dev` (migrations, seed admin, 2025 test data) and `prod` (migrations, seed admin only). The free tier allows two.
- **Placeholder content:** copy and art from `CONTENT_CHECKLIST.md` use clearly marked placeholders until delivered. Content gaps don't block any issue.

---

## Decisions (resolved 2026-11-13)

| ID | Question | Decision | ADR | Affects |
|----|----------|----------|-----|---------|
| D1 | How do tests run without npm, Node or psql? | Hand-written browser test harness, plus SQL `ASSERT` scripts run in the Supabase SQL Editor. | ADR-001 | ISSUE-001 and every issue's tests |
| D2 | How are emails sent? Supabase's SMTP setting only powers Auth emails. | An Edge Function calls `inviteUserByEmail` for invitations (sent via Gmail SMTP and the Invite template). Bulk RSVP/reminder emails use `mailto:` links with recipients in BCC. | ADR-002 | ISSUE-022, 023, 027 |
| D3 | How does a git-deployed site get `config.js`, and how do we keep docs, db and tests from being served? | Site files live in `public/`. The Pages build command `sh scripts/write-config.sh` writes `public/config.js` from Pages env vars. | ADR-003 | ISSUE-001, 030 |
| D4 | How do we stop free-tier Supabase from pausing between events? | A scheduled GitHub Actions `curl` ping every 3 days. | ADR-004 | ISSUE-031 |

## Spec Gaps — Working Assumptions

Each is recorded as an ADR in the issue that implements it. Override any of them before that issue starts.

| # | Gap in spec | Working assumption | Issue |
|---|-------------|--------------------|-------|
| A1 | Admin "registers on behalf" and seed users have no login, so they can't exist as Supabase Auth users. | `users.id` is independent of auth. Nullable `users.auth_user_id` links on first sign-in by email. | 002, 012 |
| A2 | Archiving needs a year marker that the data model lacks. | `event_year` on messages, country_claims, invitations. "Current year" = max `event_settings.year`. | 002, 028 |
| A3 | Revoked and limited-use invites aren't representable. | Status adds `revoked`. Add `max_uses` (default 1) and `use_count`. | 002, 021 |
| A4 | "Remove a user" means deactivate, not delete. | `is_active` + `deactivated_at`. Their invitation is revoked so the email can be re-invited. Messages remain. | 002, 024 |
| A5 | "Users can read all profiles" would expose every email address. | Members see name, country, flag, RSVP. Only admins see emails. | 003 |
| A6 | Landing page shows the event date, but RLS blocks anonymous reads. | Narrow RPC `get_public_event_info()` returns year and date only. | 003, 010 |
| A7 | Spec doesn't say whether members can delete their own messages. | No. Only admin deletes, per spec and SETUP_SUPABASE. | 003 |
| A8 | SPA vs multi-page is left to the developer. | Single page with hash routing (`#/rules`, `#/profile`, `#/admin`). No server rewrites needed. | 009 |
| A9 | "Reflected immediately" conflicts with the no-realtime non-goal. | Changes are reflected on the next page load or navigation. | 013, 025 |
| A10 | Country claims could be forged by direct inserts. | Claims are written only by a DB trigger on `users.country`. Clients can't insert. | 002, 003 |
| A11 | Cookie session "never expires". | 1-year cookie, but Safari caps cookies set from JS at 7 days. Each visit refreshes the session, so active users stay signed in. | 007 |
| A12 | SETUP_CLOUDFLARE says production branch `main`, but the repo uses `master`. | Use `master` and fix the doc. | 030 |
| A13 | "Non-responders" scope. | Registered, active users with `no_response`, per spec. Pending email invites are listed separately. | 021, 027 |

---

## Dependency Map

| Issue | Title | Depends on |
|-------|-------|------------|
| 001 | Project scaffold, dev docs & test harness | — |
| 002 | Database schema, constraints & triggers | — |
| 003 | Row Level Security policies | 002 |
| 004 | Flag storage bucket & policies | 002 |
| 005 | Seed data — admin & 2025 test data | 002 |
| 006 | Theme system (light / Game Night Mode) | 001 |
| 007 | Supabase client & cookie session storage | 001 |
| 008 | Shared UI utilities | 001 |
| 009 | App shell, hash router & auth-state views | 007 |
| 010 | Public landing page | 003, 009 |
| 011 | Authentication — SSO, magic link, logout | 009 |
| 012 | Invitation acceptance & first-time registration | 003, 011 |
| 013 | Sidebar — event date & yearly theme | 003, 008, 009 |
| 014 | Profile page — name, country, RSVP | 012 |
| 015 | Flag image upload | 004, 014 |
| 016 | Message board | 008, 012 |
| 017 | Meeple likes | 016 |
| 018 | Activity feed | 003, 008, 009 |
| 019 | Rules page | 009 |
| 020 | Admin panel shell & access control | 012 |
| 021 | Admin — invite links, invitation list, revocation | 020 |
| 022 | Email delivery mechanism | 003 |
| 023 | Admin — email invitations | 021, 022 |
| 024 | Admin — user management | 015, 020 |
| 025 | Admin — event date & theme | 013, 020 |
| 026 | Admin — message moderation | 016, 018, 020 |
| 027 | Admin — bulk emails | 020, 022 |
| 028 | Admin — Start New Year | 016, 018, 021 |
| 029 | Responsive design & accessibility pass | 010, 013–019 |
| 030 | Production deployment | 001–029 |
| 031 | Supabase keep-alive | 003 |

**Parallel waves**: each wave opens once the previous wave's PRs merge.
1. **001, 002**
2. 003, 004, 005 (after 002) · 006, 007, 008 (after 001)
3. 009 · 022 · 031 (after 003)
4. 010, 011, 013, 018, 019
5. 012
6. 014, 016, 020
7. 015, 017, 021, 025, 027
8. 023, 024, 026, 028, 029
9. 030

---

## [ISSUE-001] Project scaffold, dev docs & test harness

- **Type:** Feature
- **Status:** In Progress
- **Branch:** `issue/001-project-scaffold`
- **Spec Reference:** SPEC.md § Project Structure, § Configuration, § Testing, § Design Principles
- **PR:** —

### Description
Create the static-site skeleton under `public/`, the zero-dependency browser test harness (ADR-001), and developer docs. Every later issue then has a place to land and a way to write tests first.

### Acceptance Criteria
- [ ] `public/index.html`, `public/config.example.js`, `public/css/styles.css`, and every `public/js/*.js` file listed in SPEC § Project Structure exist. Each JS file has a header comment covering its purpose and how it fits the app.
- [ ] `public/index.html` loads, in order:
  1. the inline theme script in `<head>`
  2. `config.js` (classic script)
  3. the Supabase JS client from the CDN, pinned to an **exact version with an SRI hash**
  4. `js/app.js` as an ES module

  All paths are relative.
- [ ] The existing `assets/images/logo.png` is moved (`git mv`) to `public/assets/images/logo.png`.
- [ ] `tests/index.html` runs every registered test module and shows pass/fail per test plus a summary.
- [ ] `tests/run.sh` serves the repo root with `python3 -m http.server`, runs the harness in headless Chrome, prints the summary, and exits non-zero on any failure. `CHROME_BIN` overrides the browser path.
- [ ] `documentation/README.md` covers local setup: copy config, serve, run JS tests, run SQL tests.
- [ ] `documentation/DECISIONS.md` gains ADRs for ES modules with no build step and for the pinned CDN version. ADR-001 to ADR-004 already exist.
- [ ] Placeholder assets exist in `public/assets/`: `default-avatar.png`, an original simple `meeple.svg` that uses `currentColor`, a favicon, and `logo-small.png` derived from the existing logo.

### Tests
- **Test file(s):** `tests/js/test_001_harness.js`
- [ ] A passing test is reported as pass; a throwing test is reported as fail (self-test on a nested runner instance).
- [ ] Async tests are awaited; a rejected promise counts as a failure.
- [ ] `assertEqual` deep-compares objects and arrays and reports expected vs actual.
- [ ] `public/config.example.js` defines `CONFIG.SUPABASE_URL` and `CONFIG.SUPABASE_ANON_KEY` placeholders.
- [ ] `.gitignore` contains `config.js`, which also covers `public/config.js`.
- [ ] `public/index.html` references no root-absolute paths (no `src="/…"` or `href="/…"`).

### Tasks
- [ ] Write harness self-tests
- [ ] Implement `tests/harness.js` (describe/it/assert, async, DOM reporter, machine-readable summary element)
- [ ] `tests/index.html` registry and `tests/run.sh`
- [ ] Create the `public/` directory structure, stub files with header comments, and `config.example.js`
- [ ] `git mv assets public/assets`
- [ ] Placeholder assets
- [ ] `README.md` and the new ADRs in `DECISIONS.md`

### Notes
- Depends on: none.
- No `package.json`. Cloudflare Pages may try an npm install if one exists, and the project has no npm deps.

---

## [ISSUE-002] Database schema, constraints & triggers

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/002-database-schema`
- **Spec Reference:** SPEC.md § Data Model, § Yearly Lifecycle; SETUP_SUPABASE.md Step 6
- **PR:** —

### Description
SQL migrations for the six tables in the spec. Also adds the columns the spec implies but doesn't list (A1–A4), the country-claim trigger (A10), and the helper functions that RLS and storage policies rely on.

### Acceptance Criteria
- [ ] `db/migrations/001_schema.sql` creates `users`, `invitations`, `messages`, `message_likes`, `event_settings`, `country_claims` (snake_case mapping of the spec's camelCase).
- [ ] Additions: `users.auth_user_id` (nullable, unique, FK `auth.users`), `users.is_active`, `users.deactivated_at`, `users.invitation_id`. Also `event_year` on messages/country_claims/invitations, plus `invitations.max_uses` (default 1), `use_count`, `revoked_at`, and status `revoked`.
- [ ] Constraints:
  - email is unique case-insensitively
  - `char_length(country) <= 100`
  - message text is 1–1000 characters after trim
  - check constraints on rsvp/role/type/status
  - `UNIQUE(message_id, user_id)`
  - one `event_settings` row per year
  - likes cascade-delete with their message
- [ ] Trigger: inserting a user with a country, or changing `users.country` to a **different non-null** value, inserts a `country_claims` row for the current event year. Clearing a country inserts nothing.
- [ ] `SECURITY DEFINER` helpers with a fixed `search_path`: `current_event_year()`, `current_member_id()`, `is_member()` (active profile linked to `auth.uid()`), `is_admin()`.
- [ ] Every table, column addition, and function has a comment explaining *why*.

### Tests
- **Test file(s):** `tests/db/test_002_schema.sql`
- [ ] All six tables exist with the expected columns.
- [ ] An email differing only by case from an existing one is rejected.
- [ ] A 101-character country is rejected; 100 characters is accepted.
- [ ] A whitespace-only message and a 1001-character message are rejected; 1000 characters is accepted.
- [ ] Invalid rsvp, role, type, and status values are rejected.
- [ ] A second like by the same user on the same message is rejected.
- [ ] Deleting a message deletes its likes.
- [ ] Claim trigger: setting a country creates a claim; changing it creates a second claim; re-saving the same value or clearing it creates none.
- [ ] `current_event_year()` returns the max year. `is_member()`/`is_admin()` are correct for admin, member, deactivated member, and an auth user without a profile.

### Tasks
- [ ] Write SQL tests
- [ ] Schema migration
- [ ] Trigger and helper functions
- [ ] README section: applying migrations and running SQL tests
- [ ] ADRs for A1, A2, A3, A4, A10

### Notes
- Depends on: none (can run in parallel with 001).
- Migrations are applied by pasting into the SQL Editor. Keep them ordered, and idempotent where practical (`if not exists`).

---

## [ISSUE-003] Row Level Security policies

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/003-rls-policies`
- **Spec Reference:** SETUP_SUPABASE.md § Enable Row Level Security; SPEC.md § Invitation-Only Access, § Admin Panel
- **PR:** —

### Description
Supabase exposes the database through a public API, so RLS is the real security boundary. Lock every table down to exactly what each role needs.

### Acceptance Criteria
- [ ] RLS enabled on all six tables. `anon` can neither read nor write any table.
- [ ] `users`:
  - Active members can read member-safe columns of active profiles, which **excludes email** (A5).
  - A member can update only their own `name`, `country`, `flag_url`, `rsvp`, and never `role`, `email`, `is_active`, or `auth_user_id`.
  - Admin can read and update everything.
- [ ] `invitations`: admin only.
- [ ] `messages`: members read the current year and insert only as themselves. Only admin can delete (A7). No updates.
- [ ] `message_likes`: members read; insert and delete only their own.
- [ ] `country_claims`: members read. No client inserts; the trigger writes them (A10).
- [ ] `event_settings`: members read; admin inserts and updates.
- [ ] Deactivated members and authenticated users without a profile are denied everything.
- [ ] `get_public_event_info()` is callable by `anon` and returns only year and event date (A6).

### Tests
- **Test file(s):** `tests/db/test_003_rls.sql`
- [ ] anon: zero rows from every table; every insert fails.
- [ ] anon: `get_public_event_info()` returns the date and no other fields.
- [ ] Auth user without a profile: zero rows everywhere.
- [ ] Member: can read other profiles but cannot read their email.
- [ ] Member: cannot update another user, or set their own `role`/`is_active`.
- [ ] Member: cannot read invitations.
- [ ] Member: can post as self; cannot post as another user.
- [ ] Member: cannot delete any message, own included. Admin can delete any.
- [ ] Member: can like and unlike; cannot delete another user's like.
- [ ] Member: cannot insert into `country_claims` directly.
- [ ] Member: cannot update `event_settings`; admin can.
- [ ] Deactivated member: zero rows everywhere.

### Tasks
- [ ] Write SQL tests
- [ ] `db/migrations/002_rls.sql`
- [ ] Admin read path for emails (`admin_list_users()` RPC or equivalent)
- [ ] ADRs for A5, A6, A7

### Notes
- Depends on: 002.

---

## [ISSUE-004] Flag storage bucket & policies

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/004-flag-storage`
- **Spec Reference:** SPEC.md § File Storage, § Optional Fields; SETUP_SUPABASE.md Step 5
- **PR:** —

### Description
Create the `flags` bucket in SQL instead of dashboard clicks, so it's reproducible, with server-side size and type limits and owner-scoped write policies.

### Acceptance Criteria
- [ ] `db/migrations/003_storage.sql` creates a public `flags` bucket with `file_size_limit` = 2 MB and `allowed_mime_types` = `image/jpeg`, `image/png`.
- [ ] Anyone can read. Members can insert, update, and delete only under `{their member id}/`. Admin can write anywhere. anon cannot write.
- [ ] SETUP_SUPABASE.md Step 5 replaced with "run this migration".

### Tests
- **Test file(s):** `tests/db/test_004_storage.sql`
- [ ] Bucket exists, is public, has a 2,097,152-byte limit, and allows exactly jpeg and png.
- [ ] A member can insert into their own folder but not another member's.
- [ ] A member can delete their own object but not another member's.
- [ ] Admin can write into any member's folder.
- [ ] anon insert fails.

### Tasks
- [ ] Write SQL tests
- [ ] Storage migration
- [ ] Update SETUP_SUPABASE.md

### Notes
- Depends on: 002.
- The bucket can't enforce the 1024×1024 limit; that's checked client-side in ISSUE-015.

---

## [ISSUE-005] Seed data — admin & 2025 test data

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/005-seed-data`
- **Spec Reference:** SPEC.md § Initial Administrator, § Test Data (2025 Event); SEED_DATA_2025.md
- **PR:** —

### Description
Idempotent seed scripts: the admin account (all environments) and the 2025 test dataset (dev only), so the UI can be built against realistic content.

### Acceptance Criteria
- [ ] `db/seed/001_admin.sql`: Wiley Page / gwpage@gmail.com / admin, `auth_user_id` null (linked on first sign-in, A1). Safe for prod.
- [ ] `db/seed/002_test_data_2025.sql`:
  - 2025 event settings
  - all 21 users with their country and RSVP
  - 20 messages
  - every like in SEED_DATA_2025.md
  - one country claim per user, dated at registration
- [ ] The test-data script has a prominent **DEV ONLY** header.
- [ ] Re-running either script creates no duplicates.

### Tests
- **Test file(s):** `tests/db/test_005_seed.sql`
- [ ] Exactly 1 admin, with email gwpage@gmail.com.
- [ ] 21 users: 18 attending, 2 not_attending, 1 no_response.
- [ ] 20 messages, each timestamped on or after its author's registration date.
- [ ] Like totals match the source: 49 overall, 7 on Owen's "Root…", 7 on Sam's "Can't wait…", 6 on Dave's "Pandemic…".
- [ ] 21 country claims with `claimed_at` equal to the registration date.
- [ ] 2025 settings: date 2025-02-15, title "Board Games".
- [ ] Running both scripts twice leaves all counts unchanged.

### Tasks
- [ ] Write SQL tests
- [ ] Admin seed
- [ ] 2025 test data seed

### Notes
- Depends on: 002.
- The claim trigger would stamp claims with `now()`. The seed must insert claims with historical dates and stop the trigger from double-inserting, e.g. insert users without a country first, or set `session_replication_role` inside the seed transaction.
- Fake users have no auth accounts and can't log in. The admin links on first Google sign-in.

---

## [ISSUE-006] Theme system (light / Game Night Mode)

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/006-theme-system`
- **Spec Reference:** COLORS.md (all); SPEC.md § Project Structure (`theme.js`)
- **PR:** —

### Description
CSS color tokens for both themes, flash-free initial theme selection, and a persistent toggle.

### Acceptance Criteria
- [ ] `public/css/styles.css` defines every COLORS.md token on `:root` (light) and `[data-theme="dark"]`. No hex colors appear outside the token blocks.
- [ ] An inline `<head>` script applies the saved preference, otherwise the system preference, before first paint.
- [ ] A header toggle switches theme and persists it. It shows a moon icon in light mode and a sun in dark mode, with an accessible label.
- [ ] With no saved preference, live OS theme changes are followed.
- [ ] A throwing `localStorage` (private mode) doesn't break the page.

### Tests
- **Test file(s):** `tests/js/test_006_theme.js`
- [ ] `resolveTheme('dark', false)` → dark; `(null, true)` → dark; `(null, false)` → light; `('light', true)` → light.
- [ ] `nextTheme` flips dark↔light, and `nextTheme(null)` → dark.
- [ ] Every token in COLORS.md appears in `styles.css` with the identical hex for both themes (parse both files).
- [ ] `styles.css` contains no hex colors outside the token blocks.
- [ ] Toggling with a throwing `localStorage` still switches the theme.

### Tasks
- [ ] Write tests
- [ ] Tokens in `styles.css`
- [ ] Inline head script and `public/js/theme.js`
- [ ] Toggle button and icons

### Notes
- Depends on: 001.
- The inline script duplicates `resolveTheme` because it has to run before modules load. Comment both copies so they stay in sync.

---

## [ISSUE-007] Supabase client & cookie session storage

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/007-supabase-client-session`
- **Spec Reference:** SPEC.md § Session Management, § Configuration, § Database & Auth
- **PR:** —

### Description
A single Supabase client configured from `CONFIG`, whose session is stored in long-lived cookies so it survives browser restarts.

### Acceptance Criteria
- [ ] `public/js/supabase.js` exports one client with `persistSession`, `autoRefreshToken`, `detectSessionInUrl`, and a custom cookie `storage` adapter.
- [ ] Cookies are set with `Path=/; SameSite=Lax; Max-Age=31536000`, plus `Secure` on https.
- [ ] Values over the per-cookie size limit are split across numbered chunk cookies and reassembled. Shrinking or removing a value clears stale chunks.
- [ ] Missing or placeholder config shows a clear on-page error instead of a blank page.

### Tests
- **Test file(s):** `tests/js/test_007_cookie_storage.js`
- [ ] `setItem`/`getItem` round-trip through an injectable fake cookie jar.
- [ ] `getItem` of a missing key → `null`.
- [ ] A 10 KB value is split into chunks that are each under the limit, and reassembles exactly.
- [ ] Overwriting a 3-chunk value with a 1-chunk value leaves no stale chunks.
- [ ] `removeItem` deletes all chunks.
- [ ] Attributes include `Max-Age=31536000`, `SameSite=Lax`, `Path=/`, and `Secure` only on https.
- [ ] Values containing `;`, `=`, spaces, and unicode round-trip.
- [ ] `validateConfig` rejects a missing or placeholder URL or key.

### Tasks
- [ ] Write tests
- [ ] Cookie storage adapter with chunking
- [ ] Client init and config validation
- [ ] ADR: implicit auth flow and cookie storage (A11)

### Notes
- Depends on: 001.
- Use the **implicit** flow, not PKCE. PKCE breaks magic links opened in a different browser or a mail app's in-app browser, which is common on phones.
- Safari caps JS-set cookies at 7 days (A11). Document this in the file header.

---

## [ISSUE-008] Shared UI utilities

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/008-shared-utilities`
- **Spec Reference:** SPEC.md § Message Board (pagination), § Profile Rules (avatar), § Project Structure ("split it further")
- **PR:** —

### Description
Helpers that the feed, message board, sidebar, and admin all need. Putting them in one early issue lets those issues proceed in parallel.

### Acceptance Criteria
- [ ] `public/js/util.js` exports:
  - `escapeHtml`
  - `formatRelativeTime`
  - `formatEventDate`
  - `createInfiniteScroll` (IntersectionObserver batch loader)
  - keyset cursor helpers
  - `avatarUrl`
- [ ] Spec deviation (new file) is noted in its header comment.

### Tests
- **Test file(s):** `tests/js/test_008_util.js`
- [ ] `escapeHtml` escapes `& < > " '`.
- [ ] `formatRelativeTime`: 30 s → "just now", 5 min → "5 minutes ago", 2 h → "2 hours ago", 1 day → "yesterday", over 7 days → a calendar date.
- [ ] `formatEventDate('2025-02-15')` → "Saturday, February 15, 2025" in every timezone (avoids the date-only UTC off-by-one).
- [ ] Infinite scroll:
  - loads the first batch, and the next when the sentinel becomes visible
  - stops when a batch is short
  - never runs two loads concurrently
  - surfaces errors with a retry
- [ ] `avatarUrl` returns the default avatar for a null flag and the flag URL otherwise.

### Tasks
- [ ] Write tests
- [ ] Implement `public/js/util.js`

### Notes
- Depends on: 001.

---

## [ISSUE-009] App shell, hash router & auth-state views

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/009-app-shell-router`
- **Spec Reference:** SPEC.md § Home Page (Single URL, Two Views), § Page Structure, § Session Management (logout)
- **PR:** —

### Description
`app.js` resolves auth state, then routes to the right view. It also renders the authenticated layout: header, nav, theme toggle, logout, sidebar slot, and main content.

### Acceptance Criteria
- [ ] Routes: `#/` (home), `#/rules`, `#/profile`, `#/admin`. Unknown routes go to `#/`.
- [ ] Logged out → landing view on every route. Signed in without a profile → registration or not-invited view. A non-admin on `#/admin` → home.
- [ ] Auth callback fragments (`#access_token=…`, `#error=…`) are consumed by Supabase **before** routing and are never treated as routes.
- [ ] A loading state shows while the session resolves, so logged-in users never see a flash of the landing page.
- [ ] Logout is available on every authenticated page.

### Tests
- **Test file(s):** `tests/js/test_009_router.js`
- [ ] `resolveView` matrix:
  - logged out × every route → landing
  - no profile → registration or not-invited
  - member `#/admin` → home
  - admin `#/admin` → admin
  - `#/nope` and an empty hash → home
- [ ] Hashes starting `#access_token`, `#refresh_token`, `#error` are identified as auth callbacks.
- [ ] Nav marks the active route.

### Tasks
- [ ] Write tests
- [ ] Router and view resolver
- [ ] Layout markup and nav
- [ ] ADR: hash routing (A8)

### Notes
- Depends on: 007.
- Client route guards are UX only. RLS (003) is the real enforcement; say so in a comment.

---

## [ISSUE-010] Public landing page

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/010-landing-page`
- **Spec Reference:** SPEC.md § Logged-Out View (Public Landing Page); CONTENT_CHECKLIST.md § Landing Page, § Meta / SEO
- **PR:** —

### Description
The public advertisement for the event: same URL as the dashboard, shown when logged out.

### Acceptance Criteria
- [ ] Shows logo, event name, tagline, date, location, description, and a login/register button.
- [ ] The date comes from `get_public_event_info()`. Shows "Date TBA" if it's missing or the call fails.
- [ ] Makes no queries beyond that RPC.
- [ ] `<title>`, meta description, Open Graph and Twitter card tags, favicon, and apple-touch-icon are present.
- [ ] Copy sits in clearly marked placeholders until CONTENT_CHECKLIST copy is delivered.

### Tests
- **Test file(s):** `tests/js/test_010_landing.js`
- [ ] Renders the date from the RPC result; shows "Date TBA" on null or error.
- [ ] Uses only `get_public_event_info` (a fake client records every call).
- [ ] `public/index.html` head contains `title`, `meta description`, `og:title`, `og:description`, `og:image`, `og:url`.
- [ ] The login button opens the login options.

### Tasks
- [ ] Write tests
- [ ] Landing markup and styles
- [ ] Meta and OG tags

### Notes
- Depends on: 003 (RPC), 009.

---

## [ISSUE-011] Authentication — SSO, magic link, logout

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/011-authentication`
- **Spec Reference:** SPEC.md § Authentication, § Session Management; SETUP_SUPABASE.md Step 4
- **PR:** —

### Description
Login UI and flows for Google, Facebook, and email magic link, plus logout. Invite tokens survive the round-trip to the auth provider.

### Acceptance Criteria
- [ ] Login options: Google, Facebook, email magic link.
- [ ] The magic link sets `shouldCreateUser: true` **only** when an invite token is present. The redirect URL carries the token.
- [ ] The OAuth redirect URL also carries the invite token.
- [ ] Friendly messages for: invalid email, link sent, expired/invalid link, rate-limited, provider error.
- [ ] Logout signs out, clears all session cookies, and returns to the landing page.
- [ ] Dashboard steps (providers, Site URL, redirect URLs, magic-link template) are verified against SETUP_SUPABASE.md and corrected where wrong.

### Tests
- **Test file(s):** `tests/js/test_011_auth.js`
- [ ] `buildRedirectUrl(origin, token)` includes `?invite=token`; without a token it's the bare origin.
- [ ] The magic-link call passes `shouldCreateUser: false` without a token and `true` with one.
- [ ] Invalid emails are rejected before Supabase is called.
- [ ] `mapAuthError` maps `otp_expired`, `over_email_send_rate_limit`, and `access_denied` to friendly text; unknown codes → generic text.
- [ ] Logout calls `signOut` and leaves no `sb-` cookies.
- [ ] Manual (documented checklist): Google and Facebook round-trips on dev.

### Tasks
- [ ] Write tests
- [ ] `public/js/auth.js` flows
- [ ] Login UI
- [ ] Doc corrections

### Notes
- Depends on: 009.
- Uninvited OAuth sign-ins create an `auth.users` row with no profile, so no access. This is harmless; cleanup is optional.
- Seeded and admin-created users have no auth account yet. Their first sign-in must be Google/Facebook or come through an invite link.
- Facebook apps must be switched to Live mode for non-developer users, and app review may apply.

---

## [ISSUE-012] Invitation acceptance & first-time registration

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/012-invite-acceptance-registration`
- **Spec Reference:** SPEC.md § Invitation-Only Access, § RSVP Flow, § Required Fields
- **PR:** —

### Description
Turn a signed-in auth user into a member, or reject them. This is where invitation-only access is actually enforced.

### Acceptance Criteria
- [ ] `?invite=TOKEN` is captured on landing and survives login.
- [ ] After every sign-in, the client calls the `claim_membership(invite_token)` RPC (`SECURITY DEFINER`). It tries, in order:
  1. Return the existing linked profile.
  2. Link an unlinked active profile with a matching email (seeded or admin-created).
  3. Create a profile from a pending email invitation matching the email.
  4. Create a profile from a valid link token.
  5. Otherwise return `not_invited`.
- [ ] Acceptance sets `accepted_at`, increments `use_count` (status becomes `accepted` when uses run out), and sets `users.invitation_id`.
- [ ] First-time users see a registration form:
  - name, prefilled from the provider
  - RSVP attending / not attending
  - optional country
- [ ] Not-invited and deactivated users see a clear message and are signed out.

### Tests
- **Test file(s):** `tests/db/test_012_claim_membership.sql`, `tests/js/test_012_registration.js`
- [ ] SQL: A valid link token creates a profile and accepts the invitation.
- [ ] SQL: A one-time token used by a second person is rejected.
- [ ] SQL: A revoked token is rejected, and so is a prior-year pending token.
- [ ] SQL: An email invitation is matched case-insensitively without a token.
- [ ] SQL: A seeded profile is linked on first sign-in by email, not duplicated.
- [ ] SQL: Repeat calls are idempotent.
- [ ] SQL: No invitation and no profile → `not_invited`, nothing created.
- [ ] SQL: A deactivated profile is not linked → `deactivated`.
- [ ] JS: `parseInviteToken` reads the token from the query string and rejects malformed tokens.
- [ ] JS: The token is persisted through login and cleared after a successful claim.
- [ ] JS: Registration validation: name required (trimmed, ≤100); RSVP ∈ {attending, not_attending}.
- [ ] JS: The claim result picks the view: created → registration, linked → home, not_invited → not-invited screen.

### Tasks
- [ ] Write SQL and JS tests
- [ ] `claim_membership` RPC (migration)
- [ ] Registration and not-invited views
- [ ] ADR: membership gating model

### Notes
- Depends on: 003, 011.

---

## [ISSUE-013] Sidebar — event date & yearly theme

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/013-sidebar-theme`
- **Spec Reference:** SPEC.md § Sidebar — Yearly Theme, § Responsive Design
- **PR:** —

### Description
A sidebar on every authenticated page with the event date (prominent), theme title, and description.

### Acceptance Criteria
- [ ] Shows date, title, and description for the current event year on every authenticated page.
- [ ] Collapses to a top banner or expandable section on small screens.
- [ ] Re-fetched on each page load (A9). Shows an empty state if no settings exist.

### Tests
- **Test file(s):** `tests/js/test_013_sidebar.js`
- [ ] Renders date, title, and description.
- [ ] Escapes HTML in title and description.
- [ ] Shows the empty state when there are no settings.
- [ ] Preserves line breaks in the description.
- [ ] The collapse toggle flips `aria-expanded`.

### Tasks
- [ ] Write tests
- [ ] Sidebar render and fetch
- [ ] Responsive collapse

### Notes
- Depends on: 003, 008, 009.

---

## [ISSUE-014] Profile page — name, country, RSVP

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/014-profile-page`
- **Spec Reference:** SPEC.md § User Registration & Profile, § RSVP Flow, § Page Structure (Profile)
- **PR:** —

### Description
`#/profile`: view and edit your name, country, and RSVP. Flag upload is added in ISSUE-015.

### Acceptance Criteria
- [ ] Shows name, email (read-only), country, flag slot, and RSVP.
- [ ] Edit name, country (free text, ≤100, blank allowed), and RSVP (attending / not attending).
- [ ] Saving a country change produces a feed claim through the trigger.
- [ ] Success and error feedback; form values are kept on error.

### Tests
- **Test file(s):** `tests/js/test_014_profile.js`
- [ ] `validateProfile`:
  - blank name rejected
  - 101-character country rejected
  - country trimmed; blank → `null`
  - invalid RSVP rejected
- [ ] `buildProfileUpdate` includes only changed fields and never `role`, `email`, or `is_active`.
- [ ] Save success shows a confirmation; an error shows a message and keeps the inputs.

### Tasks
- [ ] Write tests
- [ ] `public/js/profile.js` view and save

### Notes
- Depends on: 012.

---

## [ISSUE-015] Flag image upload

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/015-flag-upload`
- **Spec Reference:** SPEC.md § Optional Fields (Flag image), § Profile Rules
- **PR:** —

### Description
Upload, replace, or remove your flag. It becomes your avatar throughout the site.

### Acceptance Criteria
- [ ] Accepts JPEG/PNG up to 2 MB and 1024×1024. Rejects anything else with a clear error **before** uploading.
- [ ] Stores the file at `flags/{member_id}/{timestamp}.{ext}`, updates `flag_url`, and deletes the previous file.
- [ ] Removing the flag falls back to the default avatar.
- [ ] The upload component is reusable; admin uses it in ISSUE-024.

### Tests
- **Test file(s):** `tests/js/test_015_flag_upload.js`
- [ ] `validateFlagFile`: jpeg and png pass; gif, webp, and svg fail; 2,097,152 bytes passes and one byte more fails.
- [ ] `validateFlagDimensions`: 1024×1024 passes; 1025×10 fails.
- [ ] Decoding a generated 1×1 PNG blob returns its dimensions (real browser API).
- [ ] `buildFlagPath(id, 'image/png', fixedDate)` → `${id}/<epoch-ms>.png`.
- [ ] Upload flow with a fake client: uploads, updates `flag_url`, and deletes the old file. On upload error, `flag_url` is unchanged.

### Tasks
- [ ] Write tests
- [ ] Validation and upload component
- [ ] Wire into the profile page

### Notes
- Depends on: 004, 014.

---

## [ISSUE-016] Message board

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/016-message-board`
- **Spec Reference:** SPEC.md § Message Board
- **PR:** —

### Description
Post and read plain-text messages, newest first, with infinite scroll.

### Acceptance Criteria
- [ ] A compose box with a live character counter. Posts must be 1–1000 characters, and Post is disabled when the text is invalid.
- [ ] A new post appears at the top without a reload.
- [ ] Each message shows avatar, name, timestamp (relative, with full date on hover), and text. Text is plain, escaped, and keeps line breaks.
- [ ] Infinite scroll in batches of 20 with keyset pagination, current event year only.
- [ ] Empty and error states.

### Tests
- **Test file(s):** `tests/js/test_016_messages.js`
- [ ] `validateMessage`: whitespace-only fails; 1000 characters passes; 1001 fails.
- [ ] 1000 emoji pass. Characters are counted by code point to match Postgres `char_length`, not by JS `.length`.
- [ ] `renderMessage` escapes `<script>` and `<img onerror>`, and preserves newlines.
- [ ] Renders author name, avatar (flag or default), and relative time.
- [ ] The query uses a `(created_at, id)` cursor, limit 20, filtered to the current year.
- [ ] Posting prepends the new message without a reload.

### Tasks
- [ ] Write tests
- [ ] `public/js/messages.js` compose, list, and pagination

### Notes
- Depends on: 008, 012.

---

## [ISSUE-017] Meeple likes

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/017-meeple-likes`
- **Spec Reference:** SPEC.md § Message Board (Meeple likes); COLORS.md (meeple tokens)
- **PR:** —

### Description
A meeple "like" toggle on each message, with a count and a list of who liked it.

### Acceptance Criteria
- [ ] Each message has a meeple button with a count. It's gray when inactive and orange when the current user has liked it, using CSS tokens and the SVG's `currentColor`.
- [ ] Clicking toggles the like optimistically. On failure it rolls back and shows a message.
- [ ] Hover, tap, or focus shows the names of everyone who liked it.
- [ ] Rapid double-clicks never double-insert.
- [ ] Accessible: a real `<button>`, `aria-pressed`, and an `aria-label` that includes the count.

### Tests
- **Test file(s):** `tests/js/test_017_meeples.js`
- [ ] `toggleLike` adds or removes the current user and updates the count.
- [ ] Failure rolls the state back.
- [ ] A rapid double toggle sends one request at a time.
- [ ] The likers list shows names. With zero likes it shows an empty-state prompt.
- [ ] `aria-pressed` reflects the state.

### Tasks
- [ ] Write tests
- [ ] Like toggle, likers popover, styles

### Notes
- Depends on: 016.

---

## [ISSUE-018] Activity feed

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/018-activity-feed`
- **Spec Reference:** SPEC.md § Activity Feed, § Message Board (Pagination)
- **PR:** —

### Description
A reverse-chronological feed of country claims and new messages, which gives the event a sense of momentum.

### Acceptance Criteria
- [ ] A DB view `activity_feed` (`security_invoker = true`) unions claims and messages for the current year, with actor name and flag, newest first.
- [ ] Renders lines like "Alex claimed Genovia — 2 hours ago" and "Sam posted a message — 5 minutes ago" (with a short preview).
- [ ] Infinite scroll in batches of 20. Deleted messages disappear from the feed.
- [ ] Dashboard layout: feed and board side by side on desktop, stacked or tabbed on mobile.

### Tests
- **Test file(s):** `tests/db/test_018_activity_feed.sql`, `tests/js/test_018_feed.js`
- [ ] SQL: Both kinds of item appear, newest first.
- [ ] SQL: Prior-year rows are excluded.
- [ ] SQL: A deleted message disappears from the feed.
- [ ] SQL: anon and profile-less users see nothing (the view honors RLS).
- [ ] JS: `describeActivity` produces the right text for claim and message items.
- [ ] JS: Country names are escaped.
- [ ] JS: The pagination cursor stays stable across mixed item types, with ties broken by id.

### Tasks
- [ ] Write SQL and JS tests
- [ ] Feed view migration
- [ ] `public/js/feed.js`
- [ ] Dashboard layout

### Notes
- Depends on: 003, 008, 009.

---

## [ISSUE-019] Rules page

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/019-rules-page`
- **Spec Reference:** SPEC.md § Page Structure (Rules); CONTENT_CHECKLIST.md § Rules Page
- **PR:** —

### Description
`#/rules`: event rules, format, conduct, FAQ, and a link to the Google Sheet game list.

### Acceptance Criteria
- [ ] Renders rules, schedule/format, code of conduct, and FAQ sections, with placeholder copy until delivered.
- [ ] The Google Sheet link is a named constant and opens in a new tab with `rel="noopener noreferrer"`.
- [ ] While the sheet URL is still a placeholder, shows "Game list coming soon" instead of a broken link.

### Tests
- **Test file(s):** `tests/js/test_019_rules.js`
- [ ] All section headings render.
- [ ] The sheet link has the constant `href`, `target="_blank"`, and `rel="noopener noreferrer"`.
- [ ] A placeholder URL shows the "coming soon" text.

### Tasks
- [ ] Write tests
- [ ] `public/js/rules.js`

### Notes
- Depends on: 009.
- If the sheet changes every year, move its URL into `event_settings` later.

---

## [ISSUE-020] Admin panel shell & access control

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/020-admin-shell`
- **Spec Reference:** SPEC.md § Admin Panel
- **PR:** —

### Description
An admin-only area with one panel per admin capability. Later issues fill in each panel.

### Acceptance Criteria
- [ ] The `#/admin` nav link appears only for admins.
- [ ] Panels: Invitations, Users, Theme, Emails, Messages, New Year. Each panel has its own sub-route (`#/admin/users`).
- [ ] Comments note that the client guard is UX only and RLS/RPC is the enforcement.

### Tests
- **Test file(s):** `tests/js/test_020_admin_shell.js`
- [ ] The admin link renders only for the admin role.
- [ ] A non-admin visiting `#/admin` lands on home.
- [ ] Switching panels shows exactly one panel and updates the hash.

### Tasks
- [ ] Write tests
- [ ] `public/js/admin.js` shell and panel routing

### Notes
- Depends on: 012. The admin has to be able to sign in and get linked first.

---

## [ISSUE-021] Admin — invite links, invitation list, revocation

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/021-admin-invitations`
- **Spec Reference:** SPEC.md § Invitation Management
- **PR:** —

### Description
Generate shareable invite links, list all invitations, revoke unused ones, and see non-responders.

### Acceptance Criteria
- [ ] The `create_link_invitation(max_uses)` RPC (admin only) generates a random token **server-side**. The UI copies the resulting URL to the clipboard.
- [ ] Lists current-year invitations with type, email, status, created/accepted dates, and uses.
- [ ] Revoke a pending invitation or deactivate an unused link.
- [ ] Non-responders list: active registered users with `no_response` (A13).

### Tests
- **Test file(s):** `tests/db/test_021_invitations.sql`, `tests/js/test_021_admin_invitations.js`
- [ ] SQL: Non-admins cannot create or revoke.
- [ ] SQL: Tokens are unique and carry ≥128 bits of randomness.
- [ ] SQL: Revoking works on pending invitations and fails on accepted ones.
- [ ] SQL: `max_uses` is enforced.
- [ ] JS: `buildInviteUrl(origin, token)` is correct.
- [ ] JS: Status labels and sorting are correct.
- [ ] JS: The non-responder filter excludes inactive users and users who have responded.
- [ ] JS: Copy uses the Clipboard API, with a select-text fallback.

### Tasks
- [ ] Write SQL and JS tests
- [ ] Invitation RPCs (migration)
- [ ] Invitations panel UI

### Notes
- Depends on: 020.

---

## [ISSUE-022] Email delivery mechanism

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/022-email-delivery`
- **Spec Reference:** SPEC.md § Email (Invitations, Magic Links & Reminders), § Email Actions; SETUP_SUPABASE.md § Configure Email for Invitations; DECISIONS.md ADR-002
- **PR:** —

### Description
Supabase's custom SMTP setting only powers **Auth** emails, so a static site needs a server-side piece to send invitations. Per ADR-002:
- invitations go through a small Edge Function that uses Supabase's invite email;
- bulk RSVP follow-ups and reminders open the admin's mail app via `mailto:`.

Both sit behind one interface that ISSUE-023 and ISSUE-027 use.

### Acceptance Criteria
- [ ] An `invite-user` Edge Function, created in the Supabase dashboard editor so no CLI is needed:
  - verifies the caller's JWT and admin role server-side
  - calls `auth.admin.inviteUserByEmail` with a redirect URL carrying the invite token
- [ ] The `service_role` key lives only in Edge Function secrets, never in the repo or client.
- [ ] Bulk emails use a `mailto:` builder: recipients in BCC, prefilled subject and body. Falls back to "copy recipients/body" when the URL is too long.
- [ ] The Invite email template is customised and a reference copy is committed under `documentation/`.

### Tests
- **Test file(s):** `tests/js/test_022_email.js`, `tests/deploy/test_022_invite_function.sh`
- [ ] JS: The `mailto:` builder encodes the subject and body and puts every recipient in BCC.
- [ ] JS: The builder falls back to copy mode above the URL length limit.
- [ ] Shell (against dev): a call with no JWT → 401; a member JWT → 403; an admin JWT with an invalid email → 400.

### Tasks
- [ ] Write tests
- [ ] Edge Function and secrets
- [ ] `mailto:` builder
- [ ] Commit the function source to `supabase/functions/invite-user/index.ts` as the reference copy, with deploy steps in SETUP_SUPABASE.md

### Notes
- Depends on: 003.
- Caveats (also recorded in ADR-002):
  - `inviteUserByEmail` fails for emails that already have an account. Returning users are reached by the RSVP follow-up after Start New Year instead.
  - Invite links are short-lived (≤24 h). That's harmless, because membership also matches by email on any later sign-in.
- Supabase docs say Edge Functions can't open outbound connections on SMTP ports 25/587, so hand-rolled Gmail SMTP isn't a dependable path. That's why the function uses the Auth invite API.

---

## [ISSUE-023] Admin — email invitations

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/023-admin-email-invitations`
- **Spec Reference:** SPEC.md § Invitation Management (Email invitation)
- **PR:** —

### Description
Invite one or more people by email.

### Acceptance Criteria
- [ ] Accepts emails separated by commas, spaces, or newlines.
  - Invalid entries are shown inline.
  - Duplicates, already-registered emails, and already-invited emails are reported and skipped.
- [ ] Creates email invitation records with tokens and sends them through ISSUE-022.
- [ ] Shows a result for each email. Failed sends stay pending and can be retried.

### Tests
- **Test file(s):** `tests/js/test_023_email_invites.js`, `tests/db/test_023_email_invitations.sql`
- [ ] JS: `parseEmailList` splits, trims, lowercases, dedupes, and flags invalid entries.
- [ ] JS: The results summary counts sent, skipped, and failed correctly.
- [ ] SQL: `create_email_invitations` is admin-only.
- [ ] SQL: It skips emails that have a pending invite or an active profile, and returns tokens.

### Tasks
- [ ] Write tests
- [ ] RPC
- [ ] UI and send integration

### Notes
- Depends on: 021, 022.

---

## [ISSUE-024] Admin — user management

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/024-admin-users`
- **Spec Reference:** SPEC.md § User Management, § RSVP Flow (admin changes RSVP)
- **PR:** —

### Description
View, edit, register on behalf of, and remove users.

### Acceptance Criteria
- [ ] A table of all users: name, email, country, flag, RSVP, role, active, registered date. Filter by RSVP; search by name or email.
- [ ] Edit any user's name, country, flag (reusing the 015 component), and RSVP.
- [ ] Register on behalf:
  - name and email required; country, flag, and RSVP optional
  - creates a profile with no login
  - links automatically if that person ever signs in with that email
- [ ] Remove: after confirmation, deactivates the user and revokes their invitation (A4). Their messages remain.
- [ ] An admin cannot deactivate or demote themselves.

### Tests
- **Test file(s):** `tests/db/test_024_admin_users.sql`, `tests/js/test_024_admin_users.js`
- [ ] SQL: `admin_list_users` returns emails to the admin and is denied to members.
- [ ] SQL: The admin can update another user's RSVP, country, and flag. An admin country change still logs a claim.
- [ ] SQL: `admin_create_user` creates a profile with a null `auth_user_id`. A duplicate email is rejected.
- [ ] SQL: After deactivation the user loses access, their invitation is revoked, and their messages remain.
- [ ] SQL: Self-deactivation is rejected.
- [ ] JS: Create-form validation.
- [ ] JS: Filter and search helpers.
- [ ] JS: Remove requires confirmation.

### Tasks
- [ ] Write tests
- [ ] Admin user RPCs
- [ ] Users panel UI

### Notes
- Depends on: 015, 020.

---

## [ISSUE-025] Admin — event date & theme

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/025-admin-theme`
- **Spec Reference:** SPEC.md § Theme Management
- **PR:** —

### Description
Set the current year's event date, theme title, and description.

### Acceptance Criteria
- [ ] The form is prefilled from current settings. Saving upserts the current year's row.
- [ ] Title is required and ≤100 characters; description ≤1000. Limits are named constants mirrored by DB checks.
- [ ] The sidebar reflects changes on the next load (A9).

### Tests
- **Test file(s):** `tests/js/test_025_admin_theme.js`, `tests/db/test_025_event_settings.sql`
- [ ] JS: The date is required and must be valid; title and description limits are enforced.
- [ ] SQL: An admin upsert works and bumps `updated_at`.
- [ ] SQL: A member upsert is denied.
- [ ] SQL: An over-length title is rejected.

### Tasks
- [ ] Write tests
- [ ] Constraint migration (if not in 002)
- [ ] Theme panel UI

### Notes
- Depends on: 013, 020.

---

## [ISSUE-026] Admin — message moderation

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/026-admin-moderation`
- **Spec Reference:** SPEC.md § Message Moderation, § Message Board (Admin moderation)
- **PR:** —

### Description
The admin can delete any message, from the board or from the admin panel.

### Acceptance Criteria
- [ ] A delete control appears on every message for the admin, both on the board and in a moderation list.
- [ ] Deletion requires confirmation. Afterwards the message, its likes, and its feed entry are gone.

### Tests
- **Test file(s):** `tests/db/test_026_moderation.sql`, `tests/js/test_026_moderation.js`
- [ ] SQL: An admin delete removes the likes and the `activity_feed` entry.
- [ ] SQL: A member delete is denied.
- [ ] JS: The delete control renders only for the admin.
- [ ] JS: Cancelling the confirmation sends no request.
- [ ] JS: A successful delete removes the message from the DOM.

### Tasks
- [ ] Write tests
- [ ] Board delete control
- [ ] Moderation panel

### Notes
- Depends on: 016, 018, 020.

---

## [ISSUE-027] Admin — bulk emails (RSVP follow-up, event reminder)

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/027-admin-bulk-email`
- **Spec Reference:** SPEC.md § Email Actions
- **PR:** —

### Description
Manual, button-triggered emails: nudge non-responders, and remind attendees before the event.

### Acceptance Criteria
- [ ] "RSVP follow-up" goes to active users with `no_response`. "Event reminder" goes to active users who are `attending`.
- [ ] Shows the recipient count and list before sending and requires confirmation. Sending is disabled with zero recipients.
- [ ] Subject and body are prefilled from templates (event date, location, site URL) and can be edited before sending.
- [ ] Sends through the ISSUE-022 mechanism and shows the result.

### Tests
- **Test file(s):** `tests/js/test_027_bulk_email.js`
- [ ] `selectRecipients('rsvp_followup')` returns only active `no_response` users.
- [ ] `selectRecipients('event_reminder')` returns only active `attending` users.
- [ ] Deactivated users are excluded from both.
- [ ] Templates fill in the event date and site URL.
- [ ] Send is disabled with zero recipients and requires confirmation.

### Tasks
- [ ] Write tests
- [ ] Recipient selection and templates
- [ ] Emails panel UI

### Notes
- Depends on: 020, 022.
- Email copy comes from CONTENT_CHECKLIST § RSVP Follow-Up / § Event Reminder (placeholders until delivered).

---

## [ISSUE-028] Admin — Start New Year (archive & reset)

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/028-start-new-year`
- **Spec Reference:** SPEC.md § Yearly Lifecycle (Archive + Reset)
- **PR:** —

### Description
One admin action that archives the past year and resets the site for the next event.

### Acceptance Criteria
- [ ] The admin enters the new year (defaults to current + 1), event date, theme title, and description, then must **type the year** to confirm.
- [ ] The `start_new_year(...)` RPC (admin only, single transaction):
  - inserts the new `event_settings` row
  - leaves old messages, likes, claims, and invitations in place but hidden (year-scoped queries)
  - clears every user's country and flag and resets RSVP to `no_response`
  - preserves accounts, roles, active status, and auth links
- [ ] Clearing countries creates no claims. Old flag files stay in storage as the archive.
- [ ] Prior-year pending invitation tokens stop working.

### Tests
- **Test file(s):** `tests/db/test_028_new_year.sql`, `tests/js/test_028_new_year.js`
- [ ] SQL: A non-admin call is rejected.
- [ ] SQL: A new year ≤ the current year is rejected.
- [ ] SQL: After reset, `current_event_year()` returns the new year and current-year board, feed, and claims are empty, while old rows still exist.
- [ ] SQL: All users have `no_response` and a null country and flag. User count, roles, and auth links are unchanged.
- [ ] SQL: No claims are created by the reset.
- [ ] SQL: A prior-year pending token is rejected by `claim_membership`.
- [ ] SQL: A forced mid-transaction failure leaves everything unchanged.
- [ ] JS: Confirm is enabled only when the typed year matches. The default year is current + 1.

### Tasks
- [ ] Write tests
- [ ] RPC migration
- [ ] New Year panel UI

### Notes
- Depends on: 016, 018, 021.
- Browsing archived years is out of scope (SPEC § Yearly Lifecycle).

---

## [ISSUE-029] Responsive design & accessibility pass

- **Type:** Enhancement
- **Status:** Open
- **Branch:** `issue/029-responsive-a11y`
- **Spec Reference:** SPEC.md § Responsive Design; COLORS.md
- **PR:** —

### Description
Make the whole site work well on phones and tablets, and be usable with a keyboard and screen reader.

### Acceptance Criteria
- [ ] Layout works from 320 px to desktop with no horizontal scroll. Below 768 px the sidebar becomes a banner or expandable section, and the feed and board stack or tab.
- [ ] Touch targets ≥44 px. Visible focus states. Popovers and menus are keyboard-operable. Every image has alt text and every input has a label.
- [ ] Text and link contrast meets WCAG AA in both themes. Failing tokens are **reported to the Boss with suggested values**, not silently changed.

### Tests
- **Test file(s):** `tests/js/test_029_a11y.js`
- [ ] Contrast ratios computed from the CSS tokens are ≥4.5:1 for primary text, secondary text, links, and button labels.
- [ ] Every `<img>` in the rendered views has `alt`; every input has an associated label.
- [ ] No click handlers sit on non-interactive elements (scan of the rendered DOM).
- [ ] Manual checklist: iPhone SE width, iPad, and desktop, in both themes.

### Tasks
- [ ] Write tests
- [ ] Responsive CSS pass
- [ ] Accessibility fixes
- [ ] Palette report

### Notes
- Depends on: 010, 013–019.
- Preliminary contrast check of COLORS.md, as ratios against the 4.5:1 AA target:

  | Theme | Pair | Ratio |
  |-------|------|-------|
  | Light | `--text-muted` on card | 3.45:1 |
  | Light | `--text-muted` on page | 3.19:1 |
  | Dark | `--text-link` on card | 4.10:1 |
  | Dark | white text on `--btn-primary` | 4.06:1 |
  | Dark | white text on `--btn-secondary` | 4.18:1 |

  The Boss will need to pick adjusted values.

---

## [ISSUE-030] Production deployment

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/030-production-deployment`
- **Spec Reference:** SPEC.md § Tech Stack, § Configuration; SETUP_CLOUDFLARE.md; SETUP_SUPABASE.md; DECISIONS.md ADR-003
- **PR:** —

### Description
Stand up the production Supabase project and the Cloudflare Pages site on the custom domain. The site deploys from `public/`, with `config.js` generated at deploy time (ADR-003).

### Acceptance Criteria
- [ ] The prod Supabase project has:
  - migrations and storage
  - the admin seed only, with **no test data**
  - Google and Facebook auth
  - Site URL and redirect URLs
  - Gmail SMTP
  - the email templates
- [ ] Cloudflare Pages is connected to GitHub with production branch `master` (A12), on the custom domain with SSL.
- [ ] Pages build command is `sh scripts/write-config.sh` and the build output directory is `public/`. The script writes `public/config.js` from the Pages env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY`, and fails the build if either is missing.
- [ ] A `public/_headers` file sets a Content-Security-Policy (self + the pinned CDN + Supabase origin), `X-Content-Type-Options`, `Referrer-Policy`, and `frame-ancestors 'none'`.
- [ ] SETUP_CLOUDFLARE.md and SETUP_SUPABASE.md are updated to match reality.

### Tests
- **Test file(s):** `tests/deploy/test_030_deploy.sh`
- [ ] `scripts/write-config.sh` writes a valid `public/config.js` from env vars, exits non-zero when either variable is missing, and correctly escapes quote characters in values.
- [ ] `git grep` finds no `service_role` key or other secret in the repo.
- [ ] Against production:
  - `/` and `/config.js` return 200
  - `/documentation/`, `/db/`, `/tests/`, `/scripts/` return 404
  - security headers are present
- [ ] Manual smoke checklist on prod:
  - invite link → register
  - magic link and Google sign-in
  - post and like
  - each admin panel

### Tasks
- [ ] Write tests
- [ ] `scripts/write-config.sh` and `public/_headers`
- [ ] Provision prod Supabase
- [ ] Connect Pages (build command, output dir `public/`, env vars) and the domain
- [ ] Update setup docs

### Notes
- Depends on: 001–029.
- The Boss performs the dashboard and DNS steps. Claude prepares the files, checklists, and doc updates.

---

## [ISSUE-031] Supabase keep-alive

- **Type:** Feature
- **Status:** Open
- **Branch:** `issue/031-supabase-keepalive`
- **Spec Reference:** SETUP_SUPABASE.md § Project Pausing; SPEC.md § Design Principles (Cheap to run); DECISIONS.md ADR-004
- **PR:** —

### Description
Free-tier projects pause after 7 idle days. The site sits idle for months between events, so the first visitor of the season would hit errors. Per ADR-004, a scheduled GitHub Actions job pings the project every 3 days.

### Acceptance Criteria
- [ ] `.github/workflows/keepalive.yml` runs on a schedule at least every 3 days and `curl`s `get_public_event_info` using the anon key from repo secrets.
- [ ] A failed ping fails the workflow, and GitHub emails the owner.
- [ ] The workflow also supports `workflow_dispatch`, so it can be run by hand after re-enabling.
- [ ] SETUP_SUPABASE.md § Project Pausing documents the repo secrets and the re-enable procedure.

### Tests
- **Test file(s):** `tests/deploy/test_031_keepalive.sh`
- [ ] The ping script exits 0 against dev with valid settings.
- [ ] It exits non-zero on a bad URL or key.

### Tasks
- [ ] Write tests
- [ ] Ping script and workflow
- [ ] Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` repo secrets (Boss)
- [ ] Document in SETUP_SUPABASE.md

### Notes
- Depends on: 003.
- The repo is **public** (checked 2026-11-13), so GitHub disables scheduled workflows after 60 days with no repo activity. Between events, expect an email from GitHub roughly 2–3 times a year. Then open Actions → keepalive → Enable workflow, and run it once by hand.
