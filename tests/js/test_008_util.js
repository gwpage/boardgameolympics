/**
 * tests/js/test_008_util.js: shared UI utilities (ISSUE-008, ADR-022).
 *
 * Covers public/js/util.js: escapeHtml, the date and time formatters, the
 * keyset pagination helpers, createInfiniteScroll and avatarUrl.
 *
 * TIME ZONES
 *   tests/run.sh runs the whole suite three times: in this machine's own zone,
 *   at UTC+14 (Pacific/Kiritimati) and at UTC−12 (Etc/GMT+12). Date code that
 *   leans on the local zone gets a day wrong in one of them. The first test
 *   below checks that the browser really is in the zone run.sh asked for, so
 *   the extra runs can't quietly turn into repeats of the first.
 *
 *   Expected values are built from local calendar fields
 *   (new Date(2025, 1, 15, 12, 0)), so they hold in every zone.
 */

import { describe, it, assert, assertEqual, assertThrows } from '../harness.js';
import {
  DEFAULT_AVATAR_URL,
  DEFAULT_BATCH_SIZE,
  INFINITE_SCROLL_TEXT,
  applyKeysetPage,
  avatarUrl,
  createElement,
  createInfiniteScroll,
  escapeHtml,
  formatEventDate,
  formatFullTimestamp,
  formatRelativeTime,
  keysetCursor,
} from '../../public/js/util.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Saturday, February 15, 2025, at local noon: the "now" for relative-time tests. */
const NOW = new Date(2025, 1, 15, 12, 0, 0);

/** A moment `ms` before NOW. Only for spans under a day; whole days use local calendar fields (DST-proof). */
function before(ms, now = NOW) {
  return new Date(now.getTime() - ms);
}

/** The ISO string PostgREST sends for a timestamptz: microseconds and a +00:00 offset. */
function postgresTimestamp(date) {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1456+00:00');
}

/** Chrome's ICU puts a narrow no-break space before AM/PM; compare text with plain spaces. */
function plainSpaces(text) {
  return text.replace(/[  ]/g, ' ');
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

/** Lets every pending promise callback run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await pause(16);
  }
}

/* ------------------------------------------------------------------------- */

describe('test runner time zone (ADR-022)', () => {
  it('runs in the time zone that tests/run.sh asked for with ?tz=', () => {
    const requested = new URLSearchParams(location.search).get('tz');
    if (requested === null) {
      return; // A manual run in a normal browser uses the machine's own zone.
    }
    assertEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, requested);
  });
});

/* ------------------------------------------------------------------------- */

