/**
 * Proceed-Subagent M1 — Web3Auth Single Factor Auth (Node SDK v5)
 *
 * Flow:
 *   1. User authenticates via Google OAuth → gets id_token (JWT)
 *   2. Web3Auth Node SDK uses JWT + authConnectionId to reconstruct MPC private key
 *   3. Private key is used to create an ethers.js Wallet for signing
 *
 * Setup required:
 *   1. Create app at https://dashboard.web3auth.io
 *   2. Create a custom auth connection for Google
 *   3. Set WEB3AUTH_CLIENT_ID and WEB3AUTH_AUTH_CONNECTION_ID in .env
 */

import { Web3Auth } from "@web3auth/node-sdk";
import { CHAIN_NAMESPACES, WEB3AUTH_NETWORK } from "@web3auth/base";
import { CHAINS } from "../utils/chains.js";

// Config from environment
const CLIENT_ID = process.env.WEB3AUTH_CLIENT_ID || "";
const AUTH_CONNECTION_ID = process.env.WEB3AUTH_AUTH_CONNECTION_ID || "proceed-subagent-google";
const NETWORK = (process.env.WEB3AUTH_NETWORK || "sapphire_mainnet") as keyof typeof WEB3AUTH_NETWORK;

export interface Web3AuthSession {
  privateKey: string;
  address: string;
  provider: any;
}

let web3authInstance: Web3Auth | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize Web3Auth Node SDK v5
 */
async function getWeb3Auth(): Promise<Web3Auth> {
  if (web3authInstance && initPromise) {
    await initPromise;
    return web3authInstance;
  }

  if (!CLIENT_ID) {
    throw new Error(
      "WEB3AUTH_CLIENT_ID not set. Get it from https://dashboard.web3auth.io",
    );
  }

  const ethChain = CHAINS.ethereum;

  web3authInstance = new Web3Auth({
    clientId: CLIENT_ID,
    web3AuthNetwork: WEB3AUTH_NETWORK[NETWORK],
    usePnPKey: false,
    chains: [
      {
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: `0x${ethChain.id.toString(16)}`,
        rpcTarget: ethChain.rpcUrl,
        displayName: ethChain.name,
        ticker: ethChain.nativeCurrency.symbol,
        tickerName: ethChain.nativeCurrency.name,
        blockExplorerUrl: ethChain.explorerUrl,
        logo: "",
      },
    ],
  });

  initPromise = web3authInstance.init();
  await initPromise;

  return web3authInstance;
}

/**
 * Connect with an OAuth id_token to get the private key
 *
 * @param idToken - JWT from Google OAuth (or other provider)
 * @param userId - Unique user identifier (e.g., Google sub claim)
 */
export async function connectWithJWT(
  idToken: string,
  userId: string,
): Promise<Web3AuthSession> {
  const web3auth = await getWeb3Auth();

  const result = await web3auth.connect({
    authConnectionId: AUTH_CONNECTION_ID,
    idToken,
    userId,
  });

  if (!result) {
    throw new Error("Web3Auth connection failed — no result returned");
  }

  // For EIP155 chains, the signer is an ethers Wallet with .privateKey
  if (result.chainNamespace === CHAIN_NAMESPACES.EIP155) {
    const wallet = result.signer;
    return {
      privateKey: wallet.privateKey,
      address: wallet.address,
      provider: result.provider,
    };
  }

  // Fallback: try provider request for non-EIP155 chains
  const privateKey = (await result.provider.request({
    method: "eth_private_key",
  })) as string;

  const accounts = (await result.provider.request({
    method: "eth_accounts",
  })) as string[];

  if (!privateKey || !accounts[0]) {
    throw new Error("Failed to derive wallet from Web3Auth");
  }

  return { privateKey, address: accounts[0], provider: result.provider };
}

/**
 * Get a session from stored credentials (for agent use)
 */
export async function connectFromStoredToken(): Promise<Web3AuthSession> {
  const fs = await import("fs");
  const path = await import("path");

  const tokenPath = path.join(
    process.env.HOME || "~",
    ".proceed-subagent",
    "auth.json",
  );

  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `No stored auth found at ${tokenPath}. Run login first:\n` +
        `  npx tsx agents/proceed-subagent/auth/login.ts --provider google`,
    );
  }

  const stored = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));

  if (!stored.idToken || !stored.userId) {
    throw new Error("Stored auth is invalid — missing idToken or userId");
  }

  // Check if token is expired
  try {
    const payload = JSON.parse(
      Buffer.from(stored.idToken.split(".")[1], "base64").toString(),
    );
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      throw new Error(
        "Stored token expired. Please login again:\n" +
          "  npx tsx agents/proceed-subagent/auth/login.ts --provider google",
      );
    }
  } catch (e: any) {
    if (e.message.includes("expired") || e.message.includes("login again")) {
      throw e;
    }
    // If JWT parse fails, try anyway — Web3Auth will reject if invalid
  }

  return connectWithJWT(stored.idToken, stored.userId);
}
