# Supabase Setup Guide

This guide walks you through signing up for Supabase and configuring the database, authentication, and file storage for Board Game Olympics.

---

## Step 1: Create a Supabase Account

1. Go to [supabase.com](https://supabase.com) and click **"Start your project"**.
2. Sign up with your GitHub account (easiest) or with email and password.
3. No credit card required for the free tier.

---

## Step 2: Create a New Project

1. Once logged in, click **"New Project"**.
2. Fill in the details:
   - **Project name**: `board-game-olympics` (or whatever you prefer).
   - **Database password**: Choose a strong password and save it somewhere safe. You'll need this if you ever connect directly to PostgreSQL.
   - **Region**: Pick the region closest to the majority of your event attendees (e.g., `us-east-1` for the eastern US).
3. Click **"Create new project"**. It takes about a minute to provision.

**Create two projects:** `board-game-olympics-dev` for development and testing, and `board-game-olympics` for production. The free tier allows two. Follow this guide for each. The dev project gets the 2025 test data, and SQL tests run there; production never gets either.

---

## Step 3: Get Your API Keys

Supabase is retiring the legacy JWT-based `anon` and `service_role` keys **by the end of 2026**. This project uses only the keys that replace them ([ADR-014](./DECISIONS.md)):

| Key | Looks like | Replaces | Where it goes |
|-----|------------|----------|---------------|
| **Publishable** | `sb_publishable_…` | `anon` | Anywhere public: `public/config.js`, the Cloudflare Pages env var, the GitHub Actions secret |
| **Secret** | `sb_secret_…` | `service_role` | Server-side only. The `invite-user` Edge Function reads it from its environment automatically, so you never copy it anywhere. |

### Find the URL and publishable key

1. Open the project and click **Connect** at the top of the dashboard.
2. Note down two values:
   - **Project URL**: something like `https://abcdefg.supabase.co`. This is your API endpoint.
   - **Publishable key**: starts with `sb_publishable_`.
3. Put them where they're needed:
   - **Local development (dev project):** copy `public/config.example.js` to `public/config.js` and fill in `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. See the [developer guide](./README.md#local-development).
   - **Production:** set the Cloudflare Pages environment variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (ISSUE-030).

The app creates its Supabase client from these values in `public/js/supabase.js`. You don't need to paste any code.

### Create the new keys, if the project doesn't have them yet

1. Go to **Project Settings** → **API Keys** and open the **Publishable and secret API keys** tab.
2. If you see a **Create new API keys** button, the project still has only legacy keys. Click it. This creates a publishable key and a secret key, each named `default`.

### Deactivate the legacy keys

Creating new keys does **not** turn off the old ones. This project never uses the legacy keys, so turn them off on both projects. Then a leaked old key is useless.

1. Go to **Project Settings** → **API Keys**, the same page as above.
2. Deactivate the legacy `anon` and `service_role` keys. You can reactivate them later if needed.

### Rules for the keys

- **The publishable key is safe to expose.** Row Level Security protects the data, not the key. Requests made with it run as the Postgres role `anon` when nobody is signed in, and as `authenticated` when a user is. The RLS policies are written for those two roles, and the role names haven't changed.
- **The secret key is never exposed.** It runs as `service_role`, which bypasses RLS completely. Never put it in `public/`, `config.js`, a Pages env var, a GitHub secret, a chat or a screenshot. Supabase rejects a secret key sent from a browser with HTTP 401, but a leaked key is still dangerous from anywhere else. If it leaks, create a new secret key on the **API Keys** page, then delete the leaked one. Revoking a secret key doesn't sign anybody out.
- **Send keys in the `apikey` header only.** `Authorization: Bearer …` is reserved for a signed-in user's access token. Supabase rejects a new-style key there as "Invalid JWT". supabase-js does this for you; it matters for hand-written `curl` calls such as the keep-alive ping (ISSUE-031).
- **JWT signing keys are a separate migration.** Your users' sessions are still signed with the project's legacy JWT secret. Switching to JWT signing keys is a separate migration from the API key change and isn't needed for this guide.

---

## Step 4: Set Up Authentication

People sign in with Google, Facebook, or a magic link (a one-time link by email). Signing in only proves who someone is. Whether they get in is decided afterwards by the site's database: the `claim_membership` check (ISSUE-012) and Row Level Security. So Supabase itself must let new people sign up, and the site does the turning away. How the site uses all this is in ADR-025 and `public/js/auth.js`.

The dashboard gets rearranged from time to time. If a menu below has moved, search the dashboard for the setting's name.

### Keep sign-ups switched on

**Authentication → Sign In / Providers → User Signups → Allow new users to sign up: on.**

An invited guest's first sign-in creates their Supabase account. With sign-ups off, every new guest is locked out. Someone who signs up without an invitation gets an account with no profile behind it, so they see "You're not on the guest list" and can't read anything.

### Enable Magic Link (Email Login)

1. **Authentication → Sign In / Providers → Email**: enabled (it is by default). Leave **Confirm email** on.
2. **Email OTP Expiration**: leave it at 3600 seconds (1 hour). A link used after that, or used twice, brings the visitor back to the site with "That sign-in link has expired or has already been used".
3. Nothing else to set. The site decides who may get a *new* account by magic link. It asks Supabase to create one only when the visitor arrived with an invite token (`?invite=…`). Without one, an unknown address is refused (`otp_disabled`), and the site says there's no account yet.

Seeded and admin-created guests have a profile but no Supabase account yet. Their first sign-in must be with Google or Facebook, or through an invite link. (ISSUE-012 links the account to the profile by email.)

### Email templates

**Authentication → Emails → Templates** (older dashboards: **Authentication → Email Templates**). Three templates matter:

| Template | When it's sent |
|----------|----------------|
| **Magic Link** | A returning guest asks for a sign-in link. |
| **Confirm signup** | Probably: a first-time guest asks for a link with an invite token, while **Confirm email** is on. Supabase's docs don't say which of these two a brand-new address gets. The manual sign-in checklist (`tests/manual/test_011_sign_in.md`) records which one arrives. Brand both. |
| **Invite** | The admin invites someone by email (ISSUE-022, ISSUE-023). |

In every template, **the link must be `{{ .ConfirmationURL }}`**. It carries the `redirect_to` the site asked for, and that is where the invite token travels. A link built from `{{ .SiteURL }}` sends the guest to the home page without their token. If you ever build the link by hand, use `{{ .RedirectTo }}`, never `{{ .SiteURL }}`.

The wording to use is in [CONTENT_CHECKLIST.md](./CONTENT_CHECKLIST.md) § Copy — Magic Link Email.

### Configure Email (SMTP)

Supabase's built-in email is for trying things out:
- It only sends to members of your Supabase organization. Anyone else is refused (`email_address_not_authorized`), and the site says "The site can't send email to that address yet".
- It sends about 2 emails an hour.

So configure a custom SMTP provider before anyone else uses the site:

1. Go to **Authentication → Emails → SMTP Settings** (older dashboards: **Project Settings → Authentication → SMTP Settings**).
2. Toggle on **"Enable Custom SMTP"**.
3. Enter your **Gmail SMTP** credentials:
   - **Host**: `smtp.gmail.com`
   - **Port**: `587`
   - **Username**: your Gmail address (e.g., `gwpage@gmail.com`)
   - **Password**: a Gmail App Password (not your regular password — see below)
   - Free, 500 emails/day limit — more than enough for this project.
4. Set the **Sender name** to "Board Game Olympics" and **Sender email** to your Gmail address.
5. Click **Save**.
6. **Authentication → Rate Limits**: with custom SMTP, Supabase allows 30 emails an hour by default. Raise it if you'll send a big batch of invitations at once.

**How to generate a Gmail App Password:**

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security).
2. Ensure **2-Step Verification** is turned on (required for App Passwords).
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
4. Create a new app password (name it something like "Board Game Olympics").
5. Copy the 16-character password and paste it into the Supabase SMTP settings.

### Enable Google OAuth

1. In [console.cloud.google.com](https://console.cloud.google.com), create a project (or use an existing one).
2. Set up the **OAuth consent screen** (Google Auth Platform → Branding, Audience):
   - **App name**: Board Game Olympics. **User support email** and **developer contact**: your address.
   - **Authorized domains**: `boardgameolympics.net`, and your Supabase project's domain, `<project-ref>.supabase.co`.
   - **Scopes**: `openid`, `…/auth/userinfo.email` and `…/auth/userinfo.profile`. These are all Supabase asks for. They're non-sensitive, so Google doesn't need to review the app.
   - **Audience → Publishing status: In production.** While it says **Testing**, only the test users you list can sign in, and everyone else is turned away by Google.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback` (shown on the Supabase Google provider page as **Callback URL**). No JavaScript origins are needed.
4. In Supabase, **Authentication → Sign In / Providers → Google**: turn it on, and paste the **Client ID** and **Client Secret**. Click **Save**.

Google's sign-in screen says you're continuing to `<project-ref>.supabase.co`, not to boardgameolympics.net. Changing that needs Supabase's paid custom-domain add-on; it isn't worth it for this site.

### Enable Facebook OAuth

1. In [developers.facebook.com](https://developers.facebook.com), **Create app**. Choose the use case **Authenticate and request data from users with Facebook Login** (older dashboards ask for an app type instead: choose **Consumer**). Meta changes this flow often; the goal is an app with Facebook Login.
2. In the Facebook Login use case, add the **email** permission next to **public_profile**. Without `email`, Supabase can't learn the guest's address, and the sign-in fails.
3. **Facebook Login → Settings → Valid OAuth Redirect URIs**: `https://<project-ref>.supabase.co/auth/v1/callback`.
4. **App settings → Basic**: fill in **App domains** (`boardgameolympics.net`), **Privacy Policy URL**, **User data deletion** (an instructions URL is enough), a category and an icon. Meta won't let the app go live without the privacy policy and deletion instructions. The site has neither yet; see [CONTENT_CHECKLIST.md](./CONTENT_CHECKLIST.md) § Legal Pages.
5. **Publish** the app (switch it to **Live**). In development mode, only people with a role on the app can sign in.
6. In Supabase, **Authentication → Sign In / Providers → Facebook**: turn it on, and paste the **App ID** and **App Secret**. Click **Save**.

**Until Facebook is switched on in Supabase**, the "Continue with Facebook" button leads to a bare Supabase error page (`Unsupported provider: provider is not enabled`), not back to the site. If Facebook won't be set up, remove it from `LOGIN_PROVIDERS` in `public/js/auth.js`.

### Configure Redirect URLs

After signing in, Supabase sends the visitor back to the address the site asks for: the page plus `?invite=<token>` when there is one. Supabase only does that for addresses on its allow list. **An address that isn't allowed is replaced by the Site URL**, so sign-in still works but the invite token is lost on the way, and the guest ends up "not on the guest list".

**Authentication → URL Configuration**:

| Project | Site URL | Redirect URLs |
|---------|----------|---------------|
| prod | `https://boardgameolympics.net` | `https://boardgameolympics.net/**` |
| dev | `http://localhost:8000/public/` | `http://localhost:8000/**` and `http://127.0.0.1:8000/**` |

- `**` matches anything, including `/public/` and `?invite=…`. A single `*` stops at `/` and `.`, so it isn't enough.
- Supabase also accepts addresses on the Site URL's own host, but its docs don't promise it, so prod lists its own domain anyway.
- If the site also answers at `www.boardgameolympics.net`, either redirect `www` to the bare domain (ISSUE-030) or add `https://www.boardgameolympics.net/**`.
- Supabase's own callback (`https://<project-ref>.supabase.co/auth/v1/callback`) goes in the Google and Facebook consoles, not here.

To check it works: follow the manual sign-in checklist (`tests/manual/test_011_sign_in.md`). The invite token must still be in the address bar after signing in.

---

## Step 5: Set Up Storage (for Flag Images)

**Nothing to click.** The `flags` bucket and its access rules come from `db/migrations/003_storage.sql`, which you apply with the other migrations in Step 6. It needs the helper functions from `001_schema.sql`, so it can't run any earlier.

What it sets up ([ADR-018](./DECISIONS.md)):

- A **public** bucket named `flags`. Anyone can load a flag image from its URL, signed in or not.
- Uploads are limited to **2 MB** (2,097,152 bytes) and to **JPEG or PNG**. The Storage API refuses anything else. The 1024 × 1024 px limit is checked by the upload form (ISSUE-015), because a bucket can't check it.
- Each member has a folder named after their profile id: `flags/{member id}/{timestamp}.png`.

| Who | Can do in `flags` |
|-----|-------------------|
| **Anyone** | Load a flag from its public URL. Nobody can list the bucket. |
| **Member** | Upload, replace, rename and delete files in their own folder only. |
| **Admin** | The same, in every member's folder, to set a flag for someone. |
| **Signed in, not a member**, or signed out | Nothing. |

**If the bucket was set up by hand from an older version of this guide** (the dev project was), the migration corrects the bucket's settings. It doesn't remove hand-made policies, though, and Postgres combines policies with OR, so one loose policy undoes the rules above. Before running `test_004_storage.sql`, go to **Storage** → **Policies** and delete every policy on the `flags` bucket that isn't one of `flags_select`, `flags_insert`, `flags_update` or `flags_delete`. If you miss one, the test fails and names it.

The project-wide upload limit (**Storage** → **Settings**, 50 MB on the free plan) is well above 2 MB, so leave it alone.

---

## Step 6: Create the Database Tables

The schema lives in `db/migrations/`, as numbered SQL files. Apply them **in order**, once per project:

1. Go to **SQL Editor** in the left sidebar.
2. Click **"New query"**.
3. Paste the whole of `db/migrations/001_schema.sql` and click **Run**. Expect "Success. No rows returned".
4. Repeat for each later migration file (`002_…`, `003_…`) in number order.

Each migration runs in a single transaction, so it applies completely or not at all. Re-running one is harmless.

**Check it worked (dev project only):** paste and run each test file in `tests/db/` in number order (`test_002_schema.sql`, `test_003_rls.sql`, `test_004_storage.sql`). `test_005_seed.sql` checks the seed data, so run it after Step 7. The tests change nothing (everything is rolled back), and each passes with "Success. No rows returned". See the [developer guide](./README.md#database-tests-sql) for details.

### Enable Row Level Security (RLS)

Supabase exposes your database via a public REST API, so **table privileges and Row Level Security are the real security boundary**. The publishable key in the browser is not a secret.

- `001_schema.sql` turns RLS on for every table, with no policies.
- `002_rls.sql` adds the privileges and policies. It revokes every privilege from the API roles, then grants back exactly what each one needs. Supabase's default privileges for new tables differ between projects, so nothing relies on them ([ADR-015](./DECISIONS.md)).

The access rules (details in [ADR-015 – ADR-017](./DECISIONS.md) and the comments in `002_rls.sql`):

| Who | Can do |
|-----|--------|
| **Signed out** (`anon`) | Nothing on any table. Can call `get_public_event_info()`, which returns only the current event's year and date. |
| **Signed in, not a member** (never invited, or deactivated) | Nothing. Sees no rows anywhere. |
| **Member** | Read the name, country, flag, RSVP and role of active members, but **not emails**. Update their own name, country, flag and RSVP. Read and post this year's messages, as themselves. Like and unlike as themselves. Read this year's country claims and the event settings. |
| **Admin** | Everything a member can, plus: see deactivated profiles, and every email via `admin_list_users()`. Edit anyone's name, country, flag and RSVP. Read, create and revoke invitations. Delete any message. Create and edit event settings. |

Nobody can, through the API:
- edit a message, or delete one unless they're the admin;
- write a country claim (a trigger records them, [ADR-011](./DECISIONS.md));
- delete a profile, invitation or event settings;
- read earlier years' messages and claims (they stay in the database as the archive, visible in the dashboard).

Role, email and deactivation changes go through admin RPCs (ISSUE-024).

**Client rule:** reads of `users` must list their columns (`id, name, country, flag_url, rsvp, role, created_at`). `select=*` asks for the hidden email column too, so it is refused.

---

## Step 7: Seed the Data

The seed scripts are in `db/seed/`. Apply them after all the migrations, the same way: **SQL Editor** → **New query** → paste the whole file → **Run**.

| File | Apply to | What it adds |
|------|----------|--------------|
| `001_admin.sql` | **Every project, prod included** | The first admin: Wiley Page, gwpage@gmail.com. |
| `002_test_data_2025.sql` | **Dev only. Never prod.** | The 2025 test event from [`SEED_DATA_2025.md`](./SEED_DATA_2025.md): the event settings, 20 fake people with their countries and claims, 20 messages and 49 likes. |

1. Apply `db/seed/001_admin.sql`.
2. **Dev only:** apply `db/seed/002_test_data_2025.sql`.
3. **Dev only:** run `tests/db/test_005_seed.sql`. It passes with "Success. No rows returned". Run it right after seeding: once you've changed a seeded person's data on dev (say, liking a message as Wiley), it fails, and that's expected.

Each file runs in one transaction, and both are safe to run again. They add only what's missing and never change or delete an existing row ([ADR-019](./DECISIONS.md)). So re-seeding won't undo anything you've changed on dev.

**How the admin gets admin rights.** The seed creates the profile but doesn't link it to a login. The first time someone signs in with gwpage@gmail.com, the app links that login to the profile (ISSUE-012), and that account is the admin from then on. The fake people have no login, so nobody can sign in as them.

**The test-data script refuses to run**, and changes nothing, if `001_admin.sql` hasn't been applied or if the database already has an event after 2025. The second check keeps it out of prod once a real event has been set up. A brand-new prod project has no events yet, though, so there the only protection is not pasting it in.

**On prod**, there's no event until the admin sets the date and theme in the admin panel (ISSUE-025). Do that before sending any invitations (ADR-008).

**Locked out of admin?** For example, if the admin profile was deactivated or demoted by mistake. Re-running the seed won't fix that, because it never changes an existing row. Run this in the SQL Editor instead:

```sql
update public.users
set role = 'admin', is_active = true, deactivated_at = null
where lower(email) = 'gwpage@gmail.com';
```

---

## Important: Free Tier Limitations

### Project Pausing

**Supabase free tier projects are paused after 7 days of inactivity.** This means if nobody hits the API for a week, your project goes to sleep and users will see errors until it's manually reactivated from the dashboard.

Mitigation options:

- **Upgrade to the Pro plan** ($25/month) before the event registration period to ensure 24/7 availability.
- **Set up a cron job** (e.g., via Cloudflare Workers with a scheduled trigger) to ping your Supabase project periodically and keep it active.
- **Accept the limitation** if the site is only needed during a short registration window when people will be actively using it.

### Free Tier Limits

| Resource | Limit |
|----------|-------|
| Projects | 2 |
| Database storage | 500 MB |
| Database egress | 2 GB / month |
| Auth MAUs | 50,000 |
| File storage | 1 GB |
| Storage egress | 2 GB / month |
| Edge function invocations | 500,000 / month |

All of these are well beyond what Board Game Olympics will need.

---

## Useful Links

- [Supabase documentation](https://supabase.com/docs)
- [Supabase Auth guides](https://supabase.com/docs/guides/auth)
- [Supabase Storage guides](https://supabase.com/docs/guides/storage)
- [Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase JS client reference](https://supabase.com/docs/reference/javascript/)
- [Supabase pricing](https://supabase.com/pricing)
