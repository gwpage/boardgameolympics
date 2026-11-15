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

Supabase Auth handles both SSO (OAuth) and magic links out of the box.

### Enable Magic Link (Email Login)

1. Go to **Authentication** → **Providers** in the Supabase dashboard.
2. **Email** provider is enabled by default. Magic link is supported natively.
3. Under **Authentication** → **Email Templates**, you can customize the magic link email template to match your event branding.

### Configure Email for Invitations

Supabase includes a built-in email service (via GoTrue) that handles magic links out of the box. The same service can be used to send invitation emails. To keep the stack minimal, we'll use Supabase for all email needs.

**Important: Built-in email limitations**

Supabase's default email sender has rate limits (around 2–3 emails per hour on the free tier). This is fine for development and testing, but if you need to send a batch of invitations at once, you should configure a custom SMTP provider:

1. Go to **Project Settings** → **Authentication** → **SMTP Settings**.
2. Toggle on **"Enable Custom SMTP"**.
3. Enter your **Gmail SMTP** credentials:
   - **Host**: `smtp.gmail.com`
   - **Port**: `587`
   - **Username**: your Gmail address (e.g., `gwpage@gmail.com`)
   - **Password**: a Gmail App Password (not your regular password — see below)
   - Free, 500 emails/day limit — more than enough for this project.
4. Set the **Sender name** to "Board Game Olympics" and **Sender email** to your Gmail address.
5. Click **Save**.

**How to generate a Gmail App Password:**

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security).
2. Ensure **2-Step Verification** is turned on (required for App Passwords).
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
4. Create a new app password (name it something like "Board Game Olympics").
5. Copy the 16-character password and paste it into the Supabase SMTP settings.

**Customize the invitation email template:**

1. Go to **Authentication** → **Email Templates**.
2. Select the **"Invite"** template.
3. Customize the subject line and body to match the Board Game Olympics branding. The template supports variables like `{{ .Token }}` and `{{ .SiteURL }}` for generating the invite link.

### Enable Google OAuth

1. Go to **Authentication** → **Providers** → **Google**.
2. Toggle it on.
3. You'll need a Google OAuth Client ID and Secret:
   - Go to [console.cloud.google.com](https://console.cloud.google.com).
   - Create a new project (or use an existing one).
   - Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth Client ID**.
   - Application type: **Web application**.
   - Authorized redirect URI: `https://your-project.supabase.co/auth/v1/callback`
   - Copy the **Client ID** and **Client Secret** back into the Supabase provider settings.
4. Click **Save**.

### Enable Facebook OAuth

1. Go to **Authentication** → **Providers** → **Facebook**.
2. Toggle it on.
3. You'll need a Facebook App ID and Secret:
   - Go to [developers.facebook.com](https://developers.facebook.com).
   - Create a new app (type: **Consumer**).
   - Under **Facebook Login** → **Settings**, add the redirect URI: `https://your-project.supabase.co/auth/v1/callback`
   - Copy the **App ID** and **App Secret** back into the Supabase provider settings.
4. Click **Save**.

### Configure Redirect URLs

1. Go to **Authentication** → **URL Configuration**.
2. Set your **Site URL** to your custom domain (e.g., `https://boardgameolympics.com`).
3. Add any additional redirect URLs if needed (e.g., `http://localhost:3000` for local development).

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

**Check it worked (dev project only):** paste and run each test file in `tests/db/` in number order (`test_002_schema.sql`, `test_003_rls.sql`, …). They change nothing (everything is rolled back), and each passes with "Success. No rows returned". See the [developer guide](./README.md#database-tests-sql) for details.

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

## Step 7: Seed the Admin User

After setting up auth, you'll need to ensure the initial admin account is recognized. The approach depends on implementation, but typically:

1. The admin (Wiley Page, gwpage@gmail.com) signs up or logs in normally.
2. A database trigger or manual SQL update sets their role to `admin`:
   ```sql
   UPDATE users SET role = 'admin' WHERE email = 'gwpage@gmail.com';
   ```
3. Alternatively, seed the admin record during the initial database migration.

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
