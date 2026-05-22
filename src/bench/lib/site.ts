import http from "node:http";
import { AddressInfo } from "node:net";

interface BenchVariant {
  title: string;
  sectionCount: number;
  cardsPerSection: number;
  workloadLoops: number;
  payloadRepeat: number;
}

const variants: Record<string, BenchVariant> = {
  "1": {
    title: "BaseLayer Bench 1",
    sectionCount: 4,
    cardsPerSection: 18,
    workloadLoops: 45_000,
    payloadRepeat: 80,
  },
  "2": {
    title: "BaseLayer Bench 2",
    sectionCount: 6,
    cardsPerSection: 22,
    workloadLoops: 65_000,
    payloadRepeat: 120,
  },
  "3": {
    title: "BaseLayer Bench 3",
    sectionCount: 8,
    cardsPerSection: 26,
    workloadLoops: 90_000,
    payloadRepeat: 160,
  },
};

export interface BenchSite {
  baseUrl: string;
  localBaseUrl: string;
  urlForVariant: (variant: keyof typeof variants | string) => string;
  close: () => Promise<void>;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function renderHtml(variantId: string): string {
  const variant = variants[variantId] ?? variants["1"];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(variant.title)}</title>
    <link rel="stylesheet" href="/bench.css?v=${variantId}" />
  </head>
  <body>
    <main id="app">
      <header class="hero">
        <p class="eyebrow">Boost Browser Host Benchmark</p>
        <h1>${escapeHtml(variant.title)}</h1>
        <p class="summary">Deterministic local benchmark page with DOM build, JS work, and resource fetches.</p>
      </header>
      <section id="content" class="content"></section>
      <footer class="footer">variant=${variantId}</footer>
    </main>
    <script src="/bench.js?v=${variantId}" defer></script>
  </body>
</html>`;
}

function renderCss(): string {
  return `
:root {
  color-scheme: light;
  --bg: #f4f1ea;
  --ink: #172029;
  --muted: #5d676f;
  --card: #fffdf7;
  --line: #d6d0c3;
  --accent: #0f766e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  background: linear-gradient(180deg, #f7f4ed 0%, #ece7dc 100%);
  color: var(--ink);
}
#app {
  width: min(1100px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 32px 0 64px;
}
.hero {
  display: grid;
  gap: 8px;
  margin-bottom: 24px;
}
.eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--accent);
  font-size: 12px;
}
.hero h1 {
  margin: 0;
  font-size: clamp(30px, 4vw, 52px);
  line-height: 0.95;
}
.summary, .footer {
  color: var(--muted);
  font-size: 14px;
}
.content {
  display: grid;
  gap: 16px;
}
.section {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255,255,255,0.72);
  box-shadow: 0 10px 30px rgba(23, 32, 41, 0.06);
}
.section-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;
}
.section-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.card {
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
  background: var(--card);
}
.card strong {
  display: block;
  margin-bottom: 6px;
}
.metric {
  color: var(--accent);
}
body[data-bench-ready="1"] .hero {
  transform: translateY(0);
  opacity: 1;
}
`;
}

function renderScript(variantId: string): string {
  const variant = variants[variantId] ?? variants["1"];

  return `
(() => {
  const content = document.getElementById("content");
  if (!content) {
    return;
  }

  const payload = "bench-payload-${variantId}-".repeat(${variant.payloadRepeat});
  const sections = ${variant.sectionCount};
  const cardsPerSection = ${variant.cardsPerSection};
  let checksum = 0;

  function hash(input) {
    let value = 0;
    for (let i = 0; i < input.length; i += 1) {
      value = (value * 33 + input.charCodeAt(i)) % 2147483647;
    }
    return value;
  }

  for (let sectionIndex = 0; sectionIndex < sections; sectionIndex += 1) {
    const section = document.createElement("section");
    section.className = "section";

    const header = document.createElement("div");
    header.className = "section-header";

    const title = document.createElement("h2");
    title.textContent = "Section " + (sectionIndex + 1);
    const meta = document.createElement("span");
    meta.className = "metric";
    meta.textContent = "cards=" + cardsPerSection;
    header.append(title, meta);

    const grid = document.createElement("div");
    grid.className = "section-grid";

    for (let cardIndex = 0; cardIndex < cardsPerSection; cardIndex += 1) {
      const card = document.createElement("article");
      card.className = "card";
      const heading = document.createElement("strong");
      heading.textContent = "Card " + (sectionIndex + 1) + "." + (cardIndex + 1);
      const copy = document.createElement("p");
      copy.textContent = payload.slice(0, 140 + ((cardIndex + sectionIndex) % 24));
      const stat = document.createElement("span");
      stat.className = "metric";
      stat.textContent = "hash=" + hash(copy.textContent + heading.textContent);
      card.append(heading, copy, stat);
      grid.append(card);
      checksum = (checksum + hash(copy.textContent)) % 2147483647;
    }

    section.append(header, grid);
    content.append(section);
  }

  for (let index = 0; index < ${variant.workloadLoops}; index += 1) {
    checksum = (checksum + ((index * 17) % 97)) % 2147483647;
  }

  const footer = document.querySelector(".footer");
  if (footer) {
    footer.textContent = "variant=${variantId} checksum=" + checksum;
  }

  window.__baselayerBenchReady = true;
  document.body.dataset.benchReady = "1";
})();
`;
}

export async function startBenchSite(
  requestedPort = Number.parseInt(process.env["BENCH_SITE_PORT"] ?? "0", 10),
): Promise<BenchSite> {
  const publicHost = process.env["BENCH_SITE_PUBLIC_HOST"] ?? "host.docker.internal";
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const variantId = url.searchParams.get("v") ?? "1";

    if (url.pathname === "/bench.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(renderCss());
      return;
    }

    if (url.pathname === "/bench.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      response.end(renderScript(variantId));
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHtml(variantId));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Benchmark site failed to bind a TCP port.");
  }

  const port = (address as AddressInfo).port;
  const localBaseUrl = `http://127.0.0.1:${port}`;
  const baseUrl = `http://${publicHost}:${port}`;
  return {
    baseUrl,
    localBaseUrl,
    urlForVariant: (variant) => `${baseUrl}/?v=${encodeURIComponent(String(variant))}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
