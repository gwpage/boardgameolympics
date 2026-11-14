-- =============================================================================
-- tests/db/test_002_schema.sql: ISSUE-002 tests for the schema, constraints,
-- the country-claim trigger and the membership helper functions.
--
-- HOW TO RUN (dev project only, never prod):
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--     PASS: "Success. No rows returned".
--     FAIL: an error whose message starts with the [label] of the failed check.
--   Or locally, against a throwaway Postgres: tests/db/run_local.sh
--
-- SAFE TO RE-RUN: everything happens in one transaction that is rolled back at
-- the end, so the database is left exactly as it was. Test rows use addresses
-- at example.test (a reserved domain), so they can't collide with real or
-- seeded users. No check assumes the tables start empty.
--
-- Run as the SQL Editor's default `postgres` role. The tests insert throwaway
-- rows into auth.users to simulate signed-in users.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Test helpers. They live in pg_temp, so they vanish with the rollback.
-- -----------------------------------------------------------------------------

-- Fails unless p_sql raises an error with SQLSTATE p_sqlstate. Common codes:
-- 23514 check_violation, 23505 unique_violation, 23503 foreign_key_violation,
-- 23502 not_null_violation.
create function pg_temp.expect_error(p_label text, p_sql text, p_sqlstate text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_sqlstate then
      return;
    end if;
    raise exception '[%] expected SQLSTATE % but got % (%)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception '[%] expected SQLSTATE % but the statement succeeded', p_label, p_sqlstate;
end;
$$;

-- Creates a profile with a predictable test email and returns its id.
create function pg_temp.new_user(p_tag text, p_country text default null)
returns uuid
language sql
as $$
  insert into public.users (name, email, country)
  values ('Test ' || p_tag, 't002-' || p_tag || '@example.test', p_country)
  returning id
$$;

-- Creates a Supabase Auth user (id and email only) and returns its id.
create function pg_temp.new_auth_user(p_tag text)
returns uuid
language sql
as $$
  insert into auth.users (id, email)
  values (gen_random_uuid(), 't002-auth-' || p_tag || '@example.test')
  returning id
$$;

-- Simulates a signed-in user the way PostgREST does, by setting the JWT
-- claims that auth.uid() reads. Pass null to simulate a signed-out request.
create function pg_temp.sign_in_as(p_auth_user_id uuid)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    case when p_auth_user_id is null then ''
         else json_build_object('sub', p_auth_user_id, 'role', 'authenticated')::text end,
    true
  );
$$;

-- The user's claimed countries, sorted, so checks don't depend on timestamps
-- (now() is the same for every row in a transaction).
create function pg_temp.claims_for(p_user_id uuid)
returns text[]
language sql
as $$
  select coalesce(array_agg(country order by country), '{}')
  from public.country_claims
  where user_id = p_user_id
$$;

-- -----------------------------------------------------------------------------
-- [tables] All six tables exist with exactly the expected columns, and RLS is on.
-- -----------------------------------------------------------------------------
do $$
declare
  expected constant jsonb := jsonb_build_object(
    'users', jsonb_build_array('id', 'auth_user_id', 'name', 'email', 'country', 'flag_url', 'rsvp', 'role',
                               'is_active', 'deactivated_at', 'invitation_id', 'created_at'),
    'invitations', jsonb_build_array('id', 'type', 'email', 'token', 'status', 'max_uses', 'use_count',
                                     'event_year', 'created_at', 'accepted_at', 'revoked_at'),
    'messages', jsonb_build_array('id', 'user_id', 'text', 'event_year', 'created_at'),
    'message_likes', jsonb_build_array('id', 'message_id', 'user_id', 'created_at'),
    'event_settings', jsonb_build_array('id', 'year', 'event_date', 'theme_title', 'theme_desc', 'updated_at'),
    'country_claims', jsonb_build_array('id', 'user_id', 'country', 'event_year', 'claimed_at')
  );
  tbl text;
  want text[];
  actual text[];
  rls_enabled boolean;
