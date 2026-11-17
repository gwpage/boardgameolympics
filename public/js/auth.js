/**
 * auth.js: signing in and logging out (ISSUE-011, ADR-025; SPEC § Authentication,
 * § Session Management).
 *
 * WHAT IT DOES
 *   - renderLoginOptions() draws the login panel the landing page opens:
 *     "Continue with Google", "Continue with Facebook", and an email form that
 *     sends a magic link. It shows what happened in plain words: link sent,
 *     address not valid, link expired, too many tries, provider refused.
 *   - sendMagicLink() and startOAuthSignIn() make the two kinds of sign-in
 *     call. Both send the visitor back to this page, carrying the invite
 *     token (?invite=…) when there is one, so ISSUE-012 can claim it.
 *   - logOut() signs this browser out, which deletes every session cookie.
 *
 * THE INVITE TOKEN AND shouldCreateUser
 *   A magic link only creates a new account when the visitor arrived with an
 *   invite token (shouldCreateUser: true). Without one, Supabase answers
 *   otp_disabled ("Signups not allowed for otp") for an address it doesn't
 *   know, and the visitor is told there's no account yet.
 *   OAuth always creates the account if it's new: Supabase has no switch for
 *   that per sign-in.
 *   Neither is a security boundary. Anyone can call Supabase's API directly
 *   with shouldCreateUser: true. An account with no invitation behind it has
 *   no profile, and so no access: the claim_membership RPC (ISSUE-012) and Row
 *   Level Security (ISSUE-003) decide who gets in. This just saves people who
 *   aren't invited from making an account they can't use.
 *
 * THE ROUND TRIP
 *   Both kinds of sign-in leave the site, at the email app or the provider,
 *   and come back to the redirect URL with the session in the fragment
 *   (#access_token=…), or an error (#error=…&error_code=…). supabase-js reads a
 *   session from it; app.js keeps an error and passes it to the landing page,
 *   which opens this panel with the message (callbackErrorMessage).
 *   The redirect URL is this page's origin and path, plus ?invite=<token>. It
 *   never has a fragment, because Supabase puts the session there. Supabase
 *   only sends people back to URLs on its allow list (SETUP_SUPABASE.md
 *   Step 4). A URL that isn't allowed is replaced by the Site URL, without an
 *   error, and the token is lost on the way.
 *
 * TEXT FROM THE URL IS NEVER SHOWN
 *   An #error_description comes from the URL, and anyone can send someone a
 *   link with their own words in it ("Call this number to verify…"). Only the
 *   error code is used, to pick one of the site's own messages.
 *
 * HOW IT FITS
 *   landing.js puts renderLoginOptions() in its login panel. app.js gives the
 *   landing page the invite token, the page's address and any sign-in error
 *   from the URL, and calls logOut() from the header's Log out button. The
 *   client comes from supabase.js. Signing in only proves who someone is:
 *   whether they're allowed in is decided afterwards.
 */

import { createElement as create } from './util.js';

/** The query parameter an invite link carries its token in: https://boardgameolympics.net/?invite=<token>. */
export const INVITE_PARAM = 'invite';

/** Invite tokens are exactly 64 lowercase hex characters, enforced by a database check (ADR-009). */
const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The OAuth providers on the login panel, in order. `id` is Supabase's name
 * for the provider. Each must be switched on in the Supabase dashboard
 * (SETUP_SUPABASE.md Step 4). Supabase answers a provider that isn't with a
 * bare error page of its own, not a redirect back here, so take a provider
 * off this list if it can't be switched on.
 */
export const LOGIN_PROVIDERS = Object.freeze(
  [
    { id: 'google', label: 'Google' },
    { id: 'facebook', label: 'Facebook' },
  ].map((provider) => Object.freeze(provider))
);

/**
 * Log out of this browser only. supabase-js's default ("global") would also
 * sign the person out on their phone and every other device (ADR-023).
 */
export const SIGN_OUT_OPTIONS = Object.freeze({ scope: 'local' });

/** The longest address an email can be delivered to (RFC 5321's 254-character path limit). */
const MAX_EMAIL_LENGTH = 254;

