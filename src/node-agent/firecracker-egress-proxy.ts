import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { Duplex } from "node:stream";
import { URL } from "node:url";

function parseArgs(): {
  listenHost: string;
  listenPort: number;
  upstreamProxyUrl?: string;
  dnsServers: string[];
} {
  const listenHost = process.argv[2] ?? process.env["FIRECRACKER_PROXY_LISTEN_HOST"] ?? "172.22.0.1";
  const listenPort = Number.parseInt(
    process.argv[3] ?? process.env["FIRECRACKER_PROXY_LISTEN_PORT"] ?? "3128",
    10,
  );
  const upstreamProxyUrl = process.argv[4] ?? process.env["FIRECRACKER_UPSTREAM_PROXY_URL"];
  const dnsServers = (process.env["FIRECRACKER_PROXY_DNS_SERVERS"] ?? "1.1.1.1,8.8.8.8")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return {
    listenHost,
    listenPort: Number.isFinite(listenPort) ? listenPort : 3128,
    upstreamProxyUrl: upstreamProxyUrl || undefined,
    dnsServers,
  };
}

const customResolver = new dns.promises.Resolver();

function configureResolver(servers: string[]): void {
  if (servers.length > 0) {
    customResolver.setServers(servers);
  }
}

async function resolveAddress(host: string): Promise<string> {
  if (net.isIP(host)) {
    return host;
  }

  const [ipv4] = await customResolver.resolve4(host);
  if (ipv4) {
    return ipv4;
  }

  const [ipv6] = await customResolver.resolve6(host);
  if (ipv6) {
    return ipv6;
  }

  throw new Error(`DNS resolution returned no address for ${host}`);
}

function lookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  void (async () => {
    try {
      if (net.isIP(hostname)) {
        callback(null, hostname, net.isIP(hostname));
        return;
      }

      const family = typeof options === "object" && "family" in options ? options.family ?? 0 : 0;
      if (family === 6) {
        const [address] = await customResolver.resolve6(hostname);
        callback(null, address ?? "", 6);
        return;
      }

      if (family === 4 || family === 0) {
        const [address] = await customResolver.resolve4(hostname);
        if (address) {
          callback(null, address, 4);
          return;
        }
      }

      const [address] = await customResolver.resolve6(hostname);
      callback(null, address ?? "", 6);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, "");
    }
  })();
}

function logProxy(message: string, details?: Record<string, unknown>): void {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[firecracker-egress-proxy] ${message}${payload}\n`);
}

function proxyAuthHeader(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username) {
    return undefined;
  }

  const decoded = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(decoded, "utf8").toString("base64")}`;
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const sanitized: http.OutgoingHttpHeaders = { ...headers };
  delete sanitized["proxy-connection"];
  delete sanitized["proxy-authenticate"];
  delete sanitized["proxy-authorization"];
  delete sanitized["connection"];
  return sanitized;
}

function normalizeRequestUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? "");
  } catch {
    const host = req.headers.host;
    if (!host) {
      throw new Error("Request is missing host header.");
    }
    return new URL(`http://${host}${req.url ?? "/"}`);
  }
}

function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamProxyUrl?: string,
): void {
  const targetUrl = normalizeRequestUrl(req);
  logProxy("http-request", {
    method: req.method,
    target: targetUrl.toString(),
    upstreamProxyUrl: upstreamProxyUrl ?? null,
  });
  const headers = sanitizeHeaders(req.headers);

  const requestOptions: http.RequestOptions = upstreamProxyUrl
    ? (() => {
        const proxyUrl = new URL(upstreamProxyUrl);
        const auth = proxyAuthHeader(proxyUrl);
        return {
          host: proxyUrl.hostname,
          port: proxyUrl.port ? Number.parseInt(proxyUrl.port, 10) : 80,
          method: req.method,
          path: targetUrl.toString(),
          headers: auth ? { ...headers, "Proxy-Authorization": auth } : headers,
          lookup,
        };
      })()
    : {
        protocol: targetUrl.protocol,
        host: targetUrl.hostname,
        port: targetUrl.port
          ? Number.parseInt(targetUrl.port, 10)
          : targetUrl.protocol === "https:"
            ? 443
          : 80,
        method: req.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        lookup,
      };

  const requestImpl = upstreamProxyUrl
    ? http.request
    : targetUrl.protocol === "https:"
      ? https.request
      : http.request;

  const outbound = requestImpl(requestOptions, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  outbound.on("error", (error) => {
    logProxy("http-request-failed", {
      method: req.method,
      target: targetUrl.toString(),
      error: error.message,
    });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`proxy request failed: ${error.message}`);
  });

  req.pipe(outbound);
}