begin
  for tbl in select jsonb_object_keys(expected) loop
    want := array(select jsonb_array_elements_text(expected -> tbl));
    actual := array(
      select c.column_name::text
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = tbl
    );
    -- Set comparison: column order doesn't matter, names do.
    assert actual @> want and want @> actual,
      format('[tables] public.%s columns: expected %s, got %s', tbl, want, actual);

    select c.relrowsecurity into rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = tbl;
    assert rls_enabled, format('[tables] RLS must be enabled on public.%s (deny by default)', tbl);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- [defaults] A minimal insert gets the spec's defaults.
-- -----------------------------------------------------------------------------
do $$
declare
  member public.users;
  invite public.invitations;
begin
  insert into public.users (name, email) values ('Defaults', 't002-defaults@example.test')
  returning * into member;
  assert member.rsvp = 'no_response', '[defaults] rsvp defaults to no_response';
  assert member.role = 'user', '[defaults] role defaults to user';
  assert member.is_active, '[defaults] new users are active';
  assert member.deactivated_at is null, '[defaults] deactivated_at starts null';
  assert member.auth_user_id is null, '[defaults] profiles start unlinked from auth';

  insert into public.invitations (type) values ('link') returning * into invite;
  assert invite.status = 'pending', '[defaults] invitation status defaults to pending';
  assert invite.max_uses = 1, '[defaults] invitations are single-use by default';
  assert invite.use_count = 0, '[defaults] use_count starts at 0';
  assert invite.event_year = public.current_event_year(), '[defaults] invitation event_year defaults to the current year';
end
$$;

-- -----------------------------------------------------------------------------
-- [email] Emails are unique ignoring case, and must look like an address.
-- -----------------------------------------------------------------------------
do $$
begin
  perform pg_temp.new_user('Case.Mixed');
  perform pg_temp.expect_error('email: same address in different case',
    $q$insert into public.users (name, email) values ('Dup', 'T002-CASE.MIXED@EXAMPLE.TEST')$q$, '23505');
  perform pg_temp.expect_error('email: no @',
    $q$insert into public.users (name, email) values ('Bad', 'not-an-address')$q$, '23514');
  perform pg_temp.expect_error('email: contains a space',
    $q$insert into public.users (name, email) values ('Bad', 'two words@example.test')$q$, '23514');
  perform pg_temp.expect_error('email: over 254 characters',
    format('insert into public.users (name, email) values (%L, %L)', 'Bad', repeat('x', 243) || '@example.test'), '23514');
  perform pg_temp.expect_error('email: required',
    $q$insert into public.users (name) values ('No email')$q$, '23502');
end
$$;

-- -----------------------------------------------------------------------------
-- [name] Names are required, non-blank, and at most 100 characters.
-- -----------------------------------------------------------------------------
do $$
begin
  insert into public.users (name, email) values (repeat('n', 100), 't002-name100@example.test');
  perform pg_temp.expect_error('name: 101 characters',
    format('insert into public.users (name, email) values (%L, %L)', repeat('n', 101), 't002-name101@example.test'), '23514');
  perform pg_temp.expect_error('name: whitespace only',
    format('insert into public.users (name, email) values (%L, %L)', E' \t\n ', 't002-blankname@example.test'), '23514');
end
$$;

-- -----------------------------------------------------------------------------
-- [country] Country is optional, non-blank when set, and at most 100
-- characters, counted as characters (code points) rather than bytes.
-- -----------------------------------------------------------------------------
do $$
declare
  member_id uuid := pg_temp.new_user('country');
