# Brief: complete the source custody capture for the OHS investigation

You are working for an independent investigative journalist in Nashville. He is holding a standby
piece on Metro Nashville's Office of Homeless Services that publishes on a trigger: release of the
Metro internal audit, the firing of the OHS director, or a decision to run the retrospective now
that the architect of the system has resigned.

Before it runs, every anchored citation in that piece needs a chain of custody: the bytes the source
actually served, a hash of those bytes, the byte position of the quoted words inside them, and an
independent capture at the Internet Archive. Three of those documents do not exist in the register
yet and have to be found.

Your job is to complete that capture and hand back a single verifiable bundle.

---

## What you are given

| File | What it is |
|---|---|
| `sources.json` | The manifest. 45 entries, 42 with URLs, 3 without. Each carries an `id`, `url`, a short `anchor` string, a `claim` explaining why the source matters, and an empty `capture` block. |
| `snip_and_archive.py` | A working runner. Fetches, preserves raw bytes, hashes, locates the anchor, submits to the Wayback Machine, writes `sources.enriched.json`. Tested end to end against a local fixture. Its anchor locator has three passes and passes a 10 case suite covering entities, smart quotes, wrapped whitespace and inline markup. |
| `ohs-source-custody.html` | The register the journalist reads. Self contained, no build step, no browser storage. It renders the manifest and accepts a pasted `sources.enriched.json` to fill in hashes, byte spans and capture timestamps. |

Read all three before touching anything. The runner is not a sketch; do not rewrite it wholesale.
Extend it.

---

## Non negotiable rules

These are not style preferences. Breaking any of them makes the output useless for its purpose.

1. **Bytes on disk are exactly what the server sent.** No decoding, no prettifying, no stripping,
   no re encoding. Everything else is derived from them. If you need clean text, derive it into a
   separate file and leave the original untouched.
2. **Hash before anything reads the content.** SHA-256 over the raw response body.
3. **Report misses as misses.** If an anchor is not in the bytes, the row is `anchor-missing`. Never
   loosen the match until something hits. Never edit an anchor to make it pass. If you believe an
   anchor is badly chosen, say so in the report and leave it failing.
4. **Never invent a URL.** If you cannot find a document, the entry stays `not-located` with a note
   on what you tried. A plausible looking guessed URL is worse than an empty field, because it will
   be trusted.
5. **Do not circumvent paywalls or authentication.** Capture what is publicly served. If a source is
   paywalled, record `paywalled` and stop. The journalist holds subscriptions to several of these
   outlets and can supply cookies for sources he is entitled to read; ask rather than working around.
6. **Be a polite client.** Identify yourself in the User-Agent, respect a minimum 2 second delay
   between requests to the same host, back off on 429 and 503, and honour robots directives for
   crawling. You are retrieving a fixed list of documents a person could open by hand, not crawling.
7. **Do not fabricate a `readings/` handoff for a document you failed to fetch.** An empty span list
   is correct. A guessed offset is not.

---

## Task 1. Environment and baseline run

```
pip install requests pdfminer.six
export IA_ACCESS_KEY=...      # from https://archive.org/account/s3.php
export IA_SECRET_KEY=...
python3 snip_and_archive.py --only-priority
```

Run the priority rows first. `GOV-MDHA-CA` and `GOV-MAYOR-DIR` are the two most likely to change out
from under the piece: the first is a legacy page documenting the state before a HUD role migrated
into OHS, the second carries a job title that turns over as a vacated seat is refilled.

Then run the full set. Record the baseline: how many rows land `captured`, `bytes-held`,
`anchor-missing`, `fetch-failed`, `paywalled`.

---

## Task 2. Fix the PDF gap (do this before anything else in the full run)

**This is a real defect in the runner, not a hypothetical.** Four entries are PDFs:
`AUD-HID-2023`, `LEG-AMD1`, `LEG-AMD2`, `AUD-CTTE-DEC9`. Their anchors will never be found in the raw
bytes, because PDF content streams are compressed. The locator will report `anchor-not-found` on all
four and it will be wrong to conclude the text is absent.

