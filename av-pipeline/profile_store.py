#!/usr/bin/env python3
"""
profile_store.py -- the encrypted, persistent, cross-meeting voice gallery.
THE ONLY SCRIPT IN THIS PIPELINE THAT TOUCHES A PASSWORD. Run this
yourself, in your own terminal -- never invoke it from an assistant, since
the password must never pass through anything but your own keyboard.

Encryption matches the scheme already used consistently across this
user's eopm (src/crypto/envelope.js) and hmail (src/lib/crypto.ts)
projects, not invented here: password -> PBKDF2-HMAC-SHA256 (16-byte
salt, 600,000 iterations) -> AES-256-GCM key. Ciphertext is stored as
base64(salt[16] + iv[12] + ciphertext+tag).

The gallery itself: {name: {"embeddings": [[floats], ...], "org": str|null,
"meetings": [meeting_id, ...]}}.

Usage
    python3 profile_store.py init <gallery_path>
        Create a new, empty encrypted gallery. Prompts for a password
        (typed twice to confirm) -- there is no recovery if you forget it;
        the gallery would need to be rebuilt from scratch.

    python3 profile_store.py unlock <gallery_path> <out_plaintext_json>
        Decrypt to a plaintext JSON file for a pipeline run (e.g. as
        audio_profile.py's --gallery-json). YOU are responsible for
        deleting <out_plaintext_json> once the run finishes -- this
        script does not do it for you, since it does not know when a
        caller is done reading it.

    python3 profile_store.py add <gallery_path> <name> <embeddings_json> [--org ORG] [--meeting MEETING_ID]
        Decrypt, add or merge one person's embeddings (embeddings_json:
        a JSON array of embedding arrays, e.g. one cluster's own
        <out_base>.embeddings.json value for that cluster_id), re-encrypt
        with a freshly-derived key under the SAME salt the gallery
        already carries.

    python3 profile_store.py list <gallery_path>
        Decrypt and print who is in the gallery, with org and meeting
        counts -- never the embeddings themselves.
"""
import argparse
import base64
import getpass
import json
import os
import pathlib
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

PBKDF2_ITERATIONS = 600_000  # matches eopm/hmail's own established scheme
SALT_LEN = 16
IV_LEN = 12


def derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS)
    return kdf.derive(password.encode("utf-8"))


def encrypt_gallery(gallery: dict, password: str, salt: bytes = None) -> str:
    salt = salt or os.urandom(SALT_LEN)
    key = derive_key(password, salt)
    iv = os.urandom(IV_LEN)
    aesgcm = AESGCM(key)
    plaintext = json.dumps(gallery).encode("utf-8")
    ciphertext = aesgcm.encrypt(iv, plaintext, None)
    return base64.b64encode(salt + iv + ciphertext).decode("ascii")


def decrypt_gallery(blob_b64: str, password: str) -> dict:
    raw = base64.b64decode(blob_b64)
    salt, iv, ciphertext = raw[:SALT_LEN], raw[SALT_LEN:SALT_LEN + IV_LEN], raw[SALT_LEN + IV_LEN:]
    key = derive_key(password, salt)
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)
    return json.loads(plaintext.decode("utf-8")), salt


def cmd_init(args):
    path = pathlib.Path(args.gallery_path)
    if path.exists():
        print(f"refusing to overwrite an existing gallery at {path}", file=sys.stderr)
        sys.exit(1)
    pw1 = getpass.getpass("New gallery password: ")
    pw2 = getpass.getpass("Confirm password: ")
    if pw1 != pw2:
        print("passwords did not match", file=sys.stderr)
        sys.exit(1)
    if not pw1:
        print("an empty password protects nothing", file=sys.stderr)
        sys.exit(1)
    print(
        "There is no recovery if you forget this password -- the gallery "
        "would need to be rebuilt from scratch. Write it down somewhere safe.",
    )
    blob = encrypt_gallery({}, pw1)
    path.write_text(blob, encoding="utf-8")
    print(f"created empty encrypted gallery at {path}")


def cmd_unlock(args):
    blob = pathlib.Path(args.gallery_path).read_text(encoding="utf-8")
    pw = getpass.getpass(f"Password for {args.gallery_path}: ")
    try:
        gallery, _salt = decrypt_gallery(blob, pw)
    except Exception:
        print("could not decrypt -- wrong password, or a corrupted file", file=sys.stderr)
        sys.exit(1)
    plain = {name: entry["embeddings"] for name, entry in gallery.items()}
    pathlib.Path(args.out_plaintext_json).write_text(json.dumps(plain), encoding="utf-8")
    print(
        f"unlocked {len(gallery)} known speaker(s) -> {args.out_plaintext_json}. "
        f"Delete this plaintext file yourself once your pipeline run is done.",
    )


def cmd_add(args):
    path = pathlib.Path(args.gallery_path)
    blob = path.read_text(encoding="utf-8")
    pw = getpass.getpass(f"Password for {args.gallery_path}: ")
    try:
        gallery, salt = decrypt_gallery(blob, pw)
    except Exception:
        print("could not decrypt -- wrong password, or a corrupted file", file=sys.stderr)
        sys.exit(1)

    new_embeddings = json.loads(pathlib.Path(args.embeddings_json).read_text(encoding="utf-8"))
    entry = gallery.setdefault(args.name, {"embeddings": [], "org": None, "meetings": []})
    entry["embeddings"].extend(new_embeddings)
    if args.org:
        entry["org"] = args.org
    if args.meeting and args.meeting not in entry["meetings"]:
        entry["meetings"].append(args.meeting)

    blob_out = encrypt_gallery(gallery, pw, salt=salt)
    path.write_text(blob_out, encoding="utf-8")
    print(f"added {len(new_embeddings)} embedding(s) for {args.name!r} -> {path} ({len(entry['embeddings'])} total for this person)")


def cmd_list(args):
    blob = pathlib.Path(args.gallery_path).read_text(encoding="utf-8")
    pw = getpass.getpass(f"Password for {args.gallery_path}: ")
    try:
        gallery, _salt = decrypt_gallery(blob, pw)
    except Exception:
        print("could not decrypt -- wrong password, or a corrupted file", file=sys.stderr)
        sys.exit(1)
    if not gallery:
        print("(empty gallery)")
        return
    for name, entry in sorted(gallery.items()):
        org = entry.get("org") or "(no org recorded)"
        meetings = len(entry.get("meetings", []))
        embs = len(entry.get("embeddings", []))
        print(f"{name} -- {org} -- {embs} embedding(s) across {meetings} meeting(s)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("gallery_path")
    p_init.set_defaults(func=cmd_init)

    p_unlock = sub.add_parser("unlock")
    p_unlock.add_argument("gallery_path")
    p_unlock.add_argument("out_plaintext_json")
    p_unlock.set_defaults(func=cmd_unlock)

    p_add = sub.add_parser("add")
    p_add.add_argument("gallery_path")
    p_add.add_argument("name")
    p_add.add_argument("embeddings_json")
    p_add.add_argument("--org", default=None)
    p_add.add_argument("--meeting", default=None)
    p_add.set_defaults(func=cmd_add)

    p_list = sub.add_parser("list")
    p_list.add_argument("gallery_path")
    p_list.set_defaults(func=cmd_list)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