begin
  perform pg_temp.new_user('country100', repeat('c', 100));
  perform pg_temp.new_user('country100emoji', repeat('🎲', 100));
  perform pg_temp.new_user('countrynull', null);
  perform pg_temp.expect_error('country: 101 characters',
    format('insert into public.users (name, email, country) values (%L, %L, %L)', 'C', 't002-c101@example.test', repeat('c', 101)), '23514');
  perform pg_temp.expect_error('country: 101 emoji',
    format('insert into public.users (name, email, country) values (%L, %L, %L)', 'C', 't002-c101e@example.test', repeat('🎲', 101)), '23514');
  perform pg_temp.expect_error('country: whitespace only (blank must be stored as null)',
    format('update public.users set country = %L where id = %L', '   ', member_id), '23514');
  perform pg_temp.expect_error('country: update to 101 characters',
    format('update public.users set country = %L where id = %L', repeat('c', 101), member_id), '23514');
end
$$;

-- -----------------------------------------------------------------------------
-- [flag_url] Flag URLs must be https, so a profile can't point other members'
-- browsers at javascript:, data: or plain-http URLs.
-- -----------------------------------------------------------------------------
do $$
declare
  member_id uuid := pg_temp.new_user('flag');
begin
  update public.users set flag_url = 'https://example.test/storage/v1/object/public/flags/x.png' where id = member_id;
  perform pg_temp.expect_error('flag_url: javascript: scheme',
    format('update public.users set flag_url = %L where id = %L', 'javascript:alert(1)', member_id), '23514');
  perform pg_temp.expect_error('flag_url: data: scheme',
    format('update public.users set flag_url = %L where id = %L', 'data:image/png;base64,AAAA', member_id), '23514');
  perform pg_temp.expect_error('flag_url: plain http',
    format('update public.users set flag_url = %L where id = %L', 'http://example.test/x.png', member_id), '23514');
  perform pg_temp.expect_error('flag_url: over 2048 characters',
    format('update public.users set flag_url = %L where id = %L', 'https://example.test/' || repeat('x', 2048), member_id), '23514');
end
$$;

-- -----------------------------------------------------------------------------
-- [messages] Text must contain a non-whitespace character and be at most 1000
-- characters (code points, matching the client-side counter).
-- -----------------------------------------------------------------------------
do $$
declare
  member_id uuid := pg_temp.new_user('poster');
begin
  insert into public.messages (user_id, text) values (member_id, repeat('m', 1000));
  insert into public.messages (user_id, text) values (member_id, repeat('🎲', 1000));
  perform pg_temp.expect_error('messages: whitespace only',
    format('insert into public.messages (user_id, text) values (%L, %L)', member_id, E'  \n\t  '), '23514');
  perform pg_temp.expect_error('messages: empty',
    format('insert into public.messages (user_id, text) values (%L, %L)', member_id, ''), '23514');
  perform pg_temp.expect_error('messages: 1001 characters',
    format('insert into public.messages (user_id, text) values (%L, %L)', member_id, repeat('m', 1001)), '23514');
  perform pg_temp.expect_error('messages: author must exist',
    format('insert into public.messages (user_id, text) values (%L, %L)', gen_random_uuid(), 'hi'), '23503');
end
$$;

-- -----------------------------------------------------------------------------
-- [enums] rsvp, role, invitation type and invitation status reject unknown values.
-- -----------------------------------------------------------------------------
do $$
declare
  member_id uuid := pg_temp.new_user('enums');
begin
  update public.users set rsvp = 'attending' where id = member_id;
  update public.users set rsvp = 'not_attending' where id = member_id;
  update public.users set role = 'admin' where id = member_id;
  perform pg_temp.expect_error('enums: rsvp maybe',
    format('update public.users set rsvp = %L where id = %L', 'maybe', member_id), '23514');
  perform pg_temp.expect_error('enums: role superadmin',
    format('update public.users set role = %L where id = %L', 'superadmin', member_id), '23514');
  perform pg_temp.expect_error('enums: invitation type sms',
    $q$insert into public.invitations (type) values ('sms')$q$, '23514');
  perform pg_temp.expect_error('enums: invitation status expired',
    $q$insert into public.invitations (type, status) values ('link', 'expired')$q$, '23514');
