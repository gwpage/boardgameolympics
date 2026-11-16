-- #############################################################################
-- ##                                                                         ##
-- ##   DEV ONLY.  NEVER RUN THIS AGAINST PRODUCTION.                         ##
-- ##                                                                         ##
-- ##   It adds 20 fake people, with messages and likes. Members persist      ##
-- ##   from year to year, so in prod they would show up to real members.    ##
-- ##                                                                         ##
-- #############################################################################
--
-- db/seed/002_test_data_2025.sql: the 2025 test event (ISSUE-005; SPEC.md
-- § Test Data (2025 Event); documentation/SEED_DATA_2025.md).
--
-- HOW TO APPLY (dev project only)
--   After all of db/migrations/ and db/seed/001_admin.sql:
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--   It runs in one transaction, so it applies completely or not at all.
--   Re-running it is harmless. Check the result with tests/db/test_005_seed.sql.
--
-- WHAT IT LOADS (all as SEED_DATA_2025.md lists it)
--   * The 2025 event settings: 15 February 2025, theme "Board Games". With no
--     later event, 2025 is the current year, so the board, feed and sidebar
--     show this data. It is deliberately not archived.
--   * 21 people: the admin plus 20 fake people, with their countries and RSVPs.
--     The fake people have no Auth account, so nobody can sign in as them.
--   * One country claim per person, dated when they registered.
--   * 20 messages and 49 likes.
--
-- TIMES OF DAY
--   SEED_DATA_2025.md gives dates only. People register at 12:00 UTC and post
--   at 18:00 UTC, so every date shows correctly in all US time zones (the
--   earliest, Pacific, is 04:00 and 10:00 the same day). The two posts on 30
--   January are an hour apart, so they always list in the same order. A like
--   comes an hour after the later of the post and the liker registering.
--
-- RE-RUNNING
--   Nothing existing is ever changed or deleted. Each step adds only what's
--   missing:
--   * a person is matched by email, ignoring case;
--   * a message is matched by author, text and time;
--   * the event settings are matched by year;
--   * a like is matched by message and liker.
--   So anything changed by hand on dev stays changed (ADR-019).
--
-- IT REFUSES TO RUN (and changes nothing) IF
--   * 001_admin.sql hasn't been applied. The admin is one of the 21 and likes
--     several messages.
--   * the database already has an event after 2025. The test data only makes
--     sense while 2025 is the current year. This also stops it from running
--     in prod once a real event has been set up. It cannot protect a brand-new
--     prod database, so the banner above is the main safeguard.
--
-- HOW THE HISTORICAL CLAIM DATES WORK (ADR-011)
--   Claims are written only by the users_record_country_claim trigger, which
--   stamps them with now(). So each person is saved *with* their country, the
--   trigger writes the claim, and the claim's date is then set back to the
--   registration date. Nothing else in this transaction writes claims, so
--   "claimed_at = now()" picks out exactly the claims this run just created.
--   now() is the transaction's start time and is the same in every statement.
--   This runs as the tables' owner (the SQL Editor's postgres role), so RLS
--   doesn't apply.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- The data. Kept in pg_temp functions so it's written once and read by several
-- statements. They're dropped at the end, and on failure the rollback removes
-- them.
-- -----------------------------------------------------------------------------

