#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the verb form table consumed by gen_phrase.py's display-agreement pass
(#119 addendum 2, re-sourced by addendum 3).

A hole displays the player's current best word, so that word should agree with the
sentence: in « tu t'___ » the blank must read "distrais", never "distraire". The
agreement target is the SECRET's own morphology, and turning a neighbour into that
form is a lookup — `lemma + feature -> form`. This script is the OFFLINE builder
(only it needs the network); the pipeline only READS the committed file:

    packages/generation/wordlist/fr.forms.tsv.gz

one `lemma<TAB>feature<TAB>form<TAB>dom` row per (lemma, feature, form) triple, under
a `#` header carrying provenance and licensing.

TWO SOURCES, ONE RESPONSIBILITY EACH (addendum 3)
-------------------------------------------------
Addendum 2 read morphology out of Lexique383's `infover`/`genre`/`nombre` columns,
because the repo already cached that download. That was the wrong shortcut: Lexique is
a CORPUS lexicon — its entries are limited to forms observed at least once in its
sources — so ordinary paradigm cells are missing wherever the corpus happens not to
attest them (1,901 lemmas with an `ind:pre:2s` row, against 7,777 in Lefff), while its
malformed rows needed ever more specific repair rules. So:

  Lefff 3.4      THE authority for verb morphology: surface form, verb lemma, mode,
                 tense, person, number, participle gender. It compiles lemmas through
                 explicit inflection classes, so a cell exists because the paradigm has
                 it, not because a corpus happened to show it.
  Lexique383     frequency / POS evidence ONLY — it decides whether a homographic
                 surface is dominantly verbal, and which of two spellings is preferred.
                 It no longer describes a single conjugation.
  reduced vocab  the sole typability authority, downstream in gen_phrase.

Because Lefff states the cells outright, every Lexique repair rule addendum 2 needed is
GONE rather than carried forward: no `spurious()` infover repair, no `false_lemmas()`
blacklist, no marked-row demotion, no blank-`nombre` expansion, no AUX recovery in the
morphological parser. Lefff gives `aurai` only as `F1s` of `avoir`, and `conquis` as
both `Kms` and `Kmp`.

  feature  one cell of the internal vocabulary: "ind:pre:2s", "sub:imp:3s", "inf",
           "par:pre", and participles with their agreement, "par:pas:m:s". Lefff's
           composite tags are EXPANDED into these (see expand_tag) — a tag naming
           several cells becomes several rows, never one opaque feature.
  dom      1 when the surface may be READ as a verb (the POS gate, see dominant_verbs).
           Rows stay in the table with dom=0 because such a form may still be the right
           REALIZATION of someone else's paradigm ("pensée" is a legitimate
           `par:pas:f:s` of "penser" while being dominantly the noun).

A form carrying SEVERAL verb lemmas ("durent" is both the present of durer and the past
historic of devoir) is kept here in full — the table only describes. Choosing between
paradigms is refused downstream, in FormResolver.realize.

Rows are sorted by (lemma, feature, -Lexique frequency, form), so the FIRST row of a
(lemma, feature) pair is its preferred realization: deterministic, and the reason the
sort key is not simply the whole line. Losing spellings are KEPT, only ordered after.

fr ONLY. English verbs carry ~4 forms and AGID's tagging is too coarse to be worth an
artifact, so `gen_phrase` skips the pass entirely for en (see FORM_LANGS).

Usage
    uv run scripts/build_forms.py --lang fr      (pnpm forms:fr)
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import gzip
import hashlib
import os
import sys
import tarfile
from collections import namedtuple

import build_wordlist as bw  # fetch() + the shared cache dir / UA
import reduce_embedding as red  # token_pattern — one source for the token rule

# --- Sources --------------------------------------------------------------------
# Lexique is read from build_wordlist rather than restated: the URL is what makes the
# builders share ONE download (and one cache file), so a bump must move all of them.
LEXIQUE_URL = bw.SOURCES["fr"]["lexique"]

