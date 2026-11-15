-- =============================================================================
-- db/migrations/002_rls.sql: table privileges, Row Level Security policies,
-- and two RPCs: get_public_event_info() and admin_list_users()
-- (ISSUE-003; SETUP_SUPABASE.md § Enable Row Level Security).
--
-- HOW TO APPLY
--   After 001_schema.sql: Supabase dashboard → SQL Editor → New query → paste
--   this whole file → Run. It runs in one transaction and is safe to re-run.
--   Check it on dev with tests/db/test_003_rls.sql.
--
-- WHY THIS FILE MATTERS
--   Supabase serves every table in `public` through a public REST API. The
--   publishable key in the browser is not a secret, so this file is the real
--   security boundary. Two layers, both required:
--     1. GRANTs decide which tables and columns a role may touch at all.
--     2. RLS policies decide which rows, for the roles that got a GRANT.
--   A request runs as `anon` when signed out and as `authenticated` when
--   signed in (ADR-014). Admins and members are both `authenticated`. What
--   tells them apart is is_admin() / is_member() (001_schema.sql), which look
--   up the caller's profile.
--
-- WHO MAY DO WHAT (ADR-015, ADR-016, ADR-017)
--   anon           nothing on any table. Only get_public_event_info().
--   non-members    (signed in, but no active profile: never invited, or
--                  deactivated) see no rows and change nothing.
--   members        read the member-safe columns of active profiles (no
--                  email, A5); update their own name/country/flag/RSVP; read
--                  and post this year's messages; like/unlike as themselves;
--                  read this year's claims and all event settings.
--   admin          everything members can, plus: read every profile,
--                  deactivated ones included (emails via admin_list_users());
--                  edit anyone's name/country/flag/RSVP; read, create and
--                  revoke invitations; delete messages (A7); create and edit
--                  event settings. Role, email and activation changes go
--                  through RPCs (ISSUE-012, ISSUE-024), never a plain UPDATE.
--   service_role   (secret key, server side only) plain DML on every table;
--                  it bypasses RLS by design.
--
-- CLIENT CONSEQUENCES
--   * Column-level grants on users mean `select=*` on users is refused.
--     Clients must name columns: id, name, country, flag_url, rsvp, role,
--     created_at.
--   * Members can't see deactivated profiles. A message by a removed author
--     still shows, but joining to its author gives null: the UI shows
--     "Former member" (ADR-017).
--
-- PERFORMANCE NOTE
--   Policies wrap helper calls as `(select public.is_member())`. Postgres
--   then evaluates each helper once per statement instead of once per row.
--   This is Supabase's documented RLS performance advice.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Privileges: revoke everything, then grant exactly what each role needs.
--
-- Supabase's defaults for new tables differ between projects. Older projects
-- grant ALL to anon, authenticated and service_role. Our dev project (checked
-- 2026-11-15) grants only TRUNCATE, REFERENCES and TRIGGER. Revoking
-- everything first makes the result the same either way. REVOKE on a table
-- also revokes its column-level grants, so re-running this file starts clean.
-- -----------------------------------------------------------------------------

revoke all on table
  public.event_settings, public.invitations, public.users,
  public.messages, public.message_likes, public.country_claims
  from public, anon, authenticated, service_role;

-- service_role is what the secret key runs as (e.g. the invite-user Edge
-- Function, ISSUE-022). It bypasses RLS anyway, so table grants are its only
-- limit. Plain DML, but no TRUNCATE (which would empty a whole table).
grant select, insert, update, delete on table
  public.event_settings, public.invitations, public.users,
  public.messages, public.message_likes, public.country_claims
  to service_role;

-- authenticated: the policies below then narrow these grants per row.
--
-- users: column-level, so the email address and the account-management
-- columns (auth_user_id, is_active, deactivated_at, invitation_id) are never
-- readable through the API, not even by the admin. Admins read them through
-- admin_list_users(). There is no INSERT: profiles are created by RPCs
-- (claim_membership, ISSUE-012; admin_create_user, ISSUE-024).
grant select (id, name, country, flag_url, rsvp, role, created_at) on table public.users to authenticated;
grant update (name, country, flag_url, rsvp) on table public.users to authenticated;

