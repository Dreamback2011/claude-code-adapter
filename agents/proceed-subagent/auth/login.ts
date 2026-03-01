/**
 * Proceed-Subagent M1 — Login CLI
 *
 * Opens a local OAuth flow for social login, then stores
 * the JWT for Web3Auth wallet reconstruction.
 *
 * Usage:
 *   npx tsx agents/proceed-subagent/auth/login.ts --provider google
 */

import http from "http";
import { URL } from "url";
import open from "open";
import fs from "fs";
import path from "path";
import { connectWithJWT } from "./web3auth-client.js";

// Google OAuth config — set these in .env
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const LOCAL_PORT = 8976;
const REDIRECT_URI = `http://localhost:${LOCAL_PORT}/callback`;

// Storage path
const AUTH_DIR = path.join(process.env.HOME || "~", ".proceed-subagent");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

interface AuthResult {
  idToken: string;
  userId: string;
  email: string;
  provider: string;
  timestamp: string;
}

/**
 * Google OAuth flow via local HTTP server
 */
async function googleLogin(): Promise<AuthResult> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env\n" +
        "Create OAuth credentials at https://console.cloud.google.com/apis/credentials",
    );
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://localhost:${LOCAL_PORT}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          if (!code) {
            res.writeHead(400);
            res.end("No authorization code received");
            reject(new Error("No authorization code"));
            return;
          }

          // Exchange code for tokens
          const tokenRes = await fetch(
            "https://oauth2.googleapis.com/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: "authorization_code",
              }),
            },
          );

          const tokens = (await tokenRes.json()) as any;

          if (!tokens.id_token) {
            res.writeHead(500);
            res.end("Failed to get id_token from Google");
            reject(new Error("No id_token in response"));
            return;
          }

          // Decode JWT to get email (verifierId)
          const payload = JSON.parse(
            Buffer.from(tokens.id_token.split(".")[1], "base64").toString(),
          );

          const result: AuthResult = {
            idToken: tokens.id_token,
            userId: payload.sub, // Google unique user ID
            email: payload.email,
            provider: "google",
            timestamp: new Date().toISOString(),
          };

          // Success page
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: system-ui; text-align: center; padding: 60px;">
              <h1>🔐 Proceed-Subagent Login Successful</h1>
              <p>Logged in as <strong>${payload.email}</strong></p>
              <p>You can close this window.</p>
            </body></html>
          `);

          server.close();
          resolve(result);
        }
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(LOCAL_PORT, () => {
      // Build Google OAuth URL
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      console.log(`\n🔐 Opening Google login in browser...\n`);
      console.log(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);

      open(authUrl.toString()).catch(() => {
        // If 'open' fails, user can copy the URL manually
      });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 2 minutes"));
    }, 120_000);
  });
}

/**
 * Store auth credentials securely
 */
function storeAuth(auth: AuthResult): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  console.log(`✅ Auth stored at ${AUTH_FILE}`);
}

/**
 * Main login flow
 */
async function main() {
  const args = process.argv.slice(2);
  const providerIdx = args.indexOf("--provider");
  const provider = providerIdx >= 0 ? args[providerIdx + 1] : "google";

  console.log(`🔐 Proceed-Subagent Login — Provider: ${provider}`);

  let auth: AuthResult;

  switch (provider) {
    case "google":
      auth = await googleLogin();
      break;
    default:
      console.error(`Unsupported provider: ${provider}`);
      console.error("Supported: google");
      process.exit(1);
  }

  // Store credentials
  storeAuth(auth);

  // Test Web3Auth connection
  console.log("\n🔗 Connecting to Web3Auth...");
  try {
    const session = await connectWithJWT(auth.idToken, auth.userId);
    console.log(`✅ Wallet created: ${session.address}`);
    console.log(`📧 Email: ${auth.email}`);
  } catch (err: any) {
    console.error(`⚠️  Web3Auth connection failed: ${err.message}`);
    console.error("Auth token is stored — Web3Auth may need dashboard configuration.");
    console.error("Required: Create an Auth Connection named '" + (process.env.WEB3AUTH_AUTH_CONNECTION_ID || "proceed-subagent-google") + "' in Web3Auth Dashboard");
  }
}

main().catch((err) => {
  console.error(`❌ Login failed: ${err.message}`);
  process.exit(1);
});
