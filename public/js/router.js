/**
 * router.js: the routes, and which view each visitor gets (ISSUE-009, ADR-023).
 *
 * SPEC DEVIATION: SPEC § Project Structure puts routing in app.js. This file
 * holds the part of it with no DOM and no Supabase, so it can be tested on its
 * own; app.js keeps everything that touches the page. The spec allows
 * splitting a file "further" when that helps.
 *
 * WHAT IT DOES
 *   - parseRoute(location.hash) reads a hash route: #/ (home), #/rules,
 *     #/profile, #/admin and #/admin/<panel>. An empty hash is home. Anything
 *     else is an unknown route, which goes home.
 *   - isAuthCallback(hash) spots the fragments Supabase puts in the URL when a
 *     magic link or OAuth sign-in comes back (#access_token=…, #error=…).
 *     They are never routes. readAuthCallbackError(hash) reads the error out of
 *     a failed one, for the login screen to explain (ISSUE-011).
 *   - resolveView(route, account) picks the view: the landing page when
 *     logged out, registration or "not invited" when signed in without a
 *     membership, otherwise the page asked for. It also says when the address
 *     bar should be corrected to #/.
 *   - navLinks(route, account) lists the header links, with the current one marked.
 *
 * WHY HASH ROUTES (ADR-023)
 *   The site is one static page. Routes after "#" never reach the server, so
 *   any route can be reloaded or bookmarked without server rewrite rules, and
 *   it works the same at "/" in production and "/public/" locally. Routes
 *   always start "#/"; Supabase's callback fragments never do, which is how
 *   the two are told apart.
 *
 * SECURITY
 *   These guards are for convenience only. Hiding #/admin from members just
 *   saves them a page they can't use. Row Level Security and the admin-only
 *   database functions (ISSUE-003) are what actually stop a non-admin, or a
 *   signed-in stranger, from reading or changing anything. Never rely on this
 *   file to protect data.
 */

/** The pages a hash route can name. */
export const PAGE = Object.freeze({
  HOME: 'home',
  RULES: 'rules',
  PROFILE: 'profile',
  ADMIN: 'admin',
});

/** The views app.js can show. Member pages share their names with PAGE. */
export const VIEW = Object.freeze({
  LOADING: 'loading',
  LANDING: 'landing',
  REGISTRATION: 'registration',
  NOT_INVITED: 'not_invited',
  UNAVAILABLE: 'unavailable',
  HOME: PAGE.HOME,
  RULES: PAGE.RULES,
  PROFILE: PAGE.PROFILE,
  ADMIN: PAGE.ADMIN,
});

/**
 * Who the visitor is, as far as the app knows. app.js's loadAccount() works it out.
 *   SIGNED_OUT          no session: the public landing page.
 *   UNAVAILABLE         Supabase couldn't be reached, so we don't know yet.
 *   NEEDS_REGISTRATION  invited and signed in, but hasn't filled in the form yet (ISSUE-012).
 *   NOT_INVITED         signed in, but no invitation and no profile.
 *   DEACTIVATED         signed in, but the admin removed them.
 *   MEMBER              an active member: the dashboard and member pages.
 */
export const ACCOUNT = Object.freeze({
  SIGNED_OUT: 'signed_out',
  UNAVAILABLE: 'unavailable',
  NEEDS_REGISTRATION: 'needs_registration',
  NOT_INVITED: 'not_invited',
  DEACTIVATED: 'deactivated',
  MEMBER: 'member',
});

/** users.role values (db/migrations/001_schema.sql). */
export const ROLE = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});

/** The home route. Unknown routes are corrected to this. */
export const HOME_HASH = '#/';

/**
 * Every route, in nav order. `allowsSubpath` lets #/admin/users through for
 * the admin panel's own sub-routes (ISSUE-020).
 */
export const ROUTES = Object.freeze(
  [
    { page: PAGE.HOME, hash: HOME_HASH, label: 'Home', adminOnly: false, allowsSubpath: false },
    { page: PAGE.RULES, hash: '#/rules', label: 'Rules', adminOnly: false, allowsSubpath: false },
    { page: PAGE.PROFILE, hash: '#/profile', label: 'Profile', adminOnly: false, allowsSubpath: false },
    { page: PAGE.ADMIN, hash: '#/admin', label: 'Admin', adminOnly: true, allowsSubpath: true },
  ].map((route) => Object.freeze(route))
);

/**
 * Fragment parameters that mark a Supabase auth callback. A successful
 * implicit-flow sign-in returns #access_token=…&refresh_token=…; a failed one
 * returns #error=…&error_code=…&error_description=…. supabase-js looks for the
 * same names (2.118.0, _isImplicitGrantCallback).
 */
export const AUTH_CALLBACK_PARAMS = Object.freeze(['access_token', 'refresh_token', 'error', 'error_code', 'error_description']);

/** Hash routes start with this, after the "#". */
const ROUTE_PREFIX = '/';

const SEGMENT_SEPARATOR = '/';

const HOME_ROUTE = Object.freeze({ page: PAGE.HOME, subpath: Object.freeze([]), known: true });
const UNKNOWN_ROUTE = Object.freeze({ page: PAGE.HOME, subpath: Object.freeze([]), known: false });