end
$$;

-- -----------------------------------------------------------------------------
-- [likes] One like per user per message; likes go when their message goes.
-- -----------------------------------------------------------------------------
do $$
declare
  author_id uuid := pg_temp.new_user('likes-author');
  fan_id uuid := pg_temp.new_user('likes-fan');
  liked_message_id uuid;
  remaining integer;
begin
  insert into public.messages (user_id, text) values (author_id, 'Like me') returning id into liked_message_id;
  insert into public.message_likes (message_id, user_id) values (liked_message_id, fan_id);
  insert into public.message_likes (message_id, user_id) values (liked_message_id, author_id);
  perform pg_temp.expect_error('likes: second like by the same user',
    format('insert into public.message_likes (message_id, user_id) values (%L, %L)', liked_message_id, fan_id), '23505');

  delete from public.messages where id = liked_message_id;
  select count(*) into remaining from public.message_likes l where l.message_id = liked_message_id;
  assert remaining = 0, format('[likes] deleting a message must delete its likes; %s remain', remaining);
end
$$;

-- -----------------------------------------------------------------------------
-- [claims] The trigger logs a country claim on every change to a new non-null
-- country, and on nothing else.
-- -----------------------------------------------------------------------------
do $$
declare
  member_id uuid;
  blank_id uuid;
  claim public.country_claims;
begin
  member_id := pg_temp.new_user('claims', 'Catan');
  assert pg_temp.claims_for(member_id) = array['Catan'], '[claims] inserting a user with a country creates a claim';
  select * into claim from public.country_claims where user_id = member_id;
  assert claim.event_year = public.current_event_year(), '[claims] a claim is stamped with the current event year';

  blank_id := pg_temp.new_user('claims-blank');
  assert pg_temp.claims_for(blank_id) = '{}', '[claims] inserting a user without a country creates no claim';

  update public.users set country = 'Azul' where id = member_id;
  assert pg_temp.claims_for(member_id) = array['Azul', 'Catan'], '[claims] changing the country creates a second claim';

  update public.users set country = 'Azul' where id = member_id;
  assert pg_temp.claims_for(member_id) = array['Azul', 'Catan'], '[claims] re-saving the same country creates no claim';

  update public.users set rsvp = 'attending' where id = member_id;
  assert pg_temp.claims_for(member_id) = array['Azul', 'Catan'], '[claims] changing another column creates no claim';

  update public.users set country = null where id = member_id;
  assert pg_temp.claims_for(member_id) = array['Azul', 'Catan'], '[claims] clearing the country creates no claim';

  update public.users set country = 'Catan' where id = member_id;
  assert pg_temp.claims_for(member_id) = array['Azul', 'Catan', 'Catan'],
    '[claims] setting a country again after clearing it creates a claim';
end
$$;

-- -----------------------------------------------------------------------------
-- [event_year] current_event_year() is the newest event_settings year, or the
-- calendar year before any settings exist. Destructive, so it runs inside a
-- savepoint that is rolled back straight afterwards.
-- -----------------------------------------------------------------------------
savepoint event_year_checks;
do $$
declare
  base_year integer;
  member_id uuid := pg_temp.new_user('event-year');
  message_year integer;
  settings public.event_settings;
