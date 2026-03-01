/**
 * WHOOP Data Fetch CLI
 * Usage: npx tsx agents/whoop/fetch.ts <command>
 *
 * Commands:
 *   recovery  - Recent recovery data (HRV, resting HR, recovery %)
 *   sleep     - Recent sleep records
 *   workout   - Recent workouts
 *   body      - Body measurements
 *   profile   - User profile
 *   cycle     - Physiological cycles (daily strain, calories)
 *   all       - Fetch all data at once (recovery + sleep + workout + cycle + body)
 */

import { whoopFetch } from "./whoop-client";

const command = process.argv[2];

function formatDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

async function main() {
  try {
    switch (command) {
      case "recovery": {
        const data = await whoopFetch("/recovery", {
          start: formatDate(7),
          end: new Date().toISOString(),
          limit: "7",
        }, "v2");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "sleep": {
        const data = await whoopFetch("/activity/sleep", {
          start: formatDate(7),
          end: new Date().toISOString(),
          limit: "7",
        }, "v2");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "workout": {
        const data = await whoopFetch("/activity/workout", {
          start: formatDate(7),
          end: new Date().toISOString(),
          limit: "10",
        }, "v2");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "body": {
        const data = await whoopFetch("/user/measurement/body");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "profile": {
        const data = await whoopFetch("/user/profile/basic");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "cycle": {
        const data = await whoopFetch("/cycle", {
          start: formatDate(7),
          end: new Date().toISOString(),
          limit: "7",
        }, "v2");
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case "all": {
        // Fetch all data at once for comprehensive health report
        const [recovery, sleep, workout, cycle, body] = await Promise.all([
          whoopFetch("/recovery", { start: formatDate(7), end: new Date().toISOString(), limit: "7" }, "v2"),
          whoopFetch("/activity/sleep", { start: formatDate(7), end: new Date().toISOString(), limit: "7" }, "v2"),
          whoopFetch("/activity/workout", { start: formatDate(7), end: new Date().toISOString(), limit: "10" }, "v2"),
          whoopFetch("/cycle", { start: formatDate(7), end: new Date().toISOString(), limit: "7" }, "v2"),
          whoopFetch("/user/measurement/body"),
        ]);
        console.log(JSON.stringify({ recovery, sleep, workout, cycle, body }, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error(
          "Available: recovery, sleep, workout, body, profile, cycle, all"
        );
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
