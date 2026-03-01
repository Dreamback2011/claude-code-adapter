/**
 * Proceed-Subagent E2 — Hyperliquid Position Viewer
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/hyperliquid/positions.ts --address 0x...
 *   npx tsx agents/proceed-subagent/hyperliquid/positions.ts  (uses stored wallet)
 */

import { getUserState, getAllMids, HLPosition } from "./hl-client.js";
import { getAddress } from "../auth/wallet.js";
import { formatUSD, formatTokenAmount, formatChange, asciiTable, shortenAddress } from "../utils/format.js";

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

  console.log(`\n📊 Hyperliquid Positions — ${shortenAddress(address)}`);
  console.log("═".repeat(60));

  const state = await getUserState(address);
  const mids = await getAllMids();

  // Account summary
  const margin = state.crossMarginSummary || state.marginSummary;
  console.log(`\n  Account Value: ${formatUSD(parseFloat(margin.accountValue))}`);
  console.log(`  Margin Used:   ${formatUSD(parseFloat(margin.totalMarginUsed))}`);
  console.log(`  Withdrawable:  ${formatUSD(parseFloat(state.withdrawable))}`);

  // Positions
  const positions = state.assetPositions
    .map((ap) => ap.position)
    .filter((p) => parseFloat(p.szi) !== 0);

  if (positions.length === 0) {
    console.log("\n  No open positions.");
    return;
  }

  console.log(`\n  Open Positions (${positions.length}):`);

  const rows = positions.map((p) => {
    const size = parseFloat(p.szi);
    const side = size > 0 ? "LONG" : "SHORT";
    const sideIcon = size > 0 ? "🟢" : "🔴";
    const currentPx = mids[p.coin] || p.entryPx;
    const pnl = parseFloat(p.unrealizedPnl);
    const roe = parseFloat(p.returnOnEquity) * 100;

    return [
      `${sideIcon} ${p.coin}`,
      side,
      formatTokenAmount(Math.abs(size)),
      `$${parseFloat(p.entryPx).toFixed(2)}`,
      `$${parseFloat(currentPx).toFixed(2)}`,
      `${p.leverage.value}x`,
      `${pnl >= 0 ? "+" : ""}${formatUSD(pnl)}`,
      formatChange(roe),
      p.liquidationPx ? `$${parseFloat(p.liquidationPx).toFixed(2)}` : "—",
    ];
  });

  console.log(
    asciiTable(
      ["Asset", "Side", "Size", "Entry", "Mark", "Lev", "uPnL", "ROE", "Liq"],
      rows,
    ),
  );

  // Total unrealized PnL
  const totalPnl = positions.reduce(
    (sum, p) => sum + parseFloat(p.unrealizedPnl),
    0,
  );
  console.log(`\n  Total uPnL: ${totalPnl >= 0 ? "+" : ""}${formatUSD(totalPnl)}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
