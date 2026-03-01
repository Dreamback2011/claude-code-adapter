/**
 * Proceed-Subagent E1 — Polymarket CLOB API Client
 *
 * Docs: https://docs.polymarket.com/
 * CLOB: https://clob-docs.polymarket.com/
 *
 * Required: Polygon USDC for betting
 * Auth: API Key + EIP-712 signature for order placement
 *
 * NOTE: Polymarket APIs may be geo-restricted. If connecting from
 * restricted regions (e.g., Middle East), a VPN/proxy may be needed.
 */

const CLOB_BASE = "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const FETCH_TIMEOUT = 10_000; // 10s timeout

async function pmFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(
        "Polymarket API timeout — may be geo-restricted from your region.\n" +
          "Try using a VPN or proxy.",
      );
    }
    throw new Error(
      `Polymarket API connection failed: ${err.message}\n` +
        "This may be due to geo-restrictions. Try using a VPN.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- Types ---

export interface Market {
  condition_id: string;
  question_id: string;
  question: string;
  description: string;
  market_slug: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{
    token_id: string;
    outcome: string; // "Yes" or "No"
    price: number;
    winner: boolean;
  }>;
  volume: string;
  liquidity: string;
  category?: string;
  image?: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

export interface Position {
  asset: { token_id: string; outcome: string; condition_id: string };
  size: string;
  avgPrice: string;
  currentPrice: string;
  pnl: string;
  pnlPercent: string;
}

export interface OrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  type: "GTC" | "FOK" | "GTD"; // Good Till Cancel, Fill or Kill, Good Till Date
}

// --- Gamma API (Market Discovery) ---

/**
 * Search markets by query
 */
export async function searchMarkets(query: string): Promise<Market[]> {
  const res = await pmFetch(
    `${GAMMA_BASE}/markets?${new URLSearchParams({
      closed: "false",
      active: "true",
      _limit: "20",
      _sort: "volume:desc",
      question_contains: query,
    })}`,
  );
  if (!res.ok) throw new Error(`Polymarket search failed (${res.status})`);
  return res.json();
}

/**
 * Get trending/popular markets
 */
export async function getTrendingMarkets(limit = 20): Promise<Market[]> {
  const res = await pmFetch(
    `${GAMMA_BASE}/markets?${new URLSearchParams({
      closed: "false",
      active: "true",
      _limit: limit.toString(),
      _sort: "volume:desc",
    })}`,
  );
  if (!res.ok) throw new Error(`Polymarket trending failed (${res.status})`);
  return res.json();
}

/**
 * Get a single market by condition_id or slug
 */
export async function getMarket(idOrSlug: string): Promise<Market> {
  const res = await pmFetch(`${GAMMA_BASE}/markets/${idOrSlug}`);
  if (!res.ok) throw new Error(`Market not found: ${idOrSlug}`);
  return res.json();
}

// --- CLOB API (Trading) ---

/**
 * Get order book for a token
 */
export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await pmFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`Order book failed (${res.status})`);
  return res.json();
}

/**
 * Get market midpoint price
 */
export async function getMidpoint(tokenId: string): Promise<number> {
  const res = await pmFetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`Midpoint failed (${res.status})`);
  const data = await res.json();
  return parseFloat(data.mid);
}

/**
 * Get best bid/ask spread
 */
export async function getSpread(tokenId: string): Promise<{
  bid: number;
  ask: number;
  spread: number;
}> {
  const book = await getOrderBook(tokenId);
  const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
  const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
  return {
    bid: bestBid,
    ask: bestAsk,
    spread: bestAsk - bestBid,
  };
}

/**
 * Place an order (requires API key + wallet signature)
 *
 * NOTE: Full order placement requires:
 * 1. Polymarket API key (from account settings)
 * 2. EIP-712 typed data signature from wallet
 * 3. Polygon USDC approval to CTF Exchange contract
 *
 * This is a placeholder — full implementation needs @polymarket/clob-client
 */
export async function placeOrder(
  apiKey: string,
  _apiSecret: string,
  _params: OrderParams,
): Promise<{ orderId: string; status: string }> {
  // TODO: Implement with @polymarket/clob-client SDK
  // The SDK handles EIP-712 signing and order construction
  throw new Error(
    "Order placement requires @polymarket/clob-client SDK integration.\n" +
      "Install: npm install @polymarket/clob-client\n" +
      "Requires: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE",
  );
}
