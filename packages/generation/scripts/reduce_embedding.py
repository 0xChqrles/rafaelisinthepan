#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Reduce a .vec embedding to a small, game-ready file. The source is frequency-sorted,
so we stream it from the top, apply the rules to each word, and KEEP the survivors
until TOP_N of them have passed — then we stop reading. We never stream the remaining
millions, and never load any vector into memory.

The rules below drop the words we don't want BEFORE the cap is counted, so TOP_N bounds
the number of KEPT words, not the number of source lines scanned. The survivors are
written verbatim to a single <input>_reduced.<ext> file — the single source of truth the
rest of the pipeline consumes WITHOUT re-filtering. The output has EXACTLY TOP_N words,
unless the source is exhausted first (then fewer, with a warning).

Second output: because the front's existence set is a pure function of the KEPT words,
we emit it in the SAME pass — web/public/vocab/<lang>.json, the slugged/deduped/sorted
vocab (shared slug.write_vocab), plus its metadata for the backend in
packages/shared/src/vocab.generated.json (#200: size, longest key, corpus build). No
separate vector reload. Disable both with --no-vocab.

Monitoring is the per-rule report on stderr (counts + samples), plus how many source
lines were SCANNED to reach TOP_N kept (the scanned/kept ratio shows how noisy the head
of the embedding is).

Rules (first one that matches = reason a word is dropped):
  1. single-letter  : the word is a single letter (counted by character, so "à"/"é" count as one)
  2. stopword       : function word
  3. hors-dico      : the word is in neither the reference wordlist nor exact allowlist

The hors-dico rule (rule 3) does the heavy lifting: it drops anything that is neither an
entry in wordlist/<lang>.txt.gz nor an exact language-specific allowlist entry — which,
since both sets are lowercase and letters+hyphens only, subsumes what dedicated
"uppercase" and "non-alphabet" rules used to do (an uppercase or digit/markup token
simply isn't in either set). The two morphological rules that REMAIN are the ones
hors-dico can't cover, because their targets ARE valid dictionary entries: single letters
("a".."z" ship in Hunspell/SCOWL) and stopwords. There is NO frequency exemption — the
dictionary-or-allowlist check applies to every word.

Format: if the source has a "<count> <dim>" header, the output has one too, recalculated
to the number of surviving words. If the source has none (e.g. GloVe .txt), the output
has none either.

Usage:
    uv run scripts/reduce_embedding.py cc.fr.300.vec --lang fr
    -> writes cc.fr.300_reduced.vec
"""

import argparse
import gzip
import os
import re
import shutil
import sys
import tempfile

from slug import write_vocab  # shared, stdlib-only: emit the vocab from the kept words

# Keep words (after the rules) until TOP_N have PASSED, then stop reading. TOP_N caps
# the number of KEPT words, not the number of source lines scanned. Easy to change.
TOP_N = 400000

# Versioned reference wordlists consumed by the hors-dico rule, one per language. Built
# offline by scripts/build_wordlist.py; the pipeline only READS these committed files.
# Resolved relative to this script so it works regardless of the caller's cwd.
WORDLIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "wordlist")

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

# Deliberate non-dictionary vocabulary, matched exactly against the raw embedding token.
# Keep this narrow: it is an exception to hors-dico only, not to the earlier morphological
# rules, and lowercase matching avoids retaining duplicate case variants from fastText.
HORS_DICO_ALLOWLIST = {
    "en": frozenset(),
    "fr": frozenset({"rolex"}),
}

SAMPLE_CAP = 12  # examples kept per rule — exactly what the report prints


def token_pattern(lang):
    """Compiled regex for a valid token: the language's letters + internal hyphens only
    (`arc-en-ciel` ok, `-x`/`x-`/`co²` not). Used by scripts/build_wordlist.py to normalize
    the reference wordlist, so the wordlist contains exactly the token shapes reduce keeps
    — which is why hors-dico subsumes the old uppercase/non-alphabet rules."""
    cc = CHAR_CLASS[lang]
    return re.compile(rf"^[{cc}]+(-[{cc}]+)*$")


def make_rules(lang):
    """ORDERED list of MORPHOLOGICAL rules (name, rejection-predicate). The first one that
    returns True decides the rejection. These run BEFORE the hors-dico membership check and
    cover only what hors-dico can't: single letters and stopwords are valid dictionary
    entries, so the wordlist would otherwise KEEP them. Uppercase / non-alphabet tokens need
    no rule here — they simply aren't in the (lowercase, letters+hyphens) wordlist."""
    stop = STOPWORDS[lang]
    return [
        # len() on a Python str counts characters, not bytes: "à"/"é" are one letter.
        ("single-letter", lambda w: len(w) == 1),
        ("stopword",      lambda w: w in stop),
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


def dico_path(lang):
    """Default versioned wordlist for a language: wordlist/<lang>.txt.gz."""
    return os.path.join(WORDLIST_DIR, f"{lang}.txt.gz")


def load_dico(path):
    """Load a reference wordlist into a set. One word per line, already normalized
    (lowercase, accents kept — the hors-dico rule compares the pre-slug token). Reads
    gzip when the path ends in .gz, else plain UTF-8. Blank lines are ignored."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        return {w for line in f if (w := line.strip())}


def main():
    p = argparse.ArgumentParser(description="Réduit un embedding .vec en un fichier de jeu.")
    p.add_argument("input", help="chemin du .vec source (jamais modifié)")
    p.add_argument("--lang", choices=("en", "fr"), required=True)
    p.add_argument("--out", help="chemin de sortie (défaut : <input>_reduced.<ext>)")
    p.add_argument("--dico", help="chemin de la wordlist hors-dico "
                                  "(défaut : wordlist/<lang>.txt[.gz])")
    p.add_argument("--no-dico", action="store_true",
                   help="désactive la règle hors-dico (morphologie seule)")
    p.add_argument("--no-vocab", action="store_true",
                   help="n'écrit ni web/public/vocab/<lang>.json ni ses métadonnées")
    p.add_argument("--vocab-dir", dest="vocab_dir",
                   help="dossier de sortie du vocab (défaut : web/public/vocab)")
    p.add_argument("--meta-path", dest="meta_path",
                   help="fichier de sortie des métadonnées du vocab "
                        "(défaut : packages/shared/src/vocab.generated.json)")
    args = p.parse_args()

    if not os.path.exists(args.input):
        print(f"Erreur : fichier introuvable : {args.input}", file=sys.stderr)
        sys.exit(1)

    out_path = args.out or derive_path(args.input)

    # hors-dico rule 3: load the reference wordlist unless disabled. Fail loud on a
    # missing file — silently skipping the filter would ship lexical noise into vocab.
    dico = None
    if not args.no_dico:
        d_path = args.dico or dico_path(args.lang)
        if not os.path.exists(d_path):
            print(f"Erreur : wordlist hors-dico introuvable : {d_path}\n"
                  f"         construis-la avec scripts/build_wordlist.py, ou passe "
                  f"--no-dico pour t'en passer.", file=sys.stderr)
            sys.exit(1)
        dico = load_dico(d_path)

    rules = make_rules(args.lang)
    # Report reasons = morphological rules, plus hors-dico (rule 3) when the dico is active.
    reasons = [name for name, _ in rules] + (["hors-dico"] if dico is not None else [])
    out_dir = os.path.dirname(os.path.abspath(out_path))

    scanned = 0      # SOURCE data lines read while filling the cap
    kept_count = 0   # words KEPT (passed the morphological rules AND, if a dico, are in it)
    kept_words = []  # the KEPT words themselves — the front's vocab is a function of these
    by_rule = {name: 0 for name in reasons}
    samples = {name: [] for name in reasons}

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
                # Rejected by a morphological rule (single-letter / stopword): record + skip.
                by_rule[rule] += 1
                if len(samples[rule]) < SAMPLE_CAP:
                    samples[rule].append(word)
                continue
            # hors-dico (rule 3), applied LAST to EVERY survivor: reject words absent from
            # both the reference wordlist and the language-specific exact allowlist (no
            # frequency exemption).
            if (dico is not None
                    and word not in dico
                    and word not in HORS_DICO_ALLOWLIST[args.lang]):
                by_rule["hors-dico"] += 1
                if len(samples["hors-dico"]) < SAMPLE_CAP:
                    samples["hors-dico"].append(word)
                continue
            # Kept: write it, count it toward the cap, and remember it for the vocab.
            out_tmp.write(line)
            kept_count += 1
            kept_words.append(word)
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

    # Vocab: the front's existence set is a pure function of the KEPT words, which we
    # already have in hand — write it in the SAME pass (no separate vector reload). It
    # slugs + dedupes + sorts them into web/public/vocab/<lang>.json (shared write_vocab),
    # and records what that set is for the backend (#200) — named by the SOURCE embedding
    # we just streamed, which is the corpus build this whole run is about.
    if not args.no_vocab:
        write_vocab(kept_words, args.lang, args.input, args.vocab_dir, args.meta_path)

    # --- Report (stderr) ---
    dropped = scanned - kept_count
    print(f"\nLangue : {args.lang}   en-tête source : {'oui' if has_header else 'non'}", file=sys.stderr)
    print(f"scanned {scanned:,} source lines to keep {kept_count:,}  (cap TOP_N = {TOP_N:,})", file=sys.stderr)
    print(f"Gardés   : {kept_count}", file=sys.stderr)
    print(f"Filtrés  : {dropped}", file=sys.stderr)
    for name in reasons:
        ex = ", ".join(samples[name])
        print(f"  - {name:14s}: {by_rule[name]:>8d}   ex : {ex}", file=sys.stderr)
    if kept_count < TOP_N:
        print(f"⚠ Source épuisée : seulement {kept_count:,} mots gardés, cap TOP_N "
              f"= {TOP_N:,} NON atteint.", file=sys.stderr)

    # --- Path (stdout) ---
    print(out_path)


if __name__ == "__main__":
    main()