-- "Users & Country Claims". The admin's row fills in their 2025 profile (see
-- step 3). Their role is set by 001_admin.sql, not here.
create or replace function pg_temp.seed_users()
returns table (name text, email text, country text, rsvp text, registered_at timestamptz)
language sql
immutable
as $$
  values
    ('Wiley Page',        'gwpage@gmail.com',               'Monopoly',          'attending',     timestamptz '2025-01-15 12:00+00'),
    ('Marcus Chen',       'marcus.chen@fakemail.com',       'Catan',             'attending',     '2025-01-15 12:00+00'),
    ('Priya Sharma',      'priya.sharma@fakemail.com',      'Ticket to Ride',    'attending',     '2025-01-16 12:00+00'),
    ('Jordan McAllister', 'jordan.mcallister@fakemail.com', 'Wingspan',          'attending',     '2025-01-18 12:00+00'),
    ('Tessa Björk',       'tessa.bjork@fakemail.com',       'Azul',              'attending',     '2025-01-19 12:00+00'),
    ('Dave Kowalski',     'dave.kowalski@fakemail.com',     'Pandemic',          'attending',     '2025-01-21 12:00+00'),
    ('Lina Ferreira',     'lina.ferreira@fakemail.com',     'Scythe',            'attending',     '2025-01-22 12:00+00'),
    ('Sam Okafor',        'sam.okafor@fakemail.com',        'Codenames',         'attending',     '2025-01-24 12:00+00'),
    ('Rachel Kim',        'rachel.kim@fakemail.com',        'Terraforming Mars', 'attending',     '2025-01-25 12:00+00'),
    ('Eli Brandt',        'eli.brandt@fakemail.com',        'Dominion',          'not_attending', '2025-01-27 12:00+00'),
    ('Noor Al-Rashid',    'noor.alrashid@fakemail.com',     'Carcassonne',       'attending',     '2025-01-28 12:00+00'),
    ('Casey Tremblay',    'casey.tremblay@fakemail.com',    'Spirit Island',     'attending',     '2025-01-30 12:00+00'),
    ('Anika Patel',       'anika.patel@fakemail.com',       'Splendor',          'attending',     '2025-02-01 12:00+00'),
    ('Owen Gallagher',    'owen.gallagher@fakemail.com',    'Root',              'attending',     '2025-02-02 12:00+00'),
    ('Mei-Ling Wu',       'meiling.wu@fakemail.com',        'Everdell',          'attending',     '2025-02-04 12:00+00'),
    ('Tobias Engström',   'tobias.engstrom@fakemail.com',   'Gloomhaven',        'attending',     '2025-02-05 12:00+00'),
    ('Harper Reeves',     'harper.reeves@fakemail.com',     '7 Wonders',         'not_attending', '2025-02-07 12:00+00'),
    ('Diego Morales',     'diego.morales@fakemail.com',     'Chess',             'attending',     '2025-02-08 12:00+00'),
    ('Freya Nakamura',    'freya.nakamura@fakemail.com',    'Betrayal at House on the Hill', 'attending', '2025-02-10 12:00+00'),
    ('Callum O''Brien',   'callum.obrien@fakemail.com',     'King of Tokyo',     'no_response',   '2025-02-12 12:00+00'),
    ('Zara Petrov',       'zara.petrov@fakemail.com',       'Clue',              'attending',     '2025-02-14 12:00+00')
$$;

