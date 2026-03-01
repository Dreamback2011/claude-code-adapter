/**
 * Proceed-Subagent E3 — RWA Yield Comparison
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/rwa/yields.ts
 *   npx tsx agents/proceed-subagent/rwa/yields.ts --stocks
 */

import { getUSDYInfo, getOUSGInfo } from "./ondo-client.js";
import { getAvailableStocks } from "./xstocks-client.js";
import { formatUSD, formatChange, asciiTable } from "../utils/format.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--stocks")) {
    console.log("\n📈 Tokenized Stocks (Xstocks)");
    console.log("─".repeat(50));

    const stocks = await getAvailableStocks();
    const rows = stocks.map((s) => [
      s.symbol,
      s.name,
      s.price !== "0" ? formatUSD(parseFloat(s.price)) : "—",
      s.change24h !== "0" ? formatChange(parseFloat(s.change24h)) : "—",
    ]);

    console.log(asciiTable(["Token", "Stock", "Price", "24h"], rows));
    return;
  }

  // Default: Show all RWA yields
  console.log("\n🏛️ RWA Products Overview");
  console.log("═".repeat(60));

  // Ondo products
  const usdy = getUSDYInfo();
  const ousg = getOUSGInfo();

  console.log("\n📊 Yield-Bearing Products");
  console.log(
    asciiTable(
      ["Product", "APY", "TVL", "Min", "Underlying", "Redemption"],
      [
        [
          usdy.symbol,
          `${usdy.apy}%`,
          usdy.tvl,
          usdy.minInvestment,
          usdy.underlying,
          usdy.redemptionTime,
        ],
        [
          ousg.symbol,
          `${ousg.apy}%`,
          ousg.tvl,
          ousg.minInvestment,
          ousg.underlying,
          ousg.redemptionTime,
        ],
      ],
    ),
  );

  // Chain availability
  console.log("\n🔗 USDY Chain Availability:");
  usdy.chains.forEach((chain) => {
    console.log(`  ✅ ${chain}`);
  });

  // Xstocks summary
  console.log("\n📈 Tokenized Stocks (Xstocks)");
  const stocks = await getAvailableStocks();
  console.log(`  Available: ${stocks.map((s) => s.symbol).join(", ")}`);
  console.log("  Use --stocks flag for detailed view");

  // Comparison notes
  console.log("\n💡 Notes:");
  console.log("  • USDY: 最适合闲置 USDC，$500起投，随时赎回");
  console.log("  • OUSG: 机构级，$100K起投，收益稍高");
  console.log("  • xStocks: 24/7 链上美股，适合非美国交易时段");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