/**
 * Something@something.something, with no spaces and no empty parts. Not a
 * full RFC 5322 check, which no browser or mail server agrees on; it catches
 * typos before a request is wasted. Supabase checks properly.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** supabase-js's name for "couldn't reach Supabase": a network failure, or a 502/503/504. It has no code. */
const RETRYABLE_AUTH_ERROR_NAME = 'AuthRetryableFetchError';

/** HTTP status for rate limiting, for a refusal that comes without a code. */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Everything the login panel can tell a visitor, in plain words.
 * Each one says what happened and what to do next.
 */
export const AUTH_MESSAGE = Object.freeze({
  EMPTY_EMAIL: 'Enter your email address.',
  INVALID_EMAIL: "That doesn't look like an email address. Check it and try again.",
  EXPIRED_LINK:
    'That sign-in link has expired or has already been used. Each link works only once. Enter your email below to get a new one.',
  RATE_LIMITED: 'Too many sign-in attempts in a short time. Wait a few minutes, then try again.',
  PROVIDER_ERROR: "Signing in that way didn't work: it was cancelled or refused. Try again, or use another way to sign in.",
  NO_ACCOUNT:
    "There's no account for that email address yet. If you've been invited, open the link in your invitation first. " +
    "If you're already on the guest list, sign in with Google or Facebook using this address.",
  EMAIL_REFUSED: "That email address can't be used. Check it, or try a different one.",
  CANT_EMAIL: "The site can't send email to that address yet. Sign in with Google or Facebook instead, or ask the host.",
  ACCOUNT_BLOCKED: "This account can't sign in right now. Ask the host.",
  NETWORK: "Couldn't reach the sign-in service. Check your internet connection, then try again.",
  GENERIC: 'Something went wrong while signing in. Please try again.',
});

/**
 * Supabase Auth error codes → messages. The codes are listed at
 * https://supabase.com/docs/guides/auth/debugging/error-codes. They arrive
 * as error.code on a refused request, or as error_code (or error) in a failed
 * sign-in's #error=… fragment. A Map, so a code like "constructor" can never
 * find something inherited from Object.
 */
const MESSAGE_FOR_CODE = new Map([
  // A magic link opened twice, or after it expired (1 hour by default).
  ['otp_expired', AUTH_MESSAGE.EXPIRED_LINK],
  // Too many emails to one address, or too many requests from one IP.
  ['over_email_send_rate_limit', AUTH_MESSAGE.RATE_LIMITED],
  ['over_request_rate_limit', AUTH_MESSAGE.RATE_LIMITED],
  // The visitor said no at Google or Facebook, or the provider or Supabase refused the hand-off.
  ['access_denied', AUTH_MESSAGE.PROVIDER_ERROR],
  ['provider_disabled', AUTH_MESSAGE.PROVIDER_ERROR],
  ['bad_oauth_callback', AUTH_MESSAGE.PROVIDER_ERROR],
  ['bad_oauth_state', AUTH_MESSAGE.PROVIDER_ERROR],
  // A magic link for an address with no account, sent without an invite token
  // (shouldCreateUser: false). Supabase's docs describe otp_disabled as
  // "magic links are switched off", but this is what dev returns here.
  ['otp_disabled', AUTH_MESSAGE.NO_ACCOUNT],
  ['signup_disabled', AUTH_MESSAGE.NO_ACCOUNT],
  // Supabase refused the address itself (it rejects example and test domains, for one).
  ['email_address_invalid', AUTH_MESSAGE.EMAIL_REFUSED],
  ['validation_failed', AUTH_MESSAGE.EMAIL_REFUSED],
  // Supabase's built-in email only reaches the project's own team. Fixed by custom SMTP.
  ['email_address_not_authorized', AUTH_MESSAGE.CANT_EMAIL],
  ['user_banned', AUTH_MESSAGE.ACCOUNT_BLOCKED],
]);

/** The email form's button, and what it says while the request is out. */
const SUBMIT_LABEL = 'Email me a sign-in link';
const SUBMIT_BUSY_LABEL = 'Sending…';

/** ids inside the login panel. The landing page shows one panel at a time. */
const EMAIL_INPUT_ID = 'login-email';
const EMAIL_HINT_ID = 'login-email-hint';
const EMAIL_ERROR_ID = 'login-email-error';

