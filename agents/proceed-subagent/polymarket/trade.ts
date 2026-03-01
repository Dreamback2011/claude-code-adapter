/**
 * Proceed-Subagent E1 — Polymarket Trading (placeholder)
 *
 * Full trading requires @polymarket/clob-client SDK.
 * This file provides the interface and will be completed after SDK integration.
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/polymarket/trade.ts --market <id> --side YES --amount 100
 */

import { getMarket, getMidpoint } from "./pm-client.js";
import { formatUSD } from "../utils/format.js";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const marketId = getArg("--market");
  const side = (getArg("--side") || "YES").toUpperCase();
  const amount = getArg("--amount");

  if (!marketId || !amount) {
    console.log("Usage: npx tsx trade.ts --market <slug> --side YES --amount 100");
    process.exit(1);
  }

  // Show what would happen
  const market = await getMarket(marketId);
  const yesToken = market.tokens?.find((t) => t.outcome === "Yes");
  const noToken = market.tokens?.find((t) => t.outcome === "No");
  const token = side === "YES" ? yesToken : noToken;

  if (!token) {
    console.error("Token not found for this market");
    process.exit(1);
  }

  const price = token.price;
  const shares = parseFloat(amount) / price;

  console.log("\n🎯 Polymarket Trade Preview");
  console.log("─".repeat(40));
  console.log(`  Market: ${market.question}`);
  console.log(`  Side:   ${side}`);
  console.log(`  Price:  ${(price * 100).toFixed(1)}¢`);
  console.log(`  Cost:   ${formatUSD(parseFloat(amount))} USDC`);
  console.log(`  Shares: ~${shares.toFixed(2)}`);
  console.log(`  Payout: ${formatUSD(shares)} if ${side} wins`);
  console.log("─".repeat(40));
  console.log("");
  console.log("⚠️  Trading not yet implemented.");
  console.log("Required setup:");
  console.log("  1. npm install @polymarket/clob-client");
  console.log("  2. Set POLYMARKET_API_KEY in .env");
  console.log("  3. Set POLYMARKET_API_SECRET in .env");
  console.log("  4. Set POLYMARKET_PASSPHRASE in .env");
  console.log("  5. Approve USDC on Polygon to CTF Exchange");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
