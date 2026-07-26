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
           A participle whose NUMBER column is blank is invariable in number ("pris",
           "conquis"), so it emits both cells rather than defaulting to singular.
  dom      1 when the FORM's dominant part of speech (by Lexique frequency) is the
           verb — AUX counts as the verb category, since être/avoir are verbs and
           carry that tag. This is the POS gate: "évident" is a form of "évider" on
           paper, but it is overwhelmingly the adjective, so it is never "évidé".
           Rows stay in the table with dom=0 because such a form may still be the
           right REALIZATION of someone else's paradigm ("pensée" is a legitimate
           `par:pas:f:s` of "penser" while being dominantly the noun).

A form carrying SEVERAL verb lemmas ("durent" is both the present of durer and the
past historic of devoir; 61 forms of 64,834) is kept here in full — the table only
describes. Choosing between paradigms is refused downstream, in FormResolver.realize.

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

# Read from build_wordlist rather than restated: the URL is what makes the three
# builders share ONE download (and one cache file), so a bump must move all of them.
LEXIQUE_URL = bw.SOURCES["fr"]["lexique"]

# The languages that HAVE a form table. Anything else has no agreement pass at all —
# that is a deliberate non-goal, not a missing file (gen_phrase must not error on en).
FORM_LANGS = ("fr",)

# Lexique writes a past participle's agreement in its own columns, not in the atom.
# Fold them into the feature key so "par:pas" alone can never match the wrong gender.
_PARTICIPLE = "par:pas"

# Lexique tags être/avoir as AUX, not VER — but an auxiliary IS a verb, and the two most
# frequent verbs in French are exactly the ones that carry the tag. Reading AUX as a
# rival category made "avais", "ont", "avez", "étant" and 24 other in-vocabulary forms
# fail the POS gate, so the pass silently declined every one of them (and "avais -> eu"
# was unreachable). One rule for both places that ask the question.
_VERB_TAGS = ("VER", "AUX")


def is_verb(cgram):
    """Does this Lexique category denote a verb? VER and AUX both do."""
    return cgram.startswith(_VERB_TAGS)

# Lexique hangs spurious `infover` atoms on frequent spellings — "dois" claims `inf`,
# "marcher" claims `ind:imp:3s`, "baissée" claims `ind:imp:3s`. Because the realization
# tiebreak is frequency and those spellings ARE the frequent ones, the noise would win
# every time and print "il veut viens". Three rules drop it, each one a fact about
# French rather than a heuristic:
#
#   1. a VERB's lemma IS its infinitive in Lexique, so `inf` can only realize as the
#      lemma itself;
#   2. and no infinitive is also a finite form, so a non-`inf` feature can never
#      realize as the lemma;
# The third case is a PREFERENCE, not a drop, and the difference matters. A finite form
# does not agree in gender or number, so a non-participle atom on a gender+number-marked
# row is usually the participle's marking bleeding onto it — "baissée" is not an
# imperfect, "pensé" is not an imperative. But French also has rows where it is entirely
# real: for -ir verbs Lexique writes ONE row for the m:p participle and the 1s/2s present
# ("engourdis", "adoucis"), because they are the same spelling. Dropping those cost 18
# correct rewrites on the issue's own sentence. So a marked row simply sorts LAST within
# its (lemma, feature): "baissait" beats "baissée" because it exists, and "engourdis"
# still wins when it is the only candidate there is.


def spurious(atom, lemma, form):
    """Is this (row, atom) pair one of Lexique's known misfires? Rules 1 and 2 above."""
    if atom == "inf":
        return form != lemma
    return form == lemma


def false_lemmas(rows, token_re):
    """Lemmas that are really an inflected form Lexique mis-filed as its own entry.

    Rule 1 lets a self-naming `inf` row through by construction — `form == lemma` is
    exactly what it demands — so a row like "aurai / aurai / inf" survives beside the
    true "aurai / avoir / ind:fut:1s". That invents a second paradigm for the form,
    which then looks ambiguous (two lemmas, two features) and loses its agreement
    entirely: no batch run would ever agree an "aurai" hole.

    Two facts separate the mistake from a real verb, and BOTH are needed:

      - a real verb has a PARADIGM. "aurai" as a lemma owns exactly one row, its own
        infinitive; "allier" owns fifteen. That alone is not enough, because Lexique
        genuinely attests rare verbs in the infinitive only ("booster", "dépolluer") —
        those are correct entries and must stay.
      - a real verb's infinitive is not an inflected form of a DIFFERENT verb. "booster"
        is only ever itself; "aurai" is also the 1s future of "avoir". That alone is not
        enough either — "allier" is a form of "aller" through one of Lexique's bogus
        `lemme` rows, yet it is plainly a verb of its own.

    Together they name exactly four entries: aurai, connais, mentez, parait."""
    paradigm, elsewhere = {}, set()
    for ortho, lemme, cgram, _g, _n, infover, _f in rows:
        if not is_verb(cgram) or not infover:
            continue
        if not token_re.match(ortho) or not token_re.match(lemme):
            continue
        for atom in {a.strip() for a in infover.split(";") if a.strip()}:
            if spurious(atom, lemme, ortho):
                continue
            paradigm.setdefault(lemme, set()).add((atom, ortho))
            if lemme != ortho:
                elsewhere.add(ortho)
    return {lemma for lemma, rows_ in paradigm.items()
            if rows_ == {("inf", lemma)} and lemma in elsewhere}


