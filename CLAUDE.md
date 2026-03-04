# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Board Game Olympics is a lightweight, invitation-only event registration website for an annual board game gathering. It replaces a Facebook group as the central hub. Users register via invitation, claim a country, and interact via a message board.

## Tech Stack & Architecture

- **Frontend**: Static HTML, CSS, vanilla JavaScript — no frameworks, no build step, no npm
- **Backend**: Supabase (PostgreSQL, Auth, Storage, Email) — no custom server
- **Hosting**: Cloudflare Pages (auto-deploys on push to master)
- **Supabase JS client**: Loaded via CDN (`@supabase/supabase-js@2`), not npm

## Development

There is no build step, package manager, or test runner. The site is served as static files. To develop locally, use any static file server (e.g., `python3 -m http.server`).

**Configuration**: `config.js` holds Supabase credentials (gitignored). Copy `config.example.js` to `config.js` and fill in values. The anon key is safe to expose publicly — Row Level Security (RLS) protects data.

## Design Principles (from SPEC.md)

- **Static-first**: No frameworks, no build step, no library dependencies.
- **No custom backend**: Supabase handles all server-side logic.
- **Cheap to run**: Target free tiers (Supabase, Cloudflare Pages).
- **Document everything**: This project sits untouched for up to a year. Every function, module, and config choice must be heavily commented. Inline comments should explain *why*, not just *what*. Each JS file needs a header comment describing its purpose and integration.

## Code Organization

One JS file per feature — each module has a clear, single responsibility:

- `app.js` — Main entry point, routing, auth state
- `auth.js` — Login, logout, magic link, SSO
- `supabase.js` — Client initialization
- `feed.js` — Activity feed with infinite scroll
- `messages.js` — Message board with infinite scroll
- `profile.js` — Profile editing, country claiming, flag upload
- `rules.js` — Rules page rendering
- `admin.js` — Admin panel (invitations, users, themes, emails, moderation)
- `theme.js` — Light/dark mode, system preference detection

Single `css/styles.css` file organized by section comments.

## Theme System

Uses CSS custom properties with `[data-theme="dark"]` attribute. Color tokens are defined in `documentation/COLORS.md`. Key conventions:
- Light theme is default; dark is "Game Night Mode"
- Meeple icon colors: gray (inactive), warm orange (liked)
- System preference detection via `matchMedia('prefers-color-scheme: dark')`

## Data Model (Supabase)

Six tables: Users, Invitations, Messages, Message Likes ("Meeples"), Event Settings (Theme), Country Claims. All tables require RLS policies. Schema details and setup in `documentation/SETUP_SUPABASE.md`.

## Key Documentation

- `documentation/SPEC.md` — Complete application specification (the source of truth)
- `documentation/COLORS.md` — Light/dark theme color palette with CSS tokens
- `documentation/SETUP_SUPABASE.md` — Database schema, RLS policies, auth, storage config
- `documentation/SETUP_CLOUDFLARE.md` — Deployment and DNS setup
- `documentation/SEED_DATA_2025.md` — Test data (21 users, 20 messages)
- `documentation/CONTENT_CHECKLIST.md` — Content requirements before launch

## Auth Model

- Invitation-only: users must have an invitation (email or shareable link) to register
- SSO via Google/Facebook OAuth + magic link (passwordless email)
- Session persistence via cookies (survives browser restart)
- Default admin: Wiley Page (gwpage@gmail.com)

## Yearly Lifecycle

The app resets annually: archive old messages and country claims, preserve user accounts, reset RSVP statuses to "no response". Admin sets new event date and theme each year.
