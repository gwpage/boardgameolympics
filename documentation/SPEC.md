# Board Game Olympics — App Specification

## Overview

Board Game Olympics is a lightweight, invitation-only event registration website. It replaces a Facebook group as the central hub for an annual board game event organized by the host. The site allows invited guests to register, represent a country of their choosing, and interact via a simple message board.

## Design Principles

- **Static-first**: The front end is plain HTML, CSS, and vanilla JavaScript — no frameworks, no build step, no library dependencies.
- **No custom backend**: All server-side logic (auth, database, storage, email) is handled by Supabase. No Cloudflare Workers or custom API layer needed.
- **Cheap to run**: All infrastructure should target free tiers wherever possible.
- **Document everything**: This project will sit untouched for up to a year between events. Every function, module, and configuration choice should be thoroughly commented and documented as if the person reading it has never seen the codebase before — because by next year, that person is effectively you. Inline comments should explain *why*, not just *what*. Each JS file should have a header comment describing its purpose and how it fits into the app. Any non-obvious Supabase configuration (RLS policies, storage rules, auth settings) should be documented in the code or in the `documentation/` folder.

---

## Authentication

### Methods

- **SSO**: Sign in with Google, Facebook, or other major OAuth providers.
- **Magic link**: Users receive a one-time login link via email. No password required.

### Invitation-Only Access

- Only people who have received an invitation can create an account. Invitations can be sent in two ways:
  - **Email invitation** — the admin enters their email and an invite is sent automatically.
  - **Shareable invite link** — the admin generates a link and shares it manually (via text, group chat, etc.).
- Uninvited visitors who land on the site see a public landing page but cannot register or log in.

---

## User Registration & Profile

### Required Fields

| Field | Notes |
|-------|-------|
| Name | Display name used across the site |
| Email | Collected automatically from SSO or magic link |
| RSVP status | One of: **attending**, **not attending**, or **no response**. Defaults to **no response** when an invitation is sent. Set by the user during registration or at any time afterward. |

### Optional Fields

| Field | Notes |
|-------|-------|
| Country | Freeform text — can be a real country or a made-up name. Multiple users may claim the same country. Max **100 characters**. |
| Flag image | JPEG or PNG upload that represents the user's country. Max file size: **2 MB**. Max dimensions: **1024 × 1024 px**. |

### RSVP Flow

- When an invited person first visits the site, they can **RSVP yes (attending) or no (not attending)** — they don't have to commit to attending just because they registered.
- Users can **change their RSVP status at any time** from their profile (e.g., switch from attending to not attending if something comes up, or vice versa).
- The admin can also change any user's RSVP status on their behalf.

### Profile Rules

- Country and flag can be left blank at registration and added or changed later.
- Users can update their country and flag any time they log back in.
- A user's **flag image** serves as their avatar/icon throughout the site.
- Users without a flag see a **generic default icon**.

---

## Home Page (Single URL, Two Views)

The home page serves as both the public landing page and the logged-in dashboard — same URL, different content based on auth state.

### Logged-Out View (Public Landing Page)

A simple, static advertisement for the event. Minimal content:

- Event name and branding.
- Date, location, and a brief description of what Board Game Olympics is.
- A login / register button (which only works for invited users).
- No access to the activity feed, message board, or any user data.

### Sidebar — Yearly Theme

The logged-in layout includes a sidebar that displays the **current year's theme** and **event date**. Both are set and updated by the admin via the admin panel. It should include:

- The **event date**, displayed prominently at the top of the sidebar.
- A **theme title** (e.g., "Medieval Mayhem", "Space Race").
- A **theme description** — a short blurb explaining how the theme applies to this year's event.

The sidebar is visible on all authenticated pages.

### Logged-In View (Dashboard)

Once authenticated, the same page shows the main hub with two sections:

#### 1. Activity Feed

A reverse-chronological feed that shows:

- When someone **reserves or changes a country** (e.g., "Alex claimed Genovia — 2 hours ago").
- When someone **posts a message** to the board.

This gives the event a sense of momentum as people sign up and interact.

#### 2. Message Board

A simple board where registered users can post text messages (max **1,000 characters** per message).

- Messages display in **reverse chronological order** (newest first).
- Each message shows the author's **flag icon** (or generic icon), **name**, **timestamp**, and **message text**.
- **Meeple likes**: Each message has a "like" button represented by a **meeple icon**. Clicking it toggles the like on/off. The message displays a meeple count and, on hover or tap, shows who liked it. Each user can only like a message once.
- **Admin moderation**: The event host (admin) can delete any message.
- No threading or rich text — keep it simple.
- **Pagination**: Both the activity feed and message board use infinite scroll, loading in batches (e.g., 20 items at a time).

---

## Admin Panel

A protected area accessible only to the event host (admin role).

### Initial Administrator (Seed Data)

- **Name**: Wiley Page
- **Email**: gwpage@gmail.com
- **Role**: admin

This account should be created automatically during initial database setup (seed/migration). It serves as the first admin and can manage all invitations, users, and messages from day one.

### Test Data (2025 Event)

