/**
 * app.js: main entry point. index.html loads it as an ES module.
 *
 * WHAT IT DOES NOW
 *   boot() starts the theme (ISSUE-006), then the Supabase client
 *   (ISSUE-007). If the client can't start (bad config.js, or the Supabase
 *   library didn't load), the reason is shown in #app instead of "Loading…"
 *   forever.
 *
 * WHAT IT WILL DO (ISSUE-009)
 *   - Wait for Supabase to resolve the session before routing, including the
 *     #access_token / #error fragments that magic-link and OAuth callbacks put
 *     in the URL.
 *   - Hash routing: #/ (home), #/rules, #/profile, #/admin.
 *   - Choose a view from auth state: landing (logged out), registration or
 *     not-invited (signed in without a membership), or the member pages.
 *
 * HOW IT FITS
 *   Runs in the browser with no build step (ADR-005). Two globals come from the
 *   classic scripts loaded before it: CONFIG (config.js) and supabase (the
 *   pinned Supabase CDN bundle). supabase.js reads them. Feature modules
 *   (auth.js, feed.js, ...) are imported from here.
 */

import { initTheme } from './theme.js';
import { SetupError, getSupabase, renderSetupError } from './supabase.js';

/** id of the <main> element that views render into (index.html). */
const APP_ROOT_ID = 'app';

/**
 * Starts the app. The router and views arrive in ISSUE-009.
 *
 * Every dependency can be injected so tests can drive it with fakes. The
 * defaults are the real page.
 *
 * @param {object} [options]
 * @param {() => void} [options.startTheme]   Starts the theme toggle (default: initTheme).
 * @param {() => object} [options.getClient]  Returns the Supabase client or throws SetupError (default: getSupabase).
 * @param {Element} [options.appRoot]         Where views and the setup error render (default: #app).
 * @returns {object|null} The Supabase client, or null if it couldn't start and the error is showing.
 */
export function boot({
  startTheme = initTheme,
  getClient = getSupabase,
  appRoot = document.getElementById(APP_ROOT_ID),
} = {}) {
  // First, so the header toggle works on every view, even the setup error.
  startTheme();

  try {
    return getClient();
  } catch (error) {
    // Anything other than a SetupError is a bug: let it surface in the console as usual.
    if (!(error instanceof SetupError)) {
      throw error;
    }
    console.error(error);
    renderSetupError(appRoot, error.problems);
    return null;
  }
}

// The test page (tests/index.html) imports app modules to test their functions,
// and marks itself with data-test-page so that importing never starts the real app.
const IS_TEST_PAGE = document.documentElement.hasAttribute('data-test-page');
if (!IS_TEST_PAGE) {
  boot();
}
