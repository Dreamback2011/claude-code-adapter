/**
 * Proceed-Subagent M3 — Whale Alerts & On-chain Activity
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/info/alerts.ts --chain ethereum
 *   npx tsx agents/proceed-subagent/info/alerts.ts --chain ethereum --min 500000
 */

import { getWhaleAlerts } from "./bgw-client.js";
import { formatUSD, shortenAddress, asciiTable } from "../utils/format.js";

const CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  arbitrum: "42161",
  polygon: "137",
  base: "8453",
  bsc: "56",
  optimism: "10",
};

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const chainName = getArg("--chain") || "ethereum";
  const minValue = getArg("--min") || "100000";
  const chainId = CHAIN_IDS[chainName.toLowerCase()];

  if (!chainId) {
    console.error(`Unknown chain: ${chainName}`);
    console.error(`Available: ${Object.keys(CHAIN_IDS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n🐋 Whale Alerts — ${chainName} (min ${formatUSD(parseInt(minValue))})`);

  try {
    const alerts = await getWhaleAlerts(chainId, {
      minValueUSD: minValue,
      limit: "20",
    });

    if (alerts.length === 0) {
      console.log("No recent whale activity found.");
      return;
    }

    const rows = alerts.map((a) => [
      shortenAddress(a.from),
      "→",
      shortenAddress(a.to),
      `${a.value} ${a.tokenSymbol}`,
      formatUSD(parseFloat(a.valueUSD)),
      new Date(a.timestamp * 1000).toLocaleTimeString(),
    ]);

    console.log(
      asciiTable(["From", "", "To", "Amount", "Value", "Time"], rows),
    );
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
