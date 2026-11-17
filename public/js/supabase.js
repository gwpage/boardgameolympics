/**
 * supabase.js: the single Supabase client used by the whole app (ISSUE-007).
 *
 * WHAT IT DOES
 *   - getSupabase() returns the one shared client, creating it on first use
 *     from CONFIG (config.js) and the global `supabase` (the pinned CDN
 *     bundle, ADR-006). Nothing else in the app calls createClient().
 *   - validateConfig() checks CONFIG first. A missing or placeholder URL or
 *     key, a malformed URL, or a secret key pasted in by mistake throws a
 *     SetupError. app.js shows its problems on the page with renderSetupError(),
 *     so a broken setup is never a blank page.
 *   - createCookieStorage() is the storage supabase-js saves the session
 *     through. It uses cookies instead of localStorage (SPEC § Session
 *     Management), split into numbered chunks when the session is too big
 *     for one cookie.
 *
 * SESSION COOKIES (ADR-021)
 *   - Name: the supabase-js storage key, `sb-<project-ref>-auth-token`. A
 *     session too big for one cookie is stored as `…-auth-token.0`, `.1`, …
 *     instead (a real session is usually 2 or 3 chunks).
 *   - Attributes: Path=/; Max-Age=31536000 (one year); SameSite=Lax; plus
 *     Secure on https. No Domain, so they stay on this exact host.
 *   - Lifetime: Safari caps cookies set from JavaScript at 7 days, and Chrome
 *     at 400. Every visit rewrites them, because supabase-js refreshes the
 *     session on load, so anyone who visits at least once every 7 days stays
 *     signed in on any browser. After a longer absence on Safari, they sign in
 *     again.
 *   - JavaScript can read them. HttpOnly cookies need a server to set them,
 *     and this site has none. So this is no more exposed to a cross-site
 *     scripting bug than localStorage would be. Never insert untrusted HTML.
 *   - The browser sends them with every request to this site (Cloudflare's
 *     static files, a few KB each time). Nothing reads them there. They are
 *     never sent to Supabase, which is a different site.
 *   - If cookies are blocked, or the browser drops one, the session is kept
 *     in memory for the rest of the visit and a warning is logged. Signing in
 *     still works, but it ends when the page is closed or reloaded.
 *
 * AUTH FLOW
 *   Implicit, not PKCE (ADR-021). PKCE keeps a secret in the browser that
 *   started the sign-in, so a magic link opened in a different browser, or in
 *   a mail app's built-in browser, fails. That's common on phones. With the
 *   implicit flow, the link carries the session in the URL fragment
 *   (#access_token=…). detectSessionInUrl makes supabase-js read it, save it
 *   through the cookie storage, and clear it from the address bar.
 *
 * HOW IT FITS
 *   app.js calls getSupabase() at start-up, just after the theme. Feature
 *   modules (auth.js, feed.js, …) call getSupabase() whenever they need the
 *   client. Nothing runs on import, so the test page can import this file safely.
 */

/** How long session cookies last: one year (SPEC § Session Management). Safari shortens it to 7 days; see the header. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * The longest value one cookie holds. Browsers allow 4096 bytes per cookie,
 * name included. 3000 leaves room for the name, the attributes and a chunk
 * number. Values are percent-encoded first, so every character is one byte.
 */
const MAX_COOKIE_VALUE_LENGTH = 3000;

/** Path=/ so every page on the site sees the session. Deleting a cookie needs the same Path. */
const COOKIE_PATH = '/';

/** Lax: sent on ordinary links into the site, never on cross-site requests. */
const COOKIE_SAME_SITE = 'Lax';

/** Chunk cookies are named `<key>.0`, `<key>.1`, … */
const CHUNK_SEPARATOR = '.';

/** The placeholder values in config.example.js. A config still using them was copied but never filled in. */
const PLACEHOLDER_URL = 'https://your-project.supabase.co';
const PLACEHOLDER_KEY = 'your-publishable-key-here';

/** The only key the browser may use (ADR-014). */
const PUBLISHABLE_KEY_PREFIX = 'sb_publishable_';

/** Secret keys bypass Row Level Security. One in config.js is readable by anyone who opens the site. */
const SECRET_KEY_PREFIX = 'sb_secret_';

/** Legacy anon and service_role keys are JWTs, which always start like this. They're deactivated (ADR-014). */
const LEGACY_JWT_PREFIX = 'eyJ';

/** Hosts where a plain-http Supabase URL is acceptable: a Supabase running on this computer. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

/** Where index.html loads supabase-js from (ADR-006). Named in the error when it fails to load. */
const SUPABASE_CDN_HOST = 'cdn.jsdelivr.net';

