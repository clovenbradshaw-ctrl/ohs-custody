#!/usr/bin/env python3
"""
fetch_audio.py -- yt-dlp audio-only extraction. No video stream is ever
requested. This is the lightweight replacement for the dropped face-
recognition/video-frame approach: a voice-print cross-check needs only the
audio, typically a fraction of the size of the video (this meeting: ~70MB
audio-only vs. ~240MB with video).

Usage
    python3 fetch_audio.py <youtube_id_or_url> <out_basename>

Writes
    <out_basename>.m4a (or whatever container yt-dlp's bestaudio resolves
    to) -- the caller passes the exact path back to audio_profile.py.
    Prints the resolved output path on its own last line so a caller never
    has to guess the extension.
"""
import subprocess
import sys


def main():
    video_id_or_url, out_base = sys.argv[1], sys.argv[2]
    url = video_id_or_url if video_id_or_url.startswith("http") else f"https://www.youtube.com/watch?v={video_id_or_url}"

    cmd = [
        "yt-dlp", "--no-warnings",
        "-f", "bestaudio",
        "-o", f"{out_base}.%(ext)s",
        url,
    ]
    print(f"running: {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"yt-dlp failed: {result.stderr[-2000:]}", file=sys.stderr)
        sys.exit(1)

    # yt-dlp prints the final "[download] Destination: <path>" line;
    # find it rather than guessing the extension.
    dest = None
    for line in result.stdout.splitlines():
        if "Destination:" in line:
            dest = line.split("Destination:", 1)[1].strip()
        elif "has already been downloaded" in line:
            dest = line.split("]")[-1].strip().rsplit(" has already", 1)[0].strip()
    if not dest:
        print("yt-dlp ran but no output path could be identified", file=sys.stderr)
        sys.exit(1)

    print(f"done -> {dest}", flush=True)


if __name__ == "__main__":
    main()
