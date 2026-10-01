#!/usr/bin/env bash
# Local digest: re-extract the app's analyze, then re-read the corpus.
# Run after changing transcripts/, derived/, index.html's analyze, or the
# vendored reader, then commit the regenerated files under docs/holodeck/.
# (vendor_holodeck.py does the same on every re-vendor.)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d tools/node_modules ] || (cd tools && npm install)
node tools/extract_analyze.mjs > tools/ohs-analyze.mjs
node tools/predigest.mjs
git status --short tools/ohs-analyze.mjs docs/holodeck
