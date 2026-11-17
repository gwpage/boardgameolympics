/**
 * util.js: helpers shared by the activity feed, message board, sidebar and
 * admin panel (ISSUE-008, ADR-022).
 *
 * SPEC DEVIATION
 *   This file isn't in SPEC § Project Structure, which gives each feature one
 *   file. The spec allows splitting further when needed. Four features use
 *   these helpers, so they live here once rather than in four copies.
 *
 * WHAT'S HERE
 *   escapeHtml(value)               Text made safe for HTML content and quoted attributes.
 *   createElement(doc, tag, attrs, ...children)
 *                                   Builds an element; string children go in as text (ISSUE-010).
 *   formatRelativeTime(ts, now)     "just now", "5 minutes ago", "yesterday", "Feb 8".
 *   formatFullTimestamp(ts)         "Saturday, February 15, 2025 at 3:04 PM", for hover titles.
 *   formatEventDate('2025-02-15')   "Saturday, February 15, 2025", the same in every time zone.
 *   applyKeysetPage(query, opts)    Newest-first keyset pagination for a Supabase query.
 *   keysetCursor(row, opts)         The checked (time, id) position of a row.
 *   createInfiniteScroll(opts)      Loads batches as a sentinel element scrolls into view.
 *   avatarUrl(flagUrl)              A member's flag, or the default avatar.
 *
 * DATES AND TIMES (ADR-022)
 *   - The site is in English, so formatting always uses en-US, whatever the
 *     browser's language.
 *   - Timestamps (created_at, claimed_at) are moments in time, shown in the
 *     viewer's own time zone.
 *   - The event date is a calendar date with no time or zone. It's formatted as
 *     a UTC date, so it never moves to the day before or after.
 *   - Timestamps must be ISO 8601 with a "T" and an offset, which is how
 *     PostgREST sends them. Anything else is rejected rather than guessed at,
 *     because browsers disagree about other formats.
 *
 * Nothing here runs on import, so the test page can import it freely.
 */

/** All display text is English (ADR-022). */
const LOCALE = 'en-US';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** From this many calendar days back, formatRelativeTime shows a date instead of "N days ago". */
const DAYS_UNTIL_DATE_SHOWN = 7;

/* ------------------------------------------------------------------------- */
/* HTML                                                                      */
/* ------------------------------------------------------------------------- */

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});
const HTML_SPECIAL_CHARACTERS = /[&<>"']/g;

/**
 * Escapes text for an HTML string: element content, or an attribute value in
 * single or double quotes. One pass, so `&` is never escaped twice.
 *
 * It doesn't make a URL safe to use as href or src: a `javascript:` URL has
 * nothing to escape. Check the scheme first, as avatarUrl() does. When
 * building elements one by one, setting textContent is simpler still.
 *
 * @param {*} value  Usually a string. null and undefined become ''.
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(HTML_SPECIAL_CHARACTERS, (character) => HTML_ESCAPES[character]);
}

/**
 * Builds an element. Building with this instead of innerHTML means database
 * text can never become markup: string children are added as text nodes.
 *
 * @param {Document} doc  The document to create it in.
 * @param {string} tag
 * @param {Object<string, *>} [attributes]  Set with setAttribute. null, undefined and false leave
 *   the attribute out; true writes it empty (hidden=""); anything else is turned into a string.
 * @param {...(Node|string)} children  Nodes, or strings added as text.
 * @returns {Element}
 */
export function createElement(doc, tag, attributes = {}, ...children) {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined && value !== false) {
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }
  element.append(...children);
  return element;
}

/* ------------------------------------------------------------------------- */
/* Dates and times                                                           */
/* ------------------------------------------------------------------------- */