begin
  select coalesce(max(year), extract(year from current_date)::integer) into base_year from public.event_settings;
  insert into public.event_settings (year, event_date, theme_title)
  values (base_year + 1, make_date(base_year + 1, 2, 15), 'T002 one'),
         (base_year + 5, make_date(base_year + 5, 2, 15), 'T002 five');
  assert public.current_event_year() = base_year + 5,
    format('[event_year] expected %s, got %s', base_year + 5, public.current_event_year());

  insert into public.messages (user_id, text) values (member_id, 'Which year?') returning event_year into message_year;
  assert message_year = base_year + 5, '[event_year] messages default to the current event year';

  perform pg_temp.expect_error('event_year: one settings row per year',
    format('insert into public.event_settings (year, event_date, theme_title) values (%s, %L, %L)',
           base_year + 5, make_date(base_year + 5, 3, 1), 'Duplicate'), '23505');
  perform pg_temp.expect_error('event_year: theme title is required',
    format('insert into public.event_settings (year, event_date, theme_title) values (%s, %L, %L)',
           base_year + 6, make_date(base_year + 6, 2, 15), '  '), '23514');
  perform pg_temp.expect_error('event_year: theme title over 100 characters',
    format('insert into public.event_settings (year, event_date, theme_title) values (%s, %L, %L)',
           base_year + 6, make_date(base_year + 6, 2, 15), repeat('t', 101)), '23514');
  perform pg_temp.expect_error('event_year: theme description over 2000 characters',
    format('insert into public.event_settings (year, event_date, theme_title, theme_desc) values (%s, %L, %L, %L)',
           base_year + 6, make_date(base_year + 6, 2, 15), 'Long', repeat('d', 2001)), '23514');

  -- updated_at is bumped by a trigger. now() is constant within a transaction,
  -- so start from an old timestamp and check that it moved.
  update public.event_settings set updated_at = '2000-01-01' where year = base_year + 5;
  update public.event_settings set theme_title = 'T002 renamed' where year = base_year + 5 returning * into settings;
  assert settings.updated_at = now(), '[event_year] updating event_settings bumps updated_at';

  delete from public.event_settings;
  assert public.current_event_year() = extract(year from current_date)::integer,
    '[event_year] with no event_settings rows, the current year is the calendar year';
end
$$;
rollback to savepoint event_year_checks;

-- -----------------------------------------------------------------------------
-- [helpers] is_member(), is_admin() and current_member_id() for an admin, a
-- member, a deactivated member, a deactivated admin, an auth user with no
-- profile, and a signed-out request.
-- -----------------------------------------------------------------------------
do $$
declare
  admin_auth uuid := pg_temp.new_auth_user('admin');
  member_auth uuid := pg_temp.new_auth_user('member');
  former_auth uuid := pg_temp.new_auth_user('former');
  former_admin_auth uuid := pg_temp.new_auth_user('former-admin');
  stranger_auth uuid := pg_temp.new_auth_user('stranger');
  admin_id uuid;
  member_id uuid;
begin
  insert into public.users (name, email, role, auth_user_id)
  values ('T002 Admin', 't002-admin@example.test', 'admin', admin_auth) returning id into admin_id;
  insert into public.users (name, email, auth_user_id)
  values ('T002 Member', 't002-member@example.test', member_auth) returning id into member_id;
  insert into public.users (name, email, auth_user_id, is_active, deactivated_at)
  values ('T002 Former', 't002-former@example.test', former_auth, false, now());
  insert into public.users (name, email, role, auth_user_id, is_active, deactivated_at)
  values ('T002 Former Admin', 't002-former-admin@example.test', 'admin', former_admin_auth, false, now());

  perform pg_temp.sign_in_as(admin_auth);
  assert public.is_member(), '[helpers] an active admin is a member';
  assert public.is_admin(), '[helpers] an active admin is an admin';
  assert public.current_member_id() = admin_id, '[helpers] current_member_id() is the admin''s profile id';

  perform pg_temp.sign_in_as(member_auth);
  assert public.is_member(), '[helpers] an active member is a member';
  assert not public.is_admin(), '[helpers] an active member is not an admin';
  assert public.current_member_id() = member_id, '[helpers] current_member_id() is the member''s profile id';

  perform pg_temp.sign_in_as(former_auth);
  assert not public.is_member(), '[helpers] a deactivated member is not a member';
  assert not public.is_admin(), '[helpers] a deactivated member is not an admin';
  assert public.current_member_id() is null, '[helpers] a deactivated member has no current_member_id()';

  perform pg_temp.sign_in_as(former_admin_auth);
  assert not public.is_member(), '[helpers] a deactivated admin is not a member';
  assert not public.is_admin(), '[helpers] a deactivated admin is not an admin';

  perform pg_temp.sign_in_as(stranger_auth);
  assert not public.is_member(), '[helpers] an auth user without a profile is not a member';
  assert not public.is_admin(), '[helpers] an auth user without a profile is not an admin';
  assert public.current_member_id() is null, '[helpers] an auth user without a profile has no current_member_id()';

  perform pg_temp.sign_in_as(null);
  assert not public.is_member(), '[helpers] a signed-out request is not a member';
  assert not public.is_admin(), '[helpers] a signed-out request is not an admin';
  assert public.current_member_id() is null, '[helpers] a signed-out request has no current_member_id()';
