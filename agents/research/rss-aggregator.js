import Parser from 'rss-parser';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Resolve paths relative to this script
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, 'rss-config.json');
const DIGESTS_DIR = join(__dirname, 'digests');

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let targetDate = new Date();
  for (const arg of args) {
    if (arg.startsWith('--date=')) {
      const val = arg.slice('--date='.length);
      const parsed = new Date(val + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) {
        console.error(`Invalid date: ${val}. Use YYYY-MM-DD format.`);
        process.exit(1);
      }
      targetDate = parsed;
    }
  }
  return { targetDate };
}

// ---------------------------------------------------------------------------
// Date helpers — compare calendar day in UTC
// ---------------------------------------------------------------------------
function utcDateString(date) {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isSameUTCDay(d1, d2) {
  return utcDateString(d1) === utcDateString(d2);
}

function formatTime(date) {
  return date.toISOString().slice(11, 16); // "HH:MM"
}

// ---------------------------------------------------------------------------
// Concurrency-limited runner
// ---------------------------------------------------------------------------
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Fetch a single feed
// ---------------------------------------------------------------------------
async function fetchFeed(feed, settings) {
  const parser = new Parser({
    timeout: settings.timeoutMs,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'RSS-Aggregator/1.0',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
  });

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), settings.timeoutMs);

  try {
    const result = await parser.parseURL(feed.url);
    clearTimeout(timer);
    const items = (result.items || []).slice(0, settings.maxArticlesPerFeed);
    return { ok: true, feed, items };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, feed, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Filter items by target date
// ---------------------------------------------------------------------------
function filterByDate(items, targetDate) {
  const matched = [];
  const noDate = [];

  for (const item of items) {
    const raw = item.pubDate || item.isoDate;
    if (!raw) {
      noDate.push(item);
      continue;
    }
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
      noDate.push(item);
      continue;
    }
    if (isSameUTCDay(d, targetDate)) {
      matched.push({ ...item, _parsedDate: d });
    }
  }

  return { matched, noDate };
}

