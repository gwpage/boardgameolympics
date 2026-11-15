-- =============================================================================
-- tests/db/test_003_rls.sql: ISSUE-003 tests for table privileges, Row Level
-- Security policies, and the two RPCs that come with them
-- (get_public_event_info, admin_list_users).
--
-- HOW TO RUN (dev project only, never prod):
--   Apply db/migrations/002_rls.sql first.
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--     PASS: "Success. No rows returned".
--     FAIL: an error whose message starts with the [label] of the failed check.
--   Or locally, against a throwaway Postgres: tests/db/run_local.sh
--
-- SAFE TO RE-RUN: everything happens in one transaction that is rolled back at
-- the end. Test rows use t003-…@example.test addresses. No check assumes the
-- tables start empty: a count is either over the whole table (for callers who
-- must see nothing at all) or limited to this file's own fixture rows.
--
-- HOW CALLERS ARE SIMULATED
--   Setup runs as the SQL Editor's `postgres` role. It owns the tables, so RLS
--   doesn't apply to it. Each check then runs a single statement the way
--   PostgREST would: as `anon` for a signed-out request, or as `authenticated`
--   with JWT claims naming the auth user. The pg_temp helpers below switch to
--   that role for one statement and then switch back.
--
-- WHAT "REFUSED" LOOKS LIKE
--   Postgres raises SQLSTATE 42501 (insufficient_privilege) both for a missing
--   GRANT ("permission denied for table …") and for a new row that fails an RLS
--   check ("new row violates row-level security policy …"). A blocked UPDATE
--   or DELETE raises nothing: RLS hides the row, so the statement affects
--   0 rows. Each check asserts whichever of the two applies.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Test helpers. They live in pg_temp, so they vanish with the rollback.
-- -----------------------------------------------------------------------------

-- Named fixture ids, so each do-block can find the rows the setup created.
create temp table fixture (name text primary key, id uuid not null);

create function pg_temp.remember(p_name text, p_id uuid)
returns uuid
language sql
as $$
  insert into pg_temp.fixture (name, id) values (p_name, p_id) returning id
$$;

create function pg_temp.fx(p_name text)
returns uuid
language plpgsql
stable
as $$
declare
  found_id uuid;
begin
  select f.id into found_id from pg_temp.fixture f where f.name = p_name;
  if found_id is null then
    raise exception 'test bug: no fixture named %', p_name;
  end if;
  return found_id;
end;
$$;

-- Creates a Supabase Auth user (id and email only) and returns its id.
create function pg_temp.new_auth_user(p_tag text)
returns uuid
language sql
as $$
  insert into auth.users (id, email)
  values (gen_random_uuid(), 't003-auth-' || p_tag || '@example.test')
  returning id
$$;

-- Runs one statement as PostgREST would for this caller: as `anon` when
-- p_auth_user_id is null (signed out), otherwise as `authenticated` with JWT
-- claims whose `sub` is that auth user. Returns the number of rows the
-- statement returned (SELECT) or affected (INSERT/UPDATE/DELETE).
-- The role is switched back before returning. If the statement raises, the
-- caller's exception block rolls back its subtransaction, and that undoes the
-- role switch too, because SET LOCAL is transactional.
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

