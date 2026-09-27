#!/usr/bin/env node
/** Retrieve the documented AA Free language-model API; preserve raw evidence, never infer. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BASE = "https://artificialanalysis.ai/api/v2/language/models/free?page=";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;
const timestamp = () => new Date().toISOString();
const safeJson = value => JSON.stringify(value, null, 2) + "\n";

async function readBounded(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("response too large");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error("response too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error("response too large"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function validateRows(data) {
  if (!Array.isArray(data)) throw new Error("invalid response");
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.id !== "string" || !row.id.trim() ||
        typeof row.slug !== "string" || !row.slug.trim() ||
        typeof row.name !== "string" || !row.name.trim()) throw new Error("invalid response");
  }
}

/** Fetch and archive all pages. Dependencies are injectable for deterministic offline tests. */
export async function retrieveSnapshot({ out, apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY,
  fetchImpl = globalThis.fetch, clock = timestamp, methodologyVersion } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("missing API key");
  if (methodologyVersion !== undefined && !/^v\d+\.\d+\.\d+$/.test(methodologyVersion)) throw new Error("invalid methodology version");
  if (typeof out !== "string" || !out) throw new Error("invalid output directory");
  const directory = resolve(out);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const manifest = { schemaVersion: 1, complete: false, retrievedAt: clock(), endpoint: "https://artificialanalysis.ai/api/v2/language/models/free",
    pages: [], tier: null, intelligenceIndexVersion: null, methodologyVersion: methodologyVersion ?? null };
  let models = [];
  const ids = new Set(), slugs = new Set();
  const writeManifest = () => writeFileSync(resolve(directory, "manifest.json"), safeJson(manifest), { mode: 0o600 });
  try {
    let expectedPages, pageSize;
    for (let page = 1; page <= (expectedPages ?? MAX_PAGES); page++) {
      if (page > MAX_PAGES) throw new Error("invalid response");
      const url = BASE + page;
      const item = { page, url, retrievedAt: clock() };
      manifest.pages.push(item);
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "x-api-key": apiKey, accept: "application/json" } });
        item.httpStatus = response.status;
        item.rateLimit = {};
        for (const header of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
          const value = response.headers?.get?.(header);
          if (value && /^\d+$/.test(value)) item.rateLimit[header] = value;
        }
        if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error("request failed");
        const raw = await readBounded(response);
        const filename = `page-${String(page).padStart(3, "0")}.json`;
        writeFileSync(resolve(directory, filename), raw, { flag: "wx", mode: 0o600 });
        Object.assign(item, { file: filename, sha256: createHash("sha256").update(raw).digest("hex") });
        const parsed = JSON.parse(raw.toString("utf8"));
        const p = parsed?.pagination;
        if (!["free", "pro", "commercial"].includes(parsed?.tier) || !Number.isFinite(parsed.intelligence_index_version) || parsed.intelligence_index_version <= 0 ||
            (methodologyVersion !== undefined && Number(methodologyVersion.slice(1).split(".").slice(0, 2).join(".")) !== parsed.intelligence_index_version) ||
            !p || !Number.isInteger(p.page) || !Number.isInteger(p.page_size) || p.page_size < 1 ||
            !Number.isInteger(p.total_pages) || p.total_pages < 1 || p.total_pages > MAX_PAGES || typeof p.has_more !== "boolean" || p.page !== page ||
            p.total_pages !== (expectedPages ?? p.total_pages) || p.page_size !== (pageSize ?? p.page_size) ||
            p.has_more !== (page < p.total_pages)) throw new Error("invalid response");
        validateRows(parsed.data);
        if (parsed.data.length > p.page_size || parsed.data.length !== (page < p.total_pages ? p.page_size : parsed.data.length) ||
            (page === p.total_pages && parsed.data.length === 0)) throw new Error("invalid response");
        if (manifest.tier !== null && (manifest.tier !== parsed.tier || manifest.intelligenceIndexVersion !== parsed.intelligence_index_version)) throw new Error("invalid response");
        for (const row of parsed.data) {
          if (ids.has(row.id) || slugs.has(row.slug)) throw new Error("invalid response");
          ids.add(row.id); slugs.add(row.slug);
        }
        expectedPages = p.total_pages; pageSize = p.page_size;
        manifest.tier = parsed.tier; manifest.intelligenceIndexVersion = parsed.intelligence_index_version;
        Object.assign(item, { status: "ok", count: parsed.data.length });
        models.push(...parsed.data);
      } catch {
        item.status = "error";
        item.error = "Request or response invalid; details withheld";
        throw new Error("snapshot failed");
      }
      writeManifest();
    }
    writeFileSync(resolve(directory, "models.json"), safeJson({ schemaVersion: 1, complete: true,
      retrievedAt: manifest.retrievedAt, tier: manifest.tier, intelligenceIndexVersion: manifest.intelligenceIndexVersion,
      methodologyVersion: methodologyVersion ?? null, data: models }), { flag: "wx", mode: 0o600 });
    manifest.complete = true;
    writeManifest();
    return { manifest, modelsFile: resolve(directory, "models.json") };
  } catch {
    try { writeManifest(); } catch { /* Preserve the primary generic failure. */ }
    throw new Error("AA snapshot failed; check credentials, network, API quota, arguments, and output directory");
  }
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({ args, options: {
    out: { type: "string" }, "methodology-version": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node aa-snapshot.mjs --out NEW_DIRECTORY [--methodology-version VERSION]\nRequires ARTIFICIAL_ANALYSIS_API_KEY. Retrieves only the AA Free language-model endpoint; no inference or retries. Output directory must be new.");
    return;
  }
  if (!values.out) throw new Error("invalid arguments");
  await retrieveSnapshot({ ...deps, out: values.out, methodologyVersion: values["methodology-version"] });
  console.log(`AA snapshot saved: ${resolve(values.out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("AA snapshot failed. Check credentials, network, API quota, arguments, and output directory; details and secrets are withheld.");
    process.exitCode = 1;
  });
}
