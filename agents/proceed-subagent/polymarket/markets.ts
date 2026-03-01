/**
 * Proceed-Subagent E1 — Polymarket Market Browser
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/polymarket/markets.ts --trending
 *   npx tsx agents/proceed-subagent/polymarket/markets.ts --search "Trump"
 *   npx tsx agents/proceed-subagent/polymarket/markets.ts --market <slug>
 */

import {
  searchMarkets,
  getTrendingMarkets,
  getMarket,
  getSpread,
  Market,
} from "./pm-client.js";
import { formatUSD, asciiTable } from "../utils/format.js";

function formatMarketList(markets: Market[]): string {
  const rows = markets.map((m) => {
    const yesToken = m.tokens?.find((t) => t.outcome === "Yes");
    const noToken = m.tokens?.find((t) => t.outcome === "No");
    const yesPrice = yesToken ? `${(yesToken.price * 100).toFixed(0)}%` : "—";
    const noPrice = noToken ? `${(noToken.price * 100).toFixed(0)}%` : "—";

    // Truncate question to 50 chars
    const q =
      m.question.length > 50
        ? m.question.slice(0, 47) + "..."
        : m.question;

    return [
      q,
      yesPrice,
      noPrice,
      formatUSD(parseFloat(m.volume || "0")),
    ];
  });

  return asciiTable(["Market", "YES", "NO", "Volume"], rows);
}

async function showMarketDetail(idOrSlug: string): Promise<void> {
  const m = await getMarket(idOrSlug);

  console.log(`\n🎯 ${m.question}`);
  console.log("─".repeat(60));
  if (m.description) {
    console.log(m.description.slice(0, 300));
    if (m.description.length > 300) console.log("...");
  }
  console.log("");

  for (const token of m.tokens || []) {
    const pct = (token.price * 100).toFixed(1);
    const bar = "█".repeat(Math.round(token.price * 20));
    console.log(`  ${token.outcome.padEnd(4)} ${pct}%  ${bar}`);

    // Get spread info
    try {
      const spread = await getSpread(token.token_id);
      console.log(
        `       Bid: ${(spread.bid * 100).toFixed(1)}%  Ask: ${(spread.ask * 100).toFixed(1)}%  Spread: ${(spread.spread * 100).toFixed(2)}%`,
      );
    } catch {
      // Spread fetch may fail silently
    }
  }

  console.log("");
  console.log(`  Volume:    ${formatUSD(parseFloat(m.volume || "0"))}`);
  console.log(`  Liquidity: ${formatUSD(parseFloat(m.liquidity || "0"))}`);
  console.log(`  Ends:      ${m.end_date_iso || "TBD"}`);
  console.log(`  Status:    ${m.closed ? "Closed" : m.active ? "Active" : "Inactive"}`);
  if (m.market_slug) {
    console.log(`  Link:      https://polymarket.com/event/${m.market_slug}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  if (args.includes("--trending")) {
    console.log("\n🔥 Trending Polymarket Markets");
    const markets = await getTrendingMarkets(15);
    console.log(formatMarketList(markets));
    return;
  }

  const searchQuery = getArg("--search");
  if (searchQuery) {
    console.log(`\n🔍 Polymarket Search: "${searchQuery}"`);
    const markets = await searchMarkets(searchQuery);
    if (markets.length === 0) {
      console.log("No markets found.");
      return;
    }
    console.log(formatMarketList(markets));
    return;
  }

  const marketId = getArg("--market");
  if (marketId) {
    await showMarketDetail(marketId);
    return;
  }

  console.log("Usage:");
  console.log("  --trending         Top markets by volume");
  console.log('  --search "query"   Search markets');
  console.log("  --market <slug>    Market detail + orderbook");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
