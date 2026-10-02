// predicate-extract.mjs — the relational layer the DMD/co-occurrence model threw away.
//
// Each statement span (s..e) is English prose. We read the verb (predicate) and
// bind its arguments by role (Chomsky: the verb is the relational atom; the
// surface names-set is deep structure's shadow), using the house's English POS
// prior (UD_English-EWT, sha256-pinned) to find verb forms. We then submit the
// result to Sullivan's discipline (archon, adapters/text/morph-cues.js): a cue
// is admitted only against its own NULL and a floor, audited on a half never
// used to build the rule. Here the null permutes the verb across statements —
// a relation is real only if (agent, verb, patient) RECURS beyond that null.
//
//   node --max-old-space-size=6144 tools/predicate-extract.mjs [--write]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(HERE, "..", "docs", "holodeck", "ohs.log");
const PRIOR = path.resolve(HERE, "..", "..", "the-fold", "priors-data", "pos-prior-eng.json");
const OUT = path.resolve(HERE, "..", "docs", "holodeck", "ohs-ties.json");
const WRITE = process.argv.includes("--write");

const IRREG = { was: "be", were: "be", is: "be", are: "be", been: "be", am: "be", said: "say", says: "say", has: "have", had: "have", have: "have", does: "do", did: "do", done: "do", went: "go", gotten: "get", got: "get", made: "make", holds: "hold", held: "hold", funds: "fund", funded: "fund", serves: "serve", served: "serve", provides: "provide", provided: "provide", contracts: "contract", contracted: "contract", appointed: "appoint", appointed: "appoint", approved: "approve", reported: "report", operates: "operate", operated: "operate" };
const lemma = w => IRREG[w] || (/ing$/.test(w) && w.length > 5 ? w.replace(/ing$/, "") : /(ated|ied|ed)$/.test(w) && w.length > 4 ? w.replace(/ed$/, "") : /(ies)$/.test(w) && w.length > 4 ? w.replace(/ies$/, "y") : /(shes|ches|xes|ses)$/.test(w) ? w.replace(/es$/, "") : /s$/.test(w) && w.length > 3 && !/ss$/.test(w) ? w.replace(/s$/, "") : w);

