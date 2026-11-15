-- =============================================================================
-- db/migrations/003_storage.sql: the `flags` storage bucket and who may write
-- to it (ISSUE-004; SPEC.md § File Storage, § Optional Fields;
-- SETUP_SUPABASE.md Step 5).
--
-- HOW TO APPLY
--   After 002_rls.sql: Supabase dashboard → SQL Editor → New query → paste
--   this whole file → Run. It runs in one transaction and is safe to re-run.
--   Check it on dev with tests/db/test_004_storage.sql.
--
--   If the bucket was created by hand from an older version of the setup
--   guide, this file brings its settings in line. Policies made by hand in
--   the dashboard are not removed. Delete them (Storage → Policies), because
--   Postgres ORs permissive policies together, so one loose extra policy
--   undoes the rules below. test_004 lists any it finds.
--
-- WHAT'S STORED
--   Members' flag images, which double as their avatars. One folder per
--   member, named after their profile id (users.id, not the auth id;
--   ADR-007): flags/{member_id}/{timestamp}.{ext} (ISSUE-015). The profile's
--   users.flag_url holds the image's public URL.
--
-- WHO MAY DO WHAT (ADR-018)
--   anyone         load a flag image by its public URL. The bucket is public,
--                  so the Storage API serves those URLs with no policy check.
--                  Nobody gets a SELECT policy for the whole bucket, so
--                  signed-out visitors can't list it.
--   members        upload, replace, rename and delete objects in their own
--                  folder, and list that folder. The Storage API needs SELECT
--                  as well as DELETE to remove a file, and SELECT + UPDATE +
--                  INSERT to overwrite one.
--   admin          the same, in every member's folder (to set someone's flag
--                  for them, ISSUE-024).
--   non-members    (signed in, but no active profile) and anon: nothing.
--   Every policy names bucket_id = 'flags', so none of this reaches any other
--   bucket added later.
--
-- LIMITS (enforced by the Storage API on every upload)
--   file_size_limit     2 MB (2,097,152 bytes), per file
--   allowed_mime_types  image/jpeg, image/png
--   The bucket can't check the 1024 × 1024 px limit; the upload form does
--   (ISSUE-015). The project-wide upload limit (Storage settings, 50 MB on the
--   free plan) is far above 2 MB, so it never gets in the way.
--
-- PRIVILEGES
--   Supabase owns the storage schema and grants the API roles ALL on
--   storage.objects, with RLS on. Unlike our own tables (ADR-015), this file
--   leaves those grants alone: the Storage API runs as those roles and relies
--   on them, and RLS is what limits each caller. RLS is also on for
--   storage.buckets with no policies, so no API caller can create a bucket or
--   loosen these limits (test_004 checks this).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- The bucket. An upsert, so re-running this, or running it on a project where
-- the bucket was made by hand, leaves exactly these settings.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flags', 'flags', true, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set name               = excluded.name,
      public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      updated_at         = now();

-- -----------------------------------------------------------------------------
-- Policies on storage.objects. All four apply the same rule to a different
-- command: the object is in the flags bucket, and it's either in the
-- caller's own folder or the caller is the admin.
--
--   (storage.foldername(name))[1]  the first folder of the object's path:
--                                  '<member id>' for '<member id>/123.png',
--                                  null for a file at the bucket root.
--   current_member_id()            the caller's profile id, or null if they
--                                  are signed out, have no profile, or were
--                                  deactivated. A null never matches.
--
-- Helpers are wrapped as (select …) so Postgres evaluates them once per
-- statement, not once per row (ADR-017).
-- -----------------------------------------------------------------------------

drop policy if exists flags_select on storage.objects;
drop policy if exists flags_insert on storage.objects;
drop policy if exists flags_update on storage.objects;
drop policy if exists flags_delete on storage.objects;

-- Members list their own folder; the admin, every folder. The Storage API
-- also needs this to remove or overwrite a file. Public URLs don't use it.
create policy flags_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'flags'
    and ((select public.is_admin())
         or (storage.foldername(name))[1] = (select public.current_member_id())::text)
  );

create policy flags_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'flags'
    and ((select public.is_admin())
         or (storage.foldername(name))[1] = (select public.current_member_id())::text)
  );

-- USING picks which objects may be changed; WITH CHECK where they may end up.
-- Both are needed, or a member could move a file into someone else's folder.
create policy flags_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'flags'
    and ((select public.is_admin())
         or (storage.foldername(name))[1] = (select public.current_member_id())::text)
  )
  with check (
    bucket_id = 'flags'
    and ((select public.is_admin())
         or (storage.foldername(name))[1] = (select public.current_member_id())::text)
  );

create policy flags_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'flags'
    and ((select public.is_admin())
         or (storage.foldername(name))[1] = (select public.current_member_id())::text)
  );

commit;
