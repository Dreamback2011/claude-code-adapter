/**
 * Proceed-Subagent M1 — Wallet operations
 *
 * Wraps Web3Auth private key with ethers.js for signing and sending transactions.
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/auth/wallet.ts --info
 *   npx tsx agents/proceed-subagent/auth/wallet.ts --balance --chain ethereum
 */

import { ethers } from "ethers";
import { connectFromStoredToken } from "./web3auth-client.js";
import { CHAINS, getChain } from "../utils/chains.js";
import { formatUSD, shortenAddress, weiToEth } from "../utils/format.js";

/**
 * Get an ethers Wallet connected to the specified chain
 */
export async function getWallet(
  chain: string = "ethereum",
): Promise<{ wallet: ethers.Wallet; address: string }> {
  const session = await connectFromStoredToken();
  const chainConfig = getChain(chain);

  if (!chainConfig) {
    throw new Error(`Unknown chain: ${chain}. Available: ${Object.keys(CHAINS).join(", ")}`);
  }

  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
  const wallet = new ethers.Wallet(session.privateKey, provider);

  return { wallet, address: wallet.address };
}

/**
 * Get the wallet address without connecting to any chain
 */
export async function getAddress(): Promise<string> {
  const session = await connectFromStoredToken();
  const wallet = new ethers.Wallet(session.privateKey);
  return wallet.address;
}

/**
 * Get native token balance on a specific chain
 */
export async function getNativeBalance(
  chain: string = "ethereum",
): Promise<{ balance: string; symbol: string; chain: string }> {
  const { wallet } = await getWallet(chain);
  const chainConfig = getChain(chain)!;
  const balance = await wallet.provider!.getBalance(wallet.address);

  return {
    balance: weiToEth(balance),
    symbol: chainConfig.nativeCurrency.symbol,
    chain: chainConfig.name,
  };
}

/**
 * Sign a message
 */
export async function signMessage(message: string): Promise<string> {
  const { wallet } = await getWallet();
  return wallet.signMessage(message);
}

/**
 * Send a raw transaction
 */
export async function sendTransaction(
  chain: string,
  tx: ethers.TransactionRequest,
): Promise<ethers.TransactionResponse> {
  const { wallet } = await getWallet(chain);
  return wallet.sendTransaction(tx);
}

// --- CLI entry point ---
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--info")) {
    try {
      const address = await getAddress();
      console.log(`\n🔐 Proceed-Subagent Wallet`);
      console.log(`Address: ${address}`);
      console.log(`Short:   ${shortenAddress(address)}`);

      // Check balances on main chains
      console.log(`\n💰 Balances:`);
      const checkChains = ["ethereum", "arbitrum", "base", "polygon", "bsc"];

      for (const chain of checkChains) {
        try {
          const { balance, symbol, chain: chainName } = await getNativeBalance(chain);
          console.log(`  ${chainName}: ${balance} ${symbol}`);
        } catch {
          console.log(`  ${getChain(chain)?.name || chain}: (RPC error)`);
        }
      }
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (args.includes("--balance")) {
    const chainIdx = args.indexOf("--chain");
    const chain = chainIdx >= 0 ? args[chainIdx + 1] : "ethereum";

    try {
      const { balance, symbol, chain: chainName } = await getNativeBalance(chain);
      console.log(`${chainName}: ${balance} ${symbol}`);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log("Usage:");
  console.log("  --info              Show wallet address and balances");
  console.log("  --balance [--chain] Show balance on specific chain");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
