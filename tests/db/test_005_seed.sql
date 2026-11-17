-- =============================================================================
-- tests/db/test_005_seed.sql: ISSUE-005 tests for the seed data
-- (db/seed/001_admin.sql and db/seed/002_test_data_2025.sql).
--
-- HOW TO RUN (dev project only, never prod):
--   1. Apply db/seed/001_admin.sql, then db/seed/002_test_data_2025.sql.
--   2. Apply both again, in the same order. The second run must change nothing.
--   3. Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--        PASS: "Success. No rows returned".
--        FAIL: an error whose message starts with the [label] of the failed check.
--   Or locally, against a throwaway Postgres: tests/db/run_local.sh. It applies
--   the seeds twice before running the tests.
--
-- WHAT IT CHECKS
--   That the database holds the 2025 test data from SEED_DATA_2025.md, each
--   row exactly once. The expected data is written out again below,
--   independently of the seed script, so a typo in either one fails here.
--   Exact counts after the seeds have been applied twice are what prove that
--   re-running them creates no duplicates.
--
-- WHICH ROWS IT LOOKS AT
--   Only the 21 seeded people (matched by email) and what they own. Profiles
--   created later by signing in to dev don't affect it. But it checks the
--   seeded rows exactly, so it fails once dev has been used *as* a seeded
--   person: say, Wiley changing their RSVP or liking a message. That's
--   expected. Run it right after seeding. The seeds never overwrite existing
--   rows, so re-seeding won't undo hand changes.
--
-- SAFE TO RE-RUN: it only reads. Everything happens in one transaction that is
-- rolled back at the end.
--
-- Run as the SQL Editor's default `postgres` role, which owns the tables, so
-- RLS doesn't hide any rows.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Expected data, copied from documentation/SEED_DATA_2025.md. These helpers
-- live in pg_temp, so they vanish with the rollback.
-- -----------------------------------------------------------------------------

-- Everyone in the "Users & Country Claims" table. `registered` is the date
-- only; the time of day is the seed's choice.
create function pg_temp.expected_users()
returns table (name text, email text, role text, country text, rsvp text, registered date)
language sql
immutable
as $$
  values
    ('Wiley Page',        'gwpage@gmail.com',               'admin', 'Monopoly',          'attending',     date '2025-01-15'),
    ('Marcus Chen',       'marcus.chen@fakemail.com',       'user',  'Catan',             'attending',     date '2025-01-15'),
    ('Priya Sharma',      'priya.sharma@fakemail.com',      'user',  'Ticket to Ride',    'attending',     date '2025-01-16'),
    ('Jordan McAllister', 'jordan.mcallister@fakemail.com', 'user',  'Wingspan',          'attending',     date '2025-01-18'),
    ('Tessa Björk',       'tessa.bjork@fakemail.com',       'user',  'Azul',              'attending',     date '2025-01-19'),
    ('Dave Kowalski',     'dave.kowalski@fakemail.com',     'user',  'Pandemic',          'attending',     date '2025-01-21'),
    ('Lina Ferreira',     'lina.ferreira@fakemail.com',     'user',  'Scythe',            'attending',     date '2025-01-22'),
    ('Sam Okafor',        'sam.okafor@fakemail.com',        'user',  'Codenames',         'attending',     date '2025-01-24'),
    ('Rachel Kim',        'rachel.kim@fakemail.com',        'user',  'Terraforming Mars', 'attending',     date '2025-01-25'),
    ('Eli Brandt',        'eli.brandt@fakemail.com',        'user',  'Dominion',          'not_attending', date '2025-01-27'),
    ('Noor Al-Rashid',    'noor.alrashid@fakemail.com',     'user',  'Carcassonne',       'attending',     date '2025-01-28'),
    ('Casey Tremblay',    'casey.tremblay@fakemail.com',    'user',  'Spirit Island',     'attending',     date '2025-01-30'),
    ('Anika Patel',       'anika.patel@fakemail.com',       'user',  'Splendor',          'attending',     date '2025-02-01'),
    ('Owen Gallagher',    'owen.gallagher@fakemail.com',    'user',  'Root',              'attending',     date '2025-02-02'),
    ('Mei-Ling Wu',       'meiling.wu@fakemail.com',        'user',  'Everdell',          'attending',     date '2025-02-04'),
    ('Tobias Engström',   'tobias.engstrom@fakemail.com',   'user',  'Gloomhaven',        'attending',     date '2025-02-05'),
    ('Harper Reeves',     'harper.reeves@fakemail.com',     'user',  '7 Wonders',         'not_attending', date '2025-02-07'),
    ('Diego Morales',     'diego.morales@fakemail.com',     'user',  'Chess',             'attending',     date '2025-02-08'),
    ('Freya Nakamura',    'freya.nakamura@fakemail.com',    'user',  'Betrayal at House on the Hill', 'attending', date '2025-02-10'),
    ('Callum O''Brien',   'callum.obrien@fakemail.com',     'user',  'King of Tokyo',     'no_response',   date '2025-02-12'),
    ('Zara Petrov',       'zara.petrov@fakemail.com',       'user',  'Clue',              'attending',     date '2025-02-14')
