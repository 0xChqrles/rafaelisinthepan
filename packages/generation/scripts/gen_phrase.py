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

The phrase is written to packages/generation/output/word/<lang>/<slug1>_<slug2>_<slug3>.json
(slugs in sentence order); rerunning with the same three words overwrites it. A puzzle is
a generation artifact, NOT a web asset: publish it to the backend store (local FS or S3)
with `pnpm puzzle:publish` — the front gets the day's puzzle from the backend (#6).

On a terminal the script is fully interactive (#5): the phrase, language, the three
hole words, the per-hole start word, and the optional source metadata (kind / author /
work / context) are all asked when not supplied as flags. Any flag given is not
re-prompted, and non-interactive (piped / batch) runs keep working with flags only —
no prompt ever blocks them.

Usage :
    uv run scripts/gen_phrase.py                       # fully interactive
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c \
        --kind book --author "Victor Hugo" --work "Les Misérables"
    pnpm gen:phrase "<phrase>" --lang fr --words a b c
"""

import argparse
import json
import os
import random
import re
import sys

# scripts/ -> generation package root, to import sibling modules and resolve
# vector/cache paths regardless of the cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
for path in (ROOT, SCRIPT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# Two kinds of output, two homes:
#  - PUZZLES are generation artifacts: written under this package's own output/ dir, then
#    PUBLISHED to the daily store (local FS or S3) via `pnpm puzzle:publish`. The front
#    never serves them directly (the backend does, #6), so they don't belong in web/public.
#  - The VOCAB existence set IS a web runtime asset (written to web/public/vocab by the
#    shared write_vocab, imported above).
# ROOT == packages/generation, a sibling of web in the monorepo.
GEN_OUTPUT = os.path.join(ROOT, "output")

import french_neighbors as frn
import glove_neighbors as gn
from slug import slug, write_vocab  # shared stdlib slug/fold contract + vocab writer
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

# Known "kind of piece" values offered by the interactive prompt (#5). Stored as
# canonical English tokens (the front localises for display); the list is a
# SUGGESTION, not a closed set — the prompt still accepts a free-form kind, matching
# the OPEN `SourceKind` union in packages/shared/src/types.ts.
KNOWN_KINDS = ("book", "movie", "music", "quote", "poem")

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


# --- Interactive prompts -------------------------------------------------------
# The script is fully interactive on a TTY (#5): anything not given as a CLI flag is
# asked here. These helpers only run when stdin is a terminal (main() guards them),
# so piped / batch runs are never blocked — exactly like choose_start.

def _prompt(label, default=None):
    """Read one line from a terminal prompt. Blank or EOF returns `default`.

    `default` (when set) is shown in brackets and used for an empty answer, so
    optional fields can be skipped with Enter."""
    hint = f" [{default}]" if default not in (None, "") else ""
    try:
        raw = input(f"{label}{hint} : ").strip()
    except EOFError:  # stdin closed mid-prompt: fall back to the default.
        return default
    return raw or default


def prompt_lang(default="en"):
    """Ask for the language, reprompting until it is one of the supported codes."""
    while True:
        raw = _prompt("Langue (en/fr)", default)
        if raw in ("en", "fr"):
            return raw
        print("  Réponds 'en' ou 'fr'.")


def prompt_sentence():
    """Ask for the sentence, reprompting until it is non-empty."""
    while True:
        raw = _prompt("Phrase")
        if raw:
            return raw
        print("  La phrase ne peut pas être vide.")


def prompt_words():
    """Ask for the three hole words (space-separated), reprompting until exactly 3.

    Only the count is validated here; membership in the sentence / the reduced
    vocabulary is still checked (and errors) in the per-word loop, as before."""
    while True:
        raw = _prompt("Trois mots à cacher (séparés par des espaces)")
        parts = raw.split() if raw else []
        if len(parts) == 3:
            return parts
        print("  Il faut exactement 3 mots.")


def prompt_kind():
    """Ask for the optional 'kind of piece'. Blank -> None (field omitted).

    Offers KNOWN_KINDS as a numbered shortcut but also accepts free-form text, so a
    kind outside the suggested set is allowed (the SourceKind union is open)."""
    listing = ", ".join(f"{i}={k}" for i, k in enumerate(KNOWN_KINDS, 1))
    while True:
        raw = _prompt(f"Type d'œuvre ({listing} ; ou texte libre ; Entrée = aucun)")
        if not raw:
            return None
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(KNOWN_KINDS):
                return KNOWN_KINDS[idx - 1]
            print(f"  Numéro hors liste (1–{len(KNOWN_KINDS)}).")
            continue
        return raw


def build_source(kind=None, author=None, work=None, context=None):
    """Assemble the optional `source` metadata dict, dropping blank fields.

    Returns None when nothing is provided so the puzzle JSON stays byte-compatible
    with metadata-less puzzles (no empty `source` key). Values are DISPLAY forms
    (accents kept, never slugged), matching the rest of the schema."""
    src = {}
    for key, val in (("kind", kind), ("author", author),
                     ("work", work), ("context", context)):
        if val is None:
            continue
        val = val.strip()
        if val:
            src[key] = val
    return src or None


def parse_args():
    p = argparse.ArgumentParser(
        description="Génère un fichier de jeu autonome pour une phrase "
                    "(interactif sur un terminal ; sinon fournir les arguments)."
    )
    # sentence / --words are optional: on a TTY they are asked interactively when
    # omitted; in a non-interactive run their absence is a clear error (see main()).
    p.add_argument("sentence", nargs="?", help="la phrase complète (sinon demandée)")
    # default=None (not "en") so main() can tell "flag omitted" from an explicit
    # choice, and prompt for it on a TTY while keeping the old "en" default off-TTY.
    p.add_argument("--lang", choices=("en", "fr"), default=None,
                   help="langue en/fr (défaut : en en mode non interactif)")
    p.add_argument("--words", nargs=3, metavar=("W1", "W2", "W3"),
                   help="exactement 3 mots de la phrase à transformer en trous (sinon demandés)")
    # Optional source metadata (#5); any flag given here is NOT re-prompted on a TTY.
    p.add_argument("--kind", help="type d'œuvre (book, movie, music, quote, poem, …)")
    p.add_argument("--author", help="auteur / autrice")
    p.add_argument("--work", help="titre de l'œuvre")
    p.add_argument("--context", help="passage / contexte source")
    p.add_argument("--out-dir", default=os.path.join(GEN_OUTPUT, "word"), dest="out_dir",
                   help="dossier de sortie des puzzles (défaut : packages/generation/output/word)")
    return p.parse_args()


def main():
    args = parse_args()
    interactive = sys.stdin.isatty()

    # Resolve every required input: a CLI flag wins; else prompt on a TTY; else keep
    # the old non-interactive contract (default lang / clear error for what's missing),
    # so piped and batch runs behave exactly as before.
    lang = args.lang
    if lang is None:
        lang = prompt_lang() if interactive else "en"

    sentence = args.sentence
    if sentence is None:
        if interactive:
            sentence = prompt_sentence()
        else:
            die("aucune phrase fournie (argument positionnel requis hors mode interactif).")

    words_arg = args.words
    if words_arg is None:
        if interactive:
            words_arg = prompt_words()
        else:
            die("--words est requis hors mode interactif (exactement 3 mots).")

    cfg = CONFIG[lang]
    random.seed(0)  # reproducible start words

    kv = cfg["module"].load_vectors()
    V = build_lang_vocab(kv, cfg)

    # DISPLAY forms of the sentence (accents kept), plus their slugs for matching.
    words = [normalize(t, cfg) for t in sentence.split()]
    word_slugs = [slug(w) for w in words]

    # V == kv == the whole reduced vocabulary, so there is no target to inject: a
    # target either survived reduction (it is in V) or it cannot be used. The
    # per-word loop below errors clearly in the latter case.
    M = cfg["module"].build_matrix(kv, V)
    Vset = set(V)

    # Existence set for the front: the whole (slugged) reduced vocabulary V.
    write_vocab(V, lang)

    holes = []
    ranks = {}
    used_pos = set()

    for raw in words_arg:
        tgt = normalize(raw, cfg)
        tslug = slug(tgt)
        if not tslug:
            die(f"'{raw}' ne contient aucune lettre valide pour la langue '{lang}'.")

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
                f"vocabulaire réduit '{lang}'. Choisis un autre mot cible, ou "
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

    # --- Optional source metadata (#5) ----------------------------------------
    # Flags win; otherwise ask on a TTY (any flag already given is not re-prompted);
    # otherwise leave omitted. Asked here, after the holes are built, so a bad word
    # errors out before any metadata is entered.
    kind, author, work, context = args.kind, args.author, args.work, args.context
    if interactive:
        if kind is None:
            kind = prompt_kind()
        if author is None:
            author = _prompt("Auteur / autrice")
        if work is None:
            work = _prompt("Titre de l'œuvre")
        if context is None:
            context = _prompt("Passage / contexte")
    source = build_source(kind, author, work, context)

    phrase = {
        "lang": lang,
        "words": words,
        "holes": holes,
        "ranks": ranks,
    }
    # Only write `source` when there is metadata, keeping puzzles without it
    # byte-compatible with metadata-less output.
    if source:
        phrase["source"] = source

    # --- Write one self-contained file ----------------------------------------
    out_dir = os.path.join(args.out_dir, lang)
    os.makedirs(out_dir, exist_ok=True)
    fname = "_".join(h["secret"]["slug"] for h in holes) + ".json"
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(phrase, f, ensure_ascii=False)

    # --- Preview ---------------------------------------------------------------
    print(f"\nPhrase ({lang}) écrite dans {out_path} :")
    for h in holes:
        print(f"  {h['start']['word']}^-{h['start_rank']} -> {h['secret']['word']}")
    if source:
        print("  source : " + ", ".join(f"{k}={v}" for k, v in source.items()))

    # A puzzle is not served from here: publish it into the daily store (local or S3).
    # --s3 discovers the bucket from the deployed stack output; no --bucket needed.
    print(f"\nPublier : pnpm puzzle:publish {out_path}"
          f"\n          pnpm puzzle:publish {out_path} --s3")


if __name__ == "__main__":
    main()