end
$$;

-- -----------------------------------------------------------------------------
-- [security] Helper and trigger functions are SECURITY DEFINER with an empty
-- search_path, and anon can't execute them.
-- -----------------------------------------------------------------------------
do $$
declare
  definer_functions constant text[] := array[
    'current_event_year', 'current_member_id', 'is_member', 'is_admin', 'record_country_claim'
  ];
  member_helpers constant text[] := array['current_event_year()', 'current_member_id()', 'is_member()', 'is_admin()'];
  fn record;
  found_count integer := 0;
  signature text;
begin
  for fn in
    select p.proname, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (definer_functions)
  loop
    found_count := found_count + 1;
    assert fn.prosecdef, format('[security] public.%s must be SECURITY DEFINER', fn.proname);
    assert fn.proconfig is not null and fn.proconfig && array['search_path=""', 'search_path='],
      format('[security] public.%s must set an empty search_path, has %s', fn.proname, fn.proconfig);
  end loop;
  assert found_count = cardinality(definer_functions),
    format('[security] expected %s definer functions, found %s', cardinality(definer_functions), found_count);

  foreach signature in array member_helpers loop
    assert not has_function_privilege('anon', 'public.' || signature, 'execute'),
      format('[security] anon must not execute public.%s', signature);
    assert has_function_privilege('authenticated', 'public.' || signature, 'execute'),
      format('[security] authenticated must execute public.%s (RLS policies call it)', signature);
  end loop;

  assert not has_function_privilege('authenticated', 'public.record_country_claim()', 'execute'),
    '[security] nobody but the owner may execute the claim trigger function';
  assert not has_function_privilege('anon', 'public.record_country_claim()', 'execute'),
    '[security] nobody but the owner may execute the claim trigger function';
end
$$;

-- -----------------------------------------------------------------------------
-- [accounts] Soft delete, auth linking, and protection of history.
-- -----------------------------------------------------------------------------
do $$
declare
  auth_id uuid := pg_temp.new_auth_user('link');
  member_id uuid;
  unlinked_auth_id uuid;
  unlinked_id uuid;
  linked uuid;
