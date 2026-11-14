/**
 * tests/harness.js — hand-written, zero-dependency test harness (ADR-001).
 *
 * WHY THIS EXISTS
 *   The project has no npm, no Node and no build step, so tests run in the
 *   browser itself, which is the same runtime as the app. A browser test can
 *   exercise real DOM, cookies and image decoding without shims like jsdom.
 *
 * HOW IT FITS
 *   - Test modules (tests/js/test_###_*.js) import describe/it and the assert
 *     helpers from here. Importing a module registers its tests on the shared
 *     `defaultRunner`.
 *   - tests/index.html lists every test module, imports them, runs
 *     `defaultRunner.run()`, and writes the result into #summary and #report.
 *   - tests/run.sh loads that page in headless Chrome and reads those elements.
 *
 * WRITING A TEST
 *   import { describe, it, assert, assertEqual } from '../harness.js';
 *   describe('validateMessage', () => {
 *     it('rejects whitespace-only text', () => {
 *       assertEqual(validateMessage('   ').ok, false);
 *     });
 *   });
 *   A test passes if its function returns, or returns a promise that resolves.
 *   It fails if it throws, rejects, or doesn't settle within the timeout.
 *
 * RULES
 *   - Tests run one at a time, in registration order, because they may share
 *     the DOM, cookies or localStorage. Clean up whatever you touch.
 *   - Never call the external network (Supabase, CDNs). Use fakes. Reading repo
 *     files from the local test server with fetch() is fine.
 */

/** A test that hasn't settled after this long fails, so one hung promise can't stall the run. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Joins nested describe names and the test name, e.g. "messages › validate › rejects blanks". */
const NAME_SEPARATOR = ' › ';

/** Thrown by the assert helpers so a failed expectation is distinguishable from a crash. */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Collects tests and runs them. Test files use the shared `defaultRunner` via
 * the exported describe/it functions. The harness's own self-tests create
 * private instances, so they can inspect results without polluting the real run.
 */
export class Runner {
  #tests = [];
  #suiteNames = [];
  #timeoutMs;

  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  /** Groups tests under a name. `register` runs immediately and should only call it()/describe(). */
  describe(name, register) {
    this.#suiteNames.push(name);
    try {
      register();
    } catch (error) {
      // A crash while registering would otherwise abort the whole module import
      // and hide every other test in the file. Record it as a failing test instead.
      this.#addTest('(error while registering tests)', () => {
        throw error;
      });
    } finally {
      this.#suiteNames.pop();
    }
  }

  /** Registers one test. `fn` may be sync or async. */
  it(name, fn) {
    this.#addTest(name, fn);
  }

  /** Records a test module that couldn't be imported (404, syntax error) as a failure. */
  recordLoadError(modulePath, error) {
    this.#tests.push({
      name: `load ${modulePath}`,
      fn: () => {
        throw error;
      },
    });
  }

  /**
   * Runs every registered test sequentially and returns
   * { results: [{ name, ok, error }], total, passed, failed, ok }.
   * `ok` is false for an empty run: zero tests almost always means a broken registry.
   */
  async run() {
    const results = [];
    for (const test of this.#tests) {
      results.push(await this.#runOne(test));
    }
    const passed = results.filter((result) => result.ok).length;
    return {
      results,
      total: results.length,
      passed,
      failed: results.length - passed,
      ok: results.length > 0 && passed === results.length,
    };
  }

  #addTest(name, fn) {
    this.#tests.push({ name: [...this.#suiteNames, name].join(NAME_SEPARATOR), fn });
  }

  async #runOne({ name, fn }) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${this.#timeoutMs} ms`)), this.#timeoutMs);
    });
    try {
      // Promise.resolve().then(fn) turns a synchronous throw into a rejection,
      // so sync and async tests share one code path.
      await Promise.race([Promise.resolve().then(fn), timeout]);
      return { name, ok: true, error: null };
    } catch (error) {
      return { name, ok: false, error: toError(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The runner that test modules register on and that tests/index.html runs. */
export const defaultRunner = new Runner();

/** Groups tests on the default runner. */
export function describe(name, register) {
  defaultRunner.describe(name, register);
}

/** Registers a test on the default runner. */
export function it(name, fn) {
  defaultRunner.it(name, fn);
}

/* ------------------------------------------------------------------------- */
/* Assertions                                                                */
/* ------------------------------------------------------------------------- */

/** Fails unless `condition` is truthy. */
export function assert(condition, message = 'Expected condition to be truthy') {
  if (!condition) {
    throw new AssertionError(message);
  }
}

/**
 * Fails unless `actual` deep-equals `expected`. Compares primitives with
 * Object.is, arrays element by element, plain objects key by key, Dates by
 * time, and Maps/Sets by their entries in order.
 */
export function assertEqual(actual, expected, message) {
  if (deepEqual(actual, expected)) {
    return;
  }
  const detail = `expected ${describeValue(expected)} but got ${describeValue(actual)}`;
  throw new AssertionError(message ? `${message}: ${detail}` : `Values differ: ${detail}`);
}

/** Fails unless `fn` throws (optionally an instance of `ErrorType`). Returns the error for further checks. */
export function assertThrows(fn, ErrorType) {
  try {
    fn();
  } catch (error) {
    checkErrorType(error, ErrorType);
    return error;
  }
  throw new AssertionError('Expected function to throw');
}

/**
 * Fails unless the promise (or the promise returned by `fnOrPromise()`) rejects,
 * optionally with an instance of `ErrorType`. Resolves to the rejection error.
 */
export async function assertRejects(fnOrPromise, ErrorType) {
  try {
    await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
  } catch (error) {
    checkErrorType(error, ErrorType);
    return error;
  }
  throw new AssertionError('Expected promise to reject');
}

/* ------------------------------------------------------------------------- */
/* Reporting                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Turns a run report into display text: a one-line summary plus one entry per
 * test. tests/run.sh relies on the "PASS"/"FAIL" summary wording.
 */
export function formatReport(report) {
  let summary;
  if (report.total === 0) {
    summary = 'FAIL — no tests ran';
  } else if (report.ok) {
    summary = `PASS — ${report.passed}/${report.total} tests passed`;
  } else {
    summary = `FAIL — ${report.failed} of ${report.total} tests failed`;
  }

  const lines = report.results.map((result) => ({
    ok: result.ok,
    text: result.ok ? `✓ ${result.name}` : `✗ ${result.name}\n    ${result.error.message}`,
  }));

  return { summary, lines };
}

/* ------------------------------------------------------------------------- */
/* Internals                                                                 */
/* ------------------------------------------------------------------------- */

function checkErrorType(error, ErrorType) {
  if (ErrorType && !(error instanceof ErrorType)) {
    throw new AssertionError(`Expected ${ErrorType.name} but got ${error?.name}: ${error?.message}`);
  }
}

/** Tests can throw anything; the report always needs an Error with a message. */
function toError(thrown) {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function deepEqual(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (a instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Map || a instanceof Set) {
    return deepEqual([...a], [...b]);
  }
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** Readable rendering of a value for failure messages. */
function describeValue(value) {
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Cyclic structures can't be JSON-encoded; String() is still informative.
    return String(value);
  }
}
