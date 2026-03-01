/**
 * Proceed-Subagent E3 — RWA Products Browser
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/rwa/products.ts
 *   npx tsx agents/proceed-subagent/rwa/products.ts --product USDY
 *   npx tsx agents/proceed-subagent/rwa/products.ts --balance --address 0x...
 */

import { getUSDYInfo, getOUSGInfo, getUSDYBalance, ONDO_CONTRACTS } from "./ondo-client.js";
import { getAvailableStocks } from "./xstocks-client.js";
import { formatUSD, asciiTable } from "../utils/format.js";

async function showProductDetail(symbol: string): Promise<void> {
  const products: Record<string, ReturnType<typeof getUSDYInfo>> = {
    USDY: getUSDYInfo(),
    OUSG: getOUSGInfo(),
  };

  const product = products[symbol.toUpperCase()];
  if (!product) {
    console.error(`Unknown product: ${symbol}`);
    console.error(`Available: ${Object.keys(products).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n🏛️ ${product.name} (${product.symbol})`);
  console.log("═".repeat(50));
  console.log(`  ${product.description}`);
  console.log("");
  console.log(`  APY:          ${product.apy}%`);
  console.log(`  TVL:          ${product.tvl}`);
  console.log(`  Price:        $${product.price}`);
  console.log(`  Underlying:   ${product.underlying}`);
  console.log(`  Min Invest:   ${product.minInvestment}`);
  console.log(`  Redemption:   ${product.redemptionTime}`);
  console.log("");
  console.log("  Chains:");
  product.chains.forEach((chain) => console.log(`    ✅ ${chain}`));

  if (symbol.toUpperCase() === "USDY") {
    console.log("\n  Contracts:");
    Object.entries(ONDO_CONTRACTS.USDY).forEach(([chain, addr]) => {
      console.log(`    ${chain}: ${addr}`);
    });
  }
  console.log("═".repeat(50));
}

async function showBalance(address: string): Promise<void> {
  console.log(`\n💰 RWA Holdings — ${address.slice(0, 6)}...${address.slice(-4)}`);
  console.log("─".repeat(50));

  const chains = ["ethereum", "polygon"] as const;

  for (const chain of chains) {
    try {
      const { balance, valueUSD } = await getUSDYBalance(address, chain);
      if (parseFloat(balance) > 0) {
        console.log(`  USDY (${chain}): ${parseFloat(balance).toFixed(2)} (${formatUSD(parseFloat(valueUSD))})`);
      }
    } catch {
      // Chain not available or RPC error
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const product = getArg("--product");
  if (product) {
    await showProductDetail(product);
    return;
  }

  if (args.includes("--balance")) {
    const address = getArg("--address");
    if (!address) {
      console.error("Provide --address 0x...");
      process.exit(1);
    }
    await showBalance(address);
    return;
  }

  // Default: overview of all RWA products
  console.log("\n🏛️ RWA Products");
  console.log("═".repeat(60));

  const usdy = getUSDYInfo();
  const ousg = getOUSGInfo();

  console.log("\n📊 Yield Products (Ondo Finance)");
  console.log(
    asciiTable(
      ["Product", "APY", "TVL", "Min Invest", "Underlying"],
      [
        [usdy.symbol, `${usdy.apy}%`, usdy.tvl, usdy.minInvestment, usdy.underlying],
        [ousg.symbol, `${ousg.apy}%`, ousg.tvl, ousg.minInvestment, ousg.underlying],
      ],
    ),
  );

  console.log("\n📈 Tokenized Stocks (Xstocks)");
  const stocks = await getAvailableStocks();
  const rows = stocks.map((s) => [
    s.symbol,
    s.name,
    s.price !== "0" ? formatUSD(parseFloat(s.price)) : "Live price TBD",
  ]);
  console.log(asciiTable(["Token", "Stock", "Price"], rows));

  console.log("\nUse --product USDY for details, --balance --address 0x... for holdings");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
