#!/usr/bin/env node
// fold-referents.mjs — folds referents.eot.jsonl into the current index.
//
// The log is append-only: four event kinds (alias, observe, merge, seg),
// never edited or overwritten. New knowledge — including corrections — is
// always a new line appended to the end. This script never writes to the
// log; it only replays it into an in-memory index and prints that.
//
//   node fold-referents.mjs                → full index
//   node fold-referents.mjs <text>          → filter to matching id/alias
//   node fold-referents.mjs --json [<text>] → same, as JSON
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "referents.eot.jsonl");

function ensure(referents, id) {
  if (!referents.has(id)) {
    referents.set(id, { id, aliases: [], fields: new Map(), status: "active", mergedInto: null, splitInto: null });
  }
  return referents.get(id);
}

export function fold(lines) {
  const referents = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.schema === "alias") {
      ensure(referents, e.id).aliases.push({ surface: e.surface, confidence: e.confidence, source: e.source, ts: e.ts });
    } else if (e.schema === "observe") {
      const r = ensure(referents, e.id);
      for (const [field, value] of Object.entries(e.fields)) {
        r.fields.set(field, { value, confidence: e.confidence, source: e.source, ts: e.ts });
      }
    } else if (e.schema === "merge") {
      const kept = ensure(referents, e.kept);
      for (const foldedId of e.folded) {
        const r = ensure(referents, foldedId);
        r.status = "folded";
        r.mergedInto = e.kept;
        kept.aliases.push(...r.aliases);
        for (const [field, v] of r.fields) if (!kept.fields.has(field)) kept.fields.set(field, v);
      }
    } else if (e.schema === "seg") {
      const r = ensure(referents, e.from);
      r.status = "split";
      r.splitInto = e.into;
      for (const newId of e.into) ensure(referents, newId);
    }
  }
  return referents;
}

function humanValue(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function printText(referents, filter) {
  const matches = (r) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    if (r.id.includes(q)) return true;
    return r.aliases.some((a) => a.surface.toLowerCase().includes(q));
  };

  const active = [...referents.values()].filter((r) => r.status === "active" && matches(r)).sort((a, b) => a.id.localeCompare(b.id));
  const retired = [...referents.values()].filter((r) => r.status !== "active" && matches(r)).sort((a, b) => a.id.localeCompare(b.id));

  if (active.length === 0 && retired.length === 0) {
    console.log(filter ? `(no referent matches "${filter}")` : "(log is empty)");
    return;
  }

  for (const r of active) {
    console.log(`\n## ${r.id}`);
    const surfaces = [...new Set(r.aliases.map((a) => a.surface))];
    if (surfaces.length) console.log(`aliases: ${surfaces.join(", ")}`);
    for (const [field, v] of r.fields) {
      console.log(`  ${field}: ${humanValue(v.value)}  [${v.confidence}] — ${v.source}`);
    }
  }

  if (retired.length) {
    console.log(`\n-- retired (folded/split, kept for history) --`);
    for (const r of retired) {
      if (r.status === "folded") console.log(`${r.id} -> folded into ${r.mergedInto}`);
      if (r.status === "split") console.log(`${r.id} -> split into ${r.splitInto.join(", ")}`);
    }
  }
}

function printJson(referents, filter) {
  const matches = (r) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    if (r.id.includes(q)) return true;
    return r.aliases.some((a) => a.surface.toLowerCase().includes(q));
  };
  const out = {};
  for (const r of referents.values()) {
    if (!matches(r)) continue;
    out[r.id] = {
      status: r.status,
      mergedInto: r.mergedInto,
      splitInto: r.splitInto,
      aliases: [...new Set(r.aliases.map((a) => a.surface))],
      fields: Object.fromEntries([...r.fields].map(([k, v]) => [k, v])),
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const filter = args.find((a) => !a.startsWith("--"));

  if (!fs.existsSync(LOG_FILE)) {
    console.log("(no referents.eot.jsonl yet)");
    return;
  }
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  const referents = fold(lines);
  if (asJson) printJson(referents, filter);
  else printText(referents, filter);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
