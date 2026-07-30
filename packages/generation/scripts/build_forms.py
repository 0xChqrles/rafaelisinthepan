#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the ONE fr lexeme inventory consumed by gen_phrase.py (#132).

Before #132 two different sources defined what a lexeme is: Lexique/AGID for the
rank-map lemma grouping (#104) and Lefff (verbs only) for display agreement (#119).
Two identities meant mismatch bugs waiting to happen: a surface grouped under lemma A
by one table while the morphology table inflected it under lemma B — aliases pointing
at one group while display forms come from another. So ONE dictionary now defines the
lexeme for grouping, ranking and display alike, and this script is its offline
builder (only it needs the network); the pipeline only READS the committed file:

    packages/generation/wordlist/fr.forms.tsv.gz

one `lemma<TAB>pos<TAB>feature<TAB>form<TAB>dom` row per (lexeme, feature, form)
triple, under a `#` header carrying provenance and licensing. A lexeme is
(lemma, pos): «vers» the noun and «vers» the preposition are two lexemes, and
homography is DERIVABLE from the rows — a surface shared across lexemes appears
under each of them, which is what the ranking rule (#134) will read.

TWO SOURCES, ONE RESPONSIBILITY EACH
------------------------------------
  Morphalou 3.1  THE authority for the lexeme: every part of speech, every lemma,
                 every inflected form, every cell. Chosen over Lefff by the #131 A/B:
                 measured against the reduced vocabulary it holds more realizable
                 cells for every POS (verb +12%, noun +37%, adj +25%), it carries the
                 1990 rectified spellings, and it fails per-ENTRY where Lefff's
                 compiled inflection classes fail per-CLASS (its class for «foutre»
                 generates the non-word «fouts» and nothing inside the data can say
                 so; Morphalou's holes are enumerable — see EXPECTED_CELLS).
  Lexique383     frequency / POS evidence ONLY — it decides which reading of a
                 homographic surface is dominant (the `dom` column), and which of two
                 spellings a cell prefers. It contributes no morphology and no
                 grouping. (It stays the source of the #38 wordlist and the en #104
                 lemma table, which are different questions.)
  reduced vocab  the sole typability authority, downstream in gen_phrase.

MIXED-PARADIGM CLEANUP (the #131 hazard, measured before it was written)
------------------------------------------------------------------------
Morphalou 3.1 is a mechanical fusion of five lexicons, and the fusion glued a few
wrong paradigms INSIDE otherwise-correct entries: «sortir» carries the rare legal
«-issant» conjugation next to the real one (from DELA), so with the real 1s row
missing, ind:pre:1s would REALIZE the wrong form «je sortis» — worse than a hole.
The per-row ORIGINES column is what tells them apart, and the rule was chosen by
measurement (#131's enumerated cases as the test set):

  - a row is CORROBORATED when its origins include the curated core (morphalou2) or
    an independent compiled morphology (lefff, lglexlefff);
  - inside an entry that has corroborated rows, an uncorroborated row (dela and/or
    dicollecte only, or no origin at all) is DROPPED — unless its slug matches a kept
    form of the same cell, which keeps slug-folding spelling variants;
  - an entry with NO corroborated row keeps its whole (coherent, single-source)
    paradigm: the hazard is mixing, not provenance.

Measured effect: every #131-enumerated pollution row is dropped (the «-iss-» family,
the mis-tagged «fuisse», the wrong-only «sortis»/«repartis» present cells) at a cost
of −0.13% realizable verb cells, while every enumerated legitimate row survives
(paie/paye, assois/assieds, the dela+lefff repairs of the core's missing 1s rows,
«fous», «puis», the 1990 variants). Frequency then orders, it never invents: within a
kept cell the Lexique-most-frequent spelling realizes first («sort» before «fouts»).

Morphalou's own enumerated holes are NOT patched — #131 rules out any union of
sources — they are GUARDED: EXPECTED_CELLS pins each one and the build fails loudly
when the data under them moves, so a source bump or a rule edit forces a re-audit
instead of silently shipping different morphology.

  feature  one cell of the internal vocabulary. Verbs keep #119's cells ("ind:pre:2s",
           "sub:imp:3s", "inf", "par:pre", "par:pas:m:s"); nouns carry number ("n:s",
           "n:p" — gender is lexical, not inflectional); adjectives carry gender x
           number ("adj:m:s"); every other POS carries the citation cell "cit" (they
           exist for grouping and homography, not for agreement). An unnamed source
           dimension ('-' / 'invariable') expands across its whole dimension, never
           into an opaque feature.
  dom      1 when this row's POS is the DOMINANT reading of this surface: with
           Lexique frequency for the surface the row's class must strictly beat every
           rival («évident» is never read as a verb), without it the surface must be
           analysable as this class and nothing else («accoutumes»), never guessed.
           Rows stay in the table with dom=0 because such a form may still be the
           right REALIZATION of someone else's paradigm («pensée» is a legitimate
           `par:pas:f:s` of «penser» while being dominantly the noun).

A form carrying SEVERAL verb lexemes («durent» is both the present of durer and the
past historic of devoir) is kept here in full — the table only describes. Choosing
between paradigms is refused downstream, in FormResolver.realize.

Rows are sorted by (lemma, pos, feature, -Lexique frequency, form), so the FIRST row
of a cell is its preferred realization: deterministic, and the reason the sort key is
not simply the whole line. Losing spellings are KEPT, only ordered after — and
`load_forms` hands the caller the whole ordered list, so "preferred" can fall back to
"typable" instead of the cell going unrealized.

fr ONLY. English keeps its AGID lemma table (#104) and has no forms table — a decided
non-goal, not a missing file (see FORM_LANGS).

Usage
    uv run scripts/build_forms.py --lang fr      (pnpm forms:fr)
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import csv
import gzip
import hashlib
import html
import io
import os
import re
import sys
import zipfile
from collections import namedtuple

import build_wordlist as bw  # fetch() + the shared cache dir / UA
import reduce_embedding as red  # token_pattern — one source for the token rule
from slug import slug  # spelling-variant rescue in the cleanup compares SLUGS

# --- Sources --------------------------------------------------------------------
# Lexique is read from build_wordlist rather than restated: the URL is what makes the
# builders share ONE download (and one cache file), so a bump must move all of them.
LEXIQUE_URL = bw.SOURCES["fr"]["lexique"]

# Morphalou is PINNED — exact release, exact archive, exact digest. A morphological
# table is a licensed linguistic resource, so "whatever the URL serves today" is not
# good enough: the build must be reproducible and the provenance must be checkable.
# ORTOLANG's own download endpoint answers 500 to non-browser clients, so the archive
# comes from the CNRS mirror on Hugging Face — same 6/2016 3.1 release.
MORPHALOU_URL = ("https://huggingface.co/datasets/datasets-CNRS/Morphalou/"
                 "resolve/main/Morphalou3.1_formatCSV_toutEnUn.zip")
MORPHALOU_ARCHIVE = "Morphalou3.1_formatCSV_toutEnUn.zip"
MORPHALOU_SHA256 = "4fc815cbf17aecdf1b47f6bbc263489a460fd8d11ae17e6b522336c72bd0e333"
MORPHALOU_MEMBER = "Morphalou3.1_formatCSV_toutEnUn/Morphalou3.1_CSV.csv"
MORPHALOU_README = "Morphalou3.1_formatCSV_toutEnUn/LISEZ-MOI.html"
MORPHALOU_CREDIT = "Morphalou 3.1 — ATILF / CNRS, via ORTOLANG"

# The distribution states its own licence in the LISEZ-MOI (the #lgpllr section IS
# the full LGPL-LR text), and the notice travelling with the exact artifact governs
# the exact artifact — so the licence text is extracted from the archive and
# committed beside the table (see license_path): a URL is not a copy.
MORPHALOU_LICENSE_NAME = ("LGPL-LR (Lesser General Public License For "
                          "Linguistic Resources)")

# The languages that HAVE a lexeme inventory. Anything else has no agreement pass and
# keeps its own lemma table (en: AGID) — deliberate, not a missing file.
FORM_LANGS = ("fr",)

# Morphalou category -> the artifact's POS code. Everything else (the ~350 rows with
# no category) is skipped and counted. The closed classes ARE included: they carry no
# agreement, but «vers» the preposition is exactly what makes «vers» a cross-lexeme
# homograph, and homography must be derivable from the table (#132/#134).
CATEGORIES = {
    "Verbe": "v",
    "Nom commun": "nc",
    "Adjectif qualificatif": "adj",
    "Adverbe": "adv",
    "Préposition": "prep",
    "Conjonction": "conj",
    "Interjection": "intj",
    "Pronom": "pro",
    "Déterminant": "det",
    "Nombre": "num",
}
# POS whose rows carry the citation cell only: they exist for grouping/homography,
# and #133's transfer policy gives them the citation form anyway.
CITATION_POS = frozenset(CATEGORIES.values()) - {"v", "nc", "adj"}
CITATION_FEATURE = "cit"

# The provenance classes the cleanup trusts: the curated ATILF core, and the two
# independently compiled morphologies. dela/dicollecte are mechanical imports whose
# UNCORROBORATED rows are exactly where #131 found the wrong paradigms.
TRUSTED_ORIGINS = frozenset({"morphalou2", "lefff", "lglexlefff"})

# --- Morphalou CSV layout ---------------------------------------------------------
# Semicolon-separated, a 9-column LEMME block then a 9-column FLEXION block: a lemma
# row carries both, continuation rows carry only the flexion block.
_L_GRAPHIE, _L_CAT = 0, 2
_F_GRAPHIE, _F_NOMBRE, _F_MODE, _F_GENRE, _F_TEMPS, _F_PERS, _F_ORIG = \
    9, 11, 12, 13, 14, 15, 17

# --- The internal feature vocabulary ----------------------------------------------
# The same cells #119 used (its tests and consumers keep working); the mapping now
# reads Morphalou's explicit (MODE, TEMPS, PERSONNE, NOMBRE, GENRE) columns instead
# of expanding Lefff tag codes.
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

# The cells the imperative actually HAS. Expanding an omitted value across a whole
# dimension is right for the indicative, but French has three imperative cells and no
# others — an unnamed person must not mint "imp:pre:3p". A membership filter, not an
# order: the expansion stays person-major so every mood lists its cells the same way.
IMPERATIVE_CELLS = frozenset({("2", "s"), ("1", "p"), ("2", "p")})


def _dim(table, value, all_values):
    """One Morphalou agreement cell -> the tuple of values it names.

    '-' and 'invariable' expand across the whole dimension — «un code non renseigné
    est non pertinent ou non discriminant» is the same rule #119 applied to Lefff's
    omitted codes, and «pris» really is both numbers. An unknown value returns () and
    the row is skipped (Morphalou has a handful of malformed rows; they are counted,
    never fatal and never guessed)."""
    if value in ("-", "invariable", ""):
        return all_values
    return table.get(value, ())


def morphalou_features(pos, nombre, mode, genre, temps, pers):
    """One Morphalou flexion row -> the tuple of internal features it names.

    Returns () when the row does not map (malformed values, or a (mode, temps) pair
    outside the vocabulary — Morphalou has no compound tenses to lose here)."""
    if pos == "nc":
        return tuple(f"n:{n}" for n in _dim(_NUMBERS, nombre, ("s", "p")))
    if pos == "adj":
        return tuple(f"adj:{g}:{n}"
                     for g in _dim(_GENDERS, genre, ("m", "f"))
                     for n in _dim(_NUMBERS, nombre, ("s", "p")))
    if pos in CITATION_POS:
        return (CITATION_FEATURE,)
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
                 if (p, n) in IMPERATIVE_CELLS]
        return tuple(f"imp:pre:{p}{n}" for p, n in cells)
    mood = _MODE_TEMPS.get((mode, temps))
    if not mood:
        return ()
    return tuple(f"{mood}:{p}{n}"
                 for p in _dim(_PERSONS, pers, ("1", "2", "3"))
                 for n in _dim(_NUMBERS, nombre, ("s", "p")))


def normalize_lemma(graphie):
    """Lemma graphy -> the lexeme's lemma: lowercase, pronominal marker stripped.

    Morphalou writes pronominal verbs as «s'envoler» / «se laver»; the apostrophe
    would fail the token rule and the flexions are bare forms anyway, so the lexeme
    is the bare verb. When both a bare and a pronominal entry exist they merge into
    one lexeme (read_morphalou keys by (lemma, pos)), like any homonym entries."""
    lemma = graphie.strip().lower()
    if lemma.startswith("s'"):
        return lemma[2:]
    if lemma.startswith("se "):
        return lemma[3:]
    return lemma


def lexeme_key(lemma, pos):
    """The lexeme's key as consumers see it («porter:v», «porte:nc»).

    The pipeline treats it as opaque group identity; the pos suffix is what keeps
    «vers» the noun and «vers» the preposition two groups. ':' cannot appear in a
    lemma (the token rule keeps letters and dashes only), so the key is unambiguous
    — and it reads acceptably in curator-facing messages."""
    return f"{lemma}:{pos}"


def is_verb(cgram):
    """Does this LEXIQUE category denote a verb? VER and AUX both do — an auxiliary
    is a verb, and being outweighed by one's own auxiliary use is not evidence of
    being something else."""
    return cgram.startswith(("VER", "AUX"))


def lexique_class(cgram):
    """One Lexique cgram -> the coarse POS class it competes as (the `dom` gate).

    Both sides of the frequency comparison must speak one vocabulary, so Lexique's
    categories map onto the artifact's POS codes. A category with no Morphalou
    counterpart (EXP, LIA, …) keeps its own token: it can never MATCH a row's POS,
    but it still competes as a rival — exactly how the #119 gate treated it."""
    if is_verb(cgram):
        return "v"
    if cgram.startswith("NOM"):
        return "nc"
    if cgram == "ADJ":
        return "adj"
    if cgram == "ADJ:num":
        return "num"
    if cgram.startswith(("ADJ:", "ART")):
        return "det"  # demonstrative/possessive "adjectives" are determiners here
    if cgram.startswith("PRO"):
        return "pro"
    if cgram == "ADV":
        return "adv"
    if cgram.startswith("PRE"):
        return "prep"
    if cgram.startswith("CON"):
        return "conj"
    # Lexique's only interjection-like class is ONO. Other Morphalou interjections
    # have no frequency counterpart and therefore use dominant_pos's conservative
    # case 2 (admit only an uncontested analysis), never a guessed class mapping.
    if cgram == "ONO":
        return "intj"
    return cgram or "?"


# --- Fetch ------------------------------------------------------------------------

def fetch_morphalou(refresh):
    """Download the pinned Morphalou archive; return (CSV text, licence text).

    The digest is verified before anything is read out of the archive: an artifact
    this file will be distributed under someone else's licence must be the artifact
    we think it is."""
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
        csv_text = z.read(MORPHALOU_MEMBER).decode("utf-8")
        readme = z.read(MORPHALOU_README).decode("utf-8", "replace")
    return csv_text, extract_license(readme)


def extract_license(readme_html):
    """The LGPL-LR text out of the distribution's own LISEZ-MOI (#lgpllr section).

    The licence text travels IN the archive as an HTML section, so it is extracted
    rather than fetched from anywhere else — the notice accompanying the exact
    distribution governs it. Tag-stripping is deliberately dumb: the section is prose
    paragraphs, and a missing anchor or end marker is a hard error (a bump that moves
    the licence must be looked at, not smoothed over)."""
    match = re.search(r'<a id="lgpllr"></a>', readme_html)
    end_marker = "END OF TERMS AND CONDITIONS"
    if not match or end_marker not in readme_html[match.start():]:
        print("Erreur : la section licence (#lgpllr) est introuvable dans le "
              "LISEZ-MOI de l'archive Morphalou — vérifie la distribution.",
              file=sys.stderr)
        sys.exit(1)
    section = readme_html[match.start():]
    section = section[:section.index(end_marker) + len(end_marker)]
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|dt|dd|pre|blockquote)>", "\n\n", section)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text + "\n"


# --- Parse + cleanup --------------------------------------------------------------

def clean_entry(cells):
    """The mixed-paradigm cleanup, on ONE source entry's cells.

    `cells` is {feature: {form: origins}}. In an entry that has corroborated rows,
    an uncorroborated row is dropped unless its slug matches a kept form of the same
    cell (the slug-variant rescue: «plait» folds onto the kept «plaît», so the 1990
    spelling survives). An entry with no corroborated row at all is a coherent
    single-source paradigm and keeps everything — the hazard is MIXING.

    Returns (kept, dropped): kept as {feature: {form}}, dropped as a row list."""
    has_core = any(origins & TRUSTED_ORIGINS
                   for forms in cells.values() for origins in forms.values())
    kept, dropped = {}, []
    for feature, forms in cells.items():
        good = {f for f, origins in forms.items()
                if not has_core or origins & TRUSTED_ORIGINS}
        good_slugs = {slug(f) for f in good}
        for f in forms:
            if f in good:
                continue
            if slug(f) in good_slugs:
                good.add(f)  # spelling variant of a kept form
            else:
                dropped.append((feature, f))
        if good:
            kept[feature] = good
    return kept, dropped


def read_morphalou(csv_text, token_re):
    """Morphalou CSV -> ({(lemma, pos): {feature: {form}}}, stats).

    Each SOURCE entry is parsed, cleaned (clean_entry), then merged into its lexeme:
    homonym entries of one (lemma, pos) — including a pronominal beside its bare verb
    — are one lexeme, because the embedding cannot tell them apart either. Both lemma
    and form must pass the language token rule, the same shape the reduction keeps,
    so the table can never name a form the embedding could not hold."""
    lexemes = {}
    stats = {"rows_unmappable": 0, "rows_dropped": 0, "entries_cleaned": 0,
             "entries_no_category": 0, "dropped_samples": []}

    def flush(key, cells):
        if key is None or not cells:
            return
        kept, dropped = clean_entry(cells)
        if dropped:
            stats["entries_cleaned"] += 1
            stats["rows_dropped"] += len(dropped)
            remaining = 30 - len(stats["dropped_samples"])
            if remaining > 0:
                stats["dropped_samples"].extend(
                    (key[0], key[1], feature, f)
                    for feature, f in dropped[:remaining])
        target = lexemes.setdefault(key, {})
        for feature, forms in kept.items():
            target.setdefault(feature, set()).update(forms)

    key, cells = None, {}
    data_started = False
    reader = csv.reader(io.StringIO(csv_text), delimiter=";", strict=True)
    for cols in reader:
        if not cols or not any(col.strip() for col in cols):
            continue
        if len(cols) != 18:
            if not data_started:
                continue  # the distribution's 14-line prose preamble
            raise ValueError(
                f"Morphalou ligne {reader.line_num} : 18 colonnes attendues, "
                f"{len(cols)} lues")
        data_started = True
        if cols[_L_GRAPHIE]:  # a new lemma block: flush the previous source entry
            flush(key, cells)
            cells = {}
            cat = cols[_L_CAT].strip()
            pos = CATEGORIES.get(cat)
            if pos is None:
                if cat == "":
                    stats["entries_no_category"] += 1
                key = None
                continue
            lemma = normalize_lemma(cols[_L_GRAPHIE])
            key = (lemma, pos) if token_re.match(lemma) else None
        if key is None or not cols[_F_GRAPHIE]:
            continue
        form = cols[_F_GRAPHIE].strip().lower()
        if not token_re.match(form):
            continue
        features = morphalou_features(key[1], cols[_F_NOMBRE].strip(),
                                      cols[_F_MODE].strip(), cols[_F_GENRE].strip(),
                                      cols[_F_TEMPS].strip(), cols[_F_PERS].strip())
        if not features:
            stats["rows_unmappable"] += 1
            continue
        origins = frozenset(cols[_F_ORIG].split())
        for feature in features:
            cells.setdefault(feature, {})
            cells[feature][form] = cells[feature].get(form, frozenset()) | origins
    flush(key, cells)
    return lexemes, stats


# --- Lexique evidence -------------------------------------------------------------

def read_lexique_rows(path):
    """Lexique TSV -> (ortho, cgram, freq) tuples. Frequency evidence only."""
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
    """surface -> {POS class: summed frequency}, in the artifact's class vocabulary."""
    weight = {}
    for ortho, cgram, freq in rows:
        if not token_re.match(ortho):
            continue
        pos = lexique_class(cgram)
        weight.setdefault(ortho, {})
        weight[ortho][pos] = weight[ortho].get(pos, 0.0) + freq
    return weight


def dominant_pos(analyses, weight):
    """surface -> the POS that dominates its reading, or None. The `dom` gate.

    `analyses` is {surface: {pos}} over the KEPT rows. Two cases, generalising
    #119's verb gate to every POS without changing its answers for verbs:

      1. Lexique has usable frequency for the surface — a class dominates only when
         it strictly beats every rival («évident»: 0.27 as a form of «évider», 20.14
         as the adjective, so the adjective dominates and the verb reading is gated).
      2. Lexique has none — the corpus simply never saw it, the ordinary case for
         the forms the agreement pass exists to serve («accoutumes»). The surface's
         own analyses decide: a single POS is dominant, a cross-POS homograph with
         no evidence either way is declined, not guessed."""
    dominant = {}
    for form, classes in analyses.items():
        per_pos = weight.get(form)
        if per_pos and max(per_pos.values()) > 0:
            best = max(per_pos, key=per_pos.get)
            rival = max((w for pos, w in per_pos.items() if pos != best),
                        default=-1.0)
            dominant[form] = best if per_pos[best] > rival else None
        else:
            dominant[form] = next(iter(classes)) if len(classes) == 1 else None
    return dominant


def collect_rows(lexemes, weight):
    """The cleaned lexemes -> the final deterministic (sortable) row set.

    One row per (lexeme, feature, form); `dom` marks the rows whose POS dominates
    their surface's reading; the surface's summed Lexique frequency rides along as
    the sort key that puts the preferred spelling first."""
    analyses = {}
    for (lemma, pos), cells in lexemes.items():
        for forms in cells.values():
            for form in forms:
                analyses.setdefault(form, set()).add(pos)
    dominant = dominant_pos(analyses, weight)
    rows = []
    for (lemma, pos), cells in lexemes.items():
        for feature, forms in cells.items():
            for form in forms:
                rows.append((lemma, pos, feature, form,
                             1 if dominant.get(form) == pos else 0,
                             sum(weight.get(form, {}).values())))
    return rows


# --- The #131 guards --------------------------------------------------------------
# The COMPLETE #131 audit set, pinned cell by cell: the two cell-level holes, every
# cell the «forms only Lefff states» list showed Morphalou missing a spelling in,
# every cell the «forms only Morphalou states» list showed polluted (which the
# cleanup must leave holding ONLY the real forms), the spot checks, and the
# legitimate-variation controls. Each is validated LOUDLY on every build: the holes
# stay holes (a missing agreement degrades to the dictionary form downstream) and
# the wrong forms stay dropped — but if a source bump or a rule edit changes what
# sits under ANY of these cells, the build fails and the change must be re-audited
# (#131 rules out patching them from another source). Only iterating this tuple is
# what makes the guarantee real, so it must stay the whole enumerated set.
#
# (lemma, feature, expected forms, expected preferred spelling or None — only named
# where a cell holds several spellings and the frequency order is itself audited)
EXPECTED_CELLS = (
    # -- the two cell-level holes ("missing in Morphalou, present in Lefff") -------
    # the curated core mis-tags «puisses» thirdPerson, so the 2s cell is LOST — and
    # the mis-tag itself is harmless for realisation («puisse» outranks it by freq)
    ("pouvoir", "sub:pre:2s", frozenset(), None),
    # «assis» has no masculine-plural participle row
    ("asseoir", "par:pas:m:p", frozenset(), None),
    # -- the cells Morphalou lacks a Lefff-attested spelling in --------------------
    # (the «forms only Lefff states» list: the sibling paradigm's spelling — or
    # nothing at all — is what the cell legitimately holds)
    ("asseoir", "ind:pre:1s", frozenset({"assieds"}), None),      # no «assois» 1s
    ("asseoir", "sub:pre:1s", frozenset({"asseye"}), None),       # no «assoie»
    ("essayer", "cnd:pre:1s", frozenset({"essaierais"}), None),   # no «essayerais»
    ("foutre", "cnd:pre:1s", frozenset({"fouterais"}), None),     # no «foutrais»
    ("fuir", "ind:imp:1s", frozenset(), None),                    # no «fuyais» 1s
    ("fuir", "sub:pre:1s", frozenset(), None),   # «fuie» absent, «fuisse» pollution
    ("payer", "cnd:pre:1s", frozenset({"paierais"}), None),       # no «payerais»
    # «peux» carries only a secondPerson row: the 1s survives via «puis» alone
    ("pouvoir", "ind:pre:1s", frozenset({"puis"}), None),
    ("repartir", "ind:imp:1s", frozenset(), None),                # no «repartais» 1s
    ("repartir", "ind:pre:1s", frozenset(), None),                # no «repars» 1s
    ("repartir", "sub:pre:1s", frozenset(), None),                # no «reparte» 1s
    ("sortir", "ind:imp:1s", frozenset(), None),                  # no «sortais» 1s
    ("sortir", "ind:pre:1s", frozenset(), None),                  # no «sors» 1s
    ("sortir", "sub:pre:1s", frozenset(), None),                  # no «sorte» 1s
    # -- the polluted cells ("forms only Morphalou states"): after the cleanup they
    # hold ONLY the real paradigm — the DELA «-issant» conjugation glued into
    # sortir/repartir and the mis-tagged «fuisse» must be gone, and a wrong-only
    # cell (see the 1s rows above) must come out EMPTY, never realize «je sortis» --
    ("fuir", "sub:pre:3s", frozenset({"fuie"}), None),
    ("pouvoir", "sub:pre:3s", frozenset({"puisse", "puisses"}), "puisse"),
    ("repartir", "imp:pre:1p", frozenset({"repartons"}), None),
    ("repartir", "imp:pre:2p", frozenset({"repartez"}), None),
    ("repartir", "imp:pre:2s", frozenset({"repars"}), None),
    ("repartir", "ind:imp:3p", frozenset({"repartaient"}), None),
    ("repartir", "ind:imp:3s", frozenset({"repartait"}), None),
    ("repartir", "ind:pre:1p", frozenset({"repartons"}), None),
    ("repartir", "ind:pre:2p", frozenset({"repartez"}), None),
    ("repartir", "ind:pre:2s", frozenset({"repars"}), None),
    ("repartir", "ind:pre:3p", frozenset({"repartent"}), None),
    ("repartir", "ind:pre:3s", frozenset({"repart"}), None),
    ("repartir", "par:pre", frozenset({"repartant"}), None),
    ("repartir", "sub:pre:3p", frozenset({"repartent"}), None),
    ("sortir", "imp:pre:2s", frozenset({"sors"}), None),
    ("sortir", "ind:pre:2s", frozenset({"sors"}), None),
    ("sortir", "ind:pre:3s", frozenset({"sort"}), None),
    # the real «fous» must win over the Lefff-import class error «fouts»
    ("foutre", "imp:pre:2s", frozenset({"fous", "fouts"}), "fous"),
    # -- spot checks + legitimate-variation controls -------------------------------
    # the Morphalou gap #119 first recorded
    ("conquérir", "par:pas:m:p", frozenset(), None),
    # the legitimate double paradigms survive the cleanup untouched
    ("payer", "ind:pre:1s", frozenset({"paie", "paye"}), "paie"),
    # the corroborated repairs of the core's missing 1s rows survive too
    ("finir", "ind:pre:1s", frozenset({"finis"}), None),
)

# #132's all-POS structural sentinels. The exhaustive #131 audit above is verbal by
# definition; these deliberately small pins make a parser/mapping change prove that
# nouns, adjectives and closed classes still survive with their real cells too.
# (lemma, pos, feature, expected forms)
EXPECTED_INVENTORY_CELLS = (
    ("jardin", "nc", "n:s", frozenset({"jardin"})),
    ("jardin", "nc", "n:p", frozenset({"jardins"})),
    ("oeil", "nc", "n:p", frozenset({"oeils", "yeux"})),
    ("grand", "adj", "adj:f:p", frozenset({"grandes"})),
    ("vers", "prep", "cit", frozenset({"vers"})),
    ("celui", "pro", "cit", frozenset({"celle", "celles", "celui", "ceux"})),
)

# Homography must remain derivable from the same rows (#132/#134), including
# same-POS ambiguity (`mois`) that a POS-only gate cannot settle.
EXPECTED_SURFACE_LEXEMES = (
    ("vers", frozenset({"ver:nc", "vers:nc", "vers:prep"})),
    ("mois", frozenset({"moi:nc", "mois:nc"})),
    ("celle", frozenset({"celle:nc", "celui:pro"})),
)


def validate_rows(rows):
    """Fail loudly when data under a #131 or #132 sentinel moved.

    The source is digest-pinned, so a deviation means the parsing or cleanup rules
    changed — exactly the moment the #131 audit must be redone, consciously, instead
    of new morphology shipping under an old rationale."""
    wanted_cells = {
        (lemma, "v", feature)
        for lemma, feature, _expected, _first in EXPECTED_CELLS
    } | {
        (lemma, pos, feature)
        for lemma, pos, feature, _expected in EXPECTED_INVENTORY_CELLS
    }
    wanted_surfaces = {form for form, _expected in EXPECTED_SURFACE_LEXEMES}
    cells, preferred, surface_lexemes = {}, {}, {}
    for lemma, pos, feature, form, _dom, freq in rows:
        cell = (lemma, pos, feature)
        if cell in wanted_cells:
            cells.setdefault(cell, set()).add(form)
            best = preferred.get(cell)
            if best is None or (-freq, form) < best[0]:
                preferred[cell] = ((-freq, form), form)
        if form in wanted_surfaces:
            surface_lexemes.setdefault(form, set()).add(lexeme_key(lemma, pos))
    problems = []
    for lemma, feature, expected, first in EXPECTED_CELLS:
        cell = (lemma, "v", feature)
        actual = frozenset(cells.get(cell, set()))
        if actual != expected:
            problems.append(f"{lemma} / {feature} : formes {sorted(actual)}, "
                            f"attendu {sorted(expected)}")
        elif first is not None and (
                preferred.get(cell) is None or preferred[cell][1] != first):
            actual_first = preferred[cell][1] if cell in preferred else "aucune"
            problems.append(f"{lemma} / {feature} : réalisation préférée "
                            f"« {actual_first} », attendue "
                            f"« {first} »")
    for lemma, pos, feature, expected in EXPECTED_INVENTORY_CELLS:
        actual = frozenset(cells.get((lemma, pos, feature), set()))
        if actual != expected:
            problems.append(
                f"{lemma}:{pos} / {feature} : formes {sorted(actual)}, "
                f"attendu {sorted(expected)}")
    for form, expected in EXPECTED_SURFACE_LEXEMES:
        actual = frozenset(surface_lexemes.get(form, set()))
        if actual != expected:
            problems.append(
                f"surface « {form} » : lexèmes {sorted(actual)}, "
                f"attendu {sorted(expected)}")
    if problems:
        print("Erreur : les cellules pinnées par les audits #131/#132 ont bougé —\n"
              + "".join(f"         {p}\n" for p in problems)
              + "         la source ou les règles ont changé : refais l'audit "
                "avant de mettre à jour les sentinelles.", file=sys.stderr)
        sys.exit(1)


# --- Artifact ---------------------------------------------------------------------

def forms_path(lang):
    """Default versioned lexeme inventory for a language: wordlist/<lang>.forms.tsv.gz."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.tsv.gz")


def license_path(lang):
    """The source licence shipped beside the derived table, verbatim.

    The LGPL-LR asks that a copy travel with any work based on the resource, so the
    text is committed rather than linked: a URL is not a copy."""
    return os.path.join(red.WORDLIST_DIR, f"{lang}.forms.LICENSE")


def header_lines(lang):
    """The provenance + licence block written above the rows.

    A derived linguistic resource that names no source is not auditable, and the
    LGPL-LR asks for the notice to travel with the work — so it travels IN the
    artifact, not only in this script."""
    return [
        f"# {lang}.forms.tsv.gz — the unified lexeme inventory (#132): lemma "
        f"grouping, homography and display agreement.",
        "# Built by scripts/build_forms.py (pnpm forms:fr). Do not edit by hand.",
        "#",
        f"# Lexemes     : {MORPHALOU_CREDIT}",
        f"#               {MORPHALOU_URL}",
        f"#               {MORPHALOU_ARCHIVE} sha256:{MORPHALOU_SHA256}",
        f"#               Licence: {MORPHALOU_LICENSE_NAME}; full text in "
        f"{os.path.basename(license_path(lang))}.",
        f"# POS evidence: Lexique383 (surface frequency only) — {LEXIQUE_URL}",
        "#",
        "# lemma<TAB>pos<TAB>feature<TAB>form<TAB>dom",
    ]


def build_rows(lang, csv_text, lexique_path):
    """The deterministic core: the two sources -> the exact rows the artifact holds.

    Split out of build() so the reproduction test can run the REAL path over the
    cached downloads instead of restating the sort key — a test that mirrors the
    code proves nothing about it."""
    token_re = red.token_pattern(lang)
    lexemes, stats = read_morphalou(csv_text, token_re)
    weight = lexique_weights(read_lexique_rows(lexique_path), token_re)
    rows = collect_rows(lexemes, weight)
    # Sorted by (lemma, pos, feature, -freq, form): deterministic, and the FIRST row
    # of a cell is its preferred realization — which is what load_forms reads. A
    # losing spelling is ordered after, never dropped.
    rows.sort(key=lambda r: (r[0], r[1], r[2], -r[5], r[3]))
    validate_rows(rows)
    return rows, stats


def row_line(lemma, pos, feature, form, dom):
    """One artifact line. The single place the row shape is written."""
    return f"{lemma}\t{pos}\t{feature}\t{form}\t{dom}"


# The loader's product. `grouping` spans EVERY POS — it is what gen_phrase's merge
# walk consumes (#104's lemma_table shape: form -> lexeme keys). The other four are
# the VERB view the display-agreement pass (#119) reads, shaped exactly as before —
# only the lemma strings became lexeme keys, one namespace with `grouping`, which is
# the point of #132: the grouping walk and the agreement pass can no longer disagree
# about what a form belongs to.
Lexicon = namedtuple("Lexicon", "grouping entries dominant realize features")


def load_forms(path):
    """Load a committed inventory into the indexes gen_phrase needs.

    grouping  form -> (lexeme key, ...)         — ALL POS: the #104 merge-walk table
    entries   form -> ((lexeme key, feature), ...)  — verb rows: what a surface IS
    dominant  {form}                             — surfaces dominantly read as a verb
    realize   (lexeme key, feature) -> (form, ...)  — verb rows: EVERY spelling,
              preferred first
    features  {feature}                          — the verb inventory (--form checks)

    `realize` keeps the whole ordered candidate list, not just the winner: the
    caller's typability check falls back to the next spelling («déblaies» loses to
    «déblayes» when the favourite is untypable) instead of dropping the rewrite.

    `#` lines are the provenance/licence header and are skipped; any other malformed
    line is an error, loudly, because a truncated artifact would otherwise load as a
    partial table and agree half a puzzle."""
    grouping, entries, dominant, realize, features = {}, {}, set(), {}, set()
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 5:
                raise ValueError(f"{path}:{lineno}: 5 champs attendus, "
                                 f"{len(parts)} lus — table corrompue ?")
            lemma, pos, feature, form, dom = parts
            key = lexeme_key(lemma, pos)
            keys = grouping.setdefault(form, [])
            if key not in keys:
                keys.append(key)
            if pos != "v":
                continue
            entries.setdefault(form, []).append((key, feature))
            realize.setdefault((key, feature), []).append(form)
            features.add(feature)
            if dom == "1":
                dominant.add(form)
    return Lexicon({form: tuple(keys) for form, keys in grouping.items()},
                   {form: tuple(pairs) for form, pairs in entries.items()},
                   dominant,
                   {pair: tuple(forms) for pair, forms in realize.items()},
                   frozenset(features))


def build(lang, *, refresh):
    if lang not in FORM_LANGS:
        print(f"Erreur : pas d'inventaire de lexèmes pour '{lang}' "
              f"(langues : {', '.join(FORM_LANGS)}).", file=sys.stderr)
        sys.exit(1)

    csv_text, licence = fetch_morphalou(refresh)
    lexique = bw.fetch(LEXIQUE_URL,
                       os.path.join(bw.CACHE_DIR, f"{lang}.lexique.tsv"), refresh)
    rows, stats = build_rows(lang, csv_text, lexique)
    if not rows:
        print(f"Erreur : la source n'a produit aucune forme pour {lang}.",
              file=sys.stderr)
        sys.exit(1)

    out_path, lic_path = forms_path(lang), license_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(lic_path, "w", encoding="utf-8") as f:
        f.write(licence)
    # mtime=0 — via GzipFile, since gzip.open does not take it: gzip stamps the clock
    # into its header, so without this an unchanged rebuild produces a byte-different,
    # content-identical blob and dirties the working tree for nothing.
    # build_lemmas.py / build_wordlist.py still share that wart; fixing them rewrites
    # their committed artifacts too, so that mechanical sweep remains separate.
    with gzip.GzipFile(out_path, "wb", mtime=0) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8") as f:
        for line in header_lines(lang):
            f.write(line + "\n")
        for lemma, pos, feature, form, dom, _freq in rows:
            f.write(row_line(lemma, pos, feature, form, dom) + "\n")

    # --- Report (stderr) --------------------------------------------------------
    per_pos = {}
    for lemma, pos, _feature, form, dom, _freq in rows:
        entry = per_pos.setdefault(pos, {"rows": 0, "lemmas": set(), "forms": set(),
                                         "gated": 0})
        entry["rows"] += 1
        entry["lemmas"].add(lemma)
        entry["forms"].add(form)
        if dom == 0:
            entry["gated"] += 1
    print(f"\nLangue : {lang}", file=sys.stderr)
    print(f"Lignes : {len(rows):,}", file=sys.stderr)
    for pos in sorted(per_pos, key=lambda p: -per_pos[p]["rows"]):
        e = per_pos[pos]
        print(f"          {pos:<5} {e['rows']:>9,} lignes  "
              f"{len(e['lemmas']):>8,} lexèmes  {len(e['forms']):>8,} formes  "
              f"({e['gated']:,} hors-gabarit POS, dom=0)", file=sys.stderr)
    print(f"Nettoyage des entrées mixtes : {stats['rows_dropped']:,} ligne(s) non "
          f"corroborée(s) retirée(s) de {stats['entries_cleaned']:,} entrée(s) "
          f"(origines ⊄ {{morphalou2, lefff, lglexlefff}})", file=sys.stderr)
    for lemma, pos, feature, form in stats["dropped_samples"][:10]:
        print(f"          p.ex. {lemma}:{pos} / {feature} : {form}", file=sys.stderr)
    print(f"Lignes source inexploitables : {stats['rows_unmappable']:,} ; entrées "
          f"sans catégorie : {stats['entries_no_category']:,}", file=sys.stderr)
    print(f"Gardes #131 : {len(EXPECTED_CELLS)} cellule(s) pinnée(s) vérifiée(s).",
          file=sys.stderr)
    print(f"Sentinelles #132 : {len(EXPECTED_INVENTORY_CELLS)} cellule(s) all-POS + "
          f"{len(EXPECTED_SURFACE_LEXEMES)} surface(s) homographes vérifiées.",
          file=sys.stderr)
    print(f"Licence : {MORPHALOU_LICENSE_NAME} -> {lic_path}", file=sys.stderr)
    print(f"-> {out_path}", file=sys.stderr)
    print(out_path)  # stdout: the built file path


def main():
    p = argparse.ArgumentParser(
        description="Construit l'inventaire de lexèmes d'une langue (fr) : "
                    "groupement par lemme, homographie et accord d'affichage.")
    p.add_argument("--lang", choices=FORM_LANGS, default="fr")
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge les sources (ignore le cache)")
    args = p.parse_args()
    build(args.lang, refresh=args.refresh)


if __name__ == "__main__":
    main()
