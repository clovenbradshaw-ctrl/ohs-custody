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
        "seed: ohsSeed pulls transcripts/ + derived/ out of this same repo",
        "  async pullRepo(owner, repo, opt) {",
        "  // ── OHS Pages overlay: first-run seed. Pulls the custody corpus out\n"
        "  // of this same repo (tracks main, so it stays current) when the\n"
        "  // workspace is empty. Skipped once the visitor has any docs.\n"
        "  async ohsSeed() {\n"
        "    try { if (localStorage.getItem('ohs-pages-seeded-v1') === '1') return; } catch (e) {}\n"
        "    let docs = [];\n"
        "    try { docs = this.analysis().docs || []; } catch (e) {}\n"
        "    if (docs.length) { try { localStorage.setItem('ohs-pages-seeded-v1', '1'); } catch (e) {} return; }\n"
        "    const MACHINE_JSON = /(segments|speaker-bindings|entities|pages)\\.json$/;\n"
        "    await this.pullRepo('clovenbradshaw-ctrl', 'ohs-custody', { prefix: 'transcripts/', skipRe: MACHINE_JSON });\n"
        "    await this.pullRepo('clovenbradshaw-ctrl', 'ohs-custody', { prefix: 'derived/', skipRe: MACHINE_JSON });\n"
        "    try { localStorage.setItem('ohs-pages-seeded-v1', '1'); } catch (e) {}\n"
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
            if p.name == "VENDOR.md":
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

    # OHS instance overlay (re-applied after every re-vendor).
    overlay = apply_ohs_overlay()
    overlay_sha = sha256(DEST / "index.html")

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
