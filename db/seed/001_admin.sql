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
-- IF THE PROFILE ALREADY EXISTS
--   Nothing happens. Like every seed, this only adds what's missing and never
--   changes an existing row (ADR-019). To restore admin rights after a
--   lockout, see SETUP_SUPABASE.md Step 7.
-- =============================================================================

begin;

insert into public.users (name, email, role)
values ('Wiley Page', 'gwpage@gmail.com', 'admin')
-- users_email_lower_key is a unique index on lower(email), so this also finds
-- the profile if its email was saved with different capitals.
on conflict ((lower(email))) do nothing;

commit;
