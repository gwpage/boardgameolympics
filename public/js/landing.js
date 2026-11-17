/**
 * landing.js: the public landing page, shown to logged-out visitors on every
 * route (ISSUE-010, ADR-024; SPEC § Logged-Out View).
 *
 * SPEC DEVIATION: SPEC § Project Structure has no landing.js; the landing page
 * would otherwise sit in app.js. It has its own copy, date loading and login
 * button, so it gets its own file, as the spec allows.
 *
 * WHAT IT SHOWS
 *   The logo, event name, tagline, event date, location, description, and a
 *   "Log in or register" button that opens the login options. Nothing else:
 *   no feed, no messages, no member data.
 *
 * THE DATE
 *   Signed-out visitors can't read any table. The one thing they can call is
 *   get_public_event_info() (ADR-016), which returns the current year and its
 *   date, or no row before any event exists. That is the page's only query.
 *   No row, no date, or a failed call all show "Date TBA".
 *
 * PLACEHOLDER COPY
 *   LANDING_COPY holds the text. Entries with `placeholder: true` are waiting
 *   for CONTENT_CHECKLIST.md § Copy — Landing Page. They show in square
 *   brackets ("[Placeholder: …]") and carry data-placeholder, so none can slip
 *   into production unnoticed. To deliver copy, replace the text and set
 *   `placeholder: false`.
 *
 * HOW IT FITS
 *   app.js's VIEWS table calls renderLanding() with the view context
 *   ({ doc, client, … }). The header, logo link and theme toggle are static in
 *   index.html, not here. The meta and Open Graph tags are in index.html too,
 *   because link previews and search engines don't run JavaScript.
 */

import { createElement as create, formatEventDate } from './util.js';
import { VIEW } from './router.js';

/** Shown when there's no event date to show. */
export const DATE_TBA = 'Date TBA';

/** Shown while get_public_event_info() is on its way. */
const DATE_LOADING = 'Checking the date…';

/** The landing logo: a 960 px wide copy of logo.png (2.4 MB), about 300 KB. Relative to index.html. */
export const LANDING_LOGO_PATH = 'assets/images/logo-landing.png';
const LANDING_LOGO_WIDTH = 960;
const LANDING_LOGO_HEIGHT = 640;

/** The only call this page makes (ADR-016). */
const PUBLIC_EVENT_INFO_RPC = 'get_public_event_info';

/** id of the login options panel the button opens. */
const LOGIN_OPTIONS_ID = 'login-options';

/**
 * The landing page's words. See PLACEHOLDER COPY in the header.
 * eventName is the site name already used everywhere; CONTENT_CHECKLIST asks
 * the Boss to confirm it, and whether to add the year.
 */
export const LANDING_COPY = deepFreeze({
  eventName: { text: 'Board Game Olympics', placeholder: false },
  tagline: { text: 'An annual showdown of strategy, luck, and glory.', placeholder: true },
  location: { text: 'Where the event is held: an address, a city, or just the area', placeholder: true },
  description: {
    text: "Two or three sentences on what Board Game Olympics is, who it's for, and why it's fun. Uninvited visitors see this too.",
    placeholder: true,
  },
});

/**
 * Fetches the event date for signed-out visitors.
 *
 * @param {object} client  The Supabase client (signed in or not).
 * @returns {Promise<{date: string|null, text: string}>}
 *   `date` is the YYYY-MM-DD from the database, or null; `text` is
 *   "Saturday, February 15, 2025", or "Date TBA". Never rejects: failures are
 *   logged and come back as TBA.
 */
export async function loadPublicEventDate(client) {
  const tba = { date: null, text: DATE_TBA };
  try {
    const { data, error } = await client.rpc(PUBLIC_EVENT_INFO_RPC).maybeSingle();
    if (error) {
      console.warn("Landing: couldn't load the event date, so showing \"Date TBA\".", error);
      return tba;
    }
    if (!data?.event_date) {
      return tba; // No event set up yet.
    }
    // formatEventDate builds the date in UTC, so it's the same day in every time zone (ADR-022).
    return { date: data.event_date, text: formatEventDate(data.event_date) };
  } catch (error) {
    // A malformed date or a bug: the date can't be trusted, so don't show one.
    console.error('Landing: the event date could not be shown, so showing "Date TBA".', error);
    return tba;
  }
}

/**
 * Renders the landing page. The date starts as "Checking the date…" and is
 * filled in when get_public_event_info() answers.
 *
 * @param {{doc: Document, client: object}} context  From app.js's view context.
 * @returns {HTMLElement}  A <section data-view="landing">.
 */
export function renderLanding({ doc, client }) {
  const dateLine = create(doc, 'p', { class: 'landing-date', 'aria-busy': 'true' }, DATE_LOADING);
  loadPublicEventDate(client).then(({ date, text }) => {
    dateLine.replaceChildren(date ? create(doc, 'time', { datetime: date }, text) : text);
    dateLine.removeAttribute('aria-busy');
  });

  return create(
    doc,
    'section',
    { class: 'landing', 'data-view': VIEW.LANDING, 'aria-labelledby': 'landing-title' },
    create(doc, 'img', {
      class: 'landing-logo',
      src: LANDING_LOGO_PATH,
      // The heading right below says the name, so the picture needs no words of its own.
      alt: '',
      width: LANDING_LOGO_WIDTH,
      height: LANDING_LOGO_HEIGHT,
    }),
    // tabindex="-1": app.js moves focus to a view's heading after navigation.
    copyElement(doc, 'h1', 'eventName', { id: 'landing-title', class: 'landing-title', tabindex: '-1' }),
    copyElement(doc, 'p', 'tagline', { class: 'landing-tagline' }),
    dateLine,
    copyElement(doc, 'p', 'location', { class: 'landing-location' }),
    copyElement(doc, 'p', 'description', { class: 'landing-description' }),
    renderLogin(doc)
  );
}

/** An element holding one LANDING_COPY entry, marked as a placeholder while it is one. */
function copyElement(doc, tag, name, attributes) {
  const { text, placeholder } = LANDING_COPY[name];
  return create(
    doc,
    tag,
    { ...attributes, 'data-copy': name, 'data-placeholder': placeholder },
    placeholder ? `[Placeholder: ${text}]` : text
  );
}

/**
 * The "Log in or register" button and the panel it opens: a disclosure, so
 * the options appear right below it and the button says whether they're open.
 */
function renderLogin(doc) {
  const options = create(doc, 'div', { id: LOGIN_OPTIONS_ID, class: 'login-options', hidden: true }, renderLoginOptions(doc));
  const button = create(
    doc,
    'button',
    { type: 'button', class: 'landing-login-button', 'aria-expanded': 'false', 'aria-controls': LOGIN_OPTIONS_ID },
    'Log in or register'
  );
  button.addEventListener('click', () => {
    const opening = options.hidden;
    options.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
  });
  return create(doc, 'div', { class: 'landing-login' }, button, options);
}

/** What the login panel holds. ISSUE-011 replaces this with the real options from auth.js. */
function renderLoginOptions(doc) {
  return create(doc, 'p', { class: 'placeholder' }, '[Placeholder: Google, Facebook and email sign-in, built in ISSUE-011]');
}

/** Object.freeze, all the way down, so the copy can't be changed at run time by mistake. */
function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  return Object.freeze(object);
}