Add a PDF path that does not compromise rule 1:

- Keep the raw `.bin` exactly as fetched. That stays the object of record and the thing that is hashed.
- Extract text with `pdfminer.six` into `derived/<id>.txt`, alongside a per page offset table.
- Locate the anchor in the extracted text.
- Record the hit as a **different span kind**, because a character offset into extracted text is not a
  byte offset into a PDF and must never be presented as one:

```json
"spans": [{
  "kind": "anchor-pdf",
  "page": 7,
  "text_offset": 2841,
  "text_length": 30,
  "extractor": "pdfminer.six 20240706",
  "derived_from_sha256": "<sha of the raw pdf>",
  "method": "pdf-text-layer"
}]
```

- If the PDF has no text layer (scanned), record `no-text-layer` and stop. Do not OCR silently. Flag
  it for the journalist to decide, since an OCR transcription is not a quotation source.
- Update the register HTML so a `anchor-pdf` span draws the ruler against the page count rather than
  the byte length, and labels itself as a page and text offset. Do not let it masquerade as a byte
  offset in the interface.

---

## Task 3. The hard fetch cases

Work through these deliberately. Each needs a different approach and each should end with either a
successful capture or a recorded, specific reason.

**Legistar** (`LEG-*`, six entries plus two `View.ashx` PDFs). ASP.NET application. The
`LegislationDetail.aspx` pages need both the `ID` and `GUID` query parameters. The `View.ashx`
attachment endpoints may require a `Referer` header pointing at the parent legislation page, and may
set a session cookie on first visit. Fetch the parent page first in the same session, then the
attachment. If the Wayback Machine refuses to capture Legistar, note it and fall back per Task 6.

**Substack** (`RT-*`, `PRO-*`, five entries). Cloudflare fronted. A plain request usually works with
a real User-Agent. If challenged, do not attempt to solve the challenge. These are the journalist's
own publications, so he can export canonical copies directly from Substack; ask for those rather
than fighting the edge.

**News outlets** (`SCN-*`, `BNR-*`, `AX-*`, `FOX-*`, `NC5-*`, `CTB-*`). Several are metered or
paywalled. Capture whatever is publicly served, and record `paywalled` plus how much of the article
body was present, because a capture that contains only the first two paragraphs cannot support a
quote from the tenth.

**`FOX-LAPSE` has a bad URL.** Its `url_status` is already marked `unconfirmed` in the manifest. The
URL was reconstructed from a citation, not retrieved, and it probably 404s. Find the real article by
searching Fox 17 for the Strobel House contract lapse coverage, quoting Metro Finance on payments
made through vouchers that bypassed the finance department. Replace the URL and record that you did.

**nashville.gov PDFs** carry a `?ct=` cache buster. Keep it. It is part of the URL that was cited and
dropping it may serve a different revision.

---

## Task 4. Find the three missing documents

These have no URL in the manifest. They are the highest value work in this brief, in this order.

### 4a. The MHRC Title VI determination and staff investigative report (`MHRC-DETERMINATION`)

The Metro Human Relations Commission released an investigative report at the end of June 2026 on a
Title VI complaint against OHS. Executive Director Davie Tucker issued a determination of probable
cause regarding a disproportionate adverse effect on Black women and women of color, upheld the
complaint, and referred it to conciliation under Rule 2.7 of the MHRC Rules and Procedures.

Currently the only located text of this determination is a secondary source quoting it. That means
the piece's central civil rights finding rests on a quoting source rather than the record. Fix that.

Search, in order:
- nashville.gov MHRC pages: reports, board and commission meeting agendas and packets, minutes.
  MHRC board packets frequently embed determinations as attachments.
- Metro Legistar for any MHRC board records.
- The Contributor article dated 5 August 2026 promised in print that source documents including the
  two MHRC reports would be linked in its online edition. Those links were never published. Check the
  Wayback Machine's history of that page in case an earlier revision carried them, and check the
  site's media library and uploads directory.
