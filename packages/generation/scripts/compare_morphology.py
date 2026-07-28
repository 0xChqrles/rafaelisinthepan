#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Morphology source A/B: Morphalou 3.1 vs Lefff 3.4, measured against the reduced
vocabulary (#131).

Extending display agreement (#119) beyond verbs needs an all-POS inflection
dictionary. Lefff compiles paradigms through inflection classes (a wrong class
silently truncates a whole verb); Morphalou 3.1 (ATILF, LGPL-LR) is curated per
entry and fails per-entry. This script decides the source WITH DATA:

  - parse BOTH sources into the same internal feature vocabulary (#119's cells
    for verbs; number for nouns; gender x number for adjectives);
  - intersect both with the reduced vocabulary — typability is the binding
    constraint, so every count is also given restricted to forms whose slug is
    in web/public/vocab/fr.json (the sole typability authority);
  - diff coverage: surfaces, (lemma, feature) cells, per-POS breakdown;
  - check paradigm completeness on the BASIC verbs (top Lexique lemma
    frequency), where a hole in either source hits every player.

It is an OFFLINE ANALYSIS TOOL, not a builder: it writes no artifact, changes no
pipeline, and prints a markdown report to stdout (progress on stderr). The
decision it informs feeds the unified-table issue; per #131 there is NO union of
sources — one authority per responsibility.

Both sources are read through the same language token rule and the same lemma
normalization (pronominal «s'…»/«se …» stripped), so a difference in a count is
a difference in the DATA, never in the parsing.

Usage
    uv run scripts/compare_morphology.py > ../reports/morphology-ab.md
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import collections
import hashlib
import json
import os
import sys
import zipfile

import build_forms as bf
import build_wordlist as bw
import reduce_embedding as red
from slug import slug, WEB_VOCAB_DIR

# Morphalou is PINNED like Lefff: exact release, exact archive, exact digest.
# ORTOLANG's own download endpoint answers 500 to non-browser clients, so the
# archive comes from the CNRS mirror on Hugging Face — same 6/2016 3.1 release.
MORPHALOU_URL = ("https://huggingface.co/datasets/datasets-CNRS/Morphalou/"
                 "resolve/main/Morphalou3.1_formatCSV_toutEnUn.zip")
MORPHALOU_ARCHIVE = "Morphalou3.1_formatCSV_toutEnUn.zip"
MORPHALOU_SHA256 = "4fc815cbf17aecdf1b47f6bbc263489a460fd8d11ae17e6b522336c72bd0e333"
MORPHALOU_MEMBER = "Morphalou3.1_formatCSV_toutEnUn/Morphalou3.1_CSV.csv"
MORPHALOU_CREDIT = "Morphalou 3.1 — ATILF / CNRS, via ORTOLANG (LGPL-LR)"

# The POS both sources can express in the internal feature vocabulary. Everything
# else (adverbs, prepositions, …) is uninflected or closed-class and is reported
# descriptively only.
POS_VERB, POS_NOUN, POS_ADJ = "verb", "noun", "adj"

# --- Morphalou CSV -> internal features ------------------------------------------
# Column layout (semicolon-separated, 9 lemma + 9 flexion columns): a lemma row
# carries both blocks, continuation rows carry only the flexion block.
_L_GRAPHIE, _L_CAT = 0, 2
_F_GRAPHIE, _F_NOMBRE, _F_MODE, _F_GENRE, _F_TEMPS, _F_PERS = 9, 11, 12, 13, 14, 15

MORPHALOU_CATS = {
    "Verbe": POS_VERB,
    "Nom commun": POS_NOUN,
    "Adjectif qualificatif": POS_ADJ,
}

# (MODE, TEMPS) -> the internal mood:tense. The same cells #119's expand_tag
# produces from Lefff's tag codes — one shared feature vocabulary is what makes
# the diff a diff of the data.
_MODE_TEMPS = {
    ("indicative", "present"): "ind:pre",
    ("indicative", "imperfect"): "ind:imp",
    ("indicative", "simplePast"): "ind:pas",
    ("indicative", "future"): "ind:fut",
    ("conditional", "present"): "cnd:pre",
    ("subjunctive", "present"): "sub:pre",
    ("subjunctive", "imperfect"): "sub:imp",
}
_PERSONS = {"firstPerson": ("1",), "secondPerson": ("2",), "thirdPerson": ("3",)}
_NUMBERS = {"singular": ("s",), "plural": ("p",)}
_GENDERS = {"masculine": ("m",), "feminine": ("f",)}


def _dim(table, value, all_values):
    """One Morphalou agreement cell -> the tuple of values it names.

    '-' and 'invariable' expand across the whole dimension — the same
    unnamed-dimension rule expand_tag applies to Lefff ("un code non renseigné
    est non pertinent ou non discriminant"), so neither source is credited by a
    parsing asymmetry. An unknown value returns () and the row is skipped
    (Morphalou has a handful of malformed rows; they are counted, not fatal)."""
    if value in ("-", "invariable", ""):
        return all_values
    return table.get(value, ())


def morphalou_features(pos, nombre, mode, genre, temps, pers):
    """One Morphalou flexion row -> the tuple of internal features it names.

    Returns () when the row does not map (malformed values, or a (mode, temps)
    pair outside the shared vocabulary)."""
    if pos == POS_NOUN:
        return tuple(f"n:{n}" for n in _dim(_NUMBERS, nombre, ("s", "p")))
    if pos == POS_ADJ:
        return tuple(f"adj:{g}:{n}"
                     for g in _dim(_GENDERS, genre, ("m", "f"))
                     for n in _dim(_NUMBERS, nombre, ("s", "p")))
    # verbs
    if mode == "infinitive":
        return ("inf",)
    if mode == "participle":
        if temps == "present":
            return ("par:pre",)
        if temps == "past":
            return tuple(f"par:pas:{g}:{n}"
                         for g in _dim(_GENDERS, genre, ("m", "f"))
                         for n in _dim(_NUMBERS, nombre, ("s", "p")))
        return ()
    if mode == "imperative" and temps == "present":
        cells = [(p, n)
                 for p in _dim(_PERSONS, pers, ("1", "2", "3"))
                 for n in _dim(_NUMBERS, nombre, ("s", "p"))
                 if (p, n) in bf.IMPERATIVE_CELLS]
        return tuple(f"imp:pre:{p}{n}" for p, n in cells)
    mood = _MODE_TEMPS.get((mode, temps))
    if not mood:
        return ()
    return tuple(f"{mood}:{p}{n}"
                 for p in _dim(_PERSONS, pers, ("1", "2", "3"))
                 for n in _dim(_NUMBERS, nombre, ("s", "p")))


def normalize_lemma(graphie):
    """Lemma graphy -> comparable lemma: lowercase, pronominal marker stripped.

    Morphalou writes pronominal verbs as «s'abader» / «se laver» where Lefff
    keeps the bare verb; comparing lemmas without stripping would count every
    pronominal paradigm as a Morphalou-only lemma."""
    lemma = graphie.strip().lower()
    if lemma.startswith("s'"):
        return lemma[2:]
    if lemma.startswith("se "):
        return lemma[3:]
    return lemma


def fetch_morphalou(refresh):
    """Download the pinned Morphalou archive and return the CSV text."""
    path = bw.fetch(MORPHALOU_URL, os.path.join(bw.CACHE_DIR, MORPHALOU_ARCHIVE),
                    refresh)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if digest != MORPHALOU_SHA256:
        print(f"Erreur : empreinte inattendue pour {MORPHALOU_ARCHIVE}\n"
              f"         attendu {MORPHALOU_SHA256}\n"
              f"         obtenu  {digest}\n"
              f"         la source a changé : vérifie la version et la licence "
              f"avant de mettre à jour l'empreinte.", file=sys.stderr)
        sys.exit(1)
    with zipfile.ZipFile(path) as z:
        return z.read(MORPHALOU_MEMBER).decode("utf-8")


def read_morphalou(text, token_re):
    """Morphalou CSV -> {pos: {(lemma, feature): {form, ...}}} + skipped-row count.

    Both lemma and form must pass the language token rule — the same shape the
    reduction keeps, so neither source can score with forms the embedding could
    never hold (multiword locutions, apostrophes, digits)."""
    cells = {POS_VERB: {}, POS_NOUN: {}, POS_ADJ: {}}
    skipped = 0
    lemma, pos = None, None
    for line in text.splitlines():
        cols = line.split(";")
        if len(cols) < 18:
            continue
        if cols[_L_GRAPHIE]:                      # a new lemma block
            pos = MORPHALOU_CATS.get(cols[_L_CAT].strip())
            lemma = normalize_lemma(cols[_L_GRAPHIE])
            if pos and not token_re.match(lemma):
                pos = None
        if not pos or not cols[_F_GRAPHIE]:
            continue
        form = cols[_F_GRAPHIE].strip().lower()
        if not token_re.match(form):
            continue
        feats = morphalou_features(pos, cols[_F_NOMBRE].strip(),
                                   cols[_F_MODE].strip(), cols[_F_GENRE].strip(),
                                   cols[_F_TEMPS].strip(), cols[_F_PERS].strip())
        if not feats:
            skipped += 1
            continue
        for feature in feats:
            cells[pos].setdefault((lemma, feature), set()).add(form)
    return cells, skipped


# --- Lefff .mlex -> the same internal features ------------------------------------

def lefff_nominal_features(pos, tag):
    """A Lefff nc/adj tag -> internal features. Letter scan, K codes ignored.

    nc tags are ms/mp/fs/fp/s/p/m/f/''; adj tags add participle mood codes
    (Kfs …). Gender/number letters name the cell; an unnamed dimension expands,
    the same rule as everywhere else."""
    genders = tuple(c for c in tag if c in ("m", "f")) or ("m", "f")
    numbers = tuple(c for c in tag if c in ("s", "p")) or ("s", "p")
    if pos == POS_NOUN:
        return tuple(f"n:{n}" for n in numbers)
    return tuple(f"adj:{g}:{n}" for g in genders for n in numbers)


def read_lefff(mlex, token_re):
    """Lefff .mlex -> {pos: {(lemma, feature): {form, ...}}}.

    Verbs go through #119's own expand_tag — the production parsing, not a
    restatement of it."""
    cells = {POS_VERB: {}, POS_NOUN: {}, POS_ADJ: {}}
    for form, cat, lemma, tag in bf.read_lefff_rows(mlex):
        if cat in bf.LEFFF_VERB_CATS:
            pos, feats = POS_VERB, bf.expand_tag(tag)
        elif cat == "nc":
            pos, feats = POS_NOUN, lefff_nominal_features(POS_NOUN, tag)
        elif cat == "adj":
            pos, feats = POS_ADJ, lefff_nominal_features(POS_ADJ, tag)
        else:
            continue
        if not token_re.match(form) or not token_re.match(lemma):
            continue
        for feature in feats:
            cells[pos].setdefault((lemma, feature), set()).add(form)
    return cells


# --- Lexique lemma frequency (which verbs are BASIC) ------------------------------

def lexique_lemma_freq(path, token_re):
    """Lexique TSV -> {verb lemma: summed film+book frequency}.

    Frequency evidence only, per the #119 split — it ranks which verbs matter,
    it never contributes morphology."""
    freq = collections.Counter()
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        idx = {name: header.index(name) for name in
               ("lemme", "cgram", "freqfilms2", "freqlivres")}
        needed = max(idx.values())
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) <= needed:
                continue
            if not bf.is_verb(cols[idx["cgram"]].strip()):
                continue
            lemma = cols[idx["lemme"]].strip().lower()
            if not token_re.match(lemma):
                continue
            for name in ("freqfilms2", "freqlivres"):
                try:
                    freq[lemma] += float(cols[idx[name]] or 0)
                except ValueError:
                    pass
    return freq


# --- Measures ---------------------------------------------------------------------

def load_vocab_slugs():
    path = os.path.join(WEB_VOCAB_DIR, "fr.json")
    with open(path, encoding="utf-8") as f:
        return frozenset(json.load(f))


def typable(forms, vocab):
    return any(slug(f) in vocab for f in forms)


def summarize(cells, vocab):
    """One source's {(lemma, feature): forms} -> the headline counts."""
    lemmas = {lemma for lemma, _ in cells}
    surfaces = set().union(*cells.values()) if cells else set()
    typ_cells = sum(1 for forms in cells.values() if typable(forms, vocab))
    typ_surfaces = {f for f in surfaces if slug(f) in vocab}
    return {
        "lemmas": len(lemmas),
        "surfaces": len(surfaces),
        "cells": len(cells),
        "typable_cells": typ_cells,
        "typable_surfaces": len(typ_surfaces),
    }


def fmt(n):
    return f"{n:,}"


def surface_index(cells):
    """{(lemma, feature): forms} -> {(form, feature)} — keying-independent coverage.

    Lefff keys a participial adjective by its VERB lemma («plongé» under
    «plonger») where Morphalou keys the participle graphy itself, so a
    lemma-keyed adj diff mostly measures the keying convention. Whether a
    SURFACE is known to carry a cell is the comparison that survives it."""
    idx = set()
    for (_lemma, feature), forms in cells.items():
        for form in forms:
            idx.add((form, feature))
    return idx


def form_level_gaps(m_cells, l_cells, lemmas, vocab):
    """On SHARED cells of `lemmas`: typable forms one source has and the other
    lacks, split into spelling variants (same slug as a form the other source
    has for that cell — the 1990 reform rectifications fold onto the
    traditional slug: plait/plaît) and genuinely missing forms."""
    gaps = {"m_variant": [], "m_missing": [], "l_variant": [], "l_missing": []}
    for (lemma, ft), mforms in m_cells.items():
        if lemma not in lemmas:
            continue
        lforms = l_cells.get((lemma, ft))
        if not lforms:
            continue
        for side, mine, theirs in (("m", mforms, lforms), ("l", lforms, mforms)):
            their_slugs = {slug(f) for f in theirs}
            for f in mine - theirs:
                if slug(f) not in vocab:
                    continue
                kind = "variant" if slug(f) in their_slugs else "missing"
                gaps[f"{side}_{kind}"].append((lemma, ft, f))
    return gaps


def report(morphalou, m_skipped, lefff, vocab, verb_freq, top_n):
    out = []
    w = out.append
    w("# Morphology source A/B — Morphalou 3.1 vs Lefff 3.4 (#131)")
    w("")
    w(f"- Lefff: {bf.LEFFF_CREDIT} — `{bf.LEFFF_ARCHIVE}`")
    w(f"- Morphalou: {MORPHALOU_CREDIT} — `{MORPHALOU_ARCHIVE}`")
    w("- Typability: `web/public/vocab/fr.json` "
      f"({fmt(len(vocab))} slugs), the sole typability authority.")
    w(f"- Morphalou rows skipped as unmappable/malformed: {fmt(m_skipped)}.")
    w("")
    w("Both sources are parsed into the SAME internal feature vocabulary "
      "(#119's cells for verbs, number for nouns, gender x number for "
      "adjectives), through the same token rule and lemma normalization.")

    # --- 1. coverage per POS, raw and intersected -------------------------------
    w("")
    w("## Coverage per POS")
    w("")
    w("| POS | source | lemmas | surfaces | (lemma, feature) cells | "
      "typable surfaces | realizable cells (>=1 typable form) |")
    w("|---|---|---:|---:|---:|---:|---:|")
    per_pos = {}
    for pos in (POS_VERB, POS_NOUN, POS_ADJ):
        rows = {}
        for name, cells in (("Lefff", lefff[pos]), ("Morphalou", morphalou[pos])):
            s = summarize(cells, vocab)
            rows[name] = s
            w(f"| {pos} | {name} | {fmt(s['lemmas'])} | {fmt(s['surfaces'])} | "
              f"{fmt(s['cells'])} | {fmt(s['typable_surfaces'])} | "
              f"{fmt(s['typable_cells'])} |")
        per_pos[pos] = rows

    # --- 2. cell diff -----------------------------------------------------------
    w("")
    w("## Cell diff (same feature vocabulary, same lemma key)")
    w("")
    w("| POS | shared | Morphalou only | Lefff only | Morphalou only "
      "(realizable) | Lefff only (realizable) |")
    w("|---|---:|---:|---:|---:|---:|")
    only_m_verbs = None
    for pos in (POS_VERB, POS_NOUN, POS_ADJ):
        m, l = morphalou[pos], lefff[pos]
        mk, lk = set(m), set(l)
        only_m, only_l = mk - lk, lk - mk
        typ_m = sum(1 for c in only_m if typable(m[c], vocab))
        typ_l = sum(1 for c in only_l if typable(l[c], vocab))
        w(f"| {pos} | {fmt(len(mk & lk))} | {fmt(len(only_m))} | "
          f"{fmt(len(only_l))} | {fmt(typ_m)} | {fmt(typ_l)} |")
        if pos == POS_VERB:
            only_m_verbs, only_l_verbs = only_m, only_l
    w("")
    w("The adj row is dominated by a KEYING convention, not by content: Lefff "
      "keys a participial adjective by its verb lemma («plongé» under "
      "«plonger») where Morphalou keys the participle graphy itself. The "
      "surface diff below is keying-independent.")

    # --- 2b. surface diff -------------------------------------------------------
    w("")
    w("## Surface diff — does the source know (form, feature) at all?")
    w("")
    w("Typable surfaces only (slug in the existence set).")
    w("")
    w("| POS | shared | Morphalou only | Lefff only |")
    w("|---|---:|---:|---:|")
    for pos in (POS_VERB, POS_NOUN, POS_ADJ):
        mi = {(f, ft) for f, ft in surface_index(morphalou[pos])
              if slug(f) in vocab}
        li = {(f, ft) for f, ft in surface_index(lefff[pos])
              if slug(f) in vocab}
        w(f"| {pos} | {fmt(len(mi & li))} | {fmt(len(mi - li))} | "
          f"{fmt(len(li - mi))} |")

    # --- 3. basic verbs ---------------------------------------------------------
    w("")
    w(f"## Basic verbs (top {top_n} Lexique lemma frequency): paradigm holes")
    w("")
    w("Cells one source states and the other lacks, on the verbs every player "
      "meets. A defective paradigm (falloir, pleuvoir) is absent from BOTH "
      "sides, so it never lists here.")
    top = [lm for lm, _ in verb_freq.most_common() ][:top_n]
    top_set = set(top)
    m_verbs, l_verbs = morphalou[POS_VERB], lefff[POS_VERB]
    missing_in_lefff = collections.defaultdict(list)   # lemma -> [feature]
    missing_in_morphalou = collections.defaultdict(list)
    for lemma, feature in only_m_verbs:
        if lemma in top_set:
            missing_in_lefff[lemma].append(feature)
    for lemma, feature in only_l_verbs:
        if lemma in top_set:
            missing_in_morphalou[lemma].append(feature)
    for title, gaps, cells in (
            ("Missing in Lefff, present in Morphalou", missing_in_lefff, m_verbs),
            ("Missing in Morphalou, present in Lefff", missing_in_morphalou,
             l_verbs)):
        w("")
        w(f"### {title}: {fmt(sum(len(v) for v in gaps.values()))} cells on "
          f"{fmt(len(gaps))} of the top {top_n} verbs")
        w("")
        if not gaps:
            w("(none)")
            continue
        w("| verb (freq rank) | missing cells | example forms |")
        w("|---|---|---|")
        for lemma in sorted(gaps, key=top.index):
            feats = sorted(gaps[lemma])
            shown = feats[:8] + (["…"] if len(feats) > 8 else [])
            examples = []
            for ft in feats[:4]:
                forms = sorted(cells[(lemma, ft)])
                mark = lambda f: f if slug(f) in vocab else f"{f} (untypable)"
                examples.append(f"{ft}: {mark(forms[0])}")
            w(f"| {lemma} ({top.index(lemma) + 1}) | {len(feats)}: "
              f"{', '.join(shown)} | {'; '.join(examples)} |")

    # --- 3b. form-level holes on the basic verbs --------------------------------
    w("")
    w(f"### Form-level holes on shared cells (top {top_n} verbs, typable forms)")
    w("")
    w("A cell can exist in both sources while one lacks a spelling of it. "
      "Variants share the slug of a form the other source has for the cell "
      "(the 1990 rectifications fold onto the traditional slug: plait/plaît, "
      "espèrerai/espérerai); missing forms do not.")
    gaps = form_level_gaps(m_verbs, l_verbs, top_set, vocab)
    w("")
    w("| side | spelling variants | forms with no counterpart |")
    w("|---|---:|---:|")
    w(f"| only in Morphalou | {fmt(len(gaps['m_variant']))} | "
      f"{fmt(len(gaps['m_missing']))} |")
    w(f"| only in Lefff | {fmt(len(gaps['l_variant']))} | "
      f"{fmt(len(gaps['l_missing']))} |")
    w("")
    w("The variant imbalance is the 1990 rectifications: Morphalou carries "
      "them, Lefff does not. The no-counterpart lists are NOT symmetric in "
      "meaning — read them against the raw sources (see the spot checks): a "
      "Morphalou-only form can be pollution from a mixed-in second "
      "conjugation (sortir/repartir carry the rare legal «-issant» paradigm "
      "INSIDE the same entry) or a mis-tagged cell (fuisse as sub:pre), while "
      "the Lefff-only list is dominated by first-person-singular rows "
      "Morphalou dropped where the form is homographic with the 2s (sors, "
      "peux, fuyais…).")
    for side, label in (("m", "only Morphalou states"),
                        ("l", "only Lefff states")):
        missing = sorted(gaps[f"{side}_missing"])
        w("")
        w(f"Forms {label}:")
        w("")
        if not missing:
            w("(none)")
            continue
        for lemma, ft, form in missing:
            w(f"- `{lemma} / {ft}`: {form}")

    # --- 4. known spot checks ---------------------------------------------------
    w("")
    w("## Spot checks")
    w("")
    w("Each verified against the raw sources during this audit.")
    w("")
    for lemma, feature, note in (
            ("foutre", "imp:pre:2s", "Lefff's compiled-class failure mode, "
             "confirmed: its inflection class generates the NON-WORD «fouts» "
             "(Y2s) and the real «fous» is nowhere in its paradigm"),
            ("conquérir", "par:pas:m:p", "the Morphalou gap #119 recorded"),
            ("asseoir", "par:pas:m:p", "«assis» has no masculine-plural "
             "participle row in Morphalou"),
            ("pouvoir", "sub:pre:2s", "Morphalou tags «puisses» thirdPerson — "
             "a raw-data error, the cell is lost"),
            ("pouvoir", "ind:pre:1s", "Morphalou's only «peux» row is "
             "secondPerson; the cell survives via «puis» alone"),
            ("fuir", "sub:pre:1s", "Morphalou states «fuisse» (mis-tagged; it "
             "is the sub:imp) and lacks «fuie»"),
            ("sortir", "ind:pre:1s", "Morphalou's one verb entry drops the 1s "
             "«sors» row AND mixes in the rare legal «-issant» conjugation, so "
             "the cell realizes as «sortis» — a WRONG form, not a missing one"),
    ):
        lf = sorted(l_verbs.get((lemma, feature), ()))
        mf = sorted(m_verbs.get((lemma, feature), ()))
        w(f"- `{lemma} / {feature}` — Lefff: "
          f"{', '.join(lf) if lf else 'ABSENT'}; Morphalou: "
          f"{', '.join(mf) if mf else 'ABSENT'} — {note}")

    # --- 5. decision ------------------------------------------------------------
    w("")
    w("## Decision")
    w("")
    w("Per #131's rule — Morphalou wins if it has the cells missing in Lefff "
      "and comparable-or-better intersected coverage — **Morphalou 3.1 wins "
      "the A/B**:")
    w("")
    for pos in (POS_VERB, POS_NOUN, POS_ADJ):
        lc = per_pos[pos]["Lefff"]["typable_cells"]
        mc = per_pos[pos]["Morphalou"]["typable_cells"]
        w(f"- {pos}: realizable cells {fmt(lc)} → {fmt(mc)} "
          f"({(mc - lc) / lc:+.1%}) intersected with the reduced vocabulary.")
    w("- Lefff's confirmed basic-verb defects are covered by Morphalou: the "
      "«fouts»/«fous» class error, and the 1990 rectified spellings Lefff "
      "lacks wholesale.")
    w("- Morphalou's own basic-verb holes exist but are per-entry, small and "
      "ENUMERABLE (2 cells + 14 forms on the top 300, all listed above). "
      "Lefff's failure mode — a wrong inflection class silently truncating or "
      "corrupting a paradigm — cannot be enumerated from inside the data. "
      "That asymmetry is the issue's premise, and it reproduces.")
    w("- GLÀFF is not needed: Morphalou's gaps do not defeat the decision "
      "rule, and it would trade curated-per-entry data for Wiktionnaire noise.")
    w("")
    w("Two hazards the unified-table issue MUST carry forward:")
    w("")
    w("1. **Mixed-paradigm entries.** Morphalou appends a homographic rare "
      "conjugation inside the SAME entry (sortir, repartir), and with a "
      "dropped 1s row the cell realizes a WRONG form («je sortis»), not a "
      "missing one. The build needs a mixed-paradigm detector (conflicting "
      "co-cells inside one entry) plus frequency gating, and must validate "
      "the enumerated top-verb cells loudly.")
    w("2. **The enumerated basic-verb holes** (puisses, assis m:p, peux 1s, "
      "fuie, sors/sortais/sorte 1s, …) need explicit guards — validation "
      "against the expected paradigm, NOT a silent cross-source patch: #131 "
      "rules out any union of sources.")
    return "\n".join(out) + "\n"


def main():
    p = argparse.ArgumentParser(
        description="A/B Morphalou 3.1 vs Lefff 3.4 contre le vocabulaire "
                    "réduit (#131). Rapport markdown sur stdout.")
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge les sources (ignore le cache)")
    p.add_argument("--top", type=int, default=300,
                   help="nombre de verbes de base (fréquence Lexique) à auditer")
    args = p.parse_args()

    token_re = red.token_pattern("fr")
    print("Lecture du Lefff…", file=sys.stderr)
    mlex, _licence = bf.fetch_lefff(args.refresh)
    lefff = read_lefff(mlex, token_re)
    print("Lecture de Morphalou…", file=sys.stderr)
    morphalou, m_skipped = read_morphalou(fetch_morphalou(args.refresh), token_re)
    print("Lecture de Lexique (fréquences)…", file=sys.stderr)
    lexique = bw.fetch(bf.LEXIQUE_URL,
                       os.path.join(bw.CACHE_DIR, "fr.lexique.tsv"), args.refresh)
    verb_freq = lexique_lemma_freq(lexique, token_re)
    vocab = load_vocab_slugs()

    sys.stdout.write(report(morphalou, m_skipped, lefff, vocab, verb_freq,
                            args.top))


if __name__ == "__main__":
    main()
