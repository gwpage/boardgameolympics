# Manual test: sign-in round trips on dev (ISSUE-011)

The automated tests (`tests/js/test_011_auth.js`) check everything up to the moment the browser leaves for Google, Facebook or the mail app. They can't follow it there. This checklist does. Run it on the **dev** project, never prod, after any change to sign-in or to the Supabase auth settings.

## Before you start

1. Dev's **Authentication → URL Configuration** matches SETUP_SUPABASE.md § Configure Redirect URLs: Site URL `http://localhost:8000/public/`, Redirect URLs `http://localhost:8000/**` and `http://127.0.0.1:8000/**`.
2. `public/config.js` points at dev. From the repo root: `python3 -m http.server 8000`.
3. Use a private (incognito) window, so no old session gets in the way. Keep DevTools open: **Application → Cookies → http://localhost:8000**, and the **Console**.
4. An invite token to test with. Until ISSUE-012 checks tokens against real invitations, any 64 lowercase hex characters will do:
   ```
   aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   ```
   The test link is `http://localhost:8000/public/?invite=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.

Until ISSUE-012, a successful sign-in ends on "You're not on the guest list" (or on the dashboard, if your profile is linked by hand: README § App shell and routing). Either way, **Log out** in the header means you're signed in.

## Checklist

Record the date, browser, and a ✓ or what happened instead.

| # | Do this | Expect |
|---|---------|--------|
| 1 | Open the test link. **Log in or register → Continue with Google.** Pick your account. | You come back to `http://localhost:8000/public/?invite=…` with the **token still in the address bar**, signed in. No `#access_token` is left in the address bar. If the token is gone, the redirect URLs are wrong (Before you start, step 1). |
| 2 | Look at the cookies. | `sb-<project-ref>-auth-token`, or `…-auth-token.0`, `.1`, …, is there. |
| 3 | Close the window's tab, open the site again (same private window). | Still signed in. |
| 4 | **Log out.** | The landing page. No `sb-` cookies left. |
| 5 | **Continue with Google**, then cancel or go back on Google's screen. | Back on the landing page with the login panel open and "Signing in that way didn't work…". If Google offers no way to cancel, write "n/a". |
| 6 | Steps 1–4 with **Continue with Facebook** (once Facebook is switched on: SETUP_SUPABASE.md § Enable Facebook OAuth). | The same as for Google. Before it's switched on, the button shows a bare Supabase error page; write "Facebook not enabled". |
| 7 | Without the token (`http://localhost:8000/public/`): enter `alex@` and press **Email me a sign-in link**. | "That doesn't look like an email address…" under the field. The Network tab shows no request to `/auth/v1/otp`. |
| 8 | Without the token: enter an address that has never signed in to dev. | "There's no account for that email address yet…". No email is sent. |
| 9 | Without the token: enter **your own** address (it has an account after step 1). | "Check your email…". The email arrives; note which template it is (**Magic Link** expected). Open the link: you're signed in. |
| 10 | Open the same email link a second time. | Back on the landing page with the login panel open and "That sign-in link has expired or has already been used…". |
| 11 | Ask for a link for your own address twice within a minute. | The second time: "Too many sign-in attempts in a short time…". |
| 12 | With the token: enter an address that has never signed in to dev. | Without custom SMTP: "The site can't send email to that address yet…" (Supabase's built-in email only reaches your Supabase organization). With custom SMTP: "Check your email…", and the link signs in a brand-new account. **Note which template arrived** (Magic Link or Confirm signup) and record it in SETUP_SUPABASE.md § Email templates. |

## Results

| Date | Browser | Steps passed | Notes |
|------|---------|--------------|-------|
| | | | |