- Metro Council committee packets, where such a determination may have been circulated.

If you cannot find it, produce a **drafted public records request** addressed to MHRC naming the
determination letter, the staff investigative report, and the current status of the conciliation
process, with the correct Tennessee Public Records Act citation and the Metro records custodian
contact. Put it in `records-requests/mhrc-title-vi.md`. Do not send it.

### 4b. The Audit Committee agenda packet and minutes, 23 September 2025 (`AUD-PACKET-SEP23`)

This packet contains the councilmember's audit request verbatim, with its line item allegations and
dollar components, and the audit scope as adopted. It is the single document that would let the
journalist itemise the roughly 3.2 million dollar figure instead of repeating a summary of it.

Start from the meetings index already in the manifest as `AUD-CTTE-INDEX`, find the individual
meeting page for 23 September 2025, and pull every attachment on it: agenda, packet, minutes,
presentation, and any exhibit. Add each as its own manifest entry with its own id, rather than
lumping them under one.

While you are there, pull **every** Audit Committee meeting page and minutes document from September
2025 to the present. The absence of an OHS audit result across that whole run is itself evidence, and
it is only usable if the pages are captured and dated.

### 4c. The Truthout article (`TRUTHOUT-NDP`)

Cited in research as the source for the mayor's pre office record on digital privacy, including
advocacy for the Electronic Frontier Foundation and warnings about public private surveillance
partnerships modelled on New Orleans. No retrievable URL was produced, so the claim is currently
unsupported. Search Truthout for Nashville surveillance and Downtown Partnership coverage. If it does
not exist, mark the entry `not-found` and say so plainly, because the piece will have to drop or
re source that passage.

---

## Task 5. Resolve the BL2021-971 amendment sponsor

This is the hinge of the piece and it is currently unresolved.

The substitute ordinance had the OHS director appointed by, and serving at the pleasure of, the
Continuum of Care Homelessness Planning Council. The enacted code has the director appointed by the
mayor, with the planning council reduced to a seat in the interview process. Two amendments made that
change: Amendment No. 1 adopted at second reading on 7 June 2022, Amendment No. 2 adopted at third
reading on 21 June 2022. The Legistar action text credits one councilmember with moving to suspend
the rules to introduce a late amendment and offering Amendment No. 2. A separate amendment document
appears on its face to carry a different sponsor.

Two prior research passes failed to settle which sponsor removed the council's nomination power.
Settle it:

- Fetch both amendment PDFs, attachment IDs `10956003` and `11001383`, extract their text per Task 2,
  and record the sponsor line from each verbatim along with its page and text offset.
- Fetch the Metro Council minutes for both 7 June 2022 and 21 June 2022 and locate the amendment
  adoption entries.
- Note whether video of either reading is available and at what URL, but do not attempt to transcribe.

Write the finding to `findings/bl2021-971-amendment-sequence.md`: what each document says, the exact
sequence of the appointment provision across substitute, Amendment 1, Amendment 2 and enacted code,
and an explicit statement of what remains ambiguous if anything does. Do not resolve ambiguity by
picking the likelier answer.

---

## Task 6. Archive, with fallbacks

Primary target is the Wayback Machine via the SPN2 API, which the runner already implements including
job polling and reuse of recent captures.

When a capture fails, and some will, escalate in this order and record which tier succeeded:

1. Retry once after a backoff.
2. `archive.today`, submitted manually or via its documented endpoint. Record the resulting URL.
3. Local preservation only. The raw bytes plus headers plus hash already constitute a defensible
   local record. Mark the row `local-only` and explain why the remote capture failed.

Add an `archive_tier` field to each capture block so the register can distinguish an independently
attested capture from a purely local one. Update the register HTML to show the difference, because
these carry very different evidentiary weight and the interface should not flatten them.

Never claim a capture that did not happen. If SPN times out, the field stays null.

---

## Task 7. The monitoring set