/* ------------------------------------------------------------------------- */
/* Cookie storage                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Creates a storage that keeps values in cookies, with the same methods as
 * localStorage. supabase-js uses it to save, read and remove the session.
 *
 * Values are percent-encoded (encodeURIComponent), so `;`, `=`, spaces and
 * unicode are all safe. A value too long for one cookie is split across
 * numbered chunk cookies, and every write deletes the chunks the new value
 * doesn't need.
 *
 * @param {object} [options]
 * @param {{cookie: string}} [options.cookieJar]  Anything with a `cookie` property that behaves like document.cookie (default: document).
 * @param {boolean} [options.secure]  Add the Secure attribute (default: true on https). Browsers reject Secure cookies on plain http.
 * @returns {{ getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void }}
 */
export function createCookieStorage({
  cookieJar = document,
  secure = globalThis.location?.protocol === 'https:',
} = {}) {
  // Values whose cookies the browser refused, kept for the rest of this visit
  // so sign-in still works until the page is closed. See the file header.
  const unsaved = new Map();

  const attributes = (maxAgeSeconds) =>
    [`Path=${COOKIE_PATH}`, `Max-Age=${maxAgeSeconds}`, `SameSite=${COOKIE_SAME_SITE}`, ...(secure ? ['Secure'] : [])].join(
      '; '
    );

  const writeCookie = (name, value) => {
    cookieJar.cookie = `${name}=${value}; ${attributes(SESSION_COOKIE_MAX_AGE_SECONDS)}`;
  };

  // Expiring a cookie deletes it. Path must match the one it was set with.
  const deleteCookie = (name) => {
    cookieJar.cookie = `${name}=; ${attributes(0)}`;
  };

  /** The names of the cookies that currently hold `key`: the key itself or its numbered chunks. */
  const cookieNamesFor = (key) => [...parseCookies(cookieJar.cookie).keys()].filter((name) => isCookieFor(name, key));

  /** Reads `key` from the cookies, or null. Throws URIError if a cookie is corrupted. */
  const readCookies = (key) => {
    const cookies = parseCookies(cookieJar.cookie);
    const name = cookieName(key);
    if (cookies.has(name)) {
      return decodeURIComponent(cookies.get(name));
    }
    const chunks = [];
    for (let index = 0; cookies.has(chunkName(name, index)); index += 1) {
      chunks.push(cookies.get(chunkName(name, index)));
    }
    // Join before decoding: a chunk boundary can fall inside a %XX escape or a multi-byte character.
    return chunks.length > 0 ? decodeURIComponent(chunks.join('')) : null;
  };

  /** Writes `value` as one cookie or several chunks, then deletes any of this key's cookies the new value doesn't use. */
  const writeCookies = (key, value) => {
    const name = cookieName(key);
    const chunks = splitIntoChunks(encodeURIComponent(value), MAX_COOKIE_VALUE_LENGTH);
    const names = chunks.length === 1 ? [name] : chunks.map((_, index) => chunkName(name, index));
    chunks.forEach((chunk, index) => writeCookie(names[index], chunk));
    for (const existing of cookieNamesFor(key)) {
      if (!names.includes(existing)) {
        deleteCookie(existing);
      }
    }
  };

  const removeCookies = (key) => {
    for (const name of cookieNamesFor(key)) {
      deleteCookie(name);
    }
  };

  return {
    getItem(key) {
      if (unsaved.has(key)) {
        return unsaved.get(key);
      }
      try {
        return readCookies(key);
      } catch (error) {
        // A corrupted cookie, or document.cookie throwing. supabase-js treats null as signed out.
        console.warn(`Session storage: could not read "${key}" from cookies, so treating it as signed out.`, error);
        return null;
      }
    },

    setItem(key, value) {
      const text = String(value);
      try {
        writeCookies(key, text);
        // Browsers ignore a cookie they won't store, without an error, so read it back to be sure.
        if (readCookies(key) === text) {
          unsaved.delete(key);
          return;
        }
        // Don't leave half a session for the next page load to trip over.
        removeCookies(key);
        console.warn(
          `Session storage: the browser refused the "${key}" cookie (cookies blocked?). ` +
            'Signed in until this page is closed or reloaded.'
        );
      } catch (error) {
        console.warn(
          `Session storage: could not save "${key}" to cookies. Signed in until this page is closed or reloaded.`,
          error
        );
      }
      unsaved.set(key, text);
    },

    removeItem(key) {
      unsaved.delete(key);
      try {
        removeCookies(key);
      } catch (error) {
        console.warn(`Session storage: could not delete the "${key}" cookies.`, error);
      }
    },
  };
}

