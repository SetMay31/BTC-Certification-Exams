# Black Turtle Conservation — Certification Exams

A self-contained, offline-capable exam app (PWA) for Black Turtle Conservation
certification levels. Students scan a QR code, take the exam on their phone, and
answers are marked in person afterwards on the same device.

## Levels
- **Conservation Specialist** (light teal) — live
- **Master Conservationist** (mid teal) — coming soon
- **Scientific Diver** (dark teal) — coming soon

## How it works
- No backend. Everything runs in the browser and is saved to the device
  (`localStorage`). Works fully offline after the first load (service worker).
- Question types: multiple choice (single / multi), true-false, ordered text
  slots, photo identification, "name N things", free text, and number entry.
- Auto-graded questions use fuzzy matching and can be overridden by a marker.
  Free-text and "name" questions are marked by a human during review.
- The result (percentage + raw score + pass/fail) is only shown once every
  subjective answer has been marked. Pass mark: 75%.

## Editing questions
The questions live in `data/<exam>.json` (readable source, **kept local / not
committed** so the answer key stays out of the public repo). After editing:

```bash
python3 tools/encode.py
```

This regenerates the committed `data/<exam>.enc` files that the app loads. The
`.enc` files are lightly obfuscated (XOR + base64) to deter casual snooping —
this is **not** real security; the decode key is in the client.

## Local preview
```bash
python3 -m http.server 8090
# open http://localhost:8090
```

## Deployment
Hosted on GitHub Pages (main branch, root).
