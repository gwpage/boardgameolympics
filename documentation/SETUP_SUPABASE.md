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

---

## Step 3: Get Your API Keys

Once the project is ready:

1. Go to **Project Settings** → **API** (in the left sidebar under "Configuration").
2. Note down two values:
   - **Project URL**: Something like `https://abcdefg.supabase.co` — this is your API endpoint.
   - **anon (public) key**: A long JWT string. This is safe to use in client-side JavaScript.
3. You'll use these in your static site's JavaScript to connect to Supabase:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script>
     const supabase = supabase.createClient(
       'https://your-project.supabase.co',
       'your-anon-key'
     );
   </script>
   ```

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

1. Go to **Storage** in the left sidebar.
2. Click **"New bucket"**.
3. Name it `flags`.
4. Set it to **Public** (so flag images can be displayed without authentication).
5. Click **"Create bucket"**.
6. Set up a storage policy to allow authenticated users to upload:
   - Go to the `flags` bucket → **Policies** tab.
   - Add a policy for **INSERT** that allows authenticated users (`auth.role() = 'authenticated'`).
   - Add a policy for **SELECT** that allows public access (so flags display for everyone).
   - Add a policy for **UPDATE** and **DELETE** so users can replace their own flag.

---

## Step 6: Create the Database Tables

You can run SQL directly in the Supabase dashboard:

1. Go to **SQL Editor** in the left sidebar.
2. Click **"New query"**.
3. You'll create the tables defined in `SPEC.md` (Users, Invitations, Messages, Message Likes, Event Settings, Country Claims) here. The exact SQL will be written during implementation, but the schema is outlined in the spec.

### Enable Row Level Security (RLS)

Supabase exposes your database via a public REST API, so **Row Level Security is essential**. Every table should have RLS enabled with appropriate policies:

- **Users**: Users can read all profiles, but only update their own (name, country, flag, RSVP). Admins can update any user.
- **Invitations**: Only admins can create, read, and revoke invitations.
- **Messages**: Authenticated users can read all and create their own. Admins can delete any.
- **Country Claims**: Authenticated users can read all. Users can create their own.
- **Message Likes**: Authenticated users can read all. Users can insert and delete their own likes (toggle behavior).
- **Event Settings**: All authenticated users can read (needed to display the sidebar). Only admins can update.

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
