/**
 * WHOOP API Client
 * Handles authenticated requests with automatic token refresh
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const TOKEN_FILE = join(fileURLToPath(import.meta.url), "..", ".tokens.json");
const BASE_URL_V1 = "https://api.prod.whoop.com/developer/v1";
const BASE_URL_V2 = "https://api.prod.whoop.com/developer/v2";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  obtained_at: string;
  expires_at: string;
}

function loadTokens(): TokenData {
  if (!existsSync(TOKEN_FILE)) {
    throw new Error(
      "No tokens found. Run OAuth flow first: npx tsx agents/whoop/oauth.ts"
    );
  }
  return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
}

function saveTokens(tokens: TokenData): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function isTokenExpired(tokens: TokenData): boolean {
  const expiresAt = new Date(tokens.expires_at).getTime();
  // Refresh 5 minutes before expiry
  return Date.now() > expiresAt - 5 * 60 * 1000;
}

async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET in .env");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status} ${errText}. Re-run OAuth: npx tsx agents/whoop/oauth.ts`
    );
  }

  const newTokens = await response.json();

  const tokenData: TokenData = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token || tokens.refresh_token,
    expires_in: newTokens.expires_in,
    token_type: newTokens.token_type,
    scope: newTokens.scope || tokens.scope,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(
      Date.now() + newTokens.expires_in * 1000
    ).toISOString(),
  };

  saveTokens(tokenData);
  return tokenData;
}

export async function whoopFetch(
  endpoint: string,
  params?: Record<string, string>,
  apiVersion: "v1" | "v2" = "v1"
): Promise<any> {
  let tokens = loadTokens();

  // Auto-refresh if expired
  if (isTokenExpired(tokens)) {
    console.error("[WHOOP] Token expired, refreshing...");
    tokens = await refreshAccessToken(tokens);
    console.error("[WHOOP] Token refreshed successfully");
  }

  const baseUrl = apiVersion === "v2" ? BASE_URL_V2 : BASE_URL_V1;
  const url = new URL(`${baseUrl}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  if (response.status === 401) {
    // Try refresh once more
    console.error("[WHOOP] 401 received, attempting token refresh...");
    tokens = await refreshAccessToken(tokens);

    const retryResponse = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (!retryResponse.ok) {
      throw new Error(
        `WHOOP API error: ${retryResponse.status} ${await retryResponse.text()}`
      );
    }

    return retryResponse.json();
  }

  if (!response.ok) {
    throw new Error(
      `WHOOP API error: ${response.status} ${await response.text()}`
    );
  }

  return response.json();
}
