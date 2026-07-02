#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the reference wordlist consumed by reduce_embedding.py's hors-dico rule (rule 5).

For a language, this fetches the reference sources, takes their UNION (their gaps
differ, so the union has better coverage than either alone), normalizes every entry the
same way as an embedding token (lowercase; ACCENTS KEPT — the rule compares the pre-slug
form; drop anything that couldn't pass reduce_embedding's token rule), and writes the
versioned, deterministic file

    packages/generation/wordlist/<lang>.txt.gz

which reduce_embedding.py reads. This script is the OFFLINE builder: only it needs the
network and the `unmunch` tool. The pipeline itself only reads the committed .txt.gz.

Sources (UNION per language)
  fr : Lexique.org inflected-form lexicon (TSV, `ortho` column)  ∪  Hunspell fr unmunched
  en : SCOWL (size<=60, US) via app.aspell.net                   ∪  Hunspell en_US unmunched
  We deliberately do NOT use dwyl/english-words (noisy). Full inflected forms are wanted
  (conjugations, plurals, gendered forms) — no lemmatization.

Hunspell unmunching expands a .dic/.aff pair into every surface form; it needs the
`unmunch` binary (part of hunspell-tools), which is NOT bundled:
    macOS : brew install hunspell
    Debian: apt-get install hunspell-tools
Without it, pass --skip-hunspell to build the (smaller-coverage) Lexique/SCOWL-only union.

Usage
    uv run scripts/build_wordlist.py --lang fr
    uv run scripts/build_wordlist.py --lang en
    uv run scripts/build_wordlist.py --lang fr --skip-hunspell   # no unmunch available
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import gzip
import os
import shutil
import subprocess
import sys
import urllib.request

import reduce_embedding as red  # CHAR_CLASS / token_pattern — one source for the token rule

WORDLIST_DIR = red.WORDLIST_DIR
CACHE_DIR = os.path.join(WORDLIST_DIR, ".cache")
UA = "whippin-wordlist-builder/1.0 (+https://github.com/0xChqrles/rafaelisinthepan)"

# Reference sources per language. `lexique`/`scowl` are plain wordlist downloads; `hunspell`
# is a (.dic, .aff) pair fed to `unmunch`. URLs pin the current upstream revisions.
SOURCES = {
    "fr": {
        # Lexique383: one row per surface form; column `ortho` is the inflected spelling.
        "lexique": "http://www.lexique.org/databases/Lexique383/Lexique383.tsv",
        "hunspell": (
            "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/fr_FR/fr.dic",
            "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/fr_FR/fr.aff",
        ),
    },
    "en": {
        # SCOWL US, size<=60, keep diacritics (café/naïve), inline plain wordlist.
        "scowl": ("http://app.aspell.net/create?max_size=60&spelling=US&max_variant=1"
                  "&diacritic=keep&download=wordlist&encoding=utf-8&format=inline"),
        "hunspell": (
            "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.dic",
            "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.aff",
        ),
    },
}


def fetch(url, dest, refresh):
    """Download url to dest (cached). Returns dest."""
    if os.path.exists(dest) and not refresh:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"  ↓ {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def read_lexique(path):
    """Lexique TSV -> the `ortho` (inflected surface form) column."""
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = header.index("ortho")
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) > idx:
                yield cols[idx]


def read_flat(path):
    """A plain one-word-per-line list (SCOWL inline output)."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            w = line.strip()
            if w:
                yield w


def read_hunspell(dic_path, aff_path):
    """Expand a Hunspell .dic/.aff pair into every surface form via `unmunch`."""
    if shutil.which("unmunch") is None:
        print("Erreur : `unmunch` introuvable (hunspell-tools).\n"
              "  macOS : brew install hunspell\n"
              "  Debian: apt-get install hunspell-tools\n"
              "  ou relance avec --skip-hunspell (couverture réduite).", file=sys.stderr)
        sys.exit(1)
    # unmunch writes every generated form to stdout, one per line.
    out = subprocess.run(["unmunch", dic_path, aff_path],
                         capture_output=True, check=True)
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        w = line.strip()
        if w:
            yield w


def build(lang, *, skip_hunspell, refresh):
    src = SOURCES[lang]
    token_re = red.token_pattern(lang)
    words = set()
    per_source = {}

    def add(name, it):
        before = len(words)
        for w in it:
            w = w.strip().lower()          # normalize: lowercase, accents kept
            if token_re.match(w):          # keep only what could pass reduce's token rule
                words.add(w)
        per_source[name] = len(words) - before  # NEW words this source contributed

    if "lexique" in src:
        add("lexique", read_lexique(fetch(src["lexique"],
                                          os.path.join(CACHE_DIR, f"{lang}.lexique.tsv"), refresh)))
    if "scowl" in src:
        add("scowl", read_flat(fetch(src["scowl"],
                                     os.path.join(CACHE_DIR, f"{lang}.scowl.txt"), refresh)))
    if not skip_hunspell and "hunspell" in src:
        dic_url, aff_url = src["hunspell"]
        dic = fetch(dic_url, os.path.join(CACHE_DIR, f"{lang}.dic"), refresh)
        aff = fetch(aff_url, os.path.join(CACHE_DIR, f"{lang}.aff"), refresh)
        add("hunspell", read_hunspell(dic, aff))

    if not words:
        print(f"Erreur : aucune source n'a produit de mots pour {lang}.", file=sys.stderr)
        sys.exit(1)

    out_path = red.dico_path(lang)          # wordlist/<lang>.txt.gz
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:  # deterministic: sorted + unique
        for w in sorted(words):
            f.write(w + "\n")

    # --- Report (stderr) ---
    print(f"\nLangue : {lang}", file=sys.stderr)
    for name, n in per_source.items():
        print(f"  + {name:9s}: {n:>8d} nouveaux mots (union)", file=sys.stderr)
    if skip_hunspell:
        print("  (Hunspell ignoré : --skip-hunspell → couverture réduite)", file=sys.stderr)
    print(f"Union    : {len(words):,} mots -> {out_path}", file=sys.stderr)
    print(out_path)  # stdout: the built file path


def main():
    p = argparse.ArgumentParser(description="Construit la wordlist hors-dico d'une langue.")
    p.add_argument("--lang", choices=("en", "fr"), required=True)
    p.add_argument("--skip-hunspell", action="store_true",
                   help="n'unmunch pas Hunspell (si `unmunch` absent) — couverture réduite")
    p.add_argument("--refresh", action="store_true", help="re-télécharge les sources (ignore le cache)")
    args = p.parse_args()
    build(args.lang, skip_hunspell=args.skip_hunspell, refresh=args.refresh)


if __name__ == "__main__":
    main()
