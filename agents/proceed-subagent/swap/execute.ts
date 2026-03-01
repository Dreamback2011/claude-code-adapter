/**
 * Proceed-Subagent M2 — Swap Execution
 *
 * Executes a swap using the quote from Li.Fi.
 * Handles: approve → send tx → track status
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/swap/execute.ts --from ETH --to USDC --amount 1 --chain ethereum
 */

import { ethers } from "ethers";
import { getQuote, formatQuote } from "./quote.js";
import * as lifi from "./lifi-client.js";
import { getWallet } from "../auth/wallet.js";
import { getChain } from "../utils/chains.js";
import { getExplorerTxUrl } from "../utils/chains.js";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/**
 * Check and set ERC20 approval if needed
 */
async function ensureApproval(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
): Promise<string | null> {
  // Native token (ETH, etc.) doesn't need approval
  if (
    tokenAddress === "0x0000000000000000000000000000000000000000" ||
    tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  ) {
    return null;
  }

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const currentAllowance = await token.allowance(wallet.address, spenderAddress);

  if (currentAllowance >= amount) {
    console.log("  ✅ Token already approved");
    return null;
  }

  console.log("  ⏳ Approving token spend...");
  const tx = await token.approve(spenderAddress, amount);
  console.log(`  📝 Approval tx: ${tx.hash}`);
  await tx.wait();
  console.log("  ✅ Approved");
  return tx.hash;
}

/**
 * Execute a swap
 */
export async function executeSwap(params: {
  from: string;
  to: string;
  amount: string;
  fromChain?: string;
  toChain?: string;
  skipConfirm?: boolean;
}): Promise<{
  txHash: string;
  explorerUrl: string;
  fromAmount: string;
  toAmountExpected: string;
}> {
  const fromChainName = params.fromChain || "ethereum";

  // Step 1: Get quote
  console.log("\n📊 Getting quote...");
  const quote = await getQuote({
    from: params.from,
    to: params.to,
    amount: params.amount,
    fromChain: params.fromChain,
    toChain: params.toChain,
  });

  console.log(formatQuote(quote));

  // Step 2: Safety checks
  const gasCost = parseFloat(quote.gasCostUSD);
  const fromValue = parseFloat(quote.fromAmountUSD);
  const impact = parseFloat(quote.priceImpact);

  if (fromValue > 5000) {
    console.log("⚠️  WARNING: Transaction value > $5,000");
  }
  if (impact > 3) {
    console.log(`⚠️  WARNING: High price impact (${quote.priceImpact})`);
  }
  if (gasCost > fromValue * 0.1) {
    console.log(
      `⚠️  WARNING: Gas cost is ${((gasCost / fromValue) * 100).toFixed(1)}% of swap value`,
    );
  }

  if (!params.skipConfirm) {
    // In agent context, the agent will handle confirmation
    console.log("\n⏸️  Awaiting confirmation from agent...");
  }

  // Step 3: Get wallet and check the quote has a transaction
  const rawQuote = quote.rawQuote;
  if (!rawQuote.transactionRequest) {
    throw new Error("Quote does not include transaction data. Try a different route.");
  }

  const { wallet } = await getWallet(fromChainName);

  // Step 4: Handle approval if needed
  const approvalAddress = rawQuote.estimate.approvalAddress;
  if (approvalAddress) {
    await ensureApproval(
      wallet,
      rawQuote.action.fromToken.address,
      approvalAddress,
      BigInt(rawQuote.action.fromAmount),
    );
  }

  // Step 5: Execute the swap transaction
  console.log("\n  ⏳ Sending swap transaction...");
  const txRequest = rawQuote.transactionRequest;
  const tx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value,
    gasLimit: txRequest.gasLimit,
  });

  console.log(`  📝 Tx hash: ${tx.hash}`);
  const chainName = fromChainName;
  const explorerUrl = getExplorerTxUrl(chainName, tx.hash);
  console.log(`  🔗 Explorer: ${explorerUrl}`);

  // Step 6: Wait for confirmation
  console.log("  ⏳ Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(
    `  ✅ Confirmed in block ${receipt?.blockNumber}`,
  );

  // Step 7: For cross-chain, track bridge status
  const isCrossChain = quote.fromChain !== quote.toChain;
  if (isCrossChain) {
    console.log("\n  🌉 Cross-chain transfer in progress...");
    console.log("  Use status command to track:");
    console.log(
      `  npx tsx agents/proceed-subagent/swap/status.ts --tx ${tx.hash} --fromChain ${params.fromChain} --toChain ${params.toChain}`,
    );
  }

  return {
    txHash: tx.hash,
    explorerUrl,
    fromAmount: `${quote.fromAmount} ${quote.fromToken}`,
    toAmountExpected: `${quote.toAmount} ${quote.toToken}`,
  };
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
    console.log("Usage: npx tsx execute.ts --from ETH --to USDC --amount 1 --chain ethereum");
    process.exit(1);
  }

  try {
    const result = await executeSwap({ from, to, amount, fromChain, toChain });
    console.log("\n✅ Swap complete!");
    console.log(`  Sent: ${result.fromAmount}`);
    console.log(`  Expected: ~${result.toAmountExpected}`);
    console.log(`  Tx: ${result.explorerUrl}`);
  } catch (err: any) {
    console.error(`\n❌ Swap failed: ${err.message}`);
    process.exit(1);
  }
}

main();
