/**
 * tests/js/test_010_landing.js: the public landing page (ISSUE-010, ADR-024).
 *
 * Covers:
 *  1. public/js/landing.js: the event date from get_public_event_info()
 *     ("Date TBA" when there's none or the call fails), the page's content,
 *     placeholder marking, and the login button.
 *  2. "No queries beyond that RPC": a recording client logs every call made
 *     on it, whatever the method, both for the landing view alone and for a
 *     signed-out visit through startApp().
 *  3. public/index.html's <head>: title, description, Open Graph and Twitter
 *     card tags, icons, and the files they point to.
 *
 * The date tests run in all three of run.sh's time zones (ADR-022), so
 * "Saturday, February 15, 2025" is checked at UTC+14 and UTC−12 as well.
 */

import { describe, it, assert, assertEqual } from '../harness.js';
import { DATE_TBA, LANDING_COPY, LANDING_LOGO_PATH, loadPublicEventDate, renderLanding } from '../../public/js/landing.js';
import { SITE_NAME, startApp } from '../../public/js/app.js';
import { VIEW } from '../../public/js/router.js';

/** The repo root, as served by tests/run.sh. */
const REPO_ROOT = new URL('../../', import.meta.url);

/** The 2025 event, as get_public_event_info() returns it through maybeSingle(). */
const EVENT_2025 = Object.freeze({ year: 2025, event_date: '2025-02-15' });

/** What every link preview needs: a 1200 × 630 image (Open Graph's recommended size). */
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

/** The production site (the Boss, 2026-11-16). Link previews must point here. */
const PRODUCTION_ORIGIN = 'https://boardgameolympics.net';

/** The landing logo must stay small: logo.png itself is 2.4 MB, far too much for a phone. */
const MAX_LANDING_LOGO_BYTES = 400 * 1024;

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

/** Records console.warn and console.error calls while `fn` runs. */
async function captureWarningsAndErrors(fn) {
  const logged = [];
  const errors = await captureConsole('error', async () => {
    logged.push(...(await captureConsole('warn', fn)).map((args) => ['warn', ...args]));
  });
  return [...logged, ...errors.map((args) => ['error', ...args])];
}

/**
 * A stand-in Supabase client that records EVERY call made on it, on any
 * property path: client.from('users').select('*') is recorded as
 * 'from("users")' then 'from().select("*")'. Unknown calls return another
 * recorder, so code under test keeps running and every call shows up.
 *
 * Only these answer for real:
 *   rpc(name)                  → a builder whose maybeSingle() resolves to `eventInfo`
 *                                 (an object, or a function returning a promise);
 *   auth.getSession()          → no session;
 *   auth.onAuthStateChange()   → a subscription.
 */
function createRecordingClient({ eventInfo = { data: null, error: null } } = {}) {
  const calls = [];
  const answers = {
    rpc: () => ({
      maybeSingle(...args) {
        calls.push(`rpc().maybeSingle(${args.map((arg) => JSON.stringify(arg)).join(', ')})`);
        return typeof eventInfo === 'function' ? eventInfo() : Promise.resolve(eventInfo);
      },
    }),
    'auth.getSession': () => Promise.resolve({ data: { session: null }, error: null }),
    'auth.onAuthStateChange': () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const recorder = (path) =>
    new Proxy(function recorded() {}, {
      get(target, property) {
        // Not a promise, and not convertible: only real method calls are recorded.
        if (typeof property === 'symbol' || property === 'then') {
          return undefined;
        }
        return recorder(path ? `${path}.${property}` : property);
      },
      apply(target, thisArg, args) {
        calls.push(`${path}(${args.map((arg) => (typeof arg === 'function' ? 'fn' : JSON.stringify(arg))).join(', ')})`);
        return answers[path] ? answers[path](...args) : recorder(`${path}()`);
      },
    });
  return { client: recorder(''), calls };
}

/** Renders the landing view with a recording client and waits for the date to arrive. */
async function renderWith(eventInfo) {
  const { client, calls } = createRecordingClient({ eventInfo });
  const view = renderLanding({ doc: document, client });
  await settle();
  return { view, calls };
}

function dateText(view) {
  return view.querySelector('.landing-date').textContent.trim();
}

async function readRepoFile(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `fetch ${path}: HTTP ${response.status}`);
  return response.text();
}

