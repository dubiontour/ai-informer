import { readFile, writeFile, mkdir } from 'fs/promises';
import { XMLParser } from 'fast-xml-parser';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────
const [sources, brand, site] = await Promise.all([
  readFile(path.join(ROOT, 'config/sources.json'), 'utf8').then(JSON.parse),
  readFile(path.join(ROOT, 'config/brand.json'), 'utf8').then(JSON.parse),
  readFile(path.join(ROOT, 'config/site.json'), 'utf8').then(JSON.parse),
]);

// ── RSS Fetch & Parse ─────────────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', maxTotalExpansions: 10000 });
const CUTOFF_MS = 48 * 60 * 60 * 1000;
const now = Date.now();

function stripHtml(str = '') {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  const sa = a.toLowerCase().split(/\s+/);
  const sb = new Set(b.toLowerCase().split(/\s+/));
  const common = sa.filter(w => sb.has(w)).length;
  return common / Math.max(sa.length, sb.size);
}

async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'AI-Informer-Bot/1.0 (+https://turivus.ch)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel || parsed?.feed;
  const rawItems = channel?.item || channel?.entry || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.map(item => {
    const title = stripHtml(item.title?.['#text'] ?? item.title ?? '');
    const rawLink = item.link?.['@_href'] ?? item.link ?? item.guid ?? '';
    const link = isSafeUrl(rawLink) ? rawLink : '';
    const description = stripHtml(
      item.description ?? item.summary?.['#text'] ?? item.summary ?? item.content?.['#text'] ?? ''
    ).slice(0, 400);
    const pubDateRaw = item.pubDate ?? item.published ?? item.updated ?? '';
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : new Date(0);
    return { title, link, description, pubDate, source: source.name, category: source.category };
  }).filter(a => a.title && a.link && now - a.pubDate.getTime() <= CUTOFF_MS);
}

const results = await Promise.allSettled(sources.map(fetchSource));

// ── Aggregate & deduplicate ───────────────────────────────────────────────────
const articles = [];
const sourceCounts = {};

for (let i = 0; i < results.length; i++) {
  if (results[i].status !== 'fulfilled') {
    console.warn(`Skipped ${sources[i].name}: ${results[i].reason?.message}`);
    continue;
  }
  let count = 0;
  for (const article of results[i].value) {
    if (count >= 3) break;
    const isDupe = articles.some(a => similarity(a.title, article.title) > 0.8);
    if (!isDupe) {
      articles.push(article);
      sourceCounts[article.source] = (sourceCounts[article.source] ?? 0) + 1;
      count++;
    }
  }
}

articles.sort((a, b) => b.pubDate - a.pubDate);

const successfulSources = Object.keys(sourceCounts).length;
console.log(`Built ${articles.length} articles from ${successfulSources} sources`);

// ── Scrape article content ────────────────────────────────────────────────────
async function scrapeArticle(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const html = (await res.text()).slice(0, 150_000); // limit before regex to prevent ReDoS
    // Try to extract article/main content areas
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const raw = articleMatch?.[1] || mainMatch?.[1] || html;
    const text = stripHtml(raw).slice(0, 2500);
    return text.length > 150 ? text : '';
  } catch {
    return '';
  }
}

console.log(`Scraping ${articles.length} articles...`);
const scraped = await Promise.allSettled(articles.map(a => scrapeArticle(a.link)));
articles.forEach((a, i) => {
  a.content = (scraped[i].status === 'fulfilled' && scraped[i].value)
    ? scraped[i].value
    : a.description;
});
const scrapeHits = scraped.filter(r => r.status === 'fulfilled' && r.value.length > 150).length;
console.log(`Scraping done: ${scrapeHits}/${articles.length} successful`);

// ── TL;DR via Claude (once per day, cached in data/tldr.json) ─────────────────
const TLDR_PATH = path.join(ROOT, 'data/tldr.json');
const todayISO = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
let tldrItems = null;

