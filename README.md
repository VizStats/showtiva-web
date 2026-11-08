<p align="center">
  <a href="https://dev.showtiva.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.png">
      <img src=".github/logo-light.png" alt="ShowTiva" width="380">
    </picture>
  </a>
</p>

<p align="center">
  The streaming home for wholesome films and shows.
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB">
  <img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2020-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="ESLint 9" src="https://img.shields.io/badge/ESLint-9-4B32C3?logo=eslint&logoColor=white">
  <img alt="Deployed on Vercel" src="https://img.shields.io/badge/Vercel-preview-000000?logo=vercel&logoColor=white">
</p>

---

ShowTiva is a curated, family-safe destination for films, series, shorts, documentaries and imaginative entertainment. Every title is human-vetted before it is published, the whole platform sits under a PG ceiling, and creators keep full ownership of their work.

This repository is the web front end. It is an early, UI-first build: the catalog is placeholder data, sign-in is a demo that runs entirely in the browser, and the player has no video source yet. A preview is deployed at [showtiva-web.vercel.app](https://dev.showtiva.com).

## Getting started

Requires Node.js 20.9 or newer.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The landing page has two audiences: `/` for families and `/?role=creator` for creators. The catalog lives at `/watch`.

| Script | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |

## Project layout

```
app/            Routes (App Router)
  _auth/        Demo sign-in, sign-up and profile menu
  @auth/        Intercepting routes that open sign-in and sign-up as a modal
  api/          Read/write endpoints over the content stores
  browse/       Category pages with filters and pagination
  watch/        Catalog, title detail page, shared card and popover
  globals.css   Tailwind import, design tokens, keyframes, base styles
data/           JSON content stores (catalog and site copy)
lib/            Server-only store access, validation, shared types
public/         Logo assets and background videos
ui/             Small presentational pieces
```

## Content

There is no database yet. The catalog is `data/content.json` and the site copy is `data/site.json`; pages read them on every request, so an edit shows up without a rebuild. Both are validated before anything is written, writes are atomic, and the previous version is kept as a `.bak` file.

A REST API over both stores is documented in [ADMIN-API.md](ADMIN-API.md). Writes are disabled in production, where the filesystem is read-only, unless `ALLOW_CONTENT_WRITES=true` is set on a host with persistent disk. There is no authentication on the API; it must not be exposed publicly as-is.

## Styling

Tailwind CSS v4, configured in CSS rather than a config file. Fonts, colours and keyframes are declared under `@theme` in `app/globals.css`, so each one is also a utility. The few things that read badly as class lists, such as the logo-slant button cuts and the player's progress slider, are small `@utility` blocks in the same file.

## Deployment

Built for Vercel. The content stores are read at runtime, so `next.config.ts` lists them in `outputFileTracingIncludes` for every route that reads them.
