#!/usr/bin/env python3
"""
build_meeting_batch.py -- generalizes the 2026-09-09 HPC entry precedent
(build_hpc_entry.py, a one-off script) into a repeatable pipeline over the
whole historical backlog in av-pipeline/hpc-meeting-backlog.json.

Per meeting: caption fetch (YouTube's own track; never downloads video) ->
Whisper fallback ONLY if no caption track exists (audio-only download via
fetch_audio.py, transcribed, then the audio file is deleted immediately --
this project runs on a disk that is nearly full, and nothing downstream
needs the audio once a transcript exists) -> eoreader7 speaker-boundary
pass (resolve-speakers.mjs) -> eoreader7 entity-recognition pass
(run-entity-recognition.mjs) -> a real sources.json/sources.enriched.json
entry, written the same way build_hpc_entry.py wrote one, with one honest
difference: build_hpc_entry.py's anchor/claim came from a human (me) having
read that transcript and picked out a specific, newsworthy sentence. A
batch of 75 meetings cannot get that same editorial read in one pass, so
these entries carry a real sha256/bytes/local_path/url (full, verified
capture -- the transcript genuinely is preserved and hashed) but an
honestly-labelled placeholder claim stating no specific finding has been
picked out yet, with no anchor offset guessed to look more precise than it
is. Anyone -- this project's own later work, or the journalist directly --
can read transcripts/<slug>.txt and upgrade any entry to a real anchored
claim the same way the Sept 9 entry was built, without re-fetching anything.

Commits each meeting's addition individually (transcript files + its
sources.json/sources.enriched.json/readings entry), per user direction to
commit as content is added, rather than one giant commit at the end.
sources.structured.json and the HTML register are regenerated and committed
every REGEN_EVERY meetings and once more at the end, not on every single
meeting -- avoids rewriting a large embedded-JSON HTML file 75 times for no
correctness benefit (nothing treats them as authoritative; they're always
rebuilt from sources.enriched.json).

Usage
    python3 av-pipeline/build_meeting_batch.py [--limit N] [--dry-run]

Writes
    transcripts/<slug>.txt / .segments.json / .speaker-bindings.json / .entities.json
    sources.json, sources.enriched.json, readings/<ID>.json  (updated)
    sources.structured.json, ohs-source-custody.html         (regenerated periodically)
    av-pipeline/batch-run.log                                (append-only progress log)
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path("/Users/mlacy/Documents/3.0/ohs-custody")
EOREADER7 = pathlib.Path("/Users/mlacy/Documents/3.0/eoreader7")
WHISPER_PY = ROOT / ".whisper-venv" / "bin" / "python3"
REGEN_EVERY = 10

PLACEHOLDER_CLAIM = (
    "Full meeting transcript preserved and hashed (YouTube caption track, or "
    "local Whisper transcription when no caption track existed -- see this "
    "entry's own capture.note). Bulk-ingested as part of the historical CoC/"
    "HPC meeting backlog sweep; not yet read for a specific citable finding. "
    "See the linked transcript for full text and its .entities.json sibling "
    "for extracted referents. Upgrade this entry with a real anchor/claim "
    "once a specific quote is needed, following the 2026-09-09 entry's "
    "pattern -- the underlying bytes and hash do not change."
)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(msg):
    line = f"{now_iso()}  {msg}"
    print(line, flush=True)
    with open(ROOT / "av-pipeline" / "batch-run.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(cmd, cwd=ROOT, **kw):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, **kw)


def slug_for(meeting):
    date = meeting["date"]
    title = meeting["title"]
    tail = re.sub(r"^\d{1,2}/\d{1,2}/\d{2}\s*", "", title).strip()
    tail_l = tail.lower()
    if "special called" in tail_l:
        kind = "special-called"
    elif "symposium" in tail_l:
        kind = "symposium"
    else:
        kind = "hpc-meeting"
    return f"{date}-{kind}"


def entry_id_for(slug):
    return f"{slug.upper()}-TRANSCRIPT"


def git_commit(paths, message):
    existing = [p for p in paths if (ROOT / p).exists()]
    if not existing:
        return False
    run(["git", "add", *existing])
    staged = run(["git", "diff", "--cached", "--name-only"]).stdout.strip()
    if not staged:
        return False
    r = run(["git", "commit", "-m", message])
    if r.returncode != 0:
        log(f"git commit failed: {r.stderr.strip()[:500]}")
        return False
    return True


def get_captions(video_id, out_base):
    r = run([str(WHISPER_PY), "av-pipeline/fetch_captions.py", video_id, str(out_base)])
    if r.returncode == 0:
        return True, "youtube-caption-track"
    log(f"  captions unavailable ({r.stdout.strip()[-200:]}) -- falling back to audio+whisper")
    return False, None


def get_whisper_fallback(video_id, out_base):
    audio_base = ROOT / "av-pipeline" / "audio" / out_base.name
    audio_base.parent.mkdir(parents=True, exist_ok=True)
    r = run([sys.executable, "av-pipeline/fetch_audio.py", video_id, str(audio_base)])
    if r.returncode != 0:
        log(f"  fetch_audio failed: {r.stdout.strip()[-300:]} {r.stderr.strip()[-300:]}")
        return False, None
    dest = None
    for line in r.stdout.splitlines():
        if line.startswith("done -> "):
            dest = line[len("done -> "):].strip()
    if not dest or not pathlib.Path(dest).exists():
        log("  fetch_audio produced no usable output path")
        return False, None
    r2 = run([str(WHISPER_PY), "transcripts/transcribe.py", dest, str(out_base)], timeout=1800)
    audio_size = pathlib.Path(dest).stat().st_size if pathlib.Path(dest).exists() else 0
    pathlib.Path(dest).unlink(missing_ok=True)  # delete audio immediately -- disk is nearly full
    if r2.returncode != 0:
        log(f"  transcribe.py failed: {r2.stdout.strip()[-300:]} {r2.stderr.strip()[-300:]}")
        return False, None
    log(f"  whisper transcribed ({audio_size/1e6:.0f}MB audio fetched then deleted)")
    return True, "local-whisper-mlx-large-v3-turbo"


def build_entry(meeting, slug, txt_path, source_kind):
    raw = txt_path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    eid = entry_id_for(slug)
    url = f"https://www.youtube.com/watch?v={meeting['video_id']}"
    title_tail = re.sub(r"^\d{1,2}/\d{1,2}/\d{2}\s*", "", meeting["title"]).strip()

    capture = {
        "status": "local-only",
        "sha256": sha256,
        "bytes": len(raw),
        "anchor_offset": None,
        "anchor_length": None,
        "anchor_method": "not-yet-picked",
        "content_type": "text/plain",
        "fetched_at": now_iso(),
        "local_path": str(txt_path.relative_to(ROOT)),
        "archive_tier": "local-only",
        "note": (
            f"Derived artifact via {source_kind}; video itself was never "
            "downloaded (captions/audio only, per project direction to avoid "
            "video downloads). Bulk-ingested -- see claim field."
        ),
    }
    entry = {
        "id": eid,
        "label": f"{meeting['date']} {title_tail}, transcript",
        "tier": "secondary",
        "doctype": "transcript-derived",
        "url": url,
        "anchor": None,
        "claim": PLACEHOLDER_CLAIM,
        "used_for": "Bulk-preserved CoC/HPC meeting backlog; source for future specific claims",
        "added": f"Generated {now_iso()[:10]} by build_meeting_batch.py, generalizing the 2026-09-09 entry's pattern across the full playlist backlog.",
        "capture": {"status": "unverified", "wayback_timestamp": None, "sha256": None, "bytes": None,
                     "anchor_offset": None, "anchor_length": None, "content_type": None, "fetched_at": None},
    }
    enriched_entry = dict(entry)
    enriched_entry["capture"] = capture

    reading = {
        "id": eid,
        "path": str(txt_path.relative_to(ROOT)),
        "sha256": sha256,
        "bytes": len(raw),
        "media_type": "text/plain",
        "source_url": url,
        "final_url": None,
        "retrieved_at": capture["fetched_at"],
        "derived_artifact": True,
        "derivation_note": capture["note"],
        "spans": [],
    }
    return eid, entry, enriched_entry, reading


def register_entry(eid, thin_entry, enriched_entry, reading):
    sj = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    sj["entries"] = [e for e in sj["entries"] if e["id"] != eid] + [thin_entry]
    (ROOT / "sources.json").write_text(json.dumps(sj, indent=2), encoding="utf-8")

    se = json.loads((ROOT / "sources.enriched.json").read_text(encoding="utf-8"))
    se["entries"] = [e for e in se["entries"] if e["id"] != eid] + [enriched_entry]
    se["last_run"] = now_iso()
    (ROOT / "sources.enriched.json").write_text(json.dumps(se, indent=2), encoding="utf-8")

    (ROOT / "readings" / f"{eid}.json").write_text(json.dumps(reading, indent=2), encoding="utf-8")


def regen_structured_and_html():
    r = run(["python3", "build_structured_json.py"])
    if r.returncode != 0:
        log(f"  build_structured_json.py failed: {r.stderr.strip()[:500]}")
        return False
    html_path = ROOT / "ohs-source-custody.html"
    html = html_path.read_text(encoding="utf-8")
    enriched_text = (ROOT / "sources.enriched.json").read_text(encoding="utf-8")
    m = re.search(r'(<script type="application/json" id="manifest">\n)(.*?)(\n</script>)', html, re.DOTALL)
    if not m:
        log("  could not find embedded manifest script block in HTML register")
        return False
    html_path.write_text(html[: m.start(2)] + enriched_text + html[m.end(2):], encoding="utf-8")
    return True


def process_one(meeting, dry_run):
    slug = slug_for(meeting)
    out_base = ROOT / "transcripts" / slug
    video_id = meeting["video_id"]
    log(f"[{meeting['date']}] {meeting['title']}  ({video_id})")

    if dry_run:
        log("  dry-run, skipping")
        return "dry-run"

    if out_base.with_suffix(".txt").exists():
        log("  transcript already exists, skipping fetch")
        ok, kind = True, "youtube-caption-track (pre-existing)"
    else:
        ok, kind = get_captions(video_id, out_base)
        if not ok:
            ok, kind = get_whisper_fallback(video_id, out_base)
    if not ok:
        log("  SKIPPED: no transcript could be produced (captions and whisper fallback both failed)")
        return "no-transcript"

    txt_path = out_base.with_suffix(".txt")
    r = run(["node", "cli/resolve-speakers.mjs", str(txt_path), "--out", str(out_base) + ".speaker-bindings.json"],
            cwd=EOREADER7)
    if r.returncode != 0:
        log(f"  resolve-speakers.mjs failed (non-fatal, continuing): {r.stderr.strip()[:300]}")

    r = run(["node", "run-entity-recognition.mjs", str(txt_path), str(out_base)], cwd=ROOT / "transcripts")
    if r.returncode != 0:
        log(f"  run-entity-recognition.mjs failed (non-fatal, continuing): {r.stderr.strip()[:300]}")

    eid, thin, enriched, reading = build_entry(meeting, slug, txt_path, kind)
    register_entry(eid, thin, enriched, reading)

    commit_paths = [
        "sources.json", "sources.enriched.json", f"readings/{eid}.json",
        f"transcripts/{slug}.txt", f"transcripts/{slug}.segments.json",
        f"transcripts/{slug}.speaker-bindings.json", f"transcripts/{slug}.entities.json",
    ]
    committed = git_commit(commit_paths, f"Add {meeting['date']} HPC meeting transcript ({kind})")
    log(f"  registered as {eid}{' + committed' if committed else ' (nothing to commit?)'}")
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    backlog = json.loads((ROOT / "av-pipeline" / "hpc-meeting-backlog.json").read_text())
    meetings = backlog["remaining"]
    if args.limit:
        meetings = meetings[: args.limit]

    log(f"=== batch run start: {len(meetings)} meetings ===")
    counts = {}
    for i, meeting in enumerate(meetings, 1):
        try:
            result = process_one(meeting, args.dry_run)
        except Exception as exc:
            log(f"  EXCEPTION: {type(exc).__name__}: {exc}")
            result = "exception"
        counts[result] = counts.get(result, 0) + 1

        if not args.dry_run and i % REGEN_EVERY == 0:
            if regen_structured_and_html():
                git_commit(["sources.structured.json", "ohs-source-custody.html"],
                           f"Regenerate structured manifest + HTML register (through {meeting['date']})")

    if not args.dry_run:
        if regen_structured_and_html():
            git_commit(["sources.structured.json", "ohs-source-custody.html"],
                       "Regenerate structured manifest + HTML register (final)")

    log(f"=== batch run end: {counts} ===")
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()
