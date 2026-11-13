/**
 * auth.js: login and logout. Built in ISSUE-011; invite handling in ISSUE-012.
 *
 * WHAT IT WILL DO
 *   - Login options: Google, Facebook, and an email magic link.
 *   - Carry an invite token (?invite=...) through the round trip to the auth
 *     provider. A magic link only creates a new user when a token is present.
 *   - Translate Supabase auth errors into friendly messages.
 *   - Logout: sign out, clear the session cookies, return to the landing page.
 *
 * HOW IT FITS
 *   Uses the client from supabase.js. Signing in only proves who someone is:
 *   whether they're allowed in is decided afterwards by the claim_membership
 *   RPC (ISSUE-012) and enforced by Row Level Security (ISSUE-003).
 */
