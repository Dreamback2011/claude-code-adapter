/**
 * Proceed-Subagent M3 — Portfolio Overview
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/info/portfolio.ts --address 0x...
 *   npx tsx agents/proceed-subagent/info/portfolio.ts  (uses stored wallet)
 */

import { getMultiChainBalances, TokenBalance } from "./bgw-client.js";
import { getAddress } from "../auth/wallet.js";
import { formatUSD, formatTokenAmount, formatChange, asciiTable, shortenAddress } from "../utils/format.js";
import { getChain } from "../utils/chains.js";

const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "42161": "Arbitrum",
  "137": "Polygon",
  "8453": "Base",
  "56": "BSC",
  "10": "Optimism",
  "43114": "Avalanche",
};

async function main() {
  const args = process.argv.slice(2);
  const addrIdx = args.indexOf("--address");
  let address: string;

  if (addrIdx >= 0) {
    address = args[addrIdx + 1];
  } else {
    try {
      address = await getAddress();
    } catch {
      console.error("No wallet found. Provide --address or login first.");
      process.exit(1);
    }
  }

  console.log(`\n💰 Portfolio Overview — ${shortenAddress(address)}`);
  console.log("═".repeat(50));

  const chainIds = ["1", "42161", "137", "8453", "56"];
  const allBalances = await getMultiChainBalances(address, chainIds);

  let totalUSD = 0;

  for (const chainId of chainIds) {
    const balances = allBalances[chainId] || [];
    const chainName = CHAIN_NAMES[chainId] || `Chain ${chainId}`;

    // Filter out zero balances
    const nonZero = balances.filter(
      (b) => parseFloat(b.balance) > 0,
    );

    if (nonZero.length === 0) continue;

    const chainTotal = nonZero.reduce(
      (sum, b) => sum + parseFloat(b.balanceUSD || "0"),
      0,
    );
    totalUSD += chainTotal;

    console.log(`\n📍 ${chainName} — ${formatUSD(chainTotal)}`);

    const rows = nonZero
      .sort((a, b) => parseFloat(b.balanceUSD || "0") - parseFloat(a.balanceUSD || "0"))
      .slice(0, 10)
      .map((b) => [
        b.symbol,
        formatTokenAmount(parseFloat(b.balance)),
        formatUSD(parseFloat(b.balanceUSD || "0")),
      ]);

    console.log(asciiTable(["Token", "Amount", "Value"], rows));
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`💎 Total Portfolio Value: ${formatUSD(totalUSD)}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