For development and testing, load the sample data from [`SEED_DATA_2025.md`](./SEED_DATA_2025.md). This includes 20 fake users with board-game-themed countries, registration dates spread across Jan 15 – Feb 14, 2025, and a set of sample messages. This data should remain unarchived so the UI can be tested against realistic content.

### Invitation Management

- **Email invitation** — enter one or more email addresses to generate and send invitations via email.
- **Shareable invite link** — generate a one-time-use (or limited-use) invite link that the admin can copy and share via text message, group chat, or any other channel. No email address required upfront — the recipient provides their info when they register through the link.
- View a list of all invitations (both email and link-based) and their status (pending, accepted).
- View all **non-responders** — people who have registered but whose RSVP status is still "no response."
- Revoke an unaccepted invitation or deactivate an unused invite link.

### User Management

- View all registered users and their profiles (name, email, country, flag, RSVP status).
- **Register a user on their behalf** — the admin can manually create an account for someone who can't register themselves (e.g., not tech-savvy, no email access). The admin enters the person's name, email, and optionally their country, flag, and RSVP status.
- **Edit any user's profile** — the admin can set or change a user's country, flag image, and RSVP status. Useful for people who didn't fill these in themselves or who communicated their status outside the app.
- **Remove a user** — deactivates their account and frees up their invitation. Useful if someone was invited by mistake.

### Theme Management

- Set or update the **event date**, **yearly theme title**, and **description**.
- Changes are reflected immediately in the sidebar for all logged-in users.

### Email Actions

The admin panel should have a dedicated section for sending bulk emails. All sends are **manual** (admin clicks a button), not scheduled. Available actions:

- **RSVP follow-up** — send a reminder to all non-responders asking them to RSVP.
- **Event reminder** — send a reminder to everyone who has RSVP'd "attending." Intended to be sent ~1 week before and ~2 days before the event, but the timing is entirely up to the admin.

### Message Moderation

- View and **delete any message** from the message board.

---

## Data Model

### Users

```
{
  id:        string (unique),
  name:      string,
  email:     string (unique),
  country:   string | null,
  flagUrl:   string | null,
  rsvp:      "attending" | "not_attending" | "no_response",
  role:      "admin" | "user",
  createdAt: timestamp
}
```

### Invitations

```
{
  id:        string (unique),
  type:      "email" | "link",
  email:     string | null (required for email invites, null for link invites until accepted),
  token:     string (unique, used in invite link),
  status:    "pending" | "accepted",
  createdAt: timestamp,
  acceptedAt: timestamp | null
}
```

### Messages

```
{
  id:        string (unique),
  userId:    string (foreign key → Users),
  text:      string,
  createdAt: timestamp
}
```

### Message Likes ("Meeples")

```
{
  id:        string (unique),
  messageId: string (foreign key → Messages),
  userId:    string (foreign key → Users),
  createdAt: timestamp,
  UNIQUE(messageId, userId)   ← one like per user per message
}
```

### Event Settings (Theme)

```
{
  id:          string (unique),
  year:        integer (e.g., 2026),
  eventDate:   date,
  themeTitle:  string,
  themeDesc:   string,
  updatedAt:   timestamp
}
```

### Country Claims (Activity Feed)

```
{
  id:        string (unique),
  userId:    string (foreign key → Users),
  country:   string,
  claimedAt: timestamp
}
```

---

## Tech Stack

### Front End

