#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Build the ONE word-group inventory per language consumed by gen_phrase.py
(fr: #132/#146; en: #317).

Before #132 two different sources defined what a lexeme is: Lexique/AGID for the
rank-map lemma grouping (#104) and Lefff (verbs only) for display agreement (#119).
Two identities meant mismatch bugs waiting to happen: a surface grouped under lemma A
by one table while the morphology table inflected it under lemma B — aliases pointing
at one group while display forms come from another. So ONE dictionary now defines the
lexeme for grouping, ranking and display alike, and this script is its offline
builder (only it needs the network); the pipeline only READS the committed file:

    packages/generation/wordlist/fr.forms.tsv.gz

one `group<TAB>lemma<TAB>pos<TAB>feature<TAB>form<TAB>dom` row per source-entry
cell, under a `#` header carrying provenance and licensing. `group` is the opaque
word identity consumers use; `lemma` / `pos` retain the Morphalou entry that
contributed the row. Most groups still contain one `(lemma, pos)`, but #146 merges
dictionary filings that make no playable distinction:

  - entries with exactly the same complete form set are one group, across POS;
  - an entry whose every `(feature, form)` row already occurs in a larger entry of
    the same POS is redundant and disappears (if two larger entries contain it,
    both larger words stay separate — only the redundant filing is removed).

The first surviving entry in pinned Morphalou order names an exact-form group.
That key stays readable (`rouge:nc`) but its suffix is NOT the group's POS:
`rouge:nc` carries both the noun and adjective paradigms after #146. Consumers
therefore treat it as opaque and read the explicit row POS / group metadata.

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

A form carrying SEVERAL genuinely distinct words («durent» is both the present of
durer and the past historic of devoir) is kept here in full — the table only
describes. The duplicate-entry rules above remove only distinctions the dictionary
cannot cash in forms; every remaining choice stays visible downstream.

Rows are sorted by (group, feature, -Lexique frequency, form, source lemma, source
POS), so the FIRST row of a group cell is its preferred realization: deterministic,
and the reason the sort key is not simply the whole line. Losing spellings are KEPT,
only ordered after — and `load_forms` hands the caller the whole ordered list, so
"preferred" can fall back to "typable" instead of the cell going unrealized.

ENGLISH (#317, user-decided 2026-09-25: English puzzles are made like the French ones,
as far as each language's properties allow) — the same artifact, the same columns, the
same hygiene, from three sources with one responsibility each:

  AGID 2016.01.19  THE authority for the lexeme — chosen by the #317 A/B over UniMorph
                 (plurals corrupted to «countable», one spelling per cell, «bear →
                 beared») and Wiktionary (half of what it alone states is a rare-POS
                 paradigm on the right lemma — «boys» as a verb — with no flag to clean
                 it, and no pinnable release). Its own confidence marks drive the
                 cleanup: uncertain (~ ! ?) and obscure (level >= 2) spellings drop, an
                 adjective needs both degrees attested (AGID files agent nouns as
                 comparatives: «travel → traveler»), and a GUESSED entry (POS not in
                 AGID's POS database) is corroborated against the trusted ones — the
                 English twin of Morphalou's mixed-entry rule (see corroborate_agid).
  VarCon 2020.12.07  American/British spelling variants (decision: both spellings
                 are one word): each form's pure spelling variants join its cell, so
                 «colour» and «color» become ONE group by #146's identical-form rule.
                 Sense-restricted pairs (check/cheque | bank) never merge.
  OANC           frequency / POS evidence ONLY (the `dom` column and a cell's spelling
                 order), Lexique's twin; unrestricted licence.

English has no gender, no adjective agreement and no elision, so it has no such cells:
nouns carry number (n:s / n:p), verbs the five forms English inflects (base,
ind:pre:3s, ind:pas, par:pas, par:pre), adjectives their degree (adj:pos / adj:cmp /
adj:sup — grouped and confirmable, never transferred to neighbours). And English
converts freely between noun and verb (a walk / to walk): entries sharing a lemma
spelling are ONE group across POS (merge_entries(same_lemma=True)), since a player
types the word, not its part of speech.

Usage
    uv run scripts/build_forms.py --lang fr      (pnpm forms:fr)
    uv run scripts/build_forms.py --lang en      (pnpm forms:en)
Downloads are cached under wordlist/.cache/ (gitignored); --refresh re-downloads.
"""

import argparse
import csv
import gzip
import html
import io
import os
import re
import sys
import zipfile
from collections import namedtuple

import build_wordlist as bw  # fetch() + verify_digest() + the shared cache dir / UA
import reduce_embedding as red  # token_pattern — one source for the token rule
from slug import slug  # spelling-variant rescue in the cleanup compares SLUGS

# --- Sources --------------------------------------------------------------------
# Lexique is read from build_wordlist rather than restated: the URL is what makes the
# builders share ONE download (and one cache file), so a bump must move all of them —
# and its digest pin (bw.LEXIQUE_SHA256) with it.
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

# The languages that HAVE a word-group inventory — every supported language since #317.
FORM_LANGS = ("fr", "en")
# Languages whose nominal morphology carries GENDER (the #133 prompt asks it of a noun,
# adjectives agree in it). English has none, so it never asks.
GENDERED_LANGS = frozenset({"fr"})

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


def feature_pos(feature):
    """The POS whose paradigm owns one stored/CLI cell code.

    A feature IS a cell of one part of speech's paradigm (`n:p` names a noun cell,
    `adj:f:p` an adjective cell, everything else a verb cell). #146 may transfer
    the morphology expressed by that cell to another POS, but this function still
    answers which paradigm can realize the cell itself. `cit` maps to None because
    a citation-form secret prescribes nothing."""
    if feature == CITATION_FEATURE:
        return None
    if feature.startswith("n:"):
        return "nc"
    if feature.startswith("adj:"):
        return "adj"
    return "v"

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
    """One source entry's candidate group key («porter:v», «porte:nc»).

    `merge_entries` chooses one surviving entry's key for each #146 group. The
    pipeline treats that chosen value as OPAQUE: after an exact-form cross-POS
    merge its suffix describes the entry that named the group, not every paradigm
    the group carries. ':' cannot appear in a lemma (the token rule keeps letters
    and dashes only), so the spelling stays unambiguous and curator-readable."""
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
    path = bw.verify_digest(
        bw.fetch(MORPHALOU_URL, os.path.join(bw.CACHE_DIR, MORPHALOU_ARCHIVE), refresh),
        MORPHALOU_SHA256, MORPHALOU_ARCHIVE)
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

    The scope is deliberately the SOURCE ENTRY, not the merged lexeme: a wholly
    uncorroborated homonym entry passes here whole and read_morphalou then merges it
    into its (lemma, pos) — pollution arriving as a SEPARATE entry would slip this
    rule. #131 found none in this release, and the EXPECTED_CELLS pins are what
    guard the claim; on a source bump, re-audit this seam first.

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
            remaining = 10 - len(stats["dropped_samples"])
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


# --- Duplicate dictionary entries (#146) ----------------------------------------

def entry_rows(cells):
    """The exact information one Morphalou entry contributes.

    Containment is deliberately tested on `(feature, form)`, not on surface forms
    alone: `fils:nc` claims singular «fils» as well as plural «fils», so it is NOT
    contained in `fil:nc`, whose «fils» row is plural only. That one-cell difference
    is precisely why «fil» must never solve a confirmed `fils:nc` hole."""
    return frozenset((feature, form)
                     for feature, forms in cells.items() for form in forms)


def entry_forms(cells):
    """Every spelling an entry can produce, cells deliberately forgotten."""
    return frozenset(form for forms in cells.values() for form in forms)


def merge_entries(lexemes, same_lemma=False):
    """Collapse dictionary filings that make no playable distinction (#146).

    Returns `(groups, stats)` where `groups` is insertion-ordered as
    `{opaque_group_key: ((lemma, pos, cells), ...)}`.

    Rule 1 groups surviving entries whose COMPLETE form sets are identical, across
    POS. The first entry in the pinned source order names the opaque group; every
    member row remains attached to its own lemma/POS in the artifact, so a merged
    word can carry several paradigms without making the key suffix lie to consumers.

    Rule 2 removes an entry B when a strictly larger entry A of the SAME POS already
    contains every `(feature, form)` row B contributes. Nothing is copied: A already
    owns every row. If B is contained in two incomparable larger entries, B still
    disappears while A and C remain separate; unioning them through B would make
    A-only forms solve C and change gameplay, contradicting the rule's no-new-
    information premise.

    The measurements in issue #146 are computed on the original cleaned entries,
    before either rule changes the population, so the build report can pin the
    source facts (5,712 twin sets / 11,472 entries and 1,496 contained entries on
    Morphalou 3.1).

    `same_lemma` (English, #317) adds a third rule: surviving entries that share a
    LEMMA spelling are one group across POS, joined transitively with rule 1's twins
    (so «colour» noun and verb and «color» noun and verb are one word). English
    converts freely (a walk / to walk, a dream / to dream) and the embedding holds one
    vector for both; splitting them would rank «walk» and «walked» apart and hand the
    judge the same lemma twice. It also joins true homonyms AGID cannot tell apart
    («bear» the animal and the verb) — the embedding cannot either."""
    rows = {key: entry_rows(cells) for key, cells in lexemes.items()}
    forms = {key: entry_forms(cells) for key, cells in lexemes.items()}

    by_forms = {}
    for key, spellings in forms.items():
        by_forms.setdefault(spellings, []).append(key)
    twin_sets = [keys for keys in by_forms.values() if len(keys) > 1]

    # Invert each row within its POS. Anchoring a candidate search on the rarest
    # row makes the exact subset test linear-ish over 155k entries instead of a
    # quadratic comparison of every same-POS pair.
    owners = {}
    for key, contributed in rows.items():
        per_pos = owners.setdefault(key[1], {})
        for row in contributed:
            per_pos.setdefault(row, set()).add(key)

    contained = {}
    for key, contributed in rows.items():
        if not contributed:
            continue
        per_pos = owners[key[1]]
        candidates = min((per_pos[row] for row in contributed), key=len)
        supersets = tuple(candidate for candidate in candidates
                          if candidate != key
                          and len(rows[candidate]) > len(contributed)
                          and contributed <= rows[candidate])
        if supersets:
            contained[key] = tuple(sorted(supersets,
                                          key=lambda k: lexeme_key(*k)))

    surviving = set(lexemes) - set(contained)
    surviving_by_forms = {}
    for key, spellings in forms.items():
        if key in surviving:
            surviving_by_forms.setdefault(spellings, []).append(key)

    if same_lemma:
        surviving_by_forms = _join_same_lemma(
            [key for key in lexemes if key in surviving], surviving_by_forms)

    groups = {}
    for key in lexemes:  # pinned source order owns exact-group naming
        if key not in surviving:
            continue
        members = surviving_by_forms[forms[key]] if not same_lemma \
            else surviving_by_forms[key]
        canonical = members[0]
        group = lexeme_key(*canonical)
        if group in groups:
            continue
        groups[group] = tuple((lemma, pos, lexemes[(lemma, pos)])
                              for lemma, pos in members)

    return groups, {
        "twin_groups": len(twin_sets),
        "twin_entries": sum(len(keys) for keys in twin_sets),
        "contained_entries": len(contained),
        "contained_samples": tuple(
            (lexeme_key(*key), tuple(lexeme_key(*target)
                                     for target in contained[key]))
            for key in list(contained)[:5]
        ),
        "groups": len(groups),
    }


def _join_same_lemma(keys, by_forms):
    """Rule 3 (English): union-find over the surviving entries, joining rule 1's
    identical-form twins AND entries that share a lemma. Returns {entry: members}
    with members in source order, the first naming the group."""
    parent = {key: key for key in keys}

    def find(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_lemma = {}
    for key in keys:
        by_lemma.setdefault(key[0], []).append(key)
    for members in list(by_lemma.values()) + list(by_forms.values()):
        for other in members[1:]:
            union(members[0], other)
    components = {}
    for key in keys:
        components.setdefault(find(key), []).append(key)
    return {key: tuple(components[find(key)]) for key in keys}


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


def lexique_weights(rows, token_re, classify=lexique_class):
    """surface -> {POS class: summed frequency}, in the artifact's class vocabulary.
    `classify` maps the source's category onto it (English rows arrive mapped)."""
    weight = {}
    for ortho, cgram, freq in rows:
        if not token_re.match(ortho):
            continue
        pos = classify(cgram)
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


def collect_rows(groups, weight):
    """The #146 word groups -> the final deterministic (sortable) row set.

    One row per `(group, source lemma, source POS, feature, form)`. `dom` still
    describes the SOURCE row's POS — an exact-form group may carry several — and
    the surface's summed Lexique frequency rides along as the preference sort key."""
    analyses = {}
    for members in groups.values():
        for _lemma, pos, cells in members:
            for forms in cells.values():
                for form in forms:
                    analyses.setdefault(form, set()).add(pos)
    dominant = dominant_pos(analyses, weight)
    rows = []
    for group, members in groups.items():
        for lemma, pos, cells in members:
            for feature, forms in cells.items():
                for form in forms:
                    rows.append((group, lemma, pos, feature, form,
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
_EXPECTED_VERB_CELLS = (
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

# Sentinels name the OPAQUE post-merge group, not a source `(lemma, pos)` pair.
# Verb keys happen to stay `lemma:v` in this release; spelling that conversion once
# here prevents validators/consumers from rebuilding identity out of row columns.
EXPECTED_CELLS = tuple(
    (lexeme_key(lemma, "v"), feature, expected, first)
    for lemma, feature, expected, first in _EXPECTED_VERB_CELLS
)

# #132's all-POS structural sentinels. The exhaustive #131 audit above is verbal by
# definition; these deliberately small pins make a parser/mapping change prove that
# nouns, adjectives and closed classes still survive with their real cells too.
# (opaque group key, feature, expected forms)
EXPECTED_INVENTORY_CELLS = (
    ("jardin:nc", "n:s", frozenset({"jardin"})),
    ("jardin:nc", "n:p", frozenset({"jardins"})),
    ("oeil:nc", "n:p", frozenset({"oeils", "yeux"})),
    ("grand:adj", "adj:f:p", frozenset({"grandes"})),
    # vers:prep is an exact-form duplicate of vers:nc under #146: the merged
    # opaque group carries both the noun cells and this citation cell.
    ("vers:nc", "cit", frozenset({"vers"})),
    ("celui:pro", "cit", frozenset({"celle", "celles", "celui", "ceux"})),
)

# Distinct playable groups must remain derivable from the same rows (#132/#134),
# including same-POS ambiguity (`mois`) that a POS-only gate cannot settle. Values
# are OPAQUE group keys since #146; a suffix no longer claims the group's only POS.
EXPECTED_SURFACE_LEXEMES = (
    ("vers", frozenset({"ver:nc", "vers:nc"})),
    ("mois", frozenset({"moi:nc", "mois:nc"})),
    ("celle", frozenset({"celle:nc", "celui:pro"})),
)


# #146's normalization measurements are source facts, not an informational build
# report. Pin every published number here so a parser/source/merge-rule drift stops
# the rebuild at the same boundary as the morphology sentinels below.
EXPECTED_MERGE_STATS = {
    "twin_groups": 5_712,
    "twin_entries": 11_472,
    "contained_entries": 1_496,
    "groups": 147_868,
    "rows": 994_497,
}


def validate_merge_stats(stats, row_count, expected_stats=None, audit="#146"):
    """Fail loudly when a pinned source measurement moves (fr: #146, en: #317)."""
    if expected_stats is None:
        expected_stats = EXPECTED_MERGE_STATS
    actual = {name: stats.get(name) for name in expected_stats}
    actual["rows"] = row_count
    problems = [
        f"{name} : {actual[name]:,}, attendu {expected:,}"
        if isinstance(actual[name], int) else
        f"{name} : absent, attendu {expected:,}"
        for name, expected in expected_stats.items()
        if actual[name] != expected
    ]
    if problems:
        print(f"Erreur : les mesures pinnées par l'audit {audit} ont bougé —\n"
              + "".join(f"         {problem}\n" for problem in problems)
              + "         la source ou les règles ont changé : refais l'audit "
                "avant de mettre à jour les mesures.", file=sys.stderr)
        sys.exit(1)


def validate_rows(rows, expected_cells=None, inventory_cells=None,
                  surface_lexemes=None, audit="#131/#132"):
    """Fail loudly when data under a pinned sentinel moved (fr: #131/#132, en: #317).

    The source is digest-pinned, so a deviation means the parsing or cleanup rules
    changed — exactly the moment the audit must be redone, consciously, instead
    of new morphology shipping under an old rationale. The sentinels default to the
    French ones, read at call time."""
    expected_cells = EXPECTED_CELLS if expected_cells is None else expected_cells
    inventory_cells = (EXPECTED_INVENTORY_CELLS if inventory_cells is None
                       else inventory_cells)
    surface_expected = (EXPECTED_SURFACE_LEXEMES if surface_lexemes is None
                        else surface_lexemes)
    wanted_cells = {
        (group, feature)
        for group, feature, _expected, _first in expected_cells
    } | {
        (group, feature)
        for group, feature, _expected in inventory_cells
    }
    wanted_surfaces = {form for form, _expected in surface_expected}
    cells, preferred, surface_lexemes = {}, {}, {}
    for group, _lemma, _pos, feature, form, _dom, _freq in rows:
        cell = (group, feature)
        if cell in wanted_cells:
            cells.setdefault(cell, set()).add(form)
            # `rows` arrive in artifact order: a cell's FIRST row is what load_forms
            # hands consumers as its preferred realization (fr: by frequency, en: by
            # AGID's own preference).
            preferred.setdefault(cell, form)
        if form in wanted_surfaces:
            surface_lexemes.setdefault(form, set()).add(group)
    problems = []
    for group, feature, expected, first in expected_cells:
        cell = (group, feature)
        actual = frozenset(cells.get(cell, set()))
        if actual != expected:
            problems.append(f"{group} / {feature} : formes {sorted(actual)}, "
                            f"attendu {sorted(expected)}")
        elif first is not None and preferred.get(cell) != first:
            actual_first = preferred.get(cell, "aucune")
            problems.append(f"{group} / {feature} : réalisation préférée "
                            f"« {actual_first} », attendue "
                            f"« {first} »")
    for group, feature, expected in inventory_cells:
        actual = frozenset(cells.get((group, feature), set()))
        if actual != expected:
            problems.append(
                f"{group} / {feature} : formes {sorted(actual)}, "
                f"attendu {sorted(expected)}")
    for form, expected in surface_expected:
        actual = frozenset(surface_lexemes.get(form, set()))
        if actual != expected:
            problems.append(
                f"surface « {form} » : lexèmes {sorted(actual)}, "
                f"attendu {sorted(expected)}")
    if problems:
        print(f"Erreur : les cellules pinnées par les audits {audit} ont bougé —\n"
              + "".join(f"         {p}\n" for p in problems)
              + "         la source ou les règles ont changé : refais l'audit "
                "avant de mettre à jour les sentinelles.", file=sys.stderr)
        sys.exit(1)


# ==================================================================================
# English (#317): AGID for the lexeme, VarCon for the spelling variants, OANC for POS
# evidence — one source, one responsibility, like Morphalou / Lexique for French.
# ==================================================================================

# AGID is the source the #104 lemma table already read; now PINNED like Morphalou.
AGID_URL = "http://downloads.sourceforge.net/wordlist/agid-2016.01.19.tar.gz"
AGID_ARCHIVE = "en.agid.tar.gz"
AGID_SHA256 = "15d2d792d309d2dc838bf75d8abcd3feb36708c219dc5158d4fff70b89e601d1"
AGID_MEMBER = "agid-2016.01.19/infl.txt"
AGID_README = "agid-2016.01.19/README"
AGID_CREDIT = "AGID 2016.01.19 — Kevin Atkinson, wordlist.aspell.net"
# VarCon, from the SCOWL release tag (sourceforge no longer serves the tarball).
VARCON_URL = ("https://raw.githubusercontent.com/en-wl/wordlist/rel-2020.12.07/"
              "varcon/varcon.txt")
VARCON_SHA256 = "340858b990255ec409adcf7faaf2b992aa2a76a16f30b4b9e2663863191dba33"
VARCON_README_URL = ("https://raw.githubusercontent.com/en-wl/wordlist/rel-2020.12.07/"
                     "varcon/README")
VARCON_README_SHA256 = "876c66a2cbd141728aef632286689e1cd96c9df88eab26af8fda4b9924906db7"
VARCON_CREDIT = "VarCon 2020.12.07 — Kevin Atkinson & Benjamin Titze, wordlist.aspell.net"
# The Open American National Corpus counts (word, lemma, Penn tag, count): Lexique's twin
# with an unrestricted licence (SUBTLEX-US, the issue's first idea, is CC BY-NC-SA).
ANC_URL = "https://www.anc.org/SecondRelease/data/ANC-all-count.txt"
ANC_SHA256 = "c9cd70d08604a53c29ec03ad1219499142ecbf6a3836e3f9fb9b934b12d29d27"
ANC_CREDIT = ("Open American National Corpus, second release, word counts — "
              "anc.org, unrestricted use and redistribution")

# AGID's paradigms: the slot order its README documents, per POS. A verb with three
# slots has one past for both the tense and the participle.
AGID_SLOTS = {"V": ("ind:pas", "par:pas", "par:pre", "ind:pre:3s"),
              "N": ("n:p",),
              "A": ("adj:cmp", "adj:sup")}
AGID_POS = {"V": "v", "N": "nc", "A": "adj"}
# The cell a lemma itself fills (AGID lists only the inflections).
EN_CITATION = {"v": "base", "nc": "n:s", "adj": "adj:pos"}
# Paradigms AGID writes in a slot order of their own (its README names be and wit; the
# modals and «methinks» / «only» are the other lines): not the regular grammar, so not
# guessed at — skipped by name, and any OTHER line that breaks the grammar is an error.
AGID_SPECIAL = frozenset({("be", "V"), ("wit", "V"), ("may", "V"), ("shall", "V"),
                          ("methinks", "V"), ("only", "A")})
_AGID_LINE = re.compile(r"^(?P<lemma>[A-Za-z']+) (?P<pos>[VNA])(?P<guess>\?)?: "
                        r"(?P<slots>.+)$")
_AGID_ITEM = re.compile(r"^(?P<form>[A-Za-z']+)(?P<marks>[~<!?]*)"
                        r"(?: (?P<level>\d+(?:\.\d+)?))?(?: \{(?P<note>[^}]*)\})?$")
# AGID's own doubts: «<» a good chance, «~» a slight chance, «!» likely another
# (similar) word's inflection, «?» not in its word list — and variant level 2, «archaic,
# hardly ever used, extremely obscure, or no evidence found». Holes beat wrong forms: all
# drop. «<» is a GUESS too, and in the reduced vocabulary it is nearly always another
# word's form (belief → «believes», fax → «faces», reef → «reeves», measured on the #317
# review: a handful of right ones, «canvasses», against «prices», «motives», «water»).
AGID_UNSURE = frozenset("~!?<")
AGID_OBSCURE_LEVEL = 2


def read_agid(text, token_re):
    """AGID infl.txt -> ({(lemma, pos): {feature: {form: preference}}}, guessed keys,
    stats).

    A form's PREFERENCE is AGID's own: (variant level, place in its slot) — «dreamed,
    dreamt 1», «people, persons 0.1» — the order a cell's spellings ship in (OANC
    frequency only breaks ties, e.g. between the American and British spellings a
    VarCon merge brings together). A spelling equal to the lemma itself stays in
    another cell only where AGID prefers it (level 0, no sense note: «sheep», «fish»,
    «run»); filed as a variant («duck {:1}», «cannon 1», «beat 1», «forbid 1.1») it
    would make the cell's agreement a no-op, and drops.

    Fails closed: a line outside the README's grammar (other than the named
    AGID_SPECIAL paradigms) or a slot count that does not match its POS is a hard
    error, never skipped — a misread line would file forms under the wrong cell.
    Capitalised lemmas are proper names («March», «Polish»), not the common word the
    game's lowercase vocabulary holds; they are counted and left out."""
    lexemes, guessed = {}, set()
    stats = {"special": 0, "proper": 0, "unsure": 0, "obscure": 0, "citation_variant": 0}
    for lineno, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        m = _AGID_LINE.match(raw)
        if m is None:
            raise ValueError(f"AGID ligne {lineno} : hors grammaire : {raw!r}")
        lemma, pos = m["lemma"], m["pos"]
        if (lemma, pos) in AGID_SPECIAL:
            stats["special"] += 1
            continue
        slots = m["slots"].split(" | ")
        if pos == "V" and len(slots) == 3:
            slots = [slots[0]] + slots  # one past for the tense and the participle
        if len(slots) != len(AGID_SLOTS[pos]):
            raise ValueError(f"AGID ligne {lineno} : {len(slots)} cases pour {pos} : "
                             f"{raw!r}")
        items = []
        for feature, slot in zip(AGID_SLOTS[pos], slots):
            for place, item in enumerate(slot.split(", ")):
                im = _AGID_ITEM.match(item.strip())
                if im is None:
                    raise ValueError(f"AGID ligne {lineno} : forme illisible "
                                     f"{item!r}")
                items.append((feature, place, im))
        if lemma != lemma.lower():
            stats["proper"] += 1
            continue
        if not token_re.match(lemma):
            continue
        key = (lemma, AGID_POS[pos])
        cells = lexemes.setdefault(key, {})
        cells.setdefault(EN_CITATION[key[1]], {})[lemma] = (0.0, 0)
        if m["guess"]:
            guessed.add(key)
        for feature, place, im in items:
            form = im["form"].lower()
            level = float(im["level"] or 0)
            if set(im["marks"]) & AGID_UNSURE:
                stats["unsure"] += 1
                continue
            if level >= AGID_OBSCURE_LEVEL:
                stats["obscure"] += 1
                continue
            if form == lemma and (level > 0 or im["note"] is not None):
                stats["citation_variant"] += 1
                continue
            if token_re.match(form):
                forms = cells.setdefault(feature, {})
                forms[form] = min(forms.get(form, (level, place)), (level, place))
    return lexemes, guessed, stats


def corroborate_agid(lexemes, guessed):
    """The English twin of Morphalou's mixed-entry cleanup (#131): trusted rows win.

    A GUESSED entry (AGID's `POS?`: «the part-of-speech was not in the part-of-speech
    database however the inflected forms of the word were found in the word list») is
    where AGID's wrong paradigms live: «pars V?: parsed | parsing | parses» is parse's,
    «lowe A?: lower | lowest» is low's, «newspaper V?: newspapers» is the noun's plural
    read as a verb. So a guessed entry keeps only the forms NO trusted entry already
    states (its citation aside); it disappears when nothing of its own is left, or when
    its lemma is itself another trusted word's form. Measured on the #317 A/B: every
    enumerated wrong attachment goes, while the guessed entries that carry real words
    of their own (the British «socialise», «scammers», «bartended») stay."""
    trusted = {}
    for (lemma, pos), cells in lexemes.items():
        if (lemma, pos) in guessed:
            continue
        for forms in cells.values():
            for form in forms:
                trusted.setdefault(form, set()).add(lemma)
    kept, dropped = {}, {"entries": 0, "rows": 0}
    for key, cells in lexemes.items():
        if key not in guessed:
            kept[key] = cells
            continue
        lemma, pos = key
        if trusted.get(lemma, set()) - {lemma}:
            dropped["entries"] += 1
            continue
        own = {}
        for feature, forms in cells.items():
            if feature == EN_CITATION[pos]:
                own[feature] = dict(forms)
                continue
            good = {f: pref for f, pref in forms.items() if f not in trusted}
            dropped["rows"] += len(forms) - len(good)
            if good:
                own[feature] = good
        if len(own) == 1:  # the citation alone: nothing this entry states itself
            dropped["entries"] += 1
            continue
        kept[key] = own
    return kept, dropped


def complete_adjectives(lexemes):
    """An adjective needs BOTH degrees attested. AGID files an agent noun as a
    comparative when no superlative exists («travel A: traveler | travelest?», «see A:
    seer»); a real gradable adjective has both (bigger / biggest)."""
    kept, dropped = {}, 0
    for key, cells in lexemes.items():
        if key[1] == "adj" and not (cells.get("adj:cmp") and cells.get("adj:sup")):
            dropped += 1
            continue
        kept[key] = cells
    return kept, dropped


# VarCon: the spelling categories that count (American, British -ise, British -ize) and
# the variant levels that count (preferred, equal, variant — never «seldom», «possible»
# or «improper»).
VARCON_CATEGORIES = frozenset("ABZ")
VARCON_LEVELS = frozenset({"", ".", "v"})
_VARCON_TAG = re.compile(r"^(?P<cat>[ABZCD_])(?P<level>[.vV\-x]?)$")


def read_varcon(text, token_re):
    """varcon.txt -> ({spelling: frozenset(its variant set)}, stats).

    Only PURE spelling lines join spellings: a line whose annotation restricts it to a
    sense («check / cheque | bank», «prize / prise | otherwise», «| :1», «(-)») would
    fuse two words, so it is skipped; a part-of-speech tag («practice / practise |
    <V>») or a note («-- pl») restricts nothing and is kept. Variant sets are closed
    transitively (one spelling in two lines is one word)."""
    parent = {}

    def find(w):
        parent.setdefault(w, w)
        while parent[w] != w:
            parent[w] = parent[parent[w]]
            w = parent[w]
        return w

    stats = {"lines": 0, "joined": 0, "sense": 0}
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip()
        if not line or line.startswith("#"):
            continue
        stats["lines"] += 1
        body, _sep, notes = line.partition(" | ")
        pure = all(part.strip().startswith("--")
                   or all(t.startswith("<") and t.endswith(">") for t in part.split())
                   for part in notes.split(" | ")) if notes else True
        if not pure:
            stats["sense"] += 1
            continue
        spellings = []
        for entry in body.split(" / "):
            tags, sep, word = entry.partition(": ")
            if not sep:
                raise ValueError(f"VarCon : entrée illisible {entry!r} dans {raw!r}")
            word = word.strip()
            accepted = False
            for tag in tags.split():
                if tag.isdigit():
                    continue  # a column number
                tm = _VARCON_TAG.match(tag)
                if tm is None:
                    raise ValueError(f"VarCon : étiquette illisible {tag!r} dans {raw!r}")
                if tm["cat"] in VARCON_CATEGORIES and tm["level"] in VARCON_LEVELS:
                    accepted = True
            if accepted and word == word.lower() and token_re.match(word):
                spellings.append(word)
        if len(set(spellings)) > 1:
            stats["joined"] += 1
            first = find(spellings[0])
            for other in spellings[1:]:
                root = find(other)
                if root != first:
                    parent[root] = first
    classes = {}
    for word in parent:
        classes.setdefault(find(word), set()).add(word)
    variants = {word: frozenset(classes[find(word)]) for word in parent}
    stats["largest"] = max((len(c) for c in classes.values()), default=0)
    return variants, stats


def expand_variants(lexemes, variants):
    """Every form's spelling variants join its cell («colours» brings «colors»): the
    British and American filings of one word then have the SAME complete form set,
    and #146's rule 1 makes them one group. A variant takes the preference of the form
    it spells, so the two spellings tie and frequency orders them (American first). A
    line keeps its own spelling on screen — only neighbours are displayed from the
    table."""
    added = 0
    out = {}
    for key, cells in lexemes.items():
        grown = {}
        for feature, forms in cells.items():
            more = dict(forms)
            for form, pref in forms.items():
                for variant in variants.get(form, frozenset()):
                    more[variant] = min(more.get(variant, pref), pref)
            added += len(more) - len(forms)
            grown[feature] = more
        out[key] = grown
    return out, added


def anc_class(tag):
    """One Penn tag -> the artifact's coarse POS class (the `dom` gate's vocabulary).
    A modal is a verb, like French's AUX; a proper noun competes as its own class."""
    if tag.startswith("VB") or tag == "MD":
        return "v"
    if tag in ("NN", "NNS"):
        return "nc"
    if tag in ("NNP", "NNPS"):
        return "np"
    if tag.startswith("JJ"):
        return "adj"
    if tag.startswith("RB") or tag == "WRB":
        return "adv"
    if tag in ("IN", "TO"):
        return "prep"
    if tag == "CC":
        return "conj"
    if tag in ("DT", "PDT", "WDT"):
        return "det"
    if tag.startswith(("PRP", "WP")) or tag == "EX":
        return "pro"
    if tag == "CD":
        return "num"
    if tag == "UH":
        return "intj"
    return tag or "?"


def read_anc_rows(path):
    """ANC-all-count.txt -> (surface, POS class, count) rows. Frequency evidence only."""
    with open(path, encoding="utf-8", errors="replace") as f:
        for lineno, line in enumerate(f, 1):
            cols = line.rstrip("\n").split("\t")
            if len(cols) == 1 and cols[0].startswith("Total words :"):
                continue  # the file's own footer
            if len(cols) != 4:
                raise ValueError(f"ANC ligne {lineno} : 4 colonnes attendues, "
                                 f"{len(cols)} lues")
            word, _lemma, tag, count = cols
            yield word.strip().lower(), anc_class(tag), float(count)


def build_rows_en(agid_text, varcon_text, anc_path):
    """The English deterministic core: the three sources -> the artifact's rows.

    Split from build() for the same reason as build_rows_fr: the reproduction test runs
    the real path over the cached downloads."""
    token_re = red.token_pattern("en")
    lexemes, guessed, stats = read_agid(agid_text, token_re)
    # The adjective check runs FIRST, so an agent noun AGID filed as a comparative
    # («stone A: stoner | stonest?») is no trusted form when the guessed entry of the
    # real word («stoner N?: stoners») is corroborated — and AGAIN after, since
    # corroboration can take a guessed adjective's degree away.
    lexemes, before = complete_adjectives(lexemes)
    lexemes, dropped = corroborate_agid(lexemes, guessed)
    stats["guessed_entries_dropped"] = dropped["entries"]
    stats["guessed_rows_dropped"] = dropped["rows"]
    lexemes, after = complete_adjectives(lexemes)
    stats["adj_incomplete"] = before + after
    variants, vstats = read_varcon(varcon_text, token_re)
    stats.update({f"varcon_{k}": v for k, v in vstats.items()})
    lexemes, stats["variant_forms"] = expand_variants(lexemes, variants)
    groups, merge_stats = merge_entries(lexemes, same_lemma=True)
    stats.update(merge_stats)
    weight = lexique_weights(read_anc_rows(anc_path), token_re, classify=str)
    rows = collect_rows(groups, weight)
    # Sorted by (group, feature, AGID preference, -OANC frequency, form, source lemma,
    # source POS): the FIRST row of a group cell is its preferred realization, AGID's
    # own, and frequency only breaks its ties.
    preference = {}
    for group, members in groups.items():
        for _lemma, _pos, cells in members:
            for feature, forms in cells.items():
                for form, pref in forms.items():
                    key = (group, feature, form)
                    preference[key] = min(preference.get(key, pref), pref)
    rows.sort(key=lambda r: (r[0], r[3], preference[(r[0], r[3], r[4])], -r[6], r[4],
                             r[1], r[2]))
    validate_merge_stats(stats, len(rows), EXPECTED_MERGE_STATS_EN, "#317")
    validate_rows(rows, EXPECTED_CELLS_EN, EXPECTED_INVENTORY_CELLS_EN,
                  EXPECTED_SURFACE_LEXEMES_EN, "#317")
    return rows, stats


# The #317 audit, pinned like #131/#132's: the build FAILS when the data under one of
# these moves, so a source or rule change forces a re-audit. Group keys are opaque
# (the first surviving entry in AGID order names a merged word: «go:nc» carries the
# noun AND the verb). (group, feature, expected forms, preferred spelling or None):
EXPECTED_CELLS_EN = (
    # irregular verbs, both past slots
    ("go:nc", "ind:pas", frozenset({"went"}), None),
    ("go:nc", "par:pas", frozenset({"gone"}), None),
    ("see:nc", "ind:pas", frozenset({"saw"}), None),
    ("run:nc", "par:pas", frozenset({"run"}), None),
    # one verb, two senses, two pasts (AGID's {fib} / {recline}), in AGID's order
    ("lie:nc", "ind:pas", frozenset({"lay", "lied"}), "lied"),
    ("leave:nc", "ind:pas", frozenset({"left", "leaved"}), "left"),
    ("bear:nc", "par:pas", frozenset({"born", "borne"}), "borne"),
    # irregular and zero plurals; a level-2 variant («leafs») is gone; a TRUE zero form
    # stays (sheep, run), a zero form filed as a variant does not (duck {:1}, beat 1)
    ("child:nc", "n:p", frozenset({"children"}), None),
    ("mouse:nc", "n:p", frozenset({"mice"}), None),
    ("sheep:nc", "n:p", frozenset({"sheep"}), None),
    ("fish:nc", "n:p", frozenset({"fish", "fishes"}), "fish"),
    ("duck:nc", "n:p", frozenset({"ducks"}), None),
    ("beat:nc", "par:pas", frozenset({"beaten"}), None),
    ("leaf:nc", "n:p", frozenset({"leaves"}), None),
    ("person:nc", "n:p", frozenset({"people", "persons"}), "people"),
    # a «<» guess is gone («believes» is believe's, never belief's plural)
    ("belief:nc", "n:p", frozenset({"beliefs"}), None),
    # a level-1 variant stays, after AGID's preferred spelling
    ("dream:nc", "ind:pas", frozenset({"dreamed", "dreamt"}), "dreamed"),
    ("forbid:v", "ind:pas", frozenset({"forbade", "forbad"}), "forbade"),
    # American and British spellings are ONE word (VarCon), the American first (OANC)
    ("travel:nc", "ind:pas", frozenset({"traveled", "travelled"}), "traveled"),
    ("color:nc", "n:p", frozenset({"colors", "colours"}), "colors"),
    ("judgement:nc", "n:s", frozenset({"judgment", "judgement"}), "judgment"),
    # adjective degree
    ("good:adj", "adj:cmp", frozenset({"better"}), None),
    ("big:adj", "adj:cmp", frozenset({"bigger"}), None),
)
# A noun and a verb of one spelling are one group, with both paradigms' cells.
EXPECTED_INVENTORY_CELLS_EN = (
    ("walk:nc", "base", frozenset({"walk"})),
    ("walk:nc", "ind:pas", frozenset({"walked"})),
    ("walk:nc", "ind:pre:3s", frozenset({"walks"})),
    ("walk:nc", "n:p", frozenset({"walks"})),
)
# Homography stays derivable, and the cleanup's wrong attachments stay gone: «parsed»
# is parse's, never a guessed «pars V?»'s; «lowest» is low's, never «lowe A?»'s; a
# sense-restricted VarCon pair (cheque | bank, tyre | wheel) never joins the word.
EXPECTED_SURFACE_LEXEMES_EN = (
    ("leaves", frozenset({"leaf:nc", "leave:nc"})),
    ("saw", frozenset({"saw:nc", "see:nc"})),
    ("better", frozenset({"better:nc", "good:adj", "well:adj"})),
    ("colour", frozenset({"color:nc"})),
    ("parsed", frozenset({"parse:v"})),
    ("lowest", frozenset({"low:adj"})),
    ("cheque", frozenset({"cheque:nc"})),
    ("tyre", frozenset({"tyre:nc"})),
    # «<» guesses are gone, and an agent noun AGID filed as a comparative («stone A:
    # stoner») no longer outranks the real word's guessed entry
    ("believes", frozenset({"believe:v"})),
    ("faces", frozenset({"face:nc"})),
    ("discusses", frozenset({"discuss:v"})),
    ("stoners", frozenset({"stoner:nc"})),
)
# The build's source facts on the pinned releases.
EXPECTED_MERGE_STATS_EN = {
    "proper": 13_180,
    "unsure": 22_602,
    "obscure": 274,
    "citation_variant": 220,
    "guessed_entries_dropped": 1_862,
    "guessed_rows_dropped": 1_966,
    "adj_incomplete": 5_032,
    "varcon_joined": 12_988,
    "varcon_sense": 589,
    "variant_forms": 15_623,
    "twin_groups": 1_870,
    "twin_entries": 3_757,
    "contained_entries": 112,
    "groups": 84_182,
    "rows": 245_654,
}


# --- Artifact ---------------------------------------------------------------------

def forms_path(lang):
    """Default versioned word-group inventory: wordlist/<lang>.forms.tsv.gz."""
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
    if lang == "en":
        return [
            "# en.forms.tsv.gz — the unified word inventory (#317): lemma grouping, "
            "duplicate-entry merging, spelling variants, homography and display "
            "agreement.",
            "# Built by scripts/build_forms.py (pnpm forms:en). Do not edit by hand.",
            "#",
            f"# Lexemes     : {AGID_CREDIT}",
            f"#               {AGID_URL}",
            f"#               {AGID_ARCHIVE} sha256:{AGID_SHA256}",
            f"# Variants    : {VARCON_CREDIT}",
            f"#               {VARCON_URL} sha256:{VARCON_SHA256}",
            f"#               Copyright notices of both in "
            f"{os.path.basename(license_path(lang))}.",
            f"# POS evidence: {ANC_CREDIT}",
            f"#               {ANC_URL} sha256:{ANC_SHA256}",
            "#",
            "# group<TAB>lemma<TAB>pos<TAB>feature<TAB>form<TAB>dom",
        ]
    return [
        f"# {lang}.forms.tsv.gz — the unified word inventory (#132/#146): lemma "
        f"grouping, duplicate-entry merging, homography and display agreement.",
        "# Built by scripts/build_forms.py (pnpm forms:fr). Do not edit by hand.",
        "#",
        f"# Lexemes     : {MORPHALOU_CREDIT}",
        f"#               {MORPHALOU_URL}",
        f"#               {MORPHALOU_ARCHIVE} sha256:{MORPHALOU_SHA256}",
        f"#               Licence: {MORPHALOU_LICENSE_NAME}; full text in "
        f"{os.path.basename(license_path(lang))}.",
        f"# POS evidence: Lexique383 (surface frequency only) — {LEXIQUE_URL}",
        "#",
        "# group<TAB>lemma<TAB>pos<TAB>feature<TAB>form<TAB>dom",
    ]


def build_rows_fr(csv_text, lexique_path):
    """The French deterministic core: the two sources -> the exact rows the artifact
    holds.

    Split out of build() so the reproduction test can run the REAL path over the
    cached downloads instead of restating the sort key — a test that mirrors the
    code proves nothing about it."""
    token_re = red.token_pattern("fr")
    lexemes, stats = read_morphalou(csv_text, token_re)
    groups, merge_stats = merge_entries(lexemes)
    stats.update(merge_stats)
    weight = lexique_weights(read_lexique_rows(lexique_path), token_re)
    rows = collect_rows(groups, weight)
    # Sorted by (group, feature, -freq, form, source lemma, source POS):
    # deterministic, and the FIRST row of a GROUP cell is its preferred
    # realization — which is what load_forms reads. A losing spelling and every
    # merged source member stay present, only ordered after.
    rows.sort(key=lambda r: (r[0], r[3], -r[6], r[4], r[1], r[2]))
    validate_merge_stats(stats, len(rows))
    validate_rows(rows)
    return rows, stats


def row_line(group, lemma, pos, feature, form, dom):
    """One artifact line. The single place the row shape is written."""
    return f"{group}\t{lemma}\t{pos}\t{feature}\t{form}\t{dom}"


# The loader's product. `grouping` spans EVERY POS — it is what gen_phrase's merge
# walk consumes (#104's lemma_table shape: form -> opaque group keys). `members`,
# `group_forms` and `group_pos` make the #146 key deliberately opaque: no consumer
# has to reverse-engineer a merged group's paradigms from its canonical suffix.
Lexicon = namedtuple(
    "Lexicon",
    "grouping entries dominant realize features members group_forms group_pos",
)


def load_forms(path):
    """Load a committed inventory into the indexes gen_phrase needs.

    grouping  form -> (group key, ...)           — ALL POS: the #104 merge-walk table
    entries   form -> ((group key, feature), ...) — every POS: what a surface IS
    dominant  form -> pos                        — the POS that dominates a surface's
              reading (the `dom` gate); absent when no reading dominates
    realize   (group key, feature) -> (form, ...) — every POS: EVERY spelling,
              preferred first
    features  {feature}                          — the cell inventory (--form checks)
    members   group key -> (source lexeme keys,) — exact-form entries merged by #146
    group_forms group key -> (form, ...)          — every form, canonical lemma first
    group_pos group key -> {pos}                  — paradigms the opaque group carries

    `realize` keeps the whole ordered candidate list, not just the winner: the
    caller's typability check falls back to the next spelling («déblaies» loses to
    «déblayes» when the favourite is untypable) instead of dropping the rewrite.

    `#` lines are the provenance/licence header and are skipped; any other malformed
    line is an error, loudly, because a truncated artifact would otherwise load as a
    partial table and agree half a puzzle."""
    grouping, entries, dominant, realize, features = {}, {}, {}, {}, set()
    members, group_forms, group_pos = {}, {}, {}
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 6:
                raise ValueError(f"{path}:{lineno}: 6 champs attendus, "
                                 f"{len(parts)} lus — table corrompue ?")
            group, lemma, pos, feature, form, dom = parts
            source_key = lexeme_key(lemma, pos)
            group_members = members.setdefault(group, [])
            if source_key not in group_members:
                group_members.append(source_key)
            group_forms.setdefault(group, set()).add(form)
            group_pos.setdefault(group, set()).add(pos)
            keys = grouping.setdefault(form, [])
            if group not in keys:
                keys.append(group)
            pair = (group, feature)
            surface_entries = entries.setdefault(form, [])
            if pair not in surface_entries:
                surface_entries.append(pair)
            realizations = realize.setdefault(pair, [])
            if form not in realizations:
                realizations.append(form)
            features.add(feature)
            if dom == "1":
                # dom marks the POS that dominates this surface (dominant_pos), so
                # every dom=1 row of one form names the same pos — enforced, like
                # the field-count check above: a hand-edited table with conflicting
                # dom=1 rows would otherwise load last-writer-wins, silently.
                if dominant.setdefault(form, pos) != pos:
                    raise ValueError(
                        f"{path}:{lineno}: « {form} » est dom=1 pour deux POS "
                        f"({dominant[form]}, {pos}) — table corrompue ?")
    return Lexicon({form: tuple(keys) for form, keys in grouping.items()},
                   {form: tuple(pairs) for form, pairs in entries.items()},
                   dominant,
                   {pair: tuple(forms) for pair, forms in realize.items()},
                   frozenset(features),
                   {group: tuple(sorted(keys, key=lambda key: (
                       key != group, key)))
                    for group, keys in members.items()},
                   {group: tuple(sorted(forms, key=lambda form: (
                       form != group.rpartition(":")[0], form)))
                    for group, forms in group_forms.items()},
                   {group: frozenset(poses) for group, poses in group_pos.items()})


def fetch_english(refresh):
    """The three pinned English sources -> (infl.txt, varcon.txt, ANC path, licence).

    The licence file is the two copyright sections verbatim — AGID's README
    «COPYRIGHT AND SOURCE» and VarCon's README «Copyright» — each notice travelling with
    the exact release it governs (a URL is not a copy)."""
    agid = bw.verify_digest(bw.fetch(AGID_URL, os.path.join(bw.CACHE_DIR, AGID_ARCHIVE),
                                     refresh), AGID_SHA256, AGID_ARCHIVE)
    varcon = bw.verify_digest(bw.fetch(VARCON_URL, os.path.join(bw.CACHE_DIR,
                                                                "en.varcon.txt"), refresh),
                              VARCON_SHA256, "varcon.txt")
    varcon_readme = bw.verify_digest(
        bw.fetch(VARCON_README_URL, os.path.join(bw.CACHE_DIR, "en.varcon.README"),
                 refresh), VARCON_README_SHA256, "VarCon README")
    anc = bw.verify_digest(bw.fetch(ANC_URL, os.path.join(bw.CACHE_DIR, "en.anc.tsv"),
                                    refresh), ANC_SHA256, "ANC-all-count.txt")
    import tarfile
    with tarfile.open(agid, "r:gz") as tar:
        infl = tar.extractfile(AGID_MEMBER).read().decode("latin-1")
        agid_readme = tar.extractfile(AGID_README).read().decode("latin-1")
    # Both releases are Latin-1 («führer» in VarCon); nothing outside ASCII passes the
    # token rule anyway.
    varcon_text = open(varcon, encoding="latin-1").read()
    return infl, varcon_text, anc, english_license(
        agid_readme, open(varcon_readme, encoding="latin-1").read())


def english_license(agid_readme, varcon_readme):
    """The copyright sections out of the two READMEs; a missing one is a hard error."""
    sections = []
    for name, text, marker in (("AGID", agid_readme, "COPYRIGHT AND SOURCE:"),
                               ("VarCon", varcon_readme, "\nCopyright\n=========")):
        at = text.find(marker)
        if at < 0:
            print(f"Erreur : la section de copyright de {name} est introuvable dans "
                  f"son README — vérifie la distribution.", file=sys.stderr)
            sys.exit(1)
        sections.append(f"==== {name} ====\n\n" + text[at:].strip() + "\n")
    return "\n\n".join(sections)


def build(lang, *, refresh):
    if lang == "en":
        infl, varcon_text, anc, licence = fetch_english(refresh)
        rows, stats = build_rows_en(infl, varcon_text, anc)
    else:
        csv_text, licence = fetch_morphalou(refresh)
        lexique = bw.verify_digest(
            bw.fetch(LEXIQUE_URL, os.path.join(bw.CACHE_DIR, f"{lang}.lexique.tsv"),
                     refresh), bw.LEXIQUE_SHA256, bw.LEXIQUE_NAME)
        rows, stats = build_rows_fr(csv_text, lexique)

    out_path, lic_path = forms_path(lang), license_path(lang)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(lic_path, "w", encoding="utf-8") as f:
        f.write(licence)
    # mtime=0 — via GzipFile, since gzip.open does not take it: gzip stamps the clock
    # into its header, so without this an unchanged rebuild produces a byte-different,
    # content-identical blob and dirties the working tree for nothing.
    # build_wordlist.py still has that wart; fixing it rewrites its committed
    # artifacts too, so that mechanical sweep remains separate.
    with gzip.GzipFile(out_path, "wb", mtime=0) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8") as f:
        for line in header_lines(lang):
            f.write(line + "\n")
        for group, lemma, pos, feature, form, dom, _freq in rows:
            f.write(row_line(group, lemma, pos, feature, form, dom) + "\n")

    # --- Report (stderr) --------------------------------------------------------
    per_pos = {}
    group_keys = set()
    for group, lemma, pos, _feature, form, dom, _freq in rows:
        group_keys.add(group)
        entry = per_pos.setdefault(pos, {"rows": 0, "lemmas": set(), "forms": set(),
                                         "gated": 0})
        entry["rows"] += 1
        entry["lemmas"].add(lemma)
        entry["forms"].add(form)
        if dom == 0:
            entry["gated"] += 1
    print(f"\nLangue : {lang}", file=sys.stderr)
    print(f"Lignes : {len(rows):,}", file=sys.stderr)
    print(f"Groupes : {len(group_keys):,}", file=sys.stderr)
    for pos in sorted(per_pos, key=lambda p: -per_pos[p]["rows"]):
        e = per_pos[pos]
        print(f"          {pos:<5} {e['rows']:>9,} lignes  "
              f"{len(e['lemmas']):>8,} lexèmes  {len(e['forms']):>8,} formes  "
              f"({e['gated']:,} hors-gabarit POS, dom=0)", file=sys.stderr)
    if lang == "en":
        report_english(stats, lic_path, out_path)
        return
    print(f"Nettoyage des entrées mixtes : {stats['rows_dropped']:,} ligne(s) non "
          f"corroborée(s) retirée(s) de {stats['entries_cleaned']:,} entrée(s) "
          f"(origines ⊄ {{morphalou2, lefff, lglexlefff}})", file=sys.stderr)
    for lemma, pos, feature, form in stats["dropped_samples"]:
        print(f"          p.ex. {lemma}:{pos} / {feature} : {form}", file=sys.stderr)
    print(f"Fusion #146, formes identiques : {stats['twin_groups']:,} groupe(s), "
          f"{stats['twin_entries']:,} entrée(s) source.", file=sys.stderr)
    print(f"Fusion #146, inclusions même POS : {stats['contained_entries']:,} "
          f"entrée(s) redondante(s) retirée(s).", file=sys.stderr)
    for source, targets in stats["contained_samples"]:
        print(f"          p.ex. {source} ⊂ {', '.join(targets)}", file=sys.stderr)
    print(f"Gardes #146 : {len(EXPECTED_MERGE_STATS)} mesure(s) pinnée(s) "
          "vérifiée(s).", file=sys.stderr)
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


def report_english(stats, lic_path, out_path):
    print(f"AGID : {stats['special']} paradigme(s) spécial(aux) écarté(s) par nom, "
          f"{stats['proper']:,} nom(s) propre(s), {stats['unsure']:,} forme(s) douteuse(s) "
          f"(< ~ ! ?), {stats['obscure']:,} variante(s) de niveau ≥ {AGID_OBSCURE_LEVEL}, "
          f"{stats['citation_variant']:,} forme de citation classée en variante",
          file=sys.stderr)
    print(f"Entrées devinées (POS?) : {stats['guessed_entries_dropped']:,} entrée(s) et "
          f"{stats['guessed_rows_dropped']:,} forme(s) déjà dites par une entrée sûre "
          f"retirées ; adjectifs sans leurs deux degrés : {stats['adj_incomplete']:,}",
          file=sys.stderr)
    print(f"VarCon : {stats['varcon_joined']:,} ligne(s) de graphies jointes, "
          f"{stats['varcon_sense']:,} restreinte(s) à un sens écartée(s), plus grande "
          f"classe {stats['varcon_largest']} ; {stats['variant_forms']:,} forme(s) "
          f"ajoutée(s) aux cellules", file=sys.stderr)
    print(f"Fusion : {stats['twin_groups']:,} groupe(s) de formes identiques "
          f"({stats['twin_entries']:,} entrées), {stats['contained_entries']:,} "
          f"inclusion(s) même POS, {stats['groups']:,} groupe(s) après le lemme commun",
          file=sys.stderr)
    print(f"Gardes #317 : {len(EXPECTED_CELLS_EN)} cellule(s), "
          f"{len(EXPECTED_INVENTORY_CELLS_EN)} sentinelle(s), "
          f"{len(EXPECTED_SURFACE_LEXEMES_EN)} surface(s) homographe(s), "
          f"{len(EXPECTED_MERGE_STATS_EN)} mesure(s) vérifiées.", file=sys.stderr)
    print(f"Licences : AGID + VarCon -> {lic_path}", file=sys.stderr)
    print(f"-> {out_path}", file=sys.stderr)
    print(out_path)


def main():
    p = argparse.ArgumentParser(
        description="Construit l'inventaire de lexèmes d'une langue (fr, en) : "
                    "groupement par lemme, homographie et accord d'affichage.")
    p.add_argument("--lang", choices=FORM_LANGS, default="fr")
    p.add_argument("--refresh", action="store_true",
                   help="re-télécharge les sources (ignore le cache)")
    args = p.parse_args()
    build(args.lang, refresh=args.refresh)


if __name__ == "__main__":
    main()
