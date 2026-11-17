/**
 * app.js: main entry point. index.html loads it as an ES module.
 *
 * WHAT IT DOES
 *   1. boot() starts the theme (ISSUE-006), then the Supabase client
 *      (ISSUE-007). If the client can't start (bad config.js, or the Supabase
 *      library didn't load), the reason is shown in #app instead.
 *   2. startApp() (ISSUE-009, ADR-023) works out who the visitor is, then
 *      shows the right view for the hash route, and keeps it right as the
 *      route or the sign-in changes:
 *        - loading:      "Loading…" until the session is known, so a
 *                        signed-in member never sees the landing page flash up;
 *        - landing:      logged out, on every route (landing.js, ISSUE-010);
 *        - registration: invited, signed in, form not filled in yet (ISSUE-012);
 *        - not invited:  signed in, but not a member (or deactivated);
 *        - unavailable:  Supabase couldn't be reached, with Try again;
 *        - member pages: home (#/), rules, profile and admin, inside one
 *                        layout with the sidebar (ISSUE-013).
 *      The header (static in index.html, outside #app) gets the nav links for
 *      members and the Log out button for anyone signed in.
 *
 * ORDER MATTERS ON A SIGN-IN RETURN
 *   A magic link or OAuth sign-in comes back with the session in the URL
 *   fragment (#access_token=…). supabase-js reads it while it starts up,
 *   saves the session, and clears the fragment. So startApp() doesn't read or
 *   change the URL until `await client.auth.getSession()` has returned, which
 *   waits for that. A failed sign-in (#error=…) is left in the URL by
 *   supabase-js; startApp() keeps the error (callbackError, for ISSUE-011's
 *   message) and removes the fragment. Neither is ever treated as a route.
 *
 * WHO IS A MEMBER (until ISSUE-012)
 *   loadMembership() asks the database for the caller's linked profile. Until
 *   ISSUE-012 adds claim_membership, nobody gets linked by signing in, so a
 *   signed-in visitor without a profile is "not invited". ISSUE-012 replaces
 *   loadMembership() with its claim, which can also answer "needs
 *   registration" and "deactivated".
 *
 * SECURITY
 *   Which view is shown is convenience only. Row Level Security (ISSUE-003)
 *   is what stops a non-member or non-admin reading or changing anything. See
 *   router.js.
 *
 * HOW IT FITS
 *   Runs in the browser with no build step (ADR-005). Two globals come from the
 *   classic scripts loaded before it: CONFIG (config.js) and supabase (the
 *   pinned Supabase CDN bundle). supabase.js reads them. router.js decides
 *   what to show; this file shows it. Feature modules (feed.js, messages.js, …)
 *   take over the placeholder views as their issues land.
 */

import { initTheme } from './theme.js';
import { SetupError, getSupabase, renderSetupError } from './supabase.js';
import { ACCOUNT, VIEW, isAuthCallback, navLinks, parseRoute, readAuthCallbackError, resolveView } from './router.js';
import { renderLanding } from './landing.js';
import { createElement as create } from './util.js';

/** The site's name: the whole <title> on the home and landing pages, the suffix elsewhere. */
export const SITE_NAME = 'Board Game Olympics';

/** id of the <main> element that views render into (index.html). */
const APP_ROOT_ID = 'app';

/** ids of the header's nav and Log out button (index.html). Both ship hidden. */
export const NAV_ID = 'site-nav';
export const LOGOUT_BUTTON_ID = 'logout-button';

/** Between the page name and the site name in <title>: "Rules · Board Game Olympics". */
const TITLE_SEPARATOR = ' · ';

/**
 * The supabase-js auth events that can mean a different person (or nobody)
 * is now signed in. The others (INITIAL_SESSION, TOKEN_REFRESHED,
 * USER_UPDATED, …) never change who it is.
 */
const AUTH_EVENTS_THAT_CHANGE_WHO = new Set(['SIGNED_IN', 'SIGNED_OUT']);

/**
 * supabase-js's name for "couldn't reach Supabase" (a network failure or a
 * 5xx). getSession() returns it when an expired session couldn't be renewed;
 * supabase-js keeps the session to try again later, so it isn't a sign-out.
 */
const RETRYABLE_AUTH_ERROR_NAME = 'AuthRetryableFetchError';

/**
 * Log out of this browser only. supabase-js's default ("global") would also
 * sign the person out on their phone and every other device (ADR-023).
 */
const SIGN_OUT_OPTIONS = Object.freeze({ scope: 'local' });

