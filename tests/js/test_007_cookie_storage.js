/**
 * tests/js/test_007_cookie_storage.js — ISSUE-007
 *
 * The Supabase client and the cookie storage that keeps the session across
 * browser restarts. Four groups:
 *
 *  1. createCookieStorage: the storage adapter supabase-js saves the session
 *     through. Driven through a fake cookie jar that behaves like
 *     document.cookie, plus one run against the test page's real
 *     document.cookie to prove Chrome accepts every chunk. "Survives a
 *     restart" is checked by reading back through a NEW storage on the same
 *     jar, which is what the next page load does.
 *  2. validateConfig: missing, placeholder, malformed and secret settings.
 *  3. createSupabaseClient / getSupabase: the options handed to supabase-js,
 *     with a fake library standing in for the CDN bundle. Never touches the network.
 *  4. The on-page error: renderSetupError, and boot() showing it in #app.
 */
import { assert, assertEqual, assertThrows, describe, it } from '../harness.js';
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SetupError,
  createCookieStorage,
  createSupabaseClient,
  getSupabase,
  renderSetupError,
  validateConfig,
} from '../../public/js/supabase.js';
import { boot } from '../../public/js/app.js';

/** The repo root, as served by tests/run.sh (or `python3 -m http.server` at the root). */
const REPO_ROOT = new URL('../../', import.meta.url);

/**
 * Browsers store at most 4096 bytes per cookie (RFC 6265 § 6.1; Chrome and
 * Firefox drop anything larger without an error). Defined here, not imported,
 * so the test checks the module against the browsers, not against itself.
 */
const BROWSER_COOKIE_LIMIT_BYTES = 4096;

/** One year in seconds: the lifetime SPEC § Session Management asks for. */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** The default supabase-js storage key for a project, which is also the cookie name. */
const SESSION_KEY = 'sb-abcdefghijklmnop-auth-token';

/** The size the issue's chunking test asks for. */
const TEN_KB = 10 * 1024;

/**
 * Characters allowed in a cookie value (RFC 6265 cookie-octet): printable
 * ASCII except space, double quote, comma, semicolon and backslash.
 */
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** A valid config, as config.js would define it. */
const VALID_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ABCdef123_XYZ',
});

/* ------------------------------------------------------------------------- */
/* Fakes and helpers                                                         */
/* ------------------------------------------------------------------------- */

/**
 * A stand-in for `document` that has only the `cookie` property, behaving like
 * the real one:
 *   - Reading gives "name=value; name2=value2".
 *   - Writing "name=value; Attr; Attr" stores or replaces that one cookie, and
 *     Max-Age=0 (or less) deletes it.
 * `writes` keeps every string assigned, so tests can check attributes and sizes.
 * `refuse(text)` lets a test make the jar ignore some writes, as a browser does
 * when cookies are blocked or one is too large.
 */
function createFakeCookieJar({ initial = {}, refuse = () => false } = {}) {
  const cookies = new Map(Object.entries(initial));
  const writes = [];
  return {
    cookies,
    writes,
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set cookie(text) {
      writes.push(text);
      if (refuse(text)) {
        return;
      }
      const [pair, ...attributes] = text.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const maxAge = attributes.find((attribute) => /^max-age=/i.test(attribute));
      if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    },
  };
}

/** A jar whose `cookie` property throws, like document.cookie in a sandboxed iframe. */
function createThrowingCookieJar() {
  const fail = () => {
    throw new DOMException('The document is sandboxed and lacks the allow-same-origin flag.', 'SecurityError');
  };
  return {
    get cookie() {
      return fail();
    },
    set cookie(text) {
      fail();
    },
  };
}

/** The names of the cookies in `jar` that hold `key`: the key itself or its numbered chunks. */
function cookieNamesFor(jar, key) {
  return [...jar.cookies.keys()].filter((name) => name === key || new RegExp(`^${key}\\.\\d+$`).test(name));
}

/** Parses the attributes of one written cookie string into a lower-cased name → value map. */
function parseAttributes(text) {
  const [, ...attributes] = text.split(';').map((part) => part.trim());
  return new Map(
    attributes.map((attribute) => {
      const [name, value = true] = attribute.split('=');
      return [name.toLowerCase(), value];
    })
  );
}

