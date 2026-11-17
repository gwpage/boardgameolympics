/**
 * theme.js: light / dark ("Game Night Mode") theme handling (ISSUE-006).
 *
 * WHAT IT DOES
 *   - resolveTheme(saved, systemPrefersDark) picks the theme. A saved choice
 *     wins, otherwise the OS setting decides, otherwise light.
 *   - initTheme() wires up the header toggle button (#theme-toggle in
 *     index.html). Clicking it flips the theme and saves the choice to
 *     localStorage. The button shows a moon in light mode and a sun in dark
 *     mode, and its label names what a click will do.
 *   - While the user has never clicked the toggle, live OS theme changes are
 *     followed. After a click, their choice sticks; there is no "back to
 *     automatic" option (COLORS.md describes a two-state toggle).
 *   - If localStorage throws (blocked site data, old Safari private mode), the
 *     toggle still works for the rest of the visit, and a warning is logged.
 *
 * HOW IT FITS
 *   Colours are CSS custom properties keyed off <html data-theme="light|dark">
 *   (COLORS.md, css/styles.css). The FIRST paint is handled by the small
 *   inline script in index.html's <head>. It must run before the stylesheet
 *   and can't import modules, so it repeats resolveTheme()'s rule.
 *   KEEP THE TWO IN SYNC. tests/js/test_006_theme.js runs the inline script
 *   against fakes and fails if it ever disagrees with this file.
 *
 *   app.js calls initTheme() once at start-up. Nothing here runs on import,
 *   so the test page can import this file safely.
 */

/** The two themes. These strings are the values of <html data-theme> and of the saved choice. */
export const LIGHT = 'light';
export const DARK = 'dark';

/** localStorage key for the user's explicit choice. Shared with the inline script in index.html. */
export const THEME_STORAGE_KEY = 'theme';

/** Attribute on <html> that the CSS token blocks key off. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Media query for the OS dark-mode setting. Shared with the inline script in index.html. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** id of the toggle button in index.html's header. */
export const TOGGLE_BUTTON_ID = 'theme-toggle';

/**
 * What the toggle shows in each theme. The icon shows where a click takes you
 * (moon = go dark, sun = go light), and the label says it in words for screen
 * readers and the tooltip.
 */
const TOGGLE_STATES = Object.freeze({
  [LIGHT]: { icon: 'moon', label: 'Switch to Game Night Mode (dark theme)' },
  [DARK]: { icon: 'sun', label: 'Switch to light theme' },
});

/*
 * Toggle icons, drawn here so the project needs no icon library. They use
 * currentColor, so their colour comes from the CSS tokens. aria-hidden keeps
 * them out of the accessibility tree; the button's aria-label carries the meaning.
 */
const ICON_SVG_ATTRIBUTES =
  'viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const ICONS = Object.freeze({
  // A crescent: the outer arc of one circle, cut by the arc of a smaller, offset one.
  moon: `<svg ${ICON_SVG_ATTRIBUTES}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>`,
  // A disc with eight short rays.
  sun:
    `<svg ${ICON_SVG_ATTRIBUTES}><circle cx="12" cy="12" r="4"/>` +
    '<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
});

/** True for the two valid theme names. */
function isTheme(value) {
  return value === LIGHT || value === DARK;
}

/**
 * Chooses the theme to show.
 *
 * @param {*} saved              The stored choice. Anything other than 'light' or 'dark' counts as no choice.
 * @param {boolean} systemPrefersDark  Whether the OS is in dark mode.
 * @returns {'light'|'dark'}
 *
 * The inline script in index.html repeats this rule. Keep them in sync.
 */
export function resolveTheme(saved, systemPrefersDark) {
  if (isTheme(saved)) {
    return saved;
  }
  return systemPrefersDark ? DARK : LIGHT;
}

/** The theme a toggle click switches to. Anything that isn't dark counts as light, so the next theme is dark. */
export function nextTheme(current) {
  return current === DARK ? LIGHT : DARK;
}

/**
 * Starts theme handling: applies the right theme, wires the toggle button,
 * and follows OS changes until the user makes a choice. Call once.
 *
 * Every dependency can be injected so tests can drive it with fakes. The
 * defaults are the real page.
 *
 * @param {object}  [options]
 * @param {Element} [options.root]        Element that gets data-theme (default: <html>).
 * @param {Storage|null} [options.storage]  Where the choice is saved (default: localStorage, or null if inaccessible).
 * @param {MediaQueryList|null} [options.mediaQuery]  The OS dark-mode query (default: matchMedia, or null if unsupported).
 * @param {HTMLButtonElement|null} [options.button]   The toggle (default: #theme-toggle). Without one, only the theme is applied.
 * @returns {{ readonly theme: 'light'|'dark', toggle: () => void }}
 */
export function initTheme({
  root = document.documentElement,
  storage = getBrowserStorage(),
  mediaQuery = getDarkSchemeQuery(),
  button = document.getElementById(TOGGLE_BUTTON_ID),
} = {}) {
  // The user's explicit choice, or null to follow the OS. Kept in memory as well
  // as in storage, so a choice that couldn't be saved still holds for this visit.
  let chosen = readSavedTheme(storage);

  const currentTheme = () => resolveTheme(chosen, Boolean(mediaQuery?.matches));

  const render = () => {
    const theme = currentTheme();
    root.setAttribute(THEME_ATTRIBUTE, theme);
    if (button) {
      renderToggleButton(button, theme);
    }
  };

  const toggle = () => {
    chosen = nextTheme(currentTheme());
    saveTheme(storage, chosen);
    render();
  };

  // Follow live OS theme changes. render() re-resolves, so once the user has
  // chosen, their choice still wins and an OS change is a no-op. A real
  // MediaQueryList updates `matches` before firing 'change'.
  mediaQuery?.addEventListener?.('change', render);

  if (button) {
    button.addEventListener('click', toggle);
    button.hidden = false;
  }

  render();

  return {
    get theme() {
      return currentTheme();
    },
    toggle,
  };
}

/** Shows the icon and label for `theme` on the toggle button. */
function renderToggleButton(button, theme) {
  const { icon, label } = TOGGLE_STATES[theme];
  if (button.dataset.icon !== icon) {
    // Safe: ICONS holds only the fixed SVG strings above, never user input.
    button.innerHTML = ICONS[icon];
    button.dataset.icon = icon;
  }
  button.setAttribute('aria-label', label);
  button.title = label;
}

/** The saved theme, or null if there is none, it's invalid, or storage can't be read. */
function readSavedTheme(storage) {
  if (!storage) {
    return null;
  }
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isTheme(saved) ? saved : null;
  } catch (error) {
    console.warn('Theme: could not read the saved theme, so following the system setting.', error);
    return null;
  }
}

/** Saves the choice. On failure, warns and carries on: the choice still holds in memory for this visit. */
function saveTheme(storage, theme) {
  if (!storage) {
    console.warn('Theme: localStorage is unavailable, so this choice will last only until the page is closed.');
    return;
  }
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn('Theme: could not save the theme, so it will last only until the page is closed.', error);
  }
}

/** window.localStorage, or null where even reading the property throws (e.g. Chrome with site data blocked). */
function getBrowserStorage() {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn('Theme: localStorage is blocked, so theme choices will not be saved.', error);
    return null;
  }
}

/** The OS dark-mode MediaQueryList, or null in a browser without matchMedia. */
function getDarkSchemeQuery() {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
}