/** The profile columns the shell needs: who it is, and whether they're the admin. */
const MEMBER_PROFILE_COLUMNS = 'id, name, role';

/* ------------------------------------------------------------------------- */
/* Start-up                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Starts the theme, then the Supabase client.
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

/* ------------------------------------------------------------------------- */
/* Who is the visitor?                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Finds the signed-in person's membership. Replaced by ISSUE-012's
 * claim_membership call; see WHO IS A MEMBER in the header.
 *
 * @param {object} client  The Supabase client, with a session.
 * @returns {Promise<{state: string, profile: {id: string, name: string, role: string}|null}>}
 *   MEMBER with their profile, or NOT_INVITED.
 * @throws The PostgREST error, if the database couldn't be asked. That's
 *   "unavailable", never "not invited".
 */
export async function loadMembership(client) {
  // current_member_id() (001_schema.sql) is the caller's active, linked profile id, or null.
  const { data: memberId, error } = await client.rpc('current_member_id');
  if (error) {
    throw error;
  }
  if (!memberId) {
    return { state: ACCOUNT.NOT_INVITED, profile: null };
  }

  const { data: profile, error: profileError } = await client
    .from('users')
    .select(MEMBER_PROFILE_COLUMNS)
    .eq('id', memberId)
    .maybeSingle();
  if (profileError) {
    throw profileError;
  }
  // No row means RLS hid it: they were deactivated between the two calls.
  return profile ? { state: ACCOUNT.MEMBER, profile } : { state: ACCOUNT.NOT_INVITED, profile: null };
}

/**
 * Works out who the visitor is: signed out, a member, signed in without a
 * membership, or unknown because Supabase couldn't be reached.
 *
 * Never throws. Failures are logged and come back as UNAVAILABLE, which
 * shows a Try again button.
 *
 * @param {object} client  The Supabase client.
 * @param {object} [options]
 * @param {(client: object, session: object) => Promise<{state: string, profile: object|null}>} [options.loadMembership]
 * @returns {Promise<{state: string, session: object|null, profile?: object|null}>}
 */
export async function loadAccount(client, { loadMembership: membershipLoader = loadMembership } = {}) {
  let session = null;
  try {
    // Waits for supabase-js to finish starting up, including reading a sign-in fragment from the URL.
    const { data, error } = await client.auth.getSession();
    session = data?.session ?? null;

    if (!session) {
      if (error?.name === RETRYABLE_AUTH_ERROR_NAME) {
        console.warn("Session: couldn't reach Supabase to renew the saved session. Showing Try again.", error);
        return { state: ACCOUNT.UNAVAILABLE, session: null };
      }
      if (error) {
        // supabase-js has already deleted a session the server refused (revoked, or signed out elsewhere).
        console.warn('Session: Supabase refused the saved session, so treating the visitor as signed out.', error);
      }
      return { state: ACCOUNT.SIGNED_OUT, session: null };
    }

    const { state, profile } = await membershipLoader(client, session);
    return { state, profile, session };
  } catch (error) {
    console.error("Account: couldn't find out who is signed in. Showing Try again.", error);
    return { state: ACCOUNT.UNAVAILABLE, session };
  }
}

/* ------------------------------------------------------------------------- */
/* The app                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Shows the right view for the visitor and the hash route, and keeps it right.
 *
 * Every dependency can be injected so tests can drive it with fakes. The
 * defaults are the real page.
 *
 * @param {object} options
 * @param {object} options.client               The Supabase client, from boot().
 * @param {Element} [options.appRoot]           Where views render (default: #app).
 * @param {Element} [options.nav]               The header nav (default: #site-nav).
 * @param {HTMLButtonElement} [options.logoutButton]  (default: #logout-button)
 * @param {Window} [options.win]                For location, history and hashchange (default: window).
 * @param {{title: string}} [options.doc]       Whose title to set (default: document).
 * @param {Function} [options.loadMembership]   See loadAccount() (default: loadMembership).
 * @returns {Promise<{refresh(): Promise<void>, stop(): void, readonly account: object, readonly callbackError: object|null}>}
 *   Resolves once the first view is showing.
 *   `callbackError` is the error from a failed sign-in's #error=… fragment, if
 *   any (see readAuthCallbackError in router.js).
 */
