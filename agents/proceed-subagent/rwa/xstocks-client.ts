/**
 * Proceed-Subagent E3 — Xstocks Client (Tokenized Stocks)
 *
 * Xstocks provides tokenized stock tokens:
 * - xAAPL, xTSLA, xGOOG, xAMZN, etc.
 * - Trade 24/7 on-chain
 * - Backed by real stock custody
 *
 * NOTE: Xstocks API details may change — this is based on public documentation.
 */

const XSTOCKS_API = process.env.XSTOCKS_API_BASE || "https://api.xstocks.fi";

export interface XStock {
  symbol: string;       // e.g. "xAAPL"
  underlying: string;   // e.g. "AAPL"
  name: string;
  price: string;
  change24h: string;
  marketCap: string;
  chainId: string;
  contractAddress: string;
}

export interface XStockPortfolio {
  symbol: string;
  balance: string;
  valueUSD: string;
  avgCost: string;
  pnl: string;
}

/**
 * Get all available xStocks
 */
export async function getAvailableStocks(): Promise<XStock[]> {
  try {
    const res = await fetch(`${XSTOCKS_API}/v1/stocks`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Xstocks API error (${res.status})`);
    const data = await res.json() as any;
    return data.stocks || data.data || [];
  } catch {
    // Fallback to known stocks if API is unavailable
    return getKnownStocks();
  }
}

/**
 * Get price for a specific xStock
 */
export async function getStockPrice(symbol: string): Promise<XStock | null> {
  const stocks = await getAvailableStocks();
  return stocks.find(
    (s) =>
      s.symbol.toLowerCase() === symbol.toLowerCase() ||
      s.underlying?.toLowerCase() === symbol.toLowerCase(),
  ) || null;
}

/**
 * Known xStocks listing (fallback)
 */
function getKnownStocks(): XStock[] {
  return [
    {
      symbol: "xAAPL",
      underlying: "AAPL",
      name: "Apple Inc.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
    {
      symbol: "xTSLA",
      underlying: "TSLA",
      name: "Tesla Inc.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
    {
      symbol: "xGOOG",
      underlying: "GOOG",
      name: "Alphabet Inc.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
    {
      symbol: "xAMZN",
      underlying: "AMZN",
      name: "Amazon.com Inc.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
    {
      symbol: "xMSFT",
      underlying: "MSFT",
      name: "Microsoft Corp.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
    {
      symbol: "xNVDA",
      underlying: "NVDA",
      name: "NVIDIA Corp.",
      price: "0",
      change24h: "0",
      marketCap: "0",
      chainId: "1",
      contractAddress: "",
    },
  ];
}