async function parseIndexHead() {
  return new DOMParser().parseFromString(await readRepoFile('public/index.html'), 'text/html');
}

function metaContent(doc, selector) {
  return doc.querySelector(selector)?.getAttribute('content') ?? null;
}

/** Decodes an image from the repo and returns its size and byte count. */
async function inspectImage(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `fetch ${path}: HTTP ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return { width: bitmap.width, height: bitmap.height, bytes: blob.size, type: blob.type };
}

/* ------------------------------------------------------------------------- */
/* 1. landing.js                                                             */
/* ------------------------------------------------------------------------- */

describe('landing: the event date', () => {
  it('renders the date from get_public_event_info, in every time zone', async () => {
    const { view } = await renderWith({ data: EVENT_2025, error: null });
    assertEqual(dateText(view), 'Saturday, February 15, 2025');
    assertEqual(view.querySelector('.landing-date time')?.getAttribute('datetime'), '2025-02-15', 'a <time> with the machine-readable date');
  });

  it('shows "Date TBA" when there is no event yet (no row), quietly: that is normal, not an error', async () => {
    let view;
    const logged = await captureWarningsAndErrors(async () => {
      ({ view } = await renderWith({ data: null, error: null }));
    });
    assertEqual(dateText(view), DATE_TBA);
    assertEqual(DATE_TBA, 'Date TBA');
    assertEqual(logged, []);
  });

  it('shows "Date TBA", quietly, when the event has no date', async () => {
    let view;
    const logged = await captureWarningsAndErrors(async () => {
      ({ view } = await renderWith({ data: { year: 2026, event_date: null }, error: null }));
    });
    assertEqual(dateText(view), DATE_TBA);
    assertEqual(logged, []);
  });

  it('shows "Date TBA", with a warning, when the call returns an error', async () => {
    let view;
    const warnings = await captureConsole('warn', async () => {
      ({ view } = await renderWith({ data: null, error: { message: 'Failed to fetch', code: '' } }));
    });
    assertEqual(dateText(view), DATE_TBA);
    assertEqual(warnings.length, 1);
  });

  it('shows "Date TBA", with an error logged, when the call throws or the date is malformed', async () => {
    for (const eventInfo of [
      () => Promise.reject(new TypeError('network down')),
      { data: { year: 2025, event_date: '15/02/2025' }, error: null },
    ]) {
      let view;
      const errors = await captureConsole('error', async () => {
        ({ view } = await renderWith(eventInfo));
      });
      assertEqual(dateText(view), DATE_TBA);
      assertEqual(errors.length, 1);
    }
  });

  it('says it is loading until the call answers, then shows the date', async () => {
    const answer = deferred();
    const { client } = createRecordingClient({ eventInfo: () => answer.promise });
    const view = renderLanding({ doc: document, client });
    await settle();
    const dateLine = view.querySelector('.landing-date');
    assertEqual(dateLine.getAttribute('aria-busy'), 'true');
    assert(![DATE_TBA, 'Saturday, February 15, 2025'].includes(dateText(view)), `still loading: "${dateText(view)}"`);

    answer.resolve({ data: EVENT_2025, error: null });
    await settle();
    assertEqual(dateText(view), 'Saturday, February 15, 2025');
    assertEqual(dateLine.hasAttribute('aria-busy'), false);
  });

  it('loadPublicEventDate never rejects: it returns the date and its text, or TBA', async () => {
    const found = createRecordingClient({ eventInfo: { data: EVENT_2025, error: null } });
    assertEqual(await loadPublicEventDate(found.client), { date: '2025-02-15', text: 'Saturday, February 15, 2025' });

    const failing = createRecordingClient({ eventInfo: () => Promise.reject(new Error('boom')) });
    let result;
    await captureConsole('error', async () => {
      result = await loadPublicEventDate(failing.client);
    });
    assertEqual(result, { date: null, text: DATE_TBA });
  });
});

describe('landing: queries', () => {
  it('the landing view calls get_public_event_info().maybeSingle() and nothing else', async () => {
    const { calls } = await renderWith({ data: EVENT_2025, error: null });
    assertEqual(calls, ['rpc("get_public_event_info")', 'rpc().maybeSingle()']);
  });

  it('a signed-out visit through startApp makes no query beyond that RPC', async () => {
    const { client, calls } = createRecordingClient({ eventInfo: { data: EVENT_2025, error: null } });
    const appRoot = document.createElement('main');
    const nav = document.createElement('nav');
    const logoutButton = document.createElement('button');
    const win = {
      location: { hash: '', pathname: '/public/', search: '', href: 'https://bgo.example/public/' },
      history: { state: null, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    };
    const app = await startApp({ client, appRoot, nav, logoutButton, win, doc: { title: '' } });
    try {
      await settle();
      assertEqual(appRoot.querySelector('[data-view]')?.dataset.view, VIEW.LANDING);
      const queries = calls.filter((call) => !call.startsWith('auth.'));
      assertEqual(queries, ['rpc("get_public_event_info")', 'rpc().maybeSingle()']);
      assertEqual(calls.filter((call) => call.startsWith('auth.')), ['auth.getSession()', 'auth.onAuthStateChange(fn)'], 'auth: the session check and the sign-in listener, no requests of its own');
    } finally {
      app.stop();
    }
  });
});

describe('landing: content', () => {
  it('shows the logo, event name, tagline, date, location, description and a login/register button', async () => {
    const { view } = await renderWith({ data: EVENT_2025, error: null });
    assertEqual(view.dataset.view, VIEW.LANDING);

    const logo = view.querySelector('img.landing-logo');
    assert(logo, 'a logo');
    assertEqual(logo.getAttribute('src'), LANDING_LOGO_PATH);
    assert(logo.hasAttribute('width') && logo.hasAttribute('height'), 'with its size, so the page does not jump when it loads');

    assertEqual(view.querySelector('h1')?.textContent, LANDING_COPY.eventName.text, 'the event name is the page heading');
    for (const part of ['tagline', 'location', 'description']) {
      const element = view.querySelector(`.landing-${part}`);
      assert(element && element.textContent.trim() !== '', `has a ${part}`);
    }
    assertEqual(dateText(view), 'Saturday, February 15, 2025');
    const button = view.querySelector('button.landing-login-button');
    assert(button, 'a login/register button');
    assert(/log in/i.test(button.textContent) && /register/i.test(button.textContent), `labelled for both: "${button.textContent}"`);
  });

  it('copy waiting for CONTENT_CHECKLIST is visibly marked as a placeholder, and tagged data-placeholder', async () => {
    const { view } = await renderWith({ data: null, error: null });
    const entries = Object.entries(LANDING_COPY);
    assert(entries.some(([, entry]) => entry.placeholder), 'some copy is still a placeholder (tagline, description, location)');
    for (const [name, entry] of entries) {
      const element = view.querySelector(`[data-copy="${name}"]`);
      assert(element, `${name} is rendered`);
      assertEqual(element.hasAttribute('data-placeholder'), entry.placeholder, `${name}: data-placeholder matches LANDING_COPY`);
      assertEqual(element.textContent.startsWith('[Placeholder'), entry.placeholder, `${name}: visibly marked only while a placeholder`);
      assert(element.textContent.includes(entry.text), `${name} shows its text`);
    }
  });

  it('a date that is not YYYY-MM-DD never reaches the page, even one that looks like HTML', async () => {
    let view;
    await captureConsole('error', async () => {
      ({ view } = await renderWith({ data: { year: 2025, event_date: '<img src=x onerror="window.__xss=1">' }, error: null }));
    });
    assertEqual(dateText(view), DATE_TBA);
    assertEqual(view.querySelectorAll('img').length, 1, 'only the logo');
  });
});

describe('landing: the login button', () => {
  it('opens the login options, and closes them again', async () => {
    const { view } = await renderWith({ data: null, error: null });
    const button = view.querySelector('button.landing-login-button');
    const options = view.querySelector(`#${button.getAttribute('aria-controls')}`);

    assertEqual(button.getAttribute('type'), 'button');
    assert(options, 'aria-controls names the login options');
    assertEqual(button.getAttribute('aria-expanded'), 'false');
    assertEqual(options.hidden, true, 'closed to start with');

    button.click();
    assertEqual(button.getAttribute('aria-expanded'), 'true');
    assertEqual(options.hidden, false, 'open');
    assert(options.textContent.trim() !== '', 'with something in it (ISSUE-011 fills in the options)');

    button.click();
    assertEqual(button.getAttribute('aria-expanded'), 'false');
    assertEqual(options.hidden, true, 'closed again');
  });
});

