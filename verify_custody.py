#!/usr/bin/env python3
"""
verify_custody.py

Round-trips the custody record: for every entry that has capture data,
confirms the recorded hash matches the actual file on disk, and that any
anchor span (byte-offset or PDF anchor-pdf) actually resolves to real text
at the recorded position in that same file. This is the check Task 8 asks
for at bundle time -- "verify the bundle round trips... confirm every
readings/*.json span resolves to the expected content" -- run here early
and incrementally, so a bad capture is caught the day it happens rather
than the day the bundle ships.

This does not re-fetch anything and makes no network calls. It only checks
that the files already on disk are internally consistent with what the
manifest claims about them.

Usage
    python3 verify_custody.py [--manifest sources.enriched.json] [--out .]
"""

import argparse
import hashlib
import json
import pathlib
import sys


def check_entry(entry, out):
    eid = entry["id"]
    cap = entry.get("capture", {})
    status = cap.get("status")
    if status in (None, "unverified", "not-located"):
        return None  # nothing captured yet for this row, nothing to verify

    problems = []
    local_path = cap.get("local_path")
    if not local_path:
        return [f"status is {status!r} but capture.local_path is missing"]

    p = pathlib.Path(local_path)
    if not p.is_absolute():
        p = out / p
    if not p.exists():
        return [f"local_path {local_path} does not exist on disk"]

    raw = p.read_bytes()
    actual_sha = hashlib.sha256(raw).hexdigest()
    recorded_sha = cap.get("sha256")
    if recorded_sha and actual_sha != recorded_sha:
        problems.append(f"sha256 mismatch: manifest says {recorded_sha[:16]}..., file hashes to {actual_sha[:16]}...")
    if cap.get("bytes") is not None and cap["bytes"] != len(raw):
        problems.append(f"byte count mismatch: manifest says {cap['bytes']}, file is {len(raw)}")

    anchor = entry.get("anchor")

    # Byte-offset anchor, the HTML path.
    if cap.get("anchor_offset") is not None and anchor:
        off, length = cap["anchor_offset"], cap.get("anchor_length") or 0
        if off < 0 or off + length > len(raw):
            problems.append(f"anchor_offset {off}+{length} is out of bounds for {len(raw)} bytes")
        else:
            window = raw[off:off + length]
            if cap.get("anchor_method") == "exact-bytes" and window != anchor.encode("utf-8", "replace"):
                problems.append(f"exact-bytes anchor does not match the slice at {off}: got {window!r}")

    # PDF anchor-pdf span: checked against the derived text file, since the
    # offset is a character index into extracted text, not a byte index
    # into the (compressed) PDF that was just hashed above.
    if cap.get("anchor_text_offset") is not None and anchor:
        deriv = out / "derived" / f"{eid}.txt"
        if not deriv.exists():
            problems.append(f"anchor_text_offset is set but {deriv} is missing")
        else:
            text = deriv.read_text(encoding="utf-8")
            off, length = cap["anchor_text_offset"], cap.get("anchor_text_length") or 0
            if off < 0 or off + length > len(text):
                problems.append(f"anchor_text_offset {off}+{length} is out of bounds for {len(text)} chars")
            else:
                window = text[off:off + length]
                if cap.get("anchor_method") == "exact-text" and window != anchor:
                    problems.append(f"exact-text anchor does not match the slice at {off}: got {window!r}")

    # Cross-check the reader handoff record against the same file.
    reading_path = out / "readings" / f"{eid}.json"
    if reading_path.exists():
        try:
            r = json.loads(reading_path.read_text(encoding="utf-8"))
        except Exception as exc:
            problems.append(f"readings/{eid}.json is not valid JSON: {exc}")
        else:
            rp = pathlib.Path(r.get("path", ""))
            if not rp.is_absolute():
                rp = out / rp
            if not rp.exists():
                problems.append(f"readings/{eid}.json points at {r.get('path')}, which does not exist")
            elif r.get("sha256"):
                r_actual = hashlib.sha256(rp.read_bytes()).hexdigest()
                if r["sha256"] != r_actual:
                    problems.append(f"readings/{eid}.json sha256 does not match its own path's bytes")
    elif status not in ("fetch-failed", "no-text-layer"):
        problems.append(f"no readings/{eid}.json even though status is {status!r}")

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="sources.enriched.json")
    ap.add_argument("--out", default=".")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))

    checked, clean, broken = 0, 0, 0
    for entry in manifest["entries"]:
        problems = check_entry(entry, out)
        if problems is None:
            continue
        checked += 1
        if problems:
            broken += 1
            print(f"FAIL {entry['id']}")
            for msg in problems:
                print(f"     - {msg}")
        else:
            clean += 1
            print(f"ok   {entry['id']}")

    print()
    print(f"{checked} entries with capture data checked, {clean} clean, {broken} with problems")
    sys.exit(1 if broken else 0)


if __name__ == "__main__":
    main()
