/**
 * WHOOP OAuth2 Authorization Flow
 * Run once to get access tokens: npx tsx agents/whoop/oauth.ts
 *
 * Flow:
 * 1. Opens browser to WHOOP authorization page
 * 2. User logs in and authorizes
 * 3. WHOOP redirects to local callback server
 * 4. Script exchanges code for tokens
 * 5. Tokens saved to agents/whoop/.tokens.json
 */

import http from "http";
import { URL } from "url";
import { writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/oauth/callback";
const TOKEN_FILE = join(fileURLToPath(import.meta.url), "..", ".tokens.json");

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

const SCOPES = [
  "read:recovery",
  "read:sleep",
  "read:workout",
  "read:cycles",
  "read:body_measurement",
  "read:profile",
  "offline",
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET in .env");
  process.exit(1);
}

// Build authorization URL
const authUrl = `${AUTH_URL}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=whoopset`;

console.log("\n⌚ WHOOP OAuth2 Setup\n");
console.log("Opening browser for authorization...\n");
console.log("If browser doesn't open, visit this URL manually:");
console.log(authUrl);
console.log("");

// Open browser
const openCmd =
  process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "start"
      : "xdg-open";
exec(`${openCmd} "${authUrl}"`);

// Start local callback server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:3000`);

  if (url.pathname !== "/oauth/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    console.error(`Authorization error: ${error}`);
    res.writeHead(400);
    res.end(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end("Missing authorization code");
    return;
  }

  console.log("Received authorization code, exchanging for tokens...");

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errText}`);
    }

    const tokens = await tokenResponse.json();

    // Save tokens
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

    console.log("\n✅ Tokens saved to agents/whoop/.tokens.json");
    console.log(`   Access token expires: ${tokenData.expires_at}`);
    console.log("   Refresh token: saved (used for automatic renewal)\n");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>✅ WHOOP Authorization Complete!</h1>
          <p>Tokens have been saved. You can close this window.</p>
          <p style="color: #666;">ClawdBot can now access your WHOOP data.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.writeHead(500);
    res.end(`Token exchange failed: ${err}`);
  }

  // Shutdown after a short delay
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 1000);
});

server.listen(3000, () => {
  console.log("Callback server listening on http://localhost:3000\n");
  console.log("Waiting for authorization...\n");
});
