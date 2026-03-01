/**
 * Proceed-Subagent — Chain configurations
 */

export interface ChainConfig {
  id: number;
  name: string;
  shortName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl: string;
  lifiChainId: number; // Li.Fi uses same chain IDs
}

export const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    id: 1,
    name: "Ethereum",
    shortName: "ETH",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://eth.llamarpc.com",
    explorerUrl: "https://etherscan.io",
    lifiChainId: 1,
  },
  arbitrum: {
    id: 42161,
    name: "Arbitrum One",
    shortName: "ARB",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    lifiChainId: 42161,
  },
  polygon: {
    id: 137,
    name: "Polygon",
    shortName: "MATIC",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrl: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    lifiChainId: 137,
  },
  base: {
    id: 8453,
    name: "Base",
    shortName: "BASE",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    lifiChainId: 8453,
  },
  optimism: {
    id: 10,
    name: "Optimism",
    shortName: "OP",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
    lifiChainId: 10,
  },
  bsc: {
    id: 56,
    name: "BNB Smart Chain",
    shortName: "BSC",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrl: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
    lifiChainId: 56,
  },
  avalanche: {
    id: 43114,
    name: "Avalanche C-Chain",
    shortName: "AVAX",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    lifiChainId: 43114,
  },
  solana: {
    id: -1, // Not EVM
    name: "Solana",
    shortName: "SOL",
    nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://solscan.io",
    lifiChainId: 1151111081099710, // Li.Fi Solana chain ID
  },
};

export function getChain(nameOrId: string | number): ChainConfig | undefined {
  if (typeof nameOrId === "number") {
    return Object.values(CHAINS).find((c) => c.id === nameOrId);
  }
  return CHAINS[nameOrId.toLowerCase()];
}

export function getExplorerTxUrl(chain: string, txHash: string): string {
  const c = getChain(chain);
  if (!c) return txHash;
  return `${c.explorerUrl}/tx/${txHash}`;
}

export function getExplorerAddressUrl(
  chain: string,
  address: string,
): string {
  const c = getChain(chain);
  if (!c) return address;
  return `${c.explorerUrl}/address/${address}`;
}