begin
  insert into public.users (name, email, auth_user_id)
  values ('T002 Linked', 't002-linked@example.test', auth_id) returning id into member_id;

  perform pg_temp.expect_error('accounts: one profile per auth user',
    format('insert into public.users (name, email, auth_user_id) values (%L, %L, %L)', 'Twin', 't002-twin@example.test', auth_id),
    '23505');
  perform pg_temp.expect_error('accounts: auth_user_id must be a real auth user',
    format('update public.users set auth_user_id = %L where id = %L', gen_random_uuid(), member_id), '23503');
  perform pg_temp.expect_error('accounts: inactive needs deactivated_at',
    format('update public.users set is_active = false where id = %L', member_id), '23514');
  perform pg_temp.expect_error('accounts: active must not have deactivated_at',
    format('update public.users set deactivated_at = now() where id = %L', member_id), '23514');
  update public.users set is_active = false, deactivated_at = now() where id = member_id;
  update public.users set is_active = true, deactivated_at = null where id = member_id;

  insert into public.messages (user_id, text) values (member_id, 'History');
  perform pg_temp.expect_error('accounts: a user with messages cannot be hard-deleted',
    format('delete from public.users where id = %L', member_id), '23503');

  -- Deleting the Auth account (e.g. from the dashboard) keeps the profile and
  -- unlinks it, so the person can sign in again later and be re-linked by email.
  -- Uses a profile with no messages, so nothing else would block a cascade.
  unlinked_auth_id := pg_temp.new_auth_user('unlink');
  insert into public.users (name, email, auth_user_id)
  values ('T002 Unlink', 't002-unlink@example.test', unlinked_auth_id) returning id into unlinked_id;
  delete from auth.users where id = unlinked_auth_id;
  select auth_user_id into linked from public.users where id = unlinked_id;
  assert found, '[accounts] deleting the auth user must keep the profile';
  assert linked is null, '[accounts] deleting the auth user must unlink the profile';

  perform pg_temp.expect_error('accounts: invitation_id must be a real invitation',
    format('update public.users set invitation_id = %L where id = %L', gen_random_uuid(), member_id), '23503');
end
$$;

-- -----------------------------------------------------------------------------
-- [invitations] Shape rules for email and link invitations.
-- -----------------------------------------------------------------------------
do $$
declare
  first_token text;
  second_token text;
begin
  insert into public.invitations (type) values ('link') returning token into first_token;
  insert into public.invitations (type) values ('link') returning token into second_token;
  assert first_token ~ '^[0-9a-f]{64}$', format('[invitations] default token must be 64 lowercase hex chars, got %s', first_token);
  assert first_token <> second_token, '[invitations] default tokens are unique';

  insert into public.invitations (type, email) values ('email', 't002-invitee@example.test');
  insert into public.invitations (type, max_uses) values ('link', 10);

  perform pg_temp.expect_error('invitations: email invitation without an email',
    $q$insert into public.invitations (type) values ('email')$q$, '23514');
  perform pg_temp.expect_error('invitations: malformed email',
    $q$insert into public.invitations (type, email) values ('email', 'nope')$q$, '23514');
  perform pg_temp.expect_error('invitations: email invitations are single-use',
    $q$insert into public.invitations (type, email, max_uses) values ('email', 't002-x@example.test', 2)$q$, '23514');
  perform pg_temp.expect_error('invitations: duplicate token',
    format('insert into public.invitations (type, token) values (%L, %L)', 'link', first_token), '23505');
  perform pg_temp.expect_error('invitations: malformed token',
    $q$insert into public.invitations (type, token) values ('link', 'short')$q$, '23514');
  perform pg_temp.expect_error('invitations: zero max_uses',
    $q$insert into public.invitations (type, max_uses) values ('link', 0)$q$, '23514');
  perform pg_temp.expect_error('invitations: use_count above max_uses',
    $q$insert into public.invitations (type, max_uses, use_count) values ('link', 2, 3)$q$, '23514');
  perform pg_temp.expect_error('invitations: negative use_count',
    $q$insert into public.invitations (type, use_count) values ('link', -1)$q$, '23514');
  perform pg_temp.expect_error('invitations: accepted without accepted_at',
    $q$insert into public.invitations (type, status, use_count) values ('link', 'accepted', 1)$q$, '23514');
  perform pg_temp.expect_error('invitations: revoked without revoked_at',
    $q$insert into public.invitations (type, status) values ('link', 'revoked')$q$, '23514');
  perform pg_temp.expect_error('invitations: revoked_at on a pending invitation',
    $q$insert into public.invitations (type, revoked_at) values ('link', now())$q$, '23514');

  -- An accepted invitation can later be revoked (removing a user frees it, A4).
  insert into public.invitations (type, status, use_count, accepted_at, revoked_at)
  values ('link', 'revoked', 1, now(), now());
end
$$;

rollback;
