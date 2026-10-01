// holodeck-ask.js — The Fold, inside Holodeck. A conversation over this workspace's own sources, answered by a
// model in this tab (WebLLM on WebGPU, Gemma 2 2B by default; Ollama on localhost if it is running) and held to The Fold's rules: retrieval is mechanical,
// the model is never shown an address or asked to cite, every sentence is attributed afterwards by what it
// shares with a passage, figures and names are checked against the bytes, and each turn folds to a one-line
// paraphrase (System 1) and an addressed record (System 2). What is sent on turn 400 is the summary, the
// records, and the last exchanges — never the transcript.
import * as FOLD from './vendor/the-fold/fold.js';
import { chunkSource, retrieve, buildSourceBlock, openQuestions, readRange, tokenize, foldDiacritics } from './vendor/eoreader7/native/organs/source.js';
import { meetingBoundaries } from './vendor/eoreader7/native/organs/speaker.js';
import { buildFactBlock, dedupeSourceText } from './vendor/eoreader7/native/organs/fact-block.js';
import { makeEngineRelationReader } from './holodeck-reader.js';
let _reader = null; const reader = () => _reader || (_reader = makeEngineRelationReader());
import { coverage, stripSelfCitations } from './vendor/eoreader7/native/organs/cite.js';
import { checkGrounding, unsupportedClaims } from './vendor/eoreader7/native/organs/grounding.js';
export { FOLD };