/**
 * Parses document.cookie ("a=1; b=2") into a Map of name → raw value. When a
 * name appears twice (same name, different Path), the browser lists the more
 * specific path first; the first one is kept.
 */
function parseCookies(header) {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue; // A cookie with no name. This module never writes one.
    }
    const name = part.slice(0, separator).trim();
    if (!cookies.has(name)) {
      cookies.set(name, part.slice(separator + 1).trim());
    }
  }
  return cookies;
}

/** The cookie name for a storage key. supabase-js keys are already safe; encoding guards anything else. */
function cookieName(key) {
  return encodeURIComponent(key);
}

function chunkName(name, index) {
  return `${name}${CHUNK_SEPARATOR}${index}`;
}

/** True if the cookie `name` holds `key`: exactly the key's name, or the name plus `.<number>`. */
function isCookieFor(name, key) {
  const base = cookieName(key);
  if (name === base) {
    return true;
  }
  const suffix = name.startsWith(base + CHUNK_SEPARATOR) ? name.slice(base.length + CHUNK_SEPARATOR.length) : '';
  return /^\d+$/.test(suffix);
}

/** Splits `text` into pieces of at most `maxLength` characters. An empty string is one empty piece. */
function splitIntoChunks(text, maxLength) {
  const chunks = [];
  for (let start = 0; start < text.length; start += maxLength) {
    chunks.push(text.slice(start, start + maxLength));
  }
  return chunks.length > 0 ? chunks : [''];
}

/* ------------------------------------------------------------------------- */
/* Configuration                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Checks the settings from config.js.
 *
 * @param {*} config  The CONFIG object, or undefined/null if config.js didn't load.
 * @returns {string[]}  Problems, worded for whoever runs the site. Empty means valid.
 */
export function validateConfig(config) {
  if (config === undefined || config === null || typeof config !== 'object') {
    return [
      "config.js didn't load, so the site doesn't know which Supabase project to use. " +
        'Locally: copy public/config.example.js to public/config.js and fill it in. ' +
        'In production: check that the Cloudflare Pages build command is "sh scripts/write-config.sh".',
    ];
  }

  const secretFields = Object.keys(config).filter(
    (field) => typeof config[field] === 'string' && config[field].includes(SECRET_KEY_PREFIX)
  );
  const problems = secretFields.map(
    (field) =>
      `${field} holds a SECRET key (${SECRET_KEY_PREFIX}…). Remove it from config.js now: anyone who opens the ` +
      'site can read that file. Use the publishable key (sb_publishable_…). If this config was ever deployed, ' +
      'revoke that secret key in the Supabase dashboard (Project Settings → API Keys).'
  );

  const urlProblem = checkUrl(config.SUPABASE_URL);
  if (urlProblem) {
    problems.push(urlProblem);
  }
  // A secret key in the key field already has its message; don't pile on.
  const keyProblem = secretFields.includes('SUPABASE_PUBLISHABLE_KEY') ? null : checkKey(config.SUPABASE_PUBLISHABLE_KEY);
  if (keyProblem) {
    problems.push(keyProblem);
  }
  return problems;
}

/** A problem with SUPABASE_URL, or null if it's fine. */
function checkUrl(url) {
  if (isBlank(url)) {
    return 'SUPABASE_URL is missing from config.js. Set it to your project URL, like https://abcdefghijklmnop.supabase.co.';
  }
  if (url.trim() === PLACEHOLDER_URL) {
    return 'SUPABASE_URL is still the placeholder from config.example.js. Replace it with your project URL.';
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    parsed = null; // Not a URL at all; reported below.
  }
  const isHttps = parsed?.protocol === 'https:';
  const isLocalHttp = parsed?.protocol === 'http:' && LOCAL_HOSTNAMES.has(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    return 'SUPABASE_URL must be a web address starting with https://, like https://abcdefghijklmnop.supabase.co.';
  }
  return null;
}

