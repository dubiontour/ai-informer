import { readFile, writeFile } from 'fs/promises';
import { XMLParser } from 'fast-xml-parser';
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
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const CUTOFF_MS = 48 * 60 * 60 * 1000; // 48 hours
const now = Date.now();

function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function similarity(a, b) {
  const sa = a.toLowerCase().split(/\s+/);
  const sb = new Set(b.toLowerCase().split(/\s+/));
  const common = sa.filter(w => sb.has(w)).length;
  return common / Math.max(sa.length, sb.size);
}

async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'AI-Informer-Bot/1.0 (+https://turivus.com)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = parser.parse(xml);

  // Support both RSS and Atom
  const channel = parsed?.rss?.channel || parsed?.feed;
  const rawItems = channel?.item || channel?.entry || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.map(item => {
    const title = stripHtml(item.title?.['#text'] ?? item.title ?? '');
    const link = item.link?.['@_href'] ?? item.link ?? item.guid ?? '';
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d) {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function relativeTime(d) {
  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffM = Math.floor(diffMs / 60_000);
  if (diffH >= 24) return formatDate(d);
  if (diffH >= 1) return `${diffH}h ago`;
  if (diffM >= 1) return `${diffM}m ago`;
  return 'just now';
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const today = formatDate(new Date());
const categories = ['All', ...new Set(sources.map(s => s.category))];

const logoSvg32 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32" fill="none" aria-label="Turivus">
  <circle cx="50" cy="50" r="40" stroke="#C9A8A4" stroke-width="1.25"/>
  <path stroke="#EDE8E4" stroke-width="2.2" d="M47.25 35 L47.25 30.5 L30 30.5 L30 25 L70 25 L70 30.5 L52.75 30.5 L52.75 35"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="47.25" y1="30" x2="47.25" y2="65"/>
  <line stroke="#EDE8E4" stroke-width="2.2" x1="52.75" y1="30" x2="52.75" y2="65"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="50" x2="90" y2="50"/>
  <line stroke="#C9A8A4" stroke-width="1.25" x1="57.8" y1="31.6" x2="57.8" y2="65"/>
  <circle cx="50" cy="73.5" r="4.5" stroke="#C9A8A4" stroke-width="1.25"/>
</svg>`;

const logoSvg24 = logoSvg32.replace('width="32" height="32"', 'width="24" height="24"');

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
    <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer" class="text-sm font-semibold" style="color:#2E6473;">Read more &rarr;</a>
    <button class="share-btn text-xs px-2 py-1 rounded" style="border:1px solid var(--card-border);color:var(--card-meta);background:transparent;cursor:pointer;" data-url="${escapeHtml(a.link)}" data-title="${escapeHtml(a.title)}" title="Share">&#8679; Share</button>
  </div>
</article>`;
}

const cardsHtml = articles.length > 0
  ? articles.map(renderCard).join('\n')
  : `<div class="col-span-3 text-center py-16" style="color:#526870;">No articles found for today. Check back tomorrow.</div>`;

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
      /* light mode tokens */
      --bg-page: #F5F2EF;
      --card-bg: #ffffff;
      --card-border: #E5E0DB;
      --card-title: #1A2C31;
      --card-meta: #526870;
      --filter-bg: #ffffff;
      --filter-border: #E5E0DB;
    }
    html[data-theme="dark"] {
      --bg-page: #0F1E23;
      --card-bg: #182E35;
      --card-border: #2E4E58;
      --card-title: #EDE8E4;
      --card-meta: #A8BEC3;
      --filter-bg: #243E47;
      --filter-border: #2E4E58;
    }
    body { font-family: 'Inter', sans-serif; background: var(--bg-page); transition: background 0.2s; }
    h1, h2, h3 { font-family: 'Syne', sans-serif; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 24px; transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s, border-color 0.2s; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .card-title { color: var(--card-title); }
    .card-meta { color: var(--card-meta); }
    .badge { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--teal); color: var(--teal); display: inline-block; }
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
  </style>
</head>
<body style="background:#F5F2EF;min-height:100vh;">

  <!-- Header -->
  <header style="background:#182E35;">
    <div class="max-w-6xl mx-auto px-6 py-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3 mb-2">
          ${logoSvg32}
          <h1 class="text-2xl font-bold" style="color:#EDE8E4;">${escapeHtml(brand.siteName)}</h1>
        </div>
        <button id="theme-toggle" title="Toggle dark/light mode">&#9790; Dark</button>
      </div>
      <p class="text-sm mb-1" style="color:#A8BEC3;">Daily AI News Digest</p>
      <div class="flex items-center gap-4 mt-1">
        <p class="text-xs" style="color:#A8BEC3;">Updated: ${today}</p>
        <span class="text-xs px-2 py-0.5 rounded-full" style="background:#243E47;color:#C9A8A4;">${articles.length} articles &middot; ${successfulSources} sources</span>
      </div>
    </div>
    <div style="height:2px;background:#C9A8A4;"></div>
  </header>

  <!-- Main -->
  <main class="max-w-6xl mx-auto px-6 py-8">

    <!-- Search + Filters -->
    <div class="flex flex-col sm:flex-row gap-3 mb-8">
      <input id="search" type="search" placeholder="Search articles…" class="flex-1 px-4 py-2 rounded-md text-sm outline-none" style="border:1px solid var(--filter-border);background:var(--filter-bg);color:var(--card-title);min-width:0;" />
      <div class="flex flex-wrap gap-2">
        ${filterBtns}
      </div>
    </div>

    <!-- Cards -->
    <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      ${cardsHtml}
    </div>
  </main>

  <!-- Back to top -->
  <button id="back-to-top" title="Back to top" aria-label="Back to top">&#8679;</button>

  <!-- Footer -->
  <footer style="background:#182E35;margin-top:4rem;">
    <div class="max-w-6xl mx-auto px-6 py-8">
      <div class="flex items-center gap-2 mb-3">
        ${logoSvg24}
        <a href="${escapeHtml(brand.footerLink)}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium" style="color:#A8BEC3;">${escapeHtml(brand.footerLinkLabel)}</a>
      </div>
      <p class="text-xs mb-2" style="color:#A8BEC3;">Sources updated daily at 07:00 UTC</p>
      <p class="text-xs" style="color:#526870;">${sourceList}</p>
    </div>
  </footer>

  <script>
    // ── Filter + Search ───────────────────────────────────────────────────────
    const btns = document.querySelectorAll('.filter-btn');
    const cards = document.querySelectorAll('#grid [data-category]');
    const searchInput = document.getElementById('search');
    let activeFilter = 'All';

    function applyFilters() {
      const q = searchInput.value.toLowerCase().trim();
      cards.forEach(card => {
        const matchCat = activeFilter === 'All' || card.dataset.category === activeFilter;
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
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.innerHTML = '&#8679; Share'; }, 1500);
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
        toggle.innerHTML = '&#9728; Light';
      } else {
        html.removeAttribute('data-theme');
        toggle.innerHTML = '&#9790; Dark';
      }
    }

    // Restore from localStorage or system preference
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
import { mkdir } from 'fs/promises';

