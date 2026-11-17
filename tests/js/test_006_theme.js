/**
 * tests/js/test_006_theme.js — ISSUE-006
 *
 * Light / dark ("Game Night Mode") theme. Four groups:
 *
 *  1. resolveTheme / nextTheme: the pure rules for choosing a theme.
 *  2. initTheme: the real controller, driven through a real DOM with a fake
 *     localStorage and a fake prefers-color-scheme query. Covers the toggle
 *     button, saving, live OS changes and a throwing localStorage.
 *  3. public/index.html: the inline <head> script must choose exactly what
 *     theme.js chooses (it's a copy, because it runs before modules load), and
 *     the header must hold the toggle button.
 *  4. public/css/styles.css: every COLORS.md token in both themes with the
 *     identical hex, and no hex colours anywhere else.
 *
 * Everything runs in a separate, throwaway document, so the test page's own
 * <html data-theme> and localStorage are never touched.
 */
import { assert, assertEqual, describe, it } from '../harness.js';
import {
  DARK,
  DARK_SCHEME_QUERY,
  LIGHT,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  TOGGLE_BUTTON_ID,
  initTheme,
  nextTheme,
  resolveTheme,
} from '../../public/js/theme.js';

/** The repo root, as served by tests/run.sh (or `python3 -m http.server` at the root). */
const REPO_ROOT = new URL('../../', import.meta.url);

/** COLORS.md defines 16 tokens per theme. Fewer means the table parse broke, not that tokens were removed. */
const MIN_COLOR_TOKENS = 16;

/** Selectors of the two token blocks in styles.css (COLORS.md § CSS Custom Properties). */
const LIGHT_TOKEN_SELECTOR = ':root';
const DARK_TOKEN_SELECTOR = '[data-theme="dark"]';

/** A CSS hex colour: #rgb, #rgba, #rrggbb or #rrggbbaa. */
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;

/** A COLORS.md table row: | `--token` | `#HEX` | usage |. */
const TOKEN_ROW = /^\|\s*`(--[\w-]+)`\s*\|\s*`(#[0-9a-f]{3,8})`\s*\|/gim;

/* ------------------------------------------------------------------------- */
/* Fakes and helpers                                                         */
/* ------------------------------------------------------------------------- */

/** Fetches a repo file as text, failing with a clear message if it is missing. */
async function readRepoFile(path) {
  const response = await fetch(new URL(path, REPO_ROOT));
  assert(response.ok, `Expected ${path} to exist (HTTP ${response.status})`);
  return response.text();
}