/** data-tone values on the feedback line, for styling. */
const TONE = Object.freeze({ SUCCESS: 'success', ERROR: 'error' });

/* ------------------------------------------------------------------------- */
/* URLs and the invite token                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The invite token from a query string, or null if there isn't a well-formed
 * one. A malformed token can never be valid, so it's treated as no token.
 *
 * @param {string} search  location.search, e.g. "?invite=<64 hex characters>".
 * @returns {string|null}
 */
export function parseInviteToken(search) {
  const token = new URLSearchParams(search).get(INVITE_PARAM);
  return token !== null && INVITE_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * This page's address without its query or fragment: the origin and path. It's
 * "https://boardgameolympics.net/" in production and "http://localhost:8000/public/"
 * locally, so sign-ins come back to wherever they started.
 *
 * @param {string} href  location.href.
 * @returns {string}
 */
export function siteBaseUrl(href) {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`;
}

/**
 * Where a sign-in should come back to: the page, plus ?invite=<token> if there
 * is one. Any query or fragment on `baseUrl` is dropped. Supabase puts the
 * session in the fragment, and the token is the only query the page needs.
 *
 * @param {string} baseUrl  An absolute URL, normally from siteBaseUrl().
 * @param {string|null} [token]  The invite token, if any.
 * @returns {string}
 * @throws {TypeError} If baseUrl isn't an absolute URL: a bug.
 */
export function buildRedirectUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  if (token) {
    url.searchParams.set(INVITE_PARAM, token);
  }
  return url.href;
}

/* ------------------------------------------------------------------------- */
/* Messages                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Checks an email address before anything is sent.
 *
 * @param {*} text  What the visitor typed.
 * @returns {{ok: true, email: string}|{ok: false, message: string}}
 *   The address trimmed of spaces, or the message to show.
 */
export function validateEmail(text) {
  const email = typeof text === 'string' ? text.trim() : '';
  if (email === '') {
    return { ok: false, message: AUTH_MESSAGE.EMPTY_EMAIL };
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { ok: false, message: AUTH_MESSAGE.INVALID_EMAIL };
  }
  return { ok: true, email };
}

/**
 * The friendly message for a Supabase Auth error code. Unknown codes, and no
 * code, get the generic message.
 *
 * @param {string|null|undefined} code  e.g. "otp_expired".
 * @returns {string}
 */
export function mapAuthError(code) {
  return MESSAGE_FOR_CODE.get(code) ?? AUTH_MESSAGE.GENERIC;
}

/**
 * The friendly message for an error returned by a supabase-js auth call.
 *
 * @param {*} error  Usually an AuthApiError ({name, code, status}) or an AuthRetryableFetchError.
 * @returns {string}
 */
export function describeAuthError(error) {
  if (error?.name === RETRYABLE_AUTH_ERROR_NAME) {
    return AUTH_MESSAGE.NETWORK;
  }
  const message = MESSAGE_FOR_CODE.get(error?.code);
  if (message) {
    return message;
  }
  return error?.status === HTTP_TOO_MANY_REQUESTS ? AUTH_MESSAGE.RATE_LIMITED : AUTH_MESSAGE.GENERIC;
}

/**
 * The friendly message for a failed sign-in that came back in the URL. Its
 * error_code is the specific one (otp_expired). Its error is the broad OAuth
 * one (access_denied), used when there's no code. Its description is never
 * used: see TEXT FROM THE URL IS NEVER SHOWN in the header.
 *
 * @param {{error: string|null, code: string|null, description: string|null}|null} callbackError
 *   From router.js's readAuthCallbackError(), via app.js.
 * @returns {string|null}  null when there's no error.
 */
export function callbackErrorMessage(callbackError) {
  if (!callbackError) {
    return null;
  }
  return mapAuthError(callbackError.code || callbackError.error);
}

/** What the visitor sees once the magic link is on its way. */
function linkSentMessage(email) {
  return (
    `Check your email. We've sent a sign-in link to ${email}. It works once, on any device. ` +
    "If it hasn't arrived in a few minutes, look in your spam folder."
  );
}

