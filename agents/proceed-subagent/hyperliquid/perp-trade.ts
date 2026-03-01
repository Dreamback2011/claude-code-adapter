/**
 * Proceed-Subagent E2 — Hyperliquid Perpetual Trading (placeholder)
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/hyperliquid/perp-trade.ts --asset ETH --side long --size 1000 --leverage 5
 */

import { getAllMids, getMeta } from "./hl-client.js";
import { formatUSD } from "../utils/format.js";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const asset = getArg("--asset")?.toUpperCase();
  const side = getArg("--side")?.toUpperCase();
  const size = getArg("--size");
  const leverage = getArg("--leverage") || "1";

  if (!asset || !side || !size) {
    console.log("Usage: npx tsx perp-trade.ts --asset ETH --side long --size 1000 --leverage 5");
    process.exit(1);
  }

  // Get current price
  const mids = await getAllMids();
  const price = mids[asset];
  if (!price) {
    console.error(`Asset ${asset} not found on Hyperliquid`);
    process.exit(1);
  }

  const meta = await getMeta();
  const assetMeta = meta.universe.find((u) => u.name === asset);
  const maxLev = assetMeta?.maxLeverage || 50;
  const lev = parseInt(leverage);

  if (lev > maxLev) {
    console.error(`Max leverage for ${asset} is ${maxLev}x`);
    process.exit(1);
  }

  const sizeUSD = parseFloat(size);
  const qty = sizeUSD / parseFloat(price);
  const margin = sizeUSD / lev;

  console.log("\n📊 Hyperliquid Trade Preview");
  console.log("─".repeat(40));
  console.log(`  Asset:     ${asset}-PERP`);
  console.log(`  Side:      ${side}`);
  console.log(`  Price:     $${parseFloat(price).toFixed(2)}`);
  console.log(`  Size:      ${formatUSD(sizeUSD)} (${qty.toFixed(4)} ${asset})`);
  console.log(`  Leverage:  ${lev}x`);
  console.log(`  Margin:    ${formatUSD(margin)}`);
  console.log("─".repeat(40));

  if (sizeUSD > 5000) {
    console.log("⚠️  WARNING: Position size > $5,000");
  }
  if (lev > 10) {
    console.log(`⚠️  WARNING: High leverage (${lev}x)`);
  }

  console.log("");
  console.log("⚠️  Trading not yet implemented.");
  console.log("Requires EIP-712 wallet signature integration with Proceed-Subagent wallet.");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
