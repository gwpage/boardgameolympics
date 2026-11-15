-- =============================================================================
-- tests/db/test_004_storage.sql: ISSUE-004 tests for the `flags` storage
-- bucket: its size and type limits, and who may read and write which objects.
--
-- HOW TO RUN (dev project only, never prod):
--   Apply db/migrations/003_storage.sql first.
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--     PASS: "Success. No rows returned".
--     FAIL: an error whose message starts with the [label] of the failed check.
--   Or locally, against a throwaway Postgres: tests/db/run_local.sh
--
-- SAFE TO RE-RUN: everything happens in one transaction that is rolled back at
-- the end. Test profiles use t004-…@example.test addresses, and test objects
-- sit in folders named after those profiles' fresh ids, so they can't collide
-- with real flags. No object or file is ever really stored: these are
-- metadata rows only, and the rollback removes them.
--
-- HOW CALLERS ARE SIMULATED
--   The Storage API checks permissions by running its queries on
--   storage.objects as the caller's role (`anon` or `authenticated`) with the
--   caller's JWT claims, so RLS policies decide. The pg_temp helpers below do
--   the same for one statement and then switch back to `postgres`. They're
--   copied from test_003_rls.sql, so this file can be pasted on its own.
--
-- WHAT "REFUSED" LOOKS LIKE
--   A new row that fails a policy raises SQLSTATE 42501 ("new row violates
--   row-level security policy"). A blocked UPDATE or DELETE raises nothing:
--   RLS hides the row, so the statement affects 0 rows.
-- =============================================================================

begin;

-- Supabase rejects DELETE on storage tables unless this is set. The Storage
-- API sets it for its own deletes, so the simulated API calls below need it
-- too. It lasts until the final rollback.
set local storage.allow_delete_query = 'true';

-- -----------------------------------------------------------------------------
-- Test helpers. They live in pg_temp, so they vanish with the rollback.
-- -----------------------------------------------------------------------------

-- Named fixture ids, kept in transaction-local custom settings (t004.<name>)
-- rather than a table (see the README's notes on writing SQL tests).
create function pg_temp.remember(p_name text, p_id uuid)
returns uuid
language sql
as $$
  select set_config('t004.' || p_name, p_id::text, true)::uuid
$$;

create function pg_temp.fx(p_name text)
returns uuid
language plpgsql
stable
as $$
declare
  stored constant text := current_setting('t004.' || p_name, true);
begin
  -- Never set → null. Set and then rolled back → ''.
  if stored is null or stored = '' then
    raise exception 'test bug: no fixture named %', p_name;
  end if;
  return stored::uuid;
end;
$$;

-- Creates a Supabase Auth user (id and email only) and returns its id.
create function pg_temp.new_auth_user(p_tag text)
returns uuid
language sql
as $$
  insert into auth.users (id, email)
  values (gen_random_uuid(), 't004-auth-' || p_tag || '@example.test')
  returning id
$$;

-- Runs one statement as an API caller: `anon` when p_auth_user_id is null
-- (signed out), otherwise `authenticated` with JWT claims whose `sub` is that
-- auth user. Returns the number of rows returned or affected. The role is
-- switched back before returning; if the statement raises, the caller's
-- exception block undoes the switch, because SET LOCAL is transactional.
create function pg_temp.exec_as(p_auth_user_id uuid, p_sql text)
returns bigint
language plpgsql
as $$
declare
  original_role constant text := current_user;
  api_role constant text := case when p_auth_user_id is null then 'anon' else 'authenticated' end;
  row_total bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_auth_user_id, 'role', api_role)::text, true);
  execute format('set local role %I', api_role);
  execute p_sql;
  get diagnostics row_total = row_count;
  execute format('set local role %I', original_role);
  perform set_config('request.jwt.claims', '', true);
  return row_total;
end;
$$;

-- Like exec_as, but returns the first column of the first row, as text.
create function pg_temp.value_as(p_auth_user_id uuid, p_sql text)
returns text
language plpgsql
as $$
declare
  original_role constant text := current_user;
  api_role constant text := case when p_auth_user_id is null then 'anon' else 'authenticated' end;
  result text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_auth_user_id, 'role', api_role)::text, true);
  execute format('set local role %I', api_role);
  execute p_sql into result;
  execute format('set local role %I', original_role);
  perform set_config('request.jwt.claims', '', true);
  return result;
