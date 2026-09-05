#!/usr/bin/env node
// run-entity-recognition.mjs -- second pass over a transcript through the
// user's eoreader7 referent-discovery pipeline (organs/cast.js, handle
// "Zhengming": "a name answers to its referent, not its string").
//
// This NEVER touches or overwrites the input file. It writes a sibling
// <out>.entities.json carrying the referent list plus any disclosed gaps
// (pronoun/descriptor mentions the engine could not resolve on its own --
// reported honestly, not silently guessed).
//
// Usage: node run-entity-recognition.mjs <transcript.txt> <out_basename>

import { readFileSync, writeFileSync } from "node:fs";
import { stripContainer, splitSentences } from "/Users/mlacy/Documents/3.0/eoreader7/native/adapters/text/spans.js";
import { tokenize, buildFrequencyTable, functionWordSet } from "/Users/mlacy/Documents/3.0/eoreader7/native/adapters/text/material.js";
import { extractSurfaces, discoverReferents } from "/Users/mlacy/Documents/3.0/eoreader7/native/adapters/text/surfaces.js";
import { projectReferents } from "/Users/mlacy/Documents/3.0/eoreader7/legacy-eoreader6.1/packages/engine/referents/index.js";

const [, , inPath, outBase] = process.argv;
if (!inPath || !outBase) {
  console.error("usage: node run-entity-recognition.mjs <transcript.txt> <out_basename>");
  process.exit(1);
}

const raw = readFileSync(inPath, "utf8");
const { text } = stripContainer(raw);
const sentences = splitSentences(text);
const words = tokenize(text);
const functionWords = functionWordSet(buildFrequencyTable(words));
const surfaces = extractSurfaces(sentences, { functionWords });
const { events, gaps } = discoverReferents(surfaces);
const referents = projectReferents(events).filter((r) => !r.mergedInto);

const out = {
  schema: "eoreader7-entity-pass@1",
  source_transcript: inPath,
  generated_at: new Date().toISOString(),
  sentence_count: sentences.length,
  referent_count: referents.length,
  gap_count: gaps.length,
  referents,
  gaps,
};

const outPath = `${outBase}.entities.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`wrote ${outPath}: ${referents.length} referents, ${gaps.length} unresolved gaps`);
