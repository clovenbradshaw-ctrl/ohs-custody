# Holodeck vendor manifest

Upstream: https://github.com/clovenbradshaw-ctrl/holodeck @ `9c73f3cb523e1d67d97260451c82f273b990511a`
Vendored: 2026-10-01T22:25:52+00:00 by `python3 vendor_holodeck.py`

## Scope

Runtime files only: `index.html`, top-level app `*.js` (minus
`*.test.mjs`/`*.live.mjs`, which are dev-only), and the `vendor/`
subtree they import. `fixtures/` is excluded -- nothing references it.
The app loads the OHS corpus from this same repo at runtime
(raw.githubusercontent.com `ohs-custody` `main`), so no corpus data
is duplicated here.

## Working-tree inclusions (uncommitted upstream at vendor time)

```
?? holodeck-echo.js
?? holodeck-echo.test.mjs
```

## OHS instance overlay (re-applied by this script)

- boot: seed the OHS corpus on first run with an empty workspace
- seed: ohsSeed trickles transcripts/ + derived/ in small batches (priority first)
- ingest: pullRepo accepts opt.prefix / opt.skipRe path filters
- ingest: never read this instance's own app shell (docs/) as corpus
- chrome: topic placeholder names the OHS audit, not a bridge collapse
- loading: centered progress overlay (spinner + staged bar) during seed
- loading: expose seedPct in render
- lazy: open a source loads its text + derives statement texts from spans
- analysis: rehydrate + fetchDecodedOHS helpers
- analysis: return the prebuilt analysis while the workspace is exactly the seeded set
- honesty: banner in the Sources view discloses the loaded slice
- honesty: expose ohsLoadedNote in render
- honesty: ohsLoadedNote at top level of render
- launch: land on Sources, hide Start here
- launch: remove Start here from the nav

Patched `index.html` sha256: `30857a943b2f39a62a1efb23bce12495832d73a8c5fdcdd159c8d8f823f9e4cf`

Seed manifest `ohs-seed.json`: `140` entries `c0e601952be6`

Log `ohs.log`: `140` docs `ac721451dedd` `42.2MB` (schema `ohs-log@3`, spans + source pointers)

## Files

- `index.html` `1b2e9272936a`
- `fold-net.js` `8eb260d7c5ba`
- `holodeck-ask.js` `f3791b142e3f`
- `holodeck-doors.js` `724201428af9`
- `holodeck-echo.js` `401bf4bc20c0`
- `holodeck-fort.js` `a0367f94a571`
- `holodeck-hang.js` `5d80e157fcc2`
- `holodeck-holons.js` `c7ef3561dfa3`
- `holodeck-ingest-player.js` `b5164b42ad78`
- `holodeck-map.js` `525dedb6e074`
- `holodeck-match.js` `4c66d94d9a35`
- `holodeck-media.js` `7c735be8a876`
- `holodeck-reader.js` `ee20051e6fb8`
- `holodeck-records.js` `7547dfe1793e`
- `holodeck-region.js` `2eb75e8cc3da`
- `reading-worker.js` `4bb10ec9090e`
- `support.js` `8fe7df74405f`
- `vendor/bare-metal/public/data-chat.js` `084372cd8feb`
- `vendor/bare-metal/src/fold.js` `c9974ccc326a`
- `vendor/bare-metal/src/operators.js` `979bc1c0d782`
- `vendor/eoreader7/native/adapters/text/clause-spans.js` `966bcafa7994`
- `vendor/eoreader7/native/adapters/text/grain-typing.js` `04b7a26e4cf4`
- `vendor/eoreader7/native/adapters/text/morphology.js` `63ad28135e36`
- `vendor/eoreader7/native/adapters/text/priors.js` `8893d556a1d7`
- `vendor/eoreader7/native/adapters/text/pronouns.js` `058b06ed7013`
- `vendor/eoreader7/native/adapters/text/relations-gfp.js` `39818ba59987`
- `vendor/eoreader7/native/adapters/text/relations-language.js` `ced5e7109882`
- `vendor/eoreader7/native/adapters/text/relations-positional.js` `7bbe3a878f5d`
- `vendor/eoreader7/native/adapters/text/spans.js` `9d942fcb17e7`
- `vendor/eoreader7/native/adapters/text/surfaces.js` `51d42b67a39c`
- `vendor/eoreader7/native/adapters/text/wordclass.js` `9025253abe7d`
- `vendor/eoreader7/native/kernel/activation.js` `db42f97a3a7b`
- `vendor/eoreader7/native/kernel/contest.js` `0a85fc2056c1`
- `vendor/eoreader7/native/kernel/cube.js` `6cd6d10254eb`
- `vendor/eoreader7/native/kernel/rng.js` `18d6f2fa5202`
- `vendor/eoreader7/native/memory/activation.js` `d158635f02a8`
- `vendor/eoreader7/native/organs/aposiopesis.js` `7a81abe0423d`
- `vendor/eoreader7/native/organs/asserted.js` `493c6a4b0aa8`
- `vendor/eoreader7/native/organs/cast.js` `ed70847af4bc`
- `vendor/eoreader7/native/organs/cite.js` `5f6fb996afc2`
- `vendor/eoreader7/native/organs/fact-block.js` `e97380e55cef`
- `vendor/eoreader7/native/organs/grounding.js` `cb543b1d303c`
- `vendor/eoreader7/native/organs/heard-surfaces.js` `aedc2f293c86`
- `vendor/eoreader7/native/organs/hypergraph.js` `bfacf323db05`
- `vendor/eoreader7/native/organs/kind-standing.js` `b2a444fcb5c4`
- `vendor/eoreader7/native/organs/measure.js` `6845afc61639`
- `vendor/eoreader7/native/organs/source.js` `4eb878ddd527`
- `vendor/eoreader7/native/organs/speaker.js` `741b2302237b`
- `vendor/eoreader7/native/organs/web.js` `a2e373046c8b`
- `vendor/eoreader7/native/priors/morphology-eng.json` `77f972b82800`
- `vendor/eoreader7/native/priors/pos-eng.json` `ae005bc5438a`
- `vendor/the-fold/fold.js` `313bd5f3b7c3`

## Local notes

(hand edits land here only)
