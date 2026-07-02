#!/usr/bin/env python3
"""Obfuscate exam data for public deployment.
Reads each data/*.json (readable source of truth) and writes data/*.enc
(XOR + base64). The .enc files are what the app loads and what gets committed;
the readable .json sources stay local (gitignored). Re-run after editing questions:
    python3 tools/encode.py
This is light obfuscation to deter casual snooping — NOT real security.
"""
import base64, glob, os

KEY = b"BlackTurtleConservation"

def xor(data):
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))

for src in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.json"))):
    with open(src, "rb") as f:
        raw = f.read()
    enc = base64.b64encode(xor(raw)).decode()
    dst = os.path.splitext(src)[0] + ".enc"
    with open(dst, "w") as f:
        f.write(enc)
    print("encoded", os.path.basename(src), "->", os.path.basename(dst))