-- "Messages", each with its likes from "Message Likes". People are named as in
-- seed_users() above.
create or replace function pg_temp.seed_messages()
returns table (author text, body text, posted_at timestamptz, liked_by text[])
language sql
immutable
as $$
  values
    ('Marcus Chen', 'First one here! Let''s gooo', timestamptz '2025-01-15 18:00+00',
      array['Priya Sharma', 'Jordan McAllister', 'Wiley Page', 'Sam Okafor', 'Anika Patel']),
    ('Priya Sharma', 'Ticket to Ride is going to crush it this year', '2025-01-17 18:00+00',
      array['Marcus Chen', 'Tessa Björk']),
    ('Jordan McAllister', 'Wingspan gang rise up', '2025-01-18 18:00+00',
      array[]::text[]),
    ('Dave Kowalski', 'Pandemic feels oddly appropriate for the times', '2025-01-21 18:00+00',
      array['Lina Ferreira', 'Rachel Kim', 'Noor Al-Rashid', 'Casey Tremblay', 'Owen Gallagher', 'Diego Morales']),
    ('Tessa Björk', 'Does anyone know if there''s parking nearby?', '2025-01-22 18:00+00',
      array[]::text[]),
    ('Sam Okafor', 'Can''t wait to see everyone!', '2025-01-25 18:00+00',
      array['Marcus Chen', 'Priya Sharma', 'Wiley Page', 'Anika Patel', 'Zara Petrov', 'Freya Nakamura', 'Tessa Björk']),
    ('Lina Ferreira', 'Scythe will conquer all', '2025-01-26 18:00+00',
      array['Dave Kowalski', 'Tobias Engström']),
    ('Rachel Kim', 'Terraforming Mars — because why settle for one planet?', '2025-01-28 18:00+00',
      array['Marcus Chen', 'Lina Ferreira', 'Mei-Ling Wu']),
    ('Marcus Chen', 'Who else is bringing snacks?', '2025-01-30 18:00+00',
      array['Priya Sharma', 'Sam Okafor', 'Anika Patel', 'Zara Petrov']),
    ('Noor Al-Rashid', 'Carcassonne forever', '2025-01-30 19:00+00',
      array[]::text[]),
    ('Casey Tremblay', 'Spirit Island is the best co-op game ever made, fight me', '2025-02-01 18:00+00',
      array['Owen Gallagher', 'Tobias Engström', 'Wiley Page', 'Dave Kowalski']),
    ('Owen Gallagher', 'Root is basically a war crime simulator and I''m here for it', '2025-02-03 18:00+00',
      array['Casey Tremblay', 'Freya Nakamura', 'Callum O''Brien', 'Wiley Page', 'Marcus Chen', 'Lina Ferreira',
            'Sam Okafor']),
    ('Anika Patel', 'So excited for this! My third year in a row', '2025-02-04 18:00+00',
      array[]::text[]),
    ('Mei-Ling Wu', 'Everdell is so pretty. That''s my whole argument', '2025-02-05 18:00+00',
      array['Anika Patel', 'Harper Reeves', 'Priya Sharma', 'Tessa Björk', 'Freya Nakamura']),
    ('Tobias Engström', 'Gloomhaven crew — who wants to form a party?', '2025-02-06 18:00+00',
      array[]::text[]),
    ('Harper Reeves', '7 Wonders, 7 victories', '2025-02-08 18:00+00',
      array[]::text[]),
    ('Diego Morales', 'Chess is the OG board game. Respect the classics', '2025-02-09 18:00+00',
      array['Wiley Page', 'Noor Al-Rashid']),
    ('Freya Nakamura', 'Betrayal at House on the Hill because I like chaos', '2025-02-11 18:00+00',
      array[]::text[]),
    ('Callum O''Brien', 'Anyone want to carpool from downtown?', '2025-02-13 18:00+00',
      array['Freya Nakamura', 'Zara Petrov']),
    ('Zara Petrov', 'Last minute signup! Wouldn''t miss it though', '2025-02-14 18:00+00',
      array[]::text[])
$$;

-- A seeded person's profile id, by their name in seed_users(). It matches on
-- email, because a profile's name can be edited after seeding.
create or replace function pg_temp.seed_profile_id(p_name text)
returns uuid
language sql
stable
as $$
  select u.id
  from pg_temp.seed_users() s
  join public.users u on lower(u.email) = lower(s.email)
  where s.name = p_name
$$;

-- -----------------------------------------------------------------------------
-- Preconditions. Any failure here aborts the whole transaction.
-- -----------------------------------------------------------------------------
do $$
declare
  later_year integer;
  unknown_name text;
