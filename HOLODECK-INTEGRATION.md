# Holodeck integration — what it is, what it reads today, what it doesn't

Written 2026-09-24, from direct code-reading this session (not from memory,
which was two days stale and had conflated several distinct things). If a
later pass finds this has drifted from the real code, trust the code.

## 1. Disambiguation first — "Holodeck" is one specific thing

"Holodeck" names exactly one renderer: `eoreader7/native/the-fold/surface/
block-surface.mjs`, exporting `renderSurface()`. Its own header states the
invariant plainly: **the surface is a projection, never an author** — it
takes already-built, already-gated data and emits one static HTML page. It
does no fetching, no parsing of source formats, no judgment calls.

Two things that share vocabulary but are **not** this:

- **`holograph.js`** (real `the-fold` repo root) draws one *conversation's*
  own referents/loops/voids for the chat app. It has never heard of OHS,
  Nashville, or this repo, and never will unless someone wires a chat
  session to read this custody data as attached material -- a different,
  unrelated integration from anything below.
- **The "lattice" pipeline** (`build-ohs-holograph.mjs` →
  `block-surface-lattice.mjs::renderLatticeSurface()` → `ohs-holograph.html`)
  looks like a sibling of Holodeck and covers the same OHS material, but is
  never branded "Holodeck" anywhere in its own code or output, reads a
  *different* source file (`sources.enriched.json`, not `sources.json`),
  and additionally consumes a hand-authored `plans/ohs/propositions.json`
  (schema `EOPropositions@1`) that nobody built from this repo's data. Keep
  the two apart -- they are not interchangeable and don't ingest the same
  shape.

Everything below is about the real, literally-Holodeck-branded pipeline:
`eoreader7/plans/derive-ohs.mjs` → `eoreader7/plans/drive-ohs.mjs` →
`block-surface.mjs` → `eoreader7/native/the-fold/ohs-surface-holograph.html`.

## 2. What it reads from this repo today

`derive-ohs.mjs` resolves this repo's own path directly (`../../ohs-custody`
from `eoreader7/plans`) and reads, from here:

- `sources.structured.json` and `sources.json` -- both arrays under
  `.entries`; merged, with `sources.structured.json` winning on field
  conflicts. The fields it actually uses per entry: `label`, `url`, `tier`,
  `doctype`, `anchor`, `used_for`, `claim`, `status`.
- `readings/<id>.json` -- one per capture. This is where
  `wayback_timestamp`, `sha256`, and `bytes` actually come from, along with
  `media_type`, `source_url`, `final_url`, `retrieved_at`, and `path`.
- `derived/<id>.txt` (or `.rendered.txt`) and `derived/<id>.pages.json` --
  optional text-layer/page-map sidecars.
- `bytes/<id>.bin` -- raw fallback bytes via the reading's own `path`.

**The anchor is never trusted from a stored offset.** `derive-ohs.mjs`
re-locates every `anchor` string fresh inside its own extraction of the
ground text and requires the located span's bytes to match the claim
verbatim. A stored `anchor_offset` -- if one existed -- would not be
consulted. This is the same discipline this repo's own custody register
already follows (`README.md`'s own "anchor-not-found is a false negative,
never silently accepted" stance) and it is worth keeping straight: an
anchor here is *earned by re-derivation*, not *asserted by a field*.

## 3. A real gap this session's own additions have

The 7 new `sources.json` entries added this session (`RT-24-DRONES`,
`RT-ARTS-CRUMBO`, `RT-ARTS-3M-QUESTION`, `TRUTHOUT-NDP-SURVEILLANCE`,
`CONTRIB-PROMISED-APARTMENTS`, `CONTRIB-NOTHING-ABOUT-US`,
`SCENE-NON-TRADITIONAL-HOUSING`) used a `capture: {status, wayback_timestamp,
sha256, bytes, anchor_offset}` sub-object, matching what this repo's
*existing* older entries already looked like on casual inspection. But per
§2, `derive-ohs.mjs` does not read `wayback_timestamp`/`sha256`/`bytes` from
that sub-object at all -- it reads them from a separate `readings/<id>.json`
file keyed by the entry's own `id`. **None of these 7 entries has a
corresponding `readings/` file.** A Holodeck render over this data would
still pick up each entry's `label`/`url`/`claim`/`anchor` (those *are* read
directly off the merged `sources.json`/`sources.structured.json` entry) but
would carry no real capture provenance for them, and any `anchor` field on
these 7 would need to survive re-location against real retained ground
text -- none of that ground text has been derived for these 7 yet either.
**Not fixed here** -- this document is instructions, not the fix. Building
`readings/RT-24-DRONES.json` etc. (fetch, hash, retain bytes) the way
`snip_and_archive.py` already does for the older entries is the next
concrete step if these 7 are meant to render through Holodeck specifically,
separately from their current, working use in this repo's own
`referents.eot.jsonl`/`fold-referents.mjs` system.