export async function startApp({
  client,
  appRoot = document.getElementById(APP_ROOT_ID),
  nav = document.getElementById(NAV_ID),
  logoutButton = document.getElementById(LOGOUT_BUTTON_ID),
  win = window,
  doc = document,
  loadMembership: membershipLoader = loadMembership,
}) {
  let account = null;
  let loading = false;
  let stopped = false;
  let callbackError = null;
  let subscription = null;
  // Each load gets a number. A load that finishes after a newer one started is
  // stale and is dropped, so the latest sign-in state always wins.
  let loadNumber = 0;

  /** Rewrites the fragment without adding a history entry or firing hashchange. Keeps ?invite=… (ISSUE-012). */
  const replaceHash = (hash) => {
    const { pathname, search } = win.location;
    win.history.replaceState(win.history.state, '', `${pathname}${search}${hash}`);
  };

  /** Removes a Supabase callback fragment from the URL, keeping a sign-in error for ISSUE-011 to explain. */
  const takeAuthCallbackFragment = () => {
    const { hash } = win.location;
    if (!isAuthCallback(hash)) {
      return;
    }
    const error = readAuthCallbackError(hash);
    if (error) {
      callbackError = error;
      console.warn('Sign-in: the sign-in link or provider returned an error.', error);
    } else {
      // supabase-js clears a session fragment it accepts, so one still here was
      // refused (a stale or tampered link), or arrived after start-up and was never read.
      console.warn('Sign-in: Supabase did not accept the session in the URL, so it was removed.');
    }
    replaceHash('');
  };

  /** supabase-js clears a fragment with `location.hash = ''`, which leaves "…/#" in the address bar. */
  const tidyEmptyFragment = () => {
    if (win.location.hash === '' && win.location.href.endsWith('#')) {
      replaceHash('');
    }
  };

  const setHeaderForLoading = () => {
    nav.replaceChildren();
    nav.hidden = true;
    logoutButton.hidden = true;
  };

  const show = (view, route, { moveFocus }) => {
    const details = VIEWS[view];
    const content = details.render({ doc: appRoot.ownerDocument, client, account, route, retry: refresh });
    if (details.memberLayout) {
      showInMemberLayout(appRoot, content);
    } else {
      appRoot.replaceChildren(content);
    }
    doc.title = details.title ? `${details.title}${TITLE_SEPARATOR}${SITE_NAME}` : SITE_NAME;
    if (moveFocus) {
      // After a click in the nav, take screen readers (and the scroll position) to the new page.
      content.querySelector('h1')?.focus();
    }
  };

  /** Shows the view for the current URL. Does nothing while the visitor is still being worked out. */
  const render = ({ moveFocus = false } = {}) => {
    if (stopped || loading) {
      return;
    }
    takeAuthCallbackFragment();
    tidyEmptyFragment();
    const route = parseRoute(win.location.hash);
    const { view, hash } = resolveView(route, account);
    if (hash !== null && hash !== win.location.hash) {
      replaceHash(hash);
    }
    renderNav(nav, route, account);
    logoutButton.hidden = !account.session;
    show(view, route, { moveFocus });
  };

  /** Works out who the visitor is (again), showing "Loading…" meanwhile, then renders. */
  async function refresh() {
    loadNumber += 1;
    const thisLoad = loadNumber;
    loading = true;
    setHeaderForLoading();
    show(VIEW.LOADING, null, { moveFocus: false });

    const next = await loadAccount(client, { loadMembership: membershipLoader });
    if (stopped || thisLoad !== loadNumber) {
      return;
    }
    account = next;
    loading = false;
    render();
  }

  const onHashChange = () => render({ moveFocus: true });

  const onAuthEvent = (event, session) => {
    if (!AUTH_EVENTS_THAT_CHANGE_WHO.has(event)) {
      return;
    }
    // supabase-js warns that calling it from inside this callback can deadlock,
    // so the reload runs just after.
    setTimeout(() => {
      if (stopped) {
        return;
      }
      const samePerson = (session?.user?.id ?? null) === (account?.session?.user?.id ?? null);
      // While a load is running, `account` may already be out of date, so reload to be sure.
      if (samePerson && !loading) {
        return;
      }
      refresh();
    }, 0);
  };

  const logOut = async () => {
    logoutButton.disabled = true;
    try {
      const { error } = await client.auth.signOut(SIGN_OUT_OPTIONS);
      if (error) {
        // supabase-js deletes the session from this browser even when the server call fails.
        console.warn("Log out: Supabase didn't confirm, but this browser is signed out.", error);
      }
    } catch (error) {
      console.error('Log out failed. Checking whether this browser is still signed in.', error);
    } finally {
      logoutButton.disabled = false;
    }
    replaceHash(''); // Start the next visit from the bare address.
    await refresh();
  };
  const onLogoutClick = () => {
    logOut();
  };

  await refresh();

  // Only now: the first view must come from getSession(), not from an event racing it.
  ({
    data: { subscription },
  } = client.auth.onAuthStateChange(onAuthEvent));
  win.addEventListener('hashchange', onHashChange);
  logoutButton.addEventListener('click', onLogoutClick);

  return {
    refresh,
    stop() {
      stopped = true;
      win.removeEventListener('hashchange', onHashChange);
      logoutButton.removeEventListener('click', onLogoutClick);
      subscription?.unsubscribe();
    },
    get account() {
      return account;
    },
    get callbackError() {
      return callbackError;
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Header                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Fills the header nav: Home, Rules, Profile (and Admin for the admin), with
 * aria-current="page" on the page showing. Empty and hidden for anyone who
 * isn't a member.
 *
 * @param {Element} nav  The <nav> (#site-nav).
 * @param {object} route  From parseRoute().
 * @param {object} account  From loadAccount().
 */
export function renderNav(nav, route, account) {
  const links = navLinks(route, account);
  const doc = nav.ownerDocument;
  if (links.length === 0) {
    nav.replaceChildren();
    nav.hidden = true;
    return;
  }
  const items = links.map((link) =>
    create(doc, 'li', {}, create(doc, 'a', { href: link.hash, 'aria-current': link.current ? 'page' : null }, link.label))
  );
  nav.replaceChildren(create(doc, 'ul', { class: 'site-nav-list' }, ...items));
  nav.hidden = false;
}

/* ------------------------------------------------------------------------- */
/* Views                                                                     */
/* ------------------------------------------------------------------------- */

/*
 * Each view's render function gets { doc, client, account, route, retry } and
 * returns one element marked with data-view. Text always goes in as text
 * nodes, never as HTML (util.js's createElement).
 *
 * Most are placeholders until their issue lands. To take one over, import the
 * feature module's render function and put it in VIEWS in place of the
 * placeholder.
 */

/** A page's main heading. tabindex="-1" lets the app move focus to it after navigation. */
function pageHeading(doc, text, attributes = {}) {
  return create(doc, 'h1', { tabindex: '-1', ...attributes }, text);
}

/** Visible marker for content a later issue builds. */
function placeholder(doc, what, issue) {
  return create(doc, 'p', { class: 'placeholder' }, `[Placeholder: ${what}, built in ${issue}]`);
}

function renderLoading({ doc }) {
  return create(doc, 'p', { class: 'app-status', role: 'status', 'data-view': VIEW.LOADING }, 'Loading…');
}

function renderRegistration({ doc }) {
  return create(
    doc,
    'section',
    { class: 'app-message', 'data-view': VIEW.REGISTRATION },
    pageHeading(doc, `Welcome to ${SITE_NAME}`),
    placeholder(doc, 'the registration form: name, RSVP and country', 'ISSUE-012')
  );
}

function renderNotInvited({ doc, account }) {
  const reason = account.state;
  const view = create(doc, 'section', { class: 'app-message', 'data-view': VIEW.NOT_INVITED, 'data-reason': reason });

  if (reason === ACCOUNT.DEACTIVATED) {
    view.append(
      pageHeading(doc, 'This account has been deactivated'),
      create(doc, 'p', {}, `The host has removed this account from ${SITE_NAME}. If you think that's a mistake, get in touch with them.`)
    );
    return view;
  }

  const email = account.session?.user?.email;
  const signedInAs = email
    ? create(doc, 'p', {}, "You're signed in as ", create(doc, 'strong', {}, email), `, but ${SITE_NAME} is invitation-only and that address hasn't been invited.`)
    : create(doc, 'p', {}, `You're signed in, but ${SITE_NAME} is invitation-only and this account hasn't been invited.`);
  view.append(
    pageHeading(doc, "You're not on the guest list"),
    signedInAs,
    create(doc, 'p', {}, 'If your invitation went to a different address, log out and sign in with that one. Otherwise, ask the host for an invitation.')
  );
  return view;
}

function renderUnavailable({ doc, retry }) {
  const tryAgain = create(doc, 'button', { type: 'button', class: 'app-message-button' }, 'Try again');
  tryAgain.addEventListener('click', () => {
    retry();
  });
  return create(
    doc,
    'section',
    { class: 'app-message', role: 'alert', 'data-view': VIEW.UNAVAILABLE },
    pageHeading(doc, `Can't reach ${SITE_NAME}`),
    create(doc, 'p', {}, 'Check your internet connection, then try again.'),
    tryAgain
  );
}

/** The dashboard: activity feed, then message board (SPEC § Logged-In View). */
function renderHome({ doc }) {
  const section = (id, heading, what, issue) =>
    create(
      doc,
      'section',
      { class: 'dashboard-section', id, 'aria-labelledby': `${id}-heading` },
      create(doc, 'h2', { id: `${id}-heading` }, heading),
      placeholder(doc, what, issue)
    );
  return create(
    doc,
    'div',
    { class: 'dashboard', 'data-view': VIEW.HOME },
    // The page has no visible title, but screen-reader users navigate by headings.
    pageHeading(doc, 'Dashboard', { class: 'visually-hidden' }),
    section('activity-feed', 'Activity', 'the activity feed', 'ISSUE-018'),
    section('message-board', 'Message board', 'the message board', 'ISSUE-016')
  );
}

/** A member page that is just a heading and a placeholder for now. */
function memberPage(view, heading, what, issue) {
  return ({ doc }) => create(doc, 'section', { class: 'page', 'data-view': view }, pageHeading(doc, heading), placeholder(doc, what, issue));
}

/**
 * Every view. `title` is the page name in <title> (null: just the site name).
 * `memberLayout` views render inside the shared layout with the sidebar.
 */
const VIEWS = Object.freeze({
  [VIEW.LOADING]: { title: null, memberLayout: false, render: renderLoading },
  [VIEW.LANDING]: { title: null, memberLayout: false, render: renderLanding }, // landing.js (ISSUE-010)
  [VIEW.REGISTRATION]: { title: 'Welcome', memberLayout: false, render: renderRegistration },
  [VIEW.NOT_INVITED]: { title: 'Not invited', memberLayout: false, render: renderNotInvited },
  [VIEW.UNAVAILABLE]: { title: "Can't connect", memberLayout: false, render: renderUnavailable },
  [VIEW.HOME]: { title: null, memberLayout: true, render: renderHome },
  [VIEW.RULES]: {
    title: 'Rules',
    memberLayout: true,
    render: memberPage(VIEW.RULES, 'Rules', 'the event rules and the link to the game list', 'ISSUE-019'),
  },
  [VIEW.PROFILE]: {
    title: 'Profile',
    memberLayout: true,
    render: memberPage(VIEW.PROFILE, 'Your profile', 'your name, country, flag and RSVP', 'ISSUE-014 and ISSUE-015'),
  },
  [VIEW.ADMIN]: {
    title: 'Admin',
    memberLayout: true,
    render: memberPage(VIEW.ADMIN, 'Admin', 'the admin panel', 'ISSUE-020'),
  },
});

/* ------------------------------------------------------------------------- */
/* Member layout                                                             */
/* ------------------------------------------------------------------------- */

/** Classes that mark the shared member layout and its page slot. */
const MEMBER_LAYOUT_CLASS = 'member-layout';
const MEMBER_PAGE_CLASS = 'member-page';

/**
 * Puts `content` in the member layout's page slot. The layout (and so the
 * sidebar) is built once and kept while the visitor moves between member pages.
 */
function showInMemberLayout(appRoot, content) {
  const existingPage = appRoot.querySelector(`:scope > .${MEMBER_LAYOUT_CLASS} > .${MEMBER_PAGE_CLASS}`);
  if (existingPage) {
    existingPage.replaceChildren(content);
    return;
  }
  const doc = appRoot.ownerDocument;
  // Built in full before insertion, so the page appears in one step.
  const layout = create(
    doc,
    'div',
    { class: MEMBER_LAYOUT_CLASS },
    create(
      doc,
      'aside',
      { class: 'sidebar', id: 'sidebar', 'aria-label': "This year's event" },
      placeholder(doc, 'the event date and this year\'s theme', 'ISSUE-013')
    ),
    create(doc, 'div', { class: MEMBER_PAGE_CLASS }, content)
  );
  appRoot.replaceChildren(layout);
}

/* ------------------------------------------------------------------------- */

// The test page (tests/index.html) imports app modules to test their functions,
// and marks itself with data-test-page so that importing never starts the real app.
const IS_TEST_PAGE = document.documentElement.hasAttribute('data-test-page');
if (!IS_TEST_PAGE) {
  const client = boot();
  if (client) {
    startApp({ client }).catch((error) => {
      // A bug: startApp() handles connection and sign-in failures itself.
      console.error('Board Game Olympics failed to start.', error);
    });
  }
}