/** Size in bytes as the browser counts it (UTF-8). */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * A string of at least `minLength` characters that looks like a real session:
 * JSON with a long token, some punctuation and non-ASCII names.
 */
function makeSessionLikeValue(minLength) {
  const segment = JSON.stringify({
    access_token: `eyJhbGciOiJIUzI1NiJ9.${'x'.repeat(200)}.sig`,
    user: { email: 'guest@example.com', user_metadata: { full_name: 'Zoë Ångström 🎲', note: 'a=b; c d' } },
  });
  return segment.repeat(Math.ceil(minLength / segment.length));
}

/**
 * Runs `fn` with console[method] captured, so expected warnings and errors
 * don't clutter the console and can be checked. Returns the captured calls.
 */
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

/** A stand-in for the supabase-js UMD global that records createClient calls. */
function createFakeSupabaseLibrary() {
  const calls = [];
  const client = { fake: 'client' };
  return {
    calls,
    client,
    createClient(url, key, options) {
      calls.push({ url, key, options });
      return client;
    },
  };
}

/** Fetches a repo file as text, failing with a clear message if it is missing. */
async function readRepoFile(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `Expected ${path} to exist (HTTP ${response.status})`);
  return response.text();
}

/** True if any problem mentions every one of `fragments` (strings, case-insensitive). */
function someProblemMentions(problems, ...fragments) {
  return problems.some((problem) =>
    fragments.every((fragment) => problem.toLowerCase().includes(fragment.toLowerCase()))
  );
}

/* ------------------------------------------------------------------------- */
/* 1. Cookie storage                                                         */
/* ------------------------------------------------------------------------- */

describe('cookie storage: saving and reading', () => {
  it('setItem/getItem round-trip, and the value is still there for the next page load', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: true });

    storage.setItem(SESSION_KEY, '{"access_token":"abc"}');

    assertEqual(storage.getItem(SESSION_KEY), '{"access_token":"abc"}');
    // A new storage on the same jar has no memory of the write: it must come from the cookie.
    const nextPageLoad = createCookieStorage({ cookieJar: jar, secure: true });
    assertEqual(nextPageLoad.getItem(SESSION_KEY), '{"access_token":"abc"}');
    assertEqual(cookieNamesFor(jar, SESSION_KEY), [SESSION_KEY], 'a small value is one cookie named after the key');
  });

  it('getItem of a missing key returns null, even with other cookies present', () => {
    const jar = createFakeCookieJar({ initial: { theme_unrelated: '1', [`${SESSION_KEY}-user`]: 'x' } });
    const storage = createCookieStorage({ cookieJar: jar, secure: false });

    assertEqual(storage.getItem(SESSION_KEY), null);
    assertEqual(createCookieStorage({ cookieJar: createFakeCookieJar(), secure: false }).getItem(SESSION_KEY), null);
  });

  it('splits a 10 KB value into chunk cookies that each fit the browser limit, and reassembles it exactly', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    const value = makeSessionLikeValue(TEN_KB);
    assert(value.length >= TEN_KB, 'the test value is at least 10 KB');

    storage.setItem(SESSION_KEY, value);

    const names = cookieNamesFor(jar, SESSION_KEY);
    assert(names.length >= 3, `expected at least 3 chunk cookies, got ${names.length}`);
    assert(!names.includes(SESSION_KEY), 'a chunked value has no unnumbered cookie');
    names.forEach((name, index) => assertEqual(name, `${SESSION_KEY}.${index}`, 'chunks are numbered from 0 with no gaps'));
    for (const text of jar.writes) {
      // The whole string, attributes included, so it fits even in the strictest browser.
      assert(byteLength(text) <= BROWSER_COOKIE_LIMIT_BYTES, `a ${byteLength(text)}-byte cookie is over the limit`);
    }
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), value);
  });

  it('round-trips values containing ; = spaces quotes commas backslashes % and unicode, storing only cookie-safe characters', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: false });
    const value = 'a=b; c=d, "quoted" \\back\\slash 100% Zoë Ångström 日本語 🎲\nnew line';

    storage.setItem(SESSION_KEY, value);

    assertEqual(createCookieStorage({ cookieJar: jar, secure: false }).getItem(SESSION_KEY), value);
    for (const name of cookieNamesFor(jar, SESSION_KEY)) {
      assert(COOKIE_OCTETS.test(jar.cookies.get(name)), `cookie ${name} holds a character that isn't allowed in a cookie`);
    }
  });
});

