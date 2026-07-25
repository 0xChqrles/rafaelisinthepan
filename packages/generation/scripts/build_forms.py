#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the verb form table consumed by gen_phrase.py's display-agreement pass
(#119 addendum 2).

A hole displays the player's current best word, so that word should agree with the
sentence: in « tu t'___ » the blank must read "distrais", never "distraire". The
agreement target is the SECRET's own morphology, and turning a neighbour into that
form is a lookup — `lemma + feature -> form` — which is exactly what Lexique383's
`infover` / `genre` / `nombre` columns describe. This script is the OFFLINE builder
(only it needs the network); the pipeline only READS the committed file:

    packages/generation/wordlist/fr.forms.tsv.gz

one `lemma<TAB>feature<TAB>form<TAB>dom` row per (lemma, feature, form) triple.

  feature  a single `infover` atom ("ind:pre:2s", "sub:imp:3s", "inf"), except past
           participles, which carry their agreement: "par:pas:m:s", "par:pas:f:p".
           An unmarked participle is read as masculine singular, as in French.
  dom      1 when the FORM's dominant part of speech (by Lexique frequency) is the
           verb. This is the POS gate: "évident" is a form of "évider" on paper, but
           it is overwhelmingly the adjective, so it is never rewritten to "évidé".
           Rows stay in the table with dom=0 because such a form may still be the
           right REALIZATION of someone else's paradigm ("pensée" is a legitimate
           `par:pas:f:s` of "penser" while being dominantly the noun).

Rows are sorted by (lemma, feature, frequency rank, form), so the FIRST row of a
(lemma, feature) pair is its preferred realization — deterministic, and the reason
the sort key is not simply the whole line.

fr ONLY. English verbs carry ~4 forms and AGID's tagging is too coarse to be worth
an artifact, so `gen_phrase` skips the pass entirely for en (see FORM_LANGS).

Usage
    uv run scripts/build_forms.py --lang fr      (pnpm forms:fr)
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import gzip
import os
import sys
from collections import namedtuple

import build_wordlist as bw  # fetch() + the shared cache dir / UA
import reduce_embedding as red  # token_pattern — one source for the token rule

# Same download (and cache file) as build_wordlist / build_lemmas: one fetch, three
# artifacts.
LEXIQUE_URL = "http://www.lexique.org/databases/Lexique383/Lexique383.tsv"

# The languages that HAVE a form table. Anything else has no agreement pass at all —
# that is a deliberate non-goal, not a missing file (gen_phrase must not error on en).
FORM_LANGS = ("fr",)

# Lexique writes a past participle's agreement in its own columns, not in the atom.
# Fold them into the feature key so "par:pas" alone can never match the wrong gender.
_PARTICIPLE = "par:pas"