# Lefff is PINNED — exact release, exact archive, exact digest. A morphological table
# is a licensed linguistic resource, so "whatever the URL serves today" is not good
# enough: the build must be reproducible and the provenance must be checkable.
LEFFF_URL = "https://gitlab.inria.fr/almanach/alexina/lefff/-/package_files/2570/download"
LEFFF_ARCHIVE = "lefff-3.4.0.mlex.tar.gz"
LEFFF_SHA256 = "d12ae1d54bba098b37b1a564095e7ff110d5efbac803e066262a54f263b46c49"
LEFFF_MEMBER = "lefff-3.4.mlex/lefff-3.4.mlex"
LEFFF_LICENSE_MEMBER = "lefff-3.4.mlex/LICENSE"

# The Inria resource page labels the current Lefff "CeCILL-L", while THIS distribution
# ships its own LICENSE file, and that file is the LGPL-LR. The notice travelling with
# the exact artifact governs the exact artifact, so the derived table is distributed
# under the LGPL-LR and carries its text verbatim beside it (see license_path). The
# discrepancy is recorded rather than silently resolved in either direction.
LEFFF_LICENSE_NAME = "LGPL-LR (Lesser General Public License For Linguistic Resources)"
LEFFF_CREDIT = "Lefff 3.4 — Lionel Clément, Benoît Sagot (Inria / ALMAnaCH)"

# The languages that HAVE a form table. Anything else has no agreement pass at all —
# that is a deliberate non-goal, not a missing file (gen_phrase must not error on en).
FORM_LANGS = ("fr",)

# Lefff categories that are verbs. The auxiliaries are their own categories, and they
# are verbs: être and avoir are exactly the forms that carry the tag.
LEFFF_VERB_CATS = frozenset({"v", "auxAvoir", "auxEtre"})

# --- The Lefff tagset (lefff-tagset-0.1.2.pdf) -----------------------------------
# A tag is a run of MOOD/TENSE codes followed by a set of person / gender / number
# letters. Case is what separates them: "P" is the present indicative, "p" is plural;
# "S" is the subjunctive, "s" is singular.
#
# Two rules from the tagset document drive the whole expansion, and both mean a tag can
# name SEVERAL cells at once:
#   - "lorsque plusieurs codes de même nature se suivent, cela signifie que la forme est
#     commune aux valeurs en question" — PS13s is one spelling covering indicative AND
#     subjunctive, 1st AND 3rd person singular;
#   - "un code non renseigné est non pertinent ou non discriminant pour la forme" — Km
#     is a masculine participle whose number does not discriminate ("admis" is both
#     singular and plural), which is exactly the case addendum 2 had to guess at from a
#     blank Lexique column.
# So a tag expands to the PRODUCT of its named values, and an unnamed dimension expands
# to all of its values. Never one opaque feature.
MOODS = {
    "P": "ind:pre",   # indicatif présent
    "F": "ind:fut",   # indicatif futur
    "I": "ind:imp",   # indicatif imparfait
    "J": "ind:pas",   # indicatif passé simple
    "C": "cnd:pre",   # conditionnel présent
    "Y": "imp:pre",   # impératif présent
    "S": "sub:pre",   # subjonctif présent
    "T": "sub:imp",   # subjonctif imparfait
    "K": "par:pas",   # participe passé
    "G": "par:pre",   # participe présent
    "W": "inf",       # infinitif présent
}
_PARTICIPLE = "par:pas"
_UNINFLECTED = ("par:pre", "inf")   # no person, gender or number to carry
PERSONS = ("1", "2", "3")
NUMBERS = ("s", "p")
GENDERS = ("m", "f")


def is_verb(cgram):
    """Does this LEXIQUE category denote a verb? VER and AUX both do.

    Used only by the POS gate now that morphology comes from Lefff: an auxiliary is a
    verb, and being outweighed by one's own auxiliary use is not evidence of being
    something else."""
    return cgram.startswith(("VER", "AUX"))