def marked(atom, genre, nombre):
    """Does this atom sit on a row whose gender+number marking is not its own? Rule 3:
    a demotion, so a true form always beats it and a lone one still counts."""
    return atom != _PARTICIPLE and bool(genre) and bool(nombre)


def forms_path(lang):
    """Default versioned form table for a language: wordlist/<lang>.forms.tsv.gz."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.tsv.gz")


def feature_keys(atom, genre, nombre):
    """The feature string(s) stored for one `infover` atom — usually exactly one.

    Past participles inflect for gender and number, and those live in Lexique's own
    columns, so a bare "par:pas" would let a masculine target realize as "pensée".

    A BLANK number is not a missing value, it is Lexique saying "both": a masculine
    participle already ending in -s or -x ("pris", "conquis", "clos") is invariable in
    number, which is precisely why the column is empty — all 37 such rows end that way.
    Reading it as singular was wrong in both directions: "conquis" became an unambiguous
    m:s secret, so « ils sont conquis » silently agreed its neighbours to "amusé" instead
    of "amusés"; and m:p was unreachable for those lemmas, so a genuine plural sentence
    got no agreement at all. Emitting BOTH cells fixes each: the secret is now ambiguous
    and asks, and the plural cell exists to realize into.

    A blank GENDER is a different animal — a plain gap (one row, "créés"), where the
    masculine default is simply right — so it keeps defaulting rather than expanding."""
    if atom != _PARTICIPLE:
        return (atom,)
    numbers = (nombre,) if nombre else ("s", "p")
    return tuple(f"{atom}:{genre or 'm'}:{n}" for n in numbers)


def read_lexique_rows(path):
    """Lexique TSV -> (ortho, lemme, cgram, genre, nombre, infover, freq) tuples."""
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name: header.index(name) for name in
               ("ortho", "lemme", "cgram", "genre", "nombre", "infover",
                "freqfilms2", "freqlivres")}
        needed = max(idx.values())
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) <= needed:
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
    stays out: the gate only ever ADMITS evidence.

    AUX counts as the verb category, not as a rival: an auxiliary is a verb, and being
    outweighed by one's own auxiliary use is not evidence of being something else."""
    weight = {}
    for ortho, _lemme, cgram, _g, _n, _inf, freq in rows:
        if not token_re.match(ortho):
            continue
        pos = "VER" if is_verb(cgram) else (cgram or "?")
        weight.setdefault(ortho, {})
        weight[ortho][pos] = weight[ortho].get(pos, 0.0) + freq
    dominant = set()
    for ortho, per_pos in weight.items():
        if "VER" not in per_pos:
            continue
        rival = max((w for pos, w in per_pos.items() if pos != "VER"), default=-1.0)
        if per_pos["VER"] > rival:  # a TIE admits nothing: the gate wants evidence,
            dominant.add(ortho)     # and two categories at 0.0 are not evidence.
    return dominant


def collect_rows(rows, token_re, dominant, bogus=()):
    """Normalize Lexique's verb rows into the final deterministic (sortable) set.

    One entry per (lemma, feature, form); `infover` repeats atoms ("par:pas;par:pas;")
    so they are deduped here, and one atom may still yield several features when the row
    covers several cells (see feature_keys). Both sides must pass the language token
    rule, the same shape the reduction keeps, so the table can never name a form the
    embedding could not hold."""
    best = {}
    for ortho, lemme, cgram, genre, nombre, infover, freq in rows:
        if not is_verb(cgram) or not infover:
            continue
        if not token_re.match(ortho) or not token_re.match(lemme):
            continue
        if lemme in bogus:  # an inflected form mis-filed as its own entry
            continue
        for atom in {a.strip() for a in infover.split(";") if a.strip()}:
            if spurious(atom, lemme, ortho):
                continue
            rank = marked(atom, genre, nombre)
            for feature in feature_keys(atom, genre, nombre):
                key = (lemme, feature, ortho)
                prev = best.get(key)
                # a form reachable by an UNMARKED row is never demoted by a marked one
                best[key] = ((min(prev[0], rank), max(prev[1], freq)) if prev
                             else (rank, freq))
    return [(lemma, feature, form, 1 if form in dominant else 0, rank, freq)
            for (lemma, feature, form), (rank, freq) in best.items()]


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
        for lineno, line in enumerate(f, 1):
            parts = line.rstrip("\n").split("\t")
            # Loudly, not silently: a truncated artifact would otherwise load as a
            # partial table and agree half a puzzle.
            if len(parts) != 4:
                raise ValueError(f"{path}:{lineno}: 4 champs attendus, "
                                 f"{len(parts)} lus — table corrompue ?")
            lemma, feature, form, dom = parts
            entries.setdefault(form, []).append((lemma, feature))
            realize.setdefault((lemma, feature), form)
            features.add(feature)
            if dom == "1":
                dominant.add(form)
    return FormTable({form: tuple(rows) for form, rows in entries.items()},
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
    bogus = false_lemmas(read_lexique_rows(path), token_re)
    rows = collect_rows(read_lexique_rows(path), token_re, dominant, bogus)
    if not rows:
        print(f"Erreur : la source n'a produit aucune forme pour {lang}.", file=sys.stderr)
        sys.exit(1)

    # Sorted by (lemma, feature, marked, -freq, form): deterministic, and the FIRST row
    # of a (lemma, feature) pair is its preferred realization — which is what load_forms
    # reads. Sorting the whole line instead would hand that slot to the alphabet.
    rows.sort(key=lambda r: (r[0], r[1], r[4], -r[5], r[2]))

    out_path = forms_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for lemma, feature, form, dom, _rank, _freq in rows:
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