$$;

-- The "Messages" table, numbered so expected_likes() can refer to them, with
-- the number of likes each one gets in the "Message Likes" table.
create function pg_temp.expected_messages()
returns table (n integer, author text, body text, posted date, like_count integer)
language sql
immutable
as $$
  values
    ( 1, 'Marcus Chen',       'First one here! Let''s gooo',                                     date '2025-01-15', 5),
    ( 2, 'Priya Sharma',      'Ticket to Ride is going to crush it this year',                  date '2025-01-17', 2),
    ( 3, 'Jordan McAllister', 'Wingspan gang rise up',                                          date '2025-01-18', 0),
    ( 4, 'Dave Kowalski',     'Pandemic feels oddly appropriate for the times',                 date '2025-01-21', 6),
    ( 5, 'Tessa Björk',       'Does anyone know if there''s parking nearby?',                    date '2025-01-22', 0),
    ( 6, 'Sam Okafor',        'Can''t wait to see everyone!',                                    date '2025-01-25', 7),
    ( 7, 'Lina Ferreira',     'Scythe will conquer all',                                        date '2025-01-26', 2),
    ( 8, 'Rachel Kim',        'Terraforming Mars — because why settle for one planet?',         date '2025-01-28', 3),
    ( 9, 'Marcus Chen',       'Who else is bringing snacks?',                                   date '2025-01-30', 4),
    (10, 'Noor Al-Rashid',    'Carcassonne forever',                                            date '2025-01-30', 0),
    (11, 'Casey Tremblay',    'Spirit Island is the best co-op game ever made, fight me',       date '2025-02-01', 4),
    (12, 'Owen Gallagher',    'Root is basically a war crime simulator and I''m here for it',    date '2025-02-03', 7),
    (13, 'Anika Patel',       'So excited for this! My third year in a row',                    date '2025-02-04', 0),
    (14, 'Tobias Engström',   'Gloomhaven crew — who wants to form a party?',                   date '2025-02-06', 0),
    (15, 'Harper Reeves',     '7 Wonders, 7 victories',                                         date '2025-02-08', 0),
    (16, 'Diego Morales',     'Chess is the OG board game. Respect the classics',               date '2025-02-09', 2),
    (17, 'Freya Nakamura',    'Betrayal at House on the Hill because I like chaos',             date '2025-02-11', 0),
    (18, 'Zara Petrov',       'Last minute signup! Wouldn''t miss it though',                    date '2025-02-14', 0),
    (19, 'Callum O''Brien',   'Anyone want to carpool from downtown?',                          date '2025-02-13', 2),
    (20, 'Mei-Ling Wu',       'Everdell is so pretty. That''s my whole argument',                date '2025-02-05', 5)