-- invitations (admin only, by policy): the database generates the token and
-- owns status, use count, year and timestamps. Revoking is an UPDATE of
-- status and revoked_at. There is no DELETE: invitations are revoked, never
-- deleted (ADR-009).
grant select on table public.invitations to authenticated;
grant insert (type, email, max_uses) on table public.invitations to authenticated;
grant update (status, revoked_at) on table public.invitations to authenticated;

-- messages: clients send only author and text. event_year and created_at
-- always come from column defaults, so nobody can backdate a post or post
-- into another year. There is no UPDATE: messages are never edited. DELETE is
-- granted for the admin; the policy refuses everyone else (A7).
grant select, delete on table public.messages to authenticated;
grant insert (user_id, text) on table public.messages to authenticated;

-- message_likes: insert (message, liker) and delete to unlike. Never edited.
grant select, delete on table public.message_likes to authenticated;
grant insert (message_id, user_id) on table public.message_likes to authenticated;

-- country_claims: read only. The users_record_country_claim trigger is the
-- only writer (ADR-011). It is SECURITY DEFINER, so it needs no grant here.
grant select on table public.country_claims to authenticated;

-- event_settings: the admin creates a year's row (Start New Year) and edits
-- its date and theme. A row's year never changes, because that would move
-- every message and claim of that year in or out of the archive. There is
-- no DELETE.
grant select on table public.event_settings to authenticated;
grant insert (year, event_date, theme_title, theme_desc) on table public.event_settings to authenticated;
grant update (event_date, theme_title, theme_desc) on table public.event_settings to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Row Level Security policies.
--
-- RLS is already enabled on every table (001_schema.sql). Each policy is
-- dropped and re-created so this file can be re-run. Every policy is
-- `to authenticated`: anon has no grants, so it never reaches a policy.
-- -----------------------------------------------------------------------------

-- users -----------------------------------------------------------------------

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_member()) and is_active)
  );
comment on policy users_select on public.users is
  'Members read active profiles (member-safe columns only, by column grant; A5). The admin also reads deactivated '
  'profiles. Signed-in users without an active profile read nothing.';

drop policy if exists users_update on public.users;
create policy users_update on public.users
  for update to authenticated
  using (id = (select public.current_member_id()) or (select public.is_admin()))
  with check (id = (select public.current_member_id()) or (select public.is_admin()));
comment on policy users_update on public.users is
  'Members update their own profile; the admin updates anyone''s. The column grant limits both to name, country, '
  'flag_url and rsvp. current_member_id() is null for non-members, so they match no row.';

-- invitations -----------------------------------------------------------------

drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations
  for select to authenticated
  using ((select public.is_admin()));
comment on policy invitations_select on public.invitations is
  'Admin only. Tokens are secrets that grant membership.';

drop policy if exists invitations_insert on public.invitations;
create policy invitations_insert on public.invitations
  for insert to authenticated
  with check ((select public.is_admin()));
comment on policy invitations_insert on public.invitations is
  'Admin only. The column grant leaves token, status, use_count and event_year to the database.';

drop policy if exists invitations_update on public.invitations;
create policy invitations_update on public.invitations
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
comment on policy invitations_update on public.invitations is
  'Admin only: revoking (status and revoked_at, by column grant). Acceptance is done by claim_membership (ISSUE-012).';

-- messages --------------------------------------------------------------------

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using ((select public.is_member()) and event_year = (select public.current_event_year()));
comment on policy messages_select on public.messages is
  'Members (the admin included) read only the current year. Earlier years are the archive: kept in the database, '
  'not readable through the API (ADR-008, ADR-017). Messages by deactivated authors stay visible.';

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    user_id = (select public.current_member_id())
    and event_year = (select public.current_event_year())
  );
comment on policy messages_insert on public.messages is
  'Members post only as themselves and only into the current year (ADR-008). The column grant already stops clients '
  'from sending event_year; the year check is a second line of defence.';

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages
  for delete to authenticated
  using ((select public.is_admin()));
comment on policy messages_delete on public.messages is
  'Only the admin deletes messages, own included for members (A7, ADR-017). Likes go with the message (ON DELETE CASCADE).';

-- message_likes ---------------------------------------------------------------

-- The EXISTS subquery reads public.messages as the caller, so messages' own
-- policy applies inside it: a like is visible, or can be added, only when
-- its message is visible, i.e. it's a current-year message and the caller is
-- a member.