function handleConnect(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  upstreamProxyUrl?: string,
): void {
  const target = req.url ?? "";
  const [host, portRaw] = target.split(":");
  const port = Number.parseInt(portRaw ?? "443", 10);
  logProxy("connect-request", {
    target,
    upstreamProxyUrl: upstreamProxyUrl ?? null,
  });
  if (!host || !Number.isFinite(port)) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const connectDirect = (): void => {
    void (async () => {
      try {
        const address = await resolveAddress(host);
        const upstream = net.connect({ host: address, port }, () => {
          logProxy("connect-direct-established", {
            target: `${host}:${port}`,
            resolvedAddress: address,
          });
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });

        upstream.on("error", (error) => {
          logProxy("connect-direct-failed", {
            target: `${host}:${port}`,
            error: error.message,
          });
          if (!clientSocket.destroyed) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
          clientSocket.destroy();
        });
        clientSocket.on("error", () => upstream.destroy());
      } catch (error) {
        logProxy("resolve-direct-failed", {
          target: `${host}:${port}`,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
        clientSocket.destroy();
      }
    })();
  };

  if (!upstreamProxyUrl) {
    connectDirect();
    return;
  }

  const proxyUrl = new URL(upstreamProxyUrl);
  void (async () => {
    try {
      const proxyAddress = await resolveAddress(proxyUrl.hostname);
      const proxySocket = net.connect(
        {
          host: proxyAddress,
          port: proxyUrl.port ? Number.parseInt(proxyUrl.port, 10) : 80,
        },
        () => {
          logProxy("connect-upstream-connected", {
            target: `${host}:${port}`,
            upstreamProxyUrl,
            resolvedProxyAddress: proxyAddress,
          });
          const auth = proxyAuthHeader(proxyUrl);
          const requestLines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
          if (auth) {
            requestLines.push(`Proxy-Authorization: ${auth}`);
          }
          proxySocket.write(`${requestLines.join("\r\n")}\r\n\r\n`);
        },
      );

      let response = Buffer.alloc(0);
      let established = false;
      proxySocket.on("data", (chunk) => {
        if (established) {
          return;
        }
        response = Buffer.concat([response, chunk]);
        const separator = response.indexOf(Buffer.from("\r\n\r\n"));
        if (separator < 0) {
          return;
        }
        const header = response.subarray(0, separator).toString("utf8");
        logProxy("connect-upstream-response", {
          target: `${host}:${port}`,
          upstreamProxyUrl,
          header,
        });
        if (!header.startsWith("HTTP/1.1 200") && !header.startsWith("HTTP/1.0 200")) {
          logProxy("connect-upstream-rejected", {
            target: `${host}:${port}`,
            header,
          });
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
          proxySocket.destroy();
          return;
        }

        established = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = response.subarray(separator + 4);
        if (remainder.length > 0) {
          clientSocket.write(remainder);
        }
        if (head.length > 0) {
          proxySocket.write(head);
        }
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
      });

      proxySocket.on("error", (error) => {
        logProxy("connect-upstream-failed", {
          target: `${host}:${port}`,
          upstream: upstreamProxyUrl,
          error: error.message,
        });
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
        clientSocket.destroy();
      });
      clientSocket.on("error", () => proxySocket.destroy());
    } catch (error) {
      logProxy("resolve-upstream-failed", {
        upstream: upstreamProxyUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      clientSocket.destroy();
    }
  })();
}

async function main(): Promise<void> {
  const { listenHost, listenPort, upstreamProxyUrl, dnsServers } = parseArgs();
  configureResolver(dnsServers);
  logProxy("listening", {
    listenHost,
    listenPort,
    upstreamProxyUrl: upstreamProxyUrl ?? null,
    dnsServers,
  });
  const server = http.createServer((req, res) => handleHttpRequest(req, res, upstreamProxyUrl));
  server.on("connect", (req, socket, head) => handleConnect(req, socket, head, upstreamProxyUrl));

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => resolve());
  });
}

void main();
