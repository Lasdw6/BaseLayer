import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Browser, Page } from "playwright-core";

import {
  connectBrowser,
  createSession,
  deleteSession,
  startProfileBenchmark,
  stopProfileBenchmark,
} from "./lib/harness.js";
import { getSupportedProfile } from "./lib/profiles.js";
import type { SupportedProfileId } from "./lib/types.js";

interface SiteRunResult {
  site: string;
  ok: boolean;
  classification: "success" | "loaded" | "challenge" | "blocked";
  createMs?: number;
  actionMs?: number;
  url?: string;
  title?: string;
  snippet?: string;
  error?: string;
}

const profileId = (process.env["REAL_USAGE_PROFILE_ID"] ??
  "BaseLayer-Mew-firecracker-headless-shell") as SupportedProfileId;
const reportDir = process.env["REAL_USAGE_REPORT_DIR"] ?? path.join(process.cwd(), "data", "benchmarks");
const reportPath =
  process.env["REAL_USAGE_REPORT_PATH"] ??
  path.join(reportDir, `real-usage-${profileId}.json`);

async function acceptGoogleConsent(page: Page): Promise<void> {
  const selectors = [
    'button:has-text("I agree")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'input[type="submit"][value="I agree"]',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0) {
      await button.click({ timeout: 2_000 }).catch(() => undefined);
      return;
    }
  }
}

async function classifyGoogle(page: Page): Promise<SiteRunResult["classification"]> {
  const content = (await page.content().catch(() => "")).toLowerCase();
  const title = (await page.title().catch(() => "")).toLowerCase();
  if (
    content.includes("unusual traffic") ||
    content.includes("our systems have detected") ||
    content.includes("recaptcha") ||
    title.includes("sorry")
  ) {
    return "challenge";
  }
  const searchResults = page.locator("#search, [data-async-context], [role=\"main\"]").first();
  if ((await searchResults.count()) > 0) {
    return "success";
  }
  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  if ((await searchBox.count()) > 0 || title.includes("google")) {
    return "loaded";
  }
  return "blocked";
}

async function runGoogle(page: Page): Promise<SiteRunResult["classification"]> {
  await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded" });
  await acceptGoogleConsent(page);
  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.waitFor({ timeout: 15_000 });
  await searchBox.fill("firecracker microvm");
  await searchBox.press("Enter");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  return classifyGoogle(page);
}

async function runWikipedia(page: Page): Promise<SiteRunResult["classification"]> {
  await page.goto("https://www.wikipedia.org/", { waitUntil: "domcontentloaded" });
  const searchBox = page.locator('input[name="search"]').first();
  await searchBox.waitFor({ timeout: 15_000 });
  await searchBox.fill("Firecracker");
  await searchBox.press("Enter");
  await page.locator("#firstHeading").waitFor({ timeout: 15_000 });
  return "success";
}

async function classifyReddit(page: Page): Promise<SiteRunResult["classification"]> {
  const content = (await page.content().catch(() => "")).toLowerCase();
  const title = (await page.title().catch(() => "")).toLowerCase();
  const posts = page.locator('shreddit-post, article, [data-testid="post-container"]').first();
  if ((await posts.count()) > 0) {
    return "success";
  }
  if (
    content.includes("continue with email") ||
    content.includes("log in") ||
    content.includes("open in app") ||
    content.includes("reddit") ||
    title.includes("reddit")
  ) {
    return "loaded";
  }
  if (content.includes("blocked") || content.includes("access denied")) {
    return "challenge";
  }
  return "blocked";
}

async function runReddit(page: Page): Promise<SiteRunResult["classification"]> {
  await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  return classifyReddit(page);
}

async function runHackerNews(page: Page): Promise<SiteRunResult["classification"]> {
  await page.goto("https://news.ycombinator.com/", { waitUntil: "domcontentloaded" });
  await page.locator(".athing").first().waitFor({ timeout: 15_000 });
  return "success";
}

const siteRunners: Array<{
  site: string;
  run(page: Page): Promise<SiteRunResult["classification"]>;
}> = [
  { site: "google", run: runGoogle },
  { site: "wikipedia", run: runWikipedia },
  { site: "reddit", run: runReddit },
  { site: "hackernews", run: runHackerNews },
];

async function runSite(
  controlPlaneUrl: string,
  site: string,
  run: (page: Page) => Promise<SiteRunResult["classification"]>,
): Promise<SiteRunResult> {
  const { session, createMs } = await createSession(controlPlaneUrl);
  let browser: Browser | undefined;
  const started = performance.now();

  try {
    browser = await connectBrowser(session.debugHttpUrl ?? session.playwrightUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const classification = await run(page);
    const snippet = (await page.content().catch(() => "")).slice(0, 500);
    return {
      site,
      ok: classification !== "blocked",
      classification,
      createMs,
      actionMs: performance.now() - started,
      url: page.url(),
      title: await page.title().catch(() => undefined),
      snippet,
    };
  } catch (error) {
    return {
      site,
      ok: false,
      classification: "blocked",
      createMs,
      actionMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await deleteSession(controlPlaneUrl, session.sessionId).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const profile = getSupportedProfile(profileId);
  const context = await startProfileBenchmark(profile, 3900);

  try {
    const results: SiteRunResult[] = [];
    for (const site of siteRunners) {
      results.push(await runSite(context.controlPlaneUrl, site.site, site.run));
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          benchmark: "real-usage",
          profileId,
          reportPath,
          results,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ benchmark: "real-usage", profileId, results }, null, 2));
  } finally {
    await stopProfileBenchmark(context);
  }
}

await main();
