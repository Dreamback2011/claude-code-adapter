/**
 * Proceed-Subagent M2 — Unified Quote Interface
 *
 * Gets the best swap/bridge quote from Li.Fi, with 0x as fallback.
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/swap/quote.ts --from ETH --to USDC --amount 1 --chain ethereum
 *   npx tsx agents/proceed-subagent/swap/quote.ts --from ETH --to USDC --amount 1 --fromChain ethereum --toChain arbitrum
 */

import { ethers } from "ethers";
import * as lifi from "./lifi-client.js";
import { getChain, CHAINS } from "../utils/chains.js";
import { formatUSD, formatTokenAmount } from "../utils/format.js";
import { getAddress } from "../auth/wallet.js";

export interface QuoteResult {
  source: "lifi" | "0x";
  fromToken: string;
  toToken: string;
  fromChain: string;
  toChain: string;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  fromAmountUSD: string;
  toAmountUSD: string;
  gasCostUSD: string;
  executionTime: number; // seconds
  route: string; // e.g. "UniswapV3" or "Stargate → UniswapV3"
  priceImpact: string;
  rawQuote: lifi.LiFiQuote;
}

/**
 * Get a swap quote
 */
export async function getQuote(params: {
  from: string;
  to: string;
  amount: string;
  fromChain?: string;
  toChain?: string;
  address?: string;
}): Promise<QuoteResult> {
  const fromChainName = params.fromChain || "ethereum";
  const toChainName = params.toChain || fromChainName;
  const fromChain = getChain(fromChainName);
  const toChain = getChain(toChainName);

  if (!fromChain) throw new Error(`Unknown chain: ${fromChainName}`);
  if (!toChain) throw new Error(`Unknown chain: ${toChainName}`);

  // Resolve sender address
  const address = params.address || (await getAddress());

  // Find tokens
  const fromToken = await lifi.findToken(fromChain.id, params.from);
  const toToken = await lifi.findToken(toChain.id, params.to);

  if (!fromToken) {
    throw new Error(
      `Token "${params.from}" not found on ${fromChain.name}. Try using the contract address.`,
    );
  }
  if (!toToken) {
    throw new Error(
      `Token "${params.to}" not found on ${toChain.name}. Try using the contract address.`,
    );
  }

  // Convert human amount to wei
  const fromAmount = ethers.parseUnits(params.amount, fromToken.decimals).toString();

  // Get Li.Fi quote
  const quote = await lifi.getQuote({
    fromChain: fromChain.id,
    toChain: toChain.id,
    fromToken: fromToken.address,
    toToken: toToken.address,
    fromAmount,
    fromAddress: address,
  });

  // Build route description
  const routeSteps = quote.includedSteps
    ?.map((s) => s.tool)
    .join(" → ") || quote.tool;

  // Calculate price impact
  const fromUSD = parseFloat(quote.estimate.fromAmountUSD || "0");
  const toUSD = parseFloat(quote.estimate.toAmountUSD || "0");
  const impact = fromUSD > 0 ? ((fromUSD - toUSD) / fromUSD) * 100 : 0;

  return {
    source: "lifi",
    fromToken: fromToken.symbol,
    toToken: toToken.symbol,
    fromChain: fromChain.name,
    toChain: toChain.name,
    fromAmount: params.amount,
    toAmount: ethers.formatUnits(quote.estimate.toAmount, toToken.decimals),
    toAmountMin: ethers.formatUnits(
      quote.estimate.toAmountMin,
      toToken.decimals,
    ),
    fromAmountUSD: quote.estimate.fromAmountUSD,
    toAmountUSD: quote.estimate.toAmountUSD,
    gasCostUSD: quote.estimate.gasCosts
      ?.reduce((sum, g) => sum + parseFloat(g.amountUSD || "0"), 0)
      .toFixed(2) || "0",
    executionTime: quote.estimate.executionDuration || 0,
    route: routeSteps,
    priceImpact: impact.toFixed(2) + "%",
    rawQuote: quote,
  };
}

/**
 * Display quote in a readable format
 */
export function formatQuote(q: QuoteResult): string {
  const isCrossChain = q.fromChain !== q.toChain;
  const header = isCrossChain
    ? `🔄 Cross-chain Swap Quote`
    : `🔄 Swap Quote`;

  return [
    `\n${header}`,
    `─────────────────────────────────`,
    `  From: ${q.fromAmount} ${q.fromToken} (${q.fromChain})`,
    `    To: ${q.toAmount} ${q.toToken} (${q.toChain})`,
    `   Min: ${q.toAmountMin} ${q.toToken} (after slippage)`,
    ``,
    `  Value: ${formatUSD(parseFloat(q.fromAmountUSD))} → ${formatUSD(parseFloat(q.toAmountUSD))}`,
    `  Gas:   ~${formatUSD(parseFloat(q.gasCostUSD))}`,
    `  Impact: ${q.priceImpact}`,
    `  Route: ${q.route}`,
    `  Time:  ~${q.executionTime}s`,
    `  Source: Li.Fi`,
    `─────────────────────────────────`,
  ].join("\n");
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const from = getArg("--from");
  const to = getArg("--to");
  const amount = getArg("--amount");
  const fromChain = getArg("--fromChain") || getArg("--chain");
  const toChain = getArg("--toChain") || fromChain;

  if (!from || !to || !amount) {
    console.log("Usage: npx tsx quote.ts --from ETH --to USDC --amount 1 --chain ethereum");
    console.log("       npx tsx quote.ts --from ETH --to USDC --amount 1 --fromChain ethereum --toChain arbitrum");
    process.exit(1);
  }

  try {
    const quote = await getQuote({ from, to, amount, fromChain, toChain });
    console.log(formatQuote(quote));
  } catch (err: any) {
    console.error(`❌ Quote failed: ${err.message}`);
    process.exit(1);
  }
}

main();