// Try to load today's cached TL;DR first
try {
  const cached = JSON.parse(await readFile(TLDR_PATH, 'utf8'));
  if (cached.date === todayISO && Array.isArray(cached.items) && cached.items.length > 0) {
    tldrItems = cached.items;
    console.log(`TL;DR loaded from cache (${todayISO}): ${tldrItems.length} items`);
  }
} catch { /* no cache yet */ }

if (!tldrItems) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic();

      const articlesText = articles.slice(0, 15).map((a, i) =>
        `<article id="${i + 1}">\n<title>${a.title}</title>\n<source>${a.source}</source>\n<url>${a.link}</url>\n<content>${a.content.slice(0, 1200)}</content>\n</article>`
      ).join('\n\n');

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system: [{
          type: 'text',
          text: 'Du bist ein KI-Nachrichten-Redakteur. Erstelle ein prägnantes TL;DR auf Deutsch mit genau 7 Stichpunkten zu den wichtigsten KI-News von heute. Jeder Punkt ist 1-2 präzise Sätze. Wähle für jeden Punkt die passendste URL aus dem <url>-Tag des jeweiligen Artikels. Antworte NUR mit einem JSON-Array ohne Markdown oder Codeblock: [{"text":"...","url":"https://..."}]',
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: articlesText }],
      });

      const raw = msg.content[0].text.trim();
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        tldrItems = parsed.filter(item =>
          typeof item.text === 'string' && item.text.length > 0 && item.text.length < 600 &&
          typeof item.url === 'string' && isSafeUrl(item.url)
        );
        await writeFile(TLDR_PATH, JSON.stringify({ date: todayISO, items: tldrItems }, null, 2), 'utf8');
        console.log(`TL;DR generated: ${tldrItems.length} items (cache_read: ${msg.usage.cache_read_input_tokens})`);
      }
    } catch (e) {
      console.warn('TL;DR generation failed:', e.message);
    }
  } else {
    console.log('No ANTHROPIC_API_KEY — TL;DR skipped, showing top stories instead');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d) {
  return d.toLocaleDateString('de-CH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function relativeTime(d) {
  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffM = Math.floor(diffMs / 60_000);
  if (diffH >= 24) return formatDate(d);
  if (diffH >= 1) return `vor ${diffH}h`;
  if (diffM >= 1) return `vor ${diffM}m`;
  return 'gerade eben';
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isSafeUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const today = formatDate(new Date());
const categories = ['Alle', ...new Set(sources.map(s => s.category))];

const logoSvg32 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32" fill="none" aria-label="Turivus">
  <circle cx="50" cy="50" r="40" stroke="#C9A8A4" stroke-width="1.25"/>
  <path stroke="#EDE8E4" stroke-width="2.2" d="M47.25 35 L47.25 30.5 L30 30.5 L30 25 L70 25 L70 30.5 L52.75 30.5 L52.75 35"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="47.25" y1="30" x2="47.25" y2="65"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="52.75" y1="30" x2="52.75" y2="65"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="53.85" y1="50" x2="90" y2="50"/>
  <circle cx="50" cy="73.5" r="4.5" stroke="#C9A8A4" stroke-width="1.25"/>
</svg>`;

const logoSvg24 = logoSvg32.replace('width="32" height="32"', 'width="24" height="24"');
const logoSvg56 = logoSvg32.replace('width="32" height="32"', 'width="56" height="56"');

// ── TL;DR Sidebar HTML ────────────────────────────────────────────────────────
function renderTldrSidebar() {
  const isAI = tldrItems && tldrItems.length > 0;

  const items = isAI
    ? tldrItems.map(item => `
      <li class="tldr-item">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="tldr-link">
          ${escapeHtml(item.text)}
        </a>
      </li>`).join('')
    : articles.slice(0, 8).map(a => `
      <li class="tldr-item">
        <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer" class="tldr-link">
          <span class="tldr-src">${escapeHtml(a.source)}</span>
          ${escapeHtml(a.title)}
        </a>
      </li>`).join('');

  return `
  <aside class="tldr-col">
    <div class="tldr-card">
      <div class="tldr-head">
        <span class="tldr-eyebrow">TL;DR</span>
        <h2 class="tldr-title">Heute in AI</h2>
        <p class="tldr-date">${today}</p>
      </div>
      <ul class="tldr-list">${items}</ul>
      ${isAI ? '<p class="tldr-footer">KI-Zusammenfassung</p>' : ''}
    </div>
  </aside>`;
}

// ── Card HTML ─────────────────────────────────────────────────────────────────
function renderCard(a) {
  return `<article class="card" data-category="${escapeHtml(a.category)}">
  <span class="badge">${escapeHtml(a.category)}</span>
  <h2 class="card-title mt-3 mb-1 text-lg font-bold leading-snug" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
    <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer" class="hover:underline">${escapeHtml(a.title)}</a>
  </h2>
  <p class="card-meta text-sm mb-2">${escapeHtml(a.source)} &middot; <time datetime="${a.pubDate.toISOString()}" title="${formatDate(a.pubDate)}">${relativeTime(a.pubDate)}</time></p>
  <p class="card-meta text-sm leading-relaxed mb-4" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(a.description)}</p>
  <div class="flex items-center justify-between mt-auto">
    <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer" class="text-sm font-semibold" style="color:#2E6473;">Weiterlesen &rarr;</a>
    <button class="share-btn text-xs px-2 py-1 rounded" style="border:1px solid var(--card-border);color:var(--card-meta);background:transparent;cursor:pointer;" data-url="${escapeHtml(a.link)}" data-title="${escapeHtml(a.title)}" title="Teilen">↗ Teilen</button>
  </div>
</article>`;
}

const cardsHtml = articles.length > 0
  ? articles.map(renderCard).join('\n')
  : `<div class="col-span-2 text-center py-16" style="color:#526870;">Keine Artikel gefunden. Morgen wieder vorbeischauen.</div>`;

const filterBtns = categories.map((cat, i) =>
  `<button class="filter-btn${i === 0 ? ' active' : ''}" data-filter="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
).join('\n        ');

