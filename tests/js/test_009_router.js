/**
 * tests/js/test_009_router.js: app shell, hash router and auth-state views
 * (ISSUE-009, ADR-023).
 *
 * Covers:
 *  1. public/js/router.js, the pure part: parseRoute, isAuthCallback,
 *     readAuthCallbackError, resolveView and navLinks.
 *  2. public/js/app.js, the part that touches the page: renderNav,
 *     loadMembership / loadAccount, and startApp driven end to end.
 *  3. public/index.html's header markup.
 *
 * startApp runs against fakes: a fake Supabase client (auth, rpc, from), a
 * fake window (location, history, hashchange) and real DOM elements for the
 * header and #app. Nothing touches the network or the test page's own URL.
 * Which views appeared, and in what order, is read from the real DOM with a
 * MutationObserver, so "never flashes the landing page" is checked on what
 * was actually inserted, not on what the code says it did.
 */

import { describe, it, assert, assertEqual, assertThrows } from '../harness.js';
import {
  ACCOUNT,
  HOME_HASH,
  PAGE,
  ROLE,
  VIEW,
  isAuthCallback,
  navLinks,
  parseRoute,
  readAuthCallbackError,
  resolveView,
} from '../../public/js/router.js';
import {
  LOGOUT_BUTTON_ID,
  NAV_ID,
  SITE_NAME,
  loadAccount,
  loadMembership,
  renderNav,
  startApp,
} from '../../public/js/app.js';

/** The repo root, as served by tests/run.sh. */
const REPO_ROOT = new URL('../../', import.meta.url);

/** Where the fake window starts: the site served locally at /public/, as in development. */
const SITE_URL = 'https://bgo.example/public/';

const AUTH_USER = Object.freeze({ id: '0b6f3c1e-1111-4a3b-9c1d-000000000001', email: 'alex@example.com' });
const OTHER_AUTH_USER = Object.freeze({ id: '0b6f3c1e-1111-4a3b-9c1d-000000000009', email: 'sam@example.com' });
const MEMBER_ID = '5d1c2b3a-2222-4c3d-8e9f-000000000002';
const MEMBER = Object.freeze({ id: MEMBER_ID, name: 'Alex', role: ROLE.USER });
const ADMIN = Object.freeze({ id: '5d1c2b3a-2222-4c3d-8e9f-000000000003', name: 'Robin', role: ROLE.ADMIN });

/** Every account state a signed-in visitor without membership can be in. */
const NON_MEMBER_STATES = [ACCOUNT.NEEDS_REGISTRATION, ACCOUNT.NOT_INVITED, ACCOUNT.DEACTIVATED];

/** Hashes covering every route, a sub-route, unknown routes and the empty hash. */
const EVERY_HASH = ['', '#', '#/', '#/rules', '#/profile', '#/admin', '#/admin/users', '#/nope', '#/rules/extra'];

/* ------------------------------------------------------------------------- */
/* Fakes and helpers                                                         */
/* ------------------------------------------------------------------------- */

function sessionFor(user = AUTH_USER) {
  return { access_token: 'access-token', refresh_token: 'refresh-token', user: { ...user } };
}

function member(profile = MEMBER, session = sessionFor()) {
  return { state: ACCOUNT.MEMBER, session, profile };
}

function signedIn(state, session = sessionFor()) {
  return { state, session };
}

const SIGNED_OUT = Object.freeze({ state: ACCOUNT.SIGNED_OUT, session: null });

/** A promise plus the functions that settle it. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks and zero-delay timers run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Swaps console[method] for a recorder while `fn` runs. Returns the recorded calls. */
async function captureConsole(method, fn) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => calls.push(args);
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return calls;
}

/**
 * A stand-in for the supabase-js client, with just what app.js uses:
 *   auth.getSession, auth.signOut, auth.onAuthStateChange, rpc, from(...).select().eq().maybeSingle().
 * `calls` records every call in order. `emit(event, session)` plays an auth
 * event to subscribers, as supabase-js does.
 *
 * Like the real client:
 *   - onAuthStateChange sends INITIAL_SESSION soon after subscribing;
 *   - signOut removes the session and emits SIGNED_OUT before it resolves,
 *     even when the server call fails (supabase-js 2.118, scope "global").
 */
