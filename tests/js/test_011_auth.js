/**
 * tests/js/test_011_auth.js: sign-in and logout (ISSUE-011, ADR-025).
 *
 * Covers:
 *  1. public/js/auth.js, the pure part: reading the invite token, building the
 *     redirect URL, checking an email address, and turning Supabase auth errors
 *     into friendly text.
 *  2. The two sign-in calls: the magic link (shouldCreateUser only with an
 *     invite token) and OAuth (Google, Facebook), each carrying the token in
 *     its redirect URL. Checked against a fake client that records every call.
 *  3. The login options panel: buttons, the email form, its messages, and a
 *     failed sign-in's message coming back from the URL.
 *  4. Through startApp: the token from ?invite= reaches both calls, a failed
 *     sign-in is explained once, and logout leaves no sb- cookies, using the
 *     real cookie storage (ISSUE-007) behind a stand-in supabase-js.
 *
 * Nothing here touches the network or the test page's own URL: the Supabase
 * client, the library and the window are fakes. The Google and Facebook round
 * trips can only be checked by hand: tests/manual/test_011_sign_in.md.
 */

import { describe, it, assert, assertEqual, assertRejects, assertThrows } from '../harness.js';
import {
  AUTH_MESSAGE,
  LOGIN_PROVIDERS,
  buildRedirectUrl,
  callbackErrorMessage,
  describeAuthError,
  logOut,
  mapAuthError,
  parseInviteToken,
  renderLoginOptions,
  sendMagicLink,
  siteBaseUrl,
  startOAuthSignIn,
  validateEmail,
} from '../../public/js/auth.js';
import { renderLanding } from '../../public/js/landing.js';
import { startApp } from '../../public/js/app.js';
import { ACCOUNT, ROLE, VIEW } from '../../public/js/router.js';
import { createCookieStorage, createSupabaseClient } from '../../public/js/supabase.js';

/** Where the fake window starts: the site served locally at /public/, as in development. */
const SITE_URL = 'https://bgo.example/public/';

/** A well-formed invite token: 64 lowercase hex characters (ADR-009). */
const TOKEN = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

const MEMBER = Object.freeze({ id: '5d1c2b3a-2222-4c3d-8e9f-000000000002', name: 'Alex', role: ROLE.USER });

/** A Supabase project URL for the cookie tests. The ref names the session cookie: sb-<ref>-auth-token. */
const PROJECT_REF = 'bgotestlogout011';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

/** What an expired magic link brings back (seen on dev, ISSUE-009). */
const EXPIRED_LINK_FRAGMENT = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

/* ------------------------------------------------------------------------- */
/* Fakes and helpers                                                         */
/* ------------------------------------------------------------------------- */

/** Lets pending promise callbacks and zero-delay timers run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

/** An AuthApiError as supabase-js 2.118 builds it: a name, an HTTP status and Supabase's error code. */
function authApiError(code, status = 400, message = `Supabase said ${code}`) {
  return Object.assign(new Error(message), { name: 'AuthApiError', code, status });
}

/** supabase-js's "couldn't reach Supabase": a network failure or a 502/503/504. No code. */
function retryableFetchError() {
  return Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
}

/**
 * A stand-in for the supabase-js client with what sign-in, logout and the
 * landing page use. `calls` records every call in order.
 *
 * `otp` and `oauth` are the results signInWithOtp and signInWithOAuth resolve
 * to: an object, or a function returning a promise (to hold or fail a call).
 */