end;
$$;

-- Fails unless the statement, run as the caller, returns or affects exactly
-- p_expected rows.
create function pg_temp.expect_rows(p_label text, p_auth_user_id uuid, p_sql text, p_expected bigint)
returns void
language plpgsql
as $$
declare
  actual bigint := pg_temp.exec_as(p_auth_user_id, p_sql);
begin
  assert actual = p_expected,
    format('[%s] expected %s row(s), got %s', p_label, p_expected, actual);
end;
$$;

-- Fails unless the statement, run as the caller, raises SQLSTATE p_sqlstate
-- (default 42501: permission denied, or a row rejected by an RLS policy).
create function pg_temp.expect_error_as(p_label text, p_auth_user_id uuid, p_sql text,
                                        p_sqlstate text default '42501')
returns void
language plpgsql
as $$
begin
  begin
    perform pg_temp.exec_as(p_auth_user_id, p_sql);
  exception when others then
    if sqlstate = p_sqlstate then
      return;
    end if;
    raise exception '[%] expected SQLSTATE % but got % (%)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception '[%] expected SQLSTATE % but the statement succeeded', p_label, p_sqlstate;
end;
$$;

-- Fails unless the statement, run as the caller, is refused: it either
-- raises 42501 or returns/affects 0 rows. Used for anon, whose privileges on
-- the storage tables are Supabase's to set, not ours: a missing GRANT (error)
-- and RLS (0 rows) both mean "no".
create function pg_temp.expect_refused(p_label text, p_auth_user_id uuid, p_sql text)
returns void
language plpgsql
as $$
declare
  actual bigint;
begin
  begin
    actual := pg_temp.exec_as(p_auth_user_id, p_sql);
  exception when insufficient_privilege then
    return;
  end;
  assert actual = 0, format('[%s] expected to be refused, but it returned or affected %s row(s)', p_label, actual);
end;
$$;

-- SQL that adds one object row to a bucket, as the Storage API does for an
-- upload. Only the row is created; no file is stored.
create function pg_temp.upload_sql(p_bucket text, p_name text)
returns text
language sql
immutable
as $$
  select format('insert into storage.objects (bucket_id, name) values (%L, %L)', p_bucket, p_name)
$$;

-- How many of the given objects still exist, counted as postgres (no RLS).
create function pg_temp.objects_left(variadic p_ids uuid[])
returns bigint
language sql
stable
as $$
  select count(*) from storage.objects where id = any (p_ids)
