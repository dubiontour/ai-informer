# AI Informer — Build Prompt

Build a daily AI news one-pager called "AI Informer" with the Turivus brand.

## What to build

A single static `index.html` that aggregates today's top AI news from RSS feeds and displays them in a clean, professional card layout. The page is regenerated daily via GitHub Actions and hosted on GitHub Pages.

## Project structure

```
ai-informer/
├── config/
│   ├── sources.json    ← RSS sources (add new ones here, never touch build.js)
│   ├── brand.json      ← colors, logo toggle, site name (white-label config)
│   └── site.json       ← title, description, domain, language
├── src/
│   └── build.js        ← reads configs, fetches RSS, writes index.html
├── .github/
│   └── workflows/
│       └── daily.yml   ← GitHub Actions cron: runs build.js every day 07:00 UTC
├── index.html          ← generated output (committed by CI, served by GitHub Pages)
├── favicon.svg         ← Turivus logo mark as SVG favicon
├── package.json
└── README.md
```

## Config files

### config/sources.json
Array of RSS sources. Adding a new source = add one object here, no code changes.

```json
[
  { "name": "Anthropic", "url": "https://www.anthropic.com/rss.xml", "category": "Research" },
  { "name": "OpenAI", "url": "https://openai.com/news/rss.xml", "category": "Research" },
  { "name": "Hugging Face", "url": "https://huggingface.co/blog/feed.xml", "category": "Tools" },
  { "name": "MIT Tech Review AI", "url": "https://www.technologyreview.com/topic/artificial-intelligence/feed/", "category": "News" },
  { "name": "VentureBeat AI", "url": "https://venturebeat.com/category/ai/feed/", "category": "News" }
]
```

### config/brand.json
White-label branding. Fork the repo and change this file for a new customer.

```json
{
  "siteName": "AI Informer",
  "logoSvg": "turivus",
  "colorPrimary": "#2E6473",
  "colorSecondary": "#C9A8A4",
  "colorBgDark": "#182E35",
  "colorBgDarkElevated": "#243E47",
  "colorBgLight": "#F5F2EF",
  "colorTextDark": "#EDE8E4",
  "colorTextLight": "#1A2C31",
  "footerLink": "https://turivus.com",
  "footerLinkLabel": "Powered by Turivus"
}
```

### config/site.json

```json
{
  "title": "AI Informer — Daily AI News",
  "description": "A daily digest of the most important AI news, research, and tools.",
  "language": "en",
  "baseUrl": "https://dubiontour.github.io/ai-informer"
}
```

## Build script (src/build.js)

Use Node.js ESM (`"type": "module"` in package.json).

Dependencies: only `fast-xml-parser` for RSS parsing. Use native `fetch` for HTTP (Node 18+).

Logic:
1. Read all three config files
2. Fetch all RSS sources in parallel with `Promise.allSettled` (failed sources are skipped silently)
3. Parse each feed, extract: `title`, `link`, `description`, `pubDate`, `source name`, `category`
4. Filter: only articles published in the last 48 hours
5. Deduplicate: skip if title is >80% similar to an already-included article
6. Limit: max 3 articles per source
7. Sort by date descending
8. Generate `index.html` using a template string (no template engine)
9. Write `index.html` to project root
10. Log: "Built X articles from Y sources" to stdout

## Generated index.html

The HTML is fully self-contained (no separate CSS or JS files). Use Tailwind CDN and Google Fonts CDN.

### Head

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{site.title}</title>
<meta name="description" content="{site.description}">
<!-- Open Graph -->
<meta property="og:title" content="{site.title}">
<meta property="og:description" content="{site.description}">
<meta property="og:type" content="website">
<meta property="og:url" content="{site.baseUrl}">
<!-- Tailwind CDN -->
<script src="https://cdn.tailwindcss.com"></script>
<!-- Google Fonts: Syne + Inter -->
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
```

### Design system (inline <style> block)

Define these CSS variables and classes in a `<style>` tag:

```css
:root {
  --teal: #2E6473;
  --rose: #C9A8A4;
  --dark: #182E35;
  --dark-elevated: #243E47;
  --light: #F5F2EF;
  --text-dark: #EDE8E4;
  --text-light: #1A2C31;
  --text-muted-dark: #A8BEC3;
  --text-muted-light: #526870;
  --border-dark: #2E4E58;
  --border-light: #E5E0DB;
}
body { font-family: 'Inter', sans-serif; }
h1, h2, h3 { font-family: 'Syne', sans-serif; }
.card { background: white; border: 1px solid var(--border-light); border-radius: 8px; padding: 24px; transition: transform 0.2s ease, box-shadow 0.2s ease; }
.card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
.badge { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--teal); color: var(--teal); display: inline-block; }
.filter-btn { padding: 6px 16px; border-radius: 4px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid var(--border-light); transition: all 0.15s; }
.filter-btn.active { background: var(--teal); color: white; border-color: var(--teal); }
```

### Layout structure

**Header** — dark background `#182E35`:
- Turivus logo SVG (inline, 32px, see below) + "AI Informer" text next to it
- Subtitle: "Daily AI News Digest"
- Last updated: "Updated: [date in format 'April 16, 2025']"
- Rose Gold `#C9A8A4` horizontal divider line at bottom

