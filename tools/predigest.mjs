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
// Run locally:   node tools/predigest.mjs
// CI runs it on any push touching transcripts/ or derived/ and commits the
// changed digest (see .github/workflows/digest.yml).
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
  const { makeEngineRelationReader } = await import(
    path.join(HD, "holodeck-reader.js")
  );
  const read = await makeEngineRelationReader();

  const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
  const entries = seed.entries.filter((e) => e.path.endsWith(".txt"));
  const readings = {};
  let done = 0;
  const tStart = Date.now();
  for (const e of entries) {
    const abs = path.join(ROOT, e.path);
    const txt = fs.readFileSync(abs, "utf8");
    const t0 = Date.now();
    let out;
    try {
      out = await read([{ text: txt, name: e.title }], {});
    } catch (err) {
      console.error(`read failed ${e.path}: ${err.message}`);
      continue;
    }
    const edges = out.edges || [];
    const byName = new Map();
    const desc = [];
    const seenDesc = new Set();
    for (const ed of edges) {
      for (const side of ["end1", "end2"]) {
        const nm = ed[side];
        if (!nm || typeof nm !== "string") continue;
        if (!byName.has(nm)) byName.set(nm, { surfaces: [nm], routes: ["relation"], grain: null });
        const face = ed[side + "Face"];
        if (face && face !== nm && !seenDesc.has(face)) {
          seenDesc.add(face);
          desc.push({ surfaces: [face], routes: ["descriptor"] });
        }
      }
    }
    readings[e.path] = {
      sha256: hash(fs.readFileSync(abs)),
      eng: {
        ms: Date.now() - t0,
        basis: "predigest:v1 (vendored holodeck-reader edges -> compact)",
        relations: edges.length,
        referents: [...byName.values()],
        descriptorBeings: desc,
      },
    };
    done++;
    if (done % 20 === 0) console.log(`digested ${done}/${entries.length} (${Math.round((Date.now() - tStart) / 1000)}s)`);
  }
  const payload = { generated: new Date().toISOString(), schema: "ohs-readings@1", entries: readings };
  writeArtifact(OUT, payload);
  console.log(`wrote ${OUT}: ${Object.keys(readings).length} docs, ${fs.statSync(OUT).size} bytes, ${Math.round((Date.now() - tStart) / 1000)}s`);

  // One-shot bundle: every doc (text + pre-read eng) in a single file, so the
  // app loads ALL data with one fetch. Docs carry STABLE ids (the app mints
  // runtime ids for live adds; the pre-digested analysis keys off these).
  // Text here is the CLEANED doc text analyze produces (statement byte spans
  // s/e index into it), so statement text can be derived instead of shipped.
  const BUNDLE = path.join(HD, "ohs-bundle.json");
  const docs = entries.map((e) => {
    const eng = (readings[e.path] || {}).eng;
    const id = "ohs-" + hash(fs.readFileSync(path.join(ROOT, e.path))).slice(0, 10);
    return {
      id,
      title: e.title,
      year: null,
      type: "Repo file",
      text: fs.readFileSync(path.join(ROOT, e.path), "utf8"),
      url: e.url,
      note: `From ohs-custody · ${e.path}`,
      measured: true,
      extra: eng ? { eng } : {},
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
  const ANALYSIS = path.join(HD, "ohs-analysis.json");
  const docIds = docs.map((d) => d.id).join(",");
  // Reduced serialization (byte-addressed): the app's in-memory A shares
  // references (JSON triples them) and statement text dominates the payload.
  // Ships sts ONCE with text DROPPED wherever the doc's cleaned text already
  // reproduces it from the byte span (s/e) — rehydrate derives those. names
  // carry their statement objects (some reference degenerate sts absent from
  // the list). Bundle carries analyze's cleaned doc text so spans resolve.
  const cleanDocs = A.docs; // cleaned text, same ids as the seeded docs
  const sts = A.sts.map((s) => {
    const d = cleanDocs.find((x) => x.id === s.doc);
    // rawNames/shadow are consumed only inside analyze() itself — the render
    // reads names/spans/frame/where/topics. Dropping them shrinks the payload.
    const { rawNames, shadow, ...rest } = s;
    if (d && typeof s.s === "number" && typeof s.e === "number" && d.text.slice(s.s, s.e) === s.text) {
      return { ...rest, text: null };
    }
    return rest;
  });
  const names = {};
  for (const [k, v] of Object.entries(A.names)) {
    names[k] = { name: v.name, type: v.type, aliases: v.aliases || [], docs: v.docs, sts: v.sts };
  }
  writeArtifact(
    ANALYSIS,
    {
      generated: new Date().toISOString(),
      schema: "ohs-analysis@1",
      docIds,
      sts,
      names,
      echoes: A.echoes,
      echoFloor: A.echoFloor,
    }
  );
  // Bundle now carries the cleaned doc text (same ids) so span derivation works.
  writeArtifact(BUNDLE, { generated: new Date().toISOString(), docs: cleanDocs });
  const keptText = sts.filter((s) => s.text != null).length;
  console.log(
    `wrote ${ANALYSIS}: ${sts.length} statements (${keptText} with text, ${sts.length - keptText} byte-derived), ` +
    `${Object.keys(names).length} names, ${fs.statSync(ANALYSIS).size} bytes, ${Math.round((Date.now() - a0) / 1000)}s`
  );
}

main().catch((e) => { console.error("predigest failed:", e); process.exit(1); });