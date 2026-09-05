# OHS source custody, handoff package

Hand `CODER-BRIEF.md` to a coding agent with this directory as its working tree.

## Contents

| File | Role |
|---|---|
| `CODER-BRIEF.md` | The brief. Read this first. |
| `sources.json` | Manifest. 45 entries, 42 with URLs, 3 to be found. |
| `snip_and_archive.py` | Working runner. Fetch, hash, locate anchor, archive. |
| `ohs-source-custody.html` | The register. Open in a browser, no build step. |

## Quick start

    pip install requests pdfminer.six
    export IA_ACCESS_KEY=...        # https://archive.org/account/s3.php
    export IA_SECRET_KEY=...
    python3 snip_and_archive.py --only-priority     # the two pages most likely to change
    python3 snip_and_archive.py                     # everything else

Then open `ohs-source-custody.html` and paste `sources.enriched.json` into the box at the bottom.

## Known defect the brief asks the agent to fix first

Four entries are PDFs (`AUD-HID-2023`, `LEG-AMD1`, `LEG-AMD2`, `AUD-CTTE-DEC9`). PDF content streams
are compressed, so the anchor will not be present in the raw bytes and the locator will report
`anchor-not-found`. That is a false negative. Task 2 of the brief adds a text-layer path that keeps
the raw bytes as the object of record and records page and text offsets as a distinct span kind.

## The three documents that are missing

- The MHRC Title VI determination and staff investigative report, June 2026.
- The Metro Audit Committee agenda packet and minutes for 23 September 2025.
- A Truthout article cited without a retrievable URL.

The first two are the highest value items in the package. Until the MHRC determination is in hand,
the piece's central civil rights finding rests on a secondary source quoting it.

## Verified before shipping

The runner compiles, passes a ten case anchor-location suite covering exact bytes, wrapped
whitespace, smart quotes, named and numeric HTML entities, inline markup and true negatives, and was
run end to end against a local fixture server with recorded byte offsets confirmed to resolve back to
the expected text. Nothing here was fetched from a live source; the build environment blocked every
domain involved.
