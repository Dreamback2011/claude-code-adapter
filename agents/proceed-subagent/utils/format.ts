/**
 * Proceed-Subagent — Output formatting utilities
 */

/**
 * Format USD value with $ prefix and commas
 */
export function formatUSD(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format token amount with appropriate decimals
 */
export function formatTokenAmount(amount: number, decimals = 4): string {
  if (amount === 0) return "0";
  if (amount < 0.0001) return "<0.0001";
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format percentage change with color indicator
 */
export function formatChange(pct: number): string {
  if (pct > 0) return `🟢+${pct.toFixed(2)}%`;
  if (pct < 0) return `🔴${pct.toFixed(2)}%`;
  return "——";
}

/**
 * Shorten address: 0x1234...5678
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Format wei/gwei to readable ETH
 */
export function weiToEth(wei: string | bigint): string {
  const value = Number(BigInt(wei)) / 1e18;
  return formatTokenAmount(value, 6);
}

/**
 * Build a simple ASCII table
 */
export function asciiTable(
  headers: string[],
  rows: string[][],
): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length)),
  );

  const sep = "┼" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┼";
  const topBorder = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const botBorder = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const formatRow = (cells: string[]) =>
    "│" + cells.map((c, i) => ` ${(c || "").padEnd(colWidths[i])} `).join("│") + "│";

  return [
    topBorder,
    formatRow(headers),
    "├" + sep.slice(1, -1) + "┤",
    ...rows.map(formatRow),
    botBorder,
  ].join("\n");
}