/** A localStorage stand-in backed by a Map. */
function createMemoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** A localStorage that throws on every call, like blocked site data or old Safari private mode. */
function createThrowingStorage() {
  const fail = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

/**
 * A stand-in for matchMedia('(prefers-color-scheme: dark)'). setMatches()
 * fires 'change' the way a real MediaQueryList does when the OS theme changes.
 */
class FakeDarkSchemeQuery extends EventTarget {
  constructor(matches) {
    super();
    this.matches = matches;
  }

  setMatches(matches) {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

/**
 * Builds a throwaway document with a hidden toggle button, as index.html has,
 * and starts initTheme on it. Returns the pieces a test needs to inspect.
 */
function startTheme({ storage = createMemoryStorage(), systemDark = false, mediaQuery } = {}) {
  const doc = document.implementation.createHTMLDocument('theme test');
  const button = doc.createElement('button');
  button.type = 'button';
  button.hidden = true;
  doc.body.append(button);

  const query = mediaQuery === undefined ? new FakeDarkSchemeQuery(systemDark) : mediaQuery;
  const controller = initTheme({ root: doc.documentElement, storage, mediaQuery: query, button });

  return {
    controller,
    button,
    storage,
    mediaQuery: query,
    /** The theme currently applied to the <html> element. */
    applied: () => doc.documentElement.getAttribute(THEME_ATTRIBUTE),
  };
}

/**
 * Runs `fn` with console.warn captured, so expected warnings don't clutter the
 * console and can be checked. Returns the captured calls.
 */
async function captureWarnings(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

/** The inline (src-less) script in index.html's <head>. */
async function readInlineThemeScript() {
  const html = await readRepoFile('public/index.html');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const script = doc.head.querySelector('script:not([src])');
  assert(script, 'index.html has an inline script in <head>');
  return script.textContent;
}

/**
 * Runs the inline head script against fakes and returns the theme it set.
 * `window`, `document` and `localStorage` are passed as parameters, so they
 * shadow the real globals: the script can't touch the test page.
 */
function runInlineThemeScript(source, { storage, systemDark, hasMatchMedia }) {
  const root = document.implementation.createHTMLDocument('inline script test').documentElement;
  const fakeWindow = {
    localStorage: storage,
    matchMedia: hasMatchMedia ? (query) => ({ matches: query === DARK_SCHEME_QUERY && systemDark }) : undefined,
  };
  // eslint-disable-next-line no-new-func -- deliberately evaluating the page's own inline script
  new Function('window', 'document', 'localStorage', source)(fakeWindow, { documentElement: root }, storage);
  return root.getAttribute(THEME_ATTRIBUTE);
}

/** Text between two Markdown headings (prefix match), failing clearly if either is missing. */
function sectionBetween(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start);
  assert(start !== -1 && end !== -1, `COLORS.md must have a "${startHeading}" section followed by "${endHeading}"`);
  return markdown.slice(start, end);
}

/** COLORS.md token tables → { light: Map(token → HEX), dark: Map(token → HEX) }. */
function parseColorsDoc(markdown) {
  const parseTable = (section) =>
    new Map([...section.matchAll(TOKEN_ROW)].map(([, token, hex]) => [token, hex.toUpperCase()]));
  return {
    light: parseTable(sectionBetween(markdown, '## Light Theme', '## Dark Theme')),
    dark: parseTable(sectionBetween(markdown, '## Dark Theme', '## Implementation Guide')),
  };
}

/**
 * Every innermost `selector { declarations }` block in a stylesheet, comments
 * removed. Without CSS nesting (not used here), a block with no braces inside
 * it is a declaration block, including rules inside @media.
 */
function declarationBlocks(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    declarations: body
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(':');
        return { property: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() };
      }),
  }));
}

/** The one block in styles.css with exactly this selector. */
function tokenBlock(blocks, selector) {
  const matches = blocks.filter((block) => block.selector === selector);
  assertEqual(matches.length, 1, `number of "${selector}" blocks in styles.css`);
  return matches[0];
}

/* ------------------------------------------------------------------------- */
/* 1. Pure rules                                                             */
/* ------------------------------------------------------------------------- */

describe('theme: resolveTheme', () => {
  it('a saved choice wins over the system setting', () => {
    assertEqual(resolveTheme(DARK, false), DARK);
    assertEqual(resolveTheme(LIGHT, true), LIGHT);
  });

  it('with no saved choice, follows the system setting', () => {
    assertEqual(resolveTheme(null, true), DARK);
    assertEqual(resolveTheme(null, false), LIGHT);
  });

  it('treats an unrecognised saved value as no choice', () => {
    assertEqual(resolveTheme('bogus', true), DARK);
    assertEqual(resolveTheme('', false), LIGHT);
    assertEqual(resolveTheme(undefined, true), DARK);
  });
});

