#!/usr/bin/env python3
"""
audio_profile.py -- local voice-embedding + clustering (resemblyzer),
replacing the dropped face-recognition/video-frame approach with an
audio-only one. An "utterance" is one or more consecutive caption segments
(fetch_captions.py's own .segments.json) merged to reach a minimum
duration resemblyzer needs for a reliable embedding -- utterance
boundaries come from the caption track already fetched, never a second,
disconnected windowing pass.

Usage
    python3 audio_profile.py <audio_path> <segments_json> <out_basename> [--gallery-json <path>]

Writes
    <out_basename>.clusters.json    one entry per recurring voice found:
                                     cluster_id, matched name (or null),
                                     utterances (start/end seconds, the
                                     caption text spoken, for a human to
                                     spot-check)
    <out_basename>.embeddings.json  SHORT-LIVED: raw voice embeddings per
                                     cluster, for a labeling step to add to
                                     the encrypted gallery. Delete this
                                     file once labeling is done -- the one
                                     plaintext biometric artifact this
                                     pipeline produces.

UNLIKE face_recognition's own documented TOLERANCE (0.6), resemblyzer
ships no official same-speaker similarity cutoff -- there is no library
convention to defer to here. SAME_SPEAKER_COSINE below is a disclosed,
unvalidated starting point from common speaker-verification practice, not
a measured or library-endorsed constant, and should be checked against
real clustering output (does it split one person into two clusters, or
merge two people into one) before being trusted the way the face-
recognition tolerance could be.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav
from scipy.io import wavfile

SAME_SPEAKER_COSINE = 0.80  # disclosed, unvalidated -- see module docstring
MIN_UTTERANCE_SECONDS = 1.5  # resemblyzer's own guidance: too short an
# utterance gives an unreliable embedding; merge caption segments until
# this floor is met rather than embedding each short segment alone


def merge_segments_into_utterances(segments, min_seconds):
    utterances = []
    cur_start, cur_end, cur_text = None, None, []
    for seg in segments:
        if cur_start is None:
            cur_start, cur_end, cur_text = seg["start"], seg["end"], [seg["text"]]
        else:
            cur_end = seg["end"]
            cur_text.append(seg["text"])
        if cur_end - cur_start >= min_seconds:
            utterances.append({"start": cur_start, "end": cur_end, "text": " ".join(cur_text)})
            cur_start, cur_end, cur_text = None, None, []
    if cur_start is not None:
        utterances.append({"start": cur_start, "end": cur_end, "text": " ".join(cur_text)})
    return utterances


def cosine(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def cluster_voices(observations):
    """Greedy clustering: an observation joins the first existing cluster
    whose centroid it matches within SAME_SPEAKER_COSINE, else starts a
    new one. Simple and order-dependent by construction -- adequate for a
    single meeting's own recurring voices, not proposed as a general
    solution."""
    clusters = []
    for obs in observations:
        emb = obs["embedding"]
        matched = None
        for c in clusters:
            if cosine(c["centroid"], emb) > SAME_SPEAKER_COSINE:
                matched = c
                break
        if matched is None:
            clusters.append({"centroid": emb, "embeddings": [emb], "observations": [obs]})
        else:
            matched["embeddings"].append(emb)
            matched["observations"].append(obs)
            matched["centroid"] = np.mean(matched["embeddings"], axis=0)
    return clusters


def match_against_gallery(cluster_centroid, gallery):
    best_name, best_sim = None, SAME_SPEAKER_COSINE
    for name, embs in gallery.items():
        for e in embs:
            sim = cosine(np.array(e), cluster_centroid)
            if sim > best_sim:
                best_name, best_sim = name, sim
    return best_name, (best_sim if best_name else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio_path")
    ap.add_argument("segments_json")
    ap.add_argument("out_base")
    ap.add_argument(
        "--gallery-json",
        default=None,
        help="an ALREADY-DECRYPTED gallery {name: [[embedding floats], ...]} -- never a password, never the encrypted file itself",
    )
    args = ap.parse_args()

    segments_doc = json.loads(pathlib.Path(args.segments_json).read_text(encoding="utf-8"))
    utterances = merge_segments_into_utterances(segments_doc["segments"], MIN_UTTERANCE_SECONDS)
    print(f"{len(segments_doc['segments'])} caption segments merged into {len(utterances)} utterance(s) >= {MIN_UTTERANCE_SECONDS}s", flush=True)

    gallery = {}
    if args.gallery_json:
        raw_gallery = json.loads(pathlib.Path(args.gallery_json).read_text(encoding="utf-8"))
        gallery = {name: [np.array(e) for e in embs] for name, embs in raw_gallery.items()}

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = pathlib.Path(tmp) / "audio.wav"
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", args.audio_path, "-ac", "1", "-ar", "16000", str(wav_path)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"ffmpeg failed converting audio to 16kHz mono WAV: {result.stderr[:2000]}", file=sys.stderr)
            sys.exit(1)

        sr, samples = wavfile.read(str(wav_path))
        samples = samples.astype(np.float32) / 32768.0  # int16 -> [-1, 1] float

        encoder = VoiceEncoder()
        observations = []
        for i, u in enumerate(utterances):
            start_sample, end_sample = int(u["start"] * sr), int(u["end"] * sr)
            clip = samples[start_sample:end_sample]
            if len(clip) < sr * 0.5:  # a merge that still fell short of real audio -- skip, never pad/guess
                continue
            wav = preprocess_wav(clip, source_sr=sr)
            embedding = encoder.embed_utterance(wav)
            observations.append({"start": u["start"], "end": u["end"], "text": u["text"], "embedding": embedding})
            if (i + 1) % 50 == 0:
                print(f"...{i + 1}/{len(utterances)} utterances embedded", flush=True)

    print(f"embedded {len(observations)} utterance(s)", flush=True)

    clusters = cluster_voices(observations)
    clusters.sort(key=lambda c: -sum(o["end"] - o["start"] for o in c["observations"]))  # most speaking time first

    clusters_out = []
    embeddings_out = {}
    for idx, c in enumerate(clusters):
        cluster_id = f"voice-{chr(65 + idx)}" if idx < 26 else f"voice-{idx}"
        matched_name, match_sim = (None, None)
        if gallery:
            matched_name, match_sim = match_against_gallery(c["centroid"], gallery)
        total_seconds = sum(o["end"] - o["start"] for o in c["observations"])
        clusters_out.append(
            {
                "cluster_id": cluster_id,
                "matched_name": matched_name,
                "match_similarity": round(float(match_sim), 4) if match_sim is not None else None,
                "utterance_count": len(c["observations"]),
                "total_speaking_seconds": round(total_seconds, 1),
                "utterances": [
                    {"start": o["start"], "end": o["end"], "text": o["text"]} for o in c["observations"]
                ],
            }
        )
        embeddings_out[cluster_id] = [e.tolist() for e in c["embeddings"]]

    with open(args.out_base + ".clusters.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                "audio_path": args.audio_path,
                "same_speaker_cosine": SAME_SPEAKER_COSINE,
                "cluster_count": len(clusters_out),
                "clusters": clusters_out,
            },
            f,
            indent=2,
        )
    with open(args.out_base + ".embeddings.json", "w", encoding="utf-8") as f:
        json.dump(embeddings_out, f)

    unmatched = [c for c in clusters_out if not c["matched_name"]]
    print(
        f"done -> {len(clusters_out)} recurring voice(s) found "
        f"({len(clusters_out) - len(unmatched)} matched against the gallery, {len(unmatched)} unmatched). "
        f"{args.out_base}.embeddings.json is a SHORT-LIVED plaintext file -- label it, then delete it.",
        flush=True,
    )


if __name__ == "__main__":
    main()
