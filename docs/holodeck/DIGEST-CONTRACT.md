# Holodeck digest contract

How a corpus instance (this one, or any other) hands its data to a Holodeck
so the app loads it pre-digested instead of analyzing 140+ documents live.

## The three artifacts

All live under `docs/holodeck/`, each shipped as plain `.json` plus a
`.json.zst` twin (zstd via the app's existing `@bokuweb/zstd-wasm` decode;
`.json` is the fallback). Pages gzips the `.json` on the wire anyway; the
`.zst` is the faster path.

| File | What it is |
|---|---|
| `ohs-seed.json` | File list fallback (paths + sha256). Used only if the GitHub API tree listing fails. |
| `ohs-readings.json` | Engine pre-reads: `{ [path]: { sha256, eng } }` where `eng` is the compact engine witness (`referents` with `surfaces/routes/grain`, `descriptorBeings`, `relations`, `ms`, `basis`). |
| `ohs-bundle.json` | Every doc: `docs[]` with `{ id, title, text, url, note, measured: true, extra: { eng } }`. `text` is the CLEANED doc text `analyze` produces (statement byte spans index into it). |
| `ohs-analysis.json` | The app's OWN `analyze()` output over the bundle, serialized: `{ docIds, sts[], names{}, echoes, echoFloor }`. Statement `text` is `null` wherever the doc's cleaned text reproduces it from the byte span (`s`/`e`) — the span, not a copy, is the source of truth. |

## Consumption contract (what the app does)

1. **Seed fast path** (`ohsSeed`): `fetchDecodedOHS('ohs-bundle.json')` and
   `fetchDecodedOHS('ohs-analysis.json')`. If `P.docIds === docs.map(d=>d.id).join(',')`,
   seed `state.added[custom]` = the bundle docs directly and stash `P`; **no
   `addDocs`, no `analyze` run**. Otherwise fall back to `addDocs` (which
   analyzes), or to the per-file trickle.
2. **`analysis()` guard**: while the seeded workspace's doc ids and
   `corrKey` still match `P.docIds`/`P.corrKey`, return the rehydrated
   prebuilt graph. The moment the visitor adds, removes, or files a
   correction, the guard releases and the app's own `analyze()` folds the
   change on top — the base is pre-digested, local actions append to it.
3. **`rehydrateOhsAnalysis(P, docs)`**: rebuilds `byId`, `stsByDoc`,
   `docById` from `P.sts` and the seeded docs, and derives every
   byte-addressed statement's text: `docById[st.doc].text.slice(st.s, st.e)`.
   These index maps the digest deliberately omits (JSON would triple the
   shared references).

## Producer contract (how to make these)

Run `tools/extract_analyze.mjs` (pulls the app's own `analyze` + closure out
of `index.html` via acorn — never re-implemented), then `tools/predigest.mjs`
which, per doc:

- reads `transcripts/*.txt` and `derived/*.txt` (the seed set),
- runs the vendored relation reader (`holodeck-reader.js`, byte-identical to
  the engine the app is wired to) → `ohs-readings.json`,
- runs `analyze_offline` (the extracted app analyze, under a jsdom shim)
  over the whole bundle → `ohs-analysis.json`,
- assigns **stable ids** (`ohs-` + sha256 of the file) so the digest and the
  bundle agree on `docById`,
- nulls statement `text` where the doc's cleaned text reproduces it from the
  byte span (verified at build time), so the payload stays small,
- writes the `.zst` twins.

`.github/workflows/digest.yml` reruns this on any push touching the corpus,
and `vendor_holodeck.py` reruns it on every re-vendor (and preserves this
file and `VENDOR.md` across the wipe).

## Faithfulness rules (do not break)

- The digest is the app's own code, run ahead of time. If it diverges, the
  page silently shows a different graph than a live analyze would.
- `names[name].sts` carries statement objects (not ids): a handful of
  analyze's name entries reference degenerate statements absent from `sts`,
  and mapping to ids would drop them.
- `docIds` in `ohs-analysis.json` must equal the bundle's doc ids exactly;
  the guard uses that equality to decide whether the prebuilt graph is still
  valid.
- Statement byte spans (`s`/`e`) index the CLEANED doc text in the bundle,
  not the raw capture. Rehydrate slices the cleaned text; the raw bytes stay
  the object of record in `transcripts/`/`derived/`.
- A changed corpus without a re-digest is harmless (the guard's `docIds`
  mismatch makes the app fall back to live analyze) but is not "instant".