function createFakeClient({
  session = null,
  getSessionError = null,
  getSessionGate = null,
  onGetSession = null,
  memberId = null,
  rpcResults = null,
  profile = undefined,
  profileError = null,
  signOutGate = null,
  signOutError = null,
  signOutThrows = null,
} = {}) {
  let currentSession = session;
  const listeners = new Set();
  const calls = [];
  const queuedRpcResults = rpcResults ? [...rpcResults] : null;
  // holdGetSession() queues a gate for the next getSession() call, so a test can finish loads out of order.
  const holds = [];

  const emit = (event, nextSession) => {
    currentSession = nextSession;
    for (const listener of [...listeners]) {
      listener(event, nextSession);
    }
  };

  return {
    calls,
    emit,
    get listenerCount() {
      return listeners.size;
    },
    holdGetSession() {
      const hold = deferred();
      holds.push(hold);
      return hold;
    },
    auth: {
      async getSession() {
        calls.push(['getSession']);
        const hold = holds.shift();
        // The session as it is when called, so loads finished out of order return what they saw.
        const snapshot = currentSession;
        await onGetSession?.();
        await getSessionGate;
        await hold?.promise;
        return { data: { session: snapshot }, error: getSessionError };
      },
      async signOut(options) {
        calls.push(['signOut', options]);
        await signOutGate;
        if (signOutThrows) {
          throw signOutThrows;
        }
        emit('SIGNED_OUT', null);
        return { error: signOutError };
      },
      onAuthStateChange(callback) {
        listeners.add(callback);
        queueMicrotask(() => callback('INITIAL_SESSION', currentSession));
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
    },
    // Like supabase-js, rpc() returns a builder that can be awaited or narrowed with maybeSingle().
    // get_public_event_info (the landing page's date, ISSUE-010) answers "no event yet".
    rpc(name, args) {
      calls.push(['rpc', name, args]);
      let result;
      const settle = () => {
        if (result === undefined) {
          if (name === 'get_public_event_info') {
            result = { data: null, error: null };
          } else {
            result = queuedRpcResults && queuedRpcResults.length > 0 ? queuedRpcResults.shift() : { data: memberId, error: null };
          }
        }
        return Promise.resolve(result);
      };
      return {
        then: (resolve, reject) => settle().then(resolve, reject),
        maybeSingle: () => settle(),
      };
    },
    from(table) {
      const steps = [];
      calls.push(['from', table, steps]);
      const builder = {
        select(columns) {
          steps.push(['select', columns]);
          return builder;
        },
        eq(column, value) {
          steps.push(['eq', column, value]);
          return builder;
        },
        maybeSingle() {
          steps.push(['maybeSingle']);
          if (profileError) {
            return Promise.resolve({ data: null, error: profileError });
          }
          return Promise.resolve({ data: profile === undefined ? null : profile, error: null });
        },
      };
      return builder;
    },
  };
}

function callNames(client) {
  return client.calls.map((call) => (call[0] === 'rpc' ? `rpc:${call[1]}` : call[0] === 'from' ? `from:${call[1]}` : call[0]));
}

/**
 * A stand-in for `window` with what app.js uses: location (hash, pathname,
 * search, href), history.replaceState, and add/removeEventListener.
 * Behaves like a browser:
 *   - replaceState changes the URL without a hashchange event;
 *   - navigate(hash) changes it and fires hashchange, like clicking a link;
 *   - clearHashLikeSupabase() does what supabase-js's `location.hash = ''`
 *     does: the fragment empties but the URL keeps a trailing "#".
 */
function createFakeWindow(url = SITE_URL) {
  let current = new URL(url);
  const listeners = new Map();
  const replaced = [];

  const fire = (type) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener(new Event(type));
    }
  };

  return {
    replaced,
    location: {
      get hash() {
        return current.hash;
      },
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
      get href() {
        return current.href;
      },
    },
    history: {
      state: null,
      replaceState(state, unused, next) {
        replaced.push(String(next));
        current = new URL(next, current);
      },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    navigate(hash) {
      current = new URL(hash, current);
      fire('hashchange');
    },
    clearHashLikeSupabase() {
      current = new URL(`${current.href.split('#')[0]}#`);
      fire('hashchange');
    },
  };
}

/**
 * The header and #app as index.html has them, attached to the test page so
 * focus can move. `remove()` takes them off again.
 */
function createShell() {
  const container = document.createElement('div');
  const header = document.createElement('header');
  const nav = document.createElement('nav');
  nav.id = `test-${NAV_ID}`;
  nav.hidden = true;
  const logoutButton = document.createElement('button');
  logoutButton.type = 'button';
  logoutButton.hidden = true;
  logoutButton.textContent = 'Log out';
  header.append(nav, logoutButton);
  const appRoot = document.createElement('main');
  appRoot.textContent = 'Loading…';
  container.append(header, appRoot);
  document.body.append(container);
  return { nav, logoutButton, appRoot, remove: () => container.remove() };
}

/** Records the data-view of every view element inserted into `root`, in order. */
function recordViews(root) {
  const seen = [];
  const take = (records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        const views = [node, ...node.querySelectorAll('[data-view]')].filter((element) => element.dataset.view);
        seen.push(...views.map((element) => element.dataset.view));
      }
    }
  };
  const observer = new MutationObserver(take);
  observer.observe(root, { childList: true, subtree: true });
  return {
    views() {
      take(observer.takeRecords());
      return [...seen];
    },
    stop: () => observer.disconnect(),
  };
}

/** The view currently showing in #app: the data-view of the page, not the layout around it. */
function currentView(appRoot) {
  const views = appRoot.querySelectorAll('[data-view]');
  return views.length === 1 ? views[0].dataset.view : `(${views.length} views)`;
}

function navState(nav) {
  return [...nav.querySelectorAll('a')].map((link) => ({
    label: link.textContent,
    href: link.getAttribute('href'),
    current: link.getAttribute('aria-current'),
  }));
}

/**
 * Starts the app against fakes. Returns everything a test needs to poke at;
 * always call `cleanup()` (in a finally).
 */
