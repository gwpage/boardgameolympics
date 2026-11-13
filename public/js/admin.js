/**
 * admin.js: the admin panel at #/admin. Shell in ISSUE-020; panels in
 * ISSUE-021 to ISSUE-028.
 *
 * WHAT IT WILL DO
 *   Invitations: shareable links, email invites, revoke, non-responders.
 *   Users: list, edit, register on someone's behalf, remove (deactivate).
 *   Theme: event date, theme title and description.
 *   Emails: RSVP follow-up and event reminder, via mailto: (ADR-002).
 *   Messages: delete any message.
 *   New Year: archive the old year and reset for the next event.
 *
 * HOW IT FITS
 *   Hiding the admin UI from non-admins is convenience only. The real
 *   enforcement is Row Level Security and admin-only database functions, so a
 *   non-admin who opens this page by hand still can't change anything.
 */
