#!/usr/bin/env node
/**
 * Walk a benchmark result tree or .tgz/.tar.gz artifact and print phase/create splits
 * from each provider-api.json.
 *
 * New artifacts expose phaseSummaryP50/navigationBreakdownP50 directly. Older artifacts
 * are backfilled from the existing metric stats objects, e.g. session_creation_ms.p50.
 *
 * Usage: node scripts/bench/adhoc/summarize-provider-phase-summary.mjs [resultRoot|artifact.tgz|provider-api.json]
 * Default resultRoot: cwd
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const resultRoot = path.resolve(process.argv[2] ?? process.cwd());

/** @param {string} dir */
function walk(dir, acc) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const st = fs.statSync(dir);
  if (!st.isDirectory()) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      walk(p, acc);
    } else if (name === "provider-api.json") {
      acc.push(p);
    }
  }
}

/** @param {string} archivePath */
function readArchiveProviderJsonEntries(archivePath) {
  const input = fs.readFileSync(archivePath);
  const tar = archivePath.endsWith(".tar") ? input : zlib.gunzipSync(input);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeRaw = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeRaw || "0", 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if ((fullName.endsWith("/provider-api.json") || fullName === "provider-api.json") && bodyEnd <= tar.length) {
      entries.push({
        name: fullName,
        raw: tar.subarray(bodyStart, bodyEnd).toString("utf8"),
      });
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** @param {Buffer} buf @param {number} start @param {number} length */
function readTarString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
}

/** @param {unknown} json */
function printFromPayload(json, sourceLabel) {
  if (!json || typeof json !== "object") {
    return;
  }
  const o = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(o.results)) {
    for (const row of o.results) {
      printRow(row, o.runtimeProfile, sourceLabel);
    }
    return;
  }
  printRow(json, o.runtimeProfile, sourceLabel);
}

/** @param {unknown} row @param {unknown} fallbackProfile @param {string} sourceLabel */
function printRow(row, fallbackProfile, sourceLabel) {
  if (!row || typeof row !== "object") {
    return;
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  const profile = r.runtimeProfile ?? fallbackProfile ?? "?";
  const conc = r.concurrency ?? "?";
  const p = phaseSummary(r);
  if (!p || typeof p !== "object") {
    console.log(`(no phase summary) source=${sourceLabel} profile=${profile} c=${conc}`);
    return;
  }
  const ph = /** @type {Record<string, number>} */ (p);
  const line = [
    `source=${sourceLabel}`,
    `profile=${profile}`,
    `c=${conc}`,
    `create=${fmt(ph.session_creation_ms)}`,
    `runtime=${fmt(ph.session_create_runtime_ms)}`,
    `transport=${fmt(ph.session_create_transport_overhead_ms)}`,
    `connect=${fmt(ph.session_connect_ms)}`,
    `goto=${fmt(ph.page_goto_ms)}`,
    `release=${fmt(ph.session_release_ms)}`,
    `total=${fmt(ph.total_ms)}`,
  ].join(" ");
  console.log(line);
  const n = navigationBreakdownP50(r);
  if (n && typeof n === "object") {
    const nb = /** @type {Record<string, number>} */ (n);
    const bits = [];
    for (const k of ["dnsLookupMs", "tcpConnectMs", "tlsMs", "requestToResponseMs", "responseToDomContentLoadedMs"]) {
      if (typeof nb[k] === "number") {
        bits.push(`${k}=${fmt(nb[k])}`);
      }
    }
    if (bits.length > 0) {
      console.log(`  navigationBreakdownP50 ${bits.join(" ")}`);
    }
  }
}

/** @param {Record<string, unknown>} row */
function phaseSummary(row) {
  if (row.phaseSummaryP50 && typeof row.phaseSummaryP50 === "object") {
    return row.phaseSummaryP50;
  }
  const out = {
    session_creation_ms: metricP50(row, "session_creation_ms"),
    session_create_runtime_ms: metricP50(row, "session_create_runtime_ms"),
    session_create_transport_overhead_ms: metricP50(row, "session_create_transport_overhead_ms"),
    session_connect_ms: metricP50(row, "session_connect_ms"),
    page_goto_ms: metricP50(row, "page_goto_ms"),
    session_release_ms: metricP50(row, "session_release_ms"),
    total_iteration_ms: metricP50(row, "total_ms"),
  };
  out.total_ms =
    (out.session_creation_ms ?? 0) +
    (out.session_connect_ms ?? 0) +
    (out.page_goto_ms ?? 0) +
    (out.session_release_ms ?? 0);
  return Object.values(out).some((v) => typeof v === "number" && Number.isFinite(v)) ? out : undefined;
}

/** @param {Record<string, unknown>} row */
function navigationBreakdownP50(row) {
  if (row.navigationBreakdownP50 && typeof row.navigationBreakdownP50 === "object") {
    return row.navigationBreakdownP50;
  }
  const n = row.navigationBreakdown;
  if (!n || typeof n !== "object") {
    return undefined;
  }
  const nb = /** @type {Record<string, unknown>} */ (n);
  const out = {
    dnsLookupMs: metricObjectP50(nb.dnsLookupMs),
    tcpConnectMs: metricObjectP50(nb.tcpConnectMs),
    tlsMs: metricObjectP50(nb.tlsMs),
    requestToResponseMs: metricObjectP50(nb.requestToResponseMs),
    responseToDomContentLoadedMs: metricObjectP50(nb.responseToDomContentLoadedMs),
  };
  return Object.values(out).some((v) => typeof v === "number" && Number.isFinite(v)) ? out : undefined;
}

/** @param {Record<string, unknown>} row @param {string} key */
function metricP50(row, key) {
  return metricObjectP50(row[key]);
}

/** @param {unknown} metric */
function metricObjectP50(metric) {
  if (!metric || typeof metric !== "object") {
    return undefined;
  }
  const m = /** @type {Record<string, unknown>} */ (metric);
  for (const key of ["p50", "avg", "mean"]) {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
  }
  return undefined;
}

/** @param {number | undefined} v */
function fmt(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return "?";
  }
  return v.toFixed(0);
}

/** @param {string} raw @param {string} label */
function parseAndPrint(raw, label) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`skip (invalid JSON): ${label}`);
    return;
  }
  console.log(`--- ${label}`);
  printFromPayload(json, label);
}

if (fs.existsSync(resultRoot) && fs.statSync(resultRoot).isFile()) {
  if (resultRoot.endsWith(".tgz") || resultRoot.endsWith(".tar.gz") || resultRoot.endsWith(".tar")) {
    for (const entry of readArchiveProviderJsonEntries(resultRoot)) {
      parseAndPrint(entry.raw, `${path.relative(process.cwd(), resultRoot)}!${entry.name}`);
    }
  } else {
    parseAndPrint(fs.readFileSync(resultRoot, "utf8"), path.relative(process.cwd(), resultRoot));
  }
} else {
  const files = [];
  walk(resultRoot, files);
  files.sort();
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    parseAndPrint(raw, path.relative(process.cwd(), f));
  }
}

// Keep this utility safe for bounded remote/tool execution. Some Windows/npm shells
// have left the process attached after child-process tar calls despite all work
// being complete.
process.exit(0);
