/**
 * rss-summarize.ts — V2 Bloomberg-style AI summarization for RSS daily reports.
 *
 * Reads the raw JSON produced by rss-daily.ts, groups stories into 5 themes,
 * fetches live crypto prices from BGW API, sends everything to the local
 * adapter API for Chinese summarization, and saves the result as a markdown file.
 *
 * Usage:
 *   npx tsx agents/research/rss-summarize.ts [--date=YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getTokenPrices, getTrendingTokens, type TokenPrice } from '../../agents/proceed-subagent/info/bgw-client.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPORTS_DIR = join(__dirname, 'reports');

// ---------------------------------------------------------------------------
// Types (mirrors rss-daily.ts RawReport)
// ---------------------------------------------------------------------------
interface Story {
  headline: string;
  sources: string[];
  sourceCount: number;
  pubDate: string;
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
// Theme definitions (V2: 5 themes)
// ---------------------------------------------------------------------------
type Theme = 'geopolitics' | 'markets' | 'crypto' | 'tech' | 'society';

const THEME_LABELS: Record<Theme, string> = {
  geopolitics: '■ 地缘政治',
  markets: '■ 市场 & 宏观',
  crypto: '■ Crypto',
  tech: '■ 科技',
  society: '■ 其他要闻',
};

const THEME_KEYWORDS: Record<Theme, Set<string>> = {
  geopolitics: new Set([
    'war', 'military', 'attack', 'strike', 'killed', 'bomb', 'troops',
    'iran', 'israel', 'ukraine', 'russia', 'china', 'nato', 'conflict',
    'missile', 'nuclear', 'terrorist', 'embassy', 'border', 'invasion',
    'ceasefire', 'sanction', 'diplomat', 'sanctions', 'diplomacy',
    'artillery', 'airstrike', 'airstrikes', 'hostage', 'hostages',
    'hamas', 'hezbollah', 'gaza', 'kremlin', 'pentagon', 'taiwan',
  ]),
  markets: new Set([
    'market', 'stock', 'trade', 'tariff', 'fed', 'economy', 'gdp',
    'inflation', 'rate', 'bank', 'oil', 'gold', 'dollar', 'euro',
    'recession', 'jobs', 'employment', 'debt', 'treasury', 'nasdaq',
    'dow', 'stocks', 'bonds', 'yield', 'ipo', 'earnings', 'revenue',
    'profit', 'economic', 'tariffs', 'currency', 'markets', 'financial',
    'banking', 'rates', 'prices', 'wall street', 'sp500', 'interest',
  ]),
  crypto: new Set([
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency',
    'blockchain', 'defi', 'nft', 'token', 'altcoin', 'stablecoin',
    'usdt', 'usdc', 'solana', 'sol', 'binance', 'coinbase', 'exchange',
    'mining', 'halving', 'wallet', 'web3', 'dao', 'dex', 'cex',
    'airdrop', 'memecoin', 'layer2', 'rollup', 'staking',
  ]),
  tech: new Set([
    'ai', 'artificial intelligence', 'tech', 'software', 'startup',
    'google', 'apple', 'microsoft', 'meta', 'chip', 'semiconductor',
    'quantum', 'robot', 'autonomous', 'cyber', 'data', 'cloud',
    'model', 'llm', 'openai', 'claude', 'nvidia', 'tesla', 'spacex',
    'algorithm', 'chatbot', 'technology', 'computing', 'digital',
    'cybersecurity', 'hacker', 'malware',
  ]),
  // society is the default — no keywords needed
  society: new Set(),
};

// ---------------------------------------------------------------------------
// BGW Price Integration
// ---------------------------------------------------------------------------
const PRICE_TOKENS = [
  { symbol: 'BTC', chainId: '1', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' },
  { symbol: 'ETH', chainId: '1', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
  { symbol: 'SOL', chainId: '1', address: '0xd31a59c85ae9d8edefec411d448f90841571b89c' },
  { symbol: 'BNB', chainId: '56', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
  { symbol: 'ARB', chainId: '42161', address: '0x912ce59144191c1204e64559fe8253a0e49e6548' },
  { symbol: 'OP', chainId: '10', address: '0x4200000000000000000000000000000000000042' },
];

/**
 * Fetch live crypto prices from BGW API.
 * Returns a formatted ticker string, or empty string on failure.
 */
