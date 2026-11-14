/**
 * feed.js: activity feed on the dashboard. Built in ISSUE-018.
 *
 * WHAT IT WILL DO
 *   - Show a newest-first list of what's happening: "Alex claimed Genovia",
 *     "Sam posted a message", with relative times.
 *   - Load 20 items at a time with infinite scroll.
 *
 * HOW IT FITS
 *   Reads the `activity_feed` database view, which merges country claims and
 *   messages for the current event year and respects Row Level Security.
 *   Escaping, relative times and infinite scroll come from util.js (ISSUE-008).
 */
