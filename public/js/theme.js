/**
 * theme.js: light / dark ("Game Night Mode") theme handling. Built in ISSUE-006.
 *
 * WHAT IT WILL DO
 *   - resolveTheme(saved, systemPrefersDark): choose the theme. A saved choice
 *     wins; otherwise follow the OS setting; otherwise light.
 *   - The header toggle button switches theme, saves the choice to
 *     localStorage, and shows a moon in light mode and a sun in dark mode.
 *   - Follows live OS theme changes while the user hasn't made a choice.
 *
 * HOW IT FITS
 *   Colours are CSS custom properties keyed off <html data-theme="dark">
 *   (COLORS.md). The FIRST paint is handled by the small inline script in
 *   index.html's <head>, which duplicates resolveTheme() because it must run
 *   before any module loads. Keep the two in sync.
 */