describe('cookie storage: overwriting and removing', () => {
  it('overwriting a 3-chunk value with a 1-chunk value leaves no stale chunks', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    storage.setItem(SESSION_KEY, makeSessionLikeValue(TEN_KB));
    assert(cookieNamesFor(jar, SESSION_KEY).length >= 3, 'starts with at least 3 chunks');

    storage.setItem(SESSION_KEY, 'small');

    assertEqual(cookieNamesFor(jar, SESSION_KEY), [SESSION_KEY]);
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), 'small');
  });

  it('shrinking a chunked value deletes the chunks it no longer needs, and growing one removes the unnumbered cookie', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    const big = makeSessionLikeValue(TEN_KB);
    const smaller = big.slice(0, Math.ceil(big.length / 3));

    storage.setItem(SESSION_KEY, 'small');
    storage.setItem(SESSION_KEY, big);
    assert(!cookieNamesFor(jar, SESSION_KEY).includes(SESSION_KEY), 'growing into chunks removed the unnumbered cookie');
    const bigChunkCount = cookieNamesFor(jar, SESSION_KEY).length;

    storage.setItem(SESSION_KEY, smaller);

    const names = cookieNamesFor(jar, SESSION_KEY);
    assert(names.length > 1 && names.length < bigChunkCount, `expected fewer chunks than ${bigChunkCount}, got ${names.length}`);
    names.forEach((name, index) => assertEqual(name, `${SESSION_KEY}.${index}`));
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), smaller);
  });

  it('removeItem deletes every chunk, with the same Path so the browser really removes them', () => {
    const jar = createFakeCookieJar();
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    storage.setItem(SESSION_KEY, makeSessionLikeValue(TEN_KB));
    const writesBefore = jar.writes.length;

    storage.removeItem(SESSION_KEY);

    assertEqual(cookieNamesFor(jar, SESSION_KEY), []);
    assertEqual(storage.getItem(SESSION_KEY), null);
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), null);
    for (const text of jar.writes.slice(writesBefore)) {
      const attributes = parseAttributes(text);
      assertEqual(attributes.get('path'), '/', `deletion "${text}" must use Path=/`);
      assert(Number(attributes.get('max-age')) <= 0, `deletion "${text}" must expire the cookie`);
    }
    storage.removeItem(SESSION_KEY); // removing again is harmless
  });

  it('leaves other keys and unrelated cookies alone, even ones whose names start with the key', () => {
    const jar = createFakeCookieJar({ initial: { unrelated: 'keep-me' } });
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    storage.setItem(`${SESSION_KEY}-user`, 'other key');
    storage.setItem(SESSION_KEY, makeSessionLikeValue(TEN_KB));

    storage.setItem(SESSION_KEY, 'small');
    storage.removeItem(SESSION_KEY);

    assertEqual(storage.getItem(`${SESSION_KEY}-user`), 'other key');
    assertEqual(jar.cookies.get('unrelated'), 'keep-me');
  });
});