async function launch({ client, url = SITE_URL, win = createFakeWindow(url), loadMembership: membershipLoader } = {}) {
  const shell = createShell();
  const doc = { title: 'before' };
  const recorder = recordViews(shell.appRoot);
  const options = { client, appRoot: shell.appRoot, nav: shell.nav, logoutButton: shell.logoutButton, win, doc };
  if (membershipLoader) {
    options.loadMembership = membershipLoader;
  }
  let app = null;
  const cleanup = () => {
    app?.stop();
    recorder.stop();
    shell.remove();
  };
  try {
    const starting = startApp(options);
    return {
      shell,
      win,
      doc,
      recorder,
      cleanup,
      starting,
      async ready() {
        app = await starting;
        return app;
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Like launch(), but waits for the first render. */
async function launched(options) {
  const run = await launch(options);
  try {
    run.app = await run.ready();
  } catch (error) {
    run.cleanup();
    throw error;
  }
  return run;
}

async function readRepoFile(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `fetch ${path}: HTTP ${response.status}`);
  return response.text();
}

/* ------------------------------------------------------------------------- */
/* 1. router.js                                                              */
/* ------------------------------------------------------------------------- */

describe('router: parseRoute', () => {
  it('reads #/, #/rules, #/profile and #/admin', () => {
    assertEqual(parseRoute('#/'), { page: PAGE.HOME, subpath: [], known: true });
    assertEqual(parseRoute('#/rules'), { page: PAGE.RULES, subpath: [], known: true });
    assertEqual(parseRoute('#/profile'), { page: PAGE.PROFILE, subpath: [], known: true });
    assertEqual(parseRoute('#/admin'), { page: PAGE.ADMIN, subpath: [], known: true });
  });

  it('an empty hash, or a bare "#", is home', () => {
    assertEqual(parseRoute(''), { page: PAGE.HOME, subpath: [], known: true });
    assertEqual(parseRoute('#'), { page: PAGE.HOME, subpath: [], known: true });
  });

  it('accepts a trailing slash', () => {
    assertEqual(parseRoute('#/rules/'), { page: PAGE.RULES, subpath: [], known: true });
  });

  it('keeps admin sub-routes (#/admin/users) for the admin panel to use', () => {
    assertEqual(parseRoute('#/admin/users'), { page: PAGE.ADMIN, subpath: ['users'], known: true });
  });

  it('anything else is an unknown route, which goes home', () => {
    for (const hash of ['#/nope', '#/rules/extra', '#/Rules', '#rules', '#/home', '#//rules', '#/profile?x=1', '#/admin//users']) {
      assertEqual(parseRoute(hash), { page: PAGE.HOME, subpath: [], known: false }, hash);
    }
  });

  it('an auth callback fragment is never a route', () => {
    assertEqual(parseRoute('#access_token=abc&refresh_token=def'), { page: PAGE.HOME, subpath: [], known: false });
  });
});

describe('router: auth callback fragments', () => {
  it('identifies hashes starting #access_token, #refresh_token and #error', () => {
    assert(isAuthCallback('#access_token=eyJabc&expires_in=3600&refresh_token=r1&token_type=bearer&type=magiclink'));
    assert(isAuthCallback('#refresh_token=r1'));
    assert(isAuthCallback('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid'));
  });

  it('finds the parameters in any order, and error_code or error_description alone', () => {
    assert(isAuthCallback('#expires_at=1&expires_in=3600&access_token=eyJabc'));
    assert(isAuthCallback('#error_code=otp_expired'));
    assert(isAuthCallback('#error_description=Something+went+wrong'));
  });

  it('routes and ordinary fragments are not auth callbacks', () => {
    for (const hash of ['', '#', '#/', '#/rules', '#/admin/users', '#/error=x', '#top', '#access_tokens=x']) {
      assert(!isAuthCallback(hash), hash);
    }
  });

  it('readAuthCallbackError returns the error, its code and its description, decoded', () => {
    assertEqual(
      readAuthCallbackError('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'),
      { error: 'access_denied', code: 'otp_expired', description: 'Email link is invalid or has expired' }
    );
    assertEqual(readAuthCallbackError('#error_code=bad_oauth_state'), { error: null, code: 'bad_oauth_state', description: null });
  });

  it('readAuthCallbackError returns null for a successful sign-in and for routes', () => {
    assertEqual(readAuthCallbackError('#access_token=eyJabc&refresh_token=r1'), null);
    assertEqual(readAuthCallbackError('#/rules'), null);
    assertEqual(readAuthCallbackError(''), null);
  });
});

describe('router: resolveView', () => {
  it('logged out × every route → landing', () => {
    for (const hash of EVERY_HASH) {
      assertEqual(resolveView(parseRoute(hash), SIGNED_OUT).view, VIEW.LANDING, hash);
    }
  });

  it('signed in without a profile → registration, or the not-invited view, on every route', () => {
    for (const hash of EVERY_HASH) {
      assertEqual(resolveView(parseRoute(hash), signedIn(ACCOUNT.NEEDS_REGISTRATION)).view, VIEW.REGISTRATION, hash);
      assertEqual(resolveView(parseRoute(hash), signedIn(ACCOUNT.NOT_INVITED)).view, VIEW.NOT_INVITED, hash);
      assertEqual(resolveView(parseRoute(hash), signedIn(ACCOUNT.DEACTIVATED)).view, VIEW.NOT_INVITED, hash);
    }
  });

  it("couldn't reach Supabase → the unavailable view, on every route", () => {
    for (const hash of EVERY_HASH) {
      assertEqual(resolveView(parseRoute(hash), { state: ACCOUNT.UNAVAILABLE, session: null }).view, VIEW.UNAVAILABLE, hash);
    }
  });

  it('a member gets the page they asked for', () => {
    assertEqual(resolveView(parseRoute('#/'), member()), { view: VIEW.HOME, hash: null });
    assertEqual(resolveView(parseRoute('#/rules'), member()), { view: VIEW.RULES, hash: null });
    assertEqual(resolveView(parseRoute('#/profile'), member()), { view: VIEW.PROFILE, hash: null });
  });

  it('a member on #/admin → home, and the address bar is corrected to #/', () => {
    assertEqual(resolveView(parseRoute('#/admin'), member()), { view: VIEW.HOME, hash: HOME_HASH });
    assertEqual(resolveView(parseRoute('#/admin/users'), member()), { view: VIEW.HOME, hash: HOME_HASH });
  });

  it('an admin on #/admin, or one of its sub-routes → admin', () => {
    assertEqual(resolveView(parseRoute('#/admin'), member(ADMIN)), { view: VIEW.ADMIN, hash: null });
    assertEqual(resolveView(parseRoute('#/admin/users'), member(ADMIN)), { view: VIEW.ADMIN, hash: null });
  });

  it('#/nope → home, corrected to #/; an empty hash → home, left as it is', () => {
    assertEqual(resolveView(parseRoute('#/nope'), member()), { view: VIEW.HOME, hash: HOME_HASH });
    assertEqual(resolveView(parseRoute(''), member()), { view: VIEW.HOME, hash: null });
    assertEqual(resolveView(parseRoute('#/nope'), member(ADMIN)), { view: VIEW.HOME, hash: HOME_HASH });
  });

  it('corrects an unknown route to #/ whoever is looking, and leaves known routes alone', () => {
    assertEqual(resolveView(parseRoute('#/nope'), SIGNED_OUT), { view: VIEW.LANDING, hash: HOME_HASH });
    assertEqual(resolveView(parseRoute('#/rules'), SIGNED_OUT), { view: VIEW.LANDING, hash: null });
    for (const state of NON_MEMBER_STATES) {
      assertEqual(resolveView(parseRoute('#/nope'), signedIn(state)).hash, HOME_HASH, state);
      assertEqual(resolveView(parseRoute('#/profile'), signedIn(state)).hash, null, state);
    }
  });

  it('an unrecognised account state is a bug, and throws', () => {
    assertThrows(() => resolveView(parseRoute('#/'), { state: 'banana', session: null }), TypeError);
    assertThrows(() => resolveView(parseRoute('#/'), null), TypeError);
    assertThrows(() => resolveView(parseRoute('#/admin'), member({ ...MEMBER, role: 'superuser' })), TypeError);
  });
});

describe('router: navLinks', () => {
  it('a member gets Home, Rules and Profile, with the current page marked', () => {
    assertEqual(navLinks(parseRoute('#/rules'), member()), [
      { hash: '#/', label: 'Home', current: false },
      { hash: '#/rules', label: 'Rules', current: true },
      { hash: '#/profile', label: 'Profile', current: false },
    ]);
  });

  it('an admin also gets Admin, which stays current on its sub-routes', () => {
    const links = navLinks(parseRoute('#/admin/users'), member(ADMIN));
    assertEqual(links.map((link) => link.label), ['Home', 'Rules', 'Profile', 'Admin']);
    assertEqual(links.filter((link) => link.current).map((link) => link.label), ['Admin']);
  });

  it('an empty hash and an unknown route both mark Home', () => {
    for (const hash of ['', '#/nope']) {
      assertEqual(navLinks(parseRoute(hash), member()).filter((link) => link.current).map((link) => link.label), ['Home'], hash);
    }
  });

  it('a member on #/admin (about to be sent home) gets no Admin link, and Home is marked', () => {
    const links = navLinks(parseRoute('#/admin'), member());
    assertEqual(links.map((link) => link.label), ['Home', 'Rules', 'Profile']);
    assertEqual(links.filter((link) => link.current).map((link) => link.label), ['Home']);
  });

  it('anyone who is not a member gets no links', () => {
    assertEqual(navLinks(parseRoute('#/'), SIGNED_OUT), []);
    for (const state of [...NON_MEMBER_STATES, ACCOUNT.UNAVAILABLE]) {
      assertEqual(navLinks(parseRoute('#/'), signedIn(state)), [], state);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 2. app.js                                                                 */
/* ------------------------------------------------------------------------- */

describe('app: renderNav', () => {
  it('marks the active route with aria-current="page", and only that one', () => {
    const nav = document.createElement('nav');
    nav.hidden = true;
    renderNav(nav, parseRoute('#/rules'), member());

    assertEqual(navState(nav), [
      { label: 'Home', href: '#/', current: null },
      { label: 'Rules', href: '#/rules', current: 'page' },
      { label: 'Profile', href: '#/profile', current: null },
    ]);
    assertEqual(nav.hidden, false);
  });

  it('moves the mark when the route changes, without duplicating links', () => {
    const nav = document.createElement('nav');
    renderNav(nav, parseRoute('#/rules'), member(ADMIN));
    renderNav(nav, parseRoute('#/admin/theme'), member(ADMIN));

    assertEqual(navState(nav).map((link) => link.label), ['Home', 'Rules', 'Profile', 'Admin']);
    assertEqual(navState(nav).filter((link) => link.current === 'page').map((link) => link.label), ['Admin']);
  });

  it('is emptied and hidden for anyone who is not a member', () => {
    const nav = document.createElement('nav');
    renderNav(nav, parseRoute('#/'), member());
    renderNav(nav, parseRoute('#/'), signedIn(ACCOUNT.NOT_INVITED));
    assertEqual(nav.children.length, 0);
    assertEqual(nav.hidden, true);
  });
});

describe('app: loadMembership and loadAccount', () => {
  it('asks current_member_id, then reads that profile\'s id, name and role', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });

    const membership = await loadMembership(client, sessionFor());

    assertEqual(membership, { state: ACCOUNT.MEMBER, profile: MEMBER });
    assertEqual(client.calls, [
      ['rpc', 'current_member_id', undefined],
      ['from', 'users', [['select', 'id, name, role'], ['eq', 'id', MEMBER_ID], ['maybeSingle']]],
    ]);
  });

  it('no linked profile → not invited, without reading users', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: null });
    assertEqual(await loadMembership(client, sessionFor()), { state: ACCOUNT.NOT_INVITED, profile: null });
    assertEqual(callNames(client), ['rpc:current_member_id']);
  });

  it('a profile that RLS hides (deactivated in between) → not invited', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: null });
    assertEqual(await loadMembership(client, sessionFor()), { state: ACCOUNT.NOT_INVITED, profile: null });
  });

  it('a database error is thrown, not mistaken for "not invited"', async () => {
    const failure = { message: 'TypeError: Failed to fetch', code: '' };
    for (const client of [
      createFakeClient({ session: sessionFor(), rpcResults: [{ data: null, error: failure }] }),
      createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profileError: failure }),
    ]) {
      let thrown = null;
      try {
        await loadMembership(client, sessionFor());
      } catch (error) {
        thrown = error;
      }
      assert(thrown === failure, `the PostgREST error is thrown as it came (after ${callNames(client).join(', ')})`);
    }
  });

  it('loadAccount: no session → signed out, without touching the database', async () => {
    const client = createFakeClient();
    assertEqual(await loadAccount(client), { state: ACCOUNT.SIGNED_OUT, session: null });
    assertEqual(callNames(client), ['getSession']);
  });

  it('loadAccount: a session → the membership, with the session attached', async () => {
    const session = sessionFor();
    const client = createFakeClient({ session, memberId: MEMBER_ID, profile: MEMBER });
    const account = await loadAccount(client);
    assertEqual(account.state, ACCOUNT.MEMBER);
    assertEqual(account.profile, MEMBER);
    assert(account.session === session, 'the session from getSession');
  });

  it('loadAccount: a membership that fails to load → unavailable (logged), not signed out', async () => {
    const client = createFakeClient({ session: sessionFor(), rpcResults: [{ data: null, error: { message: 'Failed to fetch' } }] });
    let account;
    const errors = await captureConsole('error', async () => {
      account = await loadAccount(client);
    });
    assertEqual(account.state, ACCOUNT.UNAVAILABLE);
    assert(account.session !== null, 'still knows there is a session, so logout stays available');
    assertEqual(errors.length, 1);
  });

  it("loadAccount: getSession couldn't reach Supabase to refresh → unavailable, not the landing page", async () => {
    const offline = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
    const client = createFakeClient({ getSessionError: offline });
    let account;
    const warnings = await captureConsole('warn', async () => {
      account = await loadAccount(client);
    });
    assertEqual(account, { state: ACCOUNT.UNAVAILABLE, session: null });
    assertEqual(warnings.length, 1);
  });

  it('loadAccount: any other getSession error (session revoked) → signed out, with a warning', async () => {
    const revoked = Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError', status: 400 });
    const client = createFakeClient({ getSessionError: revoked });
    let account;
    const warnings = await captureConsole('warn', async () => {
      account = await loadAccount(client);
    });
    assertEqual(account, { state: ACCOUNT.SIGNED_OUT, session: null });
    assertEqual(warnings.length, 1);
  });

  it('loadAccount: a custom membership loader (ISSUE-012\'s claim) is used in place of the default', async () => {
    const session = sessionFor();
    const client = createFakeClient({ session });
    const seen = [];
    const account = await loadAccount(client, {
      loadMembership: async (givenClient, givenSession) => {
        seen.push([givenClient, givenSession]);
        return { state: ACCOUNT.NEEDS_REGISTRATION, profile: null };
      },
    });
    assertEqual(account.state, ACCOUNT.NEEDS_REGISTRATION);
    assert(seen.length === 1 && seen[0][0] === client && seen[0][1] === session, 'called once with the client and session');
    assertEqual(callNames(client), ['getSession']);
  });
});

