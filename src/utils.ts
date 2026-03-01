/**
 * Shared utility functions used by server.ts and task-runner.ts.
 */

/**
 * Check if agent output is empty or an error placeholder.
 * These indicate the agent failed to produce a real response.
 */
export function isEmptyResponse(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  if (!trimmed || trimmed.length < 3) return true;
  const badPatterns = [
    "(no response)", "no response", "no_reply", "no reply",
    "no response content", "[claudecodeagent error",
  ];
  return badPatterns.some((p) => trimmed.startsWith(p));
}

/**
 * Extract raw text from an AgentSquad response output.
 */
export function extractOutput(output: any): string {
  if (typeof output === "string") return output;
  if (output instanceof Object && "getAccumulatedData" in output) {
    return output.getAccumulatedData();
  }
  return String(output);
}
