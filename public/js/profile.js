/**
 * profile.js: the #/profile page. Name, country and RSVP in ISSUE-014; flag
 * upload in ISSUE-015.
 *
 * WHAT IT WILL DO
 *   - Edit your name, country (free text, at most 100 characters) and RSVP.
 *   - Upload, replace or remove your flag image (JPEG or PNG, at most 2 MB and
 *     1024×1024). Your flag is your avatar everywhere on the site.
 *
 * HOW IT FITS
 *   Updates your own `users` row. A database trigger turns a country change
 *   into an activity-feed claim, so this module never writes claims itself.
 *   Flags go to the `flags` storage bucket under your member id. The upload
 *   component is reused by the admin panel (ISSUE-024).
 */