$$;

-- The "Message Likes" table, one row per like: (message number, liked by).
create function pg_temp.expected_likes()
returns table (n integer, liker text)
language sql
immutable
as $$
  values
    ( 1, 'Priya Sharma'), ( 1, 'Jordan McAllister'), ( 1, 'Wiley Page'), ( 1, 'Sam Okafor'), ( 1, 'Anika Patel'),
    ( 2, 'Marcus Chen'), ( 2, 'Tessa Björk'),
    ( 4, 'Lina Ferreira'), ( 4, 'Rachel Kim'), ( 4, 'Noor Al-Rashid'), ( 4, 'Casey Tremblay'), ( 4, 'Owen Gallagher'),
    ( 4, 'Diego Morales'),
    ( 6, 'Marcus Chen'), ( 6, 'Priya Sharma'), ( 6, 'Wiley Page'), ( 6, 'Anika Patel'), ( 6, 'Zara Petrov'),
    ( 6, 'Freya Nakamura'), ( 6, 'Tessa Björk'),
    ( 7, 'Dave Kowalski'), ( 7, 'Tobias Engström'),
    ( 8, 'Marcus Chen'), ( 8, 'Lina Ferreira'), ( 8, 'Mei-Ling Wu'),
    (11, 'Owen Gallagher'), (11, 'Tobias Engström'), (11, 'Wiley Page'), (11, 'Dave Kowalski'),
    (12, 'Casey Tremblay'), (12, 'Freya Nakamura'), (12, 'Callum O''Brien'), (12, 'Wiley Page'), (12, 'Marcus Chen'),
    (12, 'Lina Ferreira'), (12, 'Sam Okafor'),
    (20, 'Anika Patel'), (20, 'Harper Reeves'), (20, 'Priya Sharma'), (20, 'Tessa Björk'), (20, 'Freya Nakamura'),
    (16, 'Wiley Page'), (16, 'Noor Al-Rashid'),
    ( 9, 'Priya Sharma'), ( 9, 'Sam Okafor'), ( 9, 'Anika Patel'), ( 9, 'Zara Petrov'),
    (19, 'Freya Nakamura'), (19, 'Zara Petrov')
$$;

-- The profile id of a seeded person, by name. Names are unique in the seed
-- data, but a profile's name can be edited, so this goes through the email.
create function pg_temp.seeded_id(p_name text)
returns uuid
language sql
stable
as $$
  select u.id
  from pg_temp.expected_users() e
  join public.users u on lower(u.email) = lower(e.email)
  where e.name = p_name
$$;

-- Every seeded person's profile id.
create function pg_temp.seeded_ids()
returns setof uuid
language sql
stable
as $$
  select u.id
  from pg_temp.expected_users() e
  join public.users u on lower(u.email) = lower(e.email)
$$;

-- The seeded message by this author with exactly this text.
create function pg_temp.seeded_message_ids(p_author text, p_body text)
returns setof uuid
language sql
stable
as $$
  select m.id from public.messages m where m.user_id = pg_temp.seeded_id(p_author) and m.text = p_body
$$;

-- True if the timestamp falls between these calendar dates (inclusive) in UTC
-- and in every mainland US time zone, so the site shows a documented date
-- whoever views it.
create function pg_temp.falls_between(p_at timestamptz, p_first date, p_last date)
returns boolean
language sql
stable
as $$
  select bool_and((p_at at time zone tz)::date between p_first and p_last)
  from unnest(array['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York']) tz
$$;

-- The same, for a single date.
create function pg_temp.falls_on(p_at timestamptz, p_date date)
returns boolean
language sql
stable
as $$
  select pg_temp.falls_between(p_at, p_date, p_date)
$$;

-- -----------------------------------------------------------------------------
-- [expected] The expected data above matches the totals in SEED_DATA_2025.md
-- and ISSUE-005, so a typo in this file can't make a broken seed look right.
-- -----------------------------------------------------------------------------
do $$
declare
  dangling text;
