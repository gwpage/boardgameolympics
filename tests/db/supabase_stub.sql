-- =============================================================================
-- tests/db/supabase_stub.sql: a minimal stand-in for the Supabase pieces that
-- our migrations rely on, so SQL tests can run on a throwaway local Postgres
-- (ADR-013).
--
-- ONLY tests/db/run_local.sh applies this, as the local superuser, to a
-- cluster it has just created and will delete afterwards. Never paste it into
-- a real Supabase project. The guard below refuses to run there.
--
-- What it mimics, and why:
--   * Roles: anon, authenticated and service_role are the roles PostgREST
--     switches to. postgres is the role the Supabase SQL Editor runs as: not a
--     superuser, but it owns the public schema, can bypass RLS, and can
--     `set role` to the API roles. Tests that run as a non-superuser catch
--     permission mistakes that a superuser would silently skip past.
--   * Default privileges: on Supabase, every new table and function in public
--     is granted to anon/authenticated/service_role automatically. Migrations
--     must revoke what those roles shouldn't have, so the stub copies that
--     default. Otherwise a missing REVOKE would look fine locally.
--   * auth.users and auth.uid(): users.auth_user_id references auth.users,
--     and the helper functions read auth.uid(). auth.uid() below has the same
--     body as Supabase's: it reads the `sub` claim from request.jwt.claims,
--     which is how the tests simulate a signed-in user.
--
-- Only the columns our tests touch exist on auth.users (id, email). Tests that
-- insert into auth.users must therefore name only those columns, which also
-- works on real Supabase, where every other column is nullable or defaulted.
-- =============================================================================

\set ON_ERROR_STOP on

do $$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_auth_admin', 'authenticator')) then
    raise exception 'supabase_stub.sql is for throwaway local clusters only; this database looks like a real Supabase project';
  end if;
end
$$;

-- Roles ----------------------------------------------------------------------

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role postgres login createrole createdb bypassrls;
grant anon, authenticated, service_role to postgres;

-- public schema: owned by postgres, usable by the API roles -------------------

alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

-- auth schema ------------------------------------------------------------------

create schema auth;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create table auth.users (
  id    uuid primary key,
  email varchar(255)
);
-- On Supabase the postgres role can read, write and reference auth.users. It
-- needs REFERENCES so public.users.auth_user_id can be a foreign key.
grant all on auth.users to postgres;

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt()
  to postgres, anon, authenticated, service_role;
