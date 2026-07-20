#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the form→lemma table consumed by gen_phrase.py's lemma-merging rule (#104).

For a language, this fetches the reference source, extracts every (inflected form,
lemma) pair, normalizes both sides the same way as an embedding token (lowercase;
ACCENTS KEPT — the pre-slug form, exactly like the hors-dico wordlist), and writes
the versioned, deterministic file

    packages/generation/wordlist/<lang>.lemmas.tsv.gz

one `form<TAB>lemma` pair per line, sorted + unique. A form may appear on several
lines (several lemmas: "portes" → porte / porter); every lemma is also registered as
a form of itself, so the artifact is self-contained. This script is the OFFLINE
builder: only it needs the network. The pipeline itself only READS the committed file
(gen_phrase.py, --no-lemmas to opt out).

Sources (one per language)
  fr : Lexique.org lexicon (TSV) — its `ortho` → `lemme` columns ARE the table.
  en : AGID (Automatically Generated Inflection Database, SCOWL's sibling project) —
       infl.txt maps lemma → inflections; we invert it.

Usage
    uv run scripts/build_lemmas.py --lang fr
    uv run scripts/build_lemmas.py --lang en
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import gzip
import os
import re
import sys
import tarfile

import build_wordlist as bw  # fetch() + the shared cache dir / UA
import reduce_embedding as red  # token_pattern — one source for the token rule

SOURCES = {
    "fr": {
        # Lexique383: one row per surface form; `ortho` = inflected spelling,
        # `lemme` = its lemma. Same download (and cache file) as build_wordlist.
        "lexique": "http://www.lexique.org/databases/Lexique383/Lexique383.tsv",
    },
    "en": {
        # AGID rev 2016.01.19: infl.txt lists `lemma POS: inflections` lines.
        "agid": "http://downloads.sourceforge.net/wordlist/agid-2016.01.19.tar.gz",
    },
}

# Trailing AGID form annotations (`runs?`, `spelt~`, `dreamt<`, `wholes!`): strip them
# from a form token before validating it as a word.
_AGID_MARKERS = re.compile(r"[?~<!]+$")


def lemmas_path(lang):
    """Default versioned lemma table for a language: wordlist/<lang>.lemmas.tsv.gz."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.lemmas.tsv.gz")


def read_lexique_pairs(path):
    """Lexique TSV -> (ortho, lemme) pairs: the surface form and its lemma."""
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        i_ortho, i_lemme = header.index("ortho"), header.index("lemme")
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) > max(i_ortho, i_lemme):
                yield cols[i_ortho], cols[i_lemme]


def parse_agid_line(line):
    """One infl.txt line -> (lemma, [forms]).

    Format: `lemma POS<flags>: slot | slot | ...` where each slot holds one or more
    comma-separated variants, each variant being the form itself optionally followed
    by annotations (`?`/`~`/`<`/`!` glued to the word, or space-separated level
    digits: "was, wast 2"). Only the word itself is kept; a malformed line yields
    (None, []).
    """
    head, sep, rest = line.partition(":")
    if not sep:
        return None, []
    head_tokens = head.split()
    if not head_tokens:
        return None, []
    lemma = head_tokens[0]
    forms = []
    for slot in rest.split("|"):
        for variant in slot.split(","):
            tokens = variant.split()
            if tokens:
                forms.append(_AGID_MARKERS.sub("", tokens[0]))
    return lemma, forms


def read_agid_pairs(tar_path):
    """AGID tarball -> (form, lemma) pairs from its infl.txt (the mapping, inverted)."""
    with tarfile.open(tar_path, "r:gz") as tar:
        member = next(m for m in tar.getmembers() if m.name.endswith("/infl.txt"))
        f = tar.extractfile(member)
        for raw in f:
            lemma, forms = parse_agid_line(raw.decode("utf-8", "replace"))
            if lemma is None:
                continue
            for form in forms:
                yield form, lemma


def collect_pairs(lang, raw_pairs):
    """Normalize + filter raw (form, lemma) pairs into the final deterministic set.

    Both sides are lowercased (accents kept) and must pass the language's token rule
    (letters + internal hyphens — the same shape the reduction keeps). Every lemma is
    also registered as a form of itself, so lookups need no fallback for the lemma's
    own row (AGID never lists the lemma among its inflections).
    """
    token_re = red.token_pattern(lang)
    pairs = set()
    for form, lemma in raw_pairs:
        form, lemma = form.strip().lower(), lemma.strip().lower()
        if not token_re.match(form) or not token_re.match(lemma):
            continue
        pairs.add((form, lemma))
        pairs.add((lemma, lemma))
    return pairs


def load_lemmas(path):
    """Load a committed lemma table: { form: (lemma, ...) }, file order preserved.

    One `form<TAB>lemma` per line (gzip when the path ends in .gz). The file is
    sorted, so each form's lemmas come out in a deterministic order."""
    table = {}
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            form, sep, lemma = line.partition("\t")
            if not sep:
                continue
            table.setdefault(form, []).append(lemma)
    return {form: tuple(lemmas) for form, lemmas in table.items()}


def build(lang, *, refresh):
    src = SOURCES[lang]
    if "lexique" in src:
        # Same cache file name as build_wordlist, so one download serves both builders.
        path = bw.fetch(src["lexique"],
                        os.path.join(bw.CACHE_DIR, f"{lang}.lexique.tsv"), refresh)
        raw_pairs = read_lexique_pairs(path)
    else:
        path = bw.fetch(src["agid"],
                        os.path.join(bw.CACHE_DIR, f"{lang}.agid.tar.gz"), refresh)
        raw_pairs = read_agid_pairs(path)

    pairs = collect_pairs(lang, raw_pairs)
    if not pairs:
        print(f"Erreur : la source n'a produit aucune paire pour {lang}.", file=sys.stderr)
        sys.exit(1)

    out_path = lemmas_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:  # deterministic: sorted + unique
        for form, lemma in sorted(pairs):
            f.write(f"{form}\t{lemma}\n")

    # --- Report (stderr) ---
    forms = {form for form, _ in pairs}
    merged = sum(1 for form, lemma in pairs if form != lemma)
    print(f"\nLangue : {lang}", file=sys.stderr)
    print(f"Paires  : {len(pairs):,} ({len(forms):,} formes, "
          f"{merged:,} non-identité) -> {out_path}", file=sys.stderr)
    print(out_path)  # stdout: the built file path


def main():
    p = argparse.ArgumentParser(description="Construit la table forme→lemme d'une langue.")
    p.add_argument("--lang", choices=("en", "fr"), required=True)
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge la source (ignore le cache)")
    args = p.parse_args()
    build(args.lang, refresh=args.refresh)


if __name__ == "__main__":
    main()