begin
  assert (select count(*) from pg_temp.expected_users()) = 21, '[expected] 21 users';
  assert (select count(distinct lower(email)) from pg_temp.expected_users()) = 21, '[expected] 21 distinct emails';
  assert (select count(distinct name) from pg_temp.expected_users()) = 21, '[expected] 21 distinct names';
  assert (select count(*) from pg_temp.expected_messages()) = 20, '[expected] 20 messages';
  assert (select count(*) from pg_temp.expected_likes()) = 49, '[expected] 49 likes';
  assert (select count(*) from (select distinct n, liker from pg_temp.expected_likes()) pairs) = 49,
    '[expected] no like is listed twice';
  assert (select sum(like_count) from pg_temp.expected_messages()) = 49, '[expected] per-message like counts sum to 49';
  assert not exists (
    select 1
    from pg_temp.expected_messages() m
    where m.like_count <> (select count(*) from pg_temp.expected_likes() l where l.n = m.n)
  ), '[expected] each message''s like count matches its listed likes';

  select coalesce(min(x.name), '') into dangling
  from (
    select author as name from pg_temp.expected_messages()
    union select liker from pg_temp.expected_likes()
  ) x
  where x.name not in (select name from pg_temp.expected_users());
  assert dangling = '', format('[expected] %s appears in messages or likes but not in users', dangling);
end
$$;

-- -----------------------------------------------------------------------------
-- [settings] The 2025 event settings exist, and 2025 is the current year.
-- -----------------------------------------------------------------------------
do $$
declare
  settings public.event_settings;
begin
  select * into settings from public.event_settings s where s.year = 2025;
  assert found, '[settings] there is a 2025 event_settings row';
  assert settings.event_date = date '2025-02-15',
    format('[settings] event date is 2025-02-15, got %s', settings.event_date);
  assert settings.theme_title = 'Board Games',
    format('[settings] theme title is "Board Games", got "%s"', settings.theme_title);
  assert settings.theme_desc = 'This year, your country IS a board game. Pick your favorite tabletop classic and '
                               'represent it with pride. May the best game win!',
    format('[settings] theme description matches SEED_DATA_2025.md, got "%s"', settings.theme_desc);
  -- The test data is this year's data, not an archive, so the board, feed and
  -- sidebar show it.
  assert public.current_event_year() = 2025,
    format('[settings] 2025 is the current event year, got %s', public.current_event_year());
end
$$;

-- -----------------------------------------------------------------------------
-- [admin] Exactly one seeded person is an admin: Wiley Page, gwpage@gmail.com.
-- -----------------------------------------------------------------------------
do $$
declare
  admin public.users;
  admin_count integer;
begin
  select count(*) into admin_count from public.users u where u.id in (select pg_temp.seeded_ids()) and u.role = 'admin';
  assert admin_count = 1, format('[admin] exactly one seeded admin, got %s', admin_count);

  select * into admin from public.users u where lower(u.email) = 'gwpage@gmail.com';
  assert found, '[admin] a profile for gwpage@gmail.com exists';
  assert admin.role = 'admin', format('[admin] gwpage@gmail.com is an admin, got role %s', admin.role);
  assert admin.name = 'Wiley Page', format('[admin] the admin is named Wiley Page, got %s', admin.name);
  assert admin.is_active, '[admin] the admin is active';
  assert admin.invitation_id is null, '[admin] the admin joined without an invitation';
  -- Seeded unlinked (ADR-007). Once Wiley signs in to dev, the profile is
  -- linked to that Auth account, which must have the same email.
  assert admin.auth_user_id is null
      or exists (select 1 from auth.users a where a.id = admin.auth_user_id and lower(a.email) = lower(admin.email)),
    '[admin] the admin is unlinked, or linked to the Auth account with the same email';
end
$$;