$$;

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'flags') then
    raise exception '[setup] no flags bucket: apply db/migrations/003_storage.sql first';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Fixtures, created as postgres (RLS doesn't apply):
--   * auth users: admin, a, b, former, stranger (stranger has no profile)
--   * profiles: admin (role admin), a, b, former (deactivated)
--   * flag objects: obj_a in a's folder, obj_b in b's folder,
--     obj_former in former's folder
--   * a second bucket, t004-other, to prove the policies cover flags only
-- Folders are named after profile ids (users.id), not auth ids (ADR-007).
-- -----------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  insert into public.users (name, email, role, auth_user_id)
  values ('T004 Admin', 't004-admin@example.test', 'admin', pg_temp.remember('admin_auth', pg_temp.new_auth_user('admin')))
  returning id into new_id;
  perform pg_temp.remember('admin', new_id);

  insert into public.users (name, email, auth_user_id)
  values ('T004 A', 't004-a@example.test', pg_temp.remember('a_auth', pg_temp.new_auth_user('a')))
  returning id into new_id;
  perform pg_temp.remember('a', new_id);

  insert into public.users (name, email, auth_user_id)
  values ('T004 B', 't004-b@example.test', pg_temp.remember('b_auth', pg_temp.new_auth_user('b')))
  returning id into new_id;
  perform pg_temp.remember('b', new_id);

  insert into public.users (name, email, auth_user_id, is_active, deactivated_at)
  values ('T004 Former', 't004-former@example.test', pg_temp.remember('former_auth', pg_temp.new_auth_user('former')),
          false, now())
  returning id into new_id;
  perform pg_temp.remember('former', new_id);

  perform pg_temp.remember('stranger_auth', pg_temp.new_auth_user('stranger'));

  insert into storage.objects (bucket_id, name) values ('flags', pg_temp.fx('a') || '/t004-a.png')
  returning id into new_id;
  perform pg_temp.remember('obj_a', new_id);
  insert into storage.objects (bucket_id, name) values ('flags', pg_temp.fx('b') || '/t004-b.png')
  returning id into new_id;
  perform pg_temp.remember('obj_b', new_id);
  insert into storage.objects (bucket_id, name) values ('flags', pg_temp.fx('former') || '/t004-former.png')
  returning id into new_id;
  perform pg_temp.remember('obj_former', new_id);

  insert into storage.buckets (id, name, public) values ('t004-other', 't004-other', false);
end
$$;

-- -----------------------------------------------------------------------------
-- [bucket] The flags bucket exists, is public (anyone with a flag's URL can
-- load it, signed in or not), and limits uploads to 2 MB of JPEG or PNG. The
-- Storage API enforces both limits on every upload.
-- -----------------------------------------------------------------------------
do $$
declare
  bucket storage.buckets%rowtype;
  mime_types text[];
begin
  select * into bucket from storage.buckets where id = 'flags';
  assert found, '[bucket] no bucket with id flags';
  assert bucket.name = 'flags', format('[bucket] name is %s, expected flags', bucket.name);
  assert bucket.public is true, '[bucket] flags must be public, so flag images load without signing in';
  assert bucket.file_size_limit = 2097152,
    format('[bucket] file_size_limit is %s, expected 2097152 (2 MB)', coalesce(bucket.file_size_limit::text, 'null'));
  select array_agg(m order by m) into mime_types from unnest(bucket.allowed_mime_types) m;
  assert mime_types is not distinct from array['image/jpeg', 'image/png'],
    format('[bucket] allowed_mime_types is %s, expected exactly image/jpeg and image/png',
           coalesce(bucket.allowed_mime_types::text, 'null (anything allowed)'));
end
$$;

-- -----------------------------------------------------------------------------
-- [policies] storage.objects has RLS on, and its policies are exactly the
-- four from 003_storage.sql. Postgres ORs permissive policies together, so
-- any extra one (for example, left over from setting the bucket up by hand
-- in the dashboard) could quietly widen access. Remove extras in the
-- dashboard: Storage → Policies.
-- -----------------------------------------------------------------------------
do $$
declare
  expected constant text[] := array[
    'flags_delete|PERMISSIVE|DELETE|{authenticated}',
    'flags_insert|PERMISSIVE|INSERT|{authenticated}',
    'flags_select|PERMISSIVE|SELECT|{authenticated}',
    'flags_update|PERMISSIVE|UPDATE|{authenticated}'
  ];
  actual text[];
  missing text[];
  extra text[];
begin
  assert (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
    '[policies] RLS is off on storage.objects';

  select coalesce(array_agg(format('%s|%s|%s|%s', policyname, permissive, cmd, roles::text) order by policyname), '{}')
  into actual
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects';

  select coalesce(array_agg(e), '{}') into missing from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a), '{}') into extra from unnest(actual) a where a <> all (expected);
  assert missing = '{}' and extra = '{}',
    format('[policies] storage.objects policies differ. Missing: %s. Unexpected (remove them): %s', missing, extra);
end
$$;

-- -----------------------------------------------------------------------------
-- [anon] Signed-out visitors can't upload, change, delete or even list flags.
-- They load flag images only through the bucket's public URLs.
-- -----------------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error_as('anon insert', null,
    pg_temp.upload_sql('flags', pg_temp.fx('a') || '/t004-anon.png'));
  perform pg_temp.expect_refused('anon list', null,
    $q$select 1 from storage.objects where bucket_id = 'flags'$q$);
  perform pg_temp.expect_refused('anon update', null,
    format($q$update storage.objects set name = name || '.x' where id = %L$q$, pg_temp.fx('obj_a')));
  perform pg_temp.expect_refused('anon delete', null,
    format('delete from storage.objects where id = %L', pg_temp.fx('obj_a')));
  assert pg_temp.objects_left(pg_temp.fx('obj_a')) = 1, '[anon delete] obj_a is gone';
end
$$;