/**
 * ISO 8601 as PostgREST and Date#toISOString write it: a "T", seconds, an
 * optional fraction (Postgres sends up to 6 digits) and an offset. Without an
 * offset, JavaScript would read the time as the viewer's local time.
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** A Postgres `date` as PostgREST sends it. */
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const SHORT_DATE_WITH_YEAR_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL_TIMESTAMP_FORMAT = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeStyle: 'short' });
const EVENT_DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * How long ago a moment was, in words:
 *   under a minute          "just now" (also any future time: the viewer's clock is behind the server's)
 *   under an hour           "1 minute ago", "5 minutes ago"
 *   under 24 hours          "1 hour ago", "2 hours ago" (even across midnight)
 *   1 to 6 calendar days    "yesterday", "2 days ago"
 *   7 or more days          "Feb 8", or "Dec 28, 2024" if the year differs from now's
 * Days are counted by calendar date in the viewer's zone, so something from
 * 11 pm two nights ago is "2 days ago" even if only 30 hours have passed.
 *
 * @param {string|Date} timestamp  ISO timestamp from the database, or a Date.
 * @param {string|Date} [now]      Defaults to the current time. Tests pass a fixed one.
 * @returns {string}
 * @throws {TypeError|RangeError} If either value isn't a valid timestamp.
 */
export function formatRelativeTime(timestamp, now = new Date()) {
  const then = toDate(timestamp);
  const current = toDate(now);
  const elapsed = current.getTime() - then.getTime();

  if (elapsed < MS_PER_MINUTE) {
    return 'just now';
  }
  if (elapsed < MS_PER_HOUR) {
    return RELATIVE_TIME_FORMAT.format(-Math.floor(elapsed / MS_PER_MINUTE), 'minute');
  }
  const days = calendarDaysBetween(then, current);
  // days is 0 past 24 hours only on the 25-hour day when clocks go back.
  if (elapsed < MS_PER_DAY || days === 0) {
    return RELATIVE_TIME_FORMAT.format(-Math.floor(elapsed / MS_PER_HOUR), 'hour');
  }
  if (days < DAYS_UNTIL_DATE_SHOWN) {
    return RELATIVE_TIME_FORMAT.format(-days, 'day'); // -1 reads "yesterday"
  }
  const sameYear = then.getFullYear() === current.getFullYear();
  return (sameYear ? SHORT_DATE_FORMAT : SHORT_DATE_WITH_YEAR_FORMAT).format(then);
}

/**
 * The full date and time of a moment in the viewer's zone, e.g.
 * "Saturday, February 15, 2025 at 3:04 PM". Meant for the title (hover text)
 * of a relative time.
 *
 * @param {string|Date} timestamp  ISO timestamp from the database, or a Date.
 * @returns {string}
 * @throws {TypeError|RangeError} If the value isn't a valid timestamp.
 */
export function formatFullTimestamp(timestamp) {
  return FULL_TIMESTAMP_FORMAT.format(toDate(timestamp));
}

/**
 * Formats the event date, e.g. '2025-02-15' → "Saturday, February 15, 2025".
 *
 * `new Date('2025-02-15')` means midnight UTC, which is still February 14
 * anywhere west of Greenwich. Here the date is built and formatted in UTC, so
 * no time zone is ever involved and the result is the same everywhere.
 *
 * @param {string} value  A Postgres `date` as sent by PostgREST: 'YYYY-MM-DD'.
 * @returns {string}
 * @throws {TypeError} If value isn't a string.
 * @throws {RangeError} If it isn't a real date in that format.
 */
export function formatEventDate(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected an event date like "2025-02-15", got ${describeType(value)}`);
  }
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Expected an event date like "2025-02-15", got ${JSON.stringify(value)}`);
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2025-02-30 over to March 2; reading the fields back catches it.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`There is no such date: ${value}`);
  }
  return EVENT_DATE_FORMAT.format(date);
}

