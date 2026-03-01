/**
 * Proceed-Subagent E2 — Hyperliquid Funding Rates
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/hyperliquid/funding.ts --asset ETH
 *   npx tsx agents/proceed-subagent/hyperliquid/funding.ts --all
 */

import { getMetaAndAssetCtxs, getFundingHistory } from "./hl-client.js";
import { asciiTable, formatUSD } from "../utils/format.js";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  if (args.includes("--all")) {
    console.log("\n💰 Hyperliquid Funding Rates");

    const [meta, ctxs] = await getMetaAndAssetCtxs();

    const rows = meta.universe
      .map((asset, i) => {
        const ctx = ctxs[i];
        if (!ctx) return null;

        const funding = parseFloat(ctx.funding) * 100;
        const price = parseFloat(ctx.markPx);
        const oi = parseFloat(ctx.openInterest);
        const vol = parseFloat(ctx.dayNtlVlm);

        return {
          name: asset.name,
          funding,
          price,
          oi,
          vol,
          row: [
            asset.name,
            `$${price.toFixed(2)}`,
            `${funding >= 0 ? "+" : ""}${funding.toFixed(4)}%`,
            `${(funding * 3 * 365).toFixed(2)}%`, // Annualized (8h funding)
            formatUSD(oi * price),
            formatUSD(vol),
          ],
        };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b!.funding) - Math.abs(a!.funding))
      .slice(0, 20);

    console.log(
      asciiTable(
        ["Asset", "Price", "Funding(8h)", "APR", "OI", "24h Vol"],
        rows.map((r) => r!.row),
      ),
    );
    return;
  }

  const asset = getArg("--asset")?.toUpperCase();
  if (!asset) {
    console.log("Usage:");
    console.log("  --all              All funding rates");
    console.log("  --asset ETH        Funding history for specific asset");
    return;
  }

  console.log(`\n💰 ${asset} Funding Rate History (7d)`);

  const history = await getFundingHistory(asset);
  const rows = history.slice(-20).map((h) => {
    const rate = parseFloat(h.fundingRate) * 100;
    return [
      new Date(h.time).toLocaleString(),
      `${rate >= 0 ? "+" : ""}${rate.toFixed(4)}%`,
      `${(rate * 3 * 365).toFixed(2)}%`,
    ];
  });

  console.log(asciiTable(["Time", "Rate(8h)", "APR"], rows));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