describe('cookie storage: attributes', () => {
  it('sets Path=/, SameSite=Lax and a one-year Max-Age on every cookie, and Secure only on https', () => {
    assertEqual(SESSION_COOKIE_MAX_AGE_SECONDS, ONE_YEAR_SECONDS);

    for (const secure of [true, false]) {
      const jar = createFakeCookieJar();
      const storage = createCookieStorage({ cookieJar: jar, secure });
      storage.setItem(SESSION_KEY, makeSessionLikeValue(TEN_KB)); // several cookies, so every chunk is checked
      storage.setItem(`${SESSION_KEY}-small`, 'x');

      assert(jar.writes.length > 2, 'wrote several cookies');
      for (const text of jar.writes) {
        const attributes = parseAttributes(text);
        assertEqual(attributes.get('path'), '/', text);
        assertEqual(attributes.get('samesite'), 'Lax', text);
        assertEqual(attributes.get('max-age'), String(ONE_YEAR_SECONDS), text);
        assertEqual(attributes.has('secure'), secure, `Secure ${secure ? 'missing on https' : 'set on http'}: ${text}`);
        assert(!attributes.has('domain'), 'no Domain attribute, so the cookie stays on this exact host');
      }
    }
  });
});

describe('cookie storage: when cookies fail', () => {
  it('keeps the session in memory for this visit when the browser refuses cookies, and warns', async () => {
    const jar = createFakeCookieJar({ refuse: () => true });
    const storage = createCookieStorage({ cookieJar: jar, secure: true });

    const warnings = await captureConsole('warn', () => storage.setItem(SESSION_KEY, 'session'));

    assert(warnings.length > 0, 'a refused cookie logs a warning');
    assertEqual(storage.getItem(SESSION_KEY), 'session', 'sign-in still works until the page is closed');
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), null);
    storage.removeItem(SESSION_KEY);
    assertEqual(storage.getItem(SESSION_KEY), null, 'removeItem clears the in-memory copy too');
  });

  it('leaves no half-written value behind when the browser drops one chunk', async () => {
    // Refuse only the second chunk, as a browser does when a cookie hits a limit.
    const jar = createFakeCookieJar({ refuse: (text) => text.startsWith(`${SESSION_KEY}.1=`) });
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    const value = makeSessionLikeValue(TEN_KB);

    const warnings = await captureConsole('warn', () => storage.setItem(SESSION_KEY, value));

    assert(warnings.length > 0, 'a dropped chunk logs a warning');
    assertEqual(storage.getItem(SESSION_KEY), value, 'this visit still has the whole value');
    assertEqual(cookieNamesFor(jar, SESSION_KEY), [], 'the chunks that did save were cleaned up');
    assertEqual(createCookieStorage({ cookieJar: jar, secure: true }).getItem(SESSION_KEY), null);
  });

  it('never throws when document.cookie itself throws (sandboxed page), and warns', async () => {
    const storage = createCookieStorage({ cookieJar: createThrowingCookieJar(), secure: true });
    let readBack;

    const warnings = await captureConsole('warn', () => {
      assertEqual(storage.getItem(SESSION_KEY), null);
      storage.setItem(SESSION_KEY, 'session');
      readBack = storage.getItem(SESSION_KEY);
      storage.removeItem(SESSION_KEY);
    });

    assertEqual(readBack, 'session');
    assertEqual(storage.getItem(SESSION_KEY), null);
    assert(warnings.length > 0, 'the failures are logged');
  });

  it('reads a corrupted cookie as no session instead of throwing, and warns', async () => {
    const jar = createFakeCookieJar({ initial: { [SESSION_KEY]: '%E0%A4%A' } }); // a broken % escape
    const storage = createCookieStorage({ cookieJar: jar, secure: true });
    let value;

    const warnings = await captureConsole('warn', () => {
      value = storage.getItem(SESSION_KEY);
    });

    assertEqual(value, null);
    assert(warnings.length > 0, 'the corrupted cookie is logged');
  });
});

