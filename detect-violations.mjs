#!/usr/bin/env node
// detect-violations.mjs — the governance-violation shape: a recorded value
// sitting next to a named requirement, where that requirement is void,
// violated, bypassed, disputed, or cited inconsistently.
//
// Read-only, like fold-referents.mjs and detect-collisions.mjs. This never
// asserts corruption or intent -- it only surfaces where the ledger already
// states a value AND a requirement AND a non-compliant status, together.
// The judgment about what it means is still the reader's.
//
//   node detect-violations.mjs [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fold } from "./fold-referents.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "referents.eot.jsonl");

// A status counts as flagged unless it says the requirement was met. This is
// a closed list of the compliant states, not a list of violation words to
// search for -- new violation vocabulary needs no update here, only new
// compliant vocabulary would.
const COMPLIANT_STATUSES = new Set(["met", "compliant", "present", "satisfied"]);

function isFlagged(status) {
  if (!status) return false;
  return !COMPLIANT_STATUSES.has(String(status).toLowerCase());
}

function findViolations(referents) {
  const found = [];
  for (const r of referents.values()) {
    if (r.status !== "active") continue;
    const status = r.fields.get("status");
    if (!status || !isFlagged(status.value)) continue;
    found.push({
      id: r.id,
      status: status.value,
      amount: r.fields.get("amount")?.value ?? null,
      amountUnit: r.fields.get("amount_unit")?.value ?? "USD",
      requires: r.fields.get("requires")?.value ?? null,
      detail: r.fields.get("status_detail")?.value ?? null,
      source: status.source,
      confidence: status.confidence,
    });
  }
  // Mechanical ranking: numeric amount descending, entries with no amount
  // last (never dropped -- a violation with no dollar figure, like the
  // PEAT secret meetings or the MNPD no-contract trial, is not less real).
  found.sort((a, b) => {
    if (a.amount == null && b.amount == null) return 0;
    if (a.amount == null) return 1;
    if (b.amount == null) return -1;
    return b.amount - a.amount;
  });
  return found;
}

function fmtAmount(v, unit) {
  if (v == null) return "(no dollar figure)";
  if (unit && unit !== "USD") return `${v} ${unit}`;
  return `$${v.toLocaleString("en-US")}`;
}

function printText(violations) {
  if (violations.length === 0) {
    console.log("(no flagged value/requirement entries found)");
    return;
  }
  console.log(`${violations.length} flagged entr${violations.length === 1 ? "y" : "ies"}, ranked by dollar amount (entries with none listed last):\n`);
  for (const v of violations) {
    console.log(`## ${v.id}`);
    console.log(`  value: ${fmtAmount(v.amount, v.amountUnit)}`);
    console.log(`  requires: ${v.requires ?? "(not stated)"}`);
    console.log(`  status: ${v.status} [${v.confidence}]`);
    if (v.detail) console.log(`  detail: ${v.detail}`);
    console.log(`  source: ${v.source}`);
    console.log("");
  }
}

function main() {
  const asJson = process.argv.includes("--json");
  if (!fs.existsSync(LOG_FILE)) {
    console.log("(no referents.eot.jsonl yet)");
    return;
  }
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  const referents = fold(lines);
  const violations = findViolations(referents);
  if (asJson) console.log(JSON.stringify(violations, null, 2));
  else printText(violations);
}

main();