Five entries are trigger monitors rather than citations: `AUD-FY2027`, `AUD-FY2026`, `AUD-INVEST`,
`AUD-CTTE-INDEX`, `GOV-CALVIN`. Their value is negative evidence, proving that on a specific date a
report was not published and a director was still in post.

Write `monitor.py`: re-fetches only these entries plus any Audit Committee pages discovered in Task
4b, hashes them, compares against the last recorded hash, and reports changes. Append a dated line to
`monitor.log` on every run whether or not anything changed, since an unbroken record of no change is
the thing that makes the eventual change meaningful.

Include a `--diff` flag that shows what changed in the extracted text. Do not send notifications, do
not add a daemon, do not add a scheduler. He will wire it into cron himself.

---

## Task 8. Build the bundle

Produce `ohs-custody-<YYYYMMDD>.zip`:

```
ohs-custody-20260905/
  README.md                    what this is, how it was made, what failed
  MANIFEST.sha256              sha256 of every file in the bundle
  sources.enriched.json        the completed manifest
  ohs-source-custody.html      register, updated per Tasks 2 and 6
  snip_and_archive.py          runner, as extended
  monitor.py                   the monitoring script
  bytes/                       raw response bodies, one .bin and one .headers.json per entry
  derived/                     extracted PDF text and page offset tables
  readings/                    per source handoff records with spans
  findings/
    bl2021-971-amendment-sequence.md
    capture-report.md
  records-requests/            drafted requests for anything not found
  custody.log                  append only run log
  monitor.log
```

`MANIFEST.sha256` must be generated last and must cover every file including itself being absent from
its own listing. Verify the bundle round trips: unzip to a clean directory, re-verify every hash,
confirm every `readings/*.json` span resolves to the expected content in the corresponding `bytes/`
or `derived/` file. A bundle whose own checksums do not verify is worse than no bundle.

---

## `findings/capture-report.md`

Write this for a person, not a machine. It is the document the journalist reads before deciding
whether the piece is publishable. Cover:

- Counts by outcome, against the baseline from Task 1.
- **Every anchor that did not match, one line each, with your assessment of why.** This is the most
  important section. An anchor missing because the page is script rendered is a nuisance. An anchor
  missing because the page has been edited since it was cited is a story.
- Any source where the live text now differs from what was quoted, with both versions.
- Which rows are `local-only` and therefore have no independent attestation.
- What you could not find, what you tried, and what you would try next.
- Anything you noticed that a person should look at, even if it was outside this brief.

---

## Acceptance criteria

- Every entry with a URL is either `captured`, `bytes-held`, `anchor-missing`, `paywalled`,
  `local-only` or `fetch-failed`, with a specific note. No entry is left in a default state.
- All four PDF entries have either an `anchor-pdf` span or a recorded `no-text-layer`.
- `FOX-LAPSE` has a working URL or is marked not found.
- The BL2021-971 sponsor question is answered from the documents, or its residual ambiguity is stated
  precisely.
- The bundle unzips clean and every checksum verifies.
- The register HTML loads the enriched manifest and renders correctly, including the PDF and archive
  tier distinctions.
- No fabricated URLs, no loosened anchors, no claimed captures that did not occur.

---

## Two things to leave alone

**The eoreader7 handoff.** `readings/<id>.json` is deliberately shaped for the journalist's own
reading engine: content addressed raw bytes, provenance, and byte offset spans rather than character
indexes into cleaned text. The adapter function at the bottom of `snip_and_archive.py` is empty on
purpose. Do not guess the signature of the engine's entry point. Keep writing the handoff records in
the existing shape and leave the call unwritten.

**The anchors.** They are short location strings chosen to be distinctive enough for a machine to
find and short enough to carry no expressive content. Do not lengthen them into full quotations and
do not shorten them into strings that will match in twenty places.

---

## If you get stuck

Say so, specifically, and move on to the next task. A bundle that is honest about four failures is
worth more than one that quietly papers over one. The whole point of this exercise is that a reader
can check the work, which only holds if the record of what could not be checked is equally reliable.
