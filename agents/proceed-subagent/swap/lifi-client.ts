/**
 * Proceed-Subagent M2 — Li.Fi API Client
 *
 * Li.Fi aggregates 25+ chains, DEXs, and bridges into a single API.
 * Docs: https://docs.li.fi/
 *
 * Free tier: No API key needed for basic usage.
 * Set LIFI_API_KEY in .env for higher rate limits.
 */

const LIFI_BASE = "https://li.quest/v1";
const API_KEY = process.env.LIFI_API_KEY || "";

interface LiFiHeaders {
  [key: string]: string;
}

function getHeaders(): LiFiHeaders {
  const headers: LiFiHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (API_KEY) {
    headers["x-lifi-api-key"] = API_KEY;
  }
  return headers;
}

// --- Types ---

export interface LiFiQuote {
  id: string;
  type: string;
  tool: string;
  action: {
    fromChainId: number;
    toChainId: number;
    fromToken: LiFiToken;
    toToken: LiFiToken;
    fromAmount: string;
    fromAddress: string;
    toAddress: string;
    slippage: number;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
    gasCosts: Array<{
      type: string;
      estimate: string;
      token: LiFiToken;
      amountUSD: string;
    }>;
    feeCosts: Array<{
      name: string;
      percentage: string;
      amountUSD: string;
    }>;
    fromAmountUSD: string;
    toAmountUSD: string;
  };
  transactionRequest?: {
    data: string;
    to: string;
    value: string;
    from: string;
    chainId: number;
    gasLimit: string;
    gasPrice: string;
  };
  includedSteps: Array<{
    type: string;
    tool: string;
    estimate: {
      fromAmount: string;
      toAmount: string;
    };
  }>;
}

export interface LiFiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  logoURI?: string;
  priceUSD?: string;
}

export interface LiFiRoute {
  id: string;
  steps: LiFiQuote[];
  fromAmountUSD: string;
  toAmountUSD: string;
  gasCostUSD: string;
}

// --- API Methods ---

/**
 * Get a swap/bridge quote from Li.Fi
 */
export async function getQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  fromAddress: string;
  slippage?: number;
}): Promise<LiFiQuote> {
  const searchParams = new URLSearchParams({
    fromChain: params.fromChain.toString(),
    toChain: params.toChain.toString(),
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    slippage: (params.slippage || 0.03).toString(), // 3% default
  });

  const res = await fetch(`${LIFI_BASE}/quote?${searchParams}`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Li.Fi quote failed (${res.status}): ${error}`);
  }

  return res.json();
}

/**
 * Get available routes (multiple options for same swap)
 */
export async function getRoutes(params: {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  fromAddress: string;
  slippage?: number;
}): Promise<LiFiRoute[]> {
  const res = await fetch(`${LIFI_BASE}/advanced/routes`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromAmount,
      fromAddress: params.fromAddress,
      options: {
        slippage: params.slippage || 0.03,
        order: "RECOMMENDED",
        allowSwitchChain: true,
      },
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Li.Fi routes failed (${res.status}): ${error}`);
  }

  const data = await res.json();
  return data.routes || [];
}

/**
 * Get supported chains
 */
export async function getChains(): Promise<
  Array<{ id: number; name: string; key: string }>
> {
  const res = await fetch(`${LIFI_BASE}/chains`, { headers: getHeaders() });
  if (!res.ok) throw new Error(`Li.Fi chains failed (${res.status})`);
  const data = await res.json();
  return data.chains || [];
}

/**
 * Get supported tokens on a chain
 */
export async function getTokens(
  chainId: number,
): Promise<Record<string, LiFiToken[]>> {
  const res = await fetch(`${LIFI_BASE}/tokens?chains=${chainId}`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error(`Li.Fi tokens failed (${res.status})`);
  const data = await res.json();
  return data.tokens || {};
}

/**
 * Check transaction status
 */
export async function getStatus(params: {
  txHash: string;
  fromChain: number;
  toChain: number;
  bridge?: string;
}): Promise<{
  status: string;
  substatus?: string;
  receiving?: { txHash: string; chainId: number; amount: string };
}> {
  const searchParams = new URLSearchParams({
    txHash: params.txHash,
    fromChain: params.fromChain.toString(),
    toChain: params.toChain.toString(),
  });
  if (params.bridge) searchParams.set("bridge", params.bridge);

  const res = await fetch(`${LIFI_BASE}/status?${searchParams}`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error(`Li.Fi status failed (${res.status})`);
  return res.json();
}

/**
 * Get token info by symbol or address
 */
export async function findToken(
  chainId: number,
  query: string,
): Promise<LiFiToken | null> {
  const tokens = await getTokens(chainId);
  const chainTokens = tokens[chainId.toString()] || [];

  // Search by symbol (case-insensitive) or address
  const q = query.toLowerCase();
  return (
    chainTokens.find(
      (t) =>
        t.symbol.toLowerCase() === q ||
        t.address.toLowerCase() === q,
    ) || null
  );
}