-- -----------------------------------------------------------------------------
-- [users] Each seeded person exists once, as documented.
-- -----------------------------------------------------------------------------
do $$
declare
  expected record;
  profile public.users;
  matches integer;
begin
  for expected in select * from pg_temp.expected_users() loop
    select count(*) into matches from public.users u where lower(u.email) = lower(expected.email);
    assert matches = 1, format('[users] %s: expected exactly 1 profile, got %s', expected.email, matches);

    select * into profile from public.users u where lower(u.email) = lower(expected.email);
    assert profile.name = expected.name,
      format('[users] %s: expected name %s, got %s', expected.email, expected.name, profile.name);
    assert profile.role = expected.role,
      format('[users] %s: expected role %s, got %s', expected.email, expected.role, profile.role);
    assert profile.country is not distinct from expected.country,
      format('[users] %s: expected country %s, got %s', expected.email, expected.country, profile.country);
    assert profile.rsvp = expected.rsvp,
      format('[users] %s: expected RSVP %s, got %s', expected.email, expected.rsvp, profile.rsvp);
    assert pg_temp.falls_on(profile.created_at, expected.registered),
      format('[users] %s: expected to have registered on %s, got %s', expected.email, expected.registered,
             profile.created_at);
    assert profile.is_active and profile.deactivated_at is null,
      format('[users] %s: expected to be active', expected.email);

    -- Fake people: no Auth account (they can't sign in), no invitation, no flag.
    if expected.role = 'user' then
      assert profile.auth_user_id is null, format('[users] %s: expected no Auth account', expected.email);
      assert profile.invitation_id is null, format('[users] %s: expected no invitation', expected.email);
      assert profile.flag_url is null, format('[users] %s: expected no flag', expected.email);
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- [rsvp] 18 attending, 2 not attending, 1 no response.
-- -----------------------------------------------------------------------------
do $$
declare
  counts jsonb;
begin
  select jsonb_object_agg(rsvp, n) into counts
  from (
    select u.rsvp, count(*) as n
    from public.users u
    where u.id in (select pg_temp.seeded_ids())
    group by u.rsvp
  ) by_rsvp;
  assert counts = '{"attending": 18, "not_attending": 2, "no_response": 1}'::jsonb,
    format('[rsvp] expected 18 attending, 2 not_attending, 1 no_response; got %s', counts);
end
$$;

-- -----------------------------------------------------------------------------
-- [messages] 20 messages, each once, on its documented date, in 2025, and no
-- earlier than its author registered.
-- -----------------------------------------------------------------------------
do $$
declare
  expected record;
  message public.messages;
  author public.users;
  matches integer;
  total integer;
begin
  select count(*) into total from public.messages m where m.user_id in (select pg_temp.seeded_ids());
  assert total = 20, format('[messages] the seeded people have 20 messages, got %s', total);

  for expected in select * from pg_temp.expected_messages() loop
    select count(*) into matches from pg_temp.seeded_message_ids(expected.author, expected.body);
    assert matches = 1,
      format('[messages] %s "%s": expected exactly 1, got %s', expected.author, expected.body, matches);

    select * into message from public.messages m where m.id in (select pg_temp.seeded_message_ids(expected.author, expected.body));
    select * into author from public.users u where u.id = message.user_id;
    assert message.event_year = 2025,
      format('[messages] %s "%s": expected event_year 2025, got %s', expected.author, expected.body, message.event_year);
    assert pg_temp.falls_on(message.created_at, expected.posted),
      format('[messages] %s "%s": expected to be posted on %s, got %s', expected.author, expected.body,
             expected.posted, message.created_at);
    assert message.created_at >= author.created_at,
      format('[messages] %s "%s": posted at %s, before its author registered at %s', expected.author, expected.body,
             message.created_at, author.created_at);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- [likes] 49 likes in all, every documented one present, the right number on
-- each message, and none before the message or before the liker registered.
-- -----------------------------------------------------------------------------
do $$
declare
  expected record;
  actual integer;
  total integer;
  bad record;
begin
  select count(*) into total
  from public.message_likes l
  join public.messages m on m.id = l.message_id
  where m.user_id in (select pg_temp.seeded_ids());
  assert total = 49, format('[likes] the seeded messages have 49 likes, got %s', total);

  -- Includes the spot checks from ISSUE-005: 7 on Owen's "Root…", 7 on Sam's
  -- "Can't wait…" and 6 on Dave's "Pandemic…".
  for expected in select * from pg_temp.expected_messages() loop
    select count(*) into actual
    from public.message_likes l
    where l.message_id in (select pg_temp.seeded_message_ids(expected.author, expected.body));
    assert actual = expected.like_count,
      format('[likes] %s "%s": expected %s likes, got %s', expected.author, expected.body, expected.like_count, actual);
  end loop;

  for expected in
    select m.author, m.body, l.liker
    from pg_temp.expected_likes() l
    join pg_temp.expected_messages() m on m.n = l.n
  loop
    assert exists (
      select 1
      from public.message_likes l
      where l.message_id in (select pg_temp.seeded_message_ids(expected.author, expected.body))
        and l.user_id = pg_temp.seeded_id(expected.liker)
    ), format('[likes] %s should like %s''s "%s"', expected.liker, expected.author, expected.body);
  end loop;

  select l.created_at, m.text, m.created_at as posted_at, liker.name, liker.created_at as registered_at
  into bad
  from public.message_likes l
  join public.messages m on m.id = l.message_id
  join public.users liker on liker.id = l.user_id
  where m.user_id in (select pg_temp.seeded_ids())
    and (l.created_at < m.created_at or l.created_at < liker.created_at)
  limit 1;
  assert bad is null,
    format('[likes] %s liked "%s" at %s, before it was posted (%s) or before they registered (%s)',
           bad.name, bad.text, bad.created_at, bad.posted_at, bad.registered_at);

  -- All the 2025 activity happened during sign-ups, 15 January to 14 February.
  select l.created_at, m.text, liker.name into bad
  from public.message_likes l
  join public.messages m on m.id = l.message_id
  join public.users liker on liker.id = l.user_id
  where m.user_id in (select pg_temp.seeded_ids())
    and not pg_temp.falls_between(l.created_at, date '2025-01-15', date '2025-02-14')
  limit 1;
  assert bad is null,
    format('[likes] %s liked "%s" at %s, outside 15 January to 14 February 2025', bad.name, bad.text, bad.created_at);
end
$$;

-- -----------------------------------------------------------------------------
-- [claims] One 2025 claim per seeded person, for their country, dated when
-- they registered.
-- -----------------------------------------------------------------------------
do $$
declare
  expected record;
  profile public.users;
  claim public.country_claims;
  matches integer;
  total integer;
begin
  select count(*) into total from public.country_claims c where c.user_id in (select pg_temp.seeded_ids());
  assert total = 21, format('[claims] the seeded people have 21 country claims, got %s', total);

  for expected in select * from pg_temp.expected_users() loop
    select * into profile from public.users u where lower(u.email) = lower(expected.email);
    select count(*) into matches from public.country_claims c where c.user_id = profile.id;
    assert matches = 1, format('[claims] %s: expected exactly 1 claim, got %s', expected.name, matches);

    select * into claim from public.country_claims c where c.user_id = profile.id;
    assert claim.country = expected.country,
      format('[claims] %s: expected a claim for %s, got %s', expected.name, expected.country, claim.country);
    assert claim.claimed_at = profile.created_at,
      format('[claims] %s: expected the claim to be dated at registration (%s), got %s', expected.name,
             profile.created_at, claim.claimed_at);
    assert claim.event_year = 2025,
      format('[claims] %s: expected event_year 2025, got %s', expected.name, claim.event_year);
  end loop;
end
$$;

rollback;
