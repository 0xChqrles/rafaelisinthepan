#!/usr/bin/env python3
"""Shared, STDLIB-ONLY slug contract + the vocab existence-set writer.

`slug()` lives here — imported by every script that needs the key (gen_phrase,
gen_word, reduce_embedding, distances' callers…) — so no two keep divergent copies (a
second copy would risk breaking the cross-language slug()==fold() contract). The module stays dependency-free (no gensim/numpy) so
reduce_embedding, which only streams text and loads no vectors, can emit the vocab in
the same pass without pulling heavy deps.
"""

import json
import os
import re
import unicodedata
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)                 # packages/generation
# The vocab existence set IS a web runtime asset: the SPA fetches /vocab/<lang>.json from
# its own origin (useVocab), so it is written straight into web/public/vocab.
WEB_VOCAB_DIR = os.path.normpath(os.path.join(ROOT, "..", "web", "public", "vocab"))
# Its METADATA (#200) goes to TS source instead, because its reader is the BACKEND, which
# never loads the set: what a vocabulary IS (how big, how long its longest key, which
# corpus build produced it) is all the server needs to bound a score or a stored guess.
# packages/shared/ specifically, because deploy.yml's paths-filter already fans `shared`
# out to both stacks — so a regenerated vocabulary ships its new numbers through a
# mapping that exists, instead of leaving the backend on a stale value with no signal.
SHARED_SRC_DIR = os.path.normpath(os.path.join(ROOT, "..", "shared", "src"))
VOCAB_META_PATH = os.path.join(SHARED_SRC_DIR, "vocab.generated.json")

# Ligatures that do NOT decompose under NFKD, so we expand them by hand.
_LIGATURES = {"œ": "oe", "æ": "ae"}
# slug keeps only ASCII letters and dashes; everything else is dropped.
_SLUG_STRIP = re.compile(r"[^a-z-]")
_SLUG_DASHES = re.compile(r"-+")
# path_slug keeps letters AND digits; every other run becomes one separating dash.
_PATH_SEPARATORS = re.compile(r"[^a-z0-9]+")


def _fold_to_ascii(text):
    """lowercase -> expand ligatures -> NFKD -> drop combining marks.

    The accent folding both slug() and path_slug() start from, kept in ONE place so
    the two can never fold differently. What each does with the folded text after
    this differs, and deliberately so — see path_slug()."""
    w = text.lower()
    for lig, repl in _LIGATURES.items():
        w = w.replace(lig, repl)
    w = unicodedata.normalize("NFKD", w)
    return "".join(c for c in w if not unicodedata.combining(c))


def slug(word):
    """Accent-folded key used for COMPARISON/LOOKUP (never displayed).

    Keeps internal dashes: lowercase -> expand ligatures -> NFKD -> drop combining
    marks -> keep only [a-z] and '-' -> collapse repeated dashes -> trim edges.
    été->ete, forêt->foret, œuf->oeuf, peut-être->peut-etre, arc-en-ciel->arc-en-ciel.
    Stays byte-identical to the front-end fold() in packages/shared/src/slug.ts."""
    w = _fold_to_ascii(word)
    w = _SLUG_STRIP.sub("", w)
    w = _SLUG_DASHES.sub("-", w)
    return w.strip("-")


def path_slug(text):
    """Readable ASCII name for a DIRECTORY — NOT a key, and never a slug (#137).

    A puzzle files under its source (<lang>/<kind>/<author>/<work>/), and those
    segments are browsed by a human, so they answer a different question from
    slug(): they must stay READABLE rather than comparable. Two deliberate
    divergences follow, and neither may be "unified" with slug():

      - a run of anything non-alphanumeric becomes ONE separating dash instead of
        being dropped, so words stay apart — "Victor Hugo" -> "victor-hugo", where
        slug() gives "victorhugo". Apostrophes separate like the rest, in both
        their ASCII and typographic forms: "L'Usage du monde" -> "l-usage-du-monde".
      - DIGITS ARE KEPT. Works are named "1, 2, 3" and "Joueur 1"; dropping digits
        the way slug() does would leave the first one with an empty name.

    Returns "" when nothing survives (a title of pure punctuation); the caller
    decides what an unnamable level means — gen_phrase omits it.

    Never use this to look a word up: it is not the slug()/fold() contract, and a
    value folded through it can collide differently."""
    return _PATH_SEPARATORS.sub("-", _fold_to_ascii(text)).strip("-")


_REDUCED = "_reduced"
# The MEASURED half of a metadata entry — what is a pure function of the vocabulary
# itself. `builtAt` is the one field that isn't, which is why it is compared apart.
_MEASURED = ("embedding", "vocabSize", "maxSlugLength")


def corpus_name(path):
    """Name the CORPUS BUILD an embedding file belongs to: its basename, without the
    extension and without a `_reduced` suffix.

    Both sides of the reduction name the same build: reduce_embedding holds the raw
    `cc.fr.300.vec` it just read, the neighbor modules hold the `cc.fr.300_reduced.vec`
    they just loaded, and both answer "cc.fr.300". So whichever command refreshes the
    existence set records the same corpus — the metadata can never say two different
    things about one vocabulary."""
    root, _ext = os.path.splitext(os.path.basename(path))
    return root[: -len(_REDUCED)] if root.endswith(_REDUCED) else root