-- -----------------------------------------------------------------------------
-- [outsiders] Signed in, but not an active member: no access at all, not even
-- to a folder that looks like theirs. The stranger tries a folder named after
-- their auth id, which a policy written with auth.uid() would wrongly allow.
-- The former member tries their own old folder.
-- -----------------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error_as('stranger insert', pg_temp.fx('stranger_auth'),
    pg_temp.upload_sql('flags', pg_temp.fx('stranger_auth') || '/t004-stranger.png'));
  perform pg_temp.expect_rows('stranger list', pg_temp.fx('stranger_auth'),
    $q$select 1 from storage.objects where bucket_id = 'flags'$q$, 0);

  perform pg_temp.expect_error_as('former insert', pg_temp.fx('former_auth'),
    pg_temp.upload_sql('flags', pg_temp.fx('former') || '/t004-former-new.png'));
  perform pg_temp.expect_rows('former list', pg_temp.fx('former_auth'),
    $q$select 1 from storage.objects where bucket_id = 'flags'$q$, 0);
  perform pg_temp.expect_rows('former update', pg_temp.fx('former_auth'),
    format($q$update storage.objects set name = name || '.x' where id = %L$q$, pg_temp.fx('obj_former')), 0);
  perform pg_temp.expect_rows('former delete', pg_temp.fx('former_auth'),
    format('delete from storage.objects where id = %L', pg_temp.fx('obj_former')), 0);
  assert pg_temp.objects_left(pg_temp.fx('obj_former')) = 1, '[former delete] obj_former is gone';
end
$$;

-- -----------------------------------------------------------------------------
-- [member-insert] A member uploads only into their own folder in flags: not
-- another member's folder, not the bucket root, not another bucket.
-- -----------------------------------------------------------------------------
savepoint member_insert;
do $$
begin
  perform pg_temp.expect_rows('member insert own folder', pg_temp.fx('a_auth'),
    pg_temp.upload_sql('flags', pg_temp.fx('a') || '/t004-a-new.png'), 1);
  perform pg_temp.expect_error_as('member insert other folder', pg_temp.fx('a_auth'),
    pg_temp.upload_sql('flags', pg_temp.fx('b') || '/t004-intruder.png'));
  perform pg_temp.expect_error_as('member insert bucket root', pg_temp.fx('a_auth'),
    pg_temp.upload_sql('flags', 't004-root.png'));
  perform pg_temp.expect_error_as('member insert other bucket', pg_temp.fx('a_auth'),
    pg_temp.upload_sql('t004-other', pg_temp.fx('a') || '/t004-elsewhere.png'));
end
$$;
rollback to savepoint member_insert;

-- -----------------------------------------------------------------------------
-- [member-read] A member sees the objects in their own folder (the Storage
-- API needs this to replace or remove a file) but can't list anyone else's.
-- -----------------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_rows('member sees own object', pg_temp.fx('a_auth'),
    format('select 1 from storage.objects where id = %L', pg_temp.fx('obj_a')), 1);
  perform pg_temp.expect_rows('member cannot see other object', pg_temp.fx('a_auth'),
    format('select 1 from storage.objects where id = %L', pg_temp.fx('obj_b')), 0);
  perform pg_temp.expect_rows('member lists only own folder', pg_temp.fx('a_auth'),
    format($q$select 1 from storage.objects where bucket_id = 'flags' and id in (%L, %L, %L)$q$,
           pg_temp.fx('obj_a'), pg_temp.fx('obj_b'), pg_temp.fx('obj_former')), 1);
end
$$;

-- -----------------------------------------------------------------------------
-- [member-update] A member can rename an object within their own folder, but
-- can't move it into another member's folder or touch another member's.
-- -----------------------------------------------------------------------------
savepoint member_update;
do $$
begin
  perform pg_temp.expect_rows('member update own', pg_temp.fx('a_auth'),
    format('update storage.objects set name = %L where id = %L',
           pg_temp.fx('a') || '/t004-a-renamed.png', pg_temp.fx('obj_a')), 1);
  perform pg_temp.expect_error_as('member move into other folder', pg_temp.fx('a_auth'),
    format('update storage.objects set name = %L where id = %L',
           pg_temp.fx('b') || '/t004-moved.png', pg_temp.fx('obj_a')));
  perform pg_temp.expect_rows('member update other', pg_temp.fx('a_auth'),
    format('update storage.objects set name = %L where id = %L',
           pg_temp.fx('b') || '/t004-b-renamed.png', pg_temp.fx('obj_b')), 0);
  assert (select name from storage.objects where id = pg_temp.fx('obj_b')) = pg_temp.fx('b') || '/t004-b.png',
    '[member update other] obj_b was changed';