describe('app: startApp', () => {
  it('shows a loading state until the session resolves, then the page: never a flash of the landing page', async () => {
    const gate = deferred();
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER, getSessionGate: gate.promise });
    const run = await launch({ client, url: `${SITE_URL}#/rules` });
    try {
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.LOADING);
      assert(run.shell.appRoot.querySelector('[role="status"]'), 'the loading message is a status for screen readers');
      assertEqual(run.shell.nav.hidden, true, 'no nav until we know who this is');
      assertEqual(run.shell.logoutButton.hidden, true);

      gate.resolve();
      await run.ready();

      assertEqual(currentView(run.shell.appRoot), VIEW.RULES);
      assertEqual(run.recorder.views(), [VIEW.LOADING, VIEW.RULES], 'loading, then the page, and nothing in between');
    } finally {
      run.cleanup();
    }
  });

  it('logged out: the landing page on every route, with no nav, no logout, and no query but the public date', async () => {
    for (const hash of EVERY_HASH) {
      const client = createFakeClient();
      const run = await launched({ client, url: `${SITE_URL}${hash}` });
      try {
        assertEqual(currentView(run.shell.appRoot), VIEW.LANDING, hash);
        assertEqual(callNames(client), ['getSession', 'rpc:get_public_event_info'], `${hash}: the session, then the landing page's date (ISSUE-010)`);
        assertEqual(run.shell.nav.hidden, true, hash);
        assertEqual(run.shell.logoutButton.hidden, true, hash);
        assertEqual(run.doc.title, SITE_NAME, hash);
      } finally {
        run.cleanup();
      }
    }
  });

  it('waits for Supabase to consume an #access_token fragment, and never touches the URL before it has', async () => {
    const fragment = '#access_token=eyJabc&expires_in=3600&refresh_token=r1&token_type=bearer&type=magiclink';
    const win = createFakeWindow(`${SITE_URL}?invite=abc${fragment}`);
    const seenBySupabase = [];
    const client = createFakeClient({
      session: sessionFor(),
      memberId: MEMBER_ID,
      profile: MEMBER,
      onGetSession: async () => {
        // supabase-js reads the URL during initialize(), which getSession() waits for.
        await settle();
        seenBySupabase.push({ href: win.location.href, replacedSoFar: win.replaced.length });
        win.clearHashLikeSupabase();
      },
    });
    const run = await launch({ client, win });
    try {
      await run.ready();
      assertEqual(seenBySupabase.length, 1);
      assert(seenBySupabase[0].href.endsWith(fragment), 'the fragment was still there for Supabase to read');
      assertEqual(seenBySupabase[0].replacedSoFar, 0, 'and the app had not rewritten the URL');
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME);
      assertEqual(run.win.location.href, `${SITE_URL}?invite=abc`, 'the leftover "#" is tidied away; the query string is kept');
      assert(!run.recorder.views().includes(VIEW.LANDING), 'never showed the landing page');
    } finally {
      run.cleanup();
    }
  });

  it('an #error fragment that Supabase leaves behind is removed, kept for the login screen, and never treated as a route', async () => {
    const client = createFakeClient();
    let run;
    const warnings = await captureConsole('warn', async () => {
      run = await launched({
        client,
        url: `${SITE_URL}?invite=abc#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
      });
    });
    try {
      assertEqual(run.win.location.href, `${SITE_URL}?invite=abc`);
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING);
      assertEqual(run.app.callbackError, {
        error: 'access_denied',
        code: 'otp_expired',
        description: 'Email link is invalid or has expired',
      });
      assertEqual(warnings.length, 1, 'the error is logged');
    } finally {
      run.cleanup();
    }
  });

  it('an auth fragment arriving later by hashchange is removed (with a warning), not routed', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      const warnings = await captureConsole('warn', () => {
        run.win.navigate('#access_token=eyJabc&refresh_token=r1');
      });
      assertEqual(run.win.location.href, SITE_URL);
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME);
      assert(!run.win.replaced.some((url) => url.includes('access_token')), 'never wrote the token back into the URL');
      assertEqual(warnings.length, 1);
      assert(!String(warnings[0]).includes('eyJabc'), 'the token itself is never logged');
      assertEqual(run.app.callbackError, null, 'not a sign-in error for the login screen');
    } finally {
      run.cleanup();
    }
  });

  it('an #access_token that Supabase refused at start-up is removed with a warning, and the visitor is signed out', async () => {
    const client = createFakeClient();
    let run;
    const warnings = await captureConsole('warn', async () => {
      run = await launched({ client, url: `${SITE_URL}?invite=abc#access_token=stale&expires_in=3600&refresh_token=r1&token_type=bearer` });
    });
    try {
      assertEqual(run.win.location.href, `${SITE_URL}?invite=abc`);
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING);
      assertEqual(warnings.length, 1);
    } finally {
      run.cleanup();
    }
  });

  it('a member on an unknown route is sent to #/', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}?invite=abc#/nope` });
    try {
      assertEqual(run.win.location.href, `${SITE_URL}?invite=abc#/`);
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME);
      assertEqual(navState(run.shell.nav).filter((link) => link.current).map((link) => link.label), ['Home']);
    } finally {
      run.cleanup();
    }
  });

  it('a member who is not an admin is sent from #/admin to home', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/admin/users` });
    try {
      assertEqual(run.win.location.hash, HOME_HASH);
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME);
      assert(!run.recorder.views().includes(VIEW.ADMIN), 'the admin view was never drawn');
    } finally {
      run.cleanup();
    }
  });

  it('an admin gets #/admin, with Admin marked in the nav', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: ADMIN.id, profile: ADMIN });
    const run = await launched({ client, url: `${SITE_URL}#/admin` });
    try {
      assertEqual(currentView(run.shell.appRoot), VIEW.ADMIN);
      assertEqual(navState(run.shell.nav).find((link) => link.current === 'page')?.label, 'Admin');
      assertEqual(run.doc.title, `Admin · ${SITE_NAME}`);
    } finally {
      run.cleanup();
    }
  });

  it('member pages share one layout with a sidebar; navigating swaps only the page, moves focus to its heading and sets the title', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client });
    try {
      const { appRoot, nav } = run.shell;
      const sidebar = appRoot.querySelector('aside');
      assert(sidebar, 'the home page has the sidebar slot');
      assertEqual(run.doc.title, SITE_NAME);

      run.win.navigate('#/profile');

      assertEqual(currentView(appRoot), VIEW.PROFILE);
      assert(appRoot.querySelector('aside') === sidebar, 'the same sidebar: the layout was kept');
      assertEqual(navState(nav).find((link) => link.current === 'page')?.label, 'Profile');
      assertEqual(run.doc.title, `Profile · ${SITE_NAME}`);
      const heading = appRoot.querySelector('[data-view] h1');
      assert(heading && document.activeElement === heading, 'focus moved to the new page\'s heading');
      assertEqual(callNames(client).filter((name) => name === 'getSession').length, 1, 'navigation does not reload the session');

      run.win.navigate('#/');
      assertEqual(currentView(appRoot), VIEW.HOME);
      assert(appRoot.querySelector('aside') === sidebar);
    } finally {
      run.cleanup();
    }
  });

  it('the first page load does not move focus', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const before = document.activeElement;
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      assert(document.activeElement === before, 'focus stays where the browser put it');
    } finally {
      run.cleanup();
    }
  });

  it('logout is available on every member page and on the signed-in, non-member views', async () => {
    for (const hash of ['#/', '#/rules', '#/profile']) {
      const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
      const run = await launched({ client, url: `${SITE_URL}${hash}` });
      try {
        assertEqual(run.shell.logoutButton.hidden, false, hash);
      } finally {
        run.cleanup();
      }
    }
    for (const state of NON_MEMBER_STATES) {
      const client = createFakeClient({ session: sessionFor() });
      const run = await launched({ client, loadMembership: async () => ({ state, profile: null }) });
      try {
        assertEqual(run.shell.logoutButton.hidden, false, state);
        assertEqual(run.shell.nav.hidden, true, `${state}: no nav to pages they can't open`);
      } finally {
        run.cleanup();
      }
    }
  });

  it('logout signs out, then shows the landing page with no nav, logout or route in the URL', async () => {
    const gate = deferred();
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER, signOutGate: gate.promise });
    const run = await launched({ client, url: `${SITE_URL}?invite=abc#/profile` });
    try {
      const { logoutButton, nav, appRoot } = run.shell;
      logoutButton.click();
      await settle();
      assertEqual(logoutButton.disabled, true, 'disabled while signing out, so it can\'t be clicked twice');
      assertEqual(
        client.calls.filter((call) => call[0] === 'signOut'),
        [['signOut', { scope: 'local' }]],
        'signs out once, of this browser only (not every device: ADR-023)'
      );

      gate.resolve();
      await settle();
      await settle();

      assertEqual(currentView(appRoot), VIEW.LANDING);
      assertEqual(nav.hidden, true);
      assertEqual(logoutButton.hidden, true);
      assertEqual(logoutButton.disabled, false, 'ready for next time');
      assertEqual(run.win.location.href, `${SITE_URL}?invite=abc`);
    } finally {
      run.cleanup();
    }
  });

  it('logout still lands on the landing page when the server call fails (supabase-js has already dropped the session)', async () => {
    const client = createFakeClient({
      session: sessionFor(),
      memberId: MEMBER_ID,
      profile: MEMBER,
      signOutError: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }),
    });
    const run = await launched({ client });
    try {
      const warnings = await captureConsole('warn', async () => {
        run.shell.logoutButton.click();
        await settle();
        await settle();
      });
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING);
      assertEqual(warnings.length, 1, 'the failure is logged');
    } finally {
      run.cleanup();
    }
  });

  it('if signing out throws, the session is read again rather than assumed gone', async () => {
    const client = createFakeClient({
      session: sessionFor(),
      memberId: MEMBER_ID,
      profile: MEMBER,
      signOutThrows: new TypeError('a bug or a network failure supabase-js did not catch'),
    });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      const errors = await captureConsole('error', async () => {
        run.shell.logoutButton.click();
        await settle();
        await settle();
      });
      assertEqual(errors.length, 1, 'logged');
      assertEqual(callNames(client).filter((name) => name === 'getSession').length, 2, 'the session was checked again');
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME, 'still signed in, so still a member page');
      assertEqual(run.shell.logoutButton.hidden, false);
      assertEqual(run.shell.logoutButton.disabled, false, 'and Log out can be tried again');
    } finally {
      run.cleanup();
    }
  });

  it('while the visitor is being worked out again, the header is cleared and a hashchange draws nothing stale', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      const hold = client.holdGetSession();
      client.emit('SIGNED_IN', sessionFor(OTHER_AUTH_USER));
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.LOADING);
      assertEqual(run.shell.nav.hidden, true, 'no nav for someone we are not sure of');
      assertEqual(run.shell.logoutButton.hidden, true);

      run.win.navigate('#/profile');
      assertEqual(currentView(run.shell.appRoot), VIEW.LOADING, 'still loading: the old account is not used to draw the page');

      hold.resolve();
      await settle();
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.PROFILE, 'then the page for the new hash');
      assertEqual(run.recorder.views(), [VIEW.LOADING, VIEW.RULES, VIEW.LOADING, VIEW.PROFILE]);
    } finally {
      run.cleanup();
    }
  });

  it('when two reloads overlap, the newer one wins even if the older one finishes last', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      const older = client.holdGetSession();
      client.emit('SIGNED_IN', sessionFor(OTHER_AUTH_USER));
      await settle();
      const newer = client.holdGetSession();
      client.emit('SIGNED_OUT', null);
      await settle();

      newer.resolve();
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING);

      older.resolve(); // still sees the other person's session
      await settle();
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING, 'the stale result was dropped');
      assertEqual(run.shell.nav.hidden, true);
    } finally {
      run.cleanup();
    }
  });

  it('Supabase signing the visitor out (session expired or revoked) shows the landing page', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      client.emit('SIGNED_OUT', null);
      await settle();
      await settle();
      assertEqual(currentView(run.shell.appRoot), VIEW.LANDING);
      assertEqual(run.shell.nav.hidden, true);
    } finally {
      run.cleanup();
    }
  });

  it('SIGNED_IN or TOKEN_REFRESHED for the same person changes nothing; SIGNED_IN for someone else reloads', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      await settle(); // INITIAL_SESSION, which the app ignores
      client.emit('SIGNED_IN', sessionFor());
      client.emit('TOKEN_REFRESHED', sessionFor());
      await settle();
      await settle();
      assertEqual(callNames(client).filter((name) => name === 'rpc:current_member_id').length, 1, 'no reload');
      assertEqual(run.recorder.views(), [VIEW.LOADING, VIEW.RULES]);

      client.emit('SIGNED_IN', sessionFor(OTHER_AUTH_USER));
      await settle();
      await settle();
      assertEqual(callNames(client).filter((name) => name === 'rpc:current_member_id').length, 2, 'reloaded for the new person');
      assertEqual(currentView(run.shell.appRoot), VIEW.RULES);
    } finally {
      run.cleanup();
    }
  });

  it('signed in without a profile: the not-invited view names the account, as text', async () => {
    const email = 'alex+<img src=x onerror="window.__xss=1">@example.com';
    const client = createFakeClient({ session: sessionFor({ ...AUTH_USER, email }), memberId: null });
    const run = await launched({ client, url: `${SITE_URL}#/rules` });
    try {
      const view = run.shell.appRoot.querySelector('[data-view]');
      assertEqual(view.dataset.view, VIEW.NOT_INVITED);
      assertEqual(view.dataset.reason, ACCOUNT.NOT_INVITED);
      assert(view.textContent.includes(email), 'shows which account is signed in');
      assertEqual(view.querySelector('img'), null, 'as text, never HTML');
      assertEqual(run.win.location.hash, '#/rules', 'a known route is left alone for after they sign in properly');
    } finally {
      run.cleanup();
    }
  });

  it('deactivated: the not-invited view, with its own reason', async () => {
    const client = createFakeClient({ session: sessionFor() });
    const run = await launched({ client, loadMembership: async () => ({ state: ACCOUNT.DEACTIVATED, profile: null }) });
    try {
      const view = run.shell.appRoot.querySelector('[data-view]');
      assertEqual(view.dataset.view, VIEW.NOT_INVITED);
      assertEqual(view.dataset.reason, ACCOUNT.DEACTIVATED);
    } finally {
      run.cleanup();
    }
  });

  it('needs registration: the registration view', async () => {
    const client = createFakeClient({ session: sessionFor() });
    const run = await launched({ client, loadMembership: async () => ({ state: ACCOUNT.NEEDS_REGISTRATION, profile: null }) });
    try {
      assertEqual(currentView(run.shell.appRoot), VIEW.REGISTRATION);
    } finally {
      run.cleanup();
    }
  });

  it("can't reach Supabase: an alert with Try again, which reloads and recovers", async () => {
    const client = createFakeClient({
      session: sessionFor(),
      profile: MEMBER,
      rpcResults: [{ data: null, error: { message: 'Failed to fetch' } }, { data: MEMBER_ID, error: null }],
    });
    let run;
    await captureConsole('error', async () => {
      run = await launched({ client });
    });
    try {
      const { appRoot, logoutButton } = run.shell;
      assertEqual(currentView(appRoot), VIEW.UNAVAILABLE);
      assert(appRoot.querySelector('[role="alert"]'), 'announced to screen readers');
      assertEqual(logoutButton.hidden, false, 'a signed-in visitor can still log out');

      const retry = appRoot.querySelector('[data-view] button');
      assert(retry, 'has a Try again button');
      retry.click();
      await settle();
      await settle();

      assertEqual(currentView(appRoot), VIEW.HOME);
      assertEqual(run.recorder.views(), [VIEW.LOADING, VIEW.UNAVAILABLE, VIEW.LOADING, VIEW.HOME]);
    } finally {
      run.cleanup();
    }
  });

  it('stop() removes every listener it added', async () => {
    const client = createFakeClient({ session: sessionFor(), memberId: MEMBER_ID, profile: MEMBER });
    const run = await launched({ client });
    try {
      assertEqual(run.win.listenerCount('hashchange'), 1);
      assertEqual(client.listenerCount, 1);
      run.app.stop();
      assertEqual(run.win.listenerCount('hashchange'), 0);
      assertEqual(client.listenerCount, 0);
      run.win.navigate('#/rules');
      assertEqual(currentView(run.shell.appRoot), VIEW.HOME, 'no longer routing');
    } finally {
      run.cleanup();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 3. public/index.html                                                      */
/* ------------------------------------------------------------------------- */

describe('app: index.html header', () => {
  it('has the logo, nav, theme toggle and logout in the one static header, outside #app', async () => {
    const html = await readRepoFile('public/index.html');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headers = doc.querySelectorAll('header');
    assertEqual(headers.length, 1, 'one header');
    const header = headers[0];

    const logo = header.querySelector('a.site-logo');
    assert(logo, 'a logo link');
    assertEqual(logo.getAttribute('href'), HOME_HASH, 'the logo goes home');
    assertEqual(logo.querySelector('img')?.getAttribute('src'), 'assets/images/logo-small.png', 'the small logo, not the 2 MB one');
    assert(logo.textContent.trim().includes(SITE_NAME), 'the link has the site name as text');

    const nav = doc.getElementById(NAV_ID);
    assert(nav && nav.tagName === 'NAV' && header.contains(nav), `#${NAV_ID} is a <nav> in the header`);
    assert(nav.getAttribute('aria-label'), 'the nav has a label');
    assert(nav.hasAttribute('hidden'), 'hidden until we know the visitor is a member');

    const logout = doc.getElementById(LOGOUT_BUTTON_ID);
    assert(logout && logout.tagName === 'BUTTON' && header.contains(logout), `#${LOGOUT_BUTTON_ID} is a button in the header`);
    assertEqual(logout.getAttribute('type'), 'button');
    assert(logout.hasAttribute('hidden'), 'hidden until we know someone is signed in');

    assertEqual(header.querySelectorAll('#theme-toggle').length, 1, 'still exactly one theme toggle');
    assert(!header.closest('#app'), 'the header is outside #app');
    assertEqual(doc.getElementById('app')?.textContent.trim(), 'Loading…', 'the first paint is the loading text, never the landing page');
  });
});
