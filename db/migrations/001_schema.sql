-- =============================================================================
-- db/migrations/001_schema.sql: tables, constraints and core functions
-- (ISSUE-002; SPEC.md § Data Model, § Yearly Lifecycle).
--
-- HOW TO APPLY
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--   Apply migrations in file-name order: 001, 002, … Each runs in a single
--   transaction, so it applies completely or not at all. Re-running a
--   migration is harmless (tests/db/run_local.sh checks this on every run).
--
-- WHAT'S HERE
--   Six tables: event_settings, invitations, users, messages, message_likes,
--   country_claims. They are snake_case versions of the spec's camelCase
--   models, plus a few columns the spec implies but doesn't list (see the
--   comments on each column and ADR-007 to ADR-011). Also: the
--   current_event_year() function that year-scoping relies on, the membership
--   helpers that RLS policies call, and the trigger that logs country claims.
--
-- LIMITS (enforced here, so a client that skips validation still can't store
-- bad data. The UI checks the same limits first, for friendly messages.)
--   users.name                1–100 characters, not blank
--   users.email               looks like local@domain, at most 254 characters
--   users.country             null, or 1–100 characters and not blank (SPEC: max 100)
--   users.flag_url            null, or an https:// URL of at most 2048 characters
--   messages.text             1–1000 characters, not blank
--   event_settings.theme_*    title 1–100 characters and not blank; description at most 2000
--   invitations.token         exactly 64 lowercase hex characters
--   "Characters" means Unicode code points (char_length), not bytes.
--   "Not blank" means the value contains at least one non-whitespace character.
--
-- SECURITY
--   RLS is switched on for every table right here, with no policies, so each
--   table denies all API access until 002_rls.sql grants exactly what each
--   role needs. Supabase's API is public; a table must never be reachable
--   before its policies exist.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- event_settings: one row per yearly event. The newest row is "this year".
-- -----------------------------------------------------------------------------

create table if not exists public.event_settings (
  id          uuid primary key default gen_random_uuid(),
  year        integer not null,
  event_date  date not null,
  theme_title text not null,
  theme_desc  text not null default '',
  updated_at  timestamptz not null default now(),
  constraint event_settings_year_key unique (year),
  constraint event_settings_theme_title_check
    check (theme_title ~ '[^[:space:]]' and char_length(theme_title) <= 100),
  constraint event_settings_theme_desc_check
    check (char_length(theme_desc) <= 2000)
);

comment on table public.event_settings is
  'One row per yearly event: date and sidebar theme. The row with the highest year is the current event; '
  'older rows are the archive. Rows are added by the admin (Start New Year), never deleted.';
comment on column public.event_settings.year is
  'Event year. Unique, so each year has exactly one settings row. Its max is current_event_year().';
comment on column public.event_settings.updated_at is
  'Bumped automatically by the event_settings_set_updated_at trigger.';

-- Keeps updated_at honest without relying on every client to set it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the transaction time, so clients cannot forget or forge it.';

drop trigger if exists event_settings_set_updated_at on public.event_settings;
create trigger event_settings_set_updated_at
  before update on public.event_settings
  for each row execute function public.set_updated_at();

-- The year that "current" data belongs to. Column defaults below call it, so
-- it must exist before the tables that use it.
create or replace function public.current_event_year()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(year), extract(year from current_date)::integer)
  from public.event_settings
$$;

comment on function public.current_event_year() is
  'The current event year: the newest event_settings.year (ADR-008). Before any settings exist (a fresh install) it '
  'falls back to the calendar year, so new rows always get a year. SECURITY DEFINER so it works in column defaults '
  'and RLS policies whatever the caller can read; it reveals only a year.';

-- -----------------------------------------------------------------------------
-- invitations: email invitations and shareable invite links.
-- -----------------------------------------------------------------------------

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  email       text,
  -- Two v4 UUIDs from the server's cryptographic RNG: 244 random bits, hex encoded.
  token       text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  status      text not null default 'pending',
  max_uses    integer not null default 1,
  use_count   integer not null default 0,
  event_year  integer not null default public.current_event_year(),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  constraint invitations_token_key unique (token),
  constraint invitations_type_check check (type in ('email', 'link')),
  constraint invitations_status_check check (status in ('pending', 'accepted', 'revoked')),
  constraint invitations_email_required check (type <> 'email' or email is not null),
  constraint invitations_email_format
    check (email is null or (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length(email) <= 254)),
  constraint invitations_token_format check (token ~ '^[0-9a-f]{64}$'),
  constraint invitations_max_uses_check check (max_uses >= 1),
  constraint invitations_email_single_use check (type <> 'email' or max_uses = 1),
  constraint invitations_use_count_check check (use_count between 0 and max_uses),
  constraint invitations_accepted_at_check check (status <> 'accepted' or accepted_at is not null),
  constraint invitations_revoked_at_check check ((status = 'revoked') = (revoked_at is not null))
);

