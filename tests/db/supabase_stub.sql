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
--   * Default privileges: Supabase grants new tables and functions in public
--     to anon/authenticated/service_role automatically, but how much varies by
--     project. Older projects grant ALL. Our dev project (checked 2026-11-15)
--     grants only TRUNCATE, REFERENCES and TRIGGER on tables. The stub copies
--     the most generous default, ALL, so a missing REVOKE fails locally
--     instead of hiding behind a stingier default. Migrations revoke
--     everything and then grant exactly what's needed (002_rls.sql, ADR-015),
--     so they end up the same under either default.
--   * auth.users and auth.uid(): users.auth_user_id references auth.users,
--     and the helper functions read auth.uid(). auth.uid() below has the same
--     body as Supabase's: it reads the `sub` claim from request.jwt.claims,
--     which is how the tests simulate a signed-in user.
--   * storage.buckets, storage.objects and storage.foldername(): the flags
--     bucket and its policies (003_storage.sql) live there. Supabase grants
--     the API roles ALL on both tables and turns RLS on with no policies, so
--     the policies are the only gate; the stub does the same. Supabase also
--     blocks DELETE on storage tables unless the session sets
--     storage.allow_delete_query = 'true', which the Storage API does for
--     its own deletes. The stub has the same guard, so a test that forgets to
--     set the flag fails here too, not only on dev.
--
-- Only the columns our tests touch exist on auth.users (id, email) and on the
-- storage tables. Tests must name only those columns, which also works on
-- real Supabase, where every other column is nullable or defaulted.
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

-- storage schema -----------------------------------------------------------------
-- On Supabase these belong to supabase_storage_admin, and the postgres role
-- can still insert buckets and create policies on storage.objects (that's how
-- Supabase's docs create both). Here postgres simply owns them, which allows
-- the same two things.

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner_id   text,
  metadata   jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Same body as Supabase's: every path segment except the last (the file name).
-- 'abc/123.png' gives {abc}; a file at the bucket root gives {}.
create function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

grant execute on function storage.foldername(text) to postgres, anon, authenticated, service_role;

-- Supabase's statement-level guard against direct SQL deletes, which would
-- leave the files behind in object storage.
create function storage.protect_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), '') <> 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.';
  end if;
  return null;
end
$$;

create trigger protect_buckets_delete before delete on storage.buckets
  for each statement execute function storage.protect_delete();
create trigger protect_objects_delete before delete on storage.objects
  for each statement execute function storage.protect_delete();
