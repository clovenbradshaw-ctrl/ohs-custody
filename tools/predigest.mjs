#!/usr/bin/env node
// predigest.mjs — the OHS digestion. Runs the vendored eoreader7 relation
// reader (docs/holodeck/holodeck-reader.js, byte-identical to the engine the
// app is wired to) over every corpus transcript/derived doc ONCE, and writes
// docs/holodeck/ohs-readings.json in the exact compact shape the app's
// engine-witness consumes (hdEngineCompact/hdEngineMap/hdEngineMerge).
//
// The app then attaches the pre-read digest to each seeded doc (measured:
// true + extra.eng) so addDocs NEVER waits on a live engine read — the
// 120s-per-host timeouts against unreachable /v1/read hosts vanish and the
// whole corpus lands fast. Docs without a digest still live-read (today's
// safe fallback).
//
// Run locally:   tools/digest.sh   (extract + predigest), then commit the
// regenerated files. CI does not digest — the output is committed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HD = path.join(ROOT, "docs", "holodeck");
const OUT = path.join(HD, "ohs-readings.json");
const SEED = path.join(HD, "ohs-seed.json");

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...a) => {
  const s = String(url);
  if (s.includes("pos-eng.json") || s.includes("morphology-eng.json")) {
    const name = s.includes("pos") ? "pos-eng.json" : "morphology-eng.json";
    const p = path.join(HD, "vendor", "eoreader7", "native", "priors", name);
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(p, "utf8")) };
  }
  return realFetch(url, ...a);
};

const hash = (buf) => createHash("sha256").update(buf).digest("hex");

// Write a JSON artifact plus a zstd-compressed twin (.zst). The browser
// fetches the .zst and decodes with the same zstd-wasm the app's
// reading-worker already uses (esm.sh @bokuweb/zstd-wasm), falling back to
// the .json. zstd cuts the analysis ~35MB -> ~4MB on the wire.
function writeArtifact(file, obj) {
  const raw = JSON.stringify(obj);
  fs.writeFileSync(file, raw);
  const zst = file + ".zst";
  const r = spawnSync("zstd", ["-q", "-f", "-o", zst, file], { encoding: "utf8" });
  if (r.status !== 0) {
    console.warn(`zstd failed for ${file} (${r.stderr || r.status}); keeping .json only`);
    return;
  }
  console.log(`  ${path.basename(file)}: raw=${(raw.length / 1e6).toFixed(1)}MB zst=${(fs.statSync(zst).size / 1e6).toFixed(1)}MB`);
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
  const entries = seed.entries.filter((e) => e.path.endsWith(".txt"));
  const tStart = Date.now();

  // One-shot corpus: every doc, one entry, with a STABLE id. id must be
  // unique PER SOURCE — sha256(file bytes) collides when distinct files yield
  // identical extracted text (several contract PDFs did, corrupting stsByDoc);
  // hash the path too (the path is unique, so the id is unique).
  const docs = entries.map((e) => {
    const id = "ohs-" + hash(e.path + ":" + hash(fs.readFileSync(path.join(ROOT, e.path)))).slice(0, 12);
    return {
      id,
      title: e.title,
      year: null,
      type: "Repo file",
      text: fs.readFileSync(path.join(ROOT, e.path), "utf8"),
      url: e.url,
      note: `From ohs-custody · ${e.path}`,
      measured: true,
    };
  });

  // Pre-digested analysis: the app's OWN analyze() over the full corpus, run
  // here (jsdom shim), serialized. The app loads it instead of recomputing,
  // so first render is instant; local adds/corrections fold on top via the
  // app's own analysis() (which the guard lets through once the workspace
  // diverges from the seeded set).
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const { analyze_offline } = await import(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "ohs-analyze.mjs")
  );
  const a0 = Date.now();
  const A = analyze_offline({ docs }, {});
  const docIds = docs.map((d) => d.id).join(",");
  // Single append-only log — the computed-once fold. Statements carry spans
  // only (no text; the render derives text from the doc's text at rehydrate).
  // rawNames/shadow/topics are consumed only inside analyze(); dropped here.
  const cleanDocs = A.docs;
  // FALSIFIED then fixed: analyze's st.spans index its NORMALIZED text, not the
  // cleaned doc text shipped in the log — so highlights pointed at the wrong
  // bytes. Recompute each statement's name positions against the shipped doc
  // text: search each name string within the statement's slice, record the
  // absolute offset. Spans now index what the app actually displays.
  const docById = Object.fromEntries(cleanDocs.map((d) => [d.id, d]));
  const sts = A.sts.map((s) => {
    const { rawNames, shadow, topics, text, spans, ...rest } = s;
    const d = docById[s.doc];
    const spanOut = [];
    if (d && typeof s.s === "number" && typeof s.e === "number") {
      const slice = d.text.slice(s.s, s.e);
      for (const n of s.names || []) {
        if (!n) continue;
        const idx = slice.indexOf(n);
        if (idx !== -1) spanOut.push({ s: s.s + idx, e: s.s + idx + n.length, name: n });
      }
    }
    return { ...rest, spans: spanOut };
  });
  const names = {};
  for (const [k, v] of Object.entries(A.names)) {
    names[k] = { name: v.name, type: v.type, aliases: v.aliases || [], docs: Array.from(v.docs), sts: v.sts.map((s) => s.id) };
  }
  const stsByDoc = {}; sts.forEach((s) => { (stsByDoc[s.doc] = stsByDoc[s.doc] || []).push(s); });
  const metaDocs = cleanDocs.map((d) => {
    // docs carry the cleaned text the render reads; html/heads/blocks/links/
    // live/extra are projection artifacts the main render doesn't read.
    const { html, heads, blocks, links, live, extra, ...meta } = d;
    return meta;
  });
  const LOG = path.join(HD, "ohs.log");
  writeArtifact(
    LOG,
    {
      schema: "ohs-log@3",
      generated: new Date().toISOString(),
      docIds,
      docs: metaDocs,
      sts,
      stsByDoc,
      names,
      echoes: A.echoes,
      echoFloor: A.echoFloor,
    }
  );
  console.log(
    `wrote ${LOG}: ${sts.length} sts (spans), ${Object.keys(names).length} names, ` +
    `${fs.statSync(LOG).size} bytes, ${fs.statSync(LOG + ".zst").size} bytes zst`
  );
}

main().catch((e) => { console.error("predigest failed:", e); process.exit(1); });