/** A Date from a Date or an ISO timestamp string, or an error saying what was wrong. */
function toDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError('Expected a valid Date, got an Invalid Date');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a Date or an ISO timestamp string, got ${describeType(value)}`);
  }
  if (DATE_ONLY_PATTERN.test(value)) {
    throw new RangeError(`"${value}" is a date without a time. Use formatEventDate for dates.`);
  }
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new RangeError(`Expected an ISO timestamp with a "T" and an offset, got ${JSON.stringify(value)}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a real date and time: ${JSON.stringify(value)}`);
  }
  return date;
}

/** Whole calendar days from `earlier` to `later`, by local date (DST-safe). */
function calendarDaysBetween(earlier, later) {
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounding absorbs the 23- and 25-hour days at daylight-saving changes.
  return Math.round((startOfDay(later) - startOfDay(earlier)) / MS_PER_DAY);
}

/** "null", "undefined", "number", ... for error messages. */
function describeType(value) {
  return value === null ? 'null' : typeof value;
}

/* ------------------------------------------------------------------------- */
/* Keyset pagination                                                         */
/* ------------------------------------------------------------------------- */

/** Items per batch for the feed and the message board (SPEC § Message Board, Pagination). */
export const DEFAULT_BATCH_SIZE = 20;

const DEFAULT_TIME_COLUMN = 'created_at';
/** Every table's primary key is a uuid named id (ADR-012), so it breaks ties between equal times. */
const ID_COLUMN = 'id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * The position of a row in newest-first order: its time and id, exactly as
 * PostgREST sent them.
 *
 * The time stays a string. Postgres keeps microseconds and a JavaScript Date
 * keeps milliseconds, so a cursor that went through Date would skip or repeat
 * rows. Both values go into a filter string, so anything that isn't plainly a
 * timestamp or a uuid is refused.
 *
 * @param {object} row  A row from the previous batch (normally its last).
 * @param {object} [options]
 * @param {string} [options.timeColumn='created_at']
 * @returns {{time: string, id: string}}
 * @throws {TypeError} If the row lacks a valid time or id.
 */
export function keysetCursor(row, { timeColumn = DEFAULT_TIME_COLUMN } = {}) {
  checkColumnName(timeColumn);
  if (row === null || typeof row !== 'object') {
    throw new TypeError(`keysetCursor: expected a row object, got ${describeType(row)}`);
  }
  const time = row[timeColumn];
  const id = row[ID_COLUMN];
  if (typeof time !== 'string' || !ISO_TIMESTAMP_PATTERN.test(time)) {
    throw new TypeError(`keysetCursor: row.${timeColumn} must be a timestamp string as PostgREST sent it, got ${JSON.stringify(time)}`);
  }
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new TypeError(`keysetCursor: row.${ID_COLUMN} must be a uuid, got ${JSON.stringify(id)}`);
  }
  return { time, id };
}

/**
 * Adds newest-first keyset pagination to a Supabase query:
 *   order by <time> desc, id desc, limit <limit>, and, after the first batch,
 *   only rows that sort after `after`: older, or the same time with a smaller id.
 * Unlike offset paging, rows added at the top while someone scrolls don't
 * shift the next batch, and the database seeks straight to the position using
 * the (event_year, <time> desc, id desc) indexes from 001_schema.sql.
 *
 * Example (message board):
 *   const query = client.from('messages').select('id,text,created_at').eq('event_year', year);
 *   const { data, error } = await applyKeysetPage(query, { after: lastRow });
 *
 * @param {object} query  A supabase-js query builder, after select() and any filters.
 * @param {object} [options]
 * @param {object|null} [options.after=null]  Last row of the previous batch; null for the first batch.
 * @param {string} [options.timeColumn='created_at']
 * @param {number} [options.limit=DEFAULT_BATCH_SIZE]
 * @returns {object} The query, ready to await.
 * @throws {TypeError} If `after` isn't a valid row (see keysetCursor) or limit isn't a positive integer.
 */
export function applyKeysetPage(query, { after = null, timeColumn = DEFAULT_TIME_COLUMN, limit = DEFAULT_BATCH_SIZE } = {}) {
  checkColumnName(timeColumn);
  checkPositiveInteger(limit, 'applyKeysetPage: limit');
  // Check the cursor before touching the query, so a bad row changes nothing.
  const cursor = after === null || after === undefined ? null : keysetCursor(after, { timeColumn });

  let page = query
    .order(timeColumn, { ascending: false })
    .order(ID_COLUMN, { ascending: false })
    .limit(limit);
  if (cursor) {
    // PostgREST's or=(…) syntax. The values are quoted because "." and ":" are
    // reserved inside it, and timestamps contain both.
    page = page.or(
      `${timeColumn}.lt."${cursor.time}",and(${timeColumn}.eq."${cursor.time}",${ID_COLUMN}.lt."${cursor.id}")`,
    );
  }
  return page;
}

function checkColumnName(name) {
  if (typeof name !== 'string' || !COLUMN_NAME_PATTERN.test(name)) {
    throw new TypeError(`Expected a column name, got ${JSON.stringify(name)}`);
  }
}

function checkPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

/* ------------------------------------------------------------------------- */
/* Infinite scroll                                                           */
/* ------------------------------------------------------------------------- */

/** What the sentinel shows. Override any of these with createInfiniteScroll's `text` option. */
export const INFINITE_SCROLL_TEXT = Object.freeze({
  loading: 'Loading…',
  error: "Couldn't load. Check your connection, then try again.",
  retry: 'Try again',
  empty: 'Nothing here yet.',
  end: '',
});

/** Start the next batch this far before the sentinel scrolls into view, so scrolling rarely waits. */
const PRELOAD_MARGIN_PX = 400;

const SENTINEL_CLASS = 'scroll-status';
const MESSAGE_CLASS = 'scroll-status-message';
const RETRY_BUTTON_CLASS = 'scroll-status-retry';

/** Scroller states. The current one is also on the sentinel as data-state, for CSS. */
const STATE = Object.freeze({
  NEW: 'new',
  IDLE: 'idle',
  LOADING: 'loading',
  ERROR: 'error',
  DONE: 'done',
  DESTROYED: 'destroyed',
});

/**
 * Loads a list in batches as the reader scrolls.
 *
 * Put the sentinel element straight after the list. It does two jobs: when it
 * comes into view, the next batch loads; and it shows the status ("Loading…",
 * an error with a Try again button, or the empty/end text). It gets the
 * `scroll-status` class and `aria-live="polite"`.
 *
 * Rules:
 *   - start() loads the first batch at once. Later batches load when the
 *     sentinel is visible. If a batch doesn't fill the screen, the next one
 *     loads straight away.
 *   - Only one batch loads at a time.
 *   - A batch shorter than batchSize is the last one.
 *   - A failed batch is logged, and loading stops until the reader clicks
 *     Try again, so a dead connection isn't retried in a loop.
 *   - destroy() (for leaving the view) stops everything. A batch that arrives
 *     afterwards is dropped.
 *
 * @param {object} options
 * @param {Element} options.sentinel  Element after the list; watched, and shows the status.
 * @param {(lastItem: object|null, batchSize: number) => Promise<object[]>} options.loadBatch
 *   Fetches the batch after lastItem (null for the first). Pass both to applyKeysetPage.
 * @param {(items: object[]) => void} options.renderBatch  Appends items to the list. Never called with [].
 * @param {number} [options.batchSize=DEFAULT_BATCH_SIZE]
 * @param {Partial<typeof INFINITE_SCROLL_TEXT>} [options.text]  Replacement status text.
 * @param {Element|null} [options.root=null]  Scrolling ancestor to watch within; null means the viewport.
 * @param {(callback: Function, options: object) => {observe: Function, unobserve: Function, disconnect: Function}}
 *   [options.createObserver]  Makes the IntersectionObserver. Tests pass a fake.
 * @returns {{start: () => Promise<void>, destroy: () => void, readonly state: string}}
 */
export function createInfiniteScroll({
  sentinel,
  loadBatch,
  renderBatch,
  batchSize = DEFAULT_BATCH_SIZE,
  text = {},
  root = null,
  createObserver = (callback, observerOptions) => new IntersectionObserver(callback, observerOptions),
} = {}) {
  if (!(sentinel instanceof Element)) {
    throw new TypeError('createInfiniteScroll: sentinel must be an element');
  }
  if (typeof loadBatch !== 'function') {
    throw new TypeError('createInfiniteScroll: loadBatch must be a function');
  }
  if (typeof renderBatch !== 'function') {
    throw new TypeError('createInfiniteScroll: renderBatch must be a function');
  }
  checkPositiveInteger(batchSize, 'createInfiniteScroll: batchSize');

  const messages = { ...INFINITE_SCROLL_TEXT, ...text };
  let state = STATE.NEW;
  let observer = null;
  let lastItem = null;
  let itemCount = 0;
  let firstLoad = null;
  let currentLoad = null;

  sentinel.classList.add(SENTINEL_CLASS);
  sentinel.setAttribute('aria-live', 'polite');

  function setState(next) {
    state = next;
    sentinel.dataset.state = next;
    sentinel.replaceChildren(...statusContent());
  }

  function statusContent() {
    switch (state) {
      case STATE.LOADING:
        return [statusMessage(messages.loading)];
      case STATE.ERROR:
        return [statusMessage(messages.error), retryButton()];
      case STATE.DONE: {
        const finalText = itemCount === 0 ? messages.empty : messages.end;
        return finalText ? [statusMessage(finalText)] : [];
      }
      default:
        return [];
    }
  }

  function statusMessage(content) {
    const paragraph = document.createElement('p');
    paragraph.className = MESSAGE_CLASS;
    paragraph.textContent = content;
    return paragraph;
  }

  function retryButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = RETRY_BUTTON_CLASS;
    button.textContent = messages.retry;
    button.addEventListener('click', loadNext);
    return button;
  }

  /**
   * Re-observing makes the browser report the sentinel's visibility afresh,
   * after the new items have been laid out. An observer otherwise reports only
   * changes, so a batch that didn't push the sentinel out of view would leave
   * it waiting for a scroll that never comes on a tall screen.
   */
  function watchSentinel() {
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  function handleIntersection(entries) {
    const latest = entries.filter((entry) => entry.target === sentinel).at(-1);
    if (latest?.isIntersecting && state === STATE.IDLE) {
      loadNext();
    }
  }

  function loadNext() {
    if (state === STATE.LOADING) {
      return currentLoad;
    }
    if (state !== STATE.IDLE && state !== STATE.ERROR) {
      return Promise.resolve();
    }
    setState(STATE.LOADING);
    currentLoad = loadAndRender();
    return currentLoad;
  }

  async function loadAndRender() {
    try {
      const batch = await loadBatch(lastItem, batchSize);
      if (state === STATE.DESTROYED) {
        return;
      }
      if (!Array.isArray(batch)) {
        throw new TypeError(`loadBatch must resolve to an array of items, got ${describeType(batch)}`);
      }
      if (batch.length > 0) {
        renderBatch(batch);
        lastItem = batch.at(-1);
        itemCount += batch.length;
      }
      if (batch.length < batchSize) {
        observer.disconnect();
        setState(STATE.DONE);
      } else {
        setState(STATE.IDLE);
        watchSentinel();
      }
    } catch (error) {
      if (state === STATE.DESTROYED) {
        return;
      }
      // A renderBatch bug lands here too, so the list never sticks on "Loading…".
      console.error('Infinite scroll: a batch failed to load.', error);
      observer.unobserve(sentinel);
      setState(STATE.ERROR);
    }
  }

  function start() {
    if (state !== STATE.NEW) {
      return firstLoad ?? Promise.resolve();
    }
    observer = createObserver(handleIntersection, { root, rootMargin: `0px 0px ${PRELOAD_MARGIN_PX}px 0px` });
    state = STATE.IDLE;
    firstLoad = loadNext();
    return firstLoad;
  }

  function destroy() {
    observer?.disconnect();
    setState(STATE.DESTROYED);
  }

  return {
    start,
    destroy,
    get state() {
      return state;
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Avatars                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The generic icon for members without a flag (SPEC § Profile Rules), as an
 * absolute URL. It's resolved from this file's own location, so it's right at
 * / in production, at /public/ locally, and from the test page.
 */
export const DEFAULT_AVATAR_URL = new URL('../assets/images/default-avatar.png', import.meta.url).href;

/**
 * The image to show for a member: their flag, or the default avatar.
 *
 * The database only accepts https:// flag URLs (ADR-012). Anything else (a
 * javascript: or data: URL, plain http) is never put in an <img>: it's logged
 * and replaced with the default avatar. Escape the result with escapeHtml()
 * if it goes into an HTML string, or set img.src directly.
 *
 * @param {string|null|undefined} flagUrl  users.flag_url.
 * @returns {string}
 */
export function avatarUrl(flagUrl) {
  if (flagUrl === null || flagUrl === undefined || flagUrl === '') {
    return DEFAULT_AVATAR_URL;
  }
  if (typeof flagUrl === 'string' && URL.canParse(flagUrl) && new URL(flagUrl).protocol === 'https:') {
    return flagUrl;
  }
  console.warn("avatarUrl: ignored a flag URL that isn't https:// and showed the default avatar instead:", flagUrl);
  return DEFAULT_AVATAR_URL;
}
