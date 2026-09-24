#!/usr/bin/env python3
"""
scrape_metro_contracts.py -- discovers OHS and Social-Services (the
predecessor agency OHS split from, per the RS2022-1696/1697/1698/1699
ARPA resolutions already in this corpus) contracts from Nashville's own
public "Metro Clerk Contracts Search" (documents.nashville.gov), and
registers each as a real sources.json entry pointing at the actual PDF.

This script's job stops at discovery + registration. It does NOT fetch,
hash, or extract PDF text itself -- that is snip_and_archive.py's existing
job (fetch_and_locate_pdf), already proven this session. Every entry this
script writes gets the government database's own description as its
`claim` (a factual public-record summary, e.g. "GRANT CONTRACT
$2,469,671..."), never a fabricated anchor -- anchor location is left for
snip_and_archive.py to find honestly in the actual extracted PDF text, or
report as anchor-missing if the description's wording doesn't appear
verbatim in the document body (common for db-entered summaries).

The site mechanism (verified live, not assumed from docs):
  1. GET  /Request/Form/Contracts           -> fresh CSRF token + cookie
  2. POST /Request/Search (Index1-6 fields) -> HTML partial, one
     <tr class="data-file" data-href="/Request/Document/<token>?..."> per
     result, followed by <td> cells: token, contract#, status, party,
     dept, description, doctype, expiration.
  3. The final PDF is at /Request/Open/<token>?... (same query string,
     "Document" -> "Open") -- verified to work with NO session/cookies,
     i.e. a stable, anonymously-fetchable public URL, safe to hand to
     snip_and_archive.py's ordinary fetch() later.

Usage
    python3 av-pipeline/scrape_metro_contracts.py [--dry-run]

Writes
    New entries into sources.json (never touches sources.enriched.json,
    sources.structured.json, or the HTML register -- run
    snip_and_archive.py and the existing build_structured_json.py /
    register-splice step separately afterward, same as every other
    entry in this corpus).
"""
import argparse
import html
import json
import pathlib
import re
import sys

import requests

ROOT = pathlib.Path("/Users/mlacy/Documents/3.0/ohs-custody")
BASE = "https://documents.nashville.gov"
UA = "ohs-custody-register/1.0 (journalism source preservation; contact via publisher)"

SEARCHES = [
    {"Index3": "OFFICE OF HOMELESS SERVICES", "Index5": ""},
    {"Index3": "SOCIAL SERVICES", "Index5": "homeless"},
]

ROW_RE = re.compile(
    r'<tr[^>]*class="data-file"[^>]*data-href="([^"]+)"[^>]*>\s*'
    r'<td[^>]*>([^<]*)</td>\s*'      # hidden token (redundant with data-href)
    r'<td>([^<]*)</td>\s*'           # contract number
    r'<td>([^<]*)</td>\s*'           # status
    r'<td>([^<]*)</td>\s*'           # contracting party
    r'<td>([^<]*)</td>\s*'           # department
    r'<td>([^<]*)</td>\s*'           # description
    r'<td>([^<]*)</td>\s*'           # document type
    r'<td>([^<]*)</td>\s*'           # expiration date
    r'</tr>',
    re.DOTALL,
)


def get_token(session):
    r = session.get(f"{BASE}/Request/Form/Contracts", headers={"User-Agent": UA}, timeout=30)
    m = re.search(r'__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"', r.text)
    if not m:
        raise RuntimeError("could not find CSRF token on the search form")
    return m.group(1)


