/**
 * supabase.js: the single Supabase client used by the whole app. Built in ISSUE-007.
 *
 * WHAT IT WILL DO
 *   - Validate CONFIG (from config.js) and show a clear on-page error if the
 *     URL or anon key is missing or still a placeholder.
 *   - Create the client from the global `supabase` (pinned CDN bundle) with
 *     persistSession, autoRefreshToken, detectSessionInUrl, and the implicit
 *     auth flow.
 *   - Store the session in long-lived cookies instead of localStorage so it
 *     survives browser restarts (SPEC § Session Management). Values larger
 *     than one cookie allows are split across numbered chunk cookies.
 *
 * HOW IT FITS
 *   Every module that talks to the database imports the client from here.
 *   Nothing else calls supabase.createClient().
 */
