import type { BenchFailureClass } from "./types.js";

const ADMISSION_HINTS = /no-admit|no admit|capacity|429|503|admission|reject|ECONNRESET/i;
const TIMEOUT_HINTS = /timeout|timed out|ETIMEDOUT|AbortError|deadline/i;
const NETWORK_HINTS = /ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|fetch failed|network|socket/i;
const HTTP_CLIENT_HINTS = /\b4\d\d\b/;
const HTTP_SERVER_HINTS = /\b5\d\d\b/;
const CRASH_HINTS = /crash|Target closed|Browser closed|Session closed|disconnected/i;

export function classifyBenchFailure(message: string): BenchFailureClass {
  const m = message.toLowerCase();
  if (TIMEOUT_HINTS.test(m)) {
    return "timeout";
  }
  if (ADMISSION_HINTS.test(m)) {
    return "admission";
  }
  if (CRASH_HINTS.test(m)) {
    return "browser_crash";
  }
  if (HTTP_SERVER_HINTS.test(m)) {
    return "http_server";
  }
  if (HTTP_CLIENT_HINTS.test(m)) {
    return "http_client";
  }
  if (NETWORK_HINTS.test(m)) {
    return "network";
  }
  return "unknown";
}

export function mergeFailureTaxonomy(
  existing: Record<string, number> | undefined,
  classification: BenchFailureClass,
): Record<string, number> {
  const next = { ...existing };
  next[classification] = (next[classification] ?? 0) + 1;
  return next;
}