def expand_tag(tag):
    """One Lefff tag -> the tuple of internal features it names (possibly several).

    Returns () for a tag with no mood code — Lefff's `_error` placeholders and the
    handful of untagged entries (`voici`, `voilà`) — which is a skip, not a failure."""
    moods, rest = [], ""
    for i, ch in enumerate(tag):
        if ch in MOODS:
            moods.append(MOODS[ch])
        else:
            rest = tag[i:]
            break
    if not moods:
        return ()
    persons = tuple(c for c in rest if c in PERSONS) or PERSONS
    numbers = tuple(c for c in rest if c in NUMBERS) or NUMBERS
    genders = tuple(c for c in rest if c in GENDERS) or GENDERS
    features = []
    for mood in moods:
        if mood in _UNINFLECTED:
            features.append(mood)
        elif mood == _PARTICIPLE:
            features.extend(f"{mood}:{g}:{n}" for g in genders for n in numbers)
        else:
            features.extend(f"{mood}:{p}{n}" for p in persons for n in numbers)
    # dedupe while keeping the deterministic order above
    return tuple(dict.fromkeys(features))


def forms_path(lang):
    """Default versioned form table for a language: wordlist/<lang>.forms.tsv.gz."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.tsv.gz")


def license_path(lang):
    """The source license shipped beside the derived table, verbatim.

    The LGPL-LR asks that a copy travel with any work based on the resource, so the
    text is committed rather than linked: a URL is not a copy."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.LICENSE")


def fetch_lefff(refresh):
    """Download the pinned Lefff archive and return (mlex text, license text).

    The digest is verified before anything is read out of the archive: an artifact this
    file will be distributed under someone else's license must be the artifact we
    think it is."""
    path = bw.fetch(LEFFF_URL, os.path.join(bw.CACHE_DIR, LEFFF_ARCHIVE), refresh)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if digest != LEFFF_SHA256:
        print(f"Erreur : empreinte inattendue pour {LEFFF_ARCHIVE}\n"
              f"         attendu {LEFFF_SHA256}\n"
              f"         obtenu  {digest}\n"
              f"         la source a changé : vérifie la version et la licence avant "
              f"de mettre à jour l'empreinte.", file=sys.stderr)
        sys.exit(1)
    with tarfile.open(path, "r:gz") as tar:
        mlex = tar.extractfile(LEFFF_MEMBER).read().decode("utf-8")
        licence = tar.extractfile(LEFFF_LICENSE_MEMBER).read().decode("utf-8")
    return mlex, licence


def read_lefff_rows(text):
    """Lefff .mlex -> (form, category, lemma, tag) tuples. Four tab-separated fields."""
    for line in text.splitlines():
        cols = line.split("\t")
        if len(cols) < 4:
            continue
        yield (cols[0].strip().lower(), cols[1].strip(),
               cols[2].strip().lower(), cols[3].strip())


def read_lexique_rows(path):
    """Lexique TSV -> (ortho, cgram, freq) tuples. Frequency evidence only now."""
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name: header.index(name) for name in
               ("ortho", "cgram", "freqfilms2", "freqlivres")}
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
                   cols[idx["cgram"]].strip(),
                   freq)


def lexique_weights(rows, token_re):
    """surface -> {POS: summed frequency}, with VER and AUX merged as the verb."""
    weight = {}
    for ortho, cgram, freq in rows:
        if not token_re.match(ortho):
            continue
        pos = "VER" if is_verb(cgram) else (cgram or "?")
        weight.setdefault(ortho, {})
        weight[ortho][pos] = weight[ortho].get(pos, 0.0) + freq
    return weight