const HISTORY_PATH = path.join(ROOT, 'data/history.json');
const DATA_DIR = path.join(ROOT, 'data');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const cutoff30 = Date.now() - THIRTY_DAYS_MS;

await mkdir(DATA_DIR, { recursive: true });

let history = [];
try {
  history = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
} catch {
  // first run or missing file — start fresh
}

// Strip to minimal fields to keep file small
const todaySlim = articles.map(a => ({
  title: a.title,
  link: a.link,
  source: a.source,
  category: a.category,
  pubDate: a.pubDate.toISOString(),
}));

// Combine existing history + today's articles, deduplicate by link
const allSeen = new Set();
const allEntries = [...history, ...todaySlim].filter(a => {
  if (allSeen.has(a.link)) return false;
  allSeen.add(a.link);
  return true;
});

// Split: recent (<=30d) stays in history.json, older goes to monthly archives
const recent = [];
const toArchive = new Map(); // 'YYYY-MM' -> entries[]

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

// Write monthly archive files (merge with existing if present)
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
  console.log(`Archive ${month}: ${merged.length} entries (${archivePath.split('/').pop()})`);
}

// Sort recent newest first and save
recent.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
await writeFile(HISTORY_PATH, JSON.stringify(recent, null, 2), 'utf8');
console.log(`History: ${recent.length} entries (30-day rolling) | archived ${archivedTotal} to monthly files`);
