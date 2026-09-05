#!/usr/bin/env python3
"""
build_structured_json.py

Derives sources.structured.json from sources.enriched.json: the same facts,
flattened and annotated for easy programmatic reading, without requiring
familiarity with this project's internal pipeline field names. The enriched
manifest stays the authoritative, full-detail record; this is a derived
view onto it -- it adds nothing that isn't already in sources.enriched.json,
and every field here traces back to one there.

Usage
    python3 build_structured_json.py [--manifest sources.enriched.json] [--out sources.structured.json]
"""

import argparse
import json
import pathlib
from datetime import datetime, timezone

STATUS_MEANING = {
    "captured": "The anchor text was confirmed present in the fetched bytes, and this exact capture is independently archived (Wayback Machine or archive.today). The strongest state a row reaches.",
    "bytes-held": "The anchor text was confirmed present in the fetched/hashed bytes, but no independent archive of this capture exists yet.",
    "local-only": "The anchor text was confirmed present, but every independent-archiving attempt failed (no Internet Archive credentials, archive.today blocked scripted submission with a CAPTCHA). Only this project's own local hash backs it.",
    "anchor-missing": "The URL was fetched and hashed, but the claimed anchor text was NOT found in it. Read the entry's note: this usually means the live page has changed since it was cited, or the anchor lives on a different page/attachment than the one captured here.",
    "no-text-layer": "This PDF has no extractable text layer (looks scanned/image-only). Not OCR'd -- a human has to decide whether to transcribe it.",
    "not-located": "No URL exists for this claim yet. It is either still being searched for, or was superseded -- check the note for where the real answer ended up.",
    "fetch-failed": "The URL could not be fetched (network/HTTP error). See the note for the specific failure.",
    "unverified": "Not yet attempted.",
}

LOCATION_KIND_MEANING = {
    "byte-offset": "offset/length are a byte position in the raw HTTP response body (bytes/<id>.bin).",
    "pdf-page-text": "offset/length are a character position in text extracted from the PDF by pdfminer.six (derived/<id>.txt), on the given page. NOT a byte offset into the PDF itself -- PDF content streams are compressed.",
    "rendered-dom-text": "offset/length are a character position in text captured from a browser-rendered DOM (derived/<id>.rendered.txt), because the raw HTTP response for this URL is a JS application shell with no content in it at all.",
}


def location_for(cap):
    if cap.get("anchor_page") is not None and cap.get("rendered_text_offset") is None:
        return {
            "kind": "pdf-page-text",
            "page": cap.get("anchor_page"),
            "offset": cap.get("anchor_text_offset"),
            "length": cap.get("anchor_text_length"),
        }
    if cap.get("rendered_text_offset") is not None:
        return {
            "kind": "rendered-dom-text",
            "offset": cap.get("rendered_text_offset"),
            "length": cap.get("rendered_text_length"),
        }
    if cap.get("anchor_offset") is not None:
        return {
            "kind": "byte-offset",
            "offset": cap.get("anchor_offset"),
            "length": cap.get("anchor_length"),
        }
    return None


ARCHIVE_TIERS_INDEPENDENT = {"wayback-existing", "wayback-spn2", "archive-today", "wayback-historical"}


def archive_for(cap):
    tier = cap.get("archive_tier")
    if tier not in ARCHIVE_TIERS_INDEPENDENT:
        return None
    url = cap.get("wayback_url") or cap.get("archive_today_url")
    return {
        "tier": tier,
        "url": url,
        "timestamp": cap.get("wayback_timestamp"),
        "as_of_today": tier != "wayback-historical",
    }


def build_entry(e):
    cap = e.get("capture", {}) or {}
    sha = cap.get("sha256") or cap.get("rendered_sha256")
    out = {
        "id": e["id"],
        "label": e.get("label"),
        "url": e.get("url") or None,
        "tier": e.get("tier"),
        "claim": e.get("claim"),
        "anchor": e.get("anchor"),
        "used_for": e.get("used_for"),
        "status": cap.get("status"),
        "status_meaning": STATUS_MEANING.get(cap.get("status"), None),
        "evidence": {
            "sha256": sha,
            "bytes": cap.get("bytes"),
            "content_type": cap.get("content_type"),
            "fetched_at": cap.get("fetched_at"),
            "location": location_for(cap),
            "archive": archive_for(cap),
        } if sha else None,
    }
    if cap.get("note"):
        out["note"] = cap["note"]
    if e.get("added"):
        out["provenance_note"] = e["added"]
    if e.get("url_correction"):
        out["url_correction"] = e["url_correction"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="sources.enriched.json")
    ap.add_argument("--out", default="sources.structured.json")
    args = ap.parse_args()

    manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    entries = [build_entry(e) for e in manifest["entries"]]

    doc = {
        "case": manifest.get("case"),
        "case_label": manifest.get("case_label"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "derived_from": args.manifest,
        "how_to_use": (
            "Each entry is one claim in the piece and the source that supports it. "
            "`status` and `status_meaning` tell you how strong the evidence is -- do "
            "not treat every row the same. `evidence.location` tells you exactly where "
            "in the captured bytes the anchor sits and what kind of offset that is "
            "(see location_kind_meaning below) -- never assume it is a byte offset "
            "without checking `location.kind`. `evidence.archive` is null unless an "
            "independent third party (Internet Archive or archive.today) attests to "
            "this specific capture; a null archive with status local-only means only "
            "this project's own hash backs the claim. Quotes and dollar figures inside "
            "`claim` that are attributed to a specific person's letter or statement "
            "(see any entry whose claim says something like 'this is X's own "
            "characterization') are that person's allegation, not an established fact, "
            "even when this project has independently confirmed the document exists "
            "and says what is quoted."
        ),
        "status_meaning": STATUS_MEANING,
        "location_kind_meaning": LOCATION_KIND_MEANING,
        "entries": entries,
    }

    out_path = pathlib.Path(args.out)
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