describe('landing: assets', () => {
  it('the landing logo is a web-sized copy of the logo, under 400 KB', async () => {
    const logo = await inspectImage(`public/${LANDING_LOGO_PATH}`);
    assert(logo.bytes <= MAX_LANDING_LOGO_BYTES, `${logo.bytes} bytes`);
    assert(logo.width >= 720, `wide enough to be sharp on a phone's high-density screen: ${logo.width}px`);
  });
});

/* ------------------------------------------------------------------------- */
/* 3. index.html <head>                                                      */
/* ------------------------------------------------------------------------- */

describe('landing: index.html <head>', () => {
  it('has a <title> matching SITE_NAME, so the tab text doesn\'t change when app.js takes over', async () => {
    const doc = await parseIndexHead();
    assertEqual(doc.querySelector('head > title')?.textContent, SITE_NAME);
  });

  it('has a meta description and the Open Graph tags: og:title, og:description, og:image, og:url', async () => {
    const doc = await parseIndexHead();
    for (const selector of [
      'meta[name="description"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:image"]',
      'meta[property="og:url"]',
      'meta[property="og:type"]',
    ]) {
      const content = metaContent(doc, `head > ${selector}`);
      assert(content && content.trim() !== '', `${selector} has content`);
    }
  });

  it('og:url and og:image are absolute https URLs on the production site, as link previews require', async () => {
    const doc = await parseIndexHead();
    const url = new URL(metaContent(doc, 'meta[property="og:url"]'));
    const image = new URL(metaContent(doc, 'meta[property="og:image"]'));
    assertEqual(url.origin, PRODUCTION_ORIGIN);
    assertEqual(url.pathname, '/', 'the site root');
    assertEqual(image.origin, PRODUCTION_ORIGIN);
  });

  it('og:image is a real 1200 × 630 image in public/, and og:image:width/height say so', async () => {
    const doc = await parseIndexHead();
    const imagePath = new URL(metaContent(doc, 'meta[property="og:image"]')).pathname.replace(/^\//, '');
    const image = await inspectImage(`public/${imagePath}`);
    assertEqual([image.width, image.height], [OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT]);
    assertEqual(metaContent(doc, 'meta[property="og:image:width"]'), String(OG_IMAGE_WIDTH));
    assertEqual(metaContent(doc, 'meta[property="og:image:height"]'), String(OG_IMAGE_HEIGHT));
    assert(metaContent(doc, 'meta[property="og:image:alt"]'), 'og:image:alt describes it');
  });

  it('has a Twitter card that uses the large image', async () => {
    const doc = await parseIndexHead();
    assertEqual(metaContent(doc, 'head > meta[name="twitter:card"]'), 'summary_large_image');
  });

  it('has a favicon and an apple-touch-icon, and both files exist', async () => {
    const doc = await parseIndexHead();
    for (const selector of ['link[rel="icon"]', 'link[rel="apple-touch-icon"]']) {
      const href = doc.querySelector(`head > ${selector}`)?.getAttribute('href');
      assert(href, `${selector} is present`);
      const response = await fetch(new URL(`public/${href}`, REPO_ROOT));
      assert(response.ok, `${selector}: public/${href} exists`);
    }
  });

  it('placeholder tags are marked data-placeholder, so they can be found before launch', async () => {
    const doc = await parseIndexHead();
    const placeholders = [...doc.querySelectorAll('head [data-placeholder]')].map(
      (element) => element.getAttribute('name') ?? element.getAttribute('property')
    );
    assert(placeholders.includes('description'), `the description is a placeholder until CONTENT_CHECKLIST § Meta / SEO arrives: ${placeholders}`);
    assert(!placeholders.includes('og:url') && !placeholders.includes('og:image'), 'the domain is real, so its tags are not placeholders');
  });
});
