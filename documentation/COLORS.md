# Color Scheme & Theme Implementation

This document defines the color palette for both light and dark themes, and provides implementation guidance for the developer.

---

## Light Theme (Default)

### Background & Surfaces

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-page` | `#F7F6F3` | Page background |
| `--bg-card` | `#FFFFFF` | Card / panel background |
| `--bg-subtle` | `#EFEDE8` | Subtle section background |
| `--border` | `#E0DED9` | Borders and dividers |

### Text

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#1C1C1C` | Primary text |
| `--text-secondary` | `#5A5A5A` | Secondary text |
| `--text-muted` | `#8A8A8A` | Muted / metadata |
| `--text-link` | `#1F5FBF` | Links |

### Brand Colors (Buttons & Highlights)

| Token | Hex | Usage |
|-------|-----|-------|
| `--btn-primary` | `#1F5FBF` | Primary button (Register) |
| `--btn-primary-hover` | `#174A95` | Primary button hover |
| `--btn-secondary` | `#D62828` | Secondary button (Post / Save) |
| `--btn-secondary-hover` | `#A61E1E` | Secondary button hover |
| `--color-success` | `#2E8B57` | Confirmation states |
| `--color-gold` | `#F2B705` | Gold accent (winner flair / decorative) |
| `--meeple-inactive` | `#C8C4BC` | Meeple like button (not yet liked) |
| `--meeple-active` | `#E8740C` | Meeple like button (liked — warm orange) |

### Usage Notes

- Make the Register button blue (primary).
- Use red sparingly — secondary actions or emphasis only.
- Use gold only for headers, icons, or subtle decorative lines — not body UI.
- Meeple "like" buttons are muted gray when inactive, warm orange when the current user has liked a post. The orange stands out without clashing with the blue/red button palette.

---

## Dark Theme ("Game Night Mode")

### Background & Surfaces

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-page` | `#121212` | Page background |
| `--bg-card` | `#1E1E1E` | Card / panel background |
| `--bg-subtle` | `#262626` | Elevated surface |
| `--border` | `#333333` | Borders and dividers |

### Text

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#F2F2F2` | Primary text |
| `--text-secondary` | `#C8C8C8` | Secondary text |
| `--text-muted` | `#9A9A9A` | Muted / metadata |
| `--text-link` | `#3A7DDE` | Links |

### Brand Colors (Buttons & Highlights)

| Token | Hex | Usage |
|-------|-----|-------|
| `--btn-primary` | `#3A7DDE` | Primary button (Register) |
| `--btn-primary-hover` | `#2C66B8` | Primary button hover |
| `--btn-secondary` | `#D94A4A` | Secondary button |
| `--btn-secondary-hover` | `#B73737` | Secondary button hover |
| `--color-success` | `#4CAF50` | Confirmation states |
| `--color-gold` | `#FFD23F` | Gold accent |
| `--meeple-inactive` | `#555555` | Meeple like button (not yet liked) |
| `--meeple-active` | `#F2960C` | Meeple like button (liked — warm orange, slightly brighter for dark bg) |

---

## Implementation Guide

### CSS Custom Properties

Define all colors as CSS custom properties (variables) on the `:root` selector. Use a `[data-theme="dark"]` attribute on the `<html>` element to override them for dark mode.

```css
/* === Theme: Light (default) === */
:root {
  --bg-page: #F7F6F3;
  --bg-card: #FFFFFF;
  --bg-subtle: #EFEDE8;
  --border: #E0DED9;

  --text-primary: #1C1C1C;
  --text-secondary: #5A5A5A;
  --text-muted: #8A8A8A;
  --text-link: #1F5FBF;

  --btn-primary: #1F5FBF;
  --btn-primary-hover: #174A95;
  --btn-secondary: #D62828;
  --btn-secondary-hover: #A61E1E;
  --color-success: #2E8B57;
  --color-gold: #F2B705;
  --meeple-inactive: #C8C4BC;
  --meeple-active: #E8740C;
}

/* === Theme: Dark ("Game Night Mode") === */
[data-theme="dark"] {
  --bg-page: #121212;
  --bg-card: #1E1E1E;
  --bg-subtle: #262626;
  --border: #333333;

  --text-primary: #F2F2F2;
  --text-secondary: #C8C8C8;
  --text-muted: #9A9A9A;
  --text-link: #3A7DDE;

  --btn-primary: #3A7DDE;
  --btn-primary-hover: #2C66B8;
  --btn-secondary: #D94A4A;
  --btn-secondary-hover: #B73737;
  --color-success: #4CAF50;
  --color-gold: #FFD23F;
  --meeple-inactive: #555555;
  --meeple-active: #F2960C;
}
```

Then reference the variables everywhere in your CSS instead of hardcoding hex values:

```css
body {
  background-color: var(--bg-page);
  color: var(--text-primary);
}

.card {
  background-color: var(--bg-card);
  border: 1px solid var(--border);
}

a {
  color: var(--text-link);
}
```

### Respecting System Preferences

On page load, check the user's OS-level preference using `prefers-color-scheme`. If the user has previously made a manual choice (stored in `localStorage`), that takes priority.

```js
// theme.js — load before other scripts or inline in <head>

(function () {
  // Check for a saved preference; fall back to system preference
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  // If neither, the default light theme applies (no attribute needed)
})();
```

### Theme Toggle

Add a toggle button somewhere persistent (e.g., the header or sidebar). Clicking it switches between light and dark and saves the choice.

```js
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}
```

The button label or icon should reflect the current state (e.g., a sun icon in dark mode, a moon icon in light mode). Keep it simple — no animations required.

### Preventing Flash of Wrong Theme

To avoid a brief flash of the light theme before the JS runs, place the theme detection script **inline in the `<head>`** (not in an external file loaded with `defer` or at the end of `<body>`). This ensures the `data-theme` attribute is set before the browser paints.

```html
<head>
  <script>
    (function () {
      var saved = localStorage.getItem('theme');
      if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
      } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
  </script>
  <link rel="stylesheet" href="css/styles.css">
</head>
```
