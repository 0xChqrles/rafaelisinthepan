#!/usr/bin/env python3
"""Shared, STDLIB-ONLY slug contract + the vocab existence-set writer.

`slug()` lives here — imported by BOTH gen_phrase.py and reduce_embedding.py — so the
two never keep divergent copies (a second copy would risk breaking the cross-language
slug()==fold() contract). The module stays dependency-free (no gensim/numpy) so
reduce_embedding, which only streams text and loads no vectors, can emit the vocab in
the same pass without pulling heavy deps.
"""

import json
import os
import re
import unicodedata

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)                 # packages/generation
# The vocab existence set IS a web runtime asset: the SPA fetches /vocab/<lang>.json from
# its own origin (useVocab), so it is written straight into web/public/vocab.
WEB_VOCAB_DIR = os.path.normpath(os.path.join(ROOT, "..", "web", "public", "vocab"))

# Ligatures that do NOT decompose under NFKD, so we expand them by hand.
_LIGATURES = {"œ": "oe", "æ": "ae"}
# slug keeps only ASCII letters and dashes; everything else is dropped.
_SLUG_STRIP = re.compile(r"[^a-z-]")
_SLUG_DASHES = re.compile(r"-+")


def slug(word):
    """Accent-folded key used for COMPARISON/LOOKUP (never displayed).

    Keeps internal dashes: lowercase -> expand ligatures -> NFKD -> drop combining
    marks -> keep only [a-z] and '-' -> collapse repeated dashes -> trim edges.
    été->ete, forêt->foret, œuf->oeuf, peut-être->peut-etre, arc-en-ciel->arc-en-ciel.
    Stays byte-identical to the front-end fold() in src/screens/Game.tsx."""
    w = word.lower()
    for lig, repl in _LIGATURES.items():
        w = w.replace(lig, repl)
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))
    w = _SLUG_STRIP.sub("", w)
    w = _SLUG_DASHES.sub("-", w)
    return w.strip("-")


def write_vocab(words, lang, vocab_dir=None):
    """Write <vocab_dir>/<lang>.json: the UNLIMITED existence set.

    Every distinct slug of `words` (deduplicated, sorted) — NOT capped. The front
    fetches this once and decides word existence from it. Deterministic given `words`;
    overwritten on each run. `vocab_dir` defaults to web/public/vocab (the served
    asset); callers (tests) may point it elsewhere."""
    vocab_dir = vocab_dir or WEB_VOCAB_DIR
    slugs = sorted({s for s in (slug(w) for w in words) if s})
    os.makedirs(vocab_dir, exist_ok=True)
    out_path = os.path.join(vocab_dir, f"{lang}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(slugs, f, ensure_ascii=False)
    print(f"Vocabulaire ({lang}) : {len(slugs)} slugs -> {out_path}")
    return out_path