def dominant_verbs(weight, lefff_rows, token_re):
    """The surfaces that may be READ as a verb (the source-side POS gate).

    Lefff answers what verb form a spelling CAN be; it does not answer whether a
    homograph is normally used as one. So the gate stays, in two cases:

      1. Lexique has usable frequency evidence for the surface — admit only when the
         verbal category beats every rival. "évident" is 0.27 as a form of "évider" and
         20.14 as the adjective, so it is never read (nor written) as a verb, and
         "évident -> évidé" cannot happen.
      2. Lexique has none — the corpus simply never saw it, which is the ordinary case
         for the forms this whole feature exists to serve ("accoutumes"). Admit the
         surface only when Lefff gives it verb analyses AND no competing non-verbal
         one. A cross-POS homograph with no evidence either way is declined, not
         guessed.

    A gated form stays in the table as a TARGET: "pensée" may realize penser's
    `par:pas:f:s` while being dominantly the noun."""
    verbal, other = set(), set()
    for form, cat, _lemma, tag in lefff_rows:
        if not token_re.match(form):
            continue
        if cat in LEFFF_VERB_CATS:
            # a verb row only counts once it names a cell — Lefff's `_error` and
            # untagged placeholders are not analyses
            if expand_tag(tag):
                verbal.add(form)
        else:
            # ...but a NON-verb analysis competes whatever its tag looks like: a noun
            # row carries "ms", which is no mood code and would otherwise vanish here,
            # silently turning a contested homograph into an uncontested verb.
            other.add(form)
    dominant = set()
    for form in verbal:
        per_pos = weight.get(form)
        if per_pos and max(per_pos.values()) > 0:          # case 1: corpus evidence
            rival = max((w for pos, w in per_pos.items() if pos != "VER"), default=-1.0)
            if per_pos.get("VER", 0.0) > rival:
                dominant.add(form)
        elif form not in other:                            # case 2: Lefff alone
            dominant.add(form)
    return dominant


def collect_rows(lefff_rows, token_re, dominant, weight=None):
    """Lefff's verb entries -> the final deterministic (sortable) row set.

    One entry per (lemma, feature, form); a composite tag contributes one row per cell
    it names, and repeated analyses collapse. Both sides must pass the language token
    rule, the same shape the reduction keeps, so the table can never name a form the
    embedding could not hold."""
    weight = weight or {}
    seen = set()
    for form, cat, lemma, tag in lefff_rows:
        if cat not in LEFFF_VERB_CATS:
            continue
        if not token_re.match(form) or not token_re.match(lemma):
            continue
        for feature in expand_tag(tag):
            seen.add((lemma, feature, form))
    return [(lemma, feature, form, 1 if form in dominant else 0,
             sum(weight.get(form, {}).values()))
            for lemma, feature, form in seen]


FormTable = namedtuple("FormTable", "entries dominant realize features")


def load_forms(path):
    """Load a committed form table into the three indexes gen_phrase needs.

    entries   form -> ((lemma, feature), ...)  — what a surface form IS
    dominant  {form}                            — forms the POS gate admits
    realize   (lemma, feature) -> form          — first row wins (see the sort rule)
    features  {feature}                         — the inventory, for validating --form

    `#` lines are the provenance/licence header and are skipped; any other malformed
    line is an error, loudly, because a truncated artifact would otherwise load as a
    partial table and agree half a puzzle."""
    entries, dominant, realize, features = {}, set(), {}, set()
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
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


def header_lines(lang):
    """The provenance + licence block written above the rows.

    A derived linguistic resource that names no source is not auditable, and the LGPL-LR
    asks for the notice to travel with the work — so it travels IN the artifact, not
    only in this script."""
    return [
        f"# {lang}.forms.tsv.gz — verb morphology for the display-agreement pass (#119).",
        "# Built by scripts/build_forms.py (pnpm forms:fr). Do not edit by hand.",
        "#",
        f"# Morphology  : {LEFFF_CREDIT}",
        f"#               {LEFFF_URL}",
        f"#               {LEFFF_ARCHIVE} sha256:{LEFFF_SHA256}",
        f"#               Licence: {LEFFF_LICENSE_NAME}; full text in "
        f"{os.path.basename(license_path(lang))}.",
        f"# POS evidence: Lexique383 (surface frequency only) — {LEXIQUE_URL}",
        "#",
        "# lemma<TAB>feature<TAB>form<TAB>dom",
    ]