def _read_meta(path):
    """The metadata already on disk, or {} when the file does not exist yet.

    A MISSING file is the ordinary cold start: the run about to write it just does.
    Anything else FAILS LOUD. The file holds BOTH languages and a run only ever rebuilds
    one, so treating an unparseable file as empty would silently DROP the other
    language's entry — and a language absent from the record is one the live routes
    refuse (`Object.hasOwn(VOCAB_BUILDS, lang)`), which is a 400 on every /scores and
    /board call for it. A conflict-markered merge is the realistic way a committed file
    stops parsing, and the repair is restoring it, never overwriting half of it."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            existing = json.load(f)
    except (OSError, ValueError) as exc:
        raise SystemExit(
            f"Erreur : métadonnées du vocabulaire illisibles : {path}\n"
            f"  {exc}\n"
            "  Restaure le fichier avant de régénérer (git checkout) — il porte les deux "
            "langues, et une seule est reconstruite par exécution.")
    if not isinstance(existing, dict):
        raise SystemExit(
            f"Erreur : métadonnées du vocabulaire malformées (objet attendu) : {path}")
    return existing


def write_vocab_meta(slugs, lang, source, meta_path=None):
    """Record what the existence set of `lang` IS, into packages/shared (#200).

    One entry per language: the corpus build it came from (`embedding` + `builtAt`)
    plus two measurements of a set the backend never loads — `vocabSize` (a sentence
    score counts distinct vocabulary-valid tries, so the set's size is that score's
    ceiling, and the live score validator reads it) and `maxSlugLength` (no valid
    guess is longer than the longest key in it — emitted ahead of its consumer, the
    stored-guess cap of #199). Measured from the same `slugs` that were just written,
    so the numbers cannot describe some other vocabulary.

    Only THIS language's entry is touched — the other is read back and kept, since a
    run only ever rebuilds one language. `builtAt` (UTC) dates the run that first
    produced this exact vocabulary: an unchanged rebuild keeps the recorded date, so
    re-running the pipeline over the same corpus leaves the file byte-identical rather
    than dirtying it on every puzzle commit."""
    meta_path = meta_path or VOCAB_META_PATH
    entry = {
        "embedding": corpus_name(source),
        "vocabSize": len(slugs),
        "maxSlugLength": max((len(s) for s in slugs), default=0),
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    meta = _read_meta(meta_path)
    previous = meta.get(lang)
    if isinstance(previous, dict) and all(previous.get(k) == entry[k] for k in _MEASURED):
        entry["builtAt"] = previous.get("builtAt", entry["builtAt"])
    meta[lang] = entry

    # Written beside, then renamed: the destination is committed source that `tsc` and
    # BOTH bundles read, so a torn write (Ctrl-C, disk full) would break a file nobody
    # edited, and its repair — `git checkout` something labelled "generated" — is not
    # what anyone tries first. os.replace is atomic within a filesystem, which also
    # makes two concurrent language rebuilds resolve to one whole file instead of a
    # half-merged one.
    os.makedirs(os.path.dirname(os.path.abspath(meta_path)), exist_ok=True)
    tmp_path = f"{meta_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")  # it is committed TS source, read in diffs
    os.replace(tmp_path, meta_path)
    print(f"Métadonnées ({lang}) : {entry['embedding']}, {entry['vocabSize']} slugs, "
          f"clé la plus longue {entry['maxSlugLength']} -> {meta_path}")
    return meta_path


def write_vocab(words, lang, source, vocab_dir=None, meta_path=None):
    """Write <vocab_dir>/<lang>.json: the UNLIMITED existence set, AND its metadata.

    Every distinct slug of `words` (deduplicated, sorted) — NOT capped. The front
    fetches this once and decides word existence from it. Deterministic given `words`;
    overwritten on each run. `vocab_dir` defaults to web/public/vocab (the served
    asset); callers (tests) may point it elsewhere.

    The metadata (#200) is written in the SAME call, from the same slugs, because the
    two must describe one vocabulary: every command that can refresh the existence set
    — reduce, gen_phrase, build_vocab — goes through here, so none of them can move the
    set while leaving the backend's numbers behind. `source` is the embedding file this
    vocabulary came from; raw or `_reduced`, both name the same corpus (corpus_name).

    A REDIRECTED set takes its record with it: pointing `vocab_dir` elsewhere writes the
    metadata there too, so `--vocab-dir` alone fully isolates a run. Only a set written
    to the served location describes the vocabulary the backend is bounding, and an
    experiment must not leave its numbers in packages/shared."""
    vocab_dir = vocab_dir or WEB_VOCAB_DIR
    if meta_path is None and os.path.abspath(vocab_dir) != WEB_VOCAB_DIR:
        meta_path = os.path.join(vocab_dir, os.path.basename(VOCAB_META_PATH))
    # Refuse an unreadable record BEFORE the set moves. The two writes are one statement
    # about one vocabulary, so the failure has to land while nothing has changed — not
    # after web/public holds a set whose record was rejected, which is the drift this
    # pair exists to make impossible.
    _read_meta(meta_path or VOCAB_META_PATH)
    slugs = sorted({s for s in (slug(w) for w in words) if s})
    os.makedirs(vocab_dir, exist_ok=True)
    out_path = os.path.join(vocab_dir, f"{lang}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(slugs, f, ensure_ascii=False)
    print(f"Vocabulaire ({lang}) : {len(slugs)} slugs -> {out_path}")
    write_vocab_meta(slugs, lang, source, meta_path)
    return out_path