describe('escapeHtml', () => {
  it('escapes & < > " and \'', () => {
    assertEqual(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
  });

  it('escapes & only once, so text that looks like an entity shows literally', () => {
    assertEqual(escapeHtml('&lt;b&gt; &amp;'), '&amp;lt;b&amp;gt; &amp;amp;');
  });

  it('leaves other text, including emoji and accents, unchanged', () => {
    assertEqual(escapeHtml('Genovia 🏰 café, naïve\nnew line'), 'Genovia 🏰 café, naïve\nnew line');
  });

  it('turns null and undefined into an empty string, and numbers into text', () => {
    assertEqual(escapeHtml(null), '');
    assertEqual(escapeHtml(undefined), '');
    assertEqual(escapeHtml(42), '42');
  });

  it('makes hostile text render as plain text in element content and quoted attributes (real DOM)', () => {
    const hostile = `<img src=x onerror="alert(1)">Tom & Jerry's "best" <script>alert(2)</script>`;
    const container = document.createElement('div');
    container.innerHTML = `<span title="${escapeHtml(hostile)}" data-x='${escapeHtml(hostile)}'>${escapeHtml(hostile)}</span>`;
    const span = container.querySelector('span');
    assertEqual(span.textContent, hostile);
    assertEqual(span.title, hostile);
    assertEqual(span.dataset.x, hostile);
    assertEqual(container.querySelector('img, script'), null, 'no element was created from the text');
  });
});

/* ------------------------------------------------------------------------- */

describe('formatRelativeTime', () => {
  it('under a minute → "just now"', () => {
    assertEqual(formatRelativeTime(before(30 * SECOND), NOW), 'just now');
    assertEqual(formatRelativeTime(before(0), NOW), 'just now');
    assertEqual(formatRelativeTime(before(59 * SECOND), NOW), 'just now');
  });

  it('a time slightly in the future (clock skew) → "just now"', () => {
    assertEqual(formatRelativeTime(before(-90 * SECOND), NOW), 'just now');
  });

  it('minutes → "1 minute ago", "5 minutes ago", "59 minutes ago"', () => {
    assertEqual(formatRelativeTime(before(MINUTE), NOW), '1 minute ago');
    assertEqual(formatRelativeTime(before(5 * MINUTE), NOW), '5 minutes ago');
    assertEqual(formatRelativeTime(before(59 * MINUTE + 59 * SECOND), NOW), '59 minutes ago');
  });

  it('hours → "1 hour ago", "2 hours ago", "23 hours ago"', () => {
    assertEqual(formatRelativeTime(before(HOUR), NOW), '1 hour ago');
    assertEqual(formatRelativeTime(before(2 * HOUR), NOW), '2 hours ago');
    assertEqual(formatRelativeTime(before(23 * HOUR + 59 * MINUTE), NOW), '23 hours ago');
  });

  it('under 24 hours across midnight still counts hours', () => {
    const oneAm = new Date(2025, 1, 15, 1, 0);
    assertEqual(formatRelativeTime(new Date(2025, 1, 14, 23, 0), oneAm), '2 hours ago');
  });

  it('one day ago → "yesterday"', () => {
    assertEqual(formatRelativeTime(new Date(2025, 1, 14, 12, 0), NOW), 'yesterday');
    assertEqual(formatRelativeTime(new Date(2025, 1, 14, 8, 0), NOW), 'yesterday', '28 hours, previous calendar day');
  });

  it('counts calendar days, not 24-hour blocks: 30 hours ago but two dates back → "2 days ago"', () => {
    const fiveAm = new Date(2025, 1, 15, 5, 0);
    assertEqual(formatRelativeTime(new Date(2025, 1, 13, 23, 0), fiveAm), '2 days ago');
  });

  it('2 to 6 days → "N days ago"', () => {
    assertEqual(formatRelativeTime(new Date(2025, 1, 13, 12, 0), NOW), '2 days ago');
    assertEqual(formatRelativeTime(new Date(2025, 1, 9, 12, 0), NOW), '6 days ago');
  });

  it('7 days or more → a short calendar date', () => {
    assertEqual(formatRelativeTime(new Date(2025, 1, 8, 12, 0), NOW), 'Feb 8');
    assertEqual(formatRelativeTime(new Date(2025, 0, 2, 9, 30), NOW), 'Jan 2');
  });

  it('a date in an earlier calendar year includes the year', () => {
    assertEqual(formatRelativeTime(new Date(2024, 11, 28, 18, 0), NOW), 'Dec 28, 2024');
  });

  it('accepts the ISO strings PostgREST sends, including microseconds', () => {
    assertEqual(formatRelativeTime(postgresTimestamp(before(5 * MINUTE)), NOW), '5 minutes ago');
    assertEqual(formatRelativeTime(before(2 * HOUR).toISOString(), NOW), '2 hours ago');
  });

  it('"now" defaults to the current time', () => {
    assertEqual(formatRelativeTime(new Date()), 'just now');
    assertEqual(formatRelativeTime(new Date(Date.now() - 3 * HOUR - MINUTE)), '3 hours ago');
  });

  it('rejects values that aren\'t timestamps instead of showing "Invalid Date"', () => {
    assertThrows(() => formatRelativeTime(null, NOW), TypeError);
    assertThrows(() => formatRelativeTime(1739620800000, NOW), TypeError);
    assertThrows(() => formatRelativeTime('not a date', NOW), RangeError);
    assertThrows(() => formatRelativeTime(new Date('nope'), NOW), RangeError);
    // A date-only value would be read as UTC midnight: the off-by-one formatEventDate exists to avoid.
    const error = assertThrows(() => formatRelativeTime('2025-02-15', NOW), RangeError);
    assert(error.message.includes('formatEventDate'), `the error points to formatEventDate: ${error.message}`);
    // No offset means "local time" to JavaScript, which isn't what the server meant.
    assertThrows(() => formatRelativeTime('2025-02-15T12:00:00', NOW), RangeError);
    // Chrome reads a space separator, Safari doesn't. Reject it everywhere.
    assertThrows(() => formatRelativeTime('2025-02-15 12:00:00+00:00', NOW), RangeError);
  });
});

/* ------------------------------------------------------------------------- */

describe('formatFullTimestamp', () => {
  it('spells out the date and time in the viewer\'s zone, for a hover title', () => {
    assertEqual(plainSpaces(formatFullTimestamp(new Date(2025, 1, 15, 15, 4))), 'Saturday, February 15, 2025 at 3:04 PM');
  });

  it('accepts the ISO strings PostgREST sends', () => {
    const local = new Date(2025, 1, 14, 9, 30);
    assertEqual(plainSpaces(formatFullTimestamp(postgresTimestamp(local))), 'Friday, February 14, 2025 at 9:30 AM');
  });

  it('rejects values that aren\'t timestamps', () => {
    assertThrows(() => formatFullTimestamp(undefined), TypeError);
    assertThrows(() => formatFullTimestamp('soon'), RangeError);
  });
});

/* ------------------------------------------------------------------------- */

describe('formatEventDate', () => {
  it('"2025-02-15" → "Saturday, February 15, 2025" (run.sh repeats this at UTC+14 and UTC−12)', () => {
    assertEqual(formatEventDate('2025-02-15'), 'Saturday, February 15, 2025');
  });

  it('gets the weekday right at year boundaries and on a leap day', () => {
    assertEqual(formatEventDate('2026-01-01'), 'Thursday, January 1, 2026');
    assertEqual(formatEventDate('2025-12-31'), 'Wednesday, December 31, 2025');
    assertEqual(formatEventDate('2024-02-29'), 'Thursday, February 29, 2024');
  });

  it('rejects text that isn\'t a real YYYY-MM-DD date', () => {
    for (const bad of ['', '2025-2-15', '15/02/2025', '2025-02-15T00:00:00Z', '2025-02-30', '2025-13-01', '2025-00-10', '2023-02-29']) {
      assertThrows(() => formatEventDate(bad), RangeError);
    }
  });

  it('rejects values that aren\'t strings', () => {
    assertThrows(() => formatEventDate(null), TypeError);
    assertThrows(() => formatEventDate(new Date(2025, 1, 15)), TypeError);
  });
});

/* ------------------------------------------------------------------------- */

/** Records the query-builder calls applyKeysetPage makes, like supabase-js's chainable builder. */
function fakeQuery() {
  const calls = [];
  const builder = {
    calls,
    order(column, options) {
      calls.push(['order', column, options]);
      return builder;
    },
    limit(count) {
      calls.push(['limit', count]);
      return builder;
    },
    or(filter) {
      calls.push(['or', filter]);
      return builder;
    },
  };
  return builder;
}

const TIME = '2025-02-14T18:30:00.123456+00:00';
const ID = '0b6f0f0e-6a3e-4c55-9d43-2f1f7d0c9a11';

describe('keyset pagination', () => {
  it('DEFAULT_BATCH_SIZE is 20 (SPEC § Message Board, Pagination)', () => {
    assertEqual(DEFAULT_BATCH_SIZE, 20);
  });

  it('keysetCursor takes the time and id of a row', () => {
    assertEqual(keysetCursor({ id: ID, created_at: TIME, text: 'hi' }), { time: TIME, id: ID });
    assertEqual(keysetCursor({ id: ID, claimed_at: TIME }, { timeColumn: 'claimed_at' }), { time: TIME, id: ID });
  });

  it('the first page: newest first by time, then id, limited to a batch, with no filter', () => {
    const query = fakeQuery();
    applyKeysetPage(query);
    assertEqual(query.calls, [
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 20],
    ]);
  });

  it('the next page: only rows older than the last one, with ties on time broken by id', () => {
    const query = fakeQuery();
    applyKeysetPage(query, { after: { id: ID, created_at: TIME } });
    assertEqual(query.calls.find(([method]) => method === 'or'), [
      'or',
      `created_at.lt."${TIME}",and(created_at.eq."${TIME}",id.lt."${ID}")`,
    ]);
  });

  it('keeps the cursor time exactly as Postgres sent it, microseconds included (never via Date)', () => {
    const query = fakeQuery();
    applyKeysetPage(query, { after: { id: ID, created_at: '2025-02-14T18:30:00.000001+00:00' } });
    const [, filter] = query.calls.find(([method]) => method === 'or');
    assert(filter.includes('"2025-02-14T18:30:00.000001+00:00"'), filter);
  });

  it('works for other time columns and batch sizes (the activity feed)', () => {
    const query = fakeQuery();
    applyKeysetPage(query, { after: { id: ID, occurred_at: TIME }, timeColumn: 'occurred_at', limit: 5 });
    assertEqual(query.calls, [
      ['order', 'occurred_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 5],
      ['or', `occurred_at.lt."${TIME}",and(occurred_at.eq."${TIME}",id.lt."${ID}")`],
    ]);
  });

  it('returns the query, so the caller can keep chaining or await it', () => {
    const query = fakeQuery();
    assertEqual(applyKeysetPage(query, { after: { id: ID, created_at: TIME } }), query);
  });

  it('refuses a row whose time or id could change the filter text', () => {
    assertThrows(() => keysetCursor(null), TypeError);
    assertThrows(() => keysetCursor({ id: ID }), TypeError);
    assertThrows(() => keysetCursor({ created_at: TIME }), TypeError);
    assertThrows(() => keysetCursor({ id: ID, created_at: `${TIME}"),id.gt.("0` }), TypeError);
    assertThrows(() => keysetCursor({ id: `${ID}"`, created_at: TIME }), TypeError);
    assertThrows(() => keysetCursor({ id: 'abc', created_at: TIME }), TypeError);
    assertThrows(() => keysetCursor({ id: ID, created_at: '2025-02-14' }), TypeError);
    assertThrows(() => applyKeysetPage(fakeQuery(), { after: { id: ID, created_at: 'yesterday' } }), TypeError);
  });

  it('paging through rows with tied times and mixed kinds returns every row once, newest first', () => {
    // 45 feed-like rows: claims and messages, three sharing each timestamp.
    const rows = Array.from({ length: 45 }, (_, index) => ({
      kind: index % 2 === 0 ? 'claim' : 'message',
      id: `${(index * 7919 % 4096).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      occurred_at: `2025-02-${String(10 + Math.floor(index / 3) % 10).padStart(2, '0')}T0${Math.floor(index / 30)}:00:00.5+00:00`,
    }));
    const table = [...rows].reverse();
    // Code-point order, as Postgres compares these timestamps and uuids.
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const newestFirst = (a, b) => compare(b.occurred_at, a.occurred_at) || compare(b.id, a.id);
    const expected = [...rows].sort(newestFirst);

    // A tiny stand-in for PostgREST that understands exactly the calls applyKeysetPage makes.
    // Every timestamp here has the same format, so comparing strings compares times.
    const run = (query) => {
      const filterCall = query.calls.find(([method]) => method === 'or');
      const limit = query.calls.find(([method]) => method === 'limit')[1];
      let visible = table;
      if (filterCall) {
        const match = /^occurred_at\.lt\."([^"]+)",and\(occurred_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(filterCall[1]);
        assert(match, `unexpected filter: ${filterCall[1]}`);
        const [, before, tieTime, tieId] = match;
        visible = table.filter((row) => row.occurred_at < before || (row.occurred_at === tieTime && row.id < tieId));
      }
      return [...visible].sort(newestFirst).slice(0, limit);
    };

    const seen = [];
    const pageSizes = [];
    let last = null;
    for (;;) {
      const page = run(applyKeysetPage(fakeQuery(), { after: last, timeColumn: 'occurred_at' }));
      pageSizes.push(page.length);
      seen.push(...page);
      if (page.length < DEFAULT_BATCH_SIZE) {
        break;
      }
      last = page.at(-1);
    }
    assertEqual(pageSizes, [20, 20, 5]);
    assertEqual(seen.map((row) => row.id), expected.map((row) => row.id));
  });
});

/* ------------------------------------------------------------------------- */

/** Stands in for IntersectionObserver. fire(true) reports the observed sentinel as visible. */
function fakeObserver() {
  const record = { callback: null, options: null, observed: new Set(), disconnected: false };
  return {
    record,
    create(callback, options) {
      record.callback = callback;
      record.options = options;
      return {
        observe: (element) => record.observed.add(element),
        unobserve: (element) => record.observed.delete(element),
        disconnect: () => {
          record.observed.clear();
          record.disconnected = true;
        },
      };
    },
    fire(isIntersecting) {
      const entries = [...record.observed].map((target) => ({ target, isIntersecting }));
      if (entries.length > 0) {
        record.callback(entries);
      }
    },
  };
}

/** A promise the test resolves or rejects by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function items(from, count) {
  return Array.from({ length: count }, (_, index) => ({ id: from + index }));
}

/**
 * A scroller wired to fakes. Each loadBatch call gets a deferred, which the
 * test settles with `pending.at(-1).resolve([...])`.
 */
function fakeScroller(options = {}) {
  const sentinel = document.createElement('div');
  const observer = fakeObserver();
  const loads = [];
  const pending = [];
  const rendered = [];
  const scroller = createInfiniteScroll({
    sentinel,
    batchSize: 3,
    loadBatch: (lastItem, batchSize) => {
      loads.push({ lastItem, batchSize });
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
    renderBatch: (batch) => rendered.push(...batch),
    createObserver: (callback, observerOptions) => observer.create(callback, observerOptions),
    ...options,
  });
  return { scroller, sentinel, observer, loads, pending, rendered };
}

describe('createInfiniteScroll', () => {
  it('start() loads the first batch at once, with no last item, then watches the sentinel', async () => {
    const { scroller, sentinel, observer, loads, pending, rendered } = fakeScroller();
    const started = scroller.start();
    assertEqual(loads, [{ lastItem: null, batchSize: 3 }]);
    pending[0].resolve(items(1, 3));
    await started;
    assertEqual(rendered, items(1, 3));
    assertEqual(scroller.state, 'idle');
    assert(observer.record.observed.has(sentinel), 'the sentinel is observed after the first batch');
  });

  it('loads the next batch, after the last item, when the sentinel becomes visible', async () => {
    const { scroller, observer, loads, pending, rendered } = fakeScroller();
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;

    observer.fire(false);
    assertEqual(loads.length, 1, 'no load while the sentinel is out of view');

    observer.fire(true);
    assertEqual(loads.length, 2);
    assertEqual(loads[1], { lastItem: { id: 3 }, batchSize: 3 });
    pending[1].resolve(items(4, 3));
    await settle();
    assertEqual(rendered, items(1, 6));
  });

  it('shows the loading text while a batch loads, in the sentinel', async () => {
    const { scroller, sentinel, pending } = fakeScroller();
    const started = scroller.start();
    assertEqual(sentinel.textContent, INFINITE_SCROLL_TEXT.loading);
    assertEqual(sentinel.dataset.state, 'loading');
    pending[0].resolve(items(1, 3));
    await started;
    assertEqual(sentinel.textContent, '');
    assertEqual(sentinel.dataset.state, 'idle');
  });

  it('stops when a batch is short', async () => {
    const { scroller, observer, loads, pending, rendered } = fakeScroller();
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;
    observer.fire(true);
    pending[1].resolve(items(4, 2));
    await settle();

    assertEqual(scroller.state, 'done');
    assertEqual(rendered, items(1, 5));
    assert(observer.record.disconnected, 'stops watching the sentinel');
    observer.fire(true);
    assertEqual(loads.length, 2, 'no load after the end');
  });

  it('stops after an empty batch, without rendering it, when the total is a multiple of the batch size', async () => {
    let renderCalls = 0;
    const { scroller, observer, pending, rendered } = fakeScroller({
      renderBatch: (batch) => {
        renderCalls += 1;
        rendered.push(...batch);
      },
    });
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;
    observer.fire(true);
    pending[1].resolve([]);
    await settle();
    assertEqual(scroller.state, 'done');
    assertEqual(renderCalls, 1);
  });

  it('never runs two loads at once', async () => {
    const { scroller, observer, loads, pending } = fakeScroller();
    const first = scroller.start();
    assertEqual(scroller.start(), first, 'a second start() returns the first load');
    assertEqual(loads.length, 1);
    pending[0].resolve(items(1, 3));
    await first;

    observer.fire(true);
    observer.fire(true);
    observer.fire(true);
    assertEqual(loads.length, 1 + 1, 'visibility changes during a load start nothing new');
    pending[1].resolve(items(4, 3));
    await settle();
    observer.fire(true);
    assertEqual(loads.length, 3, 'the next load starts once the previous one has finished');
  });

  it('on an error: logs it, shows a message and a retry button, and stops loading by itself', async () => {
    const { scroller, sentinel, observer, loads, pending } = fakeScroller();
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;
    observer.fire(true);
    const failure = new Error('network down');
    const logged = await captureConsole('error', async () => {
      pending[1].reject(failure);
      await settle();
    });

    assertEqual(scroller.state, 'error');
    assert(logged.some((args) => args.includes(failure)), 'the error reaches the console');
    assert(sentinel.textContent.includes(INFINITE_SCROLL_TEXT.error), sentinel.textContent);
    const retry = sentinel.querySelector('button');
    assert(retry, 'there is a retry button');
    assertEqual(retry.type, 'button');
    assertEqual(retry.textContent, INFINITE_SCROLL_TEXT.retry);

    observer.fire(true);
    assertEqual(loads.length, 2, 'scrolling alone does not retry');
  });

  it('retry loads the same batch again, once, even if clicked twice', async () => {
    const { scroller, sentinel, observer, loads, pending, rendered } = fakeScroller();
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;
    observer.fire(true);
    await captureConsole('error', async () => {
      pending[1].reject(new Error('timeout'));
      await settle();
    });

    const retry = sentinel.querySelector('button');
    retry.click();
    retry.click();
    assertEqual(loads.length, 3, 'one retry load');
    assertEqual(loads[2].lastItem, { id: 3 }, 'retries from the same place');
    pending[2].resolve(items(4, 3));
    await settle();
    assertEqual(rendered, items(1, 6));
    assertEqual(scroller.state, 'idle');
    assertEqual(sentinel.querySelector('button'), null, 'the error is cleared');
    observer.fire(true);
    assertEqual(loads.length, 4, 'loading by scrolling resumes');
  });

  it('a failed first batch can be retried too', async () => {
    const { scroller, sentinel, loads, pending, rendered } = fakeScroller();
    await captureConsole('error', async () => {
      const started = scroller.start();
      pending[0].reject(new Error('offline'));
      await started;
    });
    sentinel.querySelector('button').click();
    assertEqual(loads[1].lastItem, null);
    pending[1].resolve(items(1, 2));
    await settle();
    assertEqual(rendered, items(1, 2));
    assertEqual(scroller.state, 'done');
  });

  it('treats a loadBatch result that isn\'t an array as an error', async () => {
    const { scroller, pending } = fakeScroller();
    const logged = await captureConsole('error', async () => {
      const started = scroller.start();
      pending[0].resolve({ data: [] });
      await started;
    });
    assertEqual(scroller.state, 'error');
    assertEqual(logged.length, 1);
  });

  it('shows the empty text when the first batch has nothing', async () => {
    const { scroller, sentinel, pending } = fakeScroller({ text: { empty: 'No messages yet.' } });
    const started = scroller.start();
    pending[0].resolve([]);
    await started;
    assertEqual(scroller.state, 'done');
    assertEqual(sentinel.textContent, 'No messages yet.');
  });

  it('shows the end text, if one is given, after the last batch (none by default)', async () => {
    const withEnd = fakeScroller({ text: { end: "That's everything." } });
    let started = withEnd.scroller.start();
    withEnd.pending[0].resolve(items(1, 1));
    await started;
    assertEqual(withEnd.sentinel.textContent, "That's everything.");

    const plain = fakeScroller();
    started = plain.scroller.start();
    plain.pending[0].resolve(items(1, 1));
    await started;
    assertEqual(plain.sentinel.textContent, '');
  });

  it('destroy() stops watching and ignores a batch that is still loading', async () => {
    const { scroller, observer, loads, pending, rendered } = fakeScroller();
    const started = scroller.start();
    scroller.destroy();
    pending[0].resolve(items(1, 3));
    await started;
    assertEqual(rendered, [], 'nothing is rendered into a view that has gone');
    assertEqual(scroller.state, 'destroyed');
    assert(observer.record.disconnected, 'the observer is disconnected');
    observer.fire(true);
    assertEqual(loads.length, 1);
  });

  it('marks the sentinel with the scroll-status class, and passes the observer a root and a preload margin', async () => {
    const root = document.createElement('div');
    const { scroller, sentinel, observer, pending } = fakeScroller({ root });
    assert(sentinel.classList.contains('scroll-status'), sentinel.className);
    const started = scroller.start();
    pending[0].resolve(items(1, 3));
    await started;
    assertEqual(observer.record.options.root, root);
    assert(/^0px 0px [1-9]\d*px 0px$/.test(observer.record.options.rootMargin), observer.record.options.rootMargin);
  });

  it('rejects missing or invalid options', () => {
    const sentinel = document.createElement('div');
    const loadBatch = async () => [];
    const renderBatch = () => {};
    assertThrows(() => createInfiniteScroll({ loadBatch, renderBatch }), TypeError);
    assertThrows(() => createInfiniteScroll({ sentinel, renderBatch }), TypeError);
    assertThrows(() => createInfiniteScroll({ sentinel, loadBatch }), TypeError);
    assertThrows(() => createInfiniteScroll({ sentinel, loadBatch, renderBatch, batchSize: 0 }), TypeError);
    assertThrows(() => createInfiniteScroll({ sentinel, loadBatch, renderBatch, batchSize: 2.5 }), TypeError);
  });

  it('with a real IntersectionObserver: keeps loading until the visible area is full, then loads more only on scroll', async () => {
    const box = document.createElement('div');
    box.style.cssText = 'position: fixed; top: 0; left: 0; width: 200px; height: 100px; overflow: auto;';
    const list = document.createElement('div');
    const sentinel = document.createElement('div');
    box.append(list, sentinel);
    document.body.append(box);

    // Two batches of five 5px rows (25px, then 50px) don't fill the 100px box, so
    // the sentinel stays in view and the next batch must load without scrolling.
    // An observer reports only changes, so the third load proves the sentinel is
    // re-checked after every batch. Batches of 1000px rows then push it far out of view.
    const rowHeights = [5, 5, 1000, 1000];
    let loads = 0;
    const scroller = createInfiniteScroll({
      sentinel,
      batchSize: 5,
      loadBatch: async () => {
        const height = rowHeights[loads] ?? 1000;
        loads += 1;
        return Array.from({ length: 5 }, () => ({ height }));
      },
      renderBatch: (batch) => {
        for (const item of batch) {
          const row = document.createElement('div');
          row.style.height = `${item.height}px`;
          list.append(row);
        }
      },
    });
    try {
      await scroller.start();
      await waitFor(() => loads >= 3, 'batches 2 and 3, loaded because the sentinel was still visible');
      await pause(250);
      assertEqual(loads, 3, 'loading pauses once the sentinel is out of view');

      box.scrollTop = box.scrollHeight;
      await waitFor(() => loads >= 4, 'batch 4, after scrolling to the bottom');
      await pause(250);
      assertEqual(loads, 4);
    } finally {
      scroller.destroy();
      box.remove();
    }
  });
});

/* ------------------------------------------------------------------------- */

describe('avatarUrl', () => {
  const FLAG = 'https://abcdefghij.supabase.co/storage/v1/object/public/flags/0b6f0f0e-6a3e-4c55-9d43-2f1f7d0c9a11/1739620800000.png';

  it('returns the flag URL when there is one', () => {
    assertEqual(avatarUrl(FLAG), FLAG);
  });

  it('returns the default avatar, quietly, when there is no flag', async () => {
    const warnings = await captureConsole('warn', () => {
      assertEqual(avatarUrl(null), DEFAULT_AVATAR_URL);
      assertEqual(avatarUrl(undefined), DEFAULT_AVATAR_URL);
      assertEqual(avatarUrl(''), DEFAULT_AVATAR_URL);
    });
    assertEqual(warnings, [], 'no flag is normal, not worth a warning');
  });

  it('the default avatar is an absolute URL to public/assets/images/default-avatar.png, whatever page imports it', () => {
    const url = new URL(DEFAULT_AVATAR_URL);
    assertEqual(url.origin, location.origin);
    assertEqual(url.pathname, '/public/assets/images/default-avatar.png');
  });

  it('the default avatar file exists and is a PNG', async () => {
    const response = await fetch(DEFAULT_AVATAR_URL);
    assert(response.ok, `HTTP ${response.status}`);
    assertEqual(response.headers.get('content-type'), 'image/png');
  });

  it('falls back to the default avatar, with a warning, for anything that isn\'t an https:// URL', async () => {
    const unsafe = ['http://example.com/flag.png', 'javascript:alert(1)', 'data:image/png;base64,iVBORw0KGgo=', 'flags/x.png', 'not a url', 42];
    const warnings = await captureConsole('warn', () => {
      for (const value of unsafe) {
        assertEqual(avatarUrl(value), DEFAULT_AVATAR_URL, String(value));
      }
    });
    assertEqual(warnings.length, unsafe.length);
  });
});

/* ------------------------------------------------------------------------- */

describe('createElement (added in ISSUE-010)', () => {
  it('builds an element with attributes, and adds string children as text, never HTML', () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const element = createElement(document, 'p', { class: 'note', 'data-x': 'y' }, 'Hello ', createElement(document, 'strong', {}, hostile));
    assertEqual(element.outerHTML, '<p class="note" data-x="y">Hello <strong>&lt;img src=x onerror="window.__xss=1"&gt;</strong></p>');
    assertEqual(element.querySelector('img'), null);
  });

  it('leaves out attributes that are null, undefined or false, and writes true as an empty attribute', () => {
    const element = createElement(document, 'button', { hidden: true, disabled: false, title: null, 'aria-label': undefined, tabindex: 0 });
    assertEqual(element.outerHTML, '<button hidden="" tabindex="0"></button>');
  });

  it('works with no attributes or children, in the document it is given', () => {
    const other = document.implementation.createHTMLDocument('other');
    const element = createElement(other, 'div');
    assertEqual(element.outerHTML, '<div></div>');
    assert(element.ownerDocument === other);
  });
});