**Main section** — background `#F5F2EF`:
- Category filter buttons row: "All" / "Research" / "Tools" / "News"
  - Client-side JS: clicking a filter hides/shows cards by data-category attribute
  - "All" is active by default
- CSS grid of article cards: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6`
- Each card has:
  - Category badge (top)
  - Article title (Syne font, `text-lg font-bold`, color `#1A2C31`, max 2 lines)
  - Source name + formatted date (`text-sm`, muted color)
  - Description (max 3 lines, CSS `line-clamp-3`, color `#526870`)
  - "Read more →" link (color `#2E6473`, font-weight 600, opens in new tab)
- If no articles found: show a centered message "No articles found for today. Check back tomorrow."

**Footer** — dark background `#182E35`:
- Turivus logo SVG (inline, 24px) + "Powered by Turivus" link to turivus.com
- "Sources updated daily at 07:00 UTC"
- Small list of source names as text

### Turivus Logo SVG (inline, for dark backgrounds)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32" fill="none" aria-label="Turivus">
  <circle cx="50" cy="50" r="40" stroke="#C9A8A4" stroke-width="1.25"/>
  <path stroke="#EDE8E4" stroke-width="2.2" d="M47.25 35 L47.25 30.5 L30 30.5 L30 25 L70 25 L70 30.5 L52.75 30.5 L52.75 35"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="47.25" y1="30" x2="47.25" y2="65"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="52.75" y1="30" x2="52.75" y2="65"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="50" x2="90" y2="50"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="31.6" x2="57.8" y2="65"/>
  <circle cx="50" cy="73.5" r="4.5" stroke="#C9A8A4" stroke-width="1.25"/>
</svg>
```

### favicon.svg

Write this as a standalone file at project root:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <rect width="100" height="100" rx="16" fill="#182E35"/>
  <circle cx="50" cy="50" r="40" stroke="#C9A8A4" stroke-width="1.25"/>
  <path stroke="#EDE8E4" stroke-width="2.2" d="M47.25 35 L47.25 30.5 L30 30.5 L30 25 L70 25 L70 30.5 L52.75 30.5 L52.75 35"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="47.25" y1="30" x2="47.25" y2="65"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="52.75" y1="30" x2="52.75" y2="65"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="50" x2="90" y2="50"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="31.6" x2="57.8" y2="65"/>
  <circle cx="50" cy="73.5" r="4.5" stroke="#C9A8A4" stroke-width="1.25"/>
</svg>
```

## GitHub Actions (.github/workflows/daily.yml)

```yaml
name: Daily Build
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: node src/build.js
      - name: Commit and push if changed
        run: |
          git config user.name "AI Informer Bot"
          git config user.email "bot@turivus.com"
          git add index.html
          git diff --staged --quiet || git commit -m "chore: daily update $(date -u +%Y-%m-%d)"
          git push
```

## package.json

```json
{
  "name": "ai-informer",
  "version": "1.0.0",
  "description": "Daily AI news digest — Turivus",
  "type": "module",
  "scripts": {
    "build": "node src/build.js"
  },
  "dependencies": {
    "fast-xml-parser": "^4.4.0"
  }
}
```

## README.md

Include:
- What this project is (1 paragraph)
- Setup: create GitHub repo, enable Pages (Settings → Pages → main branch, root `/`)
- How to run locally: `npm install && npm run build`, then open `index.html` in browser
- How to add a new RSS source: add one line to `config/sources.json`
- How to white-label for a customer: fork repo, edit `config/brand.json` and `config/site.json`
- GitHub Actions: triggered daily at 07:00 UTC, can also be run manually via workflow_dispatch

## Completion criteria

Output `<promise>BUILD COMPLETE</promise>` only when ALL of the following are true:

1. `npm install && node src/build.js` runs without errors
2. `index.html` is generated and contains articles from at least 3 different sources
3. Category filter buttons work (tested by checking the JS is present and correct)
4. All three config files exist and are valid JSON
5. `favicon.svg` exists
6. `.github/workflows/daily.yml` exists and is valid YAML
7. `README.md` explains setup and white-labeling