/* ------------------------------------------------------------------------- */
/* Signing in and out                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Emails a magic link. It creates a new account only when there's an invite
 * token (see THE INVITE TOKEN AND shouldCreateUser in the header).
 *
 * Never rejects. A refusal is logged as a warning, and anything thrown as an
 * error. Either way the visitor gets a message.
 *
 * @param {object} client  The Supabase client.
 * @param {{email: string, inviteToken: string|null, baseUrl: string}} request
 * @returns {Promise<{ok: true, email: string}|{ok: false, message: string}>}
 *   `email` is the address the link went to, trimmed.
 */
export async function sendMagicLink(client, { email, inviteToken, baseUrl }) {
  const checked = validateEmail(email);
  if (!checked.ok) {
    return checked; // Nothing is sent for an address that can't be right.
  }
  try {
    const { error } = await client.auth.signInWithOtp({
      email: checked.email,
      options: {
        shouldCreateUser: Boolean(inviteToken),
        emailRedirectTo: buildRedirectUrl(baseUrl, inviteToken),
      },
    });
    if (error) {
      console.warn('Sign-in: Supabase did not send the magic link.', error);
      return { ok: false, message: describeAuthError(error) };
    }
    return { ok: true, email: checked.email };
  } catch (error) {
    console.error('Sign-in: sending the magic link failed unexpectedly.', error);
    return { ok: false, message: AUTH_MESSAGE.GENERIC };
  }
}

/**
 * Starts signing in with Google or Facebook. supabase-js sends the browser to
 * the provider (by way of Supabase), which sends it back to the redirect URL.
 *
 * Never rejects for a failed sign-in. A refusal is logged as a warning, and
 * anything thrown as an error. Either way the visitor gets a message.
 *
 * @param {object} client  The Supabase client.
 * @param {{provider: string, inviteToken: string|null, baseUrl: string}} request
 *   `provider` is an id from LOGIN_PROVIDERS.
 * @returns {Promise<{ok: true}|{ok: false, message: string}>}  On ok, the page is already on its way out.
 * @throws {TypeError} For a provider not in LOGIN_PROVIDERS: a bug.
 */
export async function startOAuthSignIn(client, { provider, inviteToken, baseUrl }) {
  if (!LOGIN_PROVIDERS.some((candidate) => candidate.id === provider)) {
    throw new TypeError(`startOAuthSignIn: the site doesn't offer sign-in with ${JSON.stringify(provider)}`);
  }
  try {
    // Not skipBrowserRedirect: with it, supabase-js asks Supabase for JSON
    // instead of a redirect, which a browser can't follow.
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: buildRedirectUrl(baseUrl, inviteToken) },
    });
    if (error) {
      console.warn(`Sign-in: couldn't start signing in with ${provider}.`, error);
      return { ok: false, message: describeAuthError(error) };
    }
    return { ok: true };
  } catch (error) {
    console.error(`Sign-in: starting sign-in with ${provider} failed unexpectedly.`, error);
    return { ok: false, message: AUTH_MESSAGE.GENERIC };
  }
}

/**
 * Signs this browser out. supabase-js deletes the session from storage, which
 * deletes every session cookie (ADR-021). It does that even when Supabase
 * can't be reached to end the session there.
 *
 * Never throws. A failure is logged. The caller should read the session again
 * to see where things stand, as app.js does.
 *
 * @param {object} client  The Supabase client.
 * @returns {Promise<void>}
 */
export async function logOut(client) {
  try {
    const { error } = await client.auth.signOut(SIGN_OUT_OPTIONS);
    if (error) {
      console.warn("Log out: Supabase didn't confirm, but this browser is signed out.", error);
    }
  } catch (error) {
    console.error('Log out failed. Checking whether this browser is still signed in.', error);
  }
}

/* ------------------------------------------------------------------------- */
/* The login panel                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The login options: a button per provider, then the email form, then a line
 * for what happened. A failed sign-in from the URL shows first, as an alert.
 * Nothing is sent until the visitor uses one.
 *
 * @param {object} context
 * @param {Document} context.doc
 * @param {object} context.client  The Supabase client.
 * @param {string|null} [context.inviteToken]  From parseInviteToken().
 * @param {string} context.baseUrl  From siteBaseUrl().
 * @param {object|null} [context.callbackError]  A failed sign-in from the URL (app.js).
 * @returns {HTMLElement}
 */