def build_rows(lang, mlex, lexique_path):
    """The deterministic core: the two sources -> the exact rows the artifact holds.

    Split out of build() so the reproduction test can run the REAL path over the cached
    downloads instead of restating the sort key — a test that mirrors the code proves
    nothing about it."""
    token_re = red.token_pattern(lang)
    lefff = list(read_lefff_rows(mlex))
    weight = lexique_weights(read_lexique_rows(lexique_path), token_re)
    dominant = dominant_verbs(weight, lefff, token_re)
    rows = collect_rows(lefff, token_re, dominant, weight)
    # Sorted by (lemma, feature, -freq, form): deterministic, and the FIRST row of a
    # (lemma, feature) pair is its preferred realization — which is what load_forms
    # reads. A losing spelling is ordered after, never dropped.
    rows.sort(key=lambda r: (r[0], r[1], -r[4], r[2]))
    return rows


def row_line(lemma, feature, form, dom):
    """One artifact line. The single place the row shape is written."""
    return f"{lemma}\t{feature}\t{form}\t{dom}"


def build(lang, *, refresh):
    if lang not in FORM_LANGS:
        print(f"Erreur : pas de table de formes pour '{lang}' "
              f"(langues : {', '.join(FORM_LANGS)}).", file=sys.stderr)
        sys.exit(1)

    mlex, licence = fetch_lefff(refresh)
    lexique = bw.fetch(LEXIQUE_URL,
                       os.path.join(bw.CACHE_DIR, f"{lang}.lexique.tsv"), refresh)
    rows = build_rows(lang, mlex, lexique)
    if not rows:
        print(f"Erreur : la source n'a produit aucune forme pour {lang}.", file=sys.stderr)
        sys.exit(1)

    out_path, lic_path = forms_path(lang), license_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(lic_path, "w", encoding="utf-8") as f:
        f.write(licence if licence.endswith("\n") else licence + "\n")
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for line in header_lines(lang):
            f.write(line + "\n")
        for lemma, feature, form, dom, _freq in rows:
            f.write(row_line(lemma, feature, form, dom) + "\n")

    # --- Report (stderr): coverage by feature is the number addendum 3 is about ---
    lemmas = {r[0] for r in rows}
    surface = {r[2] for r in rows}
    gated = sum(1 for r in rows if r[3] == 0)
    per_feature = {}
    for lemma, feature, _form, _dom, _freq in rows:
        per_feature.setdefault(feature, set()).add(lemma)
    print(f"\nLangue : {lang}", file=sys.stderr)
    print(f"Formes  : {len(rows):,} lignes ({len(surface):,} formes, "
          f"{len(lemmas):,} lemmes, {len(per_feature):,} traits)", file=sys.stderr)
    print(f"          {gated:,} lignes hors-gabarit POS (dom=0, jamais lues comme "
          f"verbe)", file=sys.stderr)
    print(f"Licence : {LEFFF_LICENSE_NAME} -> {lic_path}", file=sys.stderr)
    print("Couverture par trait (lemmes) :", file=sys.stderr)
    for feature in sorted(per_feature, key=lambda k: (-len(per_feature[k]), k)):
        print(f"          {feature:<14} {len(per_feature[feature]):>6,}", file=sys.stderr)
    print(f"-> {out_path}", file=sys.stderr)
    print(out_path)  # stdout: the built file path


def main():
    p = argparse.ArgumentParser(
        description="Construit la table lemme+trait→forme d'une langue (fr).")
    p.add_argument("--lang", choices=FORM_LANGS, default="fr")
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge les sources (ignore le cache)")
    args = p.parse_args()
    build(args.lang, refresh=args.refresh)


if __name__ == "__main__":
    main()
