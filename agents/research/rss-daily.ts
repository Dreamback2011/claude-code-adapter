import RssParser from 'rss-parser';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, 'rss-config.json');
const REPORTS_DIR = join(__dirname, 'reports');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FeedDef {
  name: string;
  url: string;
}

interface CategoryDef {
  label: string;
  feeds: FeedDef[];
}

interface Config {
  categories: Record<string, CategoryDef>;
  settings: {
    concurrency: number;
    timeoutMs: number;
    maxArticlesPerFeed: number;
  };
}

interface Article {
  title: string;
  link: string;
  pubDate: string; // ISO string
  sourceName: string;
  category: string;
  language: string;
}

interface Story {
  headline: string;
  sources: string[];
  sourceCount: number;
  pubDate: string; // ISO string (earliest)
  category: string;
  articles: { title: string; link: string; sourceName: string; pubDate: string }[];
}

interface RawReport {
  date: string;
  stats: {
    feedsTotal: number;
    feedsOk: number;
    failures: number;
    rawArticles: number;
    stories: number;
  };
  stories: Story[];
}

// ---------------------------------------------------------------------------
// Stop words for title normalization
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for', 'is', 'are',
  'was', 'were', 'has', 'have', 'had', 'says', 'said', 'as', 'by',
  'with', 'from', 'and', 'or', 'but', 'not', 'be', 'been', 'being',
  'its', 'it', 'this', 'that', 'they', 'their', 'he', 'she', 'his',
  'her', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
  'after', 'before', 'over', 'about', 'up', 'out', 'into', 'more',
  'new', 'also', 'than', 'just', 'now', 'what', 'how', 'when', 'who',
  'which', 'where', 'why', 'all', 'no', 'do', 'does', 'did',
]);

// ---------------------------------------------------------------------------
// Common European language words for detection
// ---------------------------------------------------------------------------
const FRENCH_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'en', 'est',
  'dans', 'pour', 'sur', 'avec', 'au', 'aux', 'qui', 'que', 'par',
  'son', 'ont', 'pas', 'ce', 'cette', 'ses', 'nous', 'vous', 'mais',
  'sont', 'comme', 'entre', 'après', 'avant', 'leur', 'leurs',
]);

const SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'es',
  'por', 'con', 'para', 'como', 'que', 'más', 'pero', 'sus', 'al',
  'fue', 'han', 'son', 'hay', 'ser', 'está', 'desde', 'entre', 'sin',
  'sobre', 'todo', 'también', 'después', 'cuando', 'hasta', 'donde',
]);

const GERMAN_WORDS = new Set([
  'der', 'die', 'das', 'und', 'ist', 'von', 'den', 'ein', 'eine', 'mit',
  'auf', 'für', 'nicht', 'sich', 'dem', 'des', 'auch', 'als', 'nach',
  'wie', 'werden', 'bei', 'hat', 'sind', 'aus', 'oder', 'vom', 'noch',
  'wird', 'über', 'zum', 'zur', 'haben', 'nur', 'aber', 'kann',
]);

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function getTargetDate(): string {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--date=')) {
      const val = arg.slice('--date='.length);
      const parsed = new Date(val + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) {
        console.error(`Invalid date: ${val}. Use YYYY-MM-DD format.`);
        process.exit(1);
      }
      return val;
    }
  }
  // Default: today in UTC
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Check if a date string matches the target day (UTC)
// ---------------------------------------------------------------------------
function isSameDay(date: Date, targetDateStr: string): boolean {
  return date.toISOString().slice(0, 10) === targetDateStr;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------
function detectLanguage(title: string): string {
  // Check for non-Latin script characters
  // Malayalam (U+0D00-U+0D7F), Devanagari (U+0900-U+097F), Arabic (U+0600-U+06FF)
  const nonLatinPattern = /[\u0D00-\u0D7F\u0900-\u097F\u0600-\u06FF\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0E00-\u0E7F]/;
  const nonLatinChars = (title.match(nonLatinPattern) || []).length;
  // Count proportion of non-Latin chars vs total non-space chars
  const textChars = title.replace(/[\s\d\p{P}]/gu, '');
  if (textChars.length > 0) {
    let foreignCharCount = 0;
    for (const ch of textChars) {
      if (nonLatinPattern.test(ch)) foreignCharCount++;
    }
    if (foreignCharCount / textChars.length > 0.3) return 'foreign';
  }

  // Check for CJK characters
  const cjkPattern = /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/;
  if (textChars.length > 0) {
    let cjkCount = 0;
    for (const ch of textChars) {
      if (cjkPattern.test(ch)) cjkCount++;
    }
    if (cjkCount / textChars.length > 0.3) return 'foreign';
  }

  // Check European languages by word matching
  const words = title.toLowerCase().replace(/[^\w\sàâçéèêëïîôùûüÿñáíóúüäöß]/g, '').split(/\s+/);
  const wordCount = words.length;
  if (wordCount < 2) return 'english';

  let frenchHits = 0, spanishHits = 0, germanHits = 0;
  for (const w of words) {
    if (FRENCH_WORDS.has(w)) frenchHits++;
    if (SPANISH_WORDS.has(w)) spanishHits++;
    if (GERMAN_WORDS.has(w)) germanHits++;
  }

  const threshold = Math.max(2, wordCount * 0.25);
  if (frenchHits >= threshold || spanishHits >= threshold || germanHits >= threshold) {
    return 'european';
  }

  return 'english';
}

// ---------------------------------------------------------------------------
// Title normalization and keyword extraction
// ---------------------------------------------------------------------------
function extractKeywords(title: string): Set<string> {
  const normalized = title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ').filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w),
  );

  return new Set(words);
}

// ---------------------------------------------------------------------------
// Named entity extraction (capitalized multi-word sequences)
// ---------------------------------------------------------------------------
function extractEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const matches = title.match(/(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g);
  if (matches) {
    for (const m of matches) {
      entities.add(m.toLowerCase());
    }
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Group articles into stories via dedup
// ---------------------------------------------------------------------------
function groupIntoStories(articles: Article[]): Story[] {
  if (articles.length === 0) return [];

  // Pre-compute keyword sets and entity sets
  const keywordSets = articles.map((a) => extractKeywords(a.title));
  const entitySets = articles.map((a) => extractEntities(a.title));

  // Union-Find for grouping
  const parent = articles.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function unite(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Compare pairwise within same category
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      // Only group articles from the same category
      if (articles[i].category !== articles[j].category) continue;
      // Skip if either has very few keywords (avoid false positives)
      if (keywordSets[i].size < 2 || keywordSets[j].size < 2) continue;

      const sim = jaccardSimilarity(keywordSets[i], keywordSets[j]);

      // Strong keyword overlap
      if (sim > 0.25) {
        unite(i, j);
        continue;
      }

      // Moderate overlap + shared named entity
      if (sim > 0.1 && entitySets[i].size > 0 && entitySets[j].size > 0) {
        for (const e of entitySets[i]) {
          if (entitySets[j].has(e)) {
            unite(i, j);
            break;
          }
        }
      }
    }
  }

  // Collect groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < articles.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  // Build stories
  const stories: Story[] = [];
  for (const indices of groups.values()) {
    const groupArticles = indices.map((i) => articles[i]);

    // Pick headline: longest English title
    let headline = groupArticles[0].title;
    let maxLen = 0;
    for (const a of groupArticles) {
      if (a.language === 'english' && a.title.length > maxLen) {
        maxLen = a.title.length;
        headline = a.title;
      }
    }
    // If no English title found, use longest overall
    if (maxLen === 0) {
      for (const a of groupArticles) {
        if (a.title.length > maxLen) {
          maxLen = a.title.length;
          headline = a.title;
        }
      }
    }

    // Unique sources
    const sourceSet = new Set<string>();
    for (const a of groupArticles) sourceSet.add(a.sourceName);
    const sources = Array.from(sourceSet);

    // Earliest pubDate
    let earliest = groupArticles[0].pubDate;
    for (const a of groupArticles) {
      if (a.pubDate < earliest) earliest = a.pubDate;
    }

    // Category from first article
    const category = groupArticles[0].category;

    stories.push({
      headline,
      sources,
      sourceCount: sources.length,
      pubDate: earliest,
      category,
      articles: groupArticles.map((a) => ({
        title: a.title,
        link: a.link,
        sourceName: a.sourceName,
        pubDate: a.pubDate,
      })),
    });
  }

  // Sort by sourceCount desc, then by pubDate desc
  stories.sort((a, b) => {
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return b.pubDate.localeCompare(a.pubDate);
  });

  return stories;
}

// ---------------------------------------------------------------------------
// Concurrency-limited task runner
// ---------------------------------------------------------------------------
async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Fetch one feed, return articles or error
// ---------------------------------------------------------------------------
type FeedResult =
  | { ok: true; feedName: string; category: string; articles: Article[] }
  | { ok: false; feedName: string; error: string };

async function fetchFeed(
  feed: FeedDef,
  categoryKey: string,
  targetDate: string,
  settings: Config['settings'],
): Promise<FeedResult> {
  const parser = new RssParser({
    timeout: settings.timeoutMs,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'RSS-Daily/1.0',
      Accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
  });

  try {
    const result = await parser.parseURL(feed.url);
    const items = (result.items || []).slice(0, settings.maxArticlesPerFeed);

    const articles: Article[] = [];
    for (const item of items) {
      const raw = item.pubDate || item.isoDate;
      if (!raw) continue;
      const d = new Date(raw);
      if (isNaN(d.getTime())) continue;
      if (!isSameDay(d, targetDate)) continue;

      const title = item.title || 'Untitled';
      articles.push({
        title,
        link: item.link || '',
        pubDate: d.toISOString(),
        sourceName: feed.name,
        category: categoryKey,
        language: detectLanguage(title),
      });
    }

    return { ok: true, feedName: feed.name, category: categoryKey, articles };
  } catch (err: any) {
    return { ok: false, feedName: feed.name, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Format time as HH:MM UTC
// ---------------------------------------------------------------------------
function fmtTime(isoStr: string): string {
  return isoStr.slice(11, 16);
}

// ---------------------------------------------------------------------------
// Category emoji map
// ---------------------------------------------------------------------------
const CATEGORY_EMOJI: Record<string, string> = {
  'world-news': '🌍',
  'tech': '💻',
  'business': '💼',
  'science': '🔬',
  'sports': '⚽',
  'entertainment': '🎬',
  'health': '🏥',
  'crypto': '🪙',
  'finance': '💰',
};

// ---------------------------------------------------------------------------
// Build raw JSON report
// ---------------------------------------------------------------------------
function buildRawReport(
  targetDate: string,
  stories: Story[],
  stats: {
    feedsTotal: number;
    feedsOk: number;
    failures: number;
    rawArticles: number;
  },
): RawReport {
  return {
    date: targetDate,
    stats: {
      feedsTotal: stats.feedsTotal,
      feedsOk: stats.feedsOk,
      failures: stats.failures,
      rawArticles: stats.rawArticles,
      stories: stories.length,
    },
    stories,
  };
}

// ---------------------------------------------------------------------------
// Build markdown report
// ---------------------------------------------------------------------------
function buildMarkdownReport(
  targetDate: string,
  stories: Story[],
  categoryLabels: Record<string, string>,
  stats: {
    feedsTotal: number;
    feedsOk: number;
    failures: number;
    rawArticles: number;
  },
): string {
  const lines: string[] = [];

  lines.push(`# 📰 RSS 日报 — ${targetDate}`);
  lines.push('');
  lines.push(
    `> ${stats.feedsOk}/${stats.feedsTotal} 源成功 | ${stats.rawArticles} 篇原始文章 → 去重后 ${stories.length} 条故事`,
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group stories by category
  const byCategory = new Map<string, Story[]>();
  for (const story of stories) {
    if (!byCategory.has(story.category)) byCategory.set(story.category, []);
    byCategory.get(story.category)!.push(story);
  }

  for (const [catKey, catStories] of byCategory) {
    const label = categoryLabels[catKey] || catKey;
    const emoji = CATEGORY_EMOJI[catKey] || '📂';
    const totalArticlesInCat = catStories.reduce((sum, s) => sum + s.articles.length, 0);

    lines.push(`## ${emoji} ${label} (${catStories.length} stories from ${totalArticlesInCat} articles)`);
    lines.push('');

    // Sort by sourceCount desc
    catStories.sort((a, b) => {
      if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
      return b.pubDate.localeCompare(a.pubDate);
    });

    // Split into top stories (5+ sources) and other stories
    const topStories = catStories.filter((s) => s.sourceCount >= 5);
    const otherStories = catStories.filter((s) => s.sourceCount < 5);

    let storyNum = 1;

    if (topStories.length > 0) {
      lines.push('### 🔥 Top Stories (5+ sources)');
      lines.push('');

      for (const story of topStories) {
        const sourceList = story.sources.join(' · ');
        const firstLink = story.articles[0]?.link || '#';
        lines.push(`**${storyNum}. ${story.headline}** (${story.sourceCount} sources)`);
        lines.push(`  ${sourceList}`);
        lines.push(`  [Read more](${firstLink})`);
        lines.push('');
        storyNum++;
      }
    }

    if (otherStories.length > 0) {
      lines.push('### 📰 Other Stories');
      lines.push('');

      for (const story of otherStories) {
        const sourceList = story.sources.join(' · ');
        const firstLink = story.articles[0]?.link || '#';
        lines.push(`**${storyNum}. ${story.headline}** (${story.sourceCount} source${story.sourceCount > 1 ? 's' : ''})`);
        lines.push(`  ${sourceList}`);
        lines.push(`  [Read more](${firstLink})`);
        lines.push('');
        storyNum++;
      }
    }

    if (catStories.length === 0) {
      lines.push('_No stories for this date._');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const targetDate = getTargetDate();

  console.log(`RSS Daily Report — ${targetDate}`);
  console.log('');

  // Load config
  const config: Config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const { categories, settings } = config;

  // Build feed tasks
  const tasks: (() => Promise<FeedResult>)[] = [];
  let totalFeeds = 0;

  for (const [catKey, catDef] of Object.entries(categories)) {
    for (const feed of catDef.feeds) {
      totalFeeds++;
      tasks.push(() => fetchFeed(feed, catKey, targetDate, settings));
    }
  }

  console.log(`Fetching ${totalFeeds} feeds (concurrency: ${settings.concurrency}, timeout: ${settings.timeoutMs}ms)`);

  // Fetch all
  const results = await runConcurrent(tasks, settings.concurrency);

  // Aggregate
  let feedsOk = 0;
  let failures = 0;
  const allArticles: Article[] = [];

  for (const r of results) {
    if (r.ok === false) {
      failures++;
      console.error(`  [FAIL] ${r.feedName}: ${r.error}`);
      continue;
    }
    feedsOk++;
    allArticles.push(...r.articles);
  }

  const rawArticles = allArticles.length;

  console.log('');
  console.log(`Done — ${feedsOk}/${totalFeeds} OK, ${rawArticles} articles, ${failures} failures`);

  // Dedup: group into stories
  console.log('Deduplicating articles into stories...');
  const stories = groupIntoStories(allArticles);

  console.log(`Dedup complete — ${rawArticles} articles → ${stories.length} stories`);
  console.log('');

  // Build category labels map
  const categoryLabels: Record<string, string> = {};
  for (const [catKey, catDef] of Object.entries(categories)) {
    categoryLabels[catKey] = catDef.label;
  }

  // Stats
  const stats = {
    feedsTotal: totalFeeds,
    feedsOk,
    failures,
    rawArticles,
  };

  // Build raw JSON report
  const rawReport = buildRawReport(targetDate, stories, stats);

  // Build markdown report
  const mdReport = buildMarkdownReport(targetDate, stories, categoryLabels, stats);

  // Ensure reports dir exists
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }

  // Write raw JSON
  const rawPath = join(REPORTS_DIR, `raw-${targetDate}.json`);
  writeFileSync(rawPath, JSON.stringify(rawReport, null, 2), 'utf-8');

  // Write markdown
  const mdPath = join(REPORTS_DIR, `daily-${targetDate}.md`);
  writeFileSync(mdPath, mdReport, 'utf-8');

  // Print to stdout
  console.log(mdReport);
  console.log('');
  console.log(`Raw JSON saved to: ${rawPath}`);
  console.log(`Markdown saved to: ${mdPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