end
$$;
rollback to savepoint member_update;

-- -----------------------------------------------------------------------------
-- [member-delete] A member can delete their own object but not another
-- member's.
-- -----------------------------------------------------------------------------
savepoint member_delete;
do $$
begin
  perform pg_temp.expect_rows('member delete other', pg_temp.fx('a_auth'),
    format('delete from storage.objects where id = %L', pg_temp.fx('obj_b')), 0);
  assert pg_temp.objects_left(pg_temp.fx('obj_b')) = 1, '[member delete other] obj_b is gone';
  perform pg_temp.expect_rows('member delete own', pg_temp.fx('a_auth'),
    format('delete from storage.objects where id = %L', pg_temp.fx('obj_a')), 1);
  assert pg_temp.objects_left(pg_temp.fx('obj_a')) = 0, '[member delete own] obj_a is still there';
end
$$;
rollback to savepoint member_delete;

-- -----------------------------------------------------------------------------
-- [admin] The admin can read, upload, change and delete in any folder of the
-- flags bucket (to set a flag on someone's behalf, ISSUE-024), but not in
-- other buckets.
-- -----------------------------------------------------------------------------
savepoint admin;
do $$
begin
  perform pg_temp.expect_rows('admin sees every folder', pg_temp.fx('admin_auth'),
    format('select 1 from storage.objects where id in (%L, %L, %L)',
           pg_temp.fx('obj_a'), pg_temp.fx('obj_b'), pg_temp.fx('obj_former')), 3);
  perform pg_temp.expect_rows('admin insert member folder', pg_temp.fx('admin_auth'),
    pg_temp.upload_sql('flags', pg_temp.fx('a') || '/t004-by-admin.png'), 1);
  perform pg_temp.expect_rows('admin update member object', pg_temp.fx('admin_auth'),
    format('update storage.objects set name = %L where id = %L',
           pg_temp.fx('b') || '/t004-b-by-admin.png', pg_temp.fx('obj_b')), 1);
  perform pg_temp.expect_rows('admin delete member object', pg_temp.fx('admin_auth'),
    format('delete from storage.objects where id = %L', pg_temp.fx('obj_a')), 1);
  perform pg_temp.expect_error_as('admin insert other bucket', pg_temp.fx('admin_auth'),
    pg_temp.upload_sql('t004-other', pg_temp.fx('a') || '/t004-by-admin.png'));
end
$$;
rollback to savepoint admin;

-- -----------------------------------------------------------------------------
-- [bucket-locked] Nobody can loosen the limits through the API. This guards a
-- Supabase default the limits depend on: RLS is on for storage.buckets and
-- there are no policies, so the API roles can't create or change buckets.
-- Depending on the project's grants, a refused change either raises 42501 or
-- affects 0 rows; either is fine as long as nothing changes.
-- (array_length counts the null for anon, so the loop covers all three.)
-- -----------------------------------------------------------------------------
do $$
declare
  caller_names constant text[] := array['anon', 'member', 'admin'];
  callers constant uuid[] := array[null, pg_temp.fx('a_auth'), pg_temp.fx('admin_auth')];
begin
  for i in 1 .. array_length(callers, 1) loop
    perform pg_temp.expect_error_as(format('bucket-locked: %s creates a bucket', caller_names[i]), callers[i],
      $q$insert into storage.buckets (id, name, public) values ('t004-sneaky', 't004-sneaky', true)$q$);
    perform pg_temp.expect_refused(format('bucket-locked: %s loosens flags', caller_names[i]), callers[i],
      $q$update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'flags'$q$);
  end loop;

  assert (select file_size_limit from storage.buckets where id = 'flags') = 2097152,
    '[bucket-locked] flags file_size_limit changed';
  assert (select allowed_mime_types is not null from storage.buckets where id = 'flags'),
    '[bucket-locked] flags allowed_mime_types changed';
end
$$;

rollback;
