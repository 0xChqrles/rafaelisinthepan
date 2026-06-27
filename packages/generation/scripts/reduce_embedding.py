#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Reduce a .vec embedding to a small, game-ready file. The source is frequency-sorted,
so we stream it from the top, apply the rules to each word, and KEEP the survivors
until TOP_N of them have passed — then we stop reading. We never stream the remaining
millions, and never load any vector into memory.

The rules below drop the words we don't want (uppercase, single letters, non-alphabet
tokens, stopwords) BEFORE the cap is counted, so TOP_N bounds the number of KEPT words,
not the number of source lines scanned. The survivors are written verbatim to a single
<input>_reduced.<ext> file — the single source of truth the rest of the pipeline
consumes WITHOUT re-filtering. The output has EXACTLY TOP_N words, unless the source is
exhausted first (then fewer, with a warning).

Monitoring is the per-rule report on stderr (counts + samples), plus how many source
lines were SCANNED to reach TOP_N kept (the scanned/kept ratio shows how noisy the head
of the embedding is).

Rules (first one that matches = reason a word is dropped):
  1. majuscule      : the word contains at least one uppercase letter (proper nouns, acronyms…)
  2. single-letter  : the word is a single letter (counted by character, so "à"/"é" count as one)
  3. hors-alphabet  : something other than letters + internal hyphens (digits, </s>, co²…)
  4. stopword       : function word

Format: if the source has a "<count> <dim>" header, the output has one too, recalculated
to the number of surviving words. If the source has none (e.g. GloVe .txt), the output
has none either.

Usage:
    uv run scripts/reduce_embedding.py cc.fr.300.vec --lang fr
    -> writes cc.fr.300_reduced.vec
