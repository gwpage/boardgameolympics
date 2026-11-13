/**
 * app.js: main entry point. index.html loads it as an ES module.
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
 *   pinned Supabase CDN bundle). Feature modules (auth.js, feed.js, ...) are
 *   imported from here.
 */

/** Starts the app. Placeholder until the router and views arrive in ISSUE-009. */
export function boot() {
  // Intentionally empty for ISSUE-001: the scaffold only proves the module loads.
}

// The test page (tests/index.html) imports app modules to test their functions,
// and marks itself with data-test-page so that importing never starts the real app.
const IS_TEST_PAGE = document.documentElement.hasAttribute('data-test-page');
if (!IS_TEST_PAGE) {
  boot();
}