function createAuthClient({ session = null, otp = { data: { user: null, session: null }, error: null }, oauth = null } = {}) {
  let currentSession = session;
  const listeners = new Set();
  const calls = [];
  const answer = (result, fallback) => {
    const value = result ?? fallback;
    return typeof value === 'function' ? value() : Promise.resolve(value);
  };
  return {
    calls,
    auth: {
      signInWithOtp(args) {
        calls.push(['signInWithOtp', args]);
        return answer(otp);
      },
      signInWithOAuth(args) {
        calls.push(['signInWithOAuth', args]);
        // The real one sends the browser to the provider and resolves with the URL.
        return answer(oauth, { data: { provider: args.provider, url: 'https://example.supabase.co/auth/v1/authorize' }, error: null });
      },
      async getSession() {
        calls.push(['getSession']);
        return { data: { session: currentSession }, error: null };
      },
      async signOut(options) {
        calls.push(['signOut', options]);
        currentSession = null;
        for (const listener of [...listeners]) {
          listener('SIGNED_OUT', null);
        }
        return { error: null };
      },
      onAuthStateChange(callback) {
        listeners.add(callback);
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
    },
    // The landing page's date (ISSUE-010) answers "no event yet".
    rpc(name) {
      calls.push(['rpc', name]);
      return { maybeSingle: () => Promise.resolve({ data: null, error: null }) };
    },
  };
}

function callsNamed(client, name) {
  return client.calls.filter((call) => call[0] === name);
}

/**
 * A stand-in for `window` with what app.js uses: location, history.replaceState,
 * and hashchange. navigate(hash) changes the hash and fires hashchange, like a link.
 */
function createFakeWindow(url = SITE_URL) {
  let current = new URL(url);
  const listeners = new Map();
  return {
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
    navigate(hash) {
      current = new URL(hash, current);
      for (const listener of [...(listeners.get('hashchange') ?? [])]) {
        listener(new Event('hashchange'));
      }
    },
  };
}

/**
 * Starts the app against fakes, with the header and #app attached to the test
 * page (so focus and form submission work). Always call `cleanup()`.
 */
async function launch({ client, url = SITE_URL, loadMembership } = {}) {
  const container = document.createElement('div');
  const nav = document.createElement('nav');
  const logoutButton = document.createElement('button');
  logoutButton.type = 'button';
  logoutButton.hidden = true;
  const appRoot = document.createElement('main');
  container.append(nav, logoutButton, appRoot);
  document.body.append(container);
  const win = createFakeWindow(url);
  const options = { client, appRoot, nav, logoutButton, win, doc: { title: '' } };
  if (loadMembership) {
    options.loadMembership = loadMembership;
  }
  let app = null;
  const cleanup = () => {
    app?.stop();
    container.remove();
  };
  try {
    app = await startApp(options);
    await settle();
  } catch (error) {
    cleanup();
    throw error;
  }
  return { app, win, appRoot, logoutButton, cleanup };
}

/** Puts `element` on the test page while `fn` runs, so focus and form submission behave as in the browser. */
async function attached(element, fn) {
  document.body.append(element);
  try {
    await fn();
  } finally {
    element.remove();
  }
}

/** The parts of the login options panel the tests poke at. */
function loginParts(root) {
  return {
    providerButtons: [...root.querySelectorAll('button[data-provider]')],
    form: root.querySelector('form.login-email-form'),
    input: root.querySelector('input[type="email"]'),
    submit: root.querySelector('form.login-email-form button[type="submit"]'),
    fieldError: root.querySelector('.login-field-error'),
    feedback: root.querySelector('.login-feedback'),
    callbackAlert: root.querySelector('.login-callback-error'),
  };
}

/** Types an address into the email form and submits it, as a person would. */
function submitEmail(root, email) {
  const { form, input } = loginParts(root);
  input.value = email;
  form.requestSubmit();
}

/**
 * A minimal document.cookie: Max-Age <= 0 deletes. Enough to check what's
 * left after logout. tests/js/test_007_cookie_storage.js covers the cookie
 * storage itself in detail.
 */
function createFakeCookieJar(initial = {}) {
  const cookies = new Map(Object.entries(initial));
  return {
    cookies,
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set cookie(text) {
      const [pair, ...attributes] = text.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const maxAge = attributes.find((attribute) => /^max-age=/i.test(attribute));
      if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) {
        cookies.delete(name);
      } else {
        cookies.set(name, pair.slice(separator + 1));
      }
    },
  };
}

/** The names of the session cookies in a cookie header: everything supabase-js stores starts "sb-". */
function sessionCookieNames(cookieHeader) {
  return cookieHeader
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter((name) => name.startsWith('sb-'));
}

/** A session as big as a real one (3-6 KB once encoded), so it's stored as several chunk cookies. */
function bigSession() {
  return JSON.stringify({
    access_token: `eyJhbGciOiJIUzI1NiJ9.${'x'.repeat(4000)}.sig`,
    refresh_token: 'refresh-token',
    expires_at: 4102444800, // 2100: never expires during a test
    user: { id: '0b6f3c1e-1111-4a3b-9c1d-000000000001', email: 'alex@example.com', user_metadata: { full_name: 'Alex Ångström' } },
  });
}

/**
 * A stand-in for the supabase-js library (the CDN global). Its client keeps
 * the session in the storage it's given and, on signOut, removes the same
 * three keys supabase-js 2.118's _removeSession() removes: the session, the
 * PKCE code verifier, and the separate user copy.
 */
function createFakeSupabaseLibrary() {
  return {
    createClient(url, key, options) {
      const { storage } = options.auth;
      const storageKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
      const listeners = new Set();
      const signOutCalls = [];
      const readSession = () => JSON.parse(storage.getItem(storageKey) ?? 'null');
      return {
        signOutCalls,
        auth: {
          async getSession() {
            return { data: { session: readSession() }, error: null };
          },
          async signOut(signOutOptions) {
            signOutCalls.push(signOutOptions);
            for (const removed of [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]) {
              storage.removeItem(removed);
            }
            for (const listener of [...listeners]) {
              listener('SIGNED_OUT', null);
            }
            return { error: null };
          },
          onAuthStateChange(callback) {
            listeners.add(callback);
            return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
          },
        },
        rpc() {
          return { maybeSingle: () => Promise.resolve({ data: null, error: null }) };
        },
      };
    },
  };
}