/** A problem with SUPABASE_PUBLISHABLE_KEY, or null if it's fine. Secret keys are caught before this. */
function checkKey(key) {
  if (isBlank(key)) {
    return 'SUPABASE_PUBLISHABLE_KEY is missing from config.js. Use your project\'s publishable key (sb_publishable_…).';
  }
  const trimmed = key.trim();
  if (trimmed === PLACEHOLDER_KEY) {
    return (
      'SUPABASE_PUBLISHABLE_KEY is still the placeholder from config.example.js. ' +
      "Replace it with your project's publishable key (sb_publishable_…)."
    );
  }
  if (trimmed.startsWith(LEGACY_JWT_PREFIX)) {
    return (
      'SUPABASE_PUBLISHABLE_KEY is a legacy anon or service_role key. Those are switched off for this project, ' +
      "and service_role is a secret. Use the project's publishable key (sb_publishable_…)."
    );
  }
  if (!trimmed.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    return 'SUPABASE_PUBLISHABLE_KEY is not a publishable key: it should start with sb_publishable_.';
  }
  return null;
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/* ------------------------------------------------------------------------- */
/* The client                                                                */
/* ------------------------------------------------------------------------- */

/** Thrown when the client can't be created. `problems` holds messages ready to show on the page. */
export class SetupError extends Error {
  /**
   * @param {string[]} problems
   * @param {{cause?: *}} [options]
   */
  constructor(problems, options) {
    super(`Board Game Olympics can't start: ${problems.join(' ')}`, options);
    this.name = 'SetupError';
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * Creates a Supabase client. The app uses getSupabase() instead; this is the
 * part tests can drive with fakes.
 *
 * @param {object} [options]
 * @param {*} [options.config]           Settings (default: the CONFIG global from config.js).
 * @param {*} [options.supabaseLibrary]  supabase-js (default: the `supabase` global from the CDN bundle).
 * @param {object} [options.storage]     Where the session is saved (default: cookies).
 * @returns {object} The client.
 * @throws {SetupError} If the config is invalid, the library didn't load, or supabase-js refuses the settings.
 */
export function createSupabaseClient({
  config = globalConfig(),
  supabaseLibrary = globalSupabaseLibrary(),
  storage = createCookieStorage(),
} = {}) {
  const problems = validateConfig(config);
  if (typeof supabaseLibrary?.createClient !== 'function') {
    problems.push(
      `Part of the site (the Supabase library from ${SUPABASE_CDN_HOST}) didn't load. Check your internet ` +
        `connection; if you use a content or ad blocker, allow ${SUPABASE_CDN_HOST} for this site. Then reload.`
    );
  }
  if (problems.length > 0) {
    throw new SetupError(problems);
  }

  try {
    return supabaseLibrary.createClient(config.SUPABASE_URL.trim(), config.SUPABASE_PUBLISHABLE_KEY.trim(), {
      auth: {
        persistSession: true, // Save the session (through `storage`) so it outlives the page.
        autoRefreshToken: true, // Renew the hour-long access token before it expires; each renewal rewrites the cookies.
        detectSessionInUrl: true, // Pick up #access_token=… when a magic link or OAuth sign-in returns.
        flowType: 'implicit', // Not PKCE: see AUTH FLOW in the header.
        storage,
      },
    });
  } catch (error) {
    throw new SetupError([`Supabase couldn't start: ${error.message}`], { cause: error });
  }
}

/** The shared client, created on first call. */
let sharedClient = null;

/**
 * Returns the app's one Supabase client, creating it on the first call.
 * @throws {SetupError} See createSupabaseClient(). Nothing is cached after a failure.
 */
export function getSupabase() {
  sharedClient ??= createSupabaseClient();
  return sharedClient;
}

/*
 * config.js declares `const CONFIG` in a classic script. A top-level const is
 * global, but it is NOT a property of window, so it has to be read by name.
 * typeof is the only safe way to read a global that may not exist.
 */
function globalConfig() {
  return typeof CONFIG === 'undefined' ? null : CONFIG;
}

/** The CDN bundle declares `var supabase`, the library itself. */
function globalSupabaseLibrary() {
  return typeof supabase === 'undefined' ? null : supabase;
}

/* ------------------------------------------------------------------------- */
/* On-page error                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Shows why the site can't start, in place of whatever `container` held.
 * Problems are inserted as text, never parsed as HTML.
 *
 * @param {Element} container  Usually <main id="app">.
 * @param {string[]} problems
 */
export function renderSetupError(container, problems) {
  const doc = container.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'setup-error';
  section.setAttribute('role', 'alert');

  const heading = doc.createElement('h1');
  heading.textContent = "Board Game Olympics can't start";

  const intro = doc.createElement('p');
  intro.textContent = "Here's what went wrong:";

  const list = doc.createElement('ul');
  for (const problem of problems) {
    const item = doc.createElement('li');
    item.textContent = problem;
    list.append(item);
  }

  section.append(heading, intro, list);
  container.replaceChildren(section);
}
