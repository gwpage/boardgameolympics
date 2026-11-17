/**
 * config.example.js: template for public/config.js (SPEC § Configuration, ADR-003).
 *
 * LOCAL DEVELOPMENT
 *   Copy this file to public/config.js (gitignored) and fill in the Project URL
 *   and publishable key (sb_publishable_…) of your *dev* Supabase project.
 *   Both are shown by the dashboard's Connect button (SETUP_SUPABASE.md Step 3).
 *
 * PRODUCTION
 *   Cloudflare Pages generates public/config.js at deploy time from its
 *   SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY environment variables
 *   (scripts/write-config.sh). Never commit real values.
 *
 * SAFETY
 *   The publishable key is safe in the browser: Row Level Security protects the
 *   data, not the key. NEVER put a secret key (sb_secret_…) or the legacy
 *   anon/service_role keys here or anywhere in public/ (ADR-014).
 *
 * CHECKED AT START-UP
 *   js/supabase.js (validateConfig) checks these values before connecting. If
 *   one is missing, still a placeholder, or a secret key, the page shows
 *   "Board Game Olympics can't start" and says what to fix (README § Supabase
 *   client and sessions).
 *
 * Loaded by index.html as a classic <script> before the app, so CONFIG is a
 * global visible to every module.
 */
const CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'your-publishable-key-here'
};
