// reading-worker.js — module worker. Builds a compact index from an EO reading (.jsonl.zst).
// Strategy: first check if the repo already has a pre-built index.json beside the .zst; if so,
// fetch it directly (no decompression). Otherwise download + decompress in memory, index, and
// write only the compact index to OPFS — never the raw decompressed JSONL.
const SRC_URL = 'https://raw.githubusercontent.com/clovenbradshaw-ctrl/ohs-custody/main/ground-readings/f3affd2e11370118-causalTextPerceiver_reviseTextFold_refresh25.jsonl.zst';
async function dirOf(path) { let d = await navigator.storage.getDirectory(); for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create: true }); return d; }
// zstd frame header → declared content size (null if the frame doesn't declare one).
function frameSize(b) { if (b[0] !== 0x28 || b[1] !== 0xB5 || b[2] !== 0x2F || b[3] !== 0xFD) throw new Error('not a zstd frame');
  const fhd = b[4], fcs = fhd >> 6, single = (fhd >> 5) & 1, did = [0, 1, 2, 4][fhd & 3]; let o = 5 + (single ? 0 : 1) + did;
  const n = fcs === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcs]; if (!n) return null; let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + b[o + i]; return n === 2 ? v + 256 : v; }
const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
function buildIndex(lines, url, cur2, t0) {
  let cur = null, seq = 0, bad = 0;
  const src = {}; const S = s => src[s] || (src[s] = { chunks: 0, chars: 0, ops: {}, terrain: {}, kinds: {}, cast: {}, bonds: {}, idChurn: {} });
  const cast = new Map(); const bonds = new Map(); const canon = new Map(); const ids = new Map(); const kinds = {}; const order = [];
  const onLine = l => { if (!l) return; let j; try { j = JSON.parse(l); } catch (x) { bad++; return; }
    if (j.schema === 'Encounter@1') { cur = j.source; seq++; const X = S(cur); X.chunks++; X.chars += j.extent || 0; if (!order.includes(cur)) order.push(cur); return; }
    if (j.schema !== 'DeltaFold@1' || !cur) return; const X = S(cur);
    for (const o of j.operations || []) { const c = o.consequence || {}; const k = o.operator + '/' + (c.kind || '?'); inc(kinds, k); inc(X.kinds, k); inc(X.ops, o.operator); inc(X.terrain, o.terrain);
      const v = o.payload && o.payload.value; if (!v) continue;
      if (v.schema === 'EOReferent@1') { const id = v.id; let R = cast.get(id); if (!R) { R = { id, surfaces: [], standing: v.standing, mentions: 0, src: {}, first: cur, firstSeq: seq }; cast.set(id, R); } (v.surfaces || []).forEach(s => { if (!R.surfaces.includes(s)) R.surfaces.push(s); }); R.mentions = Math.max(R.mentions, v.mentions || 0); R.standing = v.standing || R.standing; inc(R.src, cur); inc(X.cast, (v.surfaces || [id])[0]); }
      else if (v.schema === 'EOHyperedge@1') { const P = (v.participants || []).map(p => p.surface || p.surfaceKey || '?'); if (P.length < 2) continue; const key = P.slice(0, 2).sort().join(' — '); let B = bonds.get(key); if (!B) { B = { a: P[0], b: P[1], n: 0, rel: {}, pos: 0, neg: 0, src: {}, first: cur, firstSeq: seq }; bonds.set(key, B); } B.n++; inc(B.rel, v.relation || '?'); if ((v.meta && v.meta.polarity) === '-') B.neg++; else B.pos++; inc(B.src, cur); inc(X.bonds, key); }
      else if (v.schema === 'EOCanonicalHyperedge@1') { const P = (v.participants || []).map(p => p.value); if (P.length < 2) continue; const key = P.slice(0, 2).sort().join(' — '); let B = canon.get(key); if (!B) { B = { a: P[0], b: P[1], n: 0, alts: {}, src: {} }; canon.set(key, B); } B.n++; (v.participants || []).forEach(p => (p.alternatives || []).forEach(a => { if (a !== p.value) inc(B.alts, a); })); inc(B.src, cur); }
      else if (v.schema === 'EOIdentityAlternative@1') { const key = v.left + ' ↔ ' + v.right; let I = ids.get(key); if (!I) { I = { left: v.left, right: v.right, n: 0, events: {}, src: {} }; ids.set(key, I); } I.n++; inc(I.events, c.kind || v.standing || '?'); inc(I.src, cur); inc(X.idChurn, key); }
      else if (c.kind === 'identity_split' || c.kind === 'identity_reading_refused' || c.kind === 'identity_hypothesis_supported') { const key = c.identity || (o.inputs || []).join(' ↔ '); let I = ids.get(key); if (!I) { I = { left: (o.inputs || [])[0] || key, right: (o.inputs || [])[1] || '', n: 0, events: {}, src: {} }; ids.set(key, I); } I.n++; inc(I.events, c.kind); inc(I.src, cur); inc(X.idChurn, key); }
    } };
  lines.forEach(onLine);
  if (bad) throw new Error(bad + ' of ' + lines.length + ' lines failed to parse.');
  const top = (m, n, sc) => [...m.values()].sort((a, b) => sc(b) - sc(a)).slice(0, n).map(x => ({ ...x, srcN: Object.keys(x.src || {}).length }));
  const trim = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 25));
  Object.values(src).forEach(X => { X.cast = trim(X.cast); X.bonds = trim(X.bonds); X.idChurn = trim(X.idChurn); });
  return { schema: 'FoldReadingIndex@2', from: url, cursor: cur2, builtAt: new Date().toISOString(), ms: Date.now() - t0, lines: lines.length, bad, encounters: seq, order, sources: src, kinds,
    castTotal: cast.size, cast: top(cast, 3000, x => x.mentions * 10 + Object.keys(x.src).length),
    bondsTotal: bonds.size, bonds: top(bonds, 3000, x => x.n + 3 * Object.keys(x.src).length),
    canonTotal: canon.size, canon: top(canon, 1500, x => x.n),
    identitiesTotal: ids.size, identities: top(ids, 1500, x => x.n) };
}
self.onmessage = async e => {
  try {
    const { url = SRC_URL, out = 'reading-refresh25.index.json' } = e.data || {};
    const t0 = Date.now();
    // 1. Check for a pre-built index in the repo (no download or decompression needed).
    const prebuiltUrl = url.replace(/\.zst$/, '.index.json');
    postMessage({ stage: 'checking' });
    const prebuilt = await fetch(prebuiltUrl).then(r => r.ok ? r.json() : null).catch(() => null);
    if (prebuilt && prebuilt.schema === 'FoldReadingIndex@2') {
      const dir = await dirOf('ohs-custody');
      const fh = await dir.getFileHandle(out, { create: true }); const w = await fh.createWritable(); await w.write(JSON.stringify(prebuilt)); await w.close();
      postMessage({ done: true, index: { lines: prebuilt.lines, bad: prebuilt.bad, encounters: prebuilt.encounters, sources: Object.keys(prebuilt.sources || {}).length, cast: prebuilt.castTotal, bonds: prebuilt.bondsTotal, canon: prebuilt.canonTotal, identities: prebuilt.identitiesTotal, ms: Date.now() - t0, from: 'repo-prebuilt', topCast: (prebuilt.cast || []).slice(0, 12).map(c => c.surfaces[0] + ' (' + c.mentions + ', ' + c.srcN + ' sources, ' + c.standing + ')'), topBonds: (prebuilt.bonds || []).slice(0, 10).map(b => b.a + ' — ' + b.b + ' ×' + b.n + ' in ' + b.srcN), churn: (prebuilt.identities || []).slice(0, 8).map(i => i.left + ' ↔ ' + i.right + ' ×' + i.n + ' ' + JSON.stringify(i.events)) } });
      return;
    }
    // 2. No pre-built index: download + decompress in memory, index, write only the compact index.
    postMessage({ stage: 'downloading' });
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    postMessage({ stage: 'decompressing', mb: Math.round(buf.length / 1e6) });
    const M = await import('https://esm.sh/@bokuweb/zstd-wasm@0.0.27'); await M.init(); const raw = M.decompress(buf);
    const want = frameSize(buf); if (want !== null && raw.length !== want) throw new Error('decoder produced ' + raw.length + ' bytes; the zstd frame declares ' + want + '. Refusing a silent mis-decode.');
    if (raw.length < 1000 || raw[0] !== 123) throw new Error('decoder produced ' + raw.length + ' bytes that are not JSON lines');
    postMessage({ stage: 'indexing', pct: 0 });
    const lines = new TextDecoder().decode(raw).split('\n');
    const cur2 = await fetch(url.replace(/\.zst$/, '.cursor')).then(r => r.ok ? r.json() : null).catch(() => null);
    const index = buildIndex(lines, url, cur2, t0);
    if (cur2 && cur2.sequence && cur2.sequence !== index.encounters) throw new Error('Decoded ' + index.encounters + ' encounters; the reading’s cursor records ' + cur2.sequence + '.');
    const dir = await dirOf('ohs-custody'); const fh = await dir.getFileHandle(out, { create: true }); const w = await fh.createWritable(); await w.write(JSON.stringify(index)); await w.close();
    postMessage({ done: true, index: { lines: index.lines, bad: index.bad, encounters: index.encounters, sources: Object.keys(index.sources || {}).length, cast: index.castTotal, bonds: index.bondsTotal, canon: index.canonTotal, identities: index.identitiesTotal, ms: index.ms, topCast: index.cast.slice(0, 12).map(c => c.surfaces[0] + ' (' + c.mentions + ', ' + c.srcN + ' sources, ' + c.standing + ')'), topBonds: index.bonds.slice(0, 10).map(b => b.a + ' — ' + b.b + ' ×' + b.n + ' in ' + b.srcN), churn: index.identities.slice(0, 8).map(i => i.left + ' ↔ ' + i.right + ' ×' + i.n + ' ' + JSON.stringify(i.events)) } });
  } catch (err) { postMessage({ err: String(err && err.message || err) }); }
};
