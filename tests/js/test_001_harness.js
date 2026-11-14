/**
 * tests/js/test_001_harness.js — ISSUE-001
 *
 * Two groups of tests:
 *
 *  1. Harness self-tests. They build a separate Runner instance, register tests
 *     on it, run it, and check what it reports. This is what stops a broken
 *     harness from silently reporting "all green" for every later issue.
 *
 *  2. Scaffold checks. The static site under public/ must match SPEC § Project
 *     Structure and ADR-003: relative paths only, Supabase pinned with SRI,
 *     config handled outside git, header comments, and placeholder assets.
 *
 * Scaffold checks read repo files from the local test server (same origin).
 * They never touch the external network.
 */
import {
  AssertionError,
  Runner,
  assert,
  assertEqual,
  assertRejects,
  assertThrows,
  describe,
  formatReport,
  it,
} from '../harness.js';

/** The repo root, as served by tests/run.sh (or `python3 -m http.server` at the root). */
const REPO_ROOT = new URL('../../', import.meta.url);

/** jsDelivr URL for the Supabase UMD bundle, pinned to an exact x.y.z version (ADR-006). */
const SUPABASE_CDN_PATTERN =
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js$/;

/** A sha384 Subresource Integrity value: the prefix plus 48 bytes in base64 (64 characters). */
const SHA384_SRI_PATTERN = /^sha384-[A-Za-z0-9+/]{64}$/;

/** SPEC § Project Structure lists 9 app modules under public/js/. Fewer means the tree parse broke. */
const MIN_SPEC_JS_FILES = 9;

/** First four bytes of every .ico file: reserved (0, 0) then type 1 = icon. */
const ICO_MAGIC_BYTES = [0x00, 0x00, 0x01, 0x00];

/** Fetches a repo file as text, failing with a clear message if it is missing. */
async function readRepoFile(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `Expected ${path} to exist (HTTP ${response.status})`);
  return response.text();
}

/** Fetches and parses a repo HTML file without executing any of its scripts. */
async function parseRepoHtml(path) {
  return new DOMParser().parseFromString(await readRepoFile(path), 'text/html');
}