## 4. What Holodeck cannot currently read at all

`referents.eot.jsonl`, `fold-referents.mjs`, `detect-collisions.mjs`,
`detect-violations.mjs`, and `richtext-publication-timeline.json` are
invisible to both eoreader7 and the-fold today -- a repo-wide search for
each literal filename returns zero hits in either tree. There is no
partial, stale, or half-wired bridge to find; it simply doesn't exist yet.

This matters specifically for the governance-violation shape (the
`amount`/`requires`/`status`/`status_detail` fields on `txn-*` referents)
built this session: **neither Holodeck nor the lattice pipeline has any
concept of that shape at all.** It isn't a matter of pointing an existing
reader at a new file -- the shape itself (a value, a named requirement, a
compliance status) doesn't correspond to anything either pipeline's data
model already represents. Modeling it would be new work on the Holodeck
side, not just new data on this side.

## 5. What a real bridge would need to do, if built

Following the existing convention exactly (a new `eoreader7/plans/
derive-ohs-<something>.mjs`, sibling to `derive-ohs.mjs`, not a replacement
for it):

1. Import `fold` from this repo's `fold-referents.mjs` (already exported --
   the one change made to that file this session was exactly to make this
   possible) and replay `referents.eot.jsonl` into the in-memory referent
   index.
2. For each referent's `observe` fields, resolve the claim to a byte
   address the same way `derive-ohs.mjs` already does for everything
   else -- locate the field's `source`-cited text fresh inside retained
   ground bytes (fetching/deriving that ground text first, if it isn't
   already in `derived/`/`bytes/` for that source), never trust an
   unverified offset.
3. Emit either:
   - `PlanLedgerObservation@1`-shaped rows (the `links` shape
     `derive-ohs.mjs` already produces: `id/doc/at/verbatim/kind/fields/
     basis`) if the goal is folding referent facts into the *existing*
     Holodeck render alongside everything else it already shows, or
   - `EOPropositions@1`-shaped entries (the lattice pipeline's
     hand-authored `propositions.json` shape: `id/subject/verb/object/
     source/wording/note`, each `wording` required to appear verbatim in
     its cited source) if the goal is feeding the *lattice* pipeline's
     hyperlexicon instead.
4. Either path must pass `block-gate.mjs`'s real, current requirements:
   every emitted byte ref resolves verbatim in retained ground text, every
   metric-shaped row carries `dataset+source+asOf` provenance, zero
   unflagged proposal/giver rows, and the ground digest re-derives
   (tamper-evidence). A referent observed at "uncertain" or "default"
   confidence should almost certainly land as a disclosed gap in whichever
   shape is chosen, never silently promoted to a confident claim just
   because the gate demands *some* answer -- that would be reading the
   gate's requirement backwards.
5. The `amount`/`requires`/`status` governance-violation shape has no
   existing home in either pipeline's data model (per §4) -- representing
   it faithfully is real design work, most likely as new `fields` entries
   on a `links` row (Holodeck) or a new metrics registry entry declared in
   `ohs.surfacedef.json`'s own `metrics.registries`, not a one-line mapping.

Nothing in this section has been built. It is written so the next pass
does not have to re-derive the shape of the problem from scratch.
