/**
 * Proceed-Subagent E2 — Hyperliquid API Client
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 *
 * Hyperliquid uses its own L1 chain.
 * Info endpoints: POST https://api.hyperliquid.xyz/info
 * Exchange endpoints: POST https://api.hyperliquid.xyz/exchange (requires wallet sig)
 */

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_EXCHANGE = "https://api.hyperliquid.xyz/exchange";

// --- Types ---

export interface HLMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated: boolean;
  }>;
}

export interface HLAssetInfo {
  name: string;
  markPx: string;
  midPx: string;
  oraclePx: string;
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  prevDayPx: string;
  premium: string;
}

export interface HLPosition {
  coin: string;
  szi: string; // signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  leverage: {
    type: string;
    value: number;
  };
  liquidationPx: string | null;
  marginUsed: string;
}

export interface HLUserState {
  assetPositions: Array<{
    position: HLPosition;
    type: string;
  }>;
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
}

export interface HLOrderBook {
  coin: string;
  levels: Array<Array<{ px: string; sz: string; n: number }>>;
  time: number;
}

export interface HLFundingHistory {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

// --- Info API (no auth needed) ---

async function infoPost<T>(type: string, payload?: any): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hyperliquid info error (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Get all perpetual contract metadata
 */
export async function getMeta(): Promise<HLMeta> {
  return infoPost<HLMeta>("meta");
}

/**
 * Get all asset mid prices and info
 */
export async function getAllMids(): Promise<Record<string, string>> {
  return infoPost<Record<string, string>>("allMids");
}

/**
 * Get detailed market info for all assets
 */
export async function getMetaAndAssetCtxs(): Promise<[HLMeta, HLAssetInfo[]]> {
  return infoPost<[HLMeta, HLAssetInfo[]]>("metaAndAssetCtxs");
}

/**
 * Get user's account state (positions, margin, PnL)
 */
export async function getUserState(address: string): Promise<HLUserState> {
  return infoPost<HLUserState>("clearinghouseState", { user: address });
}

/**
 * Get order book for a specific asset
 */
export async function getL2Book(coin: string): Promise<HLOrderBook> {
  return infoPost<HLOrderBook>("l2Book", { coin });
}

/**
 * Get funding rate history
 */
export async function getFundingHistory(
  coin: string,
  startTime?: number,
): Promise<HLFundingHistory[]> {
  return infoPost<HLFundingHistory[]>("fundingHistory", {
    coin,
    startTime: startTime || Date.now() - 7 * 24 * 60 * 60 * 1000, // Last 7 days
  });
}

/**
 * Get user's open orders
 */
export async function getUserOpenOrders(
  address: string,
): Promise<
  Array<{
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
  }>
> {
  return infoPost("openOrders", { user: address });
}

/**
 * Get user's trade fills
 */
export async function getUserFills(
  address: string,
): Promise<
  Array<{
    coin: string;
    side: string;
    px: string;
    sz: string;
    time: number;
    fee: string;
    oid: number;
  }>
> {
  return infoPost("userFills", { user: address });
}

// --- Exchange API (requires wallet signature) ---
// NOTE: Order placement requires EIP-712 typed data signing
// Full implementation needs ethers.js wallet integration

/**
 * Place an order (placeholder — needs wallet signing)
 *
 * Hyperliquid orders require:
 * 1. Construct order action
 * 2. Sign with EIP-712 typed data
 * 3. POST to /exchange
 */
export async function placeOrder(_params: {
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  orderType: "Limit" | "Market";
  reduceOnly?: boolean;
}): Promise<any> {
  throw new Error(
    "Order placement requires wallet signature integration.\n" +
      "Use the Hyperliquid SDK or sign EIP-712 typed data with the Proceed-Subagent wallet.",
  );
}
