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
  5. hors-dico      : the word is not in the language's reference wordlist — catches lexical
                      noise the morphological rules can't (typos of real words, letter-only
                      gibberish like "gksudo", dash fragments like "a-ligne"). Runs LAST so
                      report attribution stays clean, and it is SKIPPED for the top
                      FREQ_EXEMPT most frequent morphological survivors (the frequency safety
                      net — see below). Applied in the streaming loop, not as a stateless
                      predicate in make_rules(), because the exemption is positional.

Frequency safety net: the top FREQ_EXEMPT words that pass the morphological rules (1–4) SKIP
the hors-dico check. Position in the frequency-sorted source = frequency rank, so this exempts
the most common tokens: very frequent words absent from dictionaries are almost always
legitimate usage (slang, recent words) rather than typos, and dictionaries lag usage. Beyond
that rank the hors-dico rule applies. The report logs a sample of the words this exemption
SAVED (frequent but absent from the dico) — how FREQ_EXEMPT is tuned and dictionary gaps are
spotted.

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

# Keep words (after the rules) until TOP_N have PASSED, then stop reading. TOP_N caps
# the number of KEPT words, not the number of source lines scanned. Easy to change.
TOP_N = 400000

# Frequency safety net: the top FREQ_EXEMPT words that pass the MORPHOLOGICAL rules
# (majuscule/single-letter/hors-alphabet/stopword) skip the hors-dico check. Easy to change.
FREQ_EXEMPT = 40000

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

SAMPLE_CAP = 30  # number of examples kept per rule for the report


def token_pattern(lang):
    """Compiled regex for a valid token: the language's letters + internal hyphens only
    (`arc-en-ciel` ok, `-x`/`x-`/`co²` not). Shared by the hors-alphabet rule here and
    scripts/build_wordlist.py, so the wordlist is normalized to exactly what can pass."""
    cc = CHAR_CLASS[lang]
    return re.compile(rf"^[{cc}]+(-[{cc}]+)*$")


def make_rules(lang):
    """ORDERED list of rules (name, rejection-predicate). The first one that returns
    True decides the rejection. To add a filter, add a line here (and rerun)."""
    token_re = token_pattern(lang)
    stop = STOPWORDS[lang]
    return [
        ("majuscule",     lambda w: w != w.lower()),
        # len() on a Python str counts characters, not bytes: "à"/"é" are one letter.
        ("single-letter", lambda w: len(w) == 1),
        ("hors-alphabet", lambda w: not token_re.match(w)),
        ("stopword",      lambda w: w in stop),
        # hors-dico (rule 5) is NOT here: it needs the DICO set AND the per-word frequency
        # position (for the FREQ_EXEMPT safety net), which a stateless predicate can't see.
        # It is applied last, in main()'s streaming loop, and reported under "hors-dico".
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
    args = p.parse_args()

    if not os.path.exists(args.input):
        print(f"Erreur : fichier introuvable : {args.input}", file=sys.stderr)
        sys.exit(1)

    out_path = args.out or derive_path(args.input)

    # hors-dico rule 5: load the reference wordlist unless disabled. Fail loud on a
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
    # Report reasons = morphological rules, plus hors-dico (rule 5) when the dico is active.
    reasons = [name for name, _ in rules] + (["hors-dico"] if dico is not None else [])
    out_dir = os.path.dirname(os.path.abspath(out_path))

    scanned = 0       # SOURCE data lines read while filling the cap
    kept_count = 0    # words KEPT (passed morphology AND (in dico OR freq-exempt))
    passed_morph = 0  # words that passed the MORPHOLOGICAL rules (the FREQ_EXEMPT rank axis)
    exempt_saved = 0  # kept ONLY thanks to the freq exemption (absent from the dico)
    exempt_samples = []  # sample of those, to tune FREQ_EXEMPT / spot dictionary gaps
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
                # Rejected by a morphological rule: record it and move to the next line.
                by_rule[rule] += 1
                if len(samples[rule]) < SAMPLE_CAP:
                    samples[rule].append(word)
                continue
            # Passed morphology. This is the FREQ_EXEMPT rank axis (frequency-sorted source).
            passed_morph += 1
            # hors-dico (rule 5), applied LAST: reject words absent from the reference
            # wordlist — UNLESS this is one of the top FREQ_EXEMPT morphological survivors,
            # which are too frequent to be typos and so skip the dico check entirely.
            if dico is not None and word not in dico:
                if passed_morph <= FREQ_EXEMPT:
                    exempt_saved += 1  # frequent but absent from the dico: kept, and flagged
                    if len(exempt_samples) < SAMPLE_CAP:
                        exempt_samples.append(word)
                else:
                    by_rule["hors-dico"] += 1
                    if len(samples["hors-dico"]) < SAMPLE_CAP:
                        samples["hors-dico"].append(word)
                    continue
            # Kept: write it and count it toward the cap.
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
    for name in reasons:
        ex = ", ".join(samples[name][:12])
        print(f"  - {name:14s}: {by_rule[name]:>8d}   ex : {ex}", file=sys.stderr)
    if dico is not None:
        # Words the frequency safety net SAVED (top FREQ_EXEMPT, absent from the dico).
        # Watch this sample to tune FREQ_EXEMPT and spot dictionary gaps.
        ex = ", ".join(exempt_samples[:12])
        print(f"  · exempté-freq (top {FREQ_EXEMPT:,}, hors-dico gardés) : "
              f"{exempt_saved:>8d}   ex : {ex}", file=sys.stderr)
    if kept_count < TOP_N:
        print(f"⚠ Source épuisée : seulement {kept_count:,} mots gardés, cap TOP_N "
              f"= {TOP_N:,} NON atteint.", file=sys.stderr)

    # --- Path (stdout) ---
    print(out_path)


if __name__ == "__main__":
    main()