- **HTML / CSS / vanilla JavaScript** — no frameworks, no bundler, no transpilation.
- Single-page or multi-page static site (developer's choice during build).
- Hosted on **Cloudflare Pages** (free tier). Custom domain already reserved — will be configured via Cloudflare DNS.

### Configuration

Since there is no build step, a traditional `.env` file won't work. Instead, use a `config.js` file loaded via `<script>` tag before the main application code. This file holds the Supabase connection details (which are safe to expose client-side — Row Level Security protects the data, not the key).

```js
// config.js
const CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key-here'
};
```

A `config.example.js` with placeholder values should be committed to the repo. The real `config.js` should be added to `.gitignore` so credentials stay out of version control.

### Database & Auth

- **Supabase** (free tier) provides:
  - **PostgreSQL database** — 500 MB storage, more than sufficient for this use case.
  - **Supabase Auth** — built-in support for Google/Facebook OAuth and magic link authentication.
  - **Supabase Storage** — for flag image uploads (1 GB free).
- The Supabase JS client can be loaded via CDN `<script>` tag — no build tools required.

### File Storage (Flag Images)

- **Supabase Storage** — flag images stored in a dedicated bucket with public read access and authenticated upload.

### Email (Invitations, Magic Links & Reminders)

- **Magic links**: Handled natively by Supabase Auth.
- **All other emails** (invitations, RSVP follow-ups, event reminders): Sent via Supabase using **Gmail SMTP** as the custom mail provider. See [`SETUP_SUPABASE.md`](./SETUP_SUPABASE.md) for configuration details.

### Project Structure

```
board-game-olympics/
├── index.html                  ← Landing page / dashboard (single URL, two views)
├── config.js                   ← Real Supabase credentials (gitignored)
├── config.example.js           ← Placeholder credentials (committed to repo)
├── css/
│   └── styles.css              ← All site styles in one file
├── js/
│   ├── theme.js                ← Light/dark mode toggle, system preference detection (also inline in <head>)
│   ├── app.js                  ← Main entry point, routing, auth state handling
│   ├── auth.js                 ← Login, logout, magic link, SSO logic
│   ├── supabase.js             ← Supabase client initialization
│   ├── feed.js                 ← Activity feed rendering and infinite scroll
│   ├── messages.js             ← Message board posting, rendering, infinite scroll
│   ├── profile.js              ← Profile editing, country selection, flag upload, RSVP
│   ├── rules.js                ← Rules page rendering
│   └── admin.js                ← Admin panel: invitations, users, theme, emails, moderation
├── assets/
│   ├── images/
│   │   ├── logo.png            ← Site logo
│   │   ├── logo-small.png      ← Favicon / small version
│   │   ├── default-avatar.png  ← Generic icon for users without a flag
│   │   ├── meeple.svg          ← Meeple icon used for the "like" button
│   │   └── og-image.png        ← Open Graph social sharing image
│   └── favicon.ico
├── documentation/              ← Spec, setup guides, content checklist
│   ├── SPEC.md
│   ├── SETUP_CLOUDFLARE.md
│   ├── SETUP_SUPABASE.md
│   ├── CONTENT_CHECKLIST.md
│   └── COLORS.md
└── .gitignore
```

**Guiding principles for the structure:**

- **One JS file per feature** — each file handles one area of the app. If a file gets too long, split it further, but start here.
- **CSS in one file** — for a small app, a single stylesheet is easier to maintain than scattered styles. Use comments to section it (e.g., `/* === Message Board === */`).
- **Assets separate from code** — images and icons in their own folder so they're easy to find and replace.
- **Documentation lives alongside the code** — the `documentation/` folder ships with the repo so anyone picking up the project has context.

### .gitignore

The `.gitignore` file is already created in the project root. It covers credentials (`config.js`), OS files, editor files, Claude Code (`.claude/`), Node modules (in case dev tooling is added later), and environment files. See the file directly for the full list.

---

## Page Structure

| Page | Access | Description |
|------|--------|-------------|
| **Home (logged out)** | Public | Simple event advertisement — name, date, location, description, and a login button. No user data visible. |
| **Home (logged in)** | Authenticated | Activity feed + message board. The main hub. |
| **Rules** | Authenticated | Event rules, how-to-play info, and a link to the external Google Sheet with the game list and point values. |
| **Profile** | Authenticated | View and edit your name, country, flag image, and RSVP status. |
| **Admin panel** | Admin only | Manage invitations, view users, send emails, moderate messages. |

---

## Yearly Lifecycle (Archive + Reset)

Board Game Olympics is an annual event. At the start of each new year's cycle, the admin resets the site for the new event:

- **Country claims** and **messages** from the previous year are archived (retained in the database) but no longer displayed in the UI.
- **User accounts persist** across years — returning participants don't need to re-register. However, their country, flag, and **RSVP status** are cleared (RSVP resets to "no response") for the new year so they can start fresh.
- **Invitations reset** — the admin sends a new round of invitations each year. Previous invitation records are archived.
- The admin updates the **event date**, **theme title**, and **theme description** for the new year via the admin panel.
- Archived data is kept in the database for the admin's records but is **not browsable in the app** (potential future feature).
- The admin panel should include a **"Start New Year"** action that handles the reset process.

---

## Session Management

- Users stay logged in via Supabase Auth session tokens, persisted in a **cookie** (not just `localStorage`) so the session survives browser restarts.
- The session cookie should be set to **not expire** (or have a very long max-age, e.g., 1 year). Users should stay logged in indefinitely unless they explicitly log out.
- Supabase Auth's `persistSession` option should be enabled, and the storage mechanism should be configured to use cookies. If Supabase's JS client doesn't natively support cookie storage, the session token can be mirrored to a cookie on login and read back on page load.
- A **logout button** is available on all authenticated pages. Logging out clears the session cookie.

---

## Responsive Design

- The site should be **mobile-friendly and responsive**. No native mobile app, but the layout should work well on phones and tablets.
- The sidebar (yearly theme) can collapse to a top banner or expandable section on small screens.

---

## Non-Goals (Out of Scope for V1)

- Game scheduling or bracket management.
- Real-time chat or WebSocket features.
- Mobile app (the site should be responsive, but no native app).
- Payment processing.
- Photo gallery or file sharing beyond flag images.
- Dynamically reading the Google Sheet game list into the app (see Future Enhancements).

---

## Future Enhancements

Ideas for potential future versions, not part of V1:

- **Dynamic Google Sheet integration** — instead of linking to the game list / point values spreadsheet, fetch it directly from a published Google Sheet and display it as a table within the Rules page. This is technically feasible (publish the sheet to the web and fetch as CSV/JSON), but adds a runtime dependency on Google's servers and parsing/display logic. Keeping it as a simple link for V1 avoids this complexity.

---

## Open Questions

No open questions — all major architectural decisions have been made.