/** A signed-in client built by the real createSupabaseClient, storing its session in cookies on `cookieJar`. */
function createCookieBackedClient(cookieJar) {
  const storage = createCookieStorage({ cookieJar, secure: false });
  storage.setItem(STORAGE_KEY, bigSession());
  storage.setItem(`${STORAGE_KEY}-user`, JSON.stringify({ user: { id: 'u1' } }));
  return createSupabaseClient({
    config: { SUPABASE_URL: PROJECT_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key' },
    supabaseLibrary: createFakeSupabaseLibrary(),
    storage,
  });
}

/* ------------------------------------------------------------------------- */
/* 1. The pure part                                                          */
/* ------------------------------------------------------------------------- */

describe('auth: buildRedirectUrl', () => {
  it('with a token, the redirect URL carries ?invite=token', () => {
    assertEqual(buildRedirectUrl('https://boardgameolympics.net/', TOKEN), `https://boardgameolympics.net/?invite=${TOKEN}`);
    assertEqual(buildRedirectUrl('http://localhost:8000/public/', TOKEN), `http://localhost:8000/public/?invite=${TOKEN}`);
  });

  it('without a token, it is the bare site address', () => {
    assertEqual(buildRedirectUrl('https://boardgameolympics.net/', null), 'https://boardgameolympics.net/');
    assertEqual(buildRedirectUrl('https://boardgameolympics.net', null), 'https://boardgameolympics.net/', 'a bare origin gets its "/"');
    assertEqual(buildRedirectUrl('http://localhost:8000/public/', undefined), 'http://localhost:8000/public/');
    assertEqual(buildRedirectUrl('http://localhost:8000/public/', ''), 'http://localhost:8000/public/');
  });

  it('never carries a query or fragment from the base: Supabase puts the session in the fragment', () => {
    assertEqual(buildRedirectUrl('http://localhost:8000/public/?invite=old&x=1#/rules', null), 'http://localhost:8000/public/');
    assertEqual(buildRedirectUrl('http://localhost:8000/public/?x=1#/rules', TOKEN), `http://localhost:8000/public/?invite=${TOKEN}`);
  });
});

describe('auth: siteBaseUrl and parseInviteToken', () => {
  it('siteBaseUrl is the origin and path of the page, so it works at / and at /public/', () => {
    assertEqual(siteBaseUrl(`http://localhost:8000/public/?invite=${TOKEN}#/rules`), 'http://localhost:8000/public/');
    assertEqual(siteBaseUrl('https://boardgameolympics.net/#/profile'), 'https://boardgameolympics.net/');
  });

  it('parseInviteToken reads a well-formed token from the query string', () => {
    assertEqual(parseInviteToken(`?invite=${TOKEN}`), TOKEN);
    assertEqual(parseInviteToken(`?utm_source=chat&invite=${TOKEN}`), TOKEN);
  });

  it('parseInviteToken gives null for no token, or one that can never be valid (not 64 lowercase hex)', () => {
    for (const search of ['', '?', '?invite=', '?invite=abc', `?invite=${TOKEN.toUpperCase()}`, `?invite=${TOKEN}0`, `?invite=${TOKEN.slice(1)}`, `?invite=${TOKEN.slice(1)}g`, `?invite=%20${TOKEN}`, `?other=${TOKEN}`]) {
      assertEqual(parseInviteToken(search), null, JSON.stringify(search));
    }
  });
});

describe('auth: validateEmail', () => {
  it('accepts an address, trimmed', () => {
    assertEqual(validateEmail('  alex@example.org '), { ok: true, email: 'alex@example.org' });
    assertEqual(validateEmail('first.last+bgo@mail.example.co.uk').ok, true);
  });

  it('rejects an empty address with its own message', () => {
    for (const text of ['', '   ', null, undefined]) {
      assertEqual(validateEmail(text), { ok: false, message: AUTH_MESSAGE.EMPTY_EMAIL }, JSON.stringify(text));
    }
  });

  it('rejects anything that is not an email address', () => {
    for (const text of ['alex', 'alex@', '@example.org', 'alex@example', 'alex@@example.org', 'al ex@example.org', 'alex@exa mple.org', 'alex@example..org', 'alex@.example.org', `${'a'.repeat(250)}@example.org`]) {
      assertEqual(validateEmail(text), { ok: false, message: AUTH_MESSAGE.INVALID_EMAIL }, text);
    }
  });
});

describe('auth: mapAuthError', () => {
  it('maps otp_expired, over_email_send_rate_limit and access_denied to friendly text', () => {
    assertEqual(mapAuthError('otp_expired'), AUTH_MESSAGE.EXPIRED_LINK);
    assertEqual(mapAuthError('over_email_send_rate_limit'), AUTH_MESSAGE.RATE_LIMITED);
    assertEqual(mapAuthError('access_denied'), AUTH_MESSAGE.PROVIDER_ERROR);
  });

  it('maps the other codes a visitor can meet', () => {
    const expected = {
      over_request_rate_limit: AUTH_MESSAGE.RATE_LIMITED,
      provider_disabled: AUTH_MESSAGE.PROVIDER_ERROR,
      bad_oauth_callback: AUTH_MESSAGE.PROVIDER_ERROR,
      bad_oauth_state: AUTH_MESSAGE.PROVIDER_ERROR,
      // No account and no invite token: shouldCreateUser was false (seen on dev).
      otp_disabled: AUTH_MESSAGE.NO_ACCOUNT,
      signup_disabled: AUTH_MESSAGE.NO_ACCOUNT,
      email_address_invalid: AUTH_MESSAGE.EMAIL_REFUSED,
      validation_failed: AUTH_MESSAGE.EMAIL_REFUSED,
      // Supabase's built-in email only reaches the project's own team (no custom SMTP yet).
      email_address_not_authorized: AUTH_MESSAGE.CANT_EMAIL,
      user_banned: AUTH_MESSAGE.ACCOUNT_BLOCKED,
    };
    for (const [code, message] of Object.entries(expected)) {
      assertEqual(mapAuthError(code), message, code);
    }
  });

  it('unknown codes, and no code at all, get the generic text', () => {
    for (const code of ['something_new', 'server_error', '', null, undefined, 'constructor', '__proto__', 'toString']) {
      assertEqual(mapAuthError(code), AUTH_MESSAGE.GENERIC, String(code));
    }
  });

  it('every message is distinct, non-empty, plain text', () => {
    const messages = Object.values(AUTH_MESSAGE);
    assertEqual(new Set(messages).size, messages.length);
    for (const message of messages) {
      assert(typeof message === 'string' && message.trim() !== '' && !/[<>]/.test(message), message);
    }
  });

  it('describeAuthError uses the error\'s code, treats a network failure as one, and a bare 429 as rate limiting', () => {
    assertEqual(describeAuthError(authApiError('otp_expired', 403)), AUTH_MESSAGE.EXPIRED_LINK);
    assertEqual(describeAuthError(retryableFetchError()), AUTH_MESSAGE.NETWORK);
    assertEqual(describeAuthError(authApiError(undefined, 429)), AUTH_MESSAGE.RATE_LIMITED);
    assertEqual(describeAuthError(authApiError('mystery', 500)), AUTH_MESSAGE.GENERIC);
    assertEqual(describeAuthError(new TypeError('a bug')), AUTH_MESSAGE.GENERIC);
  });

  it('callbackErrorMessage prefers error_code over error, and never repeats the description', () => {
    assertEqual(callbackErrorMessage({ error: 'access_denied', code: 'otp_expired', description: 'Email link is invalid or has expired' }), AUTH_MESSAGE.EXPIRED_LINK);
    assertEqual(callbackErrorMessage({ error: 'access_denied', code: null, description: 'The user denied the request' }), AUTH_MESSAGE.PROVIDER_ERROR);
    assertEqual(callbackErrorMessage({ error: null, code: null, description: 'Call 555-0100 to verify your account' }), AUTH_MESSAGE.GENERIC);
    assertEqual(callbackErrorMessage(null), null);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. The sign-in calls                                                      */
/* ------------------------------------------------------------------------- */

describe('auth: sendMagicLink', () => {
  it('without a token: shouldCreateUser is false and the link returns to the bare site address', async () => {
    const client = createAuthClient();
    const result = await sendMagicLink(client, { email: ' alex@example.org ', inviteToken: null, baseUrl: SITE_URL });
    assertEqual(result, { ok: true, email: 'alex@example.org' });
    assertEqual(callsNamed(client, 'signInWithOtp'), [
      ['signInWithOtp', { email: 'alex@example.org', options: { shouldCreateUser: false, emailRedirectTo: SITE_URL } }],
    ]);
  });

  it('with a token: shouldCreateUser is true and the link returns with ?invite=token', async () => {
    const client = createAuthClient();
    await sendMagicLink(client, { email: 'alex@example.org', inviteToken: TOKEN, baseUrl: SITE_URL });
    assertEqual(callsNamed(client, 'signInWithOtp'), [
      ['signInWithOtp', { email: 'alex@example.org', options: { shouldCreateUser: true, emailRedirectTo: `${SITE_URL}?invite=${TOKEN}` } }],
    ]);
  });

  it('rejects an invalid email before Supabase is called', async () => {
    const client = createAuthClient();
    assertEqual(await sendMagicLink(client, { email: 'not-an-email', inviteToken: TOKEN, baseUrl: SITE_URL }), { ok: false, message: AUTH_MESSAGE.INVALID_EMAIL });
    assertEqual(await sendMagicLink(client, { email: '  ', inviteToken: null, baseUrl: SITE_URL }), { ok: false, message: AUTH_MESSAGE.EMPTY_EMAIL });
    assertEqual(client.calls, []);
  });

  it('turns a refusal into friendly text, with a warning', async () => {
    const cases = [
      [authApiError('over_email_send_rate_limit', 429), AUTH_MESSAGE.RATE_LIMITED],
      [authApiError('otp_disabled', 422, 'Signups not allowed for otp'), AUTH_MESSAGE.NO_ACCOUNT],
      [authApiError('email_address_not_authorized', 400), AUTH_MESSAGE.CANT_EMAIL],
      [retryableFetchError(), AUTH_MESSAGE.NETWORK],
    ];
    for (const [error, message] of cases) {
      const client = createAuthClient({ otp: { data: { user: null, session: null }, error } });
      let result;
      const warnings = await captureConsole('warn', async () => {
        result = await sendMagicLink(client, { email: 'alex@example.org', inviteToken: null, baseUrl: SITE_URL });
      });
      assertEqual(result, { ok: false, message }, error.code ?? error.name);
      assertEqual(warnings.length, 1, 'logged for whoever debugs it');
    }
  });

  it('never rejects: a thrown error is logged and comes back as the generic text', async () => {
    const client = createAuthClient({ otp: () => Promise.reject(new TypeError('a bug')) });
    let result;
    const errors = await captureConsole('error', async () => {
      result = await sendMagicLink(client, { email: 'alex@example.org', inviteToken: null, baseUrl: SITE_URL });
    });
    assertEqual(result, { ok: false, message: AUTH_MESSAGE.GENERIC });
    assertEqual(errors.length, 1);
  });
});

describe('auth: startOAuthSignIn', () => {
  it('offers Google and Facebook, in that order', () => {
    assertEqual(LOGIN_PROVIDERS.map((provider) => provider.id), ['google', 'facebook']);
    assertEqual(LOGIN_PROVIDERS.map((provider) => provider.label), ['Google', 'Facebook']);
    assert(Object.isFrozen(LOGIN_PROVIDERS) && LOGIN_PROVIDERS.every(Object.isFrozen), 'frozen');
  });

  it('the OAuth redirect URL carries the invite token too', async () => {
    for (const { id } of LOGIN_PROVIDERS) {
      const client = createAuthClient();
      assertEqual(await startOAuthSignIn(client, { provider: id, inviteToken: TOKEN, baseUrl: SITE_URL }), { ok: true });
      assertEqual(callsNamed(client, 'signInWithOAuth'), [['signInWithOAuth', { provider: id, options: { redirectTo: `${SITE_URL}?invite=${TOKEN}` } }]], id);
    }
  });

  it('without a token, it returns to the bare site address', async () => {
    const client = createAuthClient();
    await startOAuthSignIn(client, { provider: 'google', inviteToken: null, baseUrl: `${SITE_URL}?x=1#/rules` });
    assertEqual(callsNamed(client, 'signInWithOAuth'), [['signInWithOAuth', { provider: 'google', options: { redirectTo: SITE_URL } }]]);
  });

  it('a refusal before leaving the page becomes friendly text, with a warning; a thrown error is logged', async () => {
    const refused = createAuthClient({ oauth: { data: { provider: 'facebook', url: null }, error: authApiError('provider_disabled') } });
    let result;
    const warnings = await captureConsole('warn', async () => {
      result = await startOAuthSignIn(refused, { provider: 'facebook', inviteToken: null, baseUrl: SITE_URL });
    });
    assertEqual(result, { ok: false, message: AUTH_MESSAGE.PROVIDER_ERROR });
    assertEqual(warnings.length, 1);

    const broken = createAuthClient({ oauth: () => Promise.reject(new TypeError('a bug')) });
    const errors = await captureConsole('error', async () => {
      result = await startOAuthSignIn(broken, { provider: 'google', inviteToken: null, baseUrl: SITE_URL });
    });
    assertEqual(result, { ok: false, message: AUTH_MESSAGE.GENERIC });
    assertEqual(errors.length, 1);
  });

  it('a provider the site does not offer is a bug, and throws without calling Supabase', async () => {
    const client = createAuthClient();
    await assertRejects(() => startOAuthSignIn(client, { provider: 'github', inviteToken: null, baseUrl: SITE_URL }), TypeError);
    assertEqual(client.calls, []);
  });
});

/* ------------------------------------------------------------------------- */
/* 3. The login options panel                                                */
/* ------------------------------------------------------------------------- */

describe('auth: the login options', () => {
  it('has a button per provider and an email form with a label, and calls nothing until used', () => {
    const client = createAuthClient();
    const root = renderLoginOptions({ doc: document, client, inviteToken: null, baseUrl: SITE_URL });
    const { providerButtons, form, input, submit, feedback, callbackAlert } = loginParts(root);

    assertEqual(providerButtons.map((button) => button.dataset.provider), ['google', 'facebook']);
    assertEqual(providerButtons.map((button) => button.textContent), ['Continue with Google', 'Continue with Facebook']);
    assert(providerButtons.every((button) => button.type === 'button'), 'not submit buttons');

    assert(form, 'an email form');
    assertEqual(form.noValidate, true, 'the app checks the address itself, so the message is the same in every browser');
    assertEqual(input.getAttribute('autocomplete'), 'email');
    assertEqual(root.querySelector(`label[for="${input.id}"]`)?.textContent.trim().length > 0, true, 'the input has a label');
    assert(submit && /link/i.test(submit.textContent), `submit says what it does: "${submit?.textContent}"`);
    assertEqual(feedback.getAttribute('role'), 'status', 'results are announced to screen readers');
    assertEqual(callbackAlert, null, 'no error to show');
    assertEqual(client.calls, []);
  });

  it('an invalid address shows a message on the field, focuses it, and never calls Supabase', async () => {
    const client = createAuthClient();
    const root = renderLoginOptions({ doc: document, client, inviteToken: null, baseUrl: SITE_URL });
    await attached(root, async () => {
      submitEmail(root, 'alex@');
      await settle();
      const { input, fieldError } = loginParts(root);
      assertEqual(fieldError.textContent, AUTH_MESSAGE.INVALID_EMAIL);
      assertEqual(fieldError.hidden, false);
      assertEqual(input.getAttribute('aria-invalid'), 'true');
      assert(input.getAttribute('aria-describedby')?.split(' ').includes(fieldError.id), 'the message is tied to the field');
      assert(document.activeElement === input, 'focus moves to the field');

      submitEmail(root, '');
      await settle();
      assertEqual(loginParts(root).fieldError.textContent, AUTH_MESSAGE.EMPTY_EMAIL);
      assertEqual(client.calls, []);
    });
  });

  it('a good address: "Sending…" while it goes, then says the link was sent, naming the address as text', async () => {
    const answer = deferred();
    const client = createAuthClient({ otp: () => answer.promise });
    const root = renderLoginOptions({ doc: document, client, inviteToken: null, baseUrl: SITE_URL });
    await attached(root, async () => {
      submitEmail(root, 'alex@');
      await settle();
      // An address that looks like markup must come out as text.
      submitEmail(root, '<b>alex</b>@example.org');
      await settle();
      const { submit, input, fieldError, feedback } = loginParts(root);
      assertEqual(submit.disabled, true, 'so it can\'t be sent twice');
      assertEqual(submit.getAttribute('aria-busy'), 'true');
      assertEqual(input.hasAttribute('aria-invalid'), false, 'the old field error is cleared');
      assertEqual(fieldError.hidden, true);

      answer.resolve({ data: { user: null, session: null }, error: null });
      await settle();
      assertEqual(submit.disabled, false);
      assertEqual(submit.hasAttribute('aria-busy'), false);
      assertEqual(feedback.dataset.tone, 'success');
      assert(feedback.textContent.includes('<b>alex</b>@example.org'), feedback.textContent);
      assert(/check your email/i.test(feedback.textContent), feedback.textContent);
      assertEqual(root.querySelector('b'), null, 'no markup was created');
    });
  });

  it('a refused request shows the friendly text as an error', async () => {
    const client = createAuthClient({ otp: { data: { user: null, session: null }, error: authApiError('over_email_send_rate_limit', 429) } });
    const root = renderLoginOptions({ doc: document, client, inviteToken: null, baseUrl: SITE_URL });
    await attached(root, async () => {
      await captureConsole('warn', async () => {
        submitEmail(root, 'alex@example.org');
        await settle();
      });
      const { feedback, submit } = loginParts(root);
      assertEqual(feedback.textContent, AUTH_MESSAGE.RATE_LIMITED);
      assertEqual(feedback.dataset.tone, 'error');
      assertEqual(submit.disabled, false, 'ready to try again');
    });
  });

  it('a provider button starts that provider\'s sign-in with the token; a refusal is shown', async () => {
    const client = createAuthClient({ oauth: { data: { provider: 'facebook', url: null }, error: authApiError('provider_disabled') } });
    const root = renderLoginOptions({ doc: document, client, inviteToken: TOKEN, baseUrl: SITE_URL });
    await attached(root, async () => {
      await captureConsole('warn', async () => {
        loginParts(root).providerButtons[1].click();
        await settle();
      });
      assertEqual(callsNamed(client, 'signInWithOAuth'), [['signInWithOAuth', { provider: 'facebook', options: { redirectTo: `${SITE_URL}?invite=${TOKEN}` } }]]);
      assertEqual(loginParts(root).feedback.textContent, AUTH_MESSAGE.PROVIDER_ERROR);
      assertEqual(loginParts(root).feedback.dataset.tone, 'error');
    });
  });

  it('a failed sign-in from the URL is shown as an alert, without the description from the URL', () => {
    const root = renderLoginOptions({
      doc: document,
      client: createAuthClient(),
      inviteToken: null,
      baseUrl: SITE_URL,
      callbackError: { error: 'access_denied', code: 'otp_expired', description: 'Call 555-0100 to verify' },
    });
    const { callbackAlert } = loginParts(root);
    assertEqual(callbackAlert?.getAttribute('role'), 'alert');
    assertEqual(callbackAlert.textContent, AUTH_MESSAGE.EXPIRED_LINK);
    assert(!root.textContent.includes('555-0100'), 'text from the URL is never shown: anyone can craft one');
  });
});

describe('auth: the landing page\'s login panel', () => {
  it('holds the real login options', () => {
    const view = renderLanding({ doc: document, client: createAuthClient(), inviteToken: null, baseUrl: SITE_URL });
    const panel = view.querySelector('#login-options');
    assertEqual(panel.hidden, true, 'closed to start with');
    assertEqual(panel.querySelectorAll('button[data-provider]').length, LOGIN_PROVIDERS.length);
    assert(panel.querySelector('form.login-email-form'), 'the email form');
    assertEqual(panel.querySelector('.placeholder'), null, 'the ISSUE-010 placeholder is gone');
  });

  it('after a failed sign-in, opens straight away with the message, so the visitor can try again', () => {
    const view = renderLanding({ doc: document, client: createAuthClient(), inviteToken: null, baseUrl: SITE_URL, callbackError: { error: 'access_denied', code: 'otp_expired', description: null } });
    const button = view.querySelector('.landing-login-button');
    const panel = view.querySelector('#login-options');
    assertEqual(panel.hidden, false);
    assertEqual(button.getAttribute('aria-expanded'), 'true');
    assertEqual(panel.querySelector('.login-callback-error')?.textContent, AUTH_MESSAGE.EXPIRED_LINK);
  });
});

/* ------------------------------------------------------------------------- */
/* 4. Through startApp                                                       */
/* ------------------------------------------------------------------------- */

describe('auth: through startApp', () => {
  it('?invite= reaches both sign-in calls: shouldCreateUser and the redirect URL', async () => {
    const client = createAuthClient();
    const run = await launch({ client, url: `${SITE_URL}?invite=${TOKEN}#/rules` });
    try {
      run.appRoot.querySelector('.landing-login-button').click();
      submitEmail(run.appRoot, 'alex@example.org');
      await settle();
      run.appRoot.querySelector('button[data-provider="google"]').click();
      await settle();
      const redirect = `${SITE_URL}?invite=${TOKEN}`;
      assertEqual(callsNamed(client, 'signInWithOtp'), [['signInWithOtp', { email: 'alex@example.org', options: { shouldCreateUser: true, emailRedirectTo: redirect } }]]);
      assertEqual(callsNamed(client, 'signInWithOAuth'), [['signInWithOAuth', { provider: 'google', options: { redirectTo: redirect } }]]);
    } finally {
      run.cleanup();
    }
  });

  it('without a token, or with a malformed one, the magic link cannot create an account', async () => {
    for (const search of ['', '?invite=not-a-token']) {
      const client = createAuthClient();
      const run = await launch({ client, url: `${SITE_URL}${search}` });
      try {
        run.appRoot.querySelector('.landing-login-button').click();
        submitEmail(run.appRoot, 'alex@example.org');
        await settle();
        assertEqual(callsNamed(client, 'signInWithOtp'), [['signInWithOtp', { email: 'alex@example.org', options: { shouldCreateUser: false, emailRedirectTo: SITE_URL } }]], search);
      } finally {
        run.cleanup();
      }
    }
  });

  it('an expired magic link: the landing page opens the panel and explains, once', async () => {
    const client = createAuthClient();
    let run;
    await captureConsole('warn', async () => {
      run = await launch({ client, url: `${SITE_URL}${EXPIRED_LINK_FRAGMENT}` });
    });
    try {
      const alert = run.appRoot.querySelector('.login-callback-error');
      assertEqual(alert?.textContent, AUTH_MESSAGE.EXPIRED_LINK);
      assertEqual(run.appRoot.querySelector('#login-options').hidden, false);
      assertEqual(run.win.location.hash, '', 'the fragment is gone (ISSUE-009)');

      // The landing page is drawn again on every hashchange; the old error isn't news any more.
      run.win.navigate('#/rules');
      await settle();
      assertEqual(run.appRoot.querySelector('[data-view]')?.dataset.view, VIEW.LANDING);
      assertEqual(run.appRoot.querySelector('.login-callback-error'), null);
      assertEqual(run.appRoot.querySelector('#login-options').hidden, true);
    } finally {
      run.cleanup();
    }
  });

  it('text in a crafted #error_description never reaches the page', async () => {
    const client = createAuthClient();
    let run;
    await captureConsole('warn', async () => {
      run = await launch({ client, url: `${SITE_URL}#error=server_error&error_description=Call+555-0100+to+verify+your+account` });
    });
    try {
      assertEqual(run.appRoot.querySelector('.login-callback-error')?.textContent, AUTH_MESSAGE.GENERIC);
      assert(!run.appRoot.textContent.includes('555-0100'));
    } finally {
      run.cleanup();
    }
  });
});

describe('auth: logout', () => {
  it('logOut signs this browser out (scope "local") and leaves no sb- cookies, keeping other cookies', async () => {
    const jar = createFakeCookieJar({ theme_note: 'kept' });
    const client = createCookieBackedClient(jar);
    assert(sessionCookieNames(jar.cookie).length >= 3, `signed in, with the session in chunks: ${sessionCookieNames(jar.cookie)}`);

    await logOut(client);
    assertEqual(client.signOutCalls, [{ scope: 'local' }]);
    assertEqual(sessionCookieNames(jar.cookie), []);
    assertEqual(jar.cookies.get('theme_note'), 'kept', 'only session cookies go');
  });

  it('the Log out button signs out, clears every session cookie and returns to the landing page', async () => {
    const jar = createFakeCookieJar();
    const client = createCookieBackedClient(jar);
    const run = await launch({ client, url: `${SITE_URL}#/profile`, loadMembership: async () => ({ state: ACCOUNT.MEMBER, profile: MEMBER }) });
    try {
      assertEqual(run.appRoot.querySelector('.member-page [data-view]')?.dataset.view, VIEW.PROFILE, 'signed in to start with');
      run.logoutButton.click();
      await settle();
      await settle();
      assertEqual(client.signOutCalls, [{ scope: 'local' }]);
      assertEqual(sessionCookieNames(jar.cookie), []);
      assertEqual(run.appRoot.querySelector('[data-view]')?.dataset.view, VIEW.LANDING);
      assertEqual(run.logoutButton.hidden, true);
    } finally {
      run.cleanup();
    }
  });

  it('in the real browser too: logout leaves no sb- cookies in document.cookie', async () => {
    const client = createCookieBackedClient(document);
    try {
      assert(sessionCookieNames(document.cookie).some((name) => name.startsWith(STORAGE_KEY)), 'the session is in real cookies');
      await logOut(client);
      assertEqual(sessionCookieNames(document.cookie).filter((name) => name.startsWith(STORAGE_KEY)), []);
    } finally {
      // Never leave session cookies on the test page, even if an assertion failed.
      for (const name of sessionCookieNames(document.cookie).filter((cookie) => cookie.startsWith(STORAGE_KEY))) {
        document.cookie = `${name}=; Path=/; Max-Age=0`;
      }
    }
  });

  it('logOut never throws: a failure is logged (the app then reads the session again, ISSUE-009)', async () => {
    const client = createAuthClient({ session: { user: { id: 'u1' } } });
    client.auth.signOut = async () => {
      throw new TypeError('network down');
    };
    const errors = await captureConsole('error', async () => {
      await logOut(client);
    });
    assertEqual(errors.length, 1);

    const refused = createAuthClient();
    refused.auth.signOut = async () => ({ error: retryableFetchError() });
    const warnings = await captureConsole('warn', async () => {
      await logOut(refused);
    });
    assertEqual(warnings.length, 1);
  });
});

describe('auth: misuse', () => {
  it('buildRedirectUrl refuses a base that is not an absolute URL: a bug, not something to guess about', () => {
    assertThrows(() => buildRedirectUrl('/public/', TOKEN), TypeError);
  });
});