"""

import argparse
import os
import re
import shutil
import sys
import tempfile

# Keep words (after the rules) until TOP_N have PASSED, then stop reading. TOP_N caps
# the number of KEPT words, not the number of source lines scanned. Easy to change.
TOP_N = 200000

CHAR_CLASS = {
    "en": "a-z",
    "fr": "a-zàâäéèêëîïôöùûüÿçœæ",
}

STOPWORDS = {
    "en": {
        "the", "a", "an", "and", "or", "but", "if", "of", "at", "by", "for", "with",
        "to", "from", "in", "on", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "can", "could",
        "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
        "as", "than", "then", "so", "not", "no", "nor", "too", "very", "just",
    },
    "fr": {
        "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "à", "au",
        "aux", "dans", "que", "qui", "quoi", "dont", "où", "pour", "par", "sur",
        "avec", "sans", "sous", "ne", "pas", "plus", "ce", "cet", "cette", "ces",
        "se", "son", "sa", "ses", "leur", "leurs", "on", "il", "elle", "ils",
        "elles", "nous", "vous", "je", "tu", "me", "te", "mon", "ma", "mes", "ton",
        "ta", "tes", "est", "sont", "était", "été", "être", "avoir", "comme", "mais",
    },
}

SAMPLE_CAP = 30  # number of examples kept per rule for the report


def make_rules(lang):
    """ORDERED list of rules (name, rejection-predicate). The first one that returns
    True decides the rejection. To add a filter, add a line here (and rerun)."""
    cc = CHAR_CLASS[lang]
    token_re = re.compile(rf"^[{cc}]+(-[{cc}]+)*$")
    stop = STOPWORDS[lang]
    return [
        ("majuscule",     lambda w: w != w.lower()),
        # len() on a Python str counts characters, not bytes: "à"/"é" are one letter.
        ("single-letter", lambda w: len(w) == 1),
        ("hors-alphabet", lambda w: not token_re.match(w)),
        ("stopword",      lambda w: w in stop),
        # Wordlist filter (later): load a DICO set of valid words, then
        # ("hors-dico",   lambda w: w not in DICO),
    ]


def classify(word, rules):
    for name, reject in rules:
        if reject(word):
            return name
    return None  # kept


def detect_header(first_line):
    """A .vec header = exactly two integers ('2000000 300'). Returns (has_header, dim)."""
    parts = first_line.split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        return True, parts[1]
    return False, None


def derive_path(inp):
    # Insert "_reduced" before the extension, preserving the original extension
    # (.vec OR .txt). If there is no extension, ext is "" and the suffix is appended
    # to the whole name.
    root, ext = os.path.splitext(inp)
    return root + "_reduced" + ext


def main():
    p = argparse.ArgumentParser(description="Réduit un embedding .vec en un fichier de jeu.")
    p.add_argument("input", help="chemin du .vec source (jamais modifié)")
    p.add_argument("--lang", choices=("en", "fr"), required=True)
    p.add_argument("--out", help="chemin de sortie (défaut : <input>_reduced.<ext>)")
    args = p.parse_args()

    if not os.path.exists(args.input):
        print(f"Erreur : fichier introuvable : {args.input}", file=sys.stderr)
        sys.exit(1)

    out_path = args.out or derive_path(args.input)

    rules = make_rules(args.lang)
    out_dir = os.path.dirname(os.path.abspath(out_path))

    scanned = 0     # SOURCE data lines read while filling the cap
    kept_count = 0  # words that PASSED the rules (this is what TOP_N caps)
    by_rule = {name: 0 for name, _ in rules}
    samples = {name: [] for name, _ in rules}

    # The body is written first to a temporary file: we only know the final count
    # (needed for the header) after the pass, and the header must be the FIRST line.
    # We then prepend the recalculated header by copying the body over.
    out_tmp = tempfile.NamedTemporaryFile("w", delete=False, dir=out_dir, encoding="utf-8")

    with open(args.input, encoding="utf-8") as f:
        first = f.readline()
        has_header, dim = detect_header(first)

        def body():
            if not has_header and first:
                yield first
            for line in f:
                yield line

        for line in body():
            word = line.rstrip("\n").split(" ", 1)[0]
            if not word:
                continue
            scanned += 1
            rule = classify(word, rules)
            if rule is not None:
                # Rejected: record it for the report and move on to the next line.
                by_rule[rule] += 1
                if len(samples[rule]) < SAMPLE_CAP:
                    samples[rule].append(word)
                continue
            # Passed: write it and count it toward the cap.
            out_tmp.write(line)
            kept_count += 1
            # Cap on KEPT words: once TOP_N have passed we stop reading (the source is
            # sorted, so we don't stream the remaining millions of lines).
            if kept_count >= TOP_N:
                break

    out_tmp.close()

    # Final write: recalculated header (if the source had one) then the body.
    with open(out_path, "w", encoding="utf-8") as out:
        if has_header:
            out.write(f"{kept_count} {dim}\n")
        with open(out_tmp.name, encoding="utf-8") as body_f:
            shutil.copyfileobj(body_f, out)
    os.remove(out_tmp.name)

    # --- Report (stderr) ---
    dropped = scanned - kept_count
    print(f"\nLangue : {args.lang}   en-tête source : {'oui' if has_header else 'non'}", file=sys.stderr)
    print(f"scanned {scanned:,} source lines to keep {kept_count:,}  (cap TOP_N = {TOP_N:,})", file=sys.stderr)
    print(f"Gardés   : {kept_count}", file=sys.stderr)
    print(f"Filtrés  : {dropped}", file=sys.stderr)
    for name, _ in rules:
        ex = ", ".join(samples[name][:12])
        print(f"  - {name:14s}: {by_rule[name]:>8d}   ex : {ex}", file=sys.stderr)
    if kept_count < TOP_N:
        print(f"⚠ Source épuisée : seulement {kept_count:,} mots gardés, cap TOP_N "
              f"= {TOP_N:,} NON atteint.", file=sys.stderr)

    # --- Path (stdout) ---
    print(out_path)


if __name__ == "__main__":
    main()