const sourceList = sources.map(s => `<span>${escapeHtml(s.name)}</span>`).join(' &middot; ');

// ── HTML Template ─────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="${site.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(site.title)}</title>
  <meta name="description" content="${escapeHtml(site.description)}">
  <meta property="og:title" content="${escapeHtml(site.title)}">
  <meta property="og:description" content="${escapeHtml(site.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(site.baseUrl)}">
  <meta property="og:image" content="${escapeHtml(site.baseUrl)}/favicon.svg">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(site.title)}">
  <meta name="twitter:description" content="${escapeHtml(site.description)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <style>
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
      --bg-page: #F5F2EF;
      --card-bg: #ffffff;
      --card-border: #E5E0DB;
      --card-title: #1A2C31;
      --card-meta: #526870;
      --filter-bg: #ffffff;
      --filter-border: #E5E0DB;
      --tldr-bg: #ffffff;
      --tldr-border: #E5E0DB;
      --tldr-text: #1A2C31;
      --tldr-meta: #526870;
      --tldr-head-bg: #2E6473;
      --tldr-head-text: #EDE8E4;
      --tldr-head-meta: #c8e0e6;
      --tldr-head-eyebrow: #C9A8A4;
    }
    html[data-theme="dark"] {
      --bg-page: #0F1E23;
      --card-bg: #182E35;
      --card-border: #2E4E58;
      --card-title: #EDE8E4;
      --card-meta: #A8BEC3;
      --filter-bg: #243E47;
      --filter-border: #2E4E58;
      --tldr-bg: #182E35;
      --tldr-border: #2E4E58;
      --tldr-head-bg: #182E35;
      --tldr-head-text: #EDE8E4;
      --tldr-head-meta: #A8BEC3;
      --tldr-head-eyebrow: #C9A8A4;
      --tldr-text: #EDE8E4;
      --tldr-meta: #A8BEC3;
    }
    body { font-family: 'Inter', sans-serif; background: var(--bg-page); transition: background 0.2s; }
    h1, h2, h3 { font-family: 'Syne', sans-serif; }

    /* Cards */
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 24px; display: flex; flex-direction: column; transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s, border-color 0.2s; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .card-title { color: var(--card-title); }
    .card-meta { color: var(--card-meta); }
    .badge { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--teal); color: var(--teal); display: inline-block; }

    /* Filters */
    .filter-btn { padding: 6px 16px; border-radius: 4px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid var(--filter-border); background: var(--filter-bg); color: var(--card-meta); transition: all 0.15s; }
    .filter-btn.active { background: var(--teal); color: white; border-color: var(--teal); }
    .filter-btn:hover:not(.active) { border-color: var(--teal); color: var(--teal); }

    /* Dark mode toggle */
    #theme-toggle { cursor: pointer; padding: 6px 10px; border-radius: 6px; border: 1px solid #2E4E58; background: #243E47; color: #A8BEC3; font-size: 0.8rem; font-family: 'Inter', sans-serif; transition: all 0.15s; }
    #theme-toggle:hover { border-color: #C9A8A4; color: #EDE8E4; }

    /* Back to top */
    #back-to-top { position: fixed; bottom: 2rem; right: 2rem; padding: 10px 14px; border-radius: 8px; background: var(--teal); color: white; border: none; cursor: pointer; font-size: 1rem; opacity: 0; pointer-events: none; transition: opacity 0.25s, transform 0.25s; transform: translateY(8px); z-index: 50; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    #back-to-top.visible { opacity: 1; pointer-events: auto; transform: translateY(0); }
    #back-to-top:hover { background: #3a7a8c; }

    /* TL;DR sidebar */
    .tldr-col { width: 100%; }
    @media (min-width: 1024px) { .tldr-col { width: 300px; flex-shrink: 0; } }
    .tldr-card { background: var(--tldr-bg); border: 1px solid var(--tldr-border); border-radius: 8px; overflow: hidden; transition: background 0.2s, border-color 0.2s; }
    .tldr-head { background: var(--tldr-head-bg); padding: 20px 20px 16px; border-bottom: 2px solid #C9A8A4; transition: background 0.2s; }
    .tldr-eyebrow { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: var(--tldr-head-eyebrow); display: block; margin-bottom: 4px; }
    .tldr-title { font-family: 'Syne', sans-serif; font-size: 1.25rem; font-weight: 700; color: var(--tldr-head-text); margin: 0 0 4px; }
    .tldr-date { font-size: 0.75rem; color: var(--tldr-head-meta); margin: 0; }
    .tldr-list { list-style: none; margin: 0; padding: 12px 0; overflow-y: auto; max-height: calc(100vh - 220px); scrollbar-width: thin; scrollbar-color: var(--teal) transparent; }
    .tldr-list::-webkit-scrollbar { width: 4px; }
    .tldr-list::-webkit-scrollbar-track { background: transparent; }
    .tldr-list::-webkit-scrollbar-thumb { background: var(--teal); border-radius: 2px; }
    .tldr-item { border-bottom: 1px solid var(--tldr-border); }
    .tldr-item:last-child { border-bottom: none; }
    .tldr-link { display: block; padding: 12px 20px; font-size: 0.82rem; line-height: 1.5; color: var(--tldr-text); text-decoration: none; transition: background 0.15s; }
    .tldr-link:hover { background: rgba(46,100,115,0.08); color: var(--teal); }
    .tldr-src { display: inline-block; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--teal); margin-right: 4px; }
    .tldr-footer { font-size: 0.65rem; color: var(--tldr-meta); padding: 8px 20px 12px; margin: 0; text-align: right; border-top: 1px solid var(--tldr-border); }

    /* Layout */
    .content-row { display: flex; flex-direction: column; gap: 2rem; }
    @media (min-width: 1024px) { .content-row { flex-direction: row; align-items: flex-start; } }
    .cards-col { flex: 1; min-width: 0; }
    .sticky-sidebar { position: sticky; top: 1.5rem; }
  </style>
  ${site.cfAnalyticsToken ? `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${site.cfAnalyticsToken}"}'></script>` : ''}