describe('cookie storage: real browser', () => {
  it("round-trips a 10 KB value through this page's real document.cookie, then removes every chunk", () => {
    const key = `bgo-test-007-${Date.now()}`;
    const storage = createCookieStorage({ cookieJar: document, secure: false });
    const value = makeSessionLikeValue(TEN_KB);
    const ownCookieNames = () =>
      document.cookie
        .split(';')
        .map((part) => part.trim().split('=')[0])
        .filter((name) => name === key || name.startsWith(`${key}.`));
    try {
      storage.setItem(key, value);

      assert(ownCookieNames().length >= 3, 'Chrome stored every chunk');
      assertEqual(createCookieStorage({ cookieJar: document, secure: false }).getItem(key), value);

      storage.removeItem(key);
      assertEqual(ownCookieNames(), []);
    } finally {
      // Clean up even if an assertion failed, so later tests and runs start clean.
      for (const name of ownCookieNames()) {
        document.cookie = `${name}=; Path=/; Max-Age=0`;
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 2. validateConfig                                                         */
/* ------------------------------------------------------------------------- */

describe('validateConfig', () => {
  it('accepts a project URL and a publishable key', () => {
    assertEqual(validateConfig(VALID_CONFIG), []);
    assertEqual(validateConfig({ ...VALID_CONFIG, SUPABASE_URL: 'http://localhost:54321' }), [], 'plain http is fine on localhost');
  });

  it('explains that config.js did not load when CONFIG is missing', () => {
    for (const missing of [undefined, null]) {
      const problems = validateConfig(missing);
      assert(problems.length > 0, `rejects ${missing}`);
      // The exact phrase README's troubleshooting table tells people to look for.
      assert(someProblemMentions(problems, "config.js didn't load"), 'says config.js did not load');
    }
  });

  it('rejects a missing or blank URL and key, naming each setting', () => {
    for (const blank of [undefined, '', '   ', 42]) {
      const problems = validateConfig({ SUPABASE_URL: blank, SUPABASE_PUBLISHABLE_KEY: blank });
      assert(someProblemMentions(problems, 'SUPABASE_URL'), `URL ${JSON.stringify(blank)} rejected`);
      assert(someProblemMentions(problems, 'SUPABASE_PUBLISHABLE_KEY'), `key ${JSON.stringify(blank)} rejected`);
    }
  });

  it("rejects config.example.js's placeholder URL and key", async () => {
    const source = await readRepoFile('public/config.example.js');
    // Evaluated inside a function so its global const stays out of this page.
    const placeholder = new Function(`${source}\nreturn CONFIG;`)();

    const problems = validateConfig(placeholder);

    assert(someProblemMentions(problems, 'SUPABASE_URL', 'placeholder'), 'URL placeholder rejected');
    assert(someProblemMentions(problems, 'SUPABASE_PUBLISHABLE_KEY', 'placeholder'), 'key placeholder rejected');
  });

  it('rejects a URL that is not a web address, or plain http away from localhost', () => {
    for (const url of ['abcdefghijklmnop.supabase.co', 'ftp://abcdefghijklmnop.supabase.co', 'http://abcdefghijklmnop.supabase.co']) {
      const problems = validateConfig({ ...VALID_CONFIG, SUPABASE_URL: url });
      assert(someProblemMentions(problems, 'SUPABASE_URL'), `${url} rejected`);
    }
  });

  it('rejects a secret key (sb_secret_…) and says it is secret, in the key field or any other', () => {
    const inKeyField = validateConfig({ ...VALID_CONFIG, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc123' });
    assert(someProblemMentions(inKeyField, 'SUPABASE_PUBLISHABLE_KEY', 'secret'), 'secret key in the key field rejected');
    assertEqual(inKeyField.length, 1, 'one clear message, not a pile');

    const inExtraField = validateConfig({ ...VALID_CONFIG, SUPABASE_SECRET_KEY: 'sb_secret_abc123' });
    assert(someProblemMentions(inExtraField, 'SUPABASE_SECRET_KEY', 'secret'), 'secret key in an extra field rejected');
  });

  it('rejects a legacy JWT key and anything else that is not a publishable key', () => {
    const legacy = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature';
    for (const key of [legacy, 'just-some-text']) {
      const problems = validateConfig({ ...VALID_CONFIG, SUPABASE_PUBLISHABLE_KEY: key });
      assert(someProblemMentions(problems, 'SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_'), `${key} rejected`);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 3. createSupabaseClient / getSupabase                                     */
/* ------------------------------------------------------------------------- */

describe('createSupabaseClient', () => {
  it('passes the URL, key and session options (implicit flow, cookie storage) to supabase-js', () => {
    const library = createFakeSupabaseLibrary();
    const storage = createCookieStorage({ cookieJar: createFakeCookieJar(), secure: true });

    const client = createSupabaseClient({ config: VALID_CONFIG, supabaseLibrary: library, storage });

    assertEqual(client, library.client);
    assertEqual(library.calls.length, 1);
    const { url, key, options } = library.calls[0];
    assertEqual(url, VALID_CONFIG.SUPABASE_URL);
    assertEqual(key, VALID_CONFIG.SUPABASE_PUBLISHABLE_KEY);
    assertEqual(options.auth.persistSession, true);
    assertEqual(options.auth.autoRefreshToken, true);
    assertEqual(options.auth.detectSessionInUrl, true);
    assertEqual(options.auth.flowType, 'implicit');
    assert(options.auth.storage === storage, 'the session is stored through the cookie storage');
  });

  it('throws a SetupError listing every problem, without calling supabase-js, when the config is bad', () => {
    const library = createFakeSupabaseLibrary();
    const storage = createCookieStorage({ cookieJar: createFakeCookieJar(), secure: true });

    const error = assertThrows(
      () => createSupabaseClient({ config: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' }, supabaseLibrary: library, storage }),
      SetupError
    );

    assert(someProblemMentions(error.problems, 'SUPABASE_URL'), 'lists the URL problem');
    assert(someProblemMentions(error.problems, 'SUPABASE_PUBLISHABLE_KEY'), 'lists the key problem');
    assertEqual(library.calls.length, 0);
  });

  it('throws a SetupError when the Supabase library did not load (CDN blocked or integrity mismatch)', () => {
    const storage = createCookieStorage({ cookieJar: createFakeCookieJar(), secure: true });

    for (const missing of [null, {}]) {
      const error = assertThrows(
        () => createSupabaseClient({ config: VALID_CONFIG, supabaseLibrary: missing, storage }),
        SetupError
      );
      assert(someProblemMentions(error.problems, 'cdn.jsdelivr.net'), 'says where the library comes from');
    }
  });

  it('turns an error thrown by supabase-js into a SetupError that keeps the original as its cause', () => {
    const original = new Error('Invalid supabaseUrl: Provided URL is malformed.');
    const library = {
      createClient() {
        throw original;
      },
    };
    const storage = createCookieStorage({ cookieJar: createFakeCookieJar(), secure: true });

    const error = assertThrows(() => createSupabaseClient({ config: VALID_CONFIG, supabaseLibrary: library, storage }), SetupError);

    assert(error.cause === original, 'the original error is kept as the cause');
    assert(someProblemMentions(error.problems, 'Provided URL is malformed'), 'shows what supabase-js said');
  });
});

describe('getSupabase', () => {
  it('builds one shared client from the CONFIG and supabase globals, storing the session in real cookies', () => {
    const library = createFakeSupabaseLibrary();
    const key = `bgo-test-007-default-${Date.now()}`;
    globalThis.CONFIG = VALID_CONFIG;
    globalThis.supabase = library;
    try {
      const first = getSupabase();
      const second = getSupabase();

      assert(first === library.client && second === first, 'the same client both times');
      assertEqual(library.calls.length, 1, 'supabase-js is called only once');
      // The default storage writes to document.cookie, not localStorage.
      const { storage } = library.calls[0].options.auth;
      storage.setItem(key, 'value');
      assert(document.cookie.includes(`${key}=value`), 'the default storage writes a cookie');
      storage.removeItem(key);
      assert(!document.cookie.includes(key), 'and removes it');
    } finally {
      delete globalThis.CONFIG;
      delete globalThis.supabase;
      document.cookie = `${key}=; Path=/; Max-Age=0`;
    }
  });

  it('reads CONFIG and supabase declared by classic scripts, exactly as config.js (a top-level const) and the CDN bundle do', async () => {
    // A top-level `const` in a classic script is global but NOT a property of
    // window, so the test above (which sets globalThis.CONFIG) can't catch code
    // that reads window.CONFIG. This runs the module in a throwaway iframe
    // whose classic scripts declare the globals for real; removing the iframe
    // removes them.
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    document.body.append(iframe);
    try {
      const frameWindow = iframe.contentWindow;
      const frameDocument = iframe.contentDocument;
      const globals = frameDocument.createElement('script');
      globals.textContent =
        `const CONFIG = ${JSON.stringify(VALID_CONFIG)};\n` +
        'var supabase = { createClient: (url, key) => ({ url, key }) };';
      frameDocument.head.append(globals);

      const moduleUrl = new URL('../../public/js/supabase.js', import.meta.url).href;
      const result = await new Promise((resolve) => {
        frameWindow.__report = resolve;
        const runner = frameDocument.createElement('script');
        runner.type = 'module';
        runner.textContent =
          `import { getSupabase } from ${JSON.stringify(moduleUrl)};\n` +
          'try { window.__report({ client: getSupabase() }); }\n' +
          'catch (error) { window.__report({ error: String(error) }); }';
        frameDocument.head.append(runner);
      });

      assertEqual(result.error, undefined, 'getSupabase() threw');
      // Field by field: the client was made in the iframe's realm, so it isn't a plain object of this page.
      assertEqual(result.client.url, VALID_CONFIG.SUPABASE_URL);
      assertEqual(result.client.key, VALID_CONFIG.SUPABASE_PUBLISHABLE_KEY);
    } finally {
      iframe.remove();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 4. The on-page error                                                      */
/* ------------------------------------------------------------------------- */

describe('setup error on the page', () => {
  it('renderSetupError replaces the loading text with an alert listing each problem, as text not HTML', () => {
    const container = document.createElement('main');
    container.textContent = 'Loading…';
    const problems = ['SUPABASE_URL is missing.', 'Key is <img src=x onerror="window.__xss = true">.'];

    renderSetupError(container, problems);

    const alert = container.querySelector('[role="alert"]');
    assert(alert, 'has role="alert" so screen readers announce it');
    assert(alert.querySelector('h1, h2'), 'has a heading');
    assertEqual([...alert.querySelectorAll('li')].map((item) => item.textContent), problems);
    assertEqual(container.querySelector('img'), null, 'problem text is never parsed as HTML');
    assert(!container.textContent.includes('Loading'), 'the loading text is gone');
  });

  it('boot() shows the setup error in #app instead of leaving the page blank, and logs it', async () => {
    const appRoot = document.createElement('main');
    appRoot.textContent = 'Loading…';
    const problems = ['SUPABASE_URL is still the placeholder from config.example.js.'];
    let result;

    const errors = await captureConsole('error', () => {
      result = boot({
        startTheme: () => {},
        getClient: () => {
          throw new SetupError(problems);
        },
        appRoot,
      });
    });

    assertEqual(result, null);
    assert(appRoot.querySelector('[role="alert"]'), 'the error is shown');
    assert(appRoot.textContent.includes(problems[0]), 'with the problem');
    assert(errors.length > 0, 'and logged to the console');
  });

  it('boot() starts the theme, then the client, and leaves #app alone when the client starts', () => {
    const appRoot = document.createElement('main');
    appRoot.textContent = 'Loading…';
    const client = { fake: 'client' };
    const order = [];

    const result = boot({
      startTheme: () => order.push('theme'),
      getClient: () => {
        order.push('client');
        return client;
      },
      appRoot,
    });

    assert(result === client, 'returns the client');
    assertEqual(order, ['theme', 'client'], 'theme first, so the toggle works even if Supabase fails');
    assertEqual(appRoot.textContent, 'Loading…');
  });

  it('boot() lets unexpected errors (bugs) propagate rather than hiding them', () => {
    const appRoot = document.createElement('main');
    appRoot.textContent = 'Loading…';
    // RangeError, not TypeError: mishandling it tends to throw a TypeError of its own, which would hide the bug here.
    const bug = new RangeError('a bug');

    const thrown = assertThrows(
      () =>
        boot({
          startTheme: () => {},
          getClient: () => {
            throw bug;
          },
          appRoot,
        }),
      RangeError
    );

    assert(thrown === bug, 'the original error comes through unchanged');
    assertEqual(appRoot.textContent, 'Loading…', 'a bug is not shown as a setup error');
  });
});