-- -----------------------------------------------------------------------------
-- Fixtures, created as the table owner (RLS doesn't apply):
--   * a new event_settings row one year past the newest, which makes it the
--     current event year; "prior year" is the year before it
--   * auth users: admin, a, b, former, stranger (stranger has no profile)
--   * profiles: admin (role admin), a, b, former (deactivated). Each has a
--     country, so the trigger logs a current-year claim for each
--   * messages: msg_a (by a), msg_b (by b), msg_former (by former), all this
--     year; msg_old (by a) in the prior year
--   * likes: b on msg_a, a on msg_b, b on msg_old
--   * a prior-year country claim for b, and one pending link invitation
-- -----------------------------------------------------------------------------
do $$
declare
  current_year integer;
  prior_year integer;
  new_id uuid;
begin
  select coalesce(max(year), extract(year from current_date)::integer) + 1 into current_year
  from public.event_settings;
  prior_year := current_year - 1;
  insert into public.event_settings (year, event_date, theme_title, theme_desc)
  values (current_year, make_date(current_year, 2, 15), 'T003 Theme', 'T003 description');

  insert into public.users (name, email, role, country, auth_user_id)
  values ('T003 Admin', 't003-admin@example.test', 'admin', 'T003 Gondor',
          pg_temp.remember('admin_auth', pg_temp.new_auth_user('admin')))
  returning id into new_id;
  perform pg_temp.remember('admin', new_id);

  insert into public.users (name, email, country, auth_user_id)
  values ('T003 A', 't003-a@example.test', 'T003 Arnor', pg_temp.remember('a_auth', pg_temp.new_auth_user('a')))
  returning id into new_id;
  perform pg_temp.remember('a', new_id);

  insert into public.users (name, email, country, auth_user_id)
  values ('T003 B', 't003-b@example.test', 'T003 Bree', pg_temp.remember('b_auth', pg_temp.new_auth_user('b')))
  returning id into new_id;
  perform pg_temp.remember('b', new_id);

  insert into public.users (name, email, country, auth_user_id, is_active, deactivated_at)
  values ('T003 Former', 't003-former@example.test', 'T003 Fornost',
          pg_temp.remember('former_auth', pg_temp.new_auth_user('former')), false, now())
  returning id into new_id;
  perform pg_temp.remember('former', new_id);

  perform pg_temp.remember('stranger_auth', pg_temp.new_auth_user('stranger'));

  insert into public.messages (user_id, text) values (pg_temp.fx('a'), 'T003 from A') returning id into new_id;
  perform pg_temp.remember('msg_a', new_id);
  insert into public.messages (user_id, text) values (pg_temp.fx('b'), 'T003 from B') returning id into new_id;
  perform pg_temp.remember('msg_b', new_id);
  insert into public.messages (user_id, text) values (pg_temp.fx('former'), 'T003 from Former') returning id into new_id;
  perform pg_temp.remember('msg_former', new_id);
  insert into public.messages (user_id, text, event_year) values (pg_temp.fx('a'), 'T003 last year', prior_year)
  returning id into new_id;
  perform pg_temp.remember('msg_old', new_id);

  insert into public.message_likes (message_id, user_id)
  values (pg_temp.fx('msg_a'), pg_temp.fx('b')),
         (pg_temp.fx('msg_b'), pg_temp.fx('a')),
         (pg_temp.fx('msg_old'), pg_temp.fx('b'));

  insert into public.country_claims (user_id, country, event_year)
  values (pg_temp.fx('b'), 'T003 Old Bree', prior_year);

  insert into public.invitations (type) values ('link') returning id into new_id;
  perform pg_temp.remember('invitation', new_id);
end
$$;

-- -----------------------------------------------------------------------------
-- [grants] Each API role holds exactly the privileges it needs, whatever the
-- project's defaults were. Compares the full list of table-level and
-- column-level grants held by PUBLIC, anon, authenticated and service_role
-- against the expected list, and reports anything missing or extra.
-- -----------------------------------------------------------------------------
do $$
declare
  tables constant text[] := array['event_settings', 'invitations', 'users', 'messages', 'message_likes', 'country_claims'];
  expected text[];
  actual text[];
  missing text[];
  extra text[];
begin
  -- Entries are role|table|privilege|column, with column '*' for a table-level grant.
  with spec(grantee, tbl, privilege, columns) as (
    select 'service_role'::text, t.tbl, p.privilege, null::text[]
    from unnest(tables) t(tbl)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    union all
    select g.grantee, g.tbl, g.privilege, g.columns
    from (values
      ('authenticated', 'event_settings', 'SELECT', null::text[]),
      ('authenticated', 'event_settings', 'INSERT', array['year', 'event_date', 'theme_title', 'theme_desc']),
      ('authenticated', 'event_settings', 'UPDATE', array['event_date', 'theme_title', 'theme_desc']),
      ('authenticated', 'invitations',    'SELECT', null),
      ('authenticated', 'invitations',    'INSERT', array['type', 'email', 'max_uses']),
      ('authenticated', 'invitations',    'UPDATE', array['status', 'revoked_at']),
      ('authenticated', 'users',          'SELECT', array['id', 'name', 'country', 'flag_url', 'rsvp', 'role', 'created_at']),
      ('authenticated', 'users',          'UPDATE', array['name', 'country', 'flag_url', 'rsvp']),
      ('authenticated', 'messages',       'SELECT', null),
      ('authenticated', 'messages',       'INSERT', array['user_id', 'text']),
      ('authenticated', 'messages',       'DELETE', null),
      ('authenticated', 'message_likes',  'SELECT', null),
      ('authenticated', 'message_likes',  'INSERT', array['message_id', 'user_id']),
      ('authenticated', 'message_likes',  'DELETE', null),
      ('authenticated', 'country_claims', 'SELECT', null)
    ) g(grantee, tbl, privilege, columns)
  )
  select array_agg(format('%s|%s|%s|%s', s.grantee, s.tbl, s.privilege, c.col) order by 1)
  into expected
  from spec s
  cross join lateral unnest(coalesce(s.columns, array['*'])) c(col);

  with api_grantees(oid) as (
    select 0::oid  -- PUBLIC
    union all
    select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
  ),
  held(entry) as (
    select format('%s|%s|%s|*', coalesce(r.rolname, 'PUBLIC'), c.relname, a.privilege_type)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and c.relname = any (tables) and a.grantee in (select oid from api_grantees)
    union all
    select format('%s|%s|%s|%s', coalesce(r.rolname, 'PUBLIC'), c.relname, a.privilege_type, att.attname)
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(att.attacl) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and c.relname = any (tables)
      and att.attnum > 0 and not att.attisdropped
      and a.grantee in (select oid from api_grantees)
  )
  select coalesce(array_agg(entry order by entry), '{}') into actual from held;

  missing := array(select unnest(expected) except select unnest(actual) order by 1);
  extra := array(select unnest(actual) except select unnest(expected) order by 1);
  assert cardinality(missing) = 0, format('[grants] missing grants: %s', missing);
  assert cardinality(extra) = 0, format('[grants] unexpected grants: %s', extra);
end
$$;

-- -----------------------------------------------------------------------------
-- [rpc-security] The two RPCs are SECURITY DEFINER with an empty search_path.
-- Anyone may call get_public_event_info(); only signed-in users may call
-- admin_list_users(), and it checks for the admin itself.
-- -----------------------------------------------------------------------------
do $$
declare
  fn record;
  found_count integer := 0;
begin
  for fn in
    select p.proname, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('get_public_event_info', 'admin_list_users')
  loop
    found_count := found_count + 1;
    assert fn.prosecdef, format('[rpc-security] public.%s must be SECURITY DEFINER', fn.proname);
    assert fn.proconfig is not null and fn.proconfig && array['search_path=""', 'search_path='],
      format('[rpc-security] public.%s must set an empty search_path, has %s', fn.proname, fn.proconfig);
  end loop;
  assert found_count = 2, format('[rpc-security] expected 2 RPCs, found %s', found_count);

  assert has_function_privilege('anon', 'public.get_public_event_info()', 'execute'),
    '[rpc-security] anon must be able to call get_public_event_info() (landing page, keep-alive ping)';
  assert has_function_privilege('authenticated', 'public.get_public_event_info()', 'execute'),
    '[rpc-security] authenticated must be able to call get_public_event_info()';
  assert has_function_privilege('authenticated', 'public.admin_list_users()', 'execute'),
    '[rpc-security] authenticated must be able to call admin_list_users() (it checks is_admin() itself)';
  assert not has_function_privilege('anon', 'public.admin_list_users()', 'execute'),
    '[rpc-security] anon must not be able to call admin_list_users()';
  assert pg_get_function_result('public.get_public_event_info()'::regprocedure) = 'TABLE(year integer, event_date date)',
    format('[rpc-security] get_public_event_info() must return only (year, event_date), returns %s',
           pg_get_function_result('public.get_public_event_info()'::regprocedure));
end
$$;

-- -----------------------------------------------------------------------------
-- [anon] Signed-out requests can't read or write any table.
-- -----------------------------------------------------------------------------
do $$
declare
  tbl text;
begin
  foreach tbl in array array['event_settings', 'invitations', 'users', 'messages', 'message_likes', 'country_claims'] loop
    perform pg_temp.expect_error_as(format('anon: select from %s', tbl), null,
      format('select 1 from public.%I limit 1', tbl));
    perform pg_temp.expect_error_as(format('anon: insert into %s', tbl), null,
      format('insert into public.%I default values', tbl));
    perform pg_temp.expect_error_as(format('anon: update %s', tbl), null,
      format('update public.%I set id = id where false', tbl));
    perform pg_temp.expect_error_as(format('anon: delete from %s', tbl), null,
      format('delete from public.%I where false', tbl));
  end loop;
  perform pg_temp.expect_error_as('anon: admin_list_users()', null, 'select * from public.admin_list_users()');
end
$$;

-- -----------------------------------------------------------------------------
-- [public-info] get_public_event_info() gives anon the current year and date,
-- and nothing at all when no event exists yet (the landing page then shows
-- "Date TBA").
-- -----------------------------------------------------------------------------
do $$
declare
  this_year constant integer := public.current_event_year();
begin
  perform pg_temp.expect_rows('public-info: exactly one row', null, 'select * from public.get_public_event_info()', 1);
  assert pg_temp.value_as(null, 'select year from public.get_public_event_info()') = this_year::text,
    '[public-info] year is the current event year';
  assert pg_temp.value_as(null, 'select event_date from public.get_public_event_info()') = make_date(this_year, 2, 15)::text,
    '[public-info] event_date is the current event''s date';
end
$$;

savepoint no_event_yet;
do $$
begin
  delete from public.event_settings;
  perform pg_temp.expect_rows('public-info: no event settings → no row', null,
    'select * from public.get_public_event_info()', 0);
end
$$;
rollback to savepoint no_event_yet;

-- -----------------------------------------------------------------------------
-- [outsiders] A signed-in user without a profile, and a deactivated member,
-- see no rows anywhere and can change nothing.
-- -----------------------------------------------------------------------------
do $$
declare
  outsider record;
  tbl text;
begin
  for outsider in
    select * from (values
      ('no profile', pg_temp.fx('stranger_auth'), null::uuid),
      ('deactivated', pg_temp.fx('former_auth'), pg_temp.fx('former'))
    ) v(label, auth_id, profile_id)
  loop
    foreach tbl in array array['event_settings', 'invitations', 'users', 'messages', 'message_likes', 'country_claims'] loop
      perform pg_temp.expect_rows(format('%s: sees no rows in %s', outsider.label, tbl), outsider.auth_id,
        format('select id from public.%I', tbl), 0);
    end loop;

    perform pg_temp.expect_error_as(format('%s: post a message as a member', outsider.label), outsider.auth_id,
      format('insert into public.messages (user_id, text) values (%L, %L)', pg_temp.fx('a'), 'T003 nope'));
    perform pg_temp.expect_error_as(format('%s: like a message as a member', outsider.label), outsider.auth_id,
      format('insert into public.message_likes (message_id, user_id) values (%L, %L)', pg_temp.fx('msg_former'), pg_temp.fx('a')));
    perform pg_temp.expect_error_as(format('%s: create an invitation', outsider.label), outsider.auth_id,
      $q$insert into public.invitations (type) values ('link')$q$);
    perform pg_temp.expect_error_as(format('%s: create event settings', outsider.label), outsider.auth_id,
      $q$insert into public.event_settings (year, event_date, theme_title) values (3000, '3000-02-15', 'Nope')$q$);
    perform pg_temp.expect_error_as(format('%s: create a profile directly', outsider.label), outsider.auth_id,
      $q$insert into public.users (name, email) values ('Nope', 't003-nope@example.test')$q$);

    perform pg_temp.expect_rows(format('%s: update a member''s profile', outsider.label), outsider.auth_id,
      format('update public.users set rsvp = %L where id = %L', 'attending', pg_temp.fx('a')), 0);
    perform pg_temp.expect_rows(format('%s: update event settings', outsider.label), outsider.auth_id,
      $q$update public.event_settings set theme_title = 'Nope'$q$, 0);
    perform pg_temp.expect_rows(format('%s: revoke an invitation', outsider.label), outsider.auth_id,
      $q$update public.invitations set status = 'revoked', revoked_at = now()$q$, 0);
    perform pg_temp.expect_rows(format('%s: delete a message', outsider.label), outsider.auth_id,
      format('delete from public.messages where id = %L', pg_temp.fx('msg_a')), 0);
    perform pg_temp.expect_rows(format('%s: delete a like', outsider.label), outsider.auth_id,
      format('delete from public.message_likes where message_id = %L', pg_temp.fx('msg_a')), 0);
    perform pg_temp.expect_error_as(format('%s: admin_list_users()', outsider.label), outsider.auth_id,
      'select * from public.admin_list_users()');

    if outsider.profile_id is not null then
      perform pg_temp.expect_error_as(format('%s: post a message as themselves', outsider.label), outsider.auth_id,
        format('insert into public.messages (user_id, text) values (%L, %L)', outsider.profile_id, 'T003 nope'));
      perform pg_temp.expect_rows(format('%s: update their own profile', outsider.label), outsider.auth_id,
        format('update public.users set rsvp = %L where id = %L', 'attending', outsider.profile_id), 0);
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- [profiles-read] Members read the member-safe columns of active profiles.
-- Email and the account-management columns are hidden, even on their own row
-- (A5). A deactivated profile is invisible to members.
-- -----------------------------------------------------------------------------
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  hidden_column text;
begin
  perform pg_temp.expect_rows('profiles-read: member sees active profiles, not the deactivated one', a_auth,
    format('select id from public.users where id = any (%L::uuid[])',
           array[pg_temp.fx('admin'), pg_temp.fx('a'), pg_temp.fx('b'), pg_temp.fx('former')]), 3);
  perform pg_temp.expect_rows('profiles-read: member reads every member-safe column', a_auth,
    format('select id, name, country, flag_url, rsvp, role, created_at from public.users where id = %L', pg_temp.fx('b')), 1);
  assert pg_temp.value_as(a_auth, format('select name from public.users where id = %L', pg_temp.fx('b'))) = 'T003 B',
    '[profiles-read] member reads another member''s name';

  foreach hidden_column in array array['email', 'auth_user_id', 'is_active', 'deactivated_at', 'invitation_id'] loop
    perform pg_temp.expect_error_as(format('profiles-read: member cannot read %s, even their own', hidden_column), a_auth,
      format('select %I from public.users where id = %L', hidden_column, pg_temp.fx('a')));
  end loop;
  -- PostgREST's select=* asks for every column, so clients must list columns.
  perform pg_temp.expect_error_as('profiles-read: select * is refused', a_auth, 'select * from public.users');
end
$$;

-- -----------------------------------------------------------------------------
-- [profiles-write] Members update only their own name, country, flag and RSVP.
-- -----------------------------------------------------------------------------
savepoint member_profile_writes;
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  a_id constant uuid := pg_temp.fx('a');
  b_id constant uuid := pg_temp.fx('b');
  saved public.users;
  attempt record;
begin
  perform pg_temp.expect_rows('profiles-write: member updates own name, country, flag and RSVP', a_auth,
    format('update public.users set name = %L, country = %L, flag_url = %L, rsvp = %L where id = %L',
           'T003 A Renamed', 'T003 Genovia', 'https://example.test/flags/a.png', 'attending', a_id), 1);
  select * into saved from public.users where id = a_id;
  assert saved.name = 'T003 A Renamed' and saved.country = 'T003 Genovia'
     and saved.flag_url = 'https://example.test/flags/a.png' and saved.rsvp = 'attending',
    '[profiles-write] the member''s own changes are saved';
  assert exists (
    select 1 from public.country_claims c
    where c.user_id = a_id and c.country = 'T003 Genovia' and c.event_year = public.current_event_year()
  ), '[profiles-write] a member changing their own country still logs a claim';

  perform pg_temp.expect_rows('profiles-write: member cannot update another member', a_auth,
    format('update public.users set rsvp = %L where id = %L', 'attending', b_id), 0);
  assert (select u.rsvp from public.users u where u.id = b_id) = 'no_response',
    '[profiles-write] the other member''s profile is unchanged';

  for attempt in
    select * from (values
      ('role', 'admin'),
      ('email', 't003-stolen@example.test'),
      ('is_active', 'false'),
      ('deactivated_at', '2000-01-01'),
      ('auth_user_id', pg_temp.fx('b_auth')::text),
      ('invitation_id', pg_temp.fx('invitation')::text),
      ('created_at', '2000-01-01')
    ) v(column_name, new_value)
  loop
    perform pg_temp.expect_error_as(format('profiles-write: member cannot set own %s', attempt.column_name), a_auth,
      format('update public.users set %I = %L where id = %L', attempt.column_name, attempt.new_value, a_id));
  end loop;
end
$$;
rollback to savepoint member_profile_writes;

-- -----------------------------------------------------------------------------
-- [profiles-admin] The admin reads every profile, deactivated ones included,
-- and edits anyone's name, country, flag and RSVP. Email and the
-- account-management columns go through RPCs instead (admin_list_users()
-- here; the write RPCs come with ISSUE-024), so the admin can't change them
-- with a plain UPDATE either.
-- -----------------------------------------------------------------------------
savepoint admin_profile_writes;
do $$
declare
  admin_auth constant uuid := pg_temp.fx('admin_auth');
  b_id constant uuid := pg_temp.fx('b');
  former_id constant uuid := pg_temp.fx('former');
  hidden_column text;
begin
  perform pg_temp.expect_rows('profiles-admin: admin sees the deactivated profile', admin_auth,
    format('select id from public.users where id = %L', former_id), 1);
  perform pg_temp.expect_rows('profiles-admin: admin updates another member''s RSVP and country', admin_auth,
    format('update public.users set rsvp = %L, country = %L where id = %L', 'not_attending', 'T003 Rohan', b_id), 1);
  assert (select u.rsvp from public.users u where u.id = b_id) = 'not_attending',
    '[profiles-admin] the admin''s change is saved';
  assert exists (
    select 1 from public.country_claims c
    where c.user_id = b_id and c.country = 'T003 Rohan' and c.event_year = public.current_event_year()
  ), '[profiles-admin] an admin country change logs a claim';
  perform pg_temp.expect_rows('profiles-admin: admin updates a deactivated profile', admin_auth,
    format('update public.users set name = %L where id = %L', 'T003 Former Renamed', former_id), 1);

  foreach hidden_column in array array['email', 'is_active'] loop
    perform pg_temp.expect_error_as(format('profiles-admin: admin cannot read %s through the table', hidden_column), admin_auth,
      format('select %I from public.users where id = %L', hidden_column, b_id));
  end loop;
  perform pg_temp.expect_error_as('profiles-admin: admin cannot set role with a plain UPDATE', admin_auth,
    format('update public.users set role = %L where id = %L', 'admin', b_id));
  perform pg_temp.expect_error_as('profiles-admin: admin cannot deactivate with a plain UPDATE', admin_auth,
    format('update public.users set is_active = false, deactivated_at = now() where id = %L', b_id));
end
$$;
rollback to savepoint admin_profile_writes;

-- -----------------------------------------------------------------------------
-- [admin-list] admin_list_users() returns every profile with every column,
-- emails included, to the admin only.
-- -----------------------------------------------------------------------------
do $$
declare
  admin_auth constant uuid := pg_temp.fx('admin_auth');
begin
  perform pg_temp.expect_rows('admin-list: admin gets every profile, deactivated included', admin_auth,
    format('select id from public.admin_list_users() where id = any (%L::uuid[])',
           array[pg_temp.fx('admin'), pg_temp.fx('a'), pg_temp.fx('b'), pg_temp.fx('former')]), 4);
  assert pg_temp.value_as(admin_auth,
           format('select email from public.admin_list_users() where id = %L', pg_temp.fx('a'))) = 't003-a@example.test',
    '[admin-list] admin reads a member''s email';
  assert pg_temp.value_as(admin_auth,
           format('select is_active from public.admin_list_users() where id = %L', pg_temp.fx('former'))) = 'false',
    '[admin-list] admin sees who is deactivated';
  perform pg_temp.expect_error_as('admin-list: a member is refused', pg_temp.fx('a_auth'),
    'select * from public.admin_list_users()');
end
$$;

-- -----------------------------------------------------------------------------
-- [invitations] Admin only. The admin reads, creates and revokes invitations,
-- but the database owns the token, status, use count and year.
-- -----------------------------------------------------------------------------
savepoint invitation_checks;
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  admin_auth constant uuid := pg_temp.fx('admin_auth');
  invitation_id constant uuid := pg_temp.fx('invitation');
  created public.invitations;
  attempt record;
begin
  perform pg_temp.expect_rows('invitations: member sees none', a_auth, 'select id from public.invitations', 0);
  perform pg_temp.expect_error_as('invitations: member cannot create one', a_auth,
    $q$insert into public.invitations (type) values ('link')$q$);
  perform pg_temp.expect_rows('invitations: member cannot revoke one', a_auth,
    format('update public.invitations set status = %L, revoked_at = now() where id = %L', 'revoked', invitation_id), 0);

  assert pg_temp.value_as(admin_auth, format('select token from public.invitations where id = %L', invitation_id))
         = (select i.token from public.invitations i where i.id = invitation_id),
    '[invitations] admin reads an invitation, token included (needed to rebuild the link)';
  perform pg_temp.expect_rows('invitations: admin creates a multi-use link', admin_auth,
    $q$insert into public.invitations (type, max_uses) values ('link', 5)$q$, 1);
  perform pg_temp.expect_rows('invitations: admin creates an email invitation', admin_auth,
    $q$insert into public.invitations (type, email) values ('email', 't003-invitee@example.test')$q$, 1);
  select * into created from public.invitations i where i.email = 't003-invitee@example.test';
  assert created.token ~ '^[0-9a-f]{64}$' and created.status = 'pending' and created.use_count = 0
     and created.event_year = public.current_event_year(),
    '[invitations] the database fills in token, status, use count and year';

  for attempt in
    select * from (values
      ('token', $q$insert into public.invitations (type, token) values ('link', repeat('a', 64))$q$),
      ('status', $q$insert into public.invitations (type, status) values ('link', 'pending')$q$),
      ('use_count', $q$insert into public.invitations (type, use_count) values ('link', 0)$q$),
      ('event_year', $q$insert into public.invitations (type, event_year) values ('link', 1999)$q$)
    ) v(column_name, statement)
  loop
    perform pg_temp.expect_error_as(format('invitations: admin cannot choose %s', attempt.column_name), admin_auth,
      attempt.statement);
  end loop;

  perform pg_temp.expect_rows('invitations: admin revokes one', admin_auth,
    format('update public.invitations set status = %L, revoked_at = now() where id = %L', 'revoked', invitation_id), 1);
  perform pg_temp.expect_error_as('invitations: admin cannot change the use count', admin_auth,
    format('update public.invitations set use_count = 0 where id = %L', invitation_id));
  perform pg_temp.expect_error_as('invitations: admin cannot delete one (they are revoked, never deleted)', admin_auth,
    format('delete from public.invitations where id = %L', invitation_id));
end
$$;
rollback to savepoint invitation_checks;

-- -----------------------------------------------------------------------------
-- [messages] Members read this year's messages and post only as themselves,
-- into this year. Nobody edits messages. Only the admin deletes (A7), and a
-- deleted message takes its likes with it.
-- -----------------------------------------------------------------------------
savepoint message_checks;
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  admin_auth constant uuid := pg_temp.fx('admin_auth');
  a_id constant uuid := pg_temp.fx('a');
  author_sql constant text :=
    'select coalesce(u.name, ''(former member)'') from public.messages m '
    'left join public.users u on u.id = m.user_id where m.id = %L';
begin
  perform pg_temp.expect_rows('messages: member reads this year''s messages, not last year''s', a_auth,
    format('select id from public.messages where id = any (%L::uuid[])',
           array[pg_temp.fx('msg_a'), pg_temp.fx('msg_b'), pg_temp.fx('msg_former'), pg_temp.fx('msg_old')]), 3);
  assert pg_temp.value_as(a_auth, format(author_sql, pg_temp.fx('msg_former'))) = '(former member)',
    '[messages] a deactivated author''s message stays, but members can''t see who wrote it';
  assert pg_temp.value_as(admin_auth, format(author_sql, pg_temp.fx('msg_former'))) = 'T003 Former',
    '[messages] the admin sees the deactivated author''s name';

  perform pg_temp.expect_rows('messages: member posts as themselves', a_auth,
    format('insert into public.messages (user_id, text) values (%L, %L)', a_id, 'T003 posted by A'), 1);
  assert (select m.event_year from public.messages m where m.text = 'T003 posted by A') = public.current_event_year(),
    '[messages] a new message lands in the current year';
  perform pg_temp.expect_error_as('messages: member cannot post as someone else', a_auth,
    format('insert into public.messages (user_id, text) values (%L, %L)', pg_temp.fx('b'), 'T003 forged'));
  perform pg_temp.expect_error_as('messages: member cannot choose the year', a_auth,
    format('insert into public.messages (user_id, text, event_year) values (%L, %L, %s)',
           a_id, 'T003 backdated', public.current_event_year() - 1));
  perform pg_temp.expect_error_as('messages: member cannot choose the timestamp', a_auth,
    format('insert into public.messages (user_id, text, created_at) values (%L, %L, %L)', a_id, 'T003 backdated', '2000-01-01'));

  perform pg_temp.expect_error_as('messages: member cannot edit their own message', a_auth,
    format('update public.messages set text = %L where id = %L', 'T003 edited', pg_temp.fx('msg_a')));
  perform pg_temp.expect_rows('messages: member cannot delete their own message', a_auth,
    format('delete from public.messages where id = %L', pg_temp.fx('msg_a')), 0);
  perform pg_temp.expect_rows('messages: member cannot delete another''s message', a_auth,
    format('delete from public.messages where id = %L', pg_temp.fx('msg_b')), 0);
  assert (select count(*) from public.messages m where m.id in (pg_temp.fx('msg_a'), pg_temp.fx('msg_b'))) = 2,
    '[messages] both messages survive the member''s delete attempts';

  perform pg_temp.expect_rows('messages: the admin doesn''t see last year''s messages either', admin_auth,
    format('select id from public.messages where id = %L', pg_temp.fx('msg_old')), 0);
  perform pg_temp.expect_rows('messages: admin cannot delete an archived message', admin_auth,
    format('delete from public.messages where id = %L', pg_temp.fx('msg_old')), 0);
  perform pg_temp.expect_rows('messages: admin deletes another member''s message', admin_auth,
    format('delete from public.messages where id = %L', pg_temp.fx('msg_b')), 1);
  assert not exists (select 1 from public.message_likes l where l.message_id = pg_temp.fx('msg_b')),
    '[messages] deleting a message deletes its likes, including likes the admin can''t delete directly';
end
$$;
rollback to savepoint message_checks;

-- -----------------------------------------------------------------------------
-- [likes] Members read likes on the messages they can see, and like or unlike
-- only as themselves, only on this year's messages.
-- -----------------------------------------------------------------------------
savepoint like_checks;
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  a_id constant uuid := pg_temp.fx('a');
  b_id constant uuid := pg_temp.fx('b');
  msg_a constant uuid := pg_temp.fx('msg_a');
begin
  perform pg_temp.expect_rows('likes: member reads likes on this year''s messages', a_auth,
    format('select id from public.message_likes where message_id = %L', msg_a), 1);
  perform pg_temp.expect_rows('likes: member cannot see likes on last year''s messages', a_auth,
    format('select id from public.message_likes where message_id = %L', pg_temp.fx('msg_old')), 0);

  perform pg_temp.expect_rows('likes: member likes a message', a_auth,
    format('insert into public.message_likes (message_id, user_id) values (%L, %L)', msg_a, a_id), 1);
  perform pg_temp.expect_error_as('likes: member cannot like as someone else', a_auth,
    format('insert into public.message_likes (message_id, user_id) values (%L, %L)', pg_temp.fx('msg_former'), b_id));
  perform pg_temp.expect_error_as('likes: member cannot like last year''s message', a_auth,
    format('insert into public.message_likes (message_id, user_id) values (%L, %L)', pg_temp.fx('msg_old'), a_id));
  perform pg_temp.expect_error_as('likes: member cannot choose the timestamp', a_auth,
    format('insert into public.message_likes (message_id, user_id, created_at) values (%L, %L, %L)',
           pg_temp.fx('msg_former'), a_id, '2000-01-01'));

  perform pg_temp.expect_rows('likes: member unlikes', a_auth,
    format('delete from public.message_likes where message_id = %L and user_id = %L', msg_a, a_id), 1);
  perform pg_temp.expect_rows('likes: member cannot remove someone else''s like', a_auth,
    format('delete from public.message_likes where message_id = %L and user_id = %L', msg_a, b_id), 0);
  assert exists (select 1 from public.message_likes l where l.message_id = msg_a and l.user_id = b_id),
    '[likes] the other member''s like survives';
  perform pg_temp.expect_error_as('likes: likes cannot be edited', a_auth,
    format('update public.message_likes set user_id = user_id where message_id = %L', msg_a));
end
$$;
rollback to savepoint like_checks;

-- -----------------------------------------------------------------------------
-- [claims] Members read this year's claims. Nobody writes claims through the
-- API: the trigger on users is the only writer (A10, ADR-011).
-- -----------------------------------------------------------------------------
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  admin_auth constant uuid := pg_temp.fx('admin_auth');
  b_id constant uuid := pg_temp.fx('b');
begin
  perform pg_temp.expect_rows('claims: member reads this year''s claims, not last year''s', a_auth,
    format('select id from public.country_claims where user_id = %L', b_id), 1);
  perform pg_temp.expect_rows('claims: the admin also reads only this year''s', admin_auth,
    format('select id from public.country_claims where user_id = %L', b_id), 1);
  perform pg_temp.expect_error_as('claims: member cannot insert a claim', a_auth,
    format('insert into public.country_claims (user_id, country) values (%L, %L)', b_id, 'T003 Forged'));
  perform pg_temp.expect_error_as('claims: admin cannot insert a claim', admin_auth,
    format('insert into public.country_claims (user_id, country) values (%L, %L)', b_id, 'T003 Forged'));
  perform pg_temp.expect_error_as('claims: member cannot edit a claim', a_auth,
    format('update public.country_claims set country = %L where user_id = %L', 'T003 Forged', b_id));
  perform pg_temp.expect_error_as('claims: member cannot delete a claim', a_auth,
    format('delete from public.country_claims where user_id = %L', b_id));
end
$$;

-- -----------------------------------------------------------------------------
-- [settings] Members read event settings. Only the admin creates and updates
-- them, and nobody deletes them or changes a row's year.
-- -----------------------------------------------------------------------------
savepoint settings_checks;
do $$
declare
  a_auth constant uuid := pg_temp.fx('a_auth');
  admin_auth constant uuid := pg_temp.fx('admin_auth');
  this_year constant integer := public.current_event_year();
  saved public.event_settings;
begin
  assert pg_temp.value_as(a_auth, format('select theme_title from public.event_settings where year = %s', this_year)) = 'T003 Theme',
    '[settings] member reads the current theme';
  perform pg_temp.expect_rows('settings: member cannot update', a_auth,
    format('update public.event_settings set theme_title = %L where year = %s', 'T003 Hacked', this_year), 0);
  assert (select s.theme_title from public.event_settings s where s.year = this_year) = 'T003 Theme',
    '[settings] the theme is unchanged after the member''s attempt';
  perform pg_temp.expect_error_as('settings: member cannot create', a_auth,
    format('insert into public.event_settings (year, event_date, theme_title) values (%s, %L, %L)',
           this_year + 1, make_date(this_year + 1, 2, 15), 'T003 Next'));
  perform pg_temp.expect_error_as('settings: member cannot delete', a_auth,
    format('delete from public.event_settings where year = %s', this_year));

  perform pg_temp.expect_rows('settings: admin updates date, title and description', admin_auth,
    format('update public.event_settings set event_date = %L, theme_title = %L, theme_desc = %L where year = %s',
           make_date(this_year, 3, 1), 'T003 Updated', 'T003 new description', this_year), 1);
  select * into saved from public.event_settings s where s.year = this_year;
  assert saved.event_date = make_date(this_year, 3, 1) and saved.theme_title = 'T003 Updated'
     and saved.theme_desc = 'T003 new description',
    '[settings] the admin''s changes are saved';
  perform pg_temp.expect_error_as('settings: admin cannot change a row''s year', admin_auth,
    format('update public.event_settings set year = %s where year = %s', this_year + 10, this_year));
  perform pg_temp.expect_error_as('settings: admin cannot delete', admin_auth,
    format('delete from public.event_settings where year = %s', this_year));
  perform pg_temp.expect_rows('settings: admin creates next year''s settings', admin_auth,
    format('insert into public.event_settings (year, event_date, theme_title) values (%s, %L, %L)',
           this_year + 1, make_date(this_year + 1, 2, 15), 'T003 Next'), 1);
end
$$;
rollback to savepoint settings_checks;

rollback;
