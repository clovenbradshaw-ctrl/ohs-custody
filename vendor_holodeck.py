#!/usr/bin/env python3
"""
vendor_holodeck.py -- vendor the holodeck app into ohs-custody/docs/holodeck
for GitHub Pages, with a provenance manifest so the underlying thing can be
updated by re-running this script.

Usage:
    python3 vendor_holodeck.py [/path/to/holodeck-checkout]

What it does:
  - Copies runtime files from the holodeck repo working tree into
    docs/holodeck/ (index.html, support.js, reading-worker.js, fold-net.js,
    holodeck-*.js except *.test.mjs/*.live.mjs, and the vendor/ subtree).
    fixtures/ and dev-only files are left out (nothing references them).
  - Writes docs/.nojekyll so Pages serves the app as plain static files.
  - Writes docs/holodeck/VENDOR.md recording upstream repo, commit SHA,
    per-file sha256, and any uncommitted working-tree files included.

Rules:
  - Never hand-edit anything under docs/holodeck/ except VENDOR.md's
    "local notes" section. All upstream changes arrive via re-vendor.
  - The OHS instance overlay below (OHS_OVERLAY_PATCHES) is the one
    exception: small, recorded string replacements applied to the vendored
    copy after every re-vendor, so this Pages instance boots onto the OHS
    corpus instead of an empty room. If an upstream change breaks a patch
    anchor, this script fails loudly -- read VENDOR.md, adjust the patch,
    re-run.
  - The app fetches OHS corpus data from this same repo at runtime via
    raw.githubusercontent.com URLs, so no data is duplicated here.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path("/Users/mlacy/Documents/3.0/ohs-custody")
DEST = ROOT / "docs" / "holodeck"
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("/Users/mlacy/Documents/3.0/holodeck")

TOP_LEVEL_JS = [
    "support.js", "reading-worker.js", "fold-net.js",
    "holodeck-ask.js", "holodeck-doors.js", "holodeck-echo.js",
    "holodeck-fort.js", "holodeck-hang.js", "holodeck-holons.js",
    "holodeck-ingest-player.js", "holodeck-map.js", "holodeck-match.js",
    "holodeck-media.js", "holodeck-reader.js", "holodeck-records.js",
    "holodeck-region.js",
]
TOP_LEVEL_JS = sorted(set(TOP_LEVEL_JS))

# OHS instance overlay: (description, old, new). Applied to the vendored copy
# after every re-vendor; each must match exactly once or the run aborts.
OHS_OVERLAY_PATCHES = [
    (
        "boot: seed the OHS corpus on first run with an empty workspace",
        "  componentDidMount() {\n    setTimeout(() => { try { this.netInit(); } catch (e) {} }, 800);",
        "  componentDidMount() {\n"
        "    setTimeout(() => { try { this.netInit(); } catch (e) {} }, 800);\n"
        "    setTimeout(() => { try { this.ohsSeed(); } catch (e) {} }, 1500);",
    ),
    (
        "seed: ohsSeed trickles transcripts/ + derived/ in small batches (priority first)",
        "  async pullRepo(owner, repo, opt) {",
        "  // ── OHS Pages overlay: lazy seed. One tree listing, then small\n"
        "  // addDocs batches so first paint lands in seconds and the rest\n"
        "  // fills in behind it. Priority docs (audit minutes, MHRC, newest\n"
        "  // transcripts) go first. Each background batch restores the\n"
        "  // visitor's view/selection/question so the trickle never yanks\n"
        "  // them around, and the import announcement stays cleared.\n"
        "  // FAST PATH FIRST: docs/holodeck/ohs-bundle.json holds every doc\n"
        "  // (text + pre-read eng) in ONE file. One fetch + one addDocs + one\n"
        "  // analysis pass = all data at once, no per-file fetches, no\n"
        "  // re-analysis per batch. If the bundle fetch fails, it falls back\n"
        "  // to the trickle path below.\n"
        "  async ohsSeed() {\n"
        "    let docs = [];\n"
        "    try { docs = this.analysis().docs || []; } catch (e) {}\n"
        "    if (docs.length) return;\n"
        "    const say = m => { try { this.setState({ busy: m }); } catch (e) {} };\n"
        "    try {\n"
        "      const B = await fetchDecodedOHS('ohs-bundle.json');\n"
        "      if (B && Array.isArray(B.docs) && B.docs.length) {\n"
        "        say('Loading OHS corpus · ' + B.docs.length + ' documents…');\n"
        "        let P = null;\n"
        "        try { P = await fetchDecodedOHS('ohs-analysis.json'); } catch (e) { P = null; }\n"
        "        if (P && Array.isArray(P.sts) && P.sts.length && P.docIds === B.docs.map(d => d.id).join(',')) {\n"
        "          P.corrKey = this.corrKey(this.corpusId());\n"
        "          this._ohsP = P; this._ohsA = null;\n"
        "          const cid = this.corpusId();\n"
        "          const added = { ...this.state.added, [cid]: B.docs };\n"
        "          this.saveAdded(added);\n"
        "          this.setState({ added, just: null, busy: '' });\n"
        "          return;\n"
        "        }\n"
        "        await this.addDocs(B.docs);\n"
        "        this.setState({ just: null, busy: '' });\n"
        "        return;\n"
        "      }\n"
        "    } catch (e) {}\n"
        "    const MACHINE_JSON = /(segments|speaker-bindings|entities|pages)\\.json$/;\n"
        "    const isSeedPath = p => /\\.txt$/i.test(p) && (p.indexOf('transcripts/') === 0 || p.indexOf('derived/') === 0) && !MACHINE_JSON.test(p);\n"
        "    let READINGS = {};\n"
        "    try { const rr = await fetch(new URL('ohs-readings.json', location.href).href, { cache: 'no-cache' }); if (rr.ok) READINGS = ((await rr.json()).entries) || {}; } catch (e) { READINGS = {}; }\n"
        "    let paths = null;\n"
        "    try {\n"
        "      const r = await fetch('https://api.github.com/repos/clovenbradshaw-ctrl/ohs-custody/git/trees/HEAD?recursive=1', { headers: { Accept: 'application/vnd.github+json' } });\n"
        "      if (!r.ok) throw new Error('tree ' + r.status);\n"
        "      paths = (await r.json()).tree.filter(x => x.type === 'blob' && isSeedPath(x.path)).map(x => x.path);\n"
        "    } catch (e) { paths = null; }\n"
        "    if (!paths) {\n"
        "      try {\n"
        "        const r = await fetch(new URL('ohs-seed.json', location.href).href, { cache: 'no-cache' });\n"
        "        if (r.ok) paths = (await r.json()).entries.map(x => x.path).filter(isSeedPath);\n"
        "      } catch (e) { paths = null; }\n"
        "    }\n"
        "    if (!paths || !paths.length) {\n"
        "      say('Could not reach GitHub to list the OHS corpus — retrying…');\n"
        "      setTimeout(() => { try { this.ohsSeed(); } catch (e) {} }, 90000);\n"
        "      return;\n"
        "    }\n"
        "    const PRIORITY = [/WELSCH/i, /MHRC/i, /SEP23-MINUTES/i, /DEC9/i, /2026-09-29/i, /2026-06-30/i, /sept23-audit/i, /2026-09-09/i, /2026-09-23-ce/i, /HID-2023/i];\n"
        "    const score = p => { for (let i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].test(p)) return i; return PRIORITY.length; };\n"
        "    paths.sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1));\n"
        "    const rawBase = 'https://raw.githubusercontent.com/clovenbradshaw-ctrl/ohs-custody/HEAD/';\n"
        "    const get = async p => {\n"
        "      try {\n"
        "        const r = await fetch(rawBase + p.split('/').map(encodeURIComponent).join('/'), { cache: 'no-cache' });\n"
        "        if (!r.ok) return null;\n"
        "        const t = await r.text();\n"
        "        if (t.trim().length < 40) return null;\n"
        "        const pre = READINGS[p];\n"
        "        return { title: p.split('/').slice(-2).join('/'), year: null, type: 'Repo file', text: t, url: 'https://github.com/clovenbradshaw-ctrl/ohs-custody/blob/HEAD/' + p, note: 'From ohs-custody · ' + p, ...(pre ? { measured: true, extra: { eng: pre.eng } } : {}) };\n"
        "      } catch (e) { return null; }\n"
        "    };\n"
        "    const pull = async ps => { const out = []; await Promise.all(ps.map(async p => { const d = await get(p); if (d) out.push(d); })); return out; };\n"
        "    let done = 0;\n"
        "    say('Loading OHS corpus · ' + done + ' / ' + paths.length + ' files…');\n"
        "    const first = await pull(paths.slice(0, 8));\n"
        "    done += first.length;\n"
        "    if (first.length) await this.addDocs(first);\n"
        "    for (let i = 8; i < paths.length; i += 20) {\n"
        "      say('Loading OHS corpus · ' + done + ' / ' + paths.length + ' files…');\n"
        "      await new Promise(r => setTimeout(r, 2000));\n"
        "      const S = this.state, k = { view: S.view, sel: S.sel, readDoc: S.readDoc, q: S.q, f: S.f };\n"
        "      const batchDocs = await pull(paths.slice(i, i + 20));\n"
        "      done += batchDocs.length;\n"
        "      if (batchDocs.length) { await this.addDocs(batchDocs); try { this.setState({ view: k.view, sel: k.sel, readDoc: k.readDoc, q: k.q, f: k.f, just: null }); } catch (e) {} }\n"
        "    }\n"
        "    this.setState({ just: null, busy: '' });\n"
        "  }\n"
        "  async pullRepo(owner, repo, opt) {",
    ),
    (
        "ingest: pullRepo accepts opt.prefix / opt.skipRe path filters",
        "    const files = tree.filter(x => x.type === 'blob' && textRe.test(x.path) && !skipDir.test(x.path));",
        "    let files = tree.filter(x => x.type === 'blob' && textRe.test(x.path) && !skipDir.test(x.path));\n"
        "    if (opt.prefix) files = files.filter(x => x.path === opt.prefix || x.path.indexOf(opt.prefix) === 0);\n"
        "    if (opt.skipRe) files = files.filter(x => !opt.skipRe.test(x.path));",
    ),
    (
        "ingest: never read this instance's own app shell (docs/) as corpus",
        "    const skipDir = /(^|\\/)(node_modules|vendor|dist|build|\\.git|coverage|target|\\.venv|venv|__pycache__|\\.next|\\.cache|\\.ipynb_checkpoints)(\\/|$)/i;",
        "    const skipDir = /(^|\\/)(node_modules|vendor|dist|build|\\.git|coverage|target|\\.venv|venv|__pycache__|\\.next|\\.cache|\\.ipynb_checkpoints|docs)(\\/|$)/i;",
    ),
    (
        "chrome: topic placeholder names the OHS audit, not a bridge collapse",
        "topicPlaceholder: inferred ? 'e.g. ' + inferred.name : 'e.g. the bridge collapse'",
        "topicPlaceholder: inferred ? 'e.g. ' + inferred.name : 'e.g. the OHS audit'",
    ),
    (
        "loading: centered progress overlay (spinner + staged bar) during seed",
        '<sc-if value="{{ isBusy }}" hint-placeholder-val="{{ false }}">',
        '<sc-if value="{{ isBusy }}" hint-placeholder-val="{{ false }}">\n'
        '    <style>\n'
        "      @keyframes ohsSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }\n"
        "      .ohs-spinner { width:44px;height:44px;margin:0 auto;border:4px solid var(--s2);border-top-color:#8b5cf6;border-radius:50%;animation:ohsSpin 1s linear infinite; }\n"
        '    </style>\n'
        '    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);z-index:90">\n'
        "      <div style=\"background:var(--bg);border:1px solid var(--line2);border-radius:16px;padding:30px 36px;min-width:320px;max-width:90vw;text-align:center;box-shadow:0 14px 44px rgba(0,0,0,.4)\">\n"
        '        <div class="ohs-spinner"></div>\n'
        "        <div style=\"font:500 15px 'Hanken Grotesk';color:var(--ink);margin-top:18px;text-wrap:pretty\">{{ busy }}</div>\n"
        "        <div style=\"height:6px;background:var(--s2);border-radius:999px;margin-top:16px;overflow:hidden\">\n"
        "          <div style=\"height:100%;width:{{ seedPct }}%;background:#8b5cf6;border-radius:999px;transition:width .35s ease\"></div>\n"
        "        </div>\n"
        "      </div>\n"
        "    </div>\n",
    ),
    (
        "loading: expose seedPct in render",
        "dragging: S.dragging, isBusy: !!S.busy, busy: S.busy,",
        "dragging: S.dragging, isBusy: !!S.busy, busy: S.busy, seedPct: S.seedPct || 0,",
    ),
    (
        "loading: seed drives staged progress",
        "    try {\n"
        "      const B = await fetchDecodedOHS('ohs-bundle.json');\n"
        "      if (B && Array.isArray(B.docs) && B.docs.length) {\n"
        "        say('Loading OHS corpus · ' + B.docs.length + ' documents…');\n"
        "        let P = null;\n"
        "        try { P = await fetchDecodedOHS('ohs-analysis.json'); } catch (e) { P = null; }\n"
        "        if (P && Array.isArray(P.sts) && P.sts.length && P.docIds === B.docs.map(d => d.id).join(',')) {\n"
        "          P.corrKey = this.corrKey(this.corpusId());\n"
        "          this._ohsP = P; this._ohsA = null;\n"
        "          const cid = this.corpusId();\n"
        "          const added = { ...this.state.added, [cid]: B.docs };\n"
        "          this.saveAdded(added);\n"
        "          this.setState({ added, just: null, busy: '' });\n"
        "          return;\n"
        "        }\n",
        "    const stage = (pct, msg) => { try { this.setState({ seedPct: pct, busy: msg }); } catch (e) {} };\n"
        "    const stepPct = base => s => { stage(base + (s === 'fetch' ? 2 : s === 'decode' ? 12 : 22), 'Loading OHS corpus · ' + (s === 'fetch' ? 'downloading…' : s === 'decode' ? 'decoding…' : 'indexing…')); };\n"
        "    try {\n"
        "      stage(2, 'Loading OHS corpus · downloading…');\n"
        "      const B = await fetchDecodedOHS('ohs-bundle.json', stepPct(8));\n"
        "      if (B && Array.isArray(B.docs) && B.docs.length) {\n"
        "        stage(35, 'Loading OHS corpus · ' + B.docs.length + ' documents, decoding analysis…');\n"
        "        let P = null;\n"
        "        try { P = await fetchDecodedOHS('ohs-analysis.json', stepPct(45)); } catch (e) { P = null; }\n"
        "        if (P && Array.isArray(P.sts) && P.sts.length && P.docIds === B.docs.map(d => d.id).join(',')) {\n"
        "          P.corrKey = this.corrKey(this.corpusId());\n"
        "          this._ohsP = P; this._ohsA = null;\n"
        "          const cid = this.corpusId();\n"
        "          const added = { ...this.state.added, [cid]: B.docs };\n"
        "          this.saveAdded(added);\n"
        "          stage(100, 'Loading OHS corpus · ready');\n"
        "          this.setState({ added, just: null, busy: '', seedPct: 100 });\n"
        "          return;\n"
        "        }\n",
    ),
    (
        "analysis: rehydrate + fetchDecodedOHS helpers",
        "class Component extends DCLogic {",
        "// ── OHS Pages overlay: fetch a JSON artifact preferring its .zst twin,\n"
        "// decoded with the same zstd-wasm the app's reading-worker already uses.\n"
        "async function fetchDecodedOHS(path, onStep) {\n"
        "  const step = s => { try { onStep && onStep(s); } catch (e) {} };\n"
        "  const zst = path + '.zst';\n"
        "  try {\n"
        "    const r = await fetch(new URL(zst, location.href).href, { cache: 'no-cache' });\n"
        "    if (r.ok) {\n"
        "      step('fetch');\n"
        "      const M = await import('https://esm.sh/@bokuweb/zstd-wasm@0.0.27');\n"
        "      await M.init();\n"
        "      const raw = M.decompress(new Uint8Array(await r.arrayBuffer()));\n"
        "      step('decode');\n"
        "      const parsed = JSON.parse(new TextDecoder().decode(raw));\n"
        "      step('parse');\n"
        "      return parsed;\n"
        "    }\n"
        "  } catch (e) {}\n"
        "  const r2 = await fetch(new URL(path, location.href).href, { cache: 'no-cache' });\n"
        "  if (!r2.ok) throw new Error('artifact unavailable: ' + path);\n"
        "  const parsed2 = await r2.json();\n"
        "  step('parse');\n"
        "  return parsed2;\n"
        "}\n"
        "// Rehydrate the pre-digested analysis: ships sts once + names with their\n"
        "// statement objects; rebuild the index maps here, same shapes analyze()\n"
        "// produces, so the render sees a real graph.\n"
        "function rehydrateOhsAnalysis(P, docs) {\n"
        "  const byId = Object.fromEntries(P.sts.map(s => [s.id, s]));\n"
        "  const docById = Object.fromEntries(docs.map(d => [d.id, d]));\n"
        "  // Byte-addressed statements: text is null where the doc's cleaned text\n"
        "  // reproduces it from the byte span; derive it here so the payload stays\n"
        "  // small and the span stays the source of truth.\n"
        "  P.sts.forEach(s => { if (s.text == null) { const d = docById[s.doc]; if (d) s.text = d.text.slice(s.s, s.e); } });\n"
        "  const stsByDoc = {}; P.sts.forEach(s => { (stsByDoc[s.doc] = stsByDoc[s.doc] || []).push(s); });\n"
        "  return { stsByDoc, echoes: P.echoes, echoFloor: P.echoFloor, docs, sts: P.sts, names: P.names, byId, docById };\n"
        "}\n"
        "class Component extends DCLogic {",
    ),
    (
        "analysis: return the prebuilt analysis while the workspace is exactly the seeded set",
        "  analysis() {\n    const id = this.corpusId(); const seenU = new Set();",
        "  analysis() {\n"
        "    if (this._ohsP) {\n"
        "      const cur = ((this.state.added[this.corpusId()] || []).map(d => d.id).join(','));\n"
        "      if (this._ohsP.docIds === cur && this._ohsP.corrKey === this.corrKey(this.corpusId())) {\n"
        "        if (!this._ohsA) { try { this._ohsA = rehydrateOhsAnalysis(this._ohsP, this.state.added[this.corpusId()] || []); } catch (e) { this._ohsA = null; } }\n"
        "        if (this._ohsA) return this._ohsA;\n"
        "      } else { this._ohsP = null; this._ohsA = null; }\n"
        "    }\n"
        "    const id = this.corpusId(); const seenU = new Set();",
    ),
]


def apply_ohs_overlay():
    idx = (DEST / "index.html").read_text(encoding="utf-8")
    applied = []
    for desc, old, new in OHS_OVERLAY_PATCHES:
        n = idx.count(old)
        assert n == 1, f"overlay patch anchor matched {n}x (expected 1x): {desc}"
        idx = idx.replace(old, new)
        applied.append(desc)
    (DEST / "index.html").write_text(idx, encoding="utf-8")
    return applied


def sha256(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def build_seed_manifest():
    """The seed file list, so ohsSeed never depends on api.github.com
    (60 req/hr shared quota): one static fetch from raw.githubusercontent,
    which is unthrottled. Regenerated on every re-vendor."""
    import json

    entries = []
    for sub in ("transcripts", "derived"):
        for p in sorted((ROOT / sub).glob("*.txt")):
            rel = f"{sub}/{p.name}"
            entries.append({
                "path": rel,
                "title": rel,
                "url": f"https://github.com/clovenbradshaw-ctrl/ohs-custody/blob/HEAD/{rel}",
                "sha256": sha256(p),
                "bytes": p.stat().st_size,
            })
    out = DEST / "ohs-seed.json"
    out.write_text(json.dumps({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "entries": entries}, indent=1), encoding="utf-8")
    return len(entries), sha256(out)


def git_sha(src):
    r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(src),
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "not-a-git-checkout"


def git_status_short(src):
    r = subprocess.run(["git", "status", "--short"], cwd=str(src),
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def main():
    assert (SRC / "index.html").exists(), f"no index.html in {SRC}"
    assert (SRC / "support.js").exists(), f"no support.js in {SRC}"

    if DEST.exists():
        # Pristine re-vendor: wipe everything except VENDOR.md local notes.
        for p in sorted(DEST.rglob("*")):
            if p.name in ("VENDOR.md", "DIGEST-CONTRACT.md"):
                continue
            if p.is_file():
                p.unlink()
        for p in sorted(DEST.rglob("*"), reverse=True):
            if p.is_dir() and not any(p.iterdir()):
                p.rmdir()
    DEST.mkdir(parents=True, exist_ok=True)

    manifest = []
    missing = [f for f in ["index.html"] + TOP_LEVEL_JS if not (SRC / f).exists()]
    if missing:
        print(f"WARNING: upstream files absent, skipped: {missing}")

    for f in ["index.html"] + TOP_LEVEL_JS:
        s = SRC / f
        if not s.exists():
            continue
        d = DEST / f
        d.write_bytes(s.read_bytes())
        manifest.append((f, sha256(d)))

    # vendor/ subtree, minus nothing (all of it is imported at runtime).
    for s in sorted((SRC / "vendor").rglob("*")):
        if s.is_dir():
            continue
        rel = s.relative_to(SRC)
        if rel.parts[0] != "vendor":
            continue
        d = DEST / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_bytes(s.read_bytes())
        manifest.append((str(rel), sha256(d)))

    # Jekyll off: Pages must serve .js/.json untouched.
    (ROOT / "docs" / ".nojekyll").write_text("", encoding="utf-8")

    # Seed manifest: static file list for the lazy seed (no api.github.com).
    seed_n, seed_sha = build_seed_manifest()

    # OHS instance overlay (re-applied after every re-vendor).
    overlay = apply_ohs_overlay()
    overlay_sha = sha256(DEST / "index.html")

    # Re-extract + re-digest the corpus: ohs-analyze.mjs (the app's own
    # analyze), ohs-readings.json, ohs-bundle.json and ohs-analysis.json live
    # under docs/holodeck/ (the wipe removed them) and must be rebuilt now
    # from the freshly-vendored reader + app, so the app can load everything
    # pre-read instead of analyzing live.
    r = subprocess.run(["node", "tools/extract_analyze.mjs"], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit(f"extract_analyze failed: {r.stdout[-500:]} {r.stderr[-500:]}")
    with open(ROOT / "tools" / "ohs-analyze.mjs", "w", encoding="utf-8") as f:
        f.write(r.stdout)
    r = subprocess.run(["node", "tools/predigest.mjs"], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise SystemExit(f"predigest failed: {r.stdout[-500:]} {r.stderr[-500:]}")
    readings_sha = sha256(DEST / "ohs-readings.json")

    # One-shot bundle: all docs + pre-read eng in a single file.
    bundle_n = len(json.loads((DEST / "ohs-bundle.json").read_text(encoding="utf-8"))["docs"])
    bundle_sha = sha256(DEST / "ohs-bundle.json")
    bundle_bytes = (DEST / "ohs-bundle.json").stat().st_size

    upstream_sha = git_sha(SRC)
    upstream_status = git_status_short(SRC)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        "# Holodeck vendor manifest",
        "",
        f"Upstream: https://github.com/clovenbradshaw-ctrl/holodeck @ `{upstream_sha}`",
        f"Vendored: {now} by `python3 vendor_holodeck.py`",
        "",
        "## Scope",
        "",
        "Runtime files only: `index.html`, top-level app `*.js` (minus",
        "`*.test.mjs`/`*.live.mjs`, which are dev-only), and the `vendor/`",
        "subtree they import. `fixtures/` is excluded -- nothing references it.",
        "The app loads the OHS corpus from this same repo at runtime",
        "(raw.githubusercontent.com `ohs-custody` `main`), so no corpus data",
        "is duplicated here.",
        "",
        "## Working-tree inclusions (uncommitted upstream at vendor time)",
        "",
    ]
    dirty = [l for l in upstream_status.splitlines() if l.strip()]
    if dirty:
        lines += ["```"] + dirty + ["```", ""]
    else:
        lines += ["None -- working tree was clean.", ""]
    lines += ["## OHS instance overlay (re-applied by this script)", ""]
    lines += [f"- {d}" for d in overlay] + [""]
    lines += [f"Patched `index.html` sha256: `{overlay_sha}`", ""]
    lines += [f"Seed manifest `ohs-seed.json`: `{seed_n}` entries `{seed_sha[:12]}`", ""]
    lines += [f"Digest `ohs-readings.json`: `{readings_sha[:12]}` (engine pre-reads, schema `ohs-readings@1`)", ""]
    lines += ["## Files", ""]
    for rel, h in manifest:
        lines.append(f"- `{rel}` `{h[:12]}`")
    lines += ["", "## Local notes", "", "(hand edits land here only)", ""]
    (DEST / "VENDOR.md").write_text("\n".join(lines), encoding="utf-8")

    total = sum((DEST / rel).stat().st_size for rel, _ in manifest)
    print(f"vendored {len(manifest)} files ({total/1e6:.1f} MB) from {SRC} @ {upstream_sha[:12]}")
    if dirty:
        print("NOTE: upstream working tree was dirty -- see VENDOR.md")


if __name__ == "__main__":
    main()
