/**
 * config.example.js: template for public/config.js (SPEC § Configuration, ADR-003).
 *
 * LOCAL DEVELOPMENT
 *   Copy this file to public/config.js (gitignored) and fill in the values from
 *   your *dev* Supabase project: Project Settings → API.
 *
 * PRODUCTION
 *   Cloudflare Pages generates public/config.js at deploy time from its
 *   SUPABASE_URL and SUPABASE_ANON_KEY environment variables
 *   (scripts/write-config.sh). Never commit real values.
 *
 * SAFETY
 *   The anon key is safe in the browser: Row Level Security protects the data,
 *   not the key. NEVER put the service_role key here or anywhere in public/.
 *
 * Loaded by index.html as a classic <script> before the app, so CONFIG is a
 * global visible to every module.
 */
const CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key-here'
};