begin
  if not exists (select 1 from public.users u where lower(u.email) = 'gwpage@gmail.com') then
    raise exception 'Apply db/seed/001_admin.sql first. The admin, gwpage@gmail.com, is part of the 2025 test data.';
  end if;

  select min(s.year) into later_year from public.event_settings s where s.year > 2025;
  if later_year is not null then
    raise exception 'Refusing to load the 2025 test data: this database already has a % event.', later_year
      using hint = 'This script is for the dev project only, and only while 2025 is the newest event. '
                   'If this is prod, stop: the test data must never go there.';
  end if;

  -- A misspelt name would silently drop a message or a like, so check every
  -- name against the people list first.
  select min(x.name) into unknown_name
  from (
    select m.author as name from pg_temp.seed_messages() m
    union
    select unnest(m.liked_by) from pg_temp.seed_messages() m
  ) x
  where x.name not in (select s.name from pg_temp.seed_users() s);
  if unknown_name is not null then
    raise exception 'Seed data error: "%" is used in seed_messages() but isn''t in seed_users().', unknown_name;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Event settings. They go first, so 2025 is the current year by the time
--    the claim trigger stamps each claim's event_year.
-- -----------------------------------------------------------------------------
insert into public.event_settings (year, event_date, theme_title, theme_desc)
values (
  2025,
  '2025-02-15',
  'Board Games',
  'This year, your country IS a board game. Pick your favorite tabletop classic and represent it with pride. '
  'May the best game win!'
)
on conflict (year) do nothing;

-- -----------------------------------------------------------------------------
-- 2. People who don't exist yet. The admin already does (001_admin.sql), so
--    this adds the 20 fake people on the first run and nobody after that.
--    The trigger writes each new person's claim, dated now(); step 4 fixes it.
-- -----------------------------------------------------------------------------
insert into public.users (name, email, country, rsvp, created_at)
select s.name, s.email, s.country, s.rsvp, s.registered_at
from pg_temp.seed_users() s
on conflict ((lower(email))) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Seeded people who have never claimed a country get their 2025 profile:
--    country, RSVP and registration date. In practice that's the admin, whose
--    profile 001_admin.sql created bare, on the first run. After that, every
--    seeded person has a claim, so a re-run changes nobody.
-- -----------------------------------------------------------------------------
update public.users u
set country = s.country,
    rsvp = s.rsvp,
    created_at = s.registered_at
from pg_temp.seed_users() s
where lower(u.email) = lower(s.email)
  and not exists (select 1 from public.country_claims c where c.user_id = u.id);

-- -----------------------------------------------------------------------------
-- 4. Date this run's claims at the person's registration (see the header).
-- -----------------------------------------------------------------------------
update public.country_claims c
set claimed_at = u.created_at
from public.users u
where u.id = c.user_id
  and c.claimed_at = now()
  and lower(u.email) in (select lower(s.email) from pg_temp.seed_users() s);

-- -----------------------------------------------------------------------------
-- 5. Messages that don't exist yet, in 2025.
-- -----------------------------------------------------------------------------
insert into public.messages (user_id, text, event_year, created_at)
select pg_temp.seed_profile_id(m.author), m.body, 2025, m.posted_at
from pg_temp.seed_messages() m
where not exists (
  select 1
  from public.messages existing
  where existing.user_id = pg_temp.seed_profile_id(m.author)
    and existing.text = m.body
    and existing.created_at = m.posted_at
);

-- -----------------------------------------------------------------------------
-- 6. Likes that don't exist yet. UNIQUE (message_id, user_id) makes a re-run
--    skip the ones already there.
-- -----------------------------------------------------------------------------
insert into public.message_likes (message_id, user_id, created_at)
select message.id, liker.id, greatest(message.created_at, liker.created_at) + interval '1 hour'
from pg_temp.seed_messages() m
join public.messages message
  on message.user_id = pg_temp.seed_profile_id(m.author)
 and message.text = m.body
 and message.created_at = m.posted_at
cross join lateral unnest(m.liked_by) as liked (name)
join public.users liker on liker.id = pg_temp.seed_profile_id(liked.name)
on conflict (message_id, user_id) do nothing;

-- -----------------------------------------------------------------------------
-- Tidy up, so the SQL Editor session is left as it was found.
-- -----------------------------------------------------------------------------
drop function pg_temp.seed_profile_id(text);
drop function pg_temp.seed_messages();
drop function pg_temp.seed_users();

commit;