export function renderLoginOptions({ doc, client, inviteToken = null, baseUrl, callbackError = null }) {
  const signIn = { inviteToken, baseUrl };
  const feedback = create(doc, 'p', { class: 'login-feedback', role: 'status' });
  const setFeedback = (tone, text) => {
    feedback.textContent = text ?? '';
    if (tone) {
      feedback.dataset.tone = tone;
    } else {
      delete feedback.dataset.tone;
    }
  };

  const callbackMessage = callbackErrorMessage(callbackError);
  const callbackAlert = callbackMessage ? create(doc, 'p', { class: 'login-callback-error', role: 'alert' }, callbackMessage) : null;
  // Once the visitor tries again, the old error is out of date.
  const startAttempt = () => {
    callbackAlert?.remove();
    setFeedback(null);
  };

  const providerButtons = LOGIN_PROVIDERS.map(({ id, label }) => {
    const button = create(doc, 'button', { type: 'button', class: 'login-provider', 'data-provider': id }, `Continue with ${label}`);
    button.addEventListener('click', async () => {
      startAttempt();
      const result = await startOAuthSignIn(client, { provider: id, ...signIn });
      if (!result.ok) {
        setFeedback(TONE.ERROR, result.message);
      }
    });
    return button;
  });

  const parts = [
    create(doc, 'div', { class: 'login-providers' }, ...providerButtons),
    create(doc, 'p', { class: 'login-divider' }, create(doc, 'span', {}, 'or')),
    renderEmailForm(doc, { client, signIn, startAttempt, setFeedback }),
    feedback,
  ];
  if (callbackAlert) {
    parts.unshift(callbackAlert); // First, so it's the first thing read.
  }
  return create(doc, 'div', { class: 'login' }, ...parts);
}

/** The magic-link form: a labelled email field, its hint and error, and the submit button. */
function renderEmailForm(doc, { client, signIn, startAttempt, setFeedback }) {
  const input = create(doc, 'input', {
    id: EMAIL_INPUT_ID,
    class: 'login-input',
    type: 'email',
    name: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    autocapitalize: 'none',
    spellcheck: 'false',
    required: true,
    'aria-describedby': EMAIL_HINT_ID,
  });
  const fieldError = create(doc, 'p', { id: EMAIL_ERROR_ID, class: 'login-field-error', hidden: true });
  const submit = create(doc, 'button', { type: 'submit', class: 'login-submit' }, SUBMIT_LABEL);

  const showFieldError = (message) => {
    fieldError.textContent = message;
    fieldError.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', `${EMAIL_HINT_ID} ${EMAIL_ERROR_ID}`);
  };
  const clearFieldError = () => {
    fieldError.textContent = '';
    fieldError.hidden = true;
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', EMAIL_HINT_ID);
  };
  const setBusy = (busy) => {
    submit.disabled = busy;
    submit.textContent = busy ? SUBMIT_BUSY_LABEL : SUBMIT_LABEL;
    if (busy) {
      submit.setAttribute('aria-busy', 'true');
    } else {
      submit.removeAttribute('aria-busy');
    }
  };

  // novalidate: the browser's own bubble differs in every browser and some
  // screen readers miss it, so the form checks the address itself.
  const form = create(
    doc,
    'form',
    { class: 'login-email-form', novalidate: true },
    create(doc, 'label', { class: 'login-label', for: EMAIL_INPUT_ID }, 'Email address'),
    input,
    create(doc, 'p', { id: EMAIL_HINT_ID, class: 'login-hint' }, "We'll email you a link that signs you in. No password needed."),
    fieldError,
    submit
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Never a real form submission: the page would reload.
    if (submit.disabled) {
      return; // Already sending.
    }
    const checked = validateEmail(input.value);
    if (!checked.ok) {
      showFieldError(checked.message);
      input.focus();
      return;
    }
    clearFieldError();
    startAttempt();
    setBusy(true);
    const result = await sendMagicLink(client, { email: checked.email, ...signIn });
    setBusy(false);
    if (result.ok) {
      setFeedback(TONE.SUCCESS, linkSentMessage(result.email));
    } else {
      setFeedback(TONE.ERROR, result.message);
    }
  });
  return form;
}
