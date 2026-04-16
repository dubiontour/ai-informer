# AI Informer

AI Informer is a daily one-pager that aggregates the top AI news from trusted RSS feeds and displays them in a clean, professional card layout with Turivus branding. The page is regenerated every day at 07:00 UTC via GitHub Actions and served as a static site on GitHub Pages — no server required.

## Setup

1. Create a new GitHub repository (e.g. `ai-informer`)
2. Push this project to the `main` branch
3. Go to **Settings → Pages**, set Source to **Deploy from a branch**, select **main** branch and **/ (root)** folder
4. GitHub Actions will build and commit `index.html` automatically every day

## Run locally

```bash
npm install
npm run build
# Open index.html in your browser
```

## Add a new RSS source

Open `config/sources.json` and add one object:

```json
{ "name": "My Source", "url": "https://example.com/feed.xml", "category": "News" }
```

Valid categories: `Research`, `Tools`, `News` (or any new string — the filter UI picks it up automatically).

## White-label for a customer

1. Fork the repository
2. Edit `config/brand.json` — change `siteName`, colors, `footerLink`, and `footerLinkLabel`
3. Edit `config/site.json` — update `title`, `description`, and `baseUrl`
4. Push → GitHub Pages deploys automatically

No code changes needed.

## GitHub Actions

The workflow at `.github/workflows/daily.yml` runs `node src/build.js` every day at 07:00 UTC, commits the updated `index.html`, and pushes. You can also trigger it manually via **Actions → Daily Build → Run workflow**.
