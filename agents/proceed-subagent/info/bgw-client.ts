/**
 * Proceed-Subagent M3 — Bitget Wallet Open API Client
 *
 * Docs: https://web3.bitget.com/docs/
 *
 * Set BGW_API_KEY in .env
 */

const BGW_BASE = process.env.BGW_API_BASE || "https://open-api.bkcoins.com";
const API_KEY = process.env.BGW_API_KEY || "";

interface BGWHeaders {
  [key: string]: string;
}

function getHeaders(): BGWHeaders {
  const headers: BGWHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }
  return headers;
}

async function bgwFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BGW_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BGW API error (${res.status}): ${text}`);
  }

  const data = await res.json() as any;

  // BGW API typically wraps data in { code, msg, data }
  if (data.code !== undefined && data.code !== 0 && data.code !== "0") {
    throw new Error(`BGW API error: ${data.msg || JSON.stringify(data)}`);
  }

  return data.data !== undefined ? data.data : data;
}

// --- Types ---

export interface TokenPrice {
  symbol: string;
  price: string;
  priceUSD: string;
  change24h: string;
  volume24h: string;
  marketCap: string;
  chainId: string;
  address: string;
}

export interface TokenBalance {
  symbol: string;
  name: string;
  address: string;
  balance: string;
  balanceUSD: string;
  price: string;
  decimals: number;
  logoUrl?: string;
}

export interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  timestamp: number;
  status: string;
  gasUsed: string;
  chainId: string;
}

export interface WhaleAlert {
  hash: string;
  from: string;
  to: string;
  value: string;
  valueUSD: string;
  tokenSymbol: string;
  timestamp: number;
  chainId: string;
}

// --- API Methods ---

/**
 * Get token price
 */
export async function getTokenPrice(
  chainId: string,
  tokenAddress: string,
): Promise<TokenPrice> {
  return bgwFetch<TokenPrice>("/api/v1/token/price", {
    chainId,
    address: tokenAddress,
  });
}

/**
 * Get multiple token prices
 */
export async function getTokenPrices(
  tokens: Array<{ chainId: string; address: string }>,
): Promise<TokenPrice[]> {
  const results = await Promise.allSettled(
    tokens.map((t) => getTokenPrice(t.chainId, t.address)),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<TokenPrice> => r.status === "fulfilled")
    .map((r) => r.value);
}

/**
 * Get wallet token balances
 */
export async function getBalances(
  chainId: string,
  address: string,
): Promise<TokenBalance[]> {
  return bgwFetch<TokenBalance[]>("/api/v1/address/balance", {
    chainId,
    address,
  });
}

/**
 * Get wallet token balances across multiple chains
 */
export async function getMultiChainBalances(
  address: string,
  chainIds: string[] = ["1", "42161", "137", "8453", "56"],
): Promise<Record<string, TokenBalance[]>> {
  const results: Record<string, TokenBalance[]> = {};

  const fetches = chainIds.map(async (chainId) => {
    try {
      const balances = await getBalances(chainId, address);
      results[chainId] = balances;
    } catch {
      results[chainId] = [];
    }
  });

  await Promise.all(fetches);
  return results;
}

/**
 * Get transaction history
 */
export async function getTransactions(
  chainId: string,
  address: string,
  params?: { page?: string; limit?: string },
): Promise<Transaction[]> {
  return bgwFetch<Transaction[]>("/api/v1/address/transactions", {
    chainId,
    address,
    page: params?.page || "1",
    limit: params?.limit || "20",
  });
}

/**
 * Get whale alerts / large transfers
 */
export async function getWhaleAlerts(
  chainId: string,
  params?: { minValueUSD?: string; limit?: string },
): Promise<WhaleAlert[]> {
  return bgwFetch<WhaleAlert[]>("/api/v1/whale/alerts", {
    chainId,
    minValueUSD: params?.minValueUSD || "100000",
    limit: params?.limit || "20",
  });
}

/**
 * Get trending tokens
 */
export async function getTrendingTokens(
  chainId: string = "1",
): Promise<TokenPrice[]> {
  return bgwFetch<TokenPrice[]>("/api/v1/token/trending", {
    chainId,
  });
}
