# Ethical audit — the OHS Holodeck as built this session

Date: 2026-10-01. Auditor: the build agent. Method: affordance-by-affordance walkthrough of
the live build (commit `a792fc7`, verified in Brave headless via CDP), plus the falsification
record from this session. The standard being audited against is the tool's own purpose: an
investigative journalist must be able to trust that what the tool shows is byte-faithful to the
captured record, complete as claimed, and attributable to the right source. Anything that breaks
that trust is an ethical failure, not just a bug.

---

## The central finding

The tool was rebuilt this session around a sound architecture — one append-only log, readings as
projections, compute-once-and-append — but it shipped **partial views presented as the record**.
Every view (sources, names, assertions, search) reflects only the 12 of 140 sources whose
statements are folded in, **without any disclosure to the reader**. In an investigation where
*negative evidence is load-bearing* (the piece's audit-silence argument), a tool that silently
omits content can manufacture false absence. That is the single most serious ethical defect.

---

## Affordance-by-affordance

### 1. Launch / first paint
- **Broken:** the app launches on "Start here" (summary); the "sources" landing and the removal of
  Start-here are built but unshippable (the re-vendor errors out — see §10). The launch affordance
  therefore shows a summary the user asked to hide.
- **Ethical:** none beyond confusion.

### 2. The loading progress
- **Working, but disclosive failure:** the load folds in **6,686 of 57,642 statements (12 of 140
  sources)** and stops. The spinner clears; the app looks "done."
- **Ethical:** the reader is not told the corpus is 91% unloaded. A journalist could draft from the
  visible 12 sources believing they have surveyed the record. **The "X of N sources loaded" label
  was specified, built, and never shipped.**

### 3. Sources view
- **Broken (not shipped):** the requested Google-Drive-like affordance (file kinds/types,
  hierarchy) is unimplemented. Sources render as flat cards; a source's kind must be inferred from
  its path (`derived/` vs `transcripts/`).
- **Broken (live):** the card's title button is a *filter* (`sel`), not an open; there is no
  visible "open/read" control for text sources (only video thumbnails have `onRead`). A user must
  discover that selecting folds in statements.
- **Ethical:** the card shows a statement count from `A.stsByDoc[d.id]` — for the 128 unloaded
  sources this is **zero or absent**, silently. A source that has not been folded in is
  indistinguishable from a source that has no statements. (In this corpus, 41 sources genuinely
  have no extracted statements; the reader cannot tell them apart.)

### 4. Search
- **Broken, ethically:** search runs over loaded statements only. Searching "Wayfair"
  (a published lead) returns nothing unless that source is folded in first. **A journalist could
  conclude the corpus contains no Wayfair material — a false negative on an existing record.** The
  search affordance gives no "unsearched corpus" warning. This is the most direct way the tool can
  fabricate absence.

### 5. Names / Assertions
- **Broken, ethically:** the names index (15,145 names) and assertions (57,642 statements) are
  global in the log, but the *views* show only loaded-subset counts (verified: Names 1013,
  Assertions 4266 on a 12-source load). A name that exists only in an unloaded source is invisible
  until that source is folded. Same silent-omission failure as search.

### 6. Reading a source
- **Working (fold-on-open):** selecting/reading a source folds its statements (verified: 6,686 →
  7,592). But the fold is silent; nothing announces the corpus grew.
- **Working (span fix):** name spans are now recomputed against the shipped doc text (0 of 18,745
  misaligned). *Prior state was a grounding breach* — see §7.

### 7. Grounding / byte-accurate display (the tool's core claim)
- **Was broken, fixed late:** for 12,828 of 20,000 sampled statements, name spans pointed at the
  wrong bytes (e.g., a "Metro Davidson" span resolving to "ning. Really a"). The reader's
  byte-accurate highlighting — the entire evidentiary value of the tool — was wrong on a large
  fraction of statements, and the artifact that shipped it was never validated against the display.
- **Ethical:** this is quotational integrity failure at the tool's foundation. Had it gone to
  publication, a quote checked against the highlighted span could have been verified against the
  wrong bytes.

### 8. Source attribution
- **Was broken, fixed:** doc ids were `sha256(file bytes)[0:10]`; 28 distinct sources (mostly
  contract PDFs with identical extracted bytes) collapsed onto 10 ids, so statements from up to six
  different contracts attributed to one source. Any quote pulled in that state could have been
  attributed to the wrong contract. Fixed by hashing path+bytes; verified 140 unique ids.

### 9. The stash / revisits
- **Broken, was silently stale:** the IndexedDB stash keyed only on the corpus fingerprint, so a
  digest-shape change (e.g., the names.docs Set fix) was never detected and **stale, buggy
  artifacts kept being served to returning browsers**. Fixed by a digest version constant — but only
  after the journalist's browser had already cached the broken analysis.

### 10. The build/release pipeline
- **Broken (currently blocking):** `vendor_holodeck.py` errors with
  `TypeError: sequence item 16: expected str instance, tuple found` while writing the vendor
  manifest — a patch tuple has leaked into the `lines` list. Every fix built after `a792fc7`
  (honesty label, launch-on-sources, nav change) is therefore **unshippable** until this is fixed.
- **Process/ethical:** the session repeatedly shipped unvalidated changes to a public
  investigation tool — including states that rendered dead or partial — because no browser e2e
  existed until late (Chrome had been removed from the machine; Brave headless CDP finally worked).
  The journalist was told to hard-refresh against at least two broken builds. Shipping an
  investigation tool before validating its display is the process failure that made every content
  bug above a *published* harm rather than a local one.

---

## The ethical summary

1. **Silent incompleteness as the norm.** The tool presents a 12/140-source slice as a finished
   record, across every view, with no disclosure. In an investigation built partly on absence,
   this can manufacture false negative evidence.
2. **False attribution risk** (doc-id collision) and **false grounding** (span misalignment) both
   directly threaten the accuracy of any citation the tool supports. Both were shipped before
   being caught.
3. **Stale-artifact serving** meant returning browsers kept the broken analysis even after fixes.
4. **Unvalidated public shipping** is the meta-failure: the tool exists to be checkable, and the
   build process shipped uncheckable states.

## What is actually broken *right now* (live = a792fc7)

- No "sources loaded" disclosure anywhere. ← **fix this first**
- Search/names/assertions silently partial. ← same fix
- No open affordance on text-source cards (only select/filter). ← follow-up
- No Google-Drive-like source browsing. ← requested, unbuilt
- Launches on Start here, not Sources. ← built, unshippable
- `vendor_holodeck.py` TypeError blocks all of the above from deploying. ← **fix this to ship anything**

## The one-line integrity rule that would have prevented most of this

**Every view must say what slice of the log it is showing, and every displayed span must be
verified against the bytes that are displayed.** The architecture is sound; the disclosure and the
validation were missing, and the process shipped before either existed.