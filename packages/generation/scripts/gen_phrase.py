#!/usr/bin/env python3
# /// script
# dependencies = ["gensim", "numpy"]
# ///
"""
Generate one self-contained game file for ONE sentence.

Reuse the existing logic as-is:
  - glove_neighbors.build_vocab / build_matrix / closest (cosine neighbors),
  - french_neighbors equivalents for French fastText vectors,
  - start_word.pick_start (start word selection),
  - the ranking pattern: secret word = rank 0, neighbors start at 1.

Two per-language concerns drive the rest:
  - loading: English (GloVe) and French (fastText) do not share the same reduced
    file, header, or alphabet. All of that is described in CONFIG below.
  - accents: French keeps accents for DISPLAY but folds them to a slug for every
    COMPARISON/LOOKUP (see slug()). We never fold a displayed form and never
    display a slug. Output filenames are ASCII slugs; JSON content keeps accents.

The phrase is written to packages/web/public/word/<lang>/<slug1>_<slug2>_<slug3>.json
(slugs in sentence order); rerunning with the same three words overwrites it.

Usage :
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c
    npm run gen:phrase -- "<phrase>" --lang fr --words a b c
"""

import argparse
import json
import os
import random
import re
import sys
import unicodedata

# scripts/ -> generation package root, to import sibling modules and resolve
# vector/cache paths regardless of the cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
for path in (ROOT, SCRIPT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# Generated puzzle/vocab data is SERVED by the web package, so it is written into
# packages/web/public/. This generation package is a sibling of web in the monorepo
# (ROOT == packages/generation), so web's public dir is ../web/public.
WEB_PUBLIC = os.path.normpath(os.path.join(ROOT, "..", "web", "public"))

import french_neighbors as frn
import glove_neighbors as gn
from start_word import pick_start, start_band

# --- Vocabulary ----------------------------------------------------------------
# V is the WHOLE reduced vocabulary: scripts/reduce_embedding.py already capped and
# filtered it, so V is identical from one run to the next and ranks stay comparable
# between sentences — there are no size/scan knobs to tune here anymore.

# Generation-only knob: cap each secret's rank map to its K nearest words (the
# secret itself is always kept at rank 0). The front treats "absent from this
# map" as cold, so K bounds how far a guess can still register as "warm". Easy to
# change here; the front never sees K and stays K-agnostic.
TOP_K = 10_000

# --- Per-language config -------------------------------------------------------
# char_class: allowed alphabet. It is used BOTH to validate a vocab token
# (token_regex) and to clean a word (normalize), to stay consistent.
# For "en", char_class = "a-z" keeps ASCII letters only (the GloVe alphabet).
def _build_config():
    en = {
        "module": gn,
        "char_class": "a-z",
    }
    fr = {
        "module": frn,
        "char_class": "a-zàâäéèêëîïôöùûüÿçœæ",
    }
    for cfg in (en, fr):
        cc = cfg["char_class"]
        # Letters with optional internal dashes (same shape as the reduction's rule).
        cfg["token_regex"] = re.compile(rf"^[{cc}]+(-[{cc}]+)*$")
        # strip_re keeps the alphabet AND dashes (normalize collapses/trims them).
        cfg["strip_re"] = re.compile(rf"[^{cc}-]")
    return {"en": en, "fr": fr}


CONFIG = _build_config()


def die(msg):
    """Print a clear error message to stderr, then exit with failure."""
    print(f"Erreur : {msg}", file=sys.stderr)
    sys.exit(1)


def normalize(tok, cfg):
    """Lowercase and keep the language alphabet plus internal dashes.

    This is the DISPLAY form: French accents are kept (they are in char_class),
    and an internal dash survives ("arc-en-ciel" stays "arc-en-ciel"). Repeated
    dashes collapse to one and edge dashes are trimmed, matching slug()."""
    w = cfg["strip_re"].sub("", tok.lower())
    w = re.sub(r"-+", "-", w)
    return w.strip("-")


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


def ws(display):
    """A {word, slug} object: the displayed (accented) form plus its slug.

    Always carries both, even when slug == word (no conditional shortcuts)."""
    return {"word": display, "slug": slug(display)}


def build_rank_map(secret_display, ranking):
    """Slug-keyed rank map for one secret: { input_slug: {word, rank} }.

    Iterates closest-first (secret itself is rank 0), so on a slug collision
    (côté/coté -> cote) the first seen is the smallest rank: we keep it and warn.
    The kept entry's `word` is the form the front will display."""
    # Combined list in ascending-rank order: secret at 0, then neighbors at r+1.
    entries = [(secret_display, 0)]
    entries.extend((w, r + 1) for w, r, _ in ranking)

    rmap = {}
    for display, rank in entries:
        s = slug(display)
        if s in rmap:
            kept = rmap[s]
            print(f"[collision] slug '{s}' : gardé '{kept['word']}' (rang "
                  f"{kept['rank']}), écarté '{display}' (rang {rank})", file=sys.stderr)
            continue
        rmap[s] = {"word": display, "rank": rank}
    return rmap


def build_lang_vocab(kv, cfg):
    """Return the full reduced vocabulary via the configured neighbor module."""
    return cfg["module"].build_vocab(kv)


def write_vocab(V, lang):
    """Write public/vocab/<lang>.json: the UNLIMITED existence set.

    Every distinct slug in V (deduplicated, sorted) — NOT capped to TOP_K. The
    front fetches this once and decides word existence from it. Since V is the
    same pool ranks are drawn from, every word in any top-K is guaranteed here.
    Deterministic given V; overwritten on each run."""
    slugs = sorted({s for s in (slug(w) for w in V) if s})
    out_dir = os.path.join(WEB_PUBLIC, "vocab")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{lang}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(slugs, f, ensure_ascii=False)
    print(f"Vocabulaire ({lang}) : {len(slugs)} slugs -> {out_path}")
    return out_path


def choose_start(secret, ranking, rank_map, rank_by_display):
    """Pick the start (hint) word for ONE hole, interactively when on a terminal.

    The random default is exactly what pick_start would choose, so nothing about
    the rank-band selection itself changes. When stdin is a TTY, the rank-band
    candidates are printed as a numbered list (each with its rank) and one line is
    read:
      - empty (Enter)  -> the random default — keeps batch / non-interactive runs
        working without any input;
      - a list number  -> that candidate;
      - any other word -> accepted only if it is in this hole's rank map (i.e. it
        survived into V / the secret's ranking), matched by slug; else reprompt.

    Returns a DISPLAY word that is a key of rank_by_display, so start_rank and the
    {word, slug} object built downstream stay exactly as before.
    """
    default = pick_start(secret, ranking)

    # No terminal attached (piped stdin / batch generation): keep the random
    # default silently, so automated runs never block on input().
    if not sys.stdin.isatty():
        return default

    band = start_band(secret, ranking)
    print(f"\nMot de départ pour « {secret} » "
          f"(Entrée = {default}^-{rank_by_display[default]}) :")
    for i, (w, _r) in enumerate(band, 1):
        print(f"  {i}) {w}  ^-{rank_by_display[w]}")

    while True:
        try:
            raw = input("> ").strip()
        except EOFError:  # stdin closed mid-prompt: fall back to the default.
            return default
        if not raw:
            return default
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(band):
                return band[idx - 1][0]
            print(f"  Numéro hors liste (1–{len(band)}).")
            continue
        # Arbitrary typed word: accept only if it is in this hole's rank map.
        entry = rank_map.get(slug(raw))
        if entry is not None:
            return entry["word"]
        print(f"  « {raw} » n'est ni un numéro ni un mot du vocabulaire de ce trou.")


def parse_args():
    p = argparse.ArgumentParser(
        description="Génère un fichier de jeu autonome pour une phrase."
    )
    p.add_argument("sentence", help="la phrase complète")
    p.add_argument("--lang", choices=("en", "fr"), default="en", help="langue (défaut : en)")
    p.add_argument("--words", nargs=3, required=True, metavar=("W1", "W2", "W3"),
                   help="exactement 3 mots de la phrase à transformer en trous")
    p.add_argument("--out-dir", default=os.path.join(WEB_PUBLIC, "word"), dest="out_dir",
                   help="dossier de sortie (défaut : packages/web/public/word)")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = CONFIG[args.lang]
    random.seed(0)  # reproducible start words

    kv = cfg["module"].load_vectors()
    V = build_lang_vocab(kv, cfg)

    # DISPLAY forms of the sentence (accents kept), plus their slugs for matching.
    words = [normalize(t, cfg) for t in args.sentence.split()]
    word_slugs = [slug(w) for w in words]

    # V == kv == the whole reduced vocabulary, so there is no target to inject: a
    # target either survived reduction (it is in V) or it cannot be used. The
    # per-word loop below errors clearly in the latter case.
    M = cfg["module"].build_matrix(kv, V)
    Vset = set(V)

    # Existence set for the front: the whole (slugged) reduced vocabulary V.
    write_vocab(V, args.lang)

    holes = []
    ranks = {}
    used_pos = set()

    for raw in args.words:
        tgt = normalize(raw, cfg)
        tslug = slug(tgt)
        if not tslug:
            die(f"'{raw}' ne contient aucune lettre valide pour la langue '{args.lang}'.")

        # 1) the word must appear in the sentence (matched by SLUG, free position).
        pos = next((i for i, s in enumerate(word_slugs)
                    if s == tslug and i not in used_pos), None)
        if pos is None:
            if tslug in word_slugs:
                die(f"'{raw}' apparaît mais toutes ses positions sont déjà prises "
                    f"(mot en double dans --words ?).")
            die(f"'{raw}' n'apparaît pas dans la phrase : {' '.join(words)}")

        # The secret's DISPLAY form is the sentence's own (accented) form.
        secret = words[pos]

        # 2) the word must be in the reduced vocabulary V (= in the vectors). If it
        # is not, it did not survive reduction and cannot be used here.
        if secret not in Vset:
            die(f"'{raw}' (→ '{secret}') n'a pas survécu à la réduction : absent du "
                f"vocabulaire réduit '{args.lang}'. Choisis un autre mot cible, ou "
                f"ajuste puis relance la réduction (scripts/reduce_embedding.py).")

        used_pos.add(pos)

        # Top-K ranking of V against the secret; closest neighbor = rank 1. The
        # rank map is capped to these K nearest words (the start word's band sits
        # far below K, so pick_start still has its full choice).
        ranking = cfg["module"].closest(secret, kv, V, M, n=TOP_K)
        # Display-keyed ranks (secret = 0) just to look up the start word's rank.
        rank_by_display = {secret: 0}
        for w, r, _ in ranking:
            rank_by_display[w] = r + 1

        # Slug-keyed rank map (with collision handling) for the front-end lookup.
        rank_map = build_rank_map(secret, ranking)
        ranks[slug(secret)] = rank_map

        start = choose_start(secret, ranking, rank_map, rank_by_display)
        holes.append({
            "pos": pos,
            "secret": ws(secret),
            "start": ws(start),
            "start_rank": rank_by_display[start],
        })

    # Holes (and therefore the filename slugs) follow sentence order, not --words.
    holes.sort(key=lambda h: h["pos"])

    phrase = {
        "lang": args.lang,
        "words": words,
        "holes": holes,
        "ranks": ranks,
    }

    # --- Write one self-contained file ----------------------------------------
    out_dir = os.path.join(args.out_dir, args.lang)
    os.makedirs(out_dir, exist_ok=True)
    fname = "_".join(h["secret"]["slug"] for h in holes) + ".json"
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(phrase, f, ensure_ascii=False)

    # --- Preview ---------------------------------------------------------------
    print(f"\nPhrase ({args.lang}) écrite dans {out_path} :")
    for h in holes:
        print(f"  {h['start']['word']}^-{h['start_rank']} -> {h['secret']['word']}")


if __name__ == "__main__":
    main()