describe('theme: nextTheme', () => {
  it('flips dark ↔ light', () => {
    assertEqual(nextTheme(DARK), LIGHT);
    assertEqual(nextTheme(LIGHT), DARK);
  });

  it('treats no theme as light, so the next one is dark', () => {
    assertEqual(nextTheme(null), DARK);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. initTheme                                                              */
/* ------------------------------------------------------------------------- */

describe('theme: initTheme start-up', () => {
  it('applies a saved choice over the system setting', () => {
    const page = startTheme({ storage: createMemoryStorage({ [THEME_STORAGE_KEY]: LIGHT }), systemDark: true });
    assertEqual(page.applied(), LIGHT);
  });

  it('with nothing saved, applies the system setting', () => {
    assertEqual(startTheme({ systemDark: true }).applied(), DARK);
    assertEqual(startTheme({ systemDark: false }).applied(), LIGHT);
  });

  it('falls back to light where matchMedia is unsupported', () => {
    assertEqual(startTheme({ mediaQuery: null }).applied(), LIGHT);
  });

  it('reveals the toggle button, which index.html ships hidden', () => {
    assertEqual(startTheme().button.hidden, false);
  });
});

describe('theme: toggle button', () => {
  it('switches the theme and saves the choice', () => {
    const page = startTheme({ systemDark: false });

    page.button.click();
    assertEqual(page.applied(), DARK);
    assertEqual(page.storage.getItem(THEME_STORAGE_KEY), DARK);

    page.button.click();
    assertEqual(page.applied(), LIGHT);
    assertEqual(page.storage.getItem(THEME_STORAGE_KEY), LIGHT);
  });

  it('shows a moon in light mode and a sun in dark mode, with a label naming the action', () => {
    const page = startTheme({ systemDark: false });

    assertEqual(page.button.dataset.icon, 'moon');
    assert(page.button.querySelector('svg'), 'the button contains an icon');
    assert(/dark|game night/i.test(page.button.getAttribute('aria-label')), 'light mode label offers dark mode');
    assertEqual(page.button.title, page.button.getAttribute('aria-label'), 'tooltip matches the label');

    page.button.click();
    assertEqual(page.button.dataset.icon, 'sun');
    assert(/light/i.test(page.button.getAttribute('aria-label')), 'dark mode label offers light mode');
    assertEqual(page.button.title, page.button.getAttribute('aria-label'), 'tooltip matches the label');
  });

  it('keeps the icon decorative, so screen readers read only the label', () => {
    const icon = startTheme().button.querySelector('svg');
    assertEqual(icon.getAttribute('aria-hidden'), 'true');
  });
});

describe('theme: live OS theme changes', () => {
  it('are followed while nothing is saved', () => {
    const page = startTheme({ systemDark: false });

    page.mediaQuery.setMatches(true);
    assertEqual(page.applied(), DARK);
    assertEqual(page.button.dataset.icon, 'sun', 'the button follows too');

    page.mediaQuery.setMatches(false);
    assertEqual(page.applied(), LIGHT);
  });

  it('are ignored once a choice is saved', () => {
    const page = startTheme({ storage: createMemoryStorage({ [THEME_STORAGE_KEY]: LIGHT }), systemDark: false });
    page.mediaQuery.setMatches(true);
    assertEqual(page.applied(), LIGHT);
  });

  it('are ignored after a toggle, even when the choice could not be saved', async () => {
    await captureWarnings(() => {
      const page = startTheme({ storage: createThrowingStorage(), systemDark: false });
      page.button.click();
      page.mediaQuery.setMatches(true);
      page.mediaQuery.setMatches(false);
      assertEqual(page.applied(), DARK, 'the toggled choice holds for the rest of the visit');
    });
  });
});

describe('theme: throwing localStorage (private mode, blocked site data)', () => {
  it('still starts, follows the system, and toggles', async () => {
    const warnings = await captureWarnings(() => {
      const page = startTheme({ storage: createThrowingStorage(), systemDark: true });
      assertEqual(page.applied(), DARK, 'start-up falls back to the system setting');

      page.button.click();
      assertEqual(page.applied(), LIGHT, 'the toggle still switches the theme');
    });
    assert(warnings.length > 0, 'storage failures are reported with console.warn, not swallowed');
  });
});

/* ------------------------------------------------------------------------- */
/* 3. public/index.html                                                      */
/* ------------------------------------------------------------------------- */

describe('theme: public/index.html', () => {
  it('the inline <head> script chooses the same theme as theme.js in every case', async () => {
    const source = await readInlineThemeScript();
    const savedCases = [
      { label: 'saved dark', makeStorage: () => createMemoryStorage({ [THEME_STORAGE_KEY]: DARK }), saved: DARK },
      { label: 'saved light', makeStorage: () => createMemoryStorage({ [THEME_STORAGE_KEY]: LIGHT }), saved: LIGHT },
      { label: 'nothing saved', makeStorage: () => createMemoryStorage(), saved: null },
      { label: 'junk saved', makeStorage: () => createMemoryStorage({ [THEME_STORAGE_KEY]: 'bogus' }), saved: 'bogus' },
      { label: 'storage throws', makeStorage: createThrowingStorage, saved: null },
    ];
    const systemCases = [
      { label: 'system dark', systemDark: true, hasMatchMedia: true },
      { label: 'system light', systemDark: false, hasMatchMedia: true },
      { label: 'no matchMedia', systemDark: false, hasMatchMedia: false },
    ];

    const mismatches = [];
    await captureWarnings(() => {
      for (const savedCase of savedCases) {
        for (const systemCase of systemCases) {
          const expected = resolveTheme(savedCase.saved, systemCase.systemDark);
          const inline = runInlineThemeScript(source, { storage: savedCase.makeStorage(), ...systemCase });
          const module = startTheme({
            storage: savedCase.makeStorage(),
            mediaQuery: systemCase.hasMatchMedia ? new FakeDarkSchemeQuery(systemCase.systemDark) : null,
          }).applied();
          if (inline !== expected || module !== expected) {
            mismatches.push(`${savedCase.label}, ${systemCase.label}: expected ${expected}, inline ${inline}, initTheme ${module}`);
          }
        }
      }
    });
    assertEqual(mismatches, [], 'inline script vs resolveTheme vs initTheme');
  });

  it('has the toggle button in a <header> outside #app, hidden until theme.js wires it up', async () => {
    const html = await readRepoFile('public/index.html');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const button = doc.getElementById(TOGGLE_BUTTON_ID);

    assert(button, `index.html has #${TOGGLE_BUTTON_ID}`);
    assertEqual(button.tagName, 'BUTTON');
    assertEqual(button.getAttribute('type'), 'button');
    assert(button.closest('header'), 'the toggle is in a <header>');
    assert(!button.closest('#app'), 'the toggle is outside #app, so rendering a view never removes it');
    assert(button.hasAttribute('hidden'), 'hidden until JS runs, so it never shows as a dead button');
  });
});

/* ------------------------------------------------------------------------- */
/* 4. public/css/styles.css                                                  */
/* ------------------------------------------------------------------------- */

describe('theme: styles.css tokens', () => {
  it('defines every COLORS.md token with the identical hex, in both themes', async () => {
    const colors = parseColorsDoc(await readRepoFile('documentation/COLORS.md'));
    const blocks = declarationBlocks(await readRepoFile('public/css/styles.css'));

    assert(colors.light.size >= MIN_COLOR_TOKENS, `expected ≥${MIN_COLOR_TOKENS} light tokens, parsed ${colors.light.size}`);
    assertEqual([...colors.dark.keys()].sort(), [...colors.light.keys()].sort(), 'COLORS.md themes define the same tokens');

    const mismatches = [];
    for (const [theme, selector, expectedTokens] of [
      [LIGHT, LIGHT_TOKEN_SELECTOR, colors.light],
      [DARK, DARK_TOKEN_SELECTOR, colors.dark],
    ]) {
      const defined = new Map(
        tokenBlock(blocks, selector).declarations.map(({ property, value }) => [property, value.toUpperCase()]),
      );
      for (const [token, hex] of expectedTokens) {
        if (defined.get(token) !== hex) {
          mismatches.push(`${theme} ${token}: COLORS.md ${hex}, styles.css ${defined.get(token) ?? 'missing'}`);
        }
      }
    }
    assertEqual(mismatches, [], 'token mismatches');
  });

  it('has no hex colours outside the token blocks', async () => {
    const blocks = declarationBlocks(await readRepoFile('public/css/styles.css'));
    const tokenSelectors = [LIGHT_TOKEN_SELECTOR, DARK_TOKEN_SELECTOR];

    const offenders = blocks.flatMap(({ selector, declarations }) =>
      declarations
        // Inside a token block only the custom properties (--name) may hold hex.
        .filter(({ property }) => !(tokenSelectors.includes(selector) && property.startsWith('--')))
        .filter(({ value }) => HEX_COLOR.test(value))
        .map(({ property, value }) => `${selector} { ${property}: ${value} }`),
    );

    assert(blocks.length > tokenSelectors.length, 'styles.css has rules besides the token blocks');
    assertEqual(offenders, [], 'hard-coded hex colours (use var(--token))');
  });
});