</head>
<body style="background:#F5F2EF;min-height:100vh;">

  <!-- Header -->
  <header style="background:#182E35;">
    <div class="max-w-6xl mx-auto px-6 py-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4 mb-2">
          ${logoSvg56}
          <div>
            <h1 class="text-3xl font-bold" style="color:#EDE8E4;">${escapeHtml(brand.siteName)}</h1>
            <p class="text-sm mt-0.5" style="color:#A8BEC3;">Täglicher KI-Nachrichten-Digest</p>
          </div>
        </div>
        <button id="theme-toggle" title="Hell/Dunkel umschalten">&#9728; Hell</button>
      </div>
      <div class="flex items-center gap-4 mt-1">
        <p class="text-xs" style="color:#A8BEC3;">Aktualisiert: ${today}</p>
        <span class="text-xs px-2 py-0.5 rounded-full" style="background:#243E47;color:#C9A8A4;">${articles.length} Artikel &middot; ${successfulSources} Quellen</span>
      </div>
    </div>
    <div style="height:2px;background:#C9A8A4;"></div>
  </header>

  <!-- Main -->
  <main class="max-w-6xl mx-auto px-6 py-8">

    <!-- Search + Filters -->
    <div class="flex flex-col sm:flex-row gap-3 mb-8">
      <input id="search" type="search" placeholder="Artikel suchen…" class="flex-1 px-4 py-2 rounded-md text-sm outline-none" style="border:1px solid var(--filter-border);background:var(--filter-bg);color:var(--card-title);min-width:0;" />
      <div class="flex flex-wrap gap-2">
        ${filterBtns}
      </div>
    </div>

    <!-- Content: TL;DR sidebar + Cards -->
    <div class="content-row">

      <!-- TL;DR Sidebar -->
      <div class="sticky-sidebar">
        ${renderTldrSidebar()}
      </div>

      <!-- Cards Grid -->
      <div class="cards-col">
        <div id="grid" class="grid grid-cols-1 sm:grid-cols-2 gap-6">
          ${cardsHtml}
        </div>
      </div>

    </div>
  </main>

  <!-- Back to top -->
  <button id="back-to-top" title="Nach oben" aria-label="Nach oben">&#8679;</button>

  <!-- Footer -->
  <footer style="background:#182E35;margin-top:4rem;">
    <div class="max-w-6xl mx-auto px-6 py-8">
      <div class="flex items-center gap-2 mb-3">
        ${logoSvg24}
        <a href="${escapeHtml(brand.footerLink)}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium" style="color:#A8BEC3;">${escapeHtml(brand.footerLinkLabel)}</a>
      </div>
      <p class="text-xs mb-2" style="color:#A8BEC3;">Quellen werden täglich um 07:00 MESZ aktualisiert</p>
      <p class="text-xs" style="color:#526870;">${sourceList}</p>
    </div>
  </footer>

  <script>
    // ── Filter + Search ───────────────────────────────────────────────────────
    const btns = document.querySelectorAll('.filter-btn');
    const cards = document.querySelectorAll('#grid [data-category]');
    const searchInput = document.getElementById('search');
    let activeFilter = 'Alle';

    function applyFilters() {
      const q = searchInput.value.toLowerCase().trim();
      cards.forEach(card => {
        const matchCat = activeFilter === 'Alle' || card.dataset.category === activeFilter;
        const text = card.textContent.toLowerCase();
        const matchQ = !q || text.includes(q);
        card.style.display = matchCat && matchQ ? '' : 'none';
      });
    }

    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        applyFilters();
      });
    });

    searchInput.addEventListener('input', applyFilters);

    // ── Share buttons ─────────────────────────────────────────────────────────
    document.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url;
        const title = btn.dataset.title;
        if (navigator.share) {
          await navigator.share({ title, url }).catch(() => {});
        } else {
          await navigator.clipboard.writeText(url).catch(() => {});
          const orig = btn.textContent;
          btn.textContent = 'Kopiert!';
          setTimeout(() => { btn.textContent = '↗ Teilen'; }, 1500);
        }
      });
    });

    // ── Back to top ───────────────────────────────────────────────────────────
    const backBtn = document.getElementById('back-to-top');
    window.addEventListener('scroll', () => {
      backBtn.classList.toggle('visible', window.scrollY > 400);
    }, { passive: true });
    backBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // ── Dark mode toggle ──────────────────────────────────────────────────────
    const toggle = document.getElementById('theme-toggle');
    const html = document.documentElement;

    function applyTheme(dark) {
      if (dark) {
        html.setAttribute('data-theme', 'dark');
        toggle.innerHTML = '&#9790; Dunkel';
      } else {
        html.removeAttribute('data-theme');
        toggle.innerHTML = '&#9728; Hell';
      }
    }

    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored === 'dark' || (!stored && prefersDark));

    toggle.addEventListener('click', () => {
      const isDark = html.getAttribute('data-theme') === 'dark';
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
      applyTheme(!isDark);
    });
  </script>