export const WEBLLM_MODELS = [
  { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B · in this tab', size: '1.4 GB' },
  { id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', label: 'SmolLM2 1.7B · in this tab', size: '1.0 GB' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B · in this tab', size: '1.1 GB' },
];
export const DEFAULT_MODEL = 'webllm:gemma-2-2b-it-q4f16_1-MLC';
export function webgpu() { return typeof navigator !== 'undefined' && !!navigator.gpu; }
let _wl = null, _wlId = null, _wlP = null;
// The engine downloads the weights once (the browser caches them), then runs them on this machine's GPU. Nothing leaves the tab.
export async function loadWebLLM(id, onProgress) {
  if (_wl && _wlId === id) return _wl;
  if (_wlP && _wlId === id) return _wlP;
  if (_wl && _wlId !== id) { try { await _wl.unload(); } catch (e) {} _wl = null; }
  _wlId = id;
  _wlP = (async () => { const W = await import('https://esm.run/@mlc-ai/web-llm'); const e = await W.CreateMLCEngine(id, { initProgressCallback: p => onProgress && onProgress(p) }); _wl = e; return e; })();
  try { return await _wlP; } catch (e) { _wlP = null; _wlId = null; throw e; }
}
export function webllmLoaded(id) { return !!_wl && _wlId === id; }
async function chatWebLLM(id, messages, { onToken, format, maxTokens, signal } = {}) {
  const eng = await loadWebLLM(id);
  // Gemma's chat template has no system turn: the system block rides at the head of the first user message instead.
  let msgs = messages;
  if (/gemma/i.test(id)) { const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'); msgs = messages.filter(m => m.role !== 'system').map(m => ({ ...m })); const u = msgs.find(m => m.role === 'user'); if (sys && u) u.content = sys + '\n\n' + u.content; }
  const req = { messages: msgs, temperature: 0.2, ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  if (format) req.response_format = { type: 'json_object', schema: JSON.stringify(format) };
  const onAbort = () => { try { eng.interruptGenerate(); } catch (e) {} };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (!onToken) { const r = await eng.chat.completions.create({ ...req, stream: false }); return { text: (r.choices[0] && r.choices[0].message.content) || '', stats: { eval_count: r.usage && r.usage.completion_tokens, prompt_eval_count: r.usage && r.usage.prompt_tokens } }; }
    const it = await eng.chat.completions.create({ ...req, stream: true, stream_options: { include_usage: true } }); let out = '', usage = null, t0 = performance.now();
    for await (const ch of it) { const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content; if (d) { out += d; onToken(out); } if (ch.usage) usage = ch.usage; }
    if (signal && signal.aborted) throw new Error('aborted');
    return { text: out, stats: { eval_count: usage && usage.completion_tokens, prompt_eval_count: usage && usage.prompt_tokens, total_duration: (performance.now() - t0) * 1e6 } };
  } finally { if (signal) signal.removeEventListener('abort', onAbort); }
}
export const OLLAMA = 'http://localhost:11434';
const BASE_PROMPT = 'Answer the question from the sources in this workspace. Answer in plain prose. Where the material covers it, answer from it. Where it does not, say what is missing instead of filling it in.';

// Derives a prompt grounded in what the workspace actually contains.
// The framing emerges from the sources rather than being pre-assigned.
export function buildBasePrompt(IX, summary) {
  let prompt = BASE_PROMPT;
  const topic = summary && summary.topic;
  if (topic) prompt += ' The conversation so far is about: ' + topic + '.';
  return prompt;
}

export async function probe(base = OLLAMA) {
  try {
    const r = await fetch(base + '/api/tags', { cache: 'no-store' });
    if (!r.ok) return { ok: false, why: 'Ollama answered ' + r.status };
    const j = await r.json(); const models = (j.models || []).map(m => ({ name: m.name, size: m.size, family: m.details && m.details.family, params: m.details && m.details.parameter_size }));
    return { ok: true, models };
  } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
}

// Passages: every kept source, chunked by the engine's own boundaries (blank lines, tabular rows), addressed by byte range.
export function index(docs) {
  const t0 = Date.now(); const chunks = []; const texts = {}; const docOf = {}; const used = new Map();
  for (const d of docs) { const text = d.text || ''; if (text.length < 40) continue;
    let name = String(d.title || d.id).replace(/#/g, '').slice(0, 90); const k = used.get(name) || 0; used.set(name, k + 1); if (k) name += ' (' + (k + 1) + ')';
    texts[name] = text; docOf[name] = d.id;
    let boundaries;
    try { const turns = meetingBoundaries(text); if (turns.length >= 3) boundaries = turns.map((t, i) => ({ start: t.start, end: i + 1 < turns.length ? turns[i + 1].start : text.length, label: t.speaker || null })).filter(b => b.end > b.start); } catch (e) {}
    try { for (const c of chunkSource(name, text, boundaries ? { boundaries } : {})) chunks.push(c); } catch (e) { try { for (const c of chunkSource(name, text)) chunks.push(c); } catch (e2) {} } }
  return { chunks, texts, docOf, ms: Date.now() - t0 };
}

async function chat(base, model, messages, opts = {}) {
  if (String(model).startsWith('webllm:')) return chatWebLLM(String(model).slice(7), messages, opts);
  const { onToken, format, maxTokens, signal } = opts;
  const body = { model, messages, stream: !!onToken, keep_alive: '3600s', options: { num_ctx: 4096, temperature: 0.2, ...(maxTokens ? { num_predict: maxTokens } : {}) } };
  if (format) body.format = format;
  const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error('Ollama ' + r.status + ': ' + (await r.text()).slice(0, 200));
  if (!onToken) { const j = await r.json(); return { text: (j.message && j.message.content) || '', stats: j }; }
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '', out = '', stats = null;
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (j.message && j.message.content) { out += j.message.content; onToken(out); }
      if (j.done) stats = j; } }
  return { text: out, stats };
}

// One turn. `conv` = { summary, history, turns }. `computed` is an optional block of values computed from the
// Records database (never asked of the model); it rides into the prompt as material and onto the record.
export async function turn(conv, IX, question, { base = OLLAMA, model = DEFAULT_MODEL, computed = null, reading = null, retrievalQ = null, resolved = null, ctx = 4096, onToken, onStage, signal } = {}) {
  const t0 = Date.now(); const turnNo = (conv.summary.turnCount || 0) + 1;
  const folded = conv.summary.records.flatMap(r => r.refs || []);
  onStage && onStage('retrieving');
  const qTerms = [...new Set(tokenize(retrievalQ || question))];
  const ranked = retrieve(IX.chunks, retrievalQ || question, 8, folded).map(c => narrow(c, qTerms));
  const history = conv.history.slice(-2).map(m => ({ ...m, content: m.content.length > 1200 ? m.content.slice(0, 1200) + '…' : m.content }));
  // THE SURF AND FOLD (eoreader7 / the-fold holon.js): the passages are read by the engine's own relation reader,
  // and what the model receives is that reading as defeasible NOTES plus only the byte-addressed spans that bound
  // each note — never the retrieved chunks themselves. A passage no note came from is withheld, and if nothing
  // bound at all, the model is told so in plain words instead of being handed raw text to fill from memory.
  onStage && onStage('reading');
  let relations = null, factBlock = null;
  try { const R = await reader(); relations = R(ranked); factBlock = buildFactBlock(relations, ranked, question); } catch (e) { factBlock = null; }
  const spanBlock = factBlock && factBlock.spans && factBlock.spans.length ? factBlock.spans.map(sp => '"' + sp.text + '"').join('\n\n') : null;
  const build = (off, facts) => {
    const raw = facts && !facts.empty ? spanBlock : buildSourceBlock(dedupeSourceText(off, relations));
    let sb = [facts ? facts.text : null, raw].filter(Boolean).join('\n\n');
    if (reading && reading.text) sb = (sb ? sb + '\n\n' : '') + 'What the reader established about the names asked about:\n' + reading.text;
    if (computed && computed.text) sb = (sb ? sb + '\n\n' : '') + 'Counted from the workspace records:\n' + computed.text;
    return FOLD.buildTurnMessages({ basePrompt: buildBasePrompt(IX, conv.summary), summary: conv.summary, history, question, sourceBlock: sb }); };
  let offered = ranked.slice(); let messages = build(offered, factBlock);
  while (offered.length > 1 && approxTokens(messages) > ctx - 760) { offered = offered.slice(0, -1); messages = build(offered, factBlock); }
  if (approxTokens(messages) > ctx - 760 && factBlock && factBlock.lines) { const fb = { ...factBlock, text: factBlock.text.split('\n').slice(0, 14).join('\n') }; messages = build(offered.slice(0, 2).map(c => ({ ...c, text: c.text.slice(0, 500) })), fb); }
  const notes = factBlock ? { lines: factBlock.lines || [], coverage: factBlock.coverage || 0, empty: !!factBlock.empty, omitted: factBlock.omitted || 0, spans: (factBlock.spans || []).length, sentences: factBlock.sentenceCount || 0 } : null;
  const sentChars = FOLD.charCount(messages);
  const transcriptChars = conv.history.reduce((n, m) => n + (m.content || '').length, 0) + question.length;
  onStage && onStage('answering');
  const res = await chat(base, model, messages, { onToken, signal, maxTokens: 700 });
  const answer = stripSelfCitations(res.text).text;
  onStage && onStage('checking');
  const attr = offered.length ? coverage(answer, offered, IX.chunks) : [];
  const castSet = new Set(((reading && reading.surfaces) || []).map(x => foldDiacritics(String(x).toLowerCase())));
  const resolveName = castSet.size ? n => castSet.has(foldDiacritics(String(n).toLowerCase())) : null;
  const grounding = checkGrounding(answer, offered, { question, resolveName });
  const unsupported = unsupportedClaims(grounding);
  const used = [...new Set(attr.map(a => a.ref).filter(Boolean))];
  const open = openQuestions(question, offered, used);
  const channels = [notes && !notes.empty ? 'notes' : null, offered.length ? 'material' : null, reading ? 'reading' : null, computed && computed.text ? 'records' : null, 'model'].filter(Boolean);
  const record = FOLD.buildWarrantRecord({ turn: turnNo, plane: 'world', gist: FOLD.mechanicalFoldLine(question, answer), channels, refs: used, unsupported, open });
  let summary = FOLD.addWarrantRecord(conv.summary, record);
  const foldLine = FOLD.mechanicalFoldLine(question, answer);
  onStage && onStage('folding');
  let refresh = { ok: false, why: '' };
  try {
    const up = FOLD.buildSummaryUpdatePrompt(summary, [...(summary.folds || []), foldLine]);
    const r2 = await chat(base, model, [{ role: 'system', content: FOLD.FOLD_SYSTEM_PROMPT }, { role: 'user', content: up }], { format: FOLD.FOLD_SCHEMA, maxTokens: 300, signal });
    const next = FOLD.updateSummaryWithFold(summary, foldLine, r2.text);
    const w = FOLD.extractSummaryFindings(summary.entities, next.entities, { records: FOLD.projectRecords(next), folds: next.folds });
    if (w.ok) { summary = next; refresh = { ok: true }; } else { summary = FOLD.advanceSummaryFold(summary, foldLine); refresh = { ok: false, why: w.findings.map(f => f.detail).join('; ') }; }
  } catch (e) { summary = FOLD.advanceSummaryFold(summary, foldLine); refresh = { ok: false, why: String(e.message || e) }; }
  const t = { n: turnNo, question, answer, used: used.map(ref => ({ ref, text: String(readRange(IX.texts, ref) || '').trim().slice(0, 700) })), offered: offered.map(c => ({ ref: c.ref, source: c.source, start: c.start, end: c.end, label: c.label, text: c.text.slice(0, 700) })),
    attr: attr.map(a => ({ text: a.text, ref: a.ref || null, via: a.via || null })), findings: (grounding.findings || []).map(f => ({ text: f.text, kind: f.atomKind, start: f.start, end: f.end, echoesQuestion: !!f.echoesQuestion })),
    examined: !!grounding.examined, record, foldLine, refresh, computed, reading: reading ? { lines: reading.lines } : null, notes, resolved: resolved && resolved.length ? resolved : null, sentChars, transcriptChars, messages, model, ms: Date.now() - t0,
    tokens: res.stats ? { out: res.stats.eval_count, in: res.stats.prompt_eval_count, secs: res.stats.total_duration ? res.stats.total_duration / 1e9 : null } : null };
  return { conv: { summary, history: [...conv.history, { role: 'user', content: question }, { role: 'assistant', content: answer }], turns: [...conv.turns, t] }, turn: t };
}

// A passage too long for a small model's window is narrowed to the stretch where the question's own words are
// densest. The window is a real byte range of the same source, so it keeps an address that reads back.
const WIN = 1400;
function narrow(c, qTerms) {
  if (c.text.length <= WIN) return c;
  const low = c.text.toLowerCase(); const hits = [];
  for (const t of qTerms) { let i = -1; while ((i = low.indexOf(t, i + 1)) >= 0 && hits.length < 400) hits.push(i); }
  hits.sort((a, b) => a - b); let best = 0, bestN = -1;
  for (let i = 0, j = 0; i < hits.length; i++) { while (hits[i] - hits[j] > WIN) j++; if (i - j > bestN) { bestN = i - j; best = hits[j]; } }
  let a = Math.max(0, best - 200); const nl = c.text.lastIndexOf('. ', a); if (nl > a - 300 && nl >= 0) a = nl + 2;
  const b = Math.min(c.text.length, a + WIN); const off = c.text.indexOf(c.text.slice(0, 40)); const baseStart = c.start + (off > 0 ? off : 0);
  const text = c.text.slice(a, b); const start = baseStart + a, end = start + text.length;
  return { ...c, start, end, text, ref: c.source + '#' + start + '-' + end, terms: new Set(tokenize(text)), narrowed: true };
}
const approxTokens = msgs => Math.ceil(msgs.reduce((n, m) => n + (m.content || '').length, 0) / 3.2);

// What eoreader7's own reading of the corpus says about the names a question uses: the referent, how it is
// written, its standing, and who it is held together with. Read off the ground reading's index, never a model.
export function readingBlock(rix, question) {
  if (!rix || !Array.isArray(rix.cast)) return null;
  const q = ' ' + foldDiacritics(String(question).toLowerCase()).replace(/[^a-z0-9\s]/g, ' ') + ' ';
  const norm = x => foldDiacritics(String(x).toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const hits = [];
  for (const c of rix.cast) { const surf = (c.surfaces || [c.id]).filter(Boolean); let hit = null;
    for (const x of surf) { const k = norm(x); if (k.length >= 4 && q.includes(' ' + k + ' ')) { hit = { c, m: x, k }; break; } }
    if (hit) hits.push(hit); }
  hits.sort((a, b) => b.k.length - a.k.length || (b.c.mentions || 0) - (a.c.mentions || 0));
  const seen = new Set(); const refs = []; const taken = [];
  for (const h of hits) {
    if (seen.has(h.c.id)) continue;
    if (taken.some(t => t.includes(h.k) || h.k.includes(t))) continue; // an overlapping fragment of an already-accepted match (compared on the same normalized form used to find it) -- same underlying phrase, not a distinct entity
    seen.add(h.c.id); taken.push(h.k); refs.push(h.c); if (refs.length >= 3) break;
  }
  if (!refs.length) return null;
  const lines = refs.map(c => { const surf = (c.surfaces || []).slice(0, 5); const nm = surf[0] || c.id;
    const bonds = (rix.bonds || []).filter(b => b.a === nm || b.b === nm).sort((a, b) => b.n - a.n).slice(0, 5).map(b => (b.a === nm ? b.b : b.a) + ' (' + b.n + ')');
    return { name: nm, text: nm + (surf.length > 1 ? ', also written ' + surf.slice(1).join(', ') : '') + '. Mentioned ' + (c.mentions || 0) + ' times across ' + (c.srcN || Object.keys(c.src || {}).length) + ' sources' + (c.standing ? '; standing: ' + c.standing : '') + '.' + (bonds.length ? ' Held together most often with ' + bonds.join(', ') + '.' : ''), surfaces: surf }; });
  return { lines, text: lines.map(l => l.text).join('\n'), surfaces: refs.flatMap(c => c.surfaces || []) };
}

export function emptyConv() { return { summary: FOLD.emptySummary(), history: [], turns: [] }; }

// DataChat's plan → execute path, with the plan proposed by the local model. The plan's SHAPE is decoding grammar
// (a JSON schema handed to Ollama); DataChat's executor then validates every table and field against the live
// schema, so the model can only ever propose a read. Mirrors bare-metal's planWithLLM, pointed at Ollama.
const PLAN_SCHEMA = { type: 'object', properties: {
  intent: { type: 'string', enum: ['query', 'aggregate', 'profile', 'search'] }, type: { type: 'string' }, record: { type: 'string' },
  filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'] }, value: { type: 'string' } }, required: ['field', 'op', 'value'] } },
  agg: { type: 'object', properties: { fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] }, field: { type: 'string' }, groupBy: { type: 'string' } } },
  sort: { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } }, limit: { type: 'integer' } },
  required: ['intent', 'type', 'filters'] };
const PLAN_SYSTEM = 'You translate a question about a database into a query plan. Pick table and field names only from the schema given.';
export async function planQuery(DC, state, q, model = DEFAULT_MODEL, base = OLLAMA) {
  const user = DC.schemaPrompt(state, q) + '\n\nQuestion: ' + q;
  const r = await chat(base, model, [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: user }], { format: PLAN_SCHEMA, maxTokens: 220 });
  const plan = DC.parsePlanJSON(r.text); if (!plan) return null;
  if (plan.agg && plan.agg.fn && !plan.agg.agg) plan.agg.agg = plan.agg.fn;
  if (plan.type) plan.type = DC.matchType(state, ' ' + plan.type + ' ') || (DC.knownTypes(state).includes(plan.type) ? plan.type : null);
  return plan;
}
export function reopen(IX, ref) { return readRange(IX.texts, ref); }
