#!/usr/bin/env python3
"""
transcribe.py -- local audio transcription via mlx-whisper (Apple Silicon,
Metal-accelerated). Everything runs on-device; nothing is sent anywhere.

Usage
    .whisper-venv/bin/python3 transcribe.py <audio_path> <out_basename>

Writes
    <out_basename>.txt            plain text transcript
    <out_basename>.segments.json  timestamped segments (start/end/text)
"""
import json
import sys
import time

import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"


def main():
    audio_path, out_base = sys.argv[1], sys.argv[2]
    t0 = time.time()
    print(f"transcribing {audio_path} with {MODEL} ...", flush=True)
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=MODEL)
    elapsed = time.time() - t0

    with open(out_base + ".txt", "w", encoding="utf-8") as f:
        f.write(result["text"].strip() + "\n")

    segments = [
        {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        for s in result["segments"]
    ]
    with open(out_base + ".segments.json", "w", encoding="utf-8") as f:
        json.dump({"audio_path": audio_path, "model": MODEL, "language": result.get("language"),
                    "segments": segments}, f, indent=2)

    print(f"done in {elapsed:.0f}s -> {out_base}.txt ({len(result['text'])} chars, "
          f"{len(segments)} segments)", flush=True)


if __name__ == "__main__":
    main()