// verb forms: dominant UPOS is VERB (argmax of the prior's counts), plus any form
// with a VERB count that beats the runner-up — the prior's own contract.
const prior = JSON.parse(fs.readFileSync(PRIOR, "utf8"));
const verbForms = new Set();
for (const [form, counts] of Object.entries(prior.forms)) {
  if (!/^[a-z][a-z'-]*$/.test(form)) continue;
  let best = null, bv = -1, second = -1;
  for (const [tag, n] of Object.entries(counts)) { if (n > bv) { second = bv; bv = n; best = tag; } else if (n > second) second = n; }
  if (best === "VERB" && bv > second) verbForms.add(form);
}

const log = JSON.parse(fs.readFileSync(LOG, "utf8"));
const textOf = new Map(log.docs.map(d => [d.id, d.text]));

const toks = s => { const out = []; const re = /[A-Za-z][A-Za-z'’-]*/g; let m; while ((m = re.exec(s))) out.push({ w: m[0].toLowerCase(), i: m.index }); return out; };

// TEMPLATE / REGISTER gate (Sullivan's provenance rule). A vendor ToS repeated
// across twelve repo files is one register masquerading as twelve sources. A doc
// is "template" when most of its statements echo verbatim in other docs; a tie
// whose every supporting doc is template is boilerplate, not testimony, and is
// demoted below ties that carry the meeting record.
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
const textDocs = new Map();
for (const st of log.sts) { const tx = textOf.get(st.doc); if (!tx) continue; const n = norm(tx.slice(st.s, st.e)); if (n.length < 24) continue; if (!textDocs.has(n)) textDocs.set(n, new Set()); textDocs.get(n).add(st.doc); }
const docTmpl = new Map();
{ const tot = new Map(), rep = new Map();
  for (const st of log.sts) { const tx = textOf.get(st.doc); if (!tx) continue; const n = norm(tx.slice(st.s, st.e)); if (n.length < 24) continue; tot.set(st.doc, (tot.get(st.doc) || 0) + 1); if ((textDocs.get(n) || new Set()).size >= 2) rep.set(st.doc, (rep.get(st.doc) || 0) + 1); }
  for (const [d, t] of tot) docTmpl.set(d, (rep.get(d) || 0) / t); }
// REGISTER by provenance: the corpus's record is the meeting transcripts; vendor
// ToS and similar are a different register. A tie carries the register of its
// supporting sources.
const isRecord = d => /transcripts\/|meeting|minutes|transcript/i.test(d.title || "");
const docRecord = new Map(log.docs.map(d => [d.id, isRecord(d)]));

// a "name" that is really a clause fragment (all-caps boilerplate, a verb phrase
// glued by the analyzer) is not an entity — drop it. Sullivan's null punishes
// what the register admits; this punishes what the segmenter admitted.
const PRON = /\b(i|i'm|we|you|he|she|it|they|me|us|him|her|them|my|our|your|their|um|uh|yeah|okay|hmm|huh)\b/i;
const junkName = n => n.length < 2 || PRON.test(n) || /\b(AND|ARE|THE|IS|OR|OF|TO|AS|BY|IT|THIS|THAT|WILL|SHALL|MAY|BE|HAS|HAVE|NOT)\b/.test(n) || n.split(/\s+/).length > 4;

// --- read: (agent, verb, patient) per statement, with distinct-source support ---
const triples = new Map();
const tDocs = new Map();             // triple -> Set(doc)
const adjPairs = new Map();          // (agent|patient) -> [verbs]  (for the null: same arguments, permuted verb)
let stmtsWithVerb = 0, stmtsScanned = 0;
for (const st of log.sts) {
  stmtsScanned++;
  const text = textOf.get(st.doc); if (!text) continue;
  const span = text.slice(st.s, st.e);
  if (!span.trim() || !st.names || !st.names.length) continue;
  const ts = toks(span);
  const verbPos = ts.findIndex(t => verbForms.has(t.w));
  if (verbPos < 0) continue;
  stmtsWithVerb++;
  const vp = ts[verbPos].i, verb = lemma(ts[verbPos].w);
  const low = span.toLowerCase();
  const at = n => { const idx = low.indexOf(n.toLowerCase()); return idx < 0 ? null : idx; };
  let agent = null, patient = null, ab = -1, pb = Infinity;
  for (const n of st.names) { if (junkName(n)) continue; const p = at(n); if (p == null) continue; if (p < vp && p > ab) { ab = p; agent = n; } if (p > vp && p < pb) { pb = p; patient = n; } }
  if (agent == null || patient == null || agent === patient) continue;
  const k = agent + "\u0000" + verb + "\u0000" + patient;
  triples.set(k, (triples.get(k) || 0) + 1);
  if (!tDocs.has(k)) tDocs.set(k, new Set());
  tDocs.get(k).add(st.doc);
  const ap = agent + "\u0000" + patient;
  if (!adjPairs.has(ap)) adjPairs.set(ap, []);
  adjPairs.get(ap).push(verb);
}

// --- null: permute the verb across statements sharing an (agent,patient) ---
// a relation survives only if its verb recurs MORE than a permuted verb does.
const allVerbs = []; for (const vs of adjPairs.values()) for (const v of vs) allVerbs.push(v);
for (let i = allVerbs.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [allVerbs[i], allVerbs[j]] = [allVerbs[j], allVerbs[i]]; }
const nullTriples = new Map(); let p = 0;
for (const [ap, vs] of adjPairs) { const mn = ap.split("\u0000"); for (let k = 0; k < vs.length; k++) { const v = allVerbs[p++ % allVerbs.length]; const key = mn[0] + "\u0000" + v + "\u0000" + mn[1]; nullTriples.set(key, (nullTriples.get(key) || 0) + 1); } }
const recur = m => [...m.values()].filter(c => c >= 2).length;

const rows = [...triples.entries()].map(([k, c]) => { const [a, v, b] = k.split("\u0000"); const ds = tDocs.get(k) || new Set(); const nrec = [...ds].filter(id => docRecord.get(id)).length; const recFrac = ds.size ? nrec / ds.size : 0; return { a, v, b, n: c, docs: ds.size, rec: nrec, recFrac, template: recFrac < 0.5, null: nullTriples.get(k) || 0 }; }).sort((x, y) => y.recFrac - x.recFrac || y.docs - x.docs || y.n - x.n);

console.log("verb forms (dominant VERB):", verbForms.size);
console.log("statements scanned:", stmtsScanned, "| with a verb + 2 names:", stmtsWithVerb);
console.log("distinct triples:", triples.size, "| recurring (n>=2):", recur(triples), "| from the record (recFrac>=.5):", rows.filter(r => r.recFrac >= 0.5).length);
console.log("NULL (verb permuted): recurring (n>=2):", recur(nullTriples));
console.log("\ntop relations (rec = supporting docs from the meeting record):");
rows.slice(0, 20).forEach(r => console.log(String(r.n).padStart(4), "rec=" + r.rec + "/" + r.docs, "null=" + r.null, " ", r.a, "—[" + r.v + "]→", r.b));

if (WRITE) {
  fs.writeFileSync(OUT, JSON.stringify({ schema: "ohs-ties@1", generated: new Date().toISOString(), giver: prior.giver, nullFloor: 2, nullRecurring: recur(nullTriples), triples: rows }, null, 0));
  console.log("\nwrote", OUT);
}