def run_search(session, token, index3, index5):
    data = {
        "__RequestVerificationToken": token,
        "Index1": "", "Index2": "", "Index3": index3,
        "Index4": "", "Index5": index5, "Index6": "EXECUTED CONTRACT",
    }
    r = session.post(f"{BASE}/Request/Search", data=data, headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    rows = []
    for m in ROW_RE.finditer(r.text):
        data_href, _hidden_token, contract_num, status, party, dept, desc, doctype, expiry = m.groups()
        token_match = re.search(r"/Request/Document/([^?]+)", data_href)
        unesc = lambda s: html.unescape(s).strip()
        rows.append({
            "doc_token": token_match.group(1) if token_match else None,
            "contract_number": unesc(contract_num),
            "status": unesc(status),
            "party": unesc(party),
            "department": unesc(dept),
            "description": unesc(desc),
            "doctype_label": unesc(doctype),
            "expiration": unesc(expiry),
        })
    return rows


def slug(s, maxlen=24):
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").upper()
    return s[:maxlen] or "X"


def entry_id_for(row, seen_ids):
    base = f"CONTRACT-{slug(row['contract_number'])}-{slug(row['party'])}"
    eid, n = base, 2
    while eid in seen_ids:
        eid = f"{base}-{n}"
        n += 1
    return eid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session = requests.Session()
    token = get_token(session)

    all_rows, seen_contract_nums = [], set()
    for params in SEARCHES:
        rows = run_search(session, token, params["Index3"], params["Index5"])
        print(f"  {params['Index3']!r} + keyword {params['Index5']!r}: {len(rows)} rows")
        for row in rows:
            key = (row["contract_number"], row["doc_token"])
            if key in seen_contract_nums:
                continue
            seen_contract_nums.add(key)
            all_rows.append(row)

    print(f"{len(all_rows)} unique contract rows total (by contract number + document token)")

    sj = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    existing_urls = {e.get("url") for e in sj["entries"] if e.get("url")}
    seen_ids = {e["id"] for e in sj["entries"]}

    added = 0
    for row in all_rows:
        if not row["doc_token"]:
            print(f"  SKIP (no document token): {row['contract_number']} {row['party']}")
            continue
        open_url = f"{BASE}/Request/Open/{row['doc_token']}?source=Contracts&sourceAppId=14&isArchived=True"
        if open_url in existing_urls:
            continue

        eid = entry_id_for(row, seen_ids)
        seen_ids.add(eid)
        doctype = "contract-pdf"
        label = f"Metro contract {row['contract_number']}: {row['party']} ({row['department']})"
        claim = (
            f"Nashville Metro Clerk's own public contract database describes this record as: "
            f"\"{row['description']}\" -- status {row['status']}, expiration {row['expiration'] or 'not listed'}. "
            f"This claim is the government database's own summary text, not yet verified against the actual "
            f"contract document's own wording; a real anchor will be searched for in the extracted PDF text "
            f"separately, and honestly marked anchor-missing if this summary's phrasing does not appear verbatim."
        )
        entry = {
            "id": eid,
            "label": label,
            "tier": "primary-record",
            "doctype": doctype,
            "url": open_url,
            "anchor": None,
            "claim": claim,
            "used_for": f"OHS/Social Services contract roster -- {row['party']}",
            "added": (
                f"Discovered via documents.nashville.gov's public Metro Clerk Contracts Search "
                f"(Department={row['department']!r}), scrape_metro_contracts.py, 2026-09-23. "
                f"Contract number {row['contract_number']}, internal document token {row['doc_token']}."
            ),
            "capture": {"status": "unverified", "wayback_timestamp": None, "sha256": None, "bytes": None,
                         "anchor_offset": None, "anchor_length": None, "content_type": None, "fetched_at": None},
        }
        if args.dry_run:
            print(f"  WOULD ADD {eid}: {label}")
        else:
            sj["entries"].append(entry)
            print(f"  added {eid}: {label}")
        added += 1

    print(f"\n{added} new contract entries {'would be added (dry run)' if args.dry_run else 'added'}")
    if not args.dry_run and added:
        (ROOT / "sources.json").write_text(json.dumps(sj, indent=2), encoding="utf-8")
        print(f"wrote sources.json ({len(sj['entries'])} total entries)")


if __name__ == "__main__":
    main()
