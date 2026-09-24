#!/usr/bin/env node
// detect-collisions.mjs — dark-link detector: does any address appear under
// more than one referent id?
//
// Read-only, like fold-referents.mjs. This never merges and never declares
// two referents the same entity -- it only reports which ids share a
// normalized address string, for a human to read the sources and decide.
// A collision here is a CANDIDATE, not a finding.
//
//   node detect-collisions.mjs [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fold } from "./fold-referents.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "referents.eot.jsonl");

const SUFFIX_MAP = {
  road: "rd", rd: "rd",
  street: "st", st: "st",
  avenue: "ave", ave: "ave",
  drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd",
  lane: "ln", ln: "ln",
  court: "ct", ct: "ct",
  place: "pl", pl: "pl",
  parkway: "pkwy", pkwy: "pkwy",
};

// Normalizes an address string for comparison: lowercase, strip punctuation,
// collapse whitespace, standardize the one street-suffix word if present.
// This is deliberately conservative -- it narrows false positives from
// punctuation/case, not from a guess about what "the same place" means.
export function normalizeAddress(raw) {
  const words = String(raw ?? "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX_MAP[w] ?? w);
  return words.join(" ").trim();
}

function addressFieldsOf(referent) {
  const found = [];
  for (const [field, v] of referent.fields) {
    if (/address/i.test(field)) {
      const norm = normalizeAddress(v.value);
      if (norm) found.push({ field, raw: v.value, norm, source: v.source });
    }
  }
  return found;
}

function findCollisions(referents) {
  const byAddress = new Map(); // normalized address -> [{id, field, raw, source}]
  for (const r of referents.values()) {
    if (r.status !== "active") continue; // a folded/split id speaks through its kept/split target
    for (const hit of addressFieldsOf(r)) {
      const list = byAddress.get(hit.norm) ?? [];
      list.push({ id: r.id, field: hit.field, raw: hit.raw, source: hit.source });
      byAddress.set(hit.norm, list);
    }
  }
  const collisions = [];
  for (const [norm, hits] of byAddress) {
    const distinctIds = new Set(hits.map((h) => h.id));
    if (distinctIds.size > 1) collisions.push({ normalizedAddress: norm, hits });
  }
  return collisions.sort((a, b) => a.normalizedAddress.localeCompare(b.normalizedAddress));
}

function printText(collisions) {
  if (collisions.length === 0) {
    console.log("(no address collisions found)");
    return;
  }
  for (const c of collisions) {
    console.log(`\n## shared address: "${c.normalizedAddress}"`);
    for (const h of c.hits) {
      console.log(`  ${h.id}  [${h.field}]  "${h.raw}"`);
      console.log(`      — ${h.source}`);
    }
  }
  console.log(`\n${collisions.length} candidate collision(s) — not merges. Verify the source bytes before treating any of these as the same property.`);
}

function main() {
  const asJson = process.argv.includes("--json");
  if (!fs.existsSync(LOG_FILE)) {
    console.log("(no referents.eot.jsonl yet)");
    return;
  }
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  const referents = fold(lines);
  const collisions = findCollisions(referents);
  if (asJson) console.log(JSON.stringify(collisions, null, 2));
  else printText(collisions);
}

main();
