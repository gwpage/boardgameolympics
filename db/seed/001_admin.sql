-- =============================================================================
-- db/seed/001_admin.sql: the first administrator (ISSUE-005; SPEC.md
-- § Initial Administrator).
--
-- SAFE FOR EVERY ENVIRONMENT, prod included.
--
-- HOW TO APPLY
--   After all of db/migrations/ has been applied:
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--   It runs in one transaction. Re-running it is harmless.
--
-- WHAT IT DOES
--   Creates the profile Wiley Page / gwpage@gmail.com with role admin.
--   auth_user_id stays null: the profile is linked to an Auth account the
--   first time someone signs in with this email (ADR-007). Until then, nobody
--   is the admin.
--
-- IF THE PROFILE ALREADY EXISTS (a re-run)
--   Nothing about it changes, except that it is made an active admin again if
--   it had somehow stopped being one. That makes a re-run the way back in if
--   the admin is ever locked out. The name, country, flag, RSVP, sign-in link
--   and registration date are never touched (ADR-019).
-- =============================================================================

begin;

insert into public.users as existing (name, email, role)
values ('Wiley Page', 'gwpage@gmail.com', 'admin')
-- users_email_lower_key is a unique index on lower(email), so this also finds
-- the profile if its email was saved with different capitals.
on conflict ((lower(email))) do update
  set role = 'admin',
      is_active = true,
      deactivated_at = null
  -- Skip the write when it's already an active admin, so a re-run changes nothing.
  where existing.role <> 'admin' or not existing.is_active;

commit;