// ---------------------------------------------------------------------------
// Escape markdown special chars in text
// ---------------------------------------------------------------------------
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Strip HTML tags for snippets
// ---------------------------------------------------------------------------
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Build the markdown digest
// ---------------------------------------------------------------------------
function buildDigest(dateStr, categoryResults, failedFeeds, totalFeeds) {
  const lines = [];
  lines.push(`# Daily Digest — ${dateStr}`);
  lines.push('');

  // Stats
  const successCount = totalFeeds - failedFeeds.length;
  let totalArticles = 0;
  for (const cat of Object.values(categoryResults)) {
    totalArticles += cat.articles.length;
  }

  lines.push('## Stats');
  lines.push(`- Feeds fetched: ${successCount}/${totalFeeds}`);
  lines.push(`- Articles found: ${totalArticles}`);
  lines.push(`- Failed feeds: ${failedFeeds.length}`);
  lines.push('');

  // Category sections
  const categoryEmojis = {
    'world-news': '\u{1F30D}',
    tech: '\u{1F4BB}',
  };

  for (const [catKey, catData] of Object.entries(categoryResults)) {
    const emoji = categoryEmojis[catKey] || '\u{1F4F0}';
    lines.push(`## ${emoji} ${catData.label} (${catData.articles.length} articles)`);
    lines.push('');

    if (catData.articles.length === 0) {
      lines.push('_No articles found for this date._');
      lines.push('');
      continue;
    }

    // Sort by date descending (most recent first)
    catData.articles.sort((a, b) => {
      if (a._parsedDate && b._parsedDate) return b._parsedDate - a._parsedDate;
      if (a._parsedDate) return -1;
      return 1;
    });

    for (const article of catData.articles) {
      const title = escapeMarkdown(article.title || 'Untitled');
      const link = article.link || '#';
      const source = escapeMarkdown(article._sourceName || 'Unknown');

      let pubInfo = 'date unknown';
      if (article._parsedDate) {
        pubInfo = `${utcDateString(article._parsedDate)} ${formatTime(article._parsedDate)}`;
      }

      lines.push(`### [${title}](${link})`);
      lines.push(`**Source**: ${source} | **Published**: ${pubInfo}`);

      // Snippet
      const snippet = stripHtml(
        article.contentSnippet || article.content || article.summary || article.description || ''
      );
      if (snippet) {
        const trimmed = snippet.length > 300 ? snippet.slice(0, 300) + '...' : snippet;
        lines.push(`> ${trimmed}`);
      }
      lines.push('');
    }
  }

  // Failed feeds
  if (failedFeeds.length > 0) {
    lines.push('## \u274C Failed Feeds');
    lines.push('');
    for (const f of failedFeeds) {
      lines.push(`- **${escapeMarkdown(f.name)}**: ${escapeMarkdown(f.error)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { targetDate } = parseArgs();
  const dateStr = utcDateString(targetDate);

  console.log(`RSS Aggregator — fetching articles for ${dateStr}`);
  console.log('');

  // Load config
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const { categories, settings } = config;

  // Flatten all feeds with category info
  const allFeeds = [];
  for (const [catKey, catDef] of Object.entries(categories)) {
    for (const feed of catDef.feeds) {
      allFeeds.push({ ...feed, _catKey: catKey, _catLabel: catDef.label });
    }
  }

  const totalFeeds = allFeeds.length;
  console.log(`Total feeds to fetch: ${totalFeeds}`);
  console.log(`Concurrency: ${settings.concurrency}`);
  console.log(`Timeout per feed: ${settings.timeoutMs}ms`);
  console.log('');

  // Build tasks
  let completed = 0;
  const tasks = allFeeds.map((feed) => async () => {
    const result = await fetchFeed(feed, settings);
    completed++;
    if (completed % 20 === 0 || completed === totalFeeds) {
      process.stdout.write(`\rProgress: ${completed}/${totalFeeds} feeds fetched`);
    }
    return result;
  });

  // Run with concurrency
  const results = await runWithConcurrency(tasks, settings.concurrency);
  console.log('\n');

  // Process results
  const failedFeeds = [];
  const categoryResults = {};

  // Initialize categories
  for (const [catKey, catDef] of Object.entries(categories)) {
    categoryResults[catKey] = { label: catDef.label, articles: [] };
  }

  for (const result of results) {
    if (!result.ok) {
      failedFeeds.push({ name: result.feed.name, url: result.feed.url, error: result.error });
      continue;
    }

    const { matched, noDate } = filterByDate(result.items, targetDate);
    const catKey = result.feed._catKey;

    for (const item of matched) {
      categoryResults[catKey].articles.push({
        ...item,
        _sourceName: result.feed.name,
      });
    }

    // Include no-date items only if feed has zero dated items matching
    if (matched.length === 0 && noDate.length > 0) {
      for (const item of noDate.slice(0, 3)) {
        categoryResults[catKey].articles.push({
          ...item,
          _sourceName: result.feed.name,
          _parsedDate: null,
        });
      }
    }
  }

  // Report
  let totalArticles = 0;
  for (const cat of Object.values(categoryResults)) {
    totalArticles += cat.articles.length;
  }

  console.log(`Feeds OK: ${totalFeeds - failedFeeds.length}/${totalFeeds}`);
  console.log(`Articles found for ${dateStr}: ${totalArticles}`);
  console.log(`Failed feeds: ${failedFeeds.length}`);
  console.log('');

  // Build & write markdown
  const md = buildDigest(dateStr, categoryResults, failedFeeds, totalFeeds);

  if (!existsSync(DIGESTS_DIR)) {
    mkdirSync(DIGESTS_DIR, { recursive: true });
  }

  const outPath = join(DIGESTS_DIR, `${dateStr}.md`);
  writeFileSync(outPath, md, 'utf-8');
  console.log(`Digest saved to: ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
