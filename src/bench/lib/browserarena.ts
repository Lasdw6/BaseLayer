/**
 * Defaults aligned with current BrowserArena `hello-browser` methodology
 * (`https://example.com/`, DOMContentLoaded navigation completion).
 * Set BENCH_BROWSERARENA_PAGE_URL=https://google.com/ to reproduce the
 * historical Google-era BaseLayer rows.
 */
export const DEFAULT_BROWSERARENA_PAGE_URL = "https://example.com/";

export function getBrowserArenaPageUrl(): string {
  const raw = process.env["BENCH_BROWSERARENA_PAGE_URL"]?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_BROWSERARENA_PAGE_URL;
}

/** Playwright `page.goto` waitUntil — default `domcontentloaded` matches BrowserArena `hello-browser`. */
export type BrowserArenaPageGotoWaitUntil =
  | "load"
  | "domcontentloaded"
  | "networkidle";

export function getBrowserArenaPageGotoWaitUntil(): BrowserArenaPageGotoWaitUntil {
  const w = process.env["BENCH_PAGE_GOTO_WAIT_UNTIL"]?.toLowerCase();
  if (
    w === "load" ||
    w === "domcontentloaded" ||
    w === "networkidle"
  ) {
    return w;
  }
  return "domcontentloaded";
}

/** When true, latency/density use the in-repo HTTP bench site (`site.ts`) instead of the BrowserArena URL. */
export function shouldUseLocalBenchSite(): boolean {
  return process.env["BENCH_USE_LOCAL_BENCH_SITE"] === "1";
}

/** `true` when navigation should wait for `window.__baselayerBenchReady` (local bench / data URLs), not for the BrowserArena page URL. */
export function pageNavigationExpectsBenchReadyMarker(pageUrl: string): boolean {
  if (pageUrl.startsWith("data:")) {
    return true;
  }
  try {
    return new URL(pageUrl).href !== new URL(getBrowserArenaPageUrl()).href;
  } catch {
    return true;
  }
}
