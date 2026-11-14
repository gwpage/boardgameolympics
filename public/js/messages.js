/**
 * messages.js: message board. Posting and listing in ISSUE-016; meeple likes in
 * ISSUE-017; the admin delete control in ISSUE-026.
 *
 * WHAT IT WILL DO
 *   - Compose box with a live character counter (1 to 1,000 characters,
 *     counted the same way Postgres does).
 *   - Newest-first list showing flag, name, time and plain escaped text,
 *     loaded 20 at a time with infinite scroll.
 *   - Meeple "like" toggle per message, with a count and the list of who liked it.
 *
 * HOW IT FITS
 *   Writes and reads the `messages` and `message_likes` tables through the
 *   client from supabase.js. Row Level Security decides who may post, like or
 *   delete; this module only shows the controls.
 */
