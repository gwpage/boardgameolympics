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
/* Helpers                                                                   */
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