/** Fetches a repo file as raw bytes. */
async function readRepoBytes(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `Expected ${path} to exist (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/* ------------------------------------------------------------------------- */
/* 1. Harness self-tests                                                     */
/* ------------------------------------------------------------------------- */

describe('harness: pass/fail reporting', () => {
  it('reports a passing test as passed and a throwing test as failed', async () => {
    const inner = new Runner();
    inner.it('passes', () => {});
    inner.it('throws', () => {
      throw new Error('boom');
    });

    const report = await inner.run();

    assertEqual(report.total, 2);
    assertEqual(report.passed, 1);
    assertEqual(report.failed, 1);
    assertEqual(report.ok, false);
    assertEqual(
      report.results.map((result) => [result.name, result.ok]),
      [['passes', true], ['throws', false]],
    );
    assert(report.results[1].error.message.includes('boom'), 'failure keeps the original error');
  });

  it('marks a run as ok only when every test passed', async () => {
    const inner = new Runner();
    inner.it('one', () => {});
    inner.it('two', () => {});

    const report = await inner.run();

    assertEqual(report.ok, true);
  });

  it('treats a run with zero tests as not ok, because it means the registry is broken', async () => {
    const report = await new Runner().run();

    assertEqual(report.total, 0);
    assertEqual(report.ok, false);
  });

  it('prefixes test names with their describe blocks', async () => {
    const inner = new Runner();
    inner.describe('outer', () => {
      inner.describe('inner', () => {
        inner.it('case', () => {});
      });
    });

    const report = await inner.run();

    assertEqual(report.results[0].name, 'outer › inner › case');
  });

  it('records an error thrown while registering a describe block as a failure', async () => {
    const inner = new Runner();
    inner.describe('broken suite', () => {
      throw new Error('setup exploded');
    });
    inner.it('still runs', () => {});

    const report = await inner.run();

    assertEqual(report.failed, 1);
    assertEqual(report.passed, 1);
    assert(report.results[0].name.startsWith('broken suite'), report.results[0].name);
    assert(report.results[0].error.message.includes('setup exploded'));
  });

  it('counts a test module that failed to load as a failure', async () => {
    const inner = new Runner();
    inner.recordLoadError('./js/test_999_missing.js', new Error('404 Not Found'));

    const report = await inner.run();

    assertEqual(report.failed, 1);
    assert(report.results[0].name.includes('test_999_missing.js'), report.results[0].name);
  });

  it('wraps thrown non-Error values so the report always has a message', async () => {
    const inner = new Runner();
    inner.it('throws a string', () => {
      throw 'plain string'; // eslint-disable-line no-throw-literal -- deliberately testing this
    });

    const report = await inner.run();

    assertEqual(report.results[0].error.message, 'plain string');
  });
});

describe('harness: async tests', () => {
  it('awaits async tests before reporting them as passed', async () => {
    const inner = new Runner();
    let finished = false;
    inner.it('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });

    const report = await inner.run();

    assert(finished, 'async test body completed before run() resolved');
    assertEqual(report.passed, 1);
  });

  it('counts a rejected promise as a failure', async () => {
    const inner = new Runner();
    inner.it('rejects', () => Promise.reject(new Error('nope')));

    const report = await inner.run();

    assertEqual(report.failed, 1);
    assert(report.results[0].error.message.includes('nope'));
  });

  it('fails a test that never settles once the timeout passes', async () => {
    const inner = new Runner({ timeoutMs: 30 });
    inner.it('hangs', () => new Promise(() => {}));

    const report = await inner.run();

    assertEqual(report.failed, 1);
    assert(/timed out/i.test(report.results[0].error.message), report.results[0].error.message);
  });

  it('runs tests one at a time, in registration order', async () => {
    const inner = new Runner();
    const events = [];
    inner.it('first', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('first:end');
    });
    inner.it('second', () => {
      events.push('second');
    });

    await inner.run();

    assertEqual(events, ['first:start', 'first:end', 'second']);
  });
});

describe('harness: assertEqual', () => {
  it('passes for deeply equal objects and arrays', () => {
    assertEqual({ a: [1, { b: 'x' }], c: null }, { a: [1, { b: 'x' }], c: null });
  });

  it('fails for objects that differ deep inside', () => {
    assertThrows(() => assertEqual({ a: [1, 2] }, { a: [1, 3] }), AssertionError);
  });

  it('treats different array lengths and extra keys as unequal', () => {
    assertThrows(() => assertEqual([1, 2], [1, 2, 3]), AssertionError);
    assertThrows(() => assertEqual({ a: 1 }, { a: 1, b: undefined }), AssertionError);
  });

  it('does not treat an array and an object with the same keys as equal', () => {
    assertThrows(() => assertEqual(['x'], { 0: 'x' }), AssertionError);
  });

  it('compares Dates by time, and Maps and Sets by their entries', () => {
    assertEqual(new Date('2025-02-15T00:00:00Z'), new Date('2025-02-15T00:00:00Z'));
    assertThrows(() => assertEqual(new Map([['a', 1]]), new Map([['a', 2]])), AssertionError);
    assertThrows(() => assertEqual(new Set([1]), new Set([2])), AssertionError);
  });

  it('reports the expected and actual values in the failure message', () => {
    const error = assertThrows(() => assertEqual({ n: 1 }, { n: 2 }), AssertionError);

    assert(error.message.includes('{"n":2}'), `message names the expected value: ${error.message}`);
    assert(error.message.includes('{"n":1}'), `message names the actual value: ${error.message}`);
  });
});

describe('harness: other assertions', () => {
  it('assert throws AssertionError with the given message when the condition is falsy', () => {
    const error = assertThrows(() => assert(false, 'custom message'), AssertionError);

    assertEqual(error.message, 'custom message');
  });

  it('assertThrows fails when the function does not throw', () => {
    let caught = null;
    try {
      assertThrows(() => {});
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof AssertionError, 'expected an AssertionError');
  });

  it('assertThrows fails when the wrong error type is thrown', () => {
    assertThrows(() => assertThrows(() => {
      throw new TypeError('wrong kind');
    }, RangeError), AssertionError);
  });

  it('assertRejects returns the rejection error, and fails if the promise resolves', async () => {
    const error = await assertRejects(() => Promise.reject(new RangeError('bad')), RangeError);
    assertEqual(error.message, 'bad');

    let caught = null;
    try {
      await assertRejects(() => Promise.resolve('fine'));
    } catch (failure) {
      caught = failure;
    }
    assert(caught instanceof AssertionError, 'expected an AssertionError for a resolved promise');
  });
});

describe('harness: formatReport', () => {
  it('summarises a passing run and marks each line as passed', () => {
    const { summary, lines } = formatReport({
      results: [{ name: 'a', ok: true, error: null }, { name: 'b', ok: true, error: null }],
      total: 2,
      passed: 2,
      failed: 0,
      ok: true,
    });

    assertEqual(summary, 'PASS — 2/2 tests passed');
    assertEqual(lines, [{ ok: true, text: '✓ a' }, { ok: true, text: '✓ b' }]);
  });

  it('summarises a failing run and includes the error message under the failed test', () => {
    const { summary, lines } = formatReport({
      results: [{ name: 'a', ok: true, error: null }, { name: 'b', ok: false, error: new Error('broke') }],
      total: 2,
      passed: 1,
      failed: 1,
      ok: false,
    });

    assertEqual(summary, 'FAIL — 1 of 2 tests failed');
    assertEqual(lines[1], { ok: false, text: '✗ b\n    broke' });
  });

  it('summarises an empty run as a failure', () => {
    const { summary } = formatReport({ results: [], total: 0, passed: 0, failed: 0, ok: false });

    assertEqual(summary, 'FAIL — no tests ran');
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Scaffold checks                                                        */
/* ------------------------------------------------------------------------- */

describe('scaffold: configuration', () => {
  it('public/config.example.js defines placeholder Supabase settings on CONFIG', async () => {
    const source = await readRepoFile('public/config.example.js');
    // config.js is a classic script that declares a global const. Evaluating it
    // inside a function keeps that const out of this page's global scope.
    const config = new Function(`${source}\nreturn CONFIG;`)();

    assertEqual(Object.keys(config).sort(), ['SUPABASE_ANON_KEY', 'SUPABASE_URL']);
    assert(config.SUPABASE_URL.includes('your-project'), 'URL is an obvious placeholder');
    assert(config.SUPABASE_ANON_KEY.includes('your-anon-key'), 'anon key is an obvious placeholder');
  });

  it('.gitignore ignores config.js at any depth, which covers public/config.js', async () => {
    const lines = (await readRepoFile('.gitignore')).split('\n').map((line) => line.trim());

    // A pattern with no slash matches at every depth, so this one line protects public/config.js.
    assert(lines.includes('config.js'), '.gitignore must contain a bare `config.js` line');
  });
});

describe('scaffold: public/index.html', () => {
  it('uses only relative paths, so the site works at / in prod and at /public/ locally', async () => {
    const doc = await parseRepoHtml('public/index.html');
    const references = [...doc.querySelectorAll('[src], [href]')].flatMap((element) =>
      ['src', 'href'].map((name) => element.getAttribute(name)).filter((value) => value !== null),
    );

    const rootAbsolute = references.filter((value) => value.startsWith('/'));

    assert(references.length > 0, 'expected index.html to reference some files');
    assertEqual(rootAbsolute, [], 'root-absolute or protocol-relative references');
  });

  it('runs the inline theme script in <head> before the stylesheet', async () => {
    const doc = await parseRepoHtml('public/index.html');
    const firstScript = doc.querySelector('script');
    const stylesheet = doc.querySelector('link[rel="stylesheet"]');

    assert(firstScript.parentElement === doc.head, 'first script is in <head>');
    assert(!firstScript.hasAttribute('src'), 'first script is inline');
    assert(firstScript.textContent.includes('data-theme'), 'first script sets data-theme');
    assert(stylesheet, 'index.html links a stylesheet');
    assert(
      firstScript.compareDocumentPosition(stylesheet) & Node.DOCUMENT_POSITION_FOLLOWING,
      'theme script comes before the stylesheet, so the right theme paints first',
    );
  });

  it('loads config.js, then pinned Supabase with SRI, then js/app.js as a module', async () => {
    const doc = await parseRepoHtml('public/index.html');
    const scripts = [...doc.querySelectorAll('script')];

    assertEqual(scripts.length, 4, 'number of <script> elements');
    const [, config, supabaseClient, app] = scripts;

    assertEqual(config.getAttribute('src'), 'config.js');
    assert(!config.hasAttribute('type'), 'config.js is a classic script, so CONFIG is a global');

    assert(
      SUPABASE_CDN_PATTERN.test(supabaseClient.getAttribute('src')),
      `Supabase is loaded from jsDelivr, pinned to an exact version: ${supabaseClient.getAttribute('src')}`,
    );
    assert(SHA384_SRI_PATTERN.test(supabaseClient.getAttribute('integrity') ?? ''), 'Supabase has a sha384 SRI hash');
    assertEqual(supabaseClient.getAttribute('crossorigin'), 'anonymous');

    assertEqual(app.getAttribute('type'), 'module');
    assertEqual(app.getAttribute('src'), 'js/app.js');
  });
});

describe('scaffold: JavaScript modules', () => {
  it('every public/js file listed in SPEC § Project Structure exists and starts with a header comment', async () => {
    const spec = await readRepoFile('documentation/SPEC.md');
    // Entries two levels deep in the tree (│   │   ├── name.js) are exactly public/js/*.js.
    const files = [...spec.matchAll(/^│ {3}│ {3}[├└]── ([\w-]+\.js)\b/gm)].map((match) => match[1]);

    assert(files.length >= MIN_SPEC_JS_FILES, `expected ≥${MIN_SPEC_JS_FILES} JS files in the spec tree, found ${files.length}`);
    for (const file of files) {
      const source = await readRepoFile(`public/js/${file}`);
      assert(source.trimStart().startsWith('/**'), `public/js/${file} must start with a /** header comment`);
    }
  });
});

describe('scaffold: assets', () => {
  it('the existing logo has moved from assets/ to public/assets/', async () => {
    const moved = await fetch(new URL('public/assets/images/logo.png', REPO_ROOT));
    const old = await fetch(new URL('assets/images/logo.png', REPO_ROOT));

    assert(moved.ok, 'public/assets/images/logo.png exists');
    assertEqual(old.status, 404, 'assets/images/logo.png no longer exists at the repo root');
  });

  it('logo-small.png and default-avatar.png are square images that decode', async () => {
    for (const path of ['public/assets/images/logo-small.png', 'public/assets/images/default-avatar.png']) {
      const response = await fetch(new URL(path, REPO_ROOT));
      assert(response.ok, `${path} exists`);
      const bitmap = await createImageBitmap(await response.blob());

      assert(bitmap.width > 0, `${path} decodes`);
      assertEqual(bitmap.width, bitmap.height, `${path} is square`);
    }
  });

  it('favicon.ico is a real .ico file', async () => {
    const bytes = await readRepoBytes('public/assets/favicon.ico');

    assertEqual([...bytes.slice(0, ICO_MAGIC_BYTES.length)], ICO_MAGIC_BYTES);
  });

  it('meeple.svg is a single-colour icon that pages can recolour through currentColor', async () => {
    const source = await readRepoFile('public/assets/images/meeple.svg');
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');

    assert(!svg.querySelector('parsererror'), 'meeple.svg is well-formed XML');
    assert(svg.getElementById('meeple'), 'has an element with id="meeple" that pages can <use>');
    assert(source.includes('currentColor'), 'is painted with currentColor');
    assert(!/#[0-9a-f]{3,8}\b/i.test(source), 'contains no hard-coded hex colours');
  });
});