drop policy if exists message_likes_select on public.message_likes;
create policy message_likes_select on public.message_likes
  for select to authenticated
  using (
    (select public.is_member())
    and exists (select 1 from public.messages m where m.id = message_likes.message_id)
  );
comment on policy message_likes_select on public.message_likes is
  'Members read likes on the messages they can see (current year only).';

drop policy if exists message_likes_insert on public.message_likes;
create policy message_likes_insert on public.message_likes
  for insert to authenticated
  with check (
    user_id = (select public.current_member_id())
    and exists (select 1 from public.messages m where m.id = message_likes.message_id)
  );
comment on policy message_likes_insert on public.message_likes is
  'Members like only as themselves, and only messages they can see. UNIQUE (message_id, user_id) stops double likes.';

drop policy if exists message_likes_delete on public.message_likes;
create policy message_likes_delete on public.message_likes
  for delete to authenticated
  using (user_id = (select public.current_member_id()));
comment on policy message_likes_delete on public.message_likes is
  'Members remove only their own likes (unlike).';

-- country_claims --------------------------------------------------------------

drop policy if exists country_claims_select on public.country_claims;
create policy country_claims_select on public.country_claims
  for select to authenticated
  using ((select public.is_member()) and event_year = (select public.current_event_year()));
comment on policy country_claims_select on public.country_claims is
  'Members read the current year''s claims (the activity feed). No write policies: only the trigger writes (ADR-011).';

-- event_settings --------------------------------------------------------------

drop policy if exists event_settings_select on public.event_settings;
create policy event_settings_select on public.event_settings
  for select to authenticated
  using ((select public.is_member()));
comment on policy event_settings_select on public.event_settings is
  'Members read event settings (the sidebar). Signed-out visitors use get_public_event_info() instead (A6).';

drop policy if exists event_settings_insert on public.event_settings;
create policy event_settings_insert on public.event_settings
  for insert to authenticated
  with check ((select public.is_admin()));
comment on policy event_settings_insert on public.event_settings is
  'Admin only: creating a new year''s settings (Start New Year, ISSUE-028).';

drop policy if exists event_settings_update on public.event_settings;
create policy event_settings_update on public.event_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
comment on policy event_settings_update on public.event_settings is
  'Admin only: editing the date and theme (ISSUE-025). The column grant keeps year fixed.';

-- -----------------------------------------------------------------------------
-- 3. RPCs
-- -----------------------------------------------------------------------------

-- The landing page shows the event date to signed-out visitors, but anon can
-- read no table. This exposes exactly two facts, the current year and its
-- date, and nothing else (A6, ADR-016). The keep-alive ping (ADR-004) calls
-- it too.
create or replace function public.get_public_event_info()
returns table (year integer, event_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select s.year, s.event_date
  from public.event_settings s
  order by s.year desc
  limit 1
$$;

comment on function public.get_public_event_info() is
  'Public (anon) RPC: the current event''s year and date, or no row before any event exists (the landing page then '
  'shows "Date TBA"). SECURITY DEFINER so it can read event_settings, which anon cannot. Returns nothing else (A6, '
  'ADR-016).';

-- The admin needs every column of every profile, emails included, but the
-- column grants hide email from all of `authenticated`, and the admin is
-- `authenticated` too. Postgres can't grant a column to one user of a role,
-- so the admin reads through this function, which checks is_admin() itself.
create or replace function public.admin_list_users()
returns setof public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_list_users: only an active admin may list users'
      using errcode = '42501';  -- insufficient_privilege, like a refused GRANT
  end if;
  return query
    select u.*
    from public.users u
    order by lower(u.name), u.id;
end;
$$;

comment on function public.admin_list_users() is
  'Admin-only RPC: every profile with every column, deactivated ones included. The only API path to users.email '
  '(A5, ADR-015). Raises 42501 for anyone but an active admin. Filter and sort it like a table through PostgREST.';

-- Function privileges: Supabase (and Postgres, via PUBLIC) grant EXECUTE on
-- new functions to everyone. Take it back, then grant only what's needed.
revoke execute on function public.get_public_event_info(), public.admin_list_users()
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_event_info() to anon, authenticated;
grant execute on function public.admin_list_users() to authenticated;

-- Ask PostgREST to reload its schema cache now, rather than whenever it next
-- notices the change. Harmless where nothing is listening.
notify pgrst, 'reload schema';

commit;