comment on table public.invitations is
  'Who may join. type=email: an invitation to one address (sent by the invite-user Edge Function, ADR-002). '
  'type=link: a shareable link carrying the token, optionally usable several times (ADR-009). '
  'Admin-only; rows are revoked, never deleted.';
comment on column public.invitations.email is
  'Required for email invitations; null for links (the person gives their email when they sign in).';
comment on column public.invitations.token is
  'Secret in the invite link (?invite=TOKEN). Generated by the database, never by the browser: 64 hex chars '
  'from two v4 UUIDs, i.e. 244 bits from the server''s cryptographic RNG. Unguessable, so a link cannot be forged.';
comment on column public.invitations.status is
  'pending: usable. accepted: all uses consumed. revoked: cancelled by the admin, or freed when its user was '
  'removed (ADR-009, ADR-010). The spec lists pending/accepted; revoked is an addition.';
comment on column public.invitations.max_uses is
  'How many people may join with this invitation. Email invitations are always 1; links default to 1 (ADR-009).';
comment on column public.invitations.use_count is
  'How many people have joined with it. When it reaches max_uses, status becomes accepted.';
comment on column public.invitations.event_year is
  'The event year it was issued for. Prior-year invitations are archived and stop working (ADR-008).';
comment on column public.invitations.accepted_at is
  'When the first person joined with it.';
comment on column public.invitations.revoked_at is
  'When it was revoked. Set exactly when status = revoked.';

-- -----------------------------------------------------------------------------
-- users: one profile per invited person.
-- -----------------------------------------------------------------------------

create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid references auth.users (id) on delete set null,
  name           text not null,
  email          text not null,
  country        text,
  flag_url       text,
  rsvp           text not null default 'no_response',
  role           text not null default 'user',
  is_active      boolean not null default true,
  deactivated_at timestamptz,
  invitation_id  uuid references public.invitations (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint users_auth_user_id_key unique (auth_user_id),
  constraint users_name_check check (name ~ '[^[:space:]]' and char_length(name) <= 100),
  constraint users_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length(email) <= 254),
  constraint users_country_check check (country is null or (country ~ '[^[:space:]]' and char_length(country) <= 100)),
  constraint users_flag_url_check check (flag_url is null or (flag_url ~ '^https://' and char_length(flag_url) <= 2048)),
  constraint users_rsvp_check check (rsvp in ('attending', 'not_attending', 'no_response')),
  constraint users_role_check check (role in ('admin', 'user')),
  constraint users_deactivation_check check (is_active = (deactivated_at is null))
);

-- Case-insensitive uniqueness: Bob@Example.com and bob@example.com are one person.
create unique index if not exists users_email_lower_key on public.users (lower(email));

comment on table public.users is
  'One profile per invited person; persists across years. Not the same as auth.users: a profile can exist before its '
  'owner ever signs in (seed data, admin-created), and is linked on first sign-in by email (ADR-007). '
  'Users are deactivated, never deleted (ADR-010).';
comment on column public.users.email is
  'Unique ignoring case (index users_email_lower_key). Matched against the sign-in email to link the profile.';
comment on column public.users.country is
  'Free text, real or invented. Every change to a new non-null value logs a country_claims row (trigger).';
comment on column public.users.flag_url is
  'Public URL of the flag image in the flags bucket. Must be https, so a profile cannot point other members'' '
  'browsers at javascript:, data: or plain-http URLs.';
comment on column public.users.auth_user_id is
  'Addition (ADR-007): the Supabase Auth account, once linked. Null until the person first signs in; unique, so one '
  'account maps to one profile. If the Auth account is deleted the profile is unlinked, not deleted.';
comment on column public.users.is_active is
  'Addition (ADR-010): false once the admin removes the user. Inactive users are denied all access, but their '
  'messages and claims remain as history.';
comment on column public.users.deactivated_at is
  'Addition (ADR-010): when the user was removed. Set exactly when is_active is false.';
comment on column public.users.invitation_id is
  'Addition: the invitation this person joined with, so removing them can revoke it and free the email for a new '
  'invitation (ADR-010). Null for the seeded admin, seed data and admin-created users.';

-- -----------------------------------------------------------------------------
-- messages: the message board.
-- -----------------------------------------------------------------------------

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete restrict,
  text       text not null,
  event_year integer not null default public.current_event_year(),
  created_at timestamptz not null default now(),
  constraint messages_text_check check (text ~ '[^[:space:]]' and char_length(text) <= 1000)
);

-- The board pages newest-first within the current year using a
-- (created_at, id) cursor; this index serves exactly that query.
create index if not exists messages_board_page_idx on public.messages (event_year, created_at desc, id desc);
create index if not exists messages_user_id_idx on public.messages (user_id);

comment on table public.messages is
  'Message board posts. Only the admin can delete them; nobody edits them. Prior years stay as the archive.';