</body>
</html>`;

await writeFile(path.join(ROOT, 'index.html'), html, 'utf8');

// ── Rolling 30-day history + monthly archives ─────────────────────────────────
const HISTORY_PATH = path.join(ROOT, 'data/history.json');
const DATA_DIR = path.join(ROOT, 'data');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

await mkdir(DATA_DIR, { recursive: true });

let history = [];
try {
  history = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
} catch {
  // first run — start fresh
}

const todaySlim = articles.map(a => ({
  title: a.title,
  link: a.link,
  source: a.source,
  category: a.category,
  pubDate: a.pubDate.toISOString(),
}));

const allSeen = new Set();
const allEntries = [...history, ...todaySlim].filter(a => {
  if (allSeen.has(a.link)) return false;
  allSeen.add(a.link);
  return true;
});

const recent = [];
const toArchive = new Map();

for (const entry of allEntries) {
  const age = Date.now() - new Date(entry.pubDate).getTime();
  if (age <= THIRTY_DAYS_MS) {
    recent.push(entry);
  } else {
    const d = new Date(entry.pubDate);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!toArchive.has(key)) toArchive.set(key, []);
    toArchive.get(key).push(entry);
  }
}

let archivedTotal = 0;
for (const [month, entries] of toArchive) {
  const archivePath = path.join(DATA_DIR, `archive-${month}.json`);
  let existing = [];
  try {
    existing = JSON.parse(await readFile(archivePath, 'utf8'));
  } catch { /* new month */ }

  const archiveSeen = new Set(existing.map(e => e.link));
  const merged = [...existing, ...entries.filter(e => !archiveSeen.has(e.link))];
  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  await writeFile(archivePath, JSON.stringify(merged, null, 2), 'utf8');
  archivedTotal += entries.filter(e => !archiveSeen.has(e.link)).length;
  console.log(`Archive ${month}: ${merged.length} entries`);
}

recent.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
await writeFile(HISTORY_PATH, JSON.stringify(recent, null, 2), 'utf8');
console.log(`History: ${recent.length} entries (30-day rolling) | archived ${archivedTotal}`);
