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
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`wrote ${OUT}: ${Object.keys(readings).length} docs, ${fs.statSync(OUT).size} bytes, ${Math.round((Date.now() - tStart) / 1000)}s`);
}

main().catch((e) => { console.error("predigest failed:", e); process.exit(1); });