async function fetchCryptoPrices(): Promise<string> {
  try {
    const [prices, trending] = await Promise.allSettled([
      getTokenPrices(PRICE_TOKENS.map((t) => ({ chainId: t.chainId, address: t.address }))),
      getTrendingTokens('1'),
    ]);

    const priceList: TokenPrice[] =
      prices.status === 'fulfilled' ? prices.value : [];

    if (priceList.length === 0) return '';

    // Build a map from address to our symbol labels
    const addrToSymbol = new Map<string, string>();
    for (const t of PRICE_TOKENS) {
      addrToSymbol.set(t.address.toLowerCase(), t.symbol);
    }

    const parts: string[] = [];
    for (const p of priceList) {
      const symbol = addrToSymbol.get(p.address?.toLowerCase() || '') || p.symbol || '??';
      const priceNum = parseFloat(p.priceUSD || p.price || '0');
      const change = parseFloat(p.change24h || '0');
      const changeStr = change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`;
      const priceStr = priceNum >= 1000
        ? `$${priceNum.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : priceNum >= 1
          ? `$${priceNum.toFixed(2)}`
          : `$${priceNum.toFixed(4)}`;
      parts.push(`${symbol} ${priceStr} (${changeStr})`);
    }

    let result = parts.join(' | ');

    // Append trending info if available
    if (trending.status === 'fulfilled' && trending.value.length > 0) {
      const top3 = trending.value.slice(0, 3);
      const trendParts = top3.map((t) => {
        const sym = t.symbol || '??';
        const ch = parseFloat(t.change24h || '0');
        return `${sym} ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%`;
      });
      result += `\nTrending: ${trendParts.join(', ')}`;
    }

    return result;
  } catch (err) {
    console.warn('[rss-summarize] BGW price fetch failed, skipping prices:', (err as Error).message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Major outlets (keep even if single-source)
// ---------------------------------------------------------------------------
const MAJOR_OUTLETS = new Set([
  'bbc', 'cnn', 'nyt', 'new york times', 'washington post',
  'ft', 'financial times', 'wsj', 'wall street journal',
  'reuters', 'ap', 'associated press', 'al jazeera',
  'the guardian', 'npr', 'cnbc', 'bloomberg',
  'south china morning post', 'dw news', 'france 24', 'the economist',
]);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function getTargetDate(): string {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--date=')) {
      const val = arg.slice('--date='.length);
      const parsed = new Date(val + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) {
        console.error(`[rss-summarize] Invalid date: ${val}. Use YYYY-MM-DD format.`);
        process.exit(1);
      }
      return val;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Check if a source is a major outlet
// ---------------------------------------------------------------------------
function isMajorOutlet(sources: string[]): boolean {
  return sources.some((s) => MAJOR_OUTLETS.has(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Detect theme from headline (V2: crypto > geopolitics > markets > tech > society)
// ---------------------------------------------------------------------------
function detectTheme(headline: string): Theme {
  const words = headline.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);

  // Check each theme's keywords — order matters
  const themes: Theme[] = ['crypto', 'geopolitics', 'markets', 'tech'];
  for (const theme of themes) {
    const keywords = THEME_KEYWORDS[theme];
    for (const word of words) {
      if (keywords.has(word)) return theme;
    }
    // Also check 2-word combinations for multi-word keywords
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (keywords.has(bigram)) return theme;
    }
  }

  return 'society';
}

// ---------------------------------------------------------------------------
// Pre-process: filter + group stories into themes (V2: 5 themes)
// ---------------------------------------------------------------------------
function preprocessStories(stories: Story[]): Record<Theme, Story[]> {
  const grouped: Record<Theme, Story[]> = {
    geopolitics: [],
    markets: [],
    crypto: [],
    tech: [],
    society: [],
  };

  for (const story of stories) {
    // Filter: skip single-source unless from major outlet
    if (story.sourceCount === 1 && !isMajorOutlet(story.sources)) {
      continue;
    }

    const theme = detectTheme(story.headline);
    grouped[theme].push(story);
  }

  // Sort each theme by sourceCount desc
  for (const theme of Object.keys(grouped) as Theme[]) {
    grouped[theme].sort((a, b) => b.sourceCount - a.sourceCount);
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Day-of-week helper (Chinese)
// ---------------------------------------------------------------------------
function getDayOfWeek(dateStr: string): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return days[d.getUTCDay()];
}

// ---------------------------------------------------------------------------
// Build the prompt payload for the adapter (V2 Bloomberg style)
// ---------------------------------------------------------------------------
function buildPromptPayload(
  date: string,
  stats: RawReport['stats'],
  grouped: Record<Theme, Story[]>,
  priceTickerLine: string,
): { system: string; userMessage: string } {
  const system = `你是 Bloomberg Terminal 风格的专业新闻编辑。任务：将去重新闻数据生成一份精简、高信号密度的中文日报。

风格要求：
- 信息密度最大化，30秒可扫完
- Top 3 头条给2-3行深度分析，其余每条一行
- 所有非中文标题翻译成中文
- 使用信号强度标识：🔥(Top Story/多源) 🔴(重要/3+源) 🟡(值得关注/单源大媒体)
- 总篇幅控制在2-3页以内`;

  // Build the stories data for each theme
  const themeSections: string[] = [];
  const themeOrder: Theme[] = ['geopolitics', 'markets', 'crypto', 'tech', 'society'];

  let includedCount = 0;
  for (const theme of themeOrder) {
    const stories = grouped[theme];
    if (stories.length === 0) continue;

    includedCount += stories.length;
    const label = THEME_LABELS[theme];
    const lines: string[] = [`== ${label} (${stories.length} 条) ==`];

    for (const story of stories) {
      const sourceList = story.sources.slice(0, 8).join(' · ');
      lines.push(`- [${story.sourceCount}源] ${story.headline}`);
      lines.push(`  来源: ${sourceList}`);
    }

    themeSections.push(lines.join('\n'));
  }

  const dayOfWeek = getDayOfWeek(date);

  // Build the crypto price section for the template
  const cryptoPriceBlock = priceTickerLine
    ? `\n💹 实时价格: ${priceTickerLine}\n(来自 BGW API 实时数据)\n`
    : '';

  const userMessage = `[任务] 根据以下 ${date} 的去重新闻数据，生成 Bloomberg 风格中文日报。

📊 数据概览: ${stats.feedsOk}源成功 / ${stats.rawArticles}篇原始 → ${stats.stories}条去重 → 筛选后${includedCount}条

${themeSections.join('\n\n')}

${priceTickerLine ? `[BGW 实时价格数据]\n${priceTickerLine}` : ''}

请严格按以下格式输出：

══════════════════════════════════════════════
  DAILY BRIEF — ${date} (${dayOfWeek})
  ${stats.feedsOk}源 · ${stats.rawArticles}篇 · 精选${includedCount}条
══════════════════════════════════════════════

■ TOP 3 头条
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① 中文标题 [N源]
   2-3行深度分析：背景、影响、市场意义。
   — BBC · CNN · Reuters

② ...
③ ...

■ 地缘政治
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 中文标题 (N源)
🟡 中文标题 (来源)

■ 市场 & 宏观
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈/📉 简要趋势判断

■ Crypto
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${cryptoPriceBlock}
▸ 新闻条目...

■ 科技
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ 条目...

■ 态势 & 明日关注
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔺 2-3句全局态势总结
👁 明日关注: 3个关键看点
══════════════════════════════════════════════

规则：
1. 所有英文标题必须翻译成中文
2. Top 3 头条从全部主题中选取最重大的3条，给2-3行深度分析
3. 其余每条新闻一行，标注信号强度(🔥/🔴/🟡)
4. 每个主题最多8条，优先多源报道
5. 如果某主题无数据则跳过该主题
6. 如果有 BGW 实时价格数据，在 Crypto 板块顶部展示价格行
7. 保持精简，整体30秒可扫完
8. 最后加"态势 & 明日关注"板块：2-3句全局态势 + 3个明日关键看点`;

  return { system, userMessage };
}

// ---------------------------------------------------------------------------
// Call the local adapter API (same pattern as x-timeline in cron-scheduler.ts)
// ---------------------------------------------------------------------------
async function callAdapter(system: string, userMessage: string): Promise<string> {
  const port = process.env.PORT || '3456';
  const apiKey = process.env.LOCAL_API_KEY || '';

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userMessage }],
  };

  const url = `http://127.0.0.1:${port}/v1/messages`;
  console.log(`[rss-summarize] Sending to adapter at ${url}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // 2 min timeout
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Adapter responded ${response.status}: ${text.slice(0, 500)}`);
  }

  const result = (await response.json()) as any;

  // Extract text from Anthropic Messages API response
  const aiText = (result.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  if (!aiText) {
    throw new Error('Adapter returned empty response');
  }

  return aiText;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const targetDate = getTargetDate();
  console.log(`[rss-summarize] Target date: ${targetDate}`);

  // 1. Read raw JSON
  const rawPath = join(REPORTS_DIR, `raw-${targetDate}.json`);
  if (!existsSync(rawPath)) {
    console.error(`[rss-summarize] Raw report not found: ${rawPath}`);
    console.error(`[rss-summarize] Run rss-daily.ts first to generate the raw data.`);
    process.exit(1);
  }

  const raw: RawReport = JSON.parse(readFileSync(rawPath, 'utf-8'));
  console.log(
    `[rss-summarize] Loaded ${raw.stories.length} stories from ${rawPath}`,
  );
  console.log(
    `[rss-summarize] Stats: ${raw.stats.feedsOk}/${raw.stats.feedsTotal} feeds OK, ` +
    `${raw.stats.rawArticles} raw → ${raw.stats.stories} deduped`,
  );

  // 2. Pre-process: filter + group into themes
  const grouped = preprocessStories(raw.stories);

  const themeOrder: Theme[] = ['geopolitics', 'markets', 'crypto', 'tech', 'society'];
  const themeCounts: string[] = [];
  let totalIncluded = 0;
  for (const theme of themeOrder) {
    const count = grouped[theme].length;
    totalIncluded += count;
    themeCounts.push(`${THEME_LABELS[theme]}: ${count}`);
  }
  console.log(`[rss-summarize] After filtering: ${totalIncluded} stories (from ${raw.stories.length})`);
  console.log(`[rss-summarize] ${themeCounts.join(' | ')}`);

  if (totalIncluded === 0) {
    console.error(`[rss-summarize] No stories passed the filter. Nothing to summarize.`);
    process.exit(1);
  }

  // 3. Fetch BGW crypto prices (if crypto stories exist)
  let priceTickerLine = '';
  if (grouped.crypto.length > 0) {
    console.log('[rss-summarize] Crypto stories detected, fetching BGW prices...');
    priceTickerLine = await fetchCryptoPrices();
    if (priceTickerLine) {
      console.log(`[rss-summarize] BGW prices: ${priceTickerLine.split('\n')[0]}`);
    } else {
      console.log('[rss-summarize] BGW prices unavailable, continuing without.');
    }
  }

  // 4. Build prompt
  const { system, userMessage } = buildPromptPayload(targetDate, raw.stats, grouped, priceTickerLine);

  // 5. Call adapter
  console.log(`[rss-summarize] Calling adapter for AI summarization...`);
  const startTime = Date.now();
  const aiReport = await callAdapter(system, userMessage);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[rss-summarize] AI response received (${aiReport.length} chars, ${elapsed}s)`);

  // 6. Save to file
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
  const outPath = join(REPORTS_DIR, `daily-zh-${targetDate}.md`);
  writeFileSync(outPath, aiReport, 'utf-8');
  console.log(`[rss-summarize] Saved to: ${outPath}`);

  // 7. Print to stdout
  console.log('');
  console.log('='.repeat(60));
  console.log(aiReport);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error(`[rss-summarize] Fatal error:`, err);
  process.exit(1);
});
