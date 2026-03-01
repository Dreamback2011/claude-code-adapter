/**
 * Proceed-Subagent M3 — Token Price Query
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/info/price.ts --token ETH
 *   npx tsx agents/proceed-subagent/info/price.ts --token BTC,ETH,SOL
 *   npx tsx agents/proceed-subagent/info/price.ts --trending
 */

import { getTokenPrice, getTrendingTokens } from "./bgw-client.js";
import { formatUSD, formatChange, asciiTable } from "../utils/format.js";

// Well-known token addresses (native tokens use zero address convention)
const KNOWN_TOKENS: Record<string, { chainId: string; address: string }> = {
  ETH: { chainId: "1", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
  BTC: { chainId: "1", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" }, // WBTC
  USDT: { chainId: "1", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  USDC: { chainId: "1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  SOL: { chainId: "1", address: "0xd31a59c85ae9d8edefec411d448f90841571b89c" }, // Wrapped SOL on ETH
  BNB: { chainId: "56", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
  MATIC: { chainId: "137", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
  ARB: { chainId: "42161", address: "0x912ce59144191c1204e64559fe8253a0e49e6548" },
  OP: { chainId: "10", address: "0x4200000000000000000000000000000000000042" },
};

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--trending")) {
    console.log("\n🔥 Trending Tokens");
    try {
      const trending = await getTrendingTokens("1");
      const rows = trending.slice(0, 15).map((t) => [
        t.symbol,
        formatUSD(parseFloat(t.priceUSD || t.price)),
        formatChange(parseFloat(t.change24h || "0")),
        formatUSD(parseFloat(t.volume24h || "0")),
      ]);
      console.log(asciiTable(["Token", "Price", "24h", "Volume"], rows));
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
    }
    return;
  }

  const tokenIdx = args.indexOf("--token");
  if (tokenIdx < 0) {
    console.log("Usage:");
    console.log("  --token ETH          Single token price");
    console.log("  --token BTC,ETH,SOL  Multiple token prices");
    console.log("  --trending           Trending tokens");
    return;
  }

  const symbols = args[tokenIdx + 1].toUpperCase().split(",");

  console.log("\n💰 Token Prices");

  const rows: string[][] = [];
  for (const symbol of symbols) {
    const known = KNOWN_TOKENS[symbol];
    if (!known) {
      rows.push([symbol, "Unknown", "—", "—"]);
      continue;
    }

    try {
      const price = await getTokenPrice(known.chainId, known.address);
      rows.push([
        symbol,
        formatUSD(parseFloat(price.priceUSD || price.price)),
        formatChange(parseFloat(price.change24h || "0")),
        formatUSD(parseFloat(price.marketCap || "0")),
      ]);
    } catch {
      rows.push([symbol, "Error", "—", "—"]);
    }
  }

  console.log(asciiTable(["Token", "Price", "24h", "MCap"], rows));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
