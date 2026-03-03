# Content Checklist — Board Game Olympics

Everything you need to prepare before (or alongside) development. Check items off as you go.

---

## Graphics

- [ ] **Site logo** — a Board Game Olympics logo for the header and browser favicon. Provide in at least two sizes: a full logo (for the header/landing page) and a small square version (for the favicon / browser tab icon).
- [ ] **Favicon** — `favicon.ico` or `favicon.png`, ideally 32×32 and 180×180 (for Apple touch icon). Can be a simplified version of the logo.
- [ ] **Default user icon** — a generic avatar/placeholder shown for users who haven't uploaded a flag image. Something neutral that fits the board game / Olympics theme.
- [ ] **Landing page hero image or illustration** (optional) — a banner or background image for the logged-out landing page to make it visually appealing. Could be a photo from a past event, a themed illustration, or just a solid color/gradient with the logo.
- [ ] **Meeple icon** — an SVG meeple silhouette used as the "like" button on message board posts. Should work at small sizes (~20px) and look good in both light and dark themes. Provide as `meeple.svg` so it can be colored via CSS. A simple, recognizable board game meeple shape is ideal.
- [ ] **Open Graph / social sharing image** — a 1200×630 image shown when someone shares the site URL on social media or in a messaging app. Typically the logo + event name on a branded background.

---

## Copy — Landing Page (Logged Out)

- [ ] **Event name** — confirm the display name (e.g., "Board Game Olympics" or "Board Game Olympics 2026").
- [ ] **Tagline or subtitle** — a one-liner that sells the event (e.g., "An annual showdown of strategy, luck, and glory.").
- [ ] **Event description** — 2–3 sentences explaining what Board Game Olympics is, who it's for, and why it's fun. This is what uninvited visitors will see.
- [ ] **Location** — where the event is held (address, city, or general area — whatever you're comfortable sharing publicly).

---

## Copy — Yearly Theme (Sidebar)

These are entered via the admin panel, but you should have them ready for the initial setup:

- [ ] **Event date** — the date of this year's event.
- [ ] **Theme title** — this year's theme name (e.g., "Medieval Mayhem").
- [ ] **Theme description** — a short blurb (1–3 sentences) explaining the theme and how it applies to this year's event.

---

## Copy — Invitation Email

- [ ] **Email subject line** — something that grabs attention in an inbox (e.g., "You're Invited to Board Game Olympics 2026!").
- [ ] **Email body** — a short message explaining what the event is, when it is, and that the recipient has been invited. Should include a clear call-to-action linking to the site. Supabase email templates support variables like `{{ .SiteURL }}` and `{{ .Token }}` for the invite link.

---

## Copy — Rules Page

- [ ] **Event rules** — the full set of rules for Board Game Olympics. How does scoring work? How are winners determined? What's the format (tournament, round-robin, free play)?
- [ ] **Code of conduct / house rules** (optional) — any behavioral expectations (e.g., good sportsmanship, cleanup responsibilities).
- [ ] **Schedule or format overview** — what happens on event day? Is there a structure to the day (rounds, breaks, finals)?
- [ ] **FAQ** (optional) — common questions from past years (e.g., "Can I bring my own games?", "Is food provided?").
- [ ] **Google Sheet link** — the URL to your published Google Sheet containing the game list and point values (1st, 2nd, 3rd place). Make sure the sheet is set to "Anyone with the link can view."

---

## Copy — Magic Link Email

- [ ] **Email subject line** — (e.g., "Your Board Game Olympics Login Link").
- [ ] **Email body** — brief message with the magic link. Supabase provides a default template, but you can customize it to match your branding.

---

## Copy — RSVP Follow-Up Email

- [ ] **Email subject line** — a friendly nudge for people who haven't responded yet (e.g., "Are you coming to Board Game Olympics 2026?").
- [ ] **Email body** — a short reminder that they've been invited but haven't RSVP'd yet, with a link back to the site to respond.

---

## Copy — Event Reminder Email (Attending Confirmees)

- [ ] **Email subject line** — a reminder for people who RSVP'd yes (e.g., "Board Game Olympics is in 1 week!" / "Board Game Olympics is this Saturday!").
- [ ] **Email body** — a quick reminder with the event date, location, and any last-minute details. Sent manually by the admin, typically ~1 week and ~2 days before the event.

---

## Copy — Meta / SEO

- [ ] **Page title** — what shows in the browser tab (e.g., "Board Game Olympics — Annual Board Game Showdown").
- [ ] **Meta description** — a ~160-character summary for search engines and social previews (e.g., "Join the annual Board Game Olympics — an invite-only gathering of board game enthusiasts competing for glory.").

---

## Decisions

- [x] **Color scheme** — defined in [`COLORS.md`](./COLORS.md). Light theme (default) and dark theme ("Game Night Mode") with full CSS variable tokens, implementation guide, system preference detection, and toggle instructions.
- [ ] **Font preferences** — any specific fonts, or use system/web-safe fonts to keep it dependency-free?
- [ ] **Tone of voice** — casual and fun? Competitive and hype? Tongue-in-cheek? This will guide all the copy above.
