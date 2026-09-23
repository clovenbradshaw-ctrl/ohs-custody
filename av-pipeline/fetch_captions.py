#!/usr/bin/env python3
"""
fetch_captions.py -- YouTube's own caption track, tried before local Whisper
transcription. Reads the public timedtext endpoint via youtube-transcript-api;
never downloads or touches the video file itself. Writes the SAME shape
transcribe.py does (<out>.txt, <out>.segments.json), so nothing downstream
cares which one produced a given meeting's transcript.

Usage
    .whisper-venv/bin/python3 fetch_captions.py <video_id> <out_basename>

Writes (only on success)
    <out_basename>.txt            plain text transcript
    <out_basename>.segments.json  timestamped segments (start/end/text),
                                   plus which kind of track was used

Exit code 0 on a usable caption track found and written; 2 when no caption
track exists, or none could be fetched, or it came back empty -- the
caller's signal to fall back to transcribe.py, never a silent empty
transcript standing in for a real one.

Prefers a manually-uploaded English track over an auto-generated one when
both exist; most government-meeting channels carry auto-generated only.
Auto-generated captions are still a machine transcript, same caveat
transcribe.py's own callers already carry forward into the custody record:
spot-check a few segments against the real audio before printing a quote
as verbatim.
"""
import json
import sys

from youtube_transcript_api import YouTubeTranscriptApi


def main():
    video_id, out_base = sys.argv[1], sys.argv[2]
    api = YouTubeTranscriptApi()

    try:
        transcript_list = list(api.list(video_id))
    except Exception as e:
        print(f"no caption listing available for {video_id}: {type(e).__name__}: {e}", flush=True)
        sys.exit(2)

    manual = [t for t in transcript_list if not t.is_generated and t.language_code.startswith("en")]
    auto = [t for t in transcript_list if t.is_generated and t.language_code.startswith("en")]
    chosen = (manual or auto or [None])[0]
    chosen_kind = "manual" if manual and chosen in manual else ("auto-generated" if chosen else None)

    if chosen is None:
        langs = ", ".join(sorted({t.language_code for t in transcript_list})) or "none"
        print(f"no English caption track for {video_id} (available languages: {langs})", flush=True)
        sys.exit(2)

    try:
        fetched = chosen.fetch()
    except Exception as e:
        print(f"caption track listed but could not be fetched: {type(e).__name__}: {e}", flush=True)
        sys.exit(2)

    snippets = [s for s in fetched.snippets if s.text.strip()]
    if not snippets:
        print("caption track fetched but empty", flush=True)
        sys.exit(2)

    text = " ".join(s.text.strip() for s in snippets)
    segments = [
        {"start": round(s.start, 2), "end": round(s.start + s.duration, 2), "text": s.text.strip()}
        for s in snippets
    ]

    with open(out_base + ".txt", "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")
    with open(out_base + ".segments.json", "w", encoding="utf-8") as f:
        json.dump({
            "video_id": video_id,
            "source": "youtube-caption-track",
            "kind": chosen_kind,
            "language": chosen.language_code,
            "segments": segments,
        }, f, indent=2)

    duration_min = segments[-1]["end"] / 60 if segments else 0
    print(
        f"done -> {out_base}.txt ({len(text)} chars, {len(segments)} segments, "
        f"{chosen_kind} {chosen.language_code}, ~{duration_min:.1f} min)",
        flush=True,
    )


if __name__ == "__main__":
    main()
