/**
 * Proceed-Subagent M1 — Session management
 *
 * Handles stored auth token lifecycle:
 * - Read/write auth credentials
 * - Token expiry checks
 * - Session status
 */

import fs from "fs";
import path from "path";

const AUTH_DIR = path.join(process.env.HOME || "~", ".proceed-subagent");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

export interface StoredAuth {
  idToken: string;
  verifierId: string;
  email: string;
  provider: string;
  timestamp: string;
}

/**
 * Check if a stored auth session exists and is valid
 */
export function getSessionStatus(): {
  exists: boolean;
  valid: boolean;
  email?: string;
  provider?: string;
  expiresAt?: Date;
} {
  if (!fs.existsSync(AUTH_FILE)) {
    return { exists: false, valid: false };
  }

  try {
    const stored: StoredAuth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));

    // Decode JWT expiry
    const payload = JSON.parse(
      Buffer.from(stored.idToken.split(".")[1], "base64").toString(),
    );

    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : undefined;
    const valid = !expiresAt || expiresAt > new Date();

    return {
      exists: true,
      valid,
      email: stored.email,
      provider: stored.provider,
      expiresAt,
    };
  } catch {
    return { exists: true, valid: false };
  }
}

/**
 * Read stored auth
 */
export function readStoredAuth(): StoredAuth | null {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Clear stored session (logout)
 */
export function clearSession(): void {
  if (fs.existsSync(AUTH_FILE)) {
    fs.unlinkSync(AUTH_FILE);
    console.log("✅ Session cleared");
  } else {
    console.log("No active session");
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("session.ts")) {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    const status = getSessionStatus();
    console.log("\n🔐 Proceed-Subagent Session Status");
    console.log(`  Exists: ${status.exists}`);
    console.log(`  Valid:  ${status.valid}`);
    if (status.email) console.log(`  Email:  ${status.email}`);
    if (status.provider) console.log(`  Provider: ${status.provider}`);
    if (status.expiresAt) console.log(`  Expires: ${status.expiresAt.toISOString()}`);
  } else if (args.includes("--logout")) {
    clearSession();
  } else {
    console.log("Usage:");
    console.log("  --status   Show session info");
    console.log("  --logout   Clear stored session");
  }
}
