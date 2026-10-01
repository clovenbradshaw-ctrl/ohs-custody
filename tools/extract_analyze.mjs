#!/usr/bin/env node
// extract_analyze.mjs — pull the app's OWN `analyze` function and its
// transitive top-level dependency closure out of docs/holodeck/index.html
// into a standalone ESM module, so the analysis can be pre-digested offline
// with the exact function the browser runs (not a parallel re-derivation).
//
//   node tools/extract_analyze.mjs > tools/ohs-analyze.mjs
//
// Faithfulness rule: nothing here reimplements analysis. It extracts the
// same top-level declarations (in source order, so TDZ order is preserved)
// that `analyze` transitively references, and exports analyze_offline().
// If a referenced name resolves to a browser global or a helper defined in
// another script file, extraction stops and names it — never guessed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HD = path.join(ROOT, "docs", "holodeck");
const SCRIPT = fs.readFileSync(path.join(HD, "index.html"), "utf8");

const sstart = SCRIPT.lastIndexOf('<script type="text/x-dc"', SCRIPT.indexOf("function analyze"));
const sopen = SCRIPT.indexOf(">", sstart) + 1;
const send = SCRIPT.indexOf("</script>", sopen);
const code = SCRIPT.slice(sopen, send);

const ast = parse(code, { ecmaVersion: "latest", sourceType: "script", locations: false });

// Top-level declarations: name -> {start, end, kind}
const top = new Map();
const record = (name, node) => { if (!top.has(name)) top.set(name, node); };
for (const stmt of ast.body) {
  if (stmt.type === "VariableDeclaration") {
    for (const d of stmt.declarations) {
      if (d.id.type === "Identifier") record(d.id.name, stmt);
    }
  } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
    record(stmt.id.name, stmt);
  } else if (stmt.type === "ClassDeclaration" && stmt.id) {
    record(stmt.id.name, stmt);
  }
}

// Local declarations within a subtree (params + declared names), so we don't
// mistake locals for top-level references. Pattern-bound names count too:
// `({ a, b, sim }) => ...` binds a/b/sim and their uses in the body are local.
function localNames(node) {
  const out = new Set();
  function bindPattern(p) {
    if (!p) return;
    if (p.type === "Identifier") { out.add(p.name); return; }
    if (p.type === "ObjectPattern") { for (const pr of p.properties) { if (pr.type === "RestElement") bindPattern(pr.argument); else bindPattern(pr.value); } return; }
    if (p.type === "ArrayPattern") { for (const el of p.elements) bindPattern(el); return; }
    if (p.type === "AssignmentPattern") { bindPattern(p.left); return; }
    if (p.type === "RestElement") { bindPattern(p.argument); return; }
  }
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      for (const p of n.params || []) bindPattern(p);
    }
    if (n.type === "VariableDeclarator" && n.id) { if (n.id.type === "Identifier") out.add(n.id.name); else bindPattern(n.id); }
    if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) out.add(n.id.name);
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(node);
  return out;
}

// Identifier references in a subtree that could be top-level (skip object
// keys, member property names, labels, declarations, and binding PATTERNS —
// a destructured `({ a, b, sim })` is a local binding, not a reference).
function refsIn(node) {
  const out = new Set();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Identifier") { out.add(n.name); return; }
    if (n.type === "MemberExpression") {
      if (n.object.type === "Identifier") out.add(n.object.name);
      walk(n.object);
      return;
    }
    if (n.type === "Property" && n.computed === false) { walk(n.value); return; }
    if (n.type === "LabeledStatement") { walk(n.body); return; }
    if (n.type === "BreakStatement" || n.type === "ContinueStatement") return;
    // Functions: params are binding patterns, never references. Walk the body
    // only (a FunctionDeclaration's own name is its declaration).
    if (n.type === "FunctionDeclaration") { if (n.id) out.add(n.id.name); walk(n.body); return; }
    if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") { walk(n.body); return; }
    if (n.type === "AssignmentPattern") { return; } // param default pattern; ignore
    if (n.type === "RestElement") { return; }
    if (n.type === "ObjectPattern" || n.type === "ArrayPattern") { return; }
    if (n.type === "CatchClause") { walk(n.body); return; }
    if (n.type === "VariableDeclarator") { if (n.id.type === "Identifier") out.add(n.id.name); walk(n.init); return; }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(node);
  return out;
}

const analyzeNode = ast.body.find(s => s.type === "FunctionDeclaration" && s.id && s.id.name === "analyze");
if (!analyzeNode) { console.error("no analyze fn"); process.exit(1); }

// BFS closure over referenced top-level decls
const needed = new Set(["analyze"]);
const queue = ["analyze"];
while (queue.length) {
  const name = queue.shift();
  const node = top.get(name);
  if (!node) continue;
  const locals = localNames(node);
  for (const ref of refsIn(node)) {
    if (needed.has(ref) || locals.has(ref)) continue;
    if (top.has(ref)) { needed.add(ref); queue.push(ref); }
  }
}

// Global/browser names referenced by the closure but not defined top-level:
// report, don't guess.
const seen = new Set();
for (const name of needed) {
  const node = top.get(name);
  const locals = localNames(node);
  for (const ref of refsIn(node)) {
    if (top.has(ref) || locals.has(ref) || seen.has(ref)) continue;
    if (/^[A-Z_$]/.test(ref) || ["Math","Date","Object","Array","Set","Map","String","Number","JSON","RegExp","Promise","parseInt","parseFloat","Infinity","NaN","undefined","console","window","document","location","navigator","URL","AbortController","setTimeout","clearTimeout","requestAnimationFrame","cancelAnimationFrame","performance","crypto","TextDecoder","TextEncoder","fetch","Blob","File","FileReader","Worker","localStorage","indexedDB","opfsRead","opfsWrite","idbPut","idbGet","hdT","HD_TR"].includes(ref)) { seen.add(ref); continue; }
    console.error(`UNRESOLVED top-level reference inside closure: ${ref} (from ${name})`);
    process.exit(1);
  }
}

// Emit: needed top-level decls in source order + export.
const decls = [...needed].map(name => top.get(name)).sort((a, b) => a.start - b.start);
let out = "// Generated by tools/extract_analyze.mjs from docs/holodeck/index.html.\n";
out += "// The app's own analyze() plus its transitive top-level closure.\n\n";
for (const d of decls) {
  out += code.slice(d.start, d.end) + "\n";
}
out += "\nexport function analyze_offline(corpus, htmlMap) { return analyze(corpus, htmlMap); }\n";

// sanity: analyze must be defined and referenceable
if (!out.includes("function analyze")) { console.error("emitted module lost analyze"); process.exit(1); }
process.stdout.write(out);
console.error(`extracted ${needed.size} top-level decls (${out.length} bytes)`);