def forms_path(lang):
    """Default versioned form table for a language: wordlist/<lang>.forms.tsv.gz."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.tsv.gz")


def feature_key(atom, genre, nombre):
    """The feature string stored for one `infover` atom.

    Past participles inflect for gender and number, and those live in Lexique's own
    columns, so a bare "par:pas" would let a masculine target realize as "pensée".
    Unmarked agreement reads as masculine singular, which is what French does."""
    if atom == _PARTICIPLE:
        return f"{atom}:{genre or 'm'}:{nombre or 's'}"
    return atom


def read_lexique_rows(path):
    """Lexique TSV -> (ortho, lemme, cgram, genre, nombre, infover, freq) tuples."""
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name: header.index(name) for name in
               ("ortho", "lemme", "cgram", "genre", "nombre", "infover",
                "freqfilms2", "freqlivres")}
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) <= max(idx.values()):
                continue
            freq = 0.0
            for name in ("freqfilms2", "freqlivres"):
                try:
                    freq += float(cols[idx[name]] or 0)
                except ValueError:
                    pass
            yield (cols[idx["ortho"]].strip().lower(),
                   cols[idx["lemme"]].strip().lower(),
                   cols[idx["cgram"]].strip(),
                   cols[idx["genre"]].strip(),
                   cols[idx["nombre"]].strip(),
                   cols[idx["infover"]].strip(),
                   freq)


def dominant_verbs(rows, token_re):
    """The forms whose DOMINANT part of speech is the verb (the POS gate).

    Lexique lists one row per (form, lemma, category), so a form can be both a rare
    verb form and a common adjective — "évident" is 0.27 as a form of "évider" and
    20.14 as the adjective. Summing frequency per category and keeping the winner is
    what stops the pass from rewriting it to "évidé". A form nothing is known about
    stays out: the gate only ever ADMITS evidence."""
    weight = {}
    for ortho, _lemme, cgram, _g, _n, _inf, freq in rows:
        if not token_re.match(ortho):
            continue
        pos = "VER" if cgram.startswith("VER") else (cgram or "?")
        weight.setdefault(ortho, {})
        weight[ortho][pos] = weight[ortho].get(pos, 0.0) + freq
    dominant = set()
    for ortho, per_pos in weight.items():
        if "VER" not in per_pos:
            continue
        best = max(per_pos.items(), key=lambda kv: (kv[1], kv[0] == "VER"))
        if best[0] == "VER":
            dominant.add(ortho)
    return dominant


def collect_rows(rows, token_re, dominant):
    """Normalize Lexique's verb rows into the final deterministic (sortable) set.

    One entry per (lemma, feature, form); `infover` repeats atoms ("par:pas;par:pas;")
    so they are deduped here. Both sides must pass the language token rule, the same
    shape the reduction keeps, so the table can never name a form the embedding could
    not hold."""
    best = {}
    for ortho, lemme, cgram, genre, nombre, infover, freq in rows:
        if not cgram.startswith("VER") or not infover:
            continue
        if not token_re.match(ortho) or not token_re.match(lemme):
            continue
        for atom in {a.strip() for a in infover.split(";") if a.strip()}:
            key = (lemme, feature_key(atom, genre, nombre), ortho)
            best[key] = max(best.get(key, 0.0), freq)
    return [(lemma, feature, form, 1 if form in dominant else 0, freq)
            for (lemma, feature, form), freq in best.items()]


FormTable = namedtuple("FormTable", "entries dominant realize features")


def load_forms(path):
    """Load a committed form table into the three indexes gen_phrase needs.

    entries   form -> ((lemma, feature), ...)  — what a surface form IS
    dominant  {form}                            — forms the POS gate admits
    realize   (lemma, feature) -> form          — first row wins (see the sort rule)
    features  {feature}                         — the inventory, for validating --form
    """
    entries, dominant, realize, features = {}, set(), {}, set()
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 4:
                continue
            lemma, feature, form, dom = parts
            entries.setdefault(form, []).append((lemma, feature))
            realize.setdefault((lemma, feature), form)
            features.add(feature)
            if dom == "1":
                dominant.add(form)
    return FormTable({f: tuple(v) for f, v in entries.items()},
                     dominant, realize, frozenset(features))


def build(lang, *, refresh):
    if lang not in FORM_LANGS:
        print(f"Erreur : pas de table de formes pour '{lang}' "
              f"(langues : {', '.join(FORM_LANGS)}).", file=sys.stderr)
        sys.exit(1)

    path = bw.fetch(LEXIQUE_URL,
                    os.path.join(bw.CACHE_DIR, f"{lang}.lexique.tsv"), refresh)
    token_re = red.token_pattern(lang)
    dominant = dominant_verbs(read_lexique_rows(path), token_re)
    rows = collect_rows(read_lexique_rows(path), token_re, dominant)
    if not rows:
        print(f"Erreur : la source n'a produit aucune forme pour {lang}.", file=sys.stderr)
        sys.exit(1)

    # Sorted by (lemma, feature, -freq, form): deterministic, and the FIRST row of a
    # (lemma, feature) pair is its preferred realization — which is what load_forms
    # reads. Sorting the whole line instead would hand that slot to the alphabet.
    rows.sort(key=lambda r: (r[0], r[1], -r[4], r[2]))

    out_path = forms_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for lemma, feature, form, dom, _freq in rows:
            f.write(f"{lemma}\t{feature}\t{form}\t{dom}\n")

    # --- Report (stderr) ---
    lemmas = {r[0] for r in rows}
    feats = {r[1] for r in rows}
    surface = {r[2] for r in rows}
    gated = sum(1 for r in rows if r[3] == 0)
    print(f"\nLangue : {lang}", file=sys.stderr)
    print(f"Formes  : {len(rows):,} lignes ({len(surface):,} formes, "
          f"{len(lemmas):,} lemmes, {len(feats):,} traits)", file=sys.stderr)
    print(f"          {gated:,} lignes hors-gabarit POS (dom=0, jamais réécrites) "
          f"-> {out_path}", file=sys.stderr)
    print(out_path)  # stdout: the built file path


def main():
    p = argparse.ArgumentParser(
        description="Construit la table lemme+trait→forme d'une langue (fr).")
    p.add_argument("--lang", choices=FORM_LANGS, default="fr")
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge la source (ignore le cache)")
    args = p.parse_args()
    build(args.lang, refresh=args.refresh)


if __name__ == "__main__":
    main()