comment on column public.messages.user_id is
  'Author. ON DELETE RESTRICT: users are deactivated, never deleted, and an accidental hard delete must fail '
  'rather than erase history (ADR-010).';
comment on column public.messages.event_year is
  'Addition (ADR-008): the event year it was posted in. The board shows only the current year.';

-- -----------------------------------------------------------------------------
-- message_likes: "meeples", one per user per message.
-- -----------------------------------------------------------------------------

create table if not exists public.message_likes (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint message_likes_message_user_key unique (message_id, user_id)
);

create index if not exists message_likes_user_id_idx on public.message_likes (user_id);

comment on table public.message_likes is
  'Meeple likes. UNIQUE (message_id, user_id) makes a double-click unable to like twice. Likes are deleted with their '
  'message (ON DELETE CASCADE), so moderation needs only one delete.';

-- -----------------------------------------------------------------------------
-- country_claims: the activity feed's "X claimed Y" entries.
-- -----------------------------------------------------------------------------

create table if not exists public.country_claims (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete restrict,
  country    text not null,
  event_year integer not null default public.current_event_year(),
  claimed_at timestamptz not null default now(),
  constraint country_claims_country_check check (country ~ '[^[:space:]]' and char_length(country) <= 100)
);

create index if not exists country_claims_feed_page_idx on public.country_claims (event_year, claimed_at desc, id desc);
create index if not exists country_claims_user_id_idx on public.country_claims (user_id);

comment on table public.country_claims is
  'History of country claims for the activity feed. Written only by the users_record_country_claim trigger, never '
  'by clients, so nobody can forge a claim for someone else (ADR-011).';
comment on column public.country_claims.event_year is
  'Addition (ADR-008): the event year of the claim. The feed shows only the current year.';

-- -----------------------------------------------------------------------------
-- Country-claim trigger (ADR-011)
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER because members have no INSERT policy on country_claims:
-- the trigger writes the claim on their behalf, and nothing else can.
create or replace function public.record_country_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A claim is a change *to* a country. Clearing one (null) is not a claim,
  -- and re-saving the same value is not news.
  if new.country is not null
     and (tg_op = 'INSERT' or new.country is distinct from old.country) then
    insert into public.country_claims (user_id, country, event_year)
    values (new.id, new.country, public.current_event_year());
  end if;
  return null;  -- AFTER trigger: the return value is ignored.
end;
$$;

comment on function public.record_country_claim() is
  'AFTER INSERT/UPDATE OF country trigger on users: logs a country_claims row whenever a user gets a new non-null '
  'country, whether they change it themselves or the admin does. The only writer of country_claims (ADR-011).';

drop trigger if exists users_record_country_claim on public.users;
create trigger users_record_country_claim
  after insert or update of country on public.users
  for each row execute function public.record_country_claim();

-- -----------------------------------------------------------------------------
-- Membership helpers for RLS policies (002_rls.sql) and RPCs.
--
-- SECURITY DEFINER so they can read public.users even though RLS restricts
-- what the caller sees. Without it, a policy on users that calls is_member()
-- would recurse into itself. search_path is empty and every name is
-- schema-qualified, so nobody can redirect them by creating look-alike
-- objects in another schema.
-- -----------------------------------------------------------------------------

create or replace function public.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.is_active
$$;

comment on function public.current_member_id() is
  'The caller''s profile id (public.users.id), or null if they are signed out, have no linked profile, or were '
  'deactivated. Policies compare row owners against this rather than auth.uid(), because users.id is not the auth id '
  '(ADR-007).';

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_member_id() is not null
$$;

comment on function public.is_member() is
  'True if the caller has an active profile linked to their Auth account. Signed-in strangers (no profile) and '
  'deactivated users are not members and get no access.';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active
      and u.role = 'admin'
  )
$$;

comment on function public.is_admin() is
  'True if the caller is an active admin. A deactivated admin loses admin rights immediately.';

-- -----------------------------------------------------------------------------
-- Function privileges (least privilege).
--
-- Supabase grants EXECUTE on every new function to anon and authenticated,
-- and Postgres grants it to PUBLIC. Take it back, then grant only what's
-- needed: signed-in users need the helpers because RLS policies and column
-- defaults run them as the caller. anon never needs them, and the trigger
-- functions are run only by their triggers.
-- -----------------------------------------------------------------------------

revoke execute on function
  public.current_event_year(), public.current_member_id(), public.is_member(), public.is_admin()
  from public, anon;
grant execute on function
  public.current_event_year(), public.current_member_id(), public.is_member(), public.is_admin()
  to authenticated, service_role;

revoke execute on function public.record_country_claim(), public.set_updated_at()
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Deny by default: RLS on, no policies yet (see SECURITY in the header).
-- -----------------------------------------------------------------------------

alter table public.event_settings enable row level security;
alter table public.invitations    enable row level security;
alter table public.users          enable row level security;
alter table public.messages       enable row level security;
alter table public.message_likes  enable row level security;
alter table public.country_claims enable row level security;

commit;