/** The non-member views, by account state. Members are handled separately. */
const VIEW_FOR_ACCOUNT_STATE = Object.freeze({
  [ACCOUNT.SIGNED_OUT]: VIEW.LANDING,
  [ACCOUNT.UNAVAILABLE]: VIEW.UNAVAILABLE,
  [ACCOUNT.NEEDS_REGISTRATION]: VIEW.REGISTRATION,
  [ACCOUNT.NOT_INVITED]: VIEW.NOT_INVITED,
  [ACCOUNT.DEACTIVATED]: VIEW.NOT_INVITED,
});

const KNOWN_ROLES = new Set(Object.values(ROLE));

/**
 * Reads a hash route.
 *
 * @param {string} hash  location.hash: "" or "#…".
 * @returns {{page: string, subpath: string[], known: boolean}}
 *   `known` is false for anything that isn't one of the routes; such a route
 *   is treated as home and the address bar corrected (resolveView).
 *   Matching is exact: "#/Rules" and "#/rules?x" are unknown. A trailing
 *   slash is allowed.
 */
export function parseRoute(hash) {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment === '' || fragment === ROUTE_PREFIX) {
    return HOME_ROUTE;
  }
  if (!fragment.startsWith(ROUTE_PREFIX)) {
    return UNKNOWN_ROUTE; // "#top", or an auth callback.
  }

  const segments = fragment.slice(ROUTE_PREFIX.length).split(SEGMENT_SEPARATOR);
  if (segments.at(-1) === '') {
    segments.pop(); // trailing slash
  }
  const [name, ...subpath] = segments;
  // HOME's own name isn't a route segment: "#/home" is unknown, and home is "#/".
  const route = ROUTES.find((candidate) => candidate.page === name && candidate.page !== PAGE.HOME);
  const subpathAllowed = subpath.length === 0 || (route?.allowsSubpath && subpath.every((segment) => segment !== ''));
  if (!route || !subpathAllowed) {
    return UNKNOWN_ROUTE;
  }
  return { page: route.page, subpath, known: true };
}

/**
 * True if `hash` is a Supabase auth callback fragment, not a route.
 *
 * @param {string} hash  location.hash.
 */
export function isAuthCallback(hash) {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment === '' || fragment.startsWith(ROUTE_PREFIX)) {
    return false;
  }
  const params = new URLSearchParams(fragment);
  return AUTH_CALLBACK_PARAMS.some((name) => params.has(name));
}

/**
 * The error from a failed sign-in's callback fragment, or null if `hash`
 * isn't one. supabase-js doesn't clear these from the URL, so app.js reads it
 * before removing the fragment.
 *
 * @param {string} hash  location.hash, e.g. "#error=access_denied&error_code=otp_expired&error_description=…".
 * @returns {{error: string|null, code: string|null, description: string|null}|null}
 *   `code` is the one to switch on (otp_expired, …); ISSUE-011 turns it into friendly text.
 */
export function readAuthCallbackError(hash) {
  if (!isAuthCallback(hash)) {
    return null;
  }
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const error = params.get('error');
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (error === null && code === null && description === null) {
    return null; // a successful sign-in
  }
  return { error, code, description };
}

/**
 * Chooses the view for a route and a visitor.
 *
 * Remember: this only decides what to SHOW. RLS decides what anyone can read
 * or change (see SECURITY in the header).
 *
 * @param {{page: string, subpath: string[], known: boolean}} route  From parseRoute().
 * @param {{state: string, profile?: {role: string}}} account  From app.js's loadAccount().
 * @returns {{view: string, hash: string|null}}
 *   `hash` is what the address bar should be corrected to, or null to leave
 *   it. Unknown routes are corrected to #/, as is #/admin for a non-admin.
 *   Known routes are left alone for everyone else, so a logged-out visitor's
 *   #/rules is still there after they sign in.
 * @throws {TypeError} For an unrecognised account state or role: a bug.
 */
export function resolveView(route, account) {
  const correction = route.known ? null : HOME_HASH;
  const state = account?.state;

  if (state !== ACCOUNT.MEMBER) {
    if (!Object.hasOwn(VIEW_FOR_ACCOUNT_STATE, state ?? '')) {
      throw new TypeError(`resolveView: unrecognised account state ${JSON.stringify(state)}`);
    }
    return { view: VIEW_FOR_ACCOUNT_STATE[state], hash: correction };
  }

  if (route.page === PAGE.ADMIN && !isAdmin(account)) {
    return { view: VIEW.HOME, hash: HOME_HASH };
  }
  return { view: route.page, hash: correction };
}

/**
 * The header nav links for this visitor. Members get Home, Rules and Profile;
 * admins also get Admin. Everyone else gets none, since every page but the
 * landing page is members-only.
 *
 * @returns {{hash: string, label: string, current: boolean}[]}
 */
export function navLinks(route, account) {
  if (account?.state !== ACCOUNT.MEMBER) {
    return [];
  }
  const admin = isAdmin(account);
  // The page actually shown: a member on #/admin is about to be sent home.
  const shownPage = resolveView(route, account).view;
  return ROUTES.filter((candidate) => admin || !candidate.adminOnly).map((candidate) => ({
    hash: candidate.hash,
    label: candidate.label,
    current: candidate.page === shownPage,
  }));
}

/** True for an admin member. Throws on a role the app doesn't know, rather than guessing. */
function isAdmin(account) {
  const role = account.profile?.role;
  if (!KNOWN_ROLES.has(role)) {
    throw new TypeError(`unrecognised role ${JSON.stringify(role)}`);
  }
  return role === ROLE.ADMIN;
}
