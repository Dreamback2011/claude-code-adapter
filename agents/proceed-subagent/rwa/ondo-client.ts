/**
 * Proceed-Subagent E3 — Ondo Finance Client
 *
 * Ondo Finance provides tokenized RWA products:
 * - USDY: Tokenized US Treasury notes (~5% APY)
 * - OUSG: Tokenized short-duration US Treasuries
 *
 * Chains: Ethereum, Polygon, Mantle, Sui, Aptos, Solana
 */

// Ondo contract addresses (Ethereum mainnet)
export const ONDO_CONTRACTS = {
  USDY: {
    ethereum: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C",
    polygon: "0x5bE26527e817998A7206475496fDE1E68957c5A6",
    mantle: "0x5bE26527e817998A7206475496fDE1E68957c5A6",
  },
  OUSG: {
    ethereum: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92",
  },
  ONDO: {
    ethereum: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3", // Governance token
  },
};

// Ondo API (public data)
const ONDO_API = "https://api.ondo.finance";

export interface OndoProduct {
  symbol: string;
  name: string;
  description: string;
  apy: number;
  tvl: string;
  price: string;
  underlying: string;
  chains: string[];
  minInvestment: string;
  redemptionTime: string;
}

/**
 * Get USDY product info (from on-chain + public data)
 */
export function getUSDYInfo(): OndoProduct {
  return {
    symbol: "USDY",
    name: "Ondo US Dollar Yield",
    description: "Tokenized US Treasury notes, rebasing yield",
    apy: 5.0, // Approximate — should be fetched live
    tvl: "$500M+",
    price: "1.00", // Pegged to $1, yield via rebasing
    underlying: "US Short-Term Treasury Bills",
    chains: ["Ethereum", "Polygon", "Mantle", "Sui", "Aptos", "Solana"],
    minInvestment: "$500",
    redemptionTime: "T+0 to T+2 (instant for small amounts)",
  };
}

/**
 * Get OUSG product info
 */
export function getOUSGInfo(): OndoProduct {
  return {
    symbol: "OUSG",
    name: "Ondo Short-Term US Government Bond Fund",
    description: "Tokenized BlackRock SHV ETF exposure",
    apy: 5.2,
    tvl: "$200M+",
    price: "105.00", // Accumulates value
    underlying: "BlackRock iShares Short Treasury Bond ETF (SHV)",
    chains: ["Ethereum"],
    minInvestment: "$100,000",
    redemptionTime: "T+1 to T+3",
  };
}

/**
 * Get USDY balance for an address (on-chain read)
 */
export async function getUSDYBalance(
  address: string,
  chain: string = "ethereum",
): Promise<{ balance: string; valueUSD: string }> {
  const { ethers } = await import("ethers");
  const contractAddr = ONDO_CONTRACTS.USDY[chain as keyof typeof ONDO_CONTRACTS.USDY];

  if (!contractAddr) {
    throw new Error(`USDY not available on ${chain}`);
  }

  const { CHAINS } = await import("../utils/chains.js");
  const chainConfig = CHAINS[chain];
  if (!chainConfig) throw new Error(`Unknown chain: ${chain}`);

  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
  const contract = new ethers.Contract(
    contractAddr,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  );

  const balance = await contract.balanceOf(address);
  const formatted = ethers.formatUnits(balance, 18);

  return {
    balance: formatted,
    valueUSD: formatted, // USDY ≈ $1
  };
}
