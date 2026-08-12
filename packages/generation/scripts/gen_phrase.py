#!/usr/bin/env python3
# /// script
# dependencies = ["gensim", "numpy"]
# ///
"""
Generate one self-contained game file for ONE sentence.

Reuse the existing logic as-is:
  - glove_neighbors.build_vocab / build_matrix / closest (cosine neighbors),
  - french_neighbors equivalents for French fastText vectors,
  - start_word.pick_start (start word selection),
  - the ranking pattern: secret word = rank 0, neighbors start at 1.

Two per-language concerns drive the rest:
  - loading: English (GloVe) and French (fastText) do not share the same reduced
    file, header, or alphabet. All of that is described in CONFIG below.
  - accents: French keeps accents for DISPLAY but folds them to a slug for every
    COMPARISON/LOOKUP (see slug()). We never fold a displayed form and never
    display a slug. Output filenames are ASCII slugs; JSON content keeps accents.

The phrase is written under its SOURCE, to
packages/generation/output/word/<lang>/<kind>/<author>/<work>/<slug1>_<slug2>_<slug3>.json
(the three distinct selected slugs in sentence order). The directory levels are
path_slug()s of the source metadata — readable ASCII names, never lookup keys — and a
level that was not provided is omitted along with everything under it, so a puzzle with
no source at all still lands at <lang>/ (#137). Rerunning overwrites only when BOTH the
three words AND the source match: re-running to fix forgotten metadata writes a second
file and leaves the first one behind, under the path it had. A repeated selected word
produces one hole per sentence occurrence, but one rank map and one start hint for that
secret. A puzzle is a generation artifact, NOT a web asset: publish it to the backend
store (local FS or S3) with `pnpm puzzle:publish` — the front gets the day's puzzle from
the backend (#6).

On a terminal the script is fully interactive (#5): the phrase, language, and the
optional source metadata (kind / author / work) are asked when not supplied as flags.
The source metadata flags are not re-prompted when given; the phrase is always shown in
an editable prompt (pre-loaded with the flag value, if any) so it can be tweaked with
the arrow keys before Enter. WITHOUT --words, three distinct secret groups are then chosen
with a
small full-screen selector (select_holes_interactive): arrow-navigate the sentence's
content words, and for each hovered word its start-word candidates are previewed; Enter
picks that word's repeated-word group, a number picks its shared start (Esc cancels). WITH --words (or off a TTY) that
selector is skipped and the words resolve as before. Non-interactive (piped / batch) runs
keep working with flags only — no prompt ever blocks them.

A secret whose surface form has no vector in the reduced embedding can borrow one from a
form of the same lemma (#119) — explicitly: a numbered question on a TTY, --donor
MANQUANT=DONNEUR off one. Nothing is injected into the vocabulary and nothing is guessed.
Mirroring it, an interactively chosen start word can be DISPLAYED under another form of
the same word (« tu t'___ » must read "amuses" while only "amuse" has a vector); the
rank and the geometry stay the chosen band word's. Addendum 2 generalised that to the
words a hole displays, and #133 extends it to the WHOLE rank map, every part of speech:
each group agrees with every part of the secret's morphology it can express through
the committed word-group inventory (#146): adjectives take gender+number, nouns take
number, noun/adjective secrets do not guess a verb conjugation, and verb secrets
lend their stated number to nouns (plus participle gender+number to adjectives).
The secret's form is never inferred: on a TTY every secret asks in usage-level
morphology (gender / number / conjugation), while the stored and --form vocabulary
stays the per-POS cell codes; off a TTY --form MOT=TRAIT remains required per secret
(--no-inflect opts out). Groups are ranked by their homograph-free representative;
the confirmed morphology (and, only when needed, identity) NAMES group 0 — so the
question fires before the walk, and an
inflection of a homographic secret solves its hole («rouge» solves «rouges»).
#146 removes duplicate dictionary entries before this point. A real identity choice
that remains is shown only after the morphology choice, with each entry's complete
forms («fil : fil, fils» vs «fils : fils»); choices whose typable outcomes are
identical collapse because they cannot change play. Off a TTY, #144's qualified
--form MOT=LEXÈME/TRAIT still names a real remaining ambiguity; a bare typed trait
keeps the fail-closed rule.

After each selected rank map is complete, generation prints a curator-only
playability report (#135) over ranks 1..150: display-form coverage, reduced-vocab
frequency profile, homograph-only groups, and the largest measured clean-form
vector divergences. It is observation only — no metric filters or changes a puzzle.

Usage :
    uv run scripts/gen_phrase.py                       # fully interactive
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c \
        --kind book --author "Victor Hugo" --work "Les Misérables"
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c \
        --donor accoutumes=accoutume
    pnpm gen:phrase "<phrase>" --lang fr --words a b c
"""

import argparse
import functools
import json
import math
import os
import random
import re
import select
import sys
from dataclasses import dataclass

# Importing readline (when present) turns every input() on a TTY into a line editor:
# arrow keys move the cursor within the line, so an answer — the phrase especially — can
# be edited in place instead of only backspaced from the end. Harmless off-TTY and when
# the module is absent (e.g. Windows), where input() just reads a plain line.
try:
    import readline  # noqa: F401
except ImportError:  # pragma: no cover - platform without readline (e.g. Windows)
    readline = None

# scripts/ -> generation package root, to import sibling modules and resolve
# vector/cache paths regardless of the cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
for path in (ROOT, SCRIPT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# Two kinds of output, two homes:
#  - PUZZLES are generation artifacts: written under this package's own output/ dir, then
#    PUBLISHED to the daily store (local FS or S3) via `pnpm puzzle:publish`. The front
#    never serves them directly (the backend does, #6), so they don't belong in web/public.
#  - The VOCAB existence set IS a web runtime asset (written to web/public/vocab by the
#    shared write_vocab, imported above).
# ROOT == packages/generation, a sibling of web in the monorepo.
GEN_OUTPUT = os.path.join(ROOT, "output")

import french_neighbors as frn
import glove_neighbors as gn
from build_forms import (CITATION_FEATURE, FORM_LANGS, feature_pos, forms_path,
                         load_forms)  # fr word-group inventory (#132/#146)
from build_lemmas import lemmas_path, load_lemmas  # en form→lemma table (#104)
from distances import quantize_dq  # dq annotations (#115)
from slug import path_slug, slug, write_vocab  # slug/fold contract, dir names, vocab
from start_word import pick_start, start_band

# --- Vocabulary ----------------------------------------------------------------
# V is the WHOLE reduced vocabulary: scripts/reduce_embedding.py already capped and
# filtered it, so V is identical from one run to the next and ranks stay comparable
# between sentences — there are no size/scan knobs to tune here anymore.

# Generation-only knob: cap each secret's rank map to its K nearest DISTINCT LEMMA
# GROUPS (the secret itself is always kept at rank 0). Inflected forms of one word
# collapse into a single ranked group (#104) BEFORE the cap counts — filter-then-cap,
# like the reduction — so K bounds how many distinct words can register as "warm".
# Easy to change here; the front never sees K and stays K-agnostic.
TOP_K = 10_000

# Curator-only playability window (#135). The report reads the nearest groups that
# can make up a normal journey (the start band also tops out at 150), but never
# filters, reorders or otherwise changes the rank map it describes.
PLAYABILITY_TOP = 150
PLAYABILITY_SAMPLES = 5

# Known "kind of piece" values offered by the interactive prompt (#5). Stored as
# canonical English tokens (the front localises for display); the list is a
# SUGGESTION, not a closed set — the prompt still accepts a free-form kind, matching
# the OPEN `SourceKind` union in packages/shared/src/types.ts.
KNOWN_KINDS = ("book", "movie", "music", "quote", "poem")

# --- Per-language config -------------------------------------------------------
# char_class: allowed alphabet. It is used BOTH to validate a vocab token
# (token_regex) and to clean a word (normalize), to stay consistent.
# For "en", char_class = "a-z" keeps ASCII letters only (the GloVe alphabet).
def _build_config():
    en = {
        "module": gn,
        "char_class": "a-z",
    }
    fr = {
        "module": frn,
        "char_class": "a-zàâäéèêëîïôöùûüÿçœæ",
    }
    for cfg in (en, fr):
        cc = cfg["char_class"]
        # Letters with optional internal dashes (same shape as the reduction's rule).
        cfg["token_regex"] = re.compile(rf"^[{cc}]+(-[{cc}]+)*$")
        # strip_re keeps the alphabet AND dashes (normalize collapses/trims them).
        cfg["strip_re"] = re.compile(rf"[^{cc}-]")
        # core_re finds each WORD-CORE inside a raw display token: a maximal run of
        # the alphabet with internal single dashes (arc-en-ciel stays one core), with
        # apostrophes / punctuation acting as separators (t'attends -> "t", "attends").
        # Used to locate a secret inside a token while keeping the token intact for
        # display (issue: apostrophes/punctuation were being stripped from words[]).
        cfg["core_re"] = re.compile(rf"[{cc}]+(?:-[{cc}]+)*")
    return {"en": en, "fr": fr}


CONFIG = _build_config()


def die(msg):
    """Print a clear error message to stderr, then exit with failure."""
    print(f"Erreur : {msg}", file=sys.stderr)
    sys.exit(1)


def normalize(tok, cfg):
    """Clean a TARGET word (a `--words` argument) down to the language alphabet.

    Lowercases, keeps accents (they are in char_class) and internal dashes
    ("arc-en-ciel" stays "arc-en-ciel"), collapses repeated dashes and trims edge
    ones — matching slug(). This is NOT used for the sentence's DISPLAY tokens, which
    keep their punctuation/apostrophes (see display_token); it only sanitises the word
    the author asked to hole, so it can be matched by slug against the sentence."""
    w = cfg["strip_re"].sub("", tok.lower())
    w = re.sub(r"-+", "-", w)
    return w.strip("-")


def display_token(tok):
    """The DISPLAY form of one whitespace token: lowercased, but keeping accents AND
    punctuation/apostrophes. Only case is normalised; nothing is stripped, so the
    stored `words[]` reproduces the sentence faithfully ("t'attends", "rien,", "«mot»")."""
    return tok.lower()


def locate_core(token, target_slug, cfg):
    """Find the first matching word-core in one display token, or ``None``.

    The result is ``(secret_display, prefix, suffix)``: the matched core (accents
    kept, no punctuation) plus the display text before/after it. Apostrophes and
    punctuation are separators, so a secret can be located inside ``t'attends`` /
    ``rien,`` while the token stays intact for display.
    """
    for m in cfg["core_re"].finditer(token):
        if slug(m.group()) == target_slug:
            return (m.group(), token[:m.start()], token[m.end():])
    return None


def ws(display):
    """A {word, slug} object: the displayed (accented) form plus its slug.

    Always carries both, even when slug == word (no conditional shortcuts)."""
    return {"word": display, "slug": slug(display)}


# --- Lemma grouping (#104) as WORD-GROUP ranking (#134/#146) ----------------------
# Inflected forms of one word ("privé"/"privée"/"privés", "vermine"/"vermines") are
# ONE ranked group in a rank map. Since #134 each group is ranked by its
# homograph-free representative (see rank_lexemes), and #146 may merge source
# lexemes whose complete playable form families are indistinguishable. Every
# reduced-vocab form keys to its group, ambiguity resolved closest-first.
# Merging happens HERE, at generation time; embeddings, the reduction and the vocab
# existence set are untouched, and the front only ever LOOKS UP the keys.
#
# Since #132 the fr grouping comes from the SAME artifact as display agreement (the
# Morphalou word-group inventory, build_forms.py): one dictionary defines identity for
# grouping, ranking and display alike, so the merge walk and the agreement pass can
# no longer disagree about what a form belongs to. Group keys remain readable
# («porter:v», «porte:nc») but are opaque downstream: their suffix is not group POS.
# en keeps its AGID
# form→lemma table (build_lemmas.py), a decided non-goal, not a gap.

@functools.lru_cache(maxsize=None)
def _load_lexicon(lang):
    """Load (once) the committed word-group inventory for a language (#132/#146).

    One artifact feeds BOTH the merge walk (grouping) and the agreement pass (all
    morphology views), so it is loaded once and shared. Missing or corrupt -> hard error,
    like the hors-dico wordlist: silently generating without it would ship
    near-duplicate ranks or a half-agreed puzzle."""
    path = forms_path(lang)
    if not os.path.exists(path):
        die(f"inventaire de lexèmes introuvable : {path}\n"
            f"         construis-le avec scripts/build_forms.py (pnpm forms:{lang}), "
            f"ou passe --no-lemmas et --no-inflect pour t'en passer.")
    try:
        return load_forms(path)
    except ValueError as exc:  # a truncated artifact is a startup failure
        die(f"inventaire de lexèmes illisible : {exc}\n"
            f"         reconstruis-le avec scripts/build_forms.py "
            f"(pnpm forms:{lang}).")


def load_lemma_table(lang, disabled=False):
    """Load the committed grouping table for a language.

    fr reads the unified inventory's grouping (#132); en reads its AGID form→lemma
    table (#104). Missing table -> hard error either way. --no-lemmas opts out
    explicitly and returns an empty table, under which every word is its own
    singleton group — the ungrouped ranking, slug-collision losers compacted
    (#134). For a language WITH a forms table it also requires --no-inflect
    (see main): the agreement pass is keyed by the lexemes grouping provides."""
    if disabled:
        return {}
    if lang in FORM_LANGS:
        return _load_lexicon(lang).grouping
    path = lemmas_path(lang)
    if not os.path.exists(path):
        die(f"table forme→lemme introuvable : {path}\n"
            f"         construis-la avec scripts/build_lemmas.py (pnpm lemmas:{lang}), "
            f"ou passe --no-lemmas pour t'en passer.")
    return load_lemmas(path)


def lemmas_of(word, lemma_table):
    """The lemma group key(s) of a word. Absent from the table = its own singleton
    group; two forms merge ONLY when the table says so (strict grouping)."""
    return lemma_table.get(word, (word,))


def claimed_lemmas(lemmas):
    """The lexemes a SURFACE-derived group 0 may claim, absent a confirmed identity.

    A surface naming exactly one lexeme claims it: that is #104's merge, unchanged.
    A CROSS-LEXEME HOMOGRAPH claims NOTHING: its vector is a blend of unrelated
    words, so claiming its analyses would fuse them — `mois` would claim `moi:nc`
    and every form of «moi» would alias to rank 0 (typing «moi» would SOLVE a
    `mois` hole). Since #134 this is only the FALLBACK for the secret's claim: the
    author's #133 confirmation names the hole's lexeme outright (see secret_claim),
    and neighbour groups don't go through here at all — they ARE lexemes, each
    claiming exactly itself (rank_lexemes). Claiming nothing costs only compaction:
    an uncertain identity degrades to "not merged", never to "merged with the wrong
    word" — holes beat wrong forms."""
    return lemmas if len(lemmas) == 1 else ()


def invert_lemmas(lemma_table):
    """Inverse index lemma -> [forms], in the table's deterministic (sorted) order.
    Used by the assembly to enumerate every inflected form of a group's lexeme."""
    inv = {}
    for form, lemmas in lemma_table.items():
        for lemma in lemmas:
            inv.setdefault(lemma, []).append(form)
    return inv


def rank_lexemes(ranking, lemma_table):
    """Order every word group reachable from the walk by its representative (#134).

    A group's representative is its closest embedded form that is NOT shared with
    another group — group-min over clean forms. A homographic form's
    vector provably blends strangers' meanings («vers» mixes the worm's plural with
    the preposition and the poetry noun; ranking lexeme VER by it would put
    "earthworm" next to «poème»), so it sets no lexeme's distance. An unambiguous
    form owns its vector entirely, even when it diverges from its siblings —
    «lunettes» near an eye secret is a contextually excellent guess and the whole
    lexeme rides that closeness: the divergence is real sense signal, not noise.
    Zero heuristics — homography is stated by the dictionary, nothing is guessed.

    A group with NO clean embedded form still ranks: its representative falls back
    to its closest embedded form of any kind, flagged `clean=False` (#134's edge
    case — take what exists), which the caller surfaces in generation output.
    #146's exact-form twins are already one group here, so they cannot create a
    false homograph flag against each other.

    A surface the table does not know is its own singleton lexeme (lemmas_of), so
    it is trivially clean and ranks by its own vector — including under --no-lemmas,
    where every surface is: the walk then degenerates to the ungrouped ranking.

    Returns entities ascending by representative position (= descending similarity),
    ties — only possible between no-clean lexemes sharing their best form — broken
    by lexeme key: (lexeme, rep_form, rep_sim, rep_pos, clean)."""
    best_clean, best_any = {}, {}
    for pos, (w, _r, sim) in enumerate(ranking):
        lexes = lemmas_of(w, lemma_table)
        for lex in lexes:
            if lex not in best_any:
                best_any[lex] = (pos, w, sim)
        if len(lexes) == 1 and lexes[0] not in best_clean:
            best_clean[lexes[0]] = (pos, w, sim)
    entities = []
    for lex, fallback in best_any.items():
        clean = lex in best_clean
        pos, w, sim = best_clean[lex] if clean else fallback
        entities.append((lex, w, sim, pos, clean))
    entities.sort(key=lambda e: (e[3], e[0]))
    return entities


def build_merged_rank_map(secret_display, ranking, lemma_table, forms_by_lemma, Vset,
                          top_k=TOP_K, secret_lemmas=None):
    """One secret's complete rank map under word-group ranking (#134/#146).

    Group 0 is the secret: its slug plus every reduced-vocab form of its claimed
    lexeme(s) key at rank 0 — an inflection of the secret still solves the hole.
    Then the entities of rank_lexemes, closest-first, each KEYED as it opens: a
    group's candidate keys are its representative plus every reduced-vocab form of
    its lexeme, and a slug is assigned only when no closer group holds it — the
    #104 collision rule (smallest rank wins, silently), applied at assembly time,
    so an ambiguous form still attaches to whichever of its lexemes' groups ranked
    closest and «portes» still lands on the closer of porte/porter.

    A group left with NO key cannot be typed, displayed or found, so it is SKIPPED
    and consumes no rank. Filter-then-cap: TOP_K counts groups a player can
    actually reach. Duplicate entries have already merged in the inventory (#146);
    the same assembly rule still dissolves any remaining group whose every playable
    key was claimed closer. It also subsumes the old aliasing compaction (a form of
    an already-keyed group adds no new slug, so its would-be rank disappears).

    A group's DISPLAY is its closest OWNED form: whatever the map prints must type
    back at that group's own rank, so a group whose representative slug belongs to
    a closer group falls back to the nearest form it actually holds.

    With an empty lemma_table every surface is its own clean singleton lexeme and
    the walk reproduces the ungrouped ranking (slug-collision losers now compacted
    away instead of holding empty ranks).

    Returns (merged, rmap, groups):
      merged: [(display, rank_index, sim)] — survivors, compacted, ascending;
              sims are the REPRESENTATIVES' (what the rank means), so dq keeps
              quantizing the geometry the ranking was built from;
      rmap:   {slug: {word, rank}} — every owned key of every surviving group;
      groups: [(display, rank, claims, clean, rep)] — the secret at rank 0 first;
              a neighbour claims exactly its own word group, and `rep` is the
              form whose VECTOR ranked it (which can differ from the display when
              that fell back to another owned form)."""
    if secret_lemmas is None:
        secret_lemmas = claimed_lemmas(lemmas_of(secret_display, lemma_table))
    secret_lemmas = tuple(secret_lemmas)
    pos_of = {w: i for i, (w, _r, _s) in enumerate(ranking)}

    def candidate_forms(head, lemmas):
        """A group's key candidates: the head FIRST, then its lexemes' vocab forms
        closest-first. Head-first is load-bearing for rank 0: a borrowed secret's
        donor can share its very slug (#119: «abattît» borrowing «abattit»), and
        both sit outside the ranking — ordering them by anything else could hand
        the only key to the donor's spelling, and the solved sentence would print
        the wrong accent. The head is the group's identity; it keys first."""
        forms = {form for lemma in lemmas
                 for form in forms_by_lemma.get(lemma, ()) if form in Vset}
        forms.add(head)
        return sorted(forms, key=lambda f: (f != head,
                                            pos_of.get(f, len(ranking)), f))

    rmap = {}

    def open_group(head, rank, lemmas):
        """Key one group's forms (unclaimed slugs only) and pick its display.

        Returns the display form, or None when every candidate slug already
        belongs to a closer group — the group then never existed."""
        owned = []
        for form in candidate_forms(head, lemmas):
            s = slug(form)
            if s and s not in rmap:
                rmap[s] = {"word": form, "rank": rank}
                owned.append(form)
        if not owned:
            return None
        display = head if head in owned else owned[0]
        for form in owned:
            rmap[slug(form)]["word"] = display
        return display

    open_group(secret_display, 0, secret_lemmas)  # the secret always keys its slug
    groups = [(secret_display, 0, secret_lemmas, True, secret_display)]
    merged = []
    for lex, rep, sim, _pos, clean in rank_lexemes(ranking, lemma_table):
        if lex in secret_lemmas:
            continue  # the secret's own family: already keyed at rank 0
        display = open_group(rep, len(merged) + 1, (lex,))
        if display is None:
            continue  # keyless: dissolved into closer groups, no rank consumed
        merged.append((display, len(merged), sim))
        groups.append((display, len(merged), (lex,), clean, rep))
        if len(merged) >= top_k:
            break
    return merged, rmap, groups


# --- Distance annotations (#115) ------------------------------------------------
# Ranks are uniformly spaced by construction, so they carry no geometry. `dq` (the
# quantized cosine distance to the secret) restores it. It is a GROUP property computed
# from the vectors already in hand at generation time — the client never sees vectors —
# and it rides along on every key of a group, aliases included.

def annotate_rank_map(rmap, merged, secret=""):
    """Stamp a built rank map with each group's `dq`.

    Runs after the merge walk and alias expansion, and keys off the entry's `rank`
    alone — which is exactly what makes "aliases share their group's values" true by
    construction, with no second grouping pass (the front and the benchmark only ever
    LOOK UP these keys).

    The SECRET's own entry (rank 0) is deliberately left bare: it is the terminus,
    off-scale by nature, and scoring never needs it (solving is the atomic hop).
    `dq` has no opt-out — it is part of the schema.
    """
    if not merged:
        return rmap
    try:
        dq_by_rank = quantize_dq([sim for _w, _r, sim in merged])
    except ValueError as exc:
        die(f"distances inexploitables pour « {secret} » : {exc}")
    for entry in rmap.values():
        rank = entry["rank"]
        if rank == 0:
            continue
        entry["dq"] = dq_by_rank[rank - 1]
    return rmap


def build_puzzle_rank_map(secret_display, ranking, lemma_table, forms_by_lemma, Vset,
                          secret_lemmas=None):
    """One secret's rank map AS SHIPPED: lexeme-ranked, keyed, dq-annotated.

    The one entry point both authoring paths use, so a puzzle can never be written
    with a structurally correct but distance-less map. build_merged_rank_map stays the
    purely structural builder underneath it (#104/#134).

    `ranking` may have been walked from a DONOR's vector (#119) while `secret_display`
    stays the true sentence form: the similarities are the donor's either way, which is
    the whole point — the donor is the geometry source, so the dq scale is the one the
    borrowed vector describes."""
    merged, rmap, groups = build_merged_rank_map(
        secret_display, ranking, lemma_table, forms_by_lemma, Vset, TOP_K,
        secret_lemmas)
    annotate_rank_map(rmap, merged, secret=secret_display)
    return merged, rmap, groups


def group_lexeme_map(groups):
    """rank -> the group's lexeme key, for the agreement pass (#134).

    Group ids are opaque since #146: a suffix cannot say which paradigms a merged
    word carries. Pass every singleton claim through and let FormResolver's explicit
    inventory metadata decide whether it has cells. A table-less singleton has no
    entry there and keeps its representative. Rank 0 is excluded: the secret already
    holds the true sentence form."""
    return {rank: claims[0] for _w, rank, claims, _clean, _rep in groups
            if rank and len(claims) == 1}


def _percentile_rank(values, fraction):
    """Nearest-rank percentile over positive integer vocabulary ranks."""
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * fraction) - 1)
    return ordered[index]


def _cosine_distance(left, right):
    """Cosine distance for two plain or numpy-like vectors, or None if unusable.

    This is report-only arithmetic: malformed/missing vectors suppress one
    divergence datum rather than turning a valid puzzle into a generation error.
    The ranking and shipped geometry keep their existing fail-fast contracts."""
    try:
        pairs = [(float(a), float(b)) for a, b in zip(left, right)]
    except (TypeError, ValueError):
        return None
    if not pairs:
        return None
    dot = sum(a * b for a, b in pairs)
    left_norm = math.sqrt(sum(a * a for a, _b in pairs))
    right_norm = math.sqrt(sum(b * b for _a, b in pairs))
    if left_norm == 0.0 or right_norm == 0.0:
        return None
    similarity = max(-1.0, min(1.0, dot / (left_norm * right_norm)))
    distance = 1.0 - similarity
    return distance if math.isfinite(distance) else None


def build_vocab_indexes(vocab):
    """Frequency and existence indexes of the reduced vocabulary, for the report.

    A pure function of ``vocab`` — but ~TOP_N words, so slugging it is the
    report's one real cost. PlayabilityReporter builds it once and shares it
    across the run's secrets; computing it here by default keeps
    build_playability_report self-contained."""
    frequency = {word: index for index, word in enumerate(vocab, 1)}
    slug_frequency = {}
    for word, index in frequency.items():
        key = slug(word)
        if key:
            slug_frequency.setdefault(key, index)
    return frequency, slug_frequency, frozenset(vocab)


def build_playability_report(secret, groups, rank_map, vocab, lemma_table,
                             forms_by_lemma, kv, resolver=None, feature=None,
                             morphology=None, top=PLAYABILITY_TOP, indexes=None):
    """Build #135's neutral, read-only report for one secret.

    The window is the shipped groups at ranks 1..``top``. It reports four form
    outcomes so the requested three fractions stay truthful and exhaustive:
      - ``agreed``: the final display is in the requested cell;
      - ``fallback``: an expressible target cell is missing/untypable (the ``*``);
      - ``citation``: this group cannot express the selected morphology;
      - ``collision``: a realizable form was declined by closest-wins slug keying.
    Collision is deliberately not folded into ``fallback``: #134 gives ``*`` the
    narrower missing-or-untypable meaning and already reports collisions separately.

    Frequency uses the final displayed form when it exists verbatim in the reduced
    vocabulary. A display that is typable only through an accent/slug sibling uses
    that slug's first (most frequent) reduced-vocab position and records ``proxy``.
    Divergence is the maximum cosine distance from the group's representative to
    another clean embedded form of the same lexeme. Reporting every comparable
    value lets the formatter select the largest examples without a quality cutoff.

    Nothing here mutates ``groups`` or ``rank_map`` and no metric gates generation.
    """
    top = max(0, int(top))
    by_rank = {}
    for entry in rank_map.values():
        rank = entry.get("rank")
        if isinstance(rank, int) and 0 < rank <= top:
            by_rank.setdefault(rank, entry.get("word", ""))
    near = [(*group, by_rank[group[1]]) for group in groups
            if group[1] in by_rank]

    frequency, slug_frequency, vocab_set = (
        indexes if indexes is not None else build_vocab_indexes(vocab))

    # Group 0 is authoring evidence too (#146): a wrong/empty claim is the exact
    # failure that made a singular stop solving its plural. Recover display forms
    # from the inventory — never print folded map keys — and keep one spelling per
    # actual rank-0 slug.
    zero_claims = groups[0][2] if groups else ()
    zero_slugs = {key for key, entry in rank_map.items()
                  if entry.get("rank") == 0}
    zero_forms = []
    for claim in zero_claims:
        zero_forms.extend(forms_by_lemma.get(claim, ()))
    zero_forms.append(secret)
    zero_forms = [form for form in zero_forms if slug(form) in zero_slugs]
    canonical = secret
    if len(zero_claims) == 1:
        # Inventory groups carry `lemma:pos`; table-less/en claims are bare. A bare
        # claim has no suffix to strip, so the displayed secret remains canonical.
        canonical = zero_claims[0].rpartition(":")[0] or secret
    seen_zero = set()
    zero_keys = []
    for form in sorted(set(zero_forms), key=lambda form: (form != canonical, form)):
        key = slug(form)
        if key and key not in seen_zero:
            seen_zero.add(key)
            zero_keys.append(form)

    form_coverage = None
    if morphology is None and feature is not None:
        morphology = morphology_from_feature(feature)
    if resolver is not None and morphology is not None:
        counts = {"agreed": 0, "fallback": 0, "citation": 0, "collision": 0}
        for _word, _rank, claims, _clean, _rep, display in near:
            lexeme = claims[0] if len(claims) == 1 else None
            targets = resolver.target_features(lexeme, morphology) \
                if lexeme is not None else ()
            if not targets:
                counts["citation"] += 1
                continue
            realizations = resolver.realize_features(lexeme, targets)
            if display in realizations:
                counts["agreed"] += 1
                continue
            typable = any(slug(form) in slug_frequency for form in realizations)
            if not realizations or not typable:
                counts["fallback"] += 1
            else:
                # A requested form exists and is typable, but the final
                # group does not display it: closest-wins declined the rewrite.
                counts["collision"] += 1
        form_coverage = counts

    frequency_items = []
    for _word, rank, _claims, _clean, _rep, display in near:
        exact = frequency.get(display)
        freq_rank = exact if exact is not None else slug_frequency.get(slug(display))
        if freq_rank is not None:
            frequency_items.append({
                "rank": rank,
                "word": display,
                "frequency_rank": freq_rank,
                "proxy": exact is None,
            })
    values = [item["frequency_rank"] for item in frequency_items]
    rarest = sorted(frequency_items,
                    key=lambda item: (-item["frequency_rank"], item["rank"],
                                      item["word"]))[:PLAYABILITY_SAMPLES]
    frequency_profile = {
        "measured": len(values),
        "unmeasured": len(near) - len(values),
        "proxy": sum(item["proxy"] for item in frequency_items),
        "p50": _percentile_rank(values, 0.50),
        "p90": _percentile_rank(values, 0.90),
        "max": max(values) if values else None,
        "rarest": rarest,
    }

    no_clean = []
    divergences = []

    def vector_of(word):
        try:
            return kv[word]
        except (KeyError, TypeError):
            return None

    for _word, rank, claims, clean, rep, display in near:
        # Unlike the coverage loop, no ':' guard: en claims are bare AGID lemmas
        # (and key forms_by_lemma the same way), so requiring an inventory-style
        # lexeme key would silently drop every en divergence. Only the coverage
        # fractions need cells, which only ':'-keyed inventory lexemes carry.
        lexeme = claims[0] if len(claims) == 1 else None
        if not clean:
            no_clean.append({"rank": rank, "word": display, "lexeme": lexeme})
            continue
        if lexeme is None:
            continue
        rep_vector = vector_of(rep)
        if rep_vector is None:
            continue
        clean_forms = []
        for form in forms_by_lemma.get(lexeme, ()):
            analyses = lemmas_of(form, lemma_table)
            if (form in vocab_set and len(analyses) == 1
                    and analyses[0] == lexeme and vector_of(form) is not None):
                clean_forms.append(form)
        if rep not in clean_forms:
            # A clean representative should be present in its lexeme's inventory;
            # keep the report robust to table-less fixtures or partial artifacts.
            analyses = lemmas_of(rep, lemma_table)
            if (rep in vocab_set and len(analyses) == 1
                    and analyses[0] == lexeme):
                clean_forms.append(rep)
        farthest = None
        for form in sorted(set(clean_forms)):
            if form == rep:
                continue
            distance = _cosine_distance(rep_vector, vector_of(form))
            if distance is None:
                continue
            candidate = (distance, form)
            if farthest is None or candidate > farthest:
                farthest = candidate
        if farthest is not None:
            divergences.append({
                "rank": rank,
                "lexeme": lexeme,
                "representative": rep,
                "form": farthest[1],
                "distance": farthest[0],
            })
    divergences.sort(key=lambda item: (-item["distance"], item["rank"],
                                       item["lexeme"], item["form"]))

    return {
        "secret": secret,
        "claim": tuple(zero_claims),
        "claim_keys": tuple(zero_keys),
        "top": top,
        "groups": len(near),
        "last_rank": max((group[1] for group in near), default=0),
        "forms": form_coverage,
        "frequency": frequency_profile,
        "no_clean": no_clean,
        "divergences": divergences,
    }


def _fr_decimal(value, digits):
    """The report is French prose; its numbers take the French decimal comma."""
    return f"{value:.{digits}f}".replace(".", ",")


def _fraction(count, total):
    percent = 100.0 * count / total if total else 0.0
    return f"{count}/{total} ({_fr_decimal(percent, 1)} %)"


def format_playability_report(report, table=None):
    """Render one neutral curator report. No adjectives or pass/fail labels.

    `table` supplies #146's source-member metadata: opaque group ids cannot be
    described by interpreting their canonical `:pos` suffix."""
    lines = [
        f"  secret « {report['secret']} » — {report['groups']} groupe(s), "
        f"rangs 1–{report['last_rank']} (fenêtre ≤ {report['top']})"
    ]
    claim = ", ".join(report.get("claim", ())) or "aucun lexème"
    keys = ", ".join(f"« {word} »" for word in report.get("claim_keys", ())) \
        or "aucune"
    lines.append(f"    groupe 0 : claim {claim} — clés : {keys}")
    coverage = report["forms"]
    if coverage is None:
        lines.append("    formes : non mesurées (aucun trait d'accord appliqué)")
    else:
        total = sum(coverage.values())
        parts = [
            f"accord net {_fraction(coverage['agreed'], total)}",
            f"repli* {_fraction(coverage['fallback'], total)}",
            f"citation inter-POS/invariable {_fraction(coverage['citation'], total)}",
        ]
        if coverage["collision"]:
            parts.append(f"collision de slug {_fraction(coverage['collision'], total)}")
        lines.append("    formes : " + " · ".join(parts))

    freq = report["frequency"]
    if freq["measured"]:
        suffix = []
        if freq["proxy"]:
            suffix.append(f"{freq['proxy']} via slug")
        if freq["unmeasured"]:
            suffix.append(f"{freq['unmeasured']} sans rang")
        note = f" ({', '.join(suffix)})" if suffix else ""
        lines.append(
            f"    fréquence réduite : p50 #{freq['p50']} · p90 #{freq['p90']} · "
            f"max #{freq['max']} · n={freq['measured']}{note}"
        )
        rare = ", ".join(
            f"« {item['word']} » #{item['frequency_rank']}"
            + ("~" if item["proxy"] else "")
            for item in freq["rarest"]
        )
        lines.append(f"    fréquences les plus basses : {rare}")
    else:
        lines.append("    fréquence réduite : aucun rang mesurable")

    if report["no_clean"]:
        shown = report["no_clean"][:PLAYABILITY_SAMPLES]
        flags = ", ".join(
            f"{describe_lexeme(item['lexeme'], table) if item['lexeme'] else item['word']} "
            f"→ « {item['word']} » (rang {item['rank']})"
            for item in shown
        )
        more = (f", … {len(report['no_clean'])} au total"
                if len(report["no_clean"]) > len(shown) else "")
        lines.append(
            f"    vecteur uniquement homographe : "
            f"{_fraction(len(report['no_clean']), report['groups'])} · {flags}{more}"
        )
    else:
        lines.append("    vecteur uniquement homographe : aucun")

    comparable = len(report["divergences"])
    if comparable:
        shown = report["divergences"][:PLAYABILITY_SAMPLES]
        values = ", ".join(
            f"{describe_lexeme(item['lexeme'], table)} : "
            f"« {item['representative']} » ↔ "
            f"« {item['form']} » = {_fr_decimal(item['distance'], 3)}"
            for item in shown
        )
        lines.append(
            f"    écarts cosinus aux représentants ({len(shown)}/{comparable} "
            f"plus grands) : {values}"
        )
    else:
        lines.append("    écarts cosinus aux représentants : aucun groupe comparable")
    return "\n".join(lines)


class PlayabilityReporter:
    """Collect reports across both authoring paths and print them after raw mode."""

    def __init__(self, vocab, lemma_table, forms_by_lemma, kv, resolver=None,
                 top=PLAYABILITY_TOP):
        self.vocab = vocab
        self.lemma_table = lemma_table
        self.forms_by_lemma = forms_by_lemma
        self.kv = kv
        self.resolver = resolver
        self.top = top
        self.reports = {}
        self._indexes = None  # built on first capture — a pure function of vocab

    def capture(self, secret, groups, rank_map, feature=None):
        if self._indexes is None:
            self._indexes = build_vocab_indexes(self.vocab)
        morphology = (self.resolver.morphology_for(secret)
                      if self.resolver is not None and feature is not None else None)
        self.reports[slug(secret)] = build_playability_report(
            secret, groups, rank_map, self.vocab, self.lemma_table,
            self.forms_by_lemma, self.kv, resolver=self.resolver,
            feature=feature, morphology=morphology, top=self.top,
            indexes=self._indexes)

    def print(self):
        if not self.reports:
            return
        print("\nRapport de jouabilité (informatif — aucun filtrage) :")
        table = self.resolver.table if self.resolver is not None else None
        for report in self.reports.values():
            print(format_playability_report(report, table))


# --- Lemma-donor vector substitution (#119) -------------------------------------
# A perfectly valid sentence form can have NO vector in the reduced embedding while its
# SLUG is still in the vocab existence set through an accent sibling: "accoutumes" (2sg)
# never survived reduction, but "accoutumés" did and folds to the same slug — so the
# front would happily accept the player typing the secret, yet the neighbor walk has no
# vector to walk from. Inflections of one lemma sit at near-identical points in these
# spaces, so a sibling form's vector yields a rank map that is indistinguishable in
# practice. The substitution is therefore allowed, but NEVER silent and NEVER guessed:
# on a TTY the human picks the donor from a numbered list, off a TTY it must be spelled
# out with --donor. Nothing is injected into the vocabulary — the donor is an EXISTING
# vector borrowed only as the GEOMETRY source; the hole still displays the true sentence
# form, `ranks` stays keyed by the secret's slug, and the donor is absorbed as a rank-0
# alias by the #104 merge walk (typing it solves, like any inflection of the secret).

def parse_donor_args(pairs):
    """`--donor MANQUANT=DONNEUR` occurrences -> {slug(manquant): donneur}.

    Keyed by SLUG because that is how a secret is identified everywhere else; the
    donor keeps its display form (it must match a reduced-vocab word exactly)."""
    mapping = {}
    for raw in pairs or ():
        missing, sep, donor = raw.partition("=")
        missing, donor = missing.strip().lower(), donor.strip().lower()
        if not sep or not missing or not donor:
            die(f"--donor attend 'MANQUANT=DONNEUR' (reçu : '{raw}').")
        key = slug(missing)
        if not key:
            die(f"--donor : '{missing}' ne contient aucune lettre exploitable.")
        mapping[key] = donor
    return mapping


def edit_distance(a, b):
    """Levenshtein distance between two DISPLAY forms (accents kept, NOT slugs).

    Slug space would put an accent sibling ("accoutumés") at distance 0 from the
    missing form and hide the genuinely closer inflection, so the comparison stays on
    the displayed spellings where « é » ≠ « e ». Only used to ORDER the donor
    suggestions — the choice itself is always the human's."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def donor_candidates(lemmas, word, forms_by_lemma, Vset, freq_index):
    """The forms that may lend `word` their vector, best suggestion first.

    Every form of `lemmas` that IS in the reduced vocabulary, minus `word` itself.
    Sorted by accent-aware edit distance, then by frequency index (the reduced file's
    order: lower = more frequent), then alphabetically so the listing is
    deterministic."""
    forms = set()
    for lemma in lemmas:
        for form in forms_by_lemma.get(lemma, ()):
            if form != word and form in Vset:
                forms.add(form)
    return sorted(forms, key=lambda f: (edit_distance(word, f),
                                        freq_index.get(f, len(freq_index)), f))


def free_donors(secret, used_lemmas, lemma_table, donors):
    """The donor candidates that would NOT merge `secret` into an already committed
    group. A borrowed vector gives the secret the donor's identity (see group_lemmas),
    so a donor whose lemma is spent would hole one word twice."""
    return [d for d in donors.candidates(secret)
            if not (set(group_lemmas(secret, d, lemma_table)) & used_lemmas)]


def spent_candidate(secret, used_slugs, used_lemmas, lemma_table, donors=None):
    """Is this selectable occurrence already consumed by an earlier hole?

    Its slug is committed, or its group's lemmas are already claimed — one word, one
    hole set (#104). The group is decided by the DONOR when there is one (#119), never
    by the secret's own lemmas: a form the table does not know is a singleton that
    clashes with nothing, so asking it would leave "accoutumes" selectable after
    "accoutume" and hole the accoutumer group twice. While its donor is still open the
    word has no group yet, so it is spent only once NO donor is left that would keep it
    independent."""
    if slug(secret) in used_slugs:
        return True
    donor = secret if donors is None else donors.resolved(secret)
    if donor is None:
        return not free_donors(secret, used_lemmas, lemma_table, donors)
    return bool(set(group_lemmas(secret, donor, lemma_table)) & used_lemmas)


def group_lemmas(secret, donor, lemma_table):
    """The secret's IDENTITY: which lexemes count as "the same word" as this hole.

    Without a substitution: the secret's own lemmas (unchanged, #104). With one: the
    donor's too, because the borrowed identity has to be complete — a form the
    grouping table does not know is its own singleton group, so without the donor's
    lemmas its own family would rank as strangers around it.

    This is the DUPLICATE-HOLE test ("one word, one hole set"), so it stays the FULL
    set: two occurrences of one family must clash even when neither can claim its
    lexemes in the walk. What the group actually claims there is this run through
    `claimed_lemmas` — a stricter set, and deliberately a separate question."""
    lemmas = list(lemmas_of(secret, lemma_table))
    if donor != secret:
        lemmas += [l for l in lemmas_of(donor, lemma_table) if l not in lemmas]
    return tuple(lemmas)


def group_claim(secret, donor, lemma_table, donors=None):
    """What the secret CLAIMS in the merge walk — at most ONE word group.

    Without a substitution: the secret's own group, if its surface names just one
    (see claimed_lemmas).

    With a BORROWED vector (#119), the claim is what the two SHARE, never the union
    of what they name. A donor pair names a SURFACE — which vector to borrow — not a
    lexeme: choosing «fut» for the secret «futs» says "use fut's vector", NOT "the
    cask and the verb être are the same word". Claiming the union did exactly that,
    and every form of être then aliased to rank 0 of a noun hole — the very fusion
    the ordinary path refuses. The intersection keeps the donor useful (`futs`/`fut`
    still share `fut:nc`, so the cask's family still solves) while `être:v`, which
    the secret never names, can never be claimed.

    `donors` supplies the slug-sibling bridge for a secret the table does not know
    (`accoutumes`), which is the whole reason a borrowed identity exists; without a
    resolver the plain intersection is used, which is fail-closed."""
    if donor == secret:
        return claimed_lemmas(lemmas_of(secret, lemma_table))
    if donors is not None:
        shared = donors.shared_lemmas(secret, donor)
    else:
        wanted = set(lemmas_of(secret, lemma_table))
        shared = tuple(l for l in lemmas_of(donor, lemma_table) if l in wanted)
    return claimed_lemmas(shared)


def secret_claim(secret, donor, lemma_table, donors=None, forms=None):
    """What group 0 claims (#134/#146): the confirmed word group, else fall back.

    The #133 answer first names usage morphology. Duplicate dictionary entries are
    already one opaque group, so «rouges» needs only gender+number and its merged
    group is the claim. If real groups with different typable families remain, the
    prompt adds an identity pick; a qualified --form MOT=LEXÈME/TRAIT does the same
    off a TTY (#144). Claiming that group is what makes an inflection of a
    homographic secret solve its hole. A BARE trait still names a group only when
    one distinct playable outcome carries it; otherwise it falls back fail-closed
    (and a bare --form trait in that position is a hard error — see feature_for).

    A BORROWED vector (#119) still claims only what secret and donor share: the
    confirmed group is honoured only when it is in that shared set, else the
    plain group_claim intersection applies. Asking the resolver here is what pulls
    the #133 question AHEAD of the walk — the claim needs the answer, so the
    prompt (or --form, or the off-TTY hard error) fires before any ranking."""
    confirmed = forms.confirmed_lexeme(secret) if forms is not None else None
    if confirmed is not None:
        if donor == secret:
            return (confirmed,)
        if donors is not None and confirmed in donors.shared_lemmas(secret, donor):
            return (confirmed,)
    return group_claim(secret, donor, lemma_table, donors)


def walk_secret(secret, donor, cfg, kv, V, M, Vset, lemma_table, forms_by_lemma,
                donors=None, forms=None):
    """One word's ranked neighborhood, from its identity to its shipped rank map.

    The per-secret pipeline, in the one order that is load-bearing: settle what
    group 0 CLAIMS first (#133/#134 — the answer is the author's, so the question
    fires before any ranking), then walk from the geometry source, then assemble and
    dq-stamp the map.

    Shared by every authoring path so none of them can reorder the pipeline: a
    sentence hole (holes_from_words), and a single-word artifact (gen_word, #154).
    `donor` is the vector source — the secret itself, or the form lending it one
    (#119); `secret` stays the true form the artifact displays and keys either way.

    Returns build_puzzle_rank_map's (merged, rank_map, groups)."""
    secret_lemmas = secret_claim(secret, donor, lemma_table, donors, forms)
    # The walk needs the FULL raw ranking: merging collapses inflections, so reaching
    # TOP_K distinct groups can consume well over TOP_K raw neighbors.
    ranking = cfg["module"].closest(donor, kv, V, M, n=None)
    return build_puzzle_rank_map(secret, ranking, lemma_table, forms_by_lemma, Vset,
                                 secret_lemmas=secret_lemmas)


class DonorResolver:
    """Resolve the vector source for a secret form, asking the human when needed.

    A secret that survived reduction is its own source (the whole point: nothing
    changes for the normal case). A missing form goes through the explicit path: a
    --donor pair, or a numbered prompt on a TTY. Every question is asked at most once
    per secret slug (`_chosen`), and every substitution is recorded in `used` so the
    caller can surface it."""

    def __init__(self, lemma_table, forms_by_lemma, V, Vset, lang,
                 explicit=None, interactive=False):
        self.lemma_table = lemma_table
        self.forms_by_lemma = forms_by_lemma
        self.V = V
        self.Vset = Vset
        self.lang = lang
        self.explicit = explicit or {}
        self.interactive = interactive
        self.used = {}      # secret slug -> (secret display, donor display)
        self._chosen = {}   # secret slug -> donor display
        self._candidates = {}
        self._freq = None
        self._by_slug = None

    # -- lazily derived indexes (a normal run never needs them) ------------------
    @property
    def freq_index(self):
        """word -> position in the reduced file (frequency order), for tie-breaks."""
        if self._freq is None:
            self._freq = {w: i for i, w in enumerate(self.V)}
        return self._freq

    @property
    def by_slug(self):
        """slug -> the reduced-vocab forms that fold to it, in frequency order. Its
        keys ARE the existence set the front will fetch."""
        if self._by_slug is None:
            index = {}
            for w in self.V:
                s = slug(w)
                if s:
                    index.setdefault(s, []).append(w)
            self._by_slug = index
        return self._by_slug

    # -- eligibility -------------------------------------------------------------
    def lemmas_for(self, word):
        """Where to look for donors: the lemma group(s) `word` belongs to.

        The committed table when it knows the form. Otherwise the table is asked about
        the reduced-vocab forms sharing `word`'s SLUG — the very words that make the
        secret typable. The bridge carries a sentence form the grouping table happens
        not to state: such a form has no lemma of its own, and only its accent
        sibling can name the group. Returns () when nothing knows the word — then
        there is no donor."""
        if word in self.lemma_table:
            return tuple(self.lemma_table[word])
        lemmas = []
        for sibling in self.by_slug.get(slug(word), ()):
            for lemma in lemmas_of(sibling, self.lemma_table):
                if lemma not in lemmas:
                    lemmas.append(lemma)
        return tuple(lemmas)

    def shared_lemmas(self, word, donor):
        """Lexemes `donor` has in common with `word`, in table order."""
        wanted = set(self.lemmas_for(word))
        return tuple(lemma for lemma in lemmas_of(donor, self.lemma_table)
                     if lemma in wanted)

    def candidates(self, word):
        """Donor candidates for one missing form (cached per display form)."""
        if word not in self._candidates:
            self._candidates[word] = donor_candidates(
                self.lemmas_for(word), word, self.forms_by_lemma, self.Vset,
                self.freq_index)
        return self._candidates[word]

    def typable(self, word):
        """Could the player ever type this exact secret? Its slug must be in the
        existence set, i.e. SOME reduced word folds to it (here: the accent sibling).
        Without that, borrowing a vector would build a hole nobody can fill exactly."""
        return slug(word) in self.by_slug

    def eligible(self, word):
        """Can this vector-less form be holed at all (a donor exists AND it is
        typable)? Used by the interactive selector to decide whether to offer it."""
        return bool(self.candidates(word)) and self.typable(word)

    # -- resolution --------------------------------------------------------------
    def choose(self, word, donor):
        """Remember the donor settled on for `word`, so the question — asked or read
        off --donor — is settled once per secret slug. Answering it is NOT using it:
        availability checks resolve donors for words that may never be holed."""
        self._chosen[slug(word)] = donor
        return donor

    def note_used(self, word, donor):
        """Record a substitution that actually made it into the puzzle. `used` is what
        the run reports, so a --donor pair (or an answered question) for a word nobody
        holed is never announced. A no-op when the secret is its own vector."""
        if donor != word:
            self.used[slug(word)] = (word, donor)
        return donor

    def _validate(self, word, donor):
        """A --donor pair must name a real vector AND a genuine same-lemma form."""
        if donor not in self.Vset:
            die(f"--donor : « {donor} » est absent du vocabulaire réduit "
                f"'{self.lang}' (aucun vecteur à emprunter).")
        if not self.shared_lemmas(word, donor):
            die(f"--donor : « {donor} » ne partage aucun lemme avec « {word} » ; "
                f"donneurs valides : {', '.join(self.candidates(word)) or 'aucun'}.")

    def start_display_error(self, start, display):
        """Why `display` cannot stand in for the start word `start` — None when it can.

        The MIRROR of a donor pair (#119 addendum): a borrowed secret keeps the
        sentence's form over the donor's vector, and an overridden start keeps the
        sentence's form over the band word's rank. Both ask the same two questions of
        the substitute, so both answer them the same way — a form of the SAME word
        (lemma table, bridged through slug siblings for a form the table does not know),
        and typable, i.e. its slug is in the existence set. Showing the player a hint
        they could never type would break the game's own rule that a displayed clue's
        distance is already known."""
        if not set(self.lemmas_for(display)) & set(self.lemmas_for(start)):
            return (f"« {display} » n'est pas une forme de « {start} » "
                    f"(aucun lemme commun).")
        if not self.typable(display):
            return (f"« {display} » ne se trouve dans aucun mot du vocabulaire réduit "
                    f"'{self.lang}' (slug '{slug(display)}') : le joueur ne pourrait "
                    f"jamais taper l'indice affiché.")
        return None

    def resolved(self, word):
        """The donor already KNOWN for `word` — itself when it has a vector, an
        earlier choice, or a validated --donor pair — else None. Never prompts, so
        the raw-mode selector can call it on every hover."""
        if word in self.Vset:
            return word
        key = slug(word)
        if key in self._chosen:
            return self._chosen[key]
        donor = self.explicit.get(key)
        if donor is None:
            return None
        self._validate(word, donor)
        return self.choose(word, donor)

    def donor_lines(self, word, cands):
        """The numbered donor listing, shared by the prompt and the selector."""
        freq = self.freq_index
        lines = []
        for i, form in enumerate(cands, 1):
            place = freq.get(form)
            place = f", fréq #{place + 1}" if place is not None else ""
            marker = "   ← suggéré" if i == 1 else ""
            lines.append(f"{i:>3}) {form}  (édition {edit_distance(word, form)}{place}){marker}")
        return lines

    def choose_donor(self, word, cands):
        """Ask which same-lemma form lends its vector (TTY only, mirrors choose_start).

        Enter accepts the suggestion, a number picks another candidate, an exact
        candidate spelling is accepted too. A closed stdin falls back to the
        suggestion, like choose_start — the substitution is printed either way."""
        print(f"\n« {word} » n'a pas de vecteur. Formes du même lemme présentes "
              f"dans l'embedding :")
        for line in self.donor_lines(word, cands):
            print("  " + line)
        while True:
            try:
                raw = input(f"Donneur [{cands[0]}] > ").strip().lower()
            except EOFError:  # stdin closed mid-prompt: keep the suggestion.
                return cands[0]
            if not raw:
                return cands[0]
            if raw.isdigit():
                idx = int(raw)
                if 1 <= idx <= len(cands):
                    return cands[idx - 1]
                print(f"  Numéro hors liste (1–{len(cands)}).")
                continue
            if raw in cands:
                return raw
            print(f"  « {raw} » n'est ni un numéro ni un donneur proposé.")

    def donor_for(self, word):
        """The vector source for `word`, resolving the question if it is still open.

        Called where the hole is about to be built, so the answer is also marked as
        USED. Dies rather than guess: no candidate, an untypable secret, or a batch run
        without --donor are all hard errors. Callers holding richer context (the
        --words path knows the raw selector) may pre-empt the no-candidate case."""
        if word in self.Vset:
            return word
        cands = self.candidates(word)
        if not cands:
            die(f"« {word} » est absent du vocabulaire réduit '{self.lang}' et aucune "
                f"forme de son lemme n'y figure : aucun vecteur à emprunter.")
        if not self.typable(word):
            die(f"« {word} » est absent du vocabulaire réduit '{self.lang}' et son slug "
                f"'{slug(word)}' ne s'y trouve pas non plus : aucun mot réduit ne s'y "
                f"replie, le joueur ne pourrait jamais taper ce secret.")
        donor = self.resolved(word)
        if donor is not None:
            return self.note_used(word, donor)
        if self.interactive:
            return self.note_used(word, self.choose(word, self.choose_donor(word, cands)))
        die(f"« {word} » n'a pas de vecteur dans l'embedding réduit '{self.lang}'.\n"
            f"         Formes du même lemme disponibles : {', '.join(cands)}\n"
            f"         Hors mode interactif le donneur doit être explicite : "
            f"--donor {word}={cands[0]}")


def _make_hole(secret, prefix, suffix, pos, start_display, start_rank):
    """Assemble one hole dict from a chosen secret + start word.

    prefix/suffix are the display-only affixes around the blank (a leading clitic /
    punctuation); omitted when empty so a hole with no affixes stays byte-compatible.
    Shared by the --words path and the interactive selector, so the hole schema is
    written in exactly one place."""
    hole = {
        "pos": pos,
        "secret": ws(secret),
        "start": ws(start_display),
        "start_rank": start_rank,
    }
    if prefix:
        hole["prefix"] = prefix
    if suffix:
        hole["suffix"] = suffix
    return hole


def build_lang_vocab(kv, cfg):
    """Return the full reduced vocabulary via the configured neighbor module."""
    return cfg["module"].build_vocab(kv)


def choose_start(secret, ranking, rank_map, rank_by_display):
    """Pick the start (hint) word for ONE hole, interactively when on a terminal.

    The random default is exactly what pick_start would choose, so nothing about
    the rank-band selection itself changes. When stdin is a TTY, the rank-band
    candidates are printed as a numbered list (each with its rank) and one line is
    read:
      - empty (Enter)  -> the random default — keeps batch / non-interactive runs
        working without any input;
      - a list number  -> that candidate;
      - any other word -> accepted only if it is in this hole's rank map (i.e. it
        survived into V / the secret's ranking), matched by slug; else reprompt.

    Returns a DISPLAY word that is a key of rank_by_display, so start_rank and the
    {word, slug} object built downstream stay exactly as before.
    """
    default = pick_start(secret, ranking)

    # No terminal attached (piped stdin / batch generation): keep the random
    # default silently, so automated runs never block on input().
    if not sys.stdin.isatty():
        return default

    band = start_band(secret, ranking)
    print(f"\nMot de départ pour « {secret} » "
          f"(Entrée = {default}^-{rank_by_display[default]}) :")
    for i, (w, _r) in enumerate(band, 1):
        print(f"  {i}) {w}  ^-{rank_by_display[w]}")

    while True:
        try:
            raw = input("> ").strip()
        except EOFError:  # stdin closed mid-prompt: fall back to the default.
            return default
        if not raw:
            return default
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(band):
                return band[idx - 1][0]
            print(f"  Numéro hors liste (1–{len(band)}).")
            continue
        # Arbitrary typed word: accept only if it is in this hole's rank map.
        entry = rank_map.get(slug(raw))
        if entry is not None:
            return entry["word"]
        print(f"  « {raw} » n'est ni un numéro ni un mot du vocabulaire de ce trou.")


# --- Start-word display override (#119 addendum) --------------------------------
# The MIRROR of the borrowed secret. The rank band can only offer a word that HAS a
# vector, but the sentence's grammar may demand an inflection the embedding lacks: in
# « tu t'___ » the hint has to read "amuses", and only "amuse" has a vector. The hint is
# shown to the player, so it must be grammatically right in context — the DISPLAY form is
# therefore overridable, and nothing else is: start_rank and the whole geometry stay
# those of the chosen band word, exactly as if no question had been asked.

def choose_start_display(start, start_rank, donors, default=None):
    """Ask which FORM of the chosen start word the hole displays (TTY only).

    Enter keeps `default` — the band word, or what the agreement pass already made of
    it (#119 addendum 2), which is why the default is passed in rather than assumed.
    Any other answer is validated like a donor pair (start_display_error): a form of the
    same word, and typable. Validation is always against the BAND word, not the default:
    an override replaces the automatic agreement, it does not build on it. A rejected
    answer prints why and asks again rather than dying — the start word is already
    chosen, so there is nothing to unwind.

    Without a resolver (no lemma knowledge to validate against) or off a terminal the
    default stands — batch runs keep their silent random start, unchanged."""
    default = default or start
    if donors is None or not sys.stdin.isatty():
        return default
    while True:
        try:
            raw = input(f"Mot de départ : {start} (rang {start_rank}). "
                        f"Forme affichée [{default}] > ").strip().lower()
        except EOFError:  # stdin closed mid-prompt: keep the default.
            return default
        if not raw or raw == default:
            return default
        problem = donors.start_display_error(start, raw)
        if problem is None:
            return raw
        print("  " + problem)


def alias_start_display(rank_map, start, display, start_rank):
    """Make an OVERRIDDEN start form typable at its own slug, at the band word's rank.

    The hole shows `display` while the map is keyed on the band word, so without this
    key typing the very word printed in the hole could read MISS — which contradicts the
    rule that a displayed clue's distance is already known. Same slug as the band word
    (an accent-only override): the entry is already there, nothing to add. Otherwise
    build_merged_rank_map's smallest-rank collision rule applies unchanged —
    an existing closer entry keeps the key, and typing the hint still reads its true
    (closer) distance rather than a MISS.

    The new key is an alias of the band word's GROUP, so it inherits that group's `dq`
    (#115) like any other alias — without it the departure would carry a rank but no
    position, and a consumer plotting the neighborhood would drop the one stop the hole
    actually shows."""
    s = slug(display)
    if s == slug(start):
        return rank_map
    existing = rank_map.get(s)
    if existing is None or start_rank < existing["rank"]:
        band = rank_map.get(slug(start), {})
        entry = {"word": display, "rank": start_rank}
        if "dq" in band:
            entry["dq"] = band["dq"]
        rank_map[s] = entry
    return rank_map


# --- Display agreement (#119 addendum 2, whole-vocabulary since #133) ------------
# The start word is only the FIRST word a hole shows. Every improving guess replaces it,
# and each replacement arrives in its dictionary form: « tu t'___ » renders "t'distraire"
# where the sentence wants "t'distrais". So the whole run should agree, not just its
# first frame.
#
# The set to agree is the WHOLE rank map (#133) — all TOP_K groups, not just the ones
# below start_rank: a warm word's displayed form is data every consumer of the map may
# surface, and re-inflection is a table lookup, so bounding it bought nothing. Only each
# group's CANONICAL form needs rewriting, since its alias keys all point at it.
#
# The agreement target is the SECRET's own morphology (it IS the correctly inflected
# form) — and it is NEVER inferred (#133): even a single-analysis secret is confirmed
# on a TTY, and off one --form is required per secret; a 999/1000-correct inference
# silently corrupts the thousandth puzzle, where a confirmation keystroke is cheap.
# #146 transfers the usage information across every POS that can express it:
# adjectives take gender+number, nouns take number, and nominal answers prescribe
# no verb conjugation. A finite verb's stated number reaches nouns; a participle's
# gender+number can reach adjectives too. Realizing a neighbour is then a lookup in
# the committed inventory (build_forms.py, Morphalou-derived since #132 — the same
# artifact the merge walk groups by, so display and grouping cannot disagree).

def parse_form_args(pairs):
    """`--form MOT=TRAIT` / `MOT=LEXÈME/TRAIT` -> {slug(mot): (lexème|None, trait)}.

    Keyed by SLUG, like --donor: that is how a secret is identified everywhere else.
    The qualified spelling (#144) names the hole's LEXEME along with its cell — the
    only way to answer a cell that several DISTINCT playable groups still carry,
    where the plain trait identifies nothing (`--form fils=fils:nc/n:p`). Split on
    '/' because neither side ever contains one: a lexeme key is `lemma:pos` and a
    trait is ':'-separated codes. Validation against the table happens where the
    answer is SETTLED (feature_for), same as a typed trait."""
    mapping = {}
    for raw in pairs or ():
        word, sep, value = raw.partition("=")
        word, value = word.strip().lower(), value.strip().lower()
        if not sep or not word or not value:
            die(f"--form attend 'MOT=TRAIT' ou 'MOT=LEXÈME/TRAIT' (reçu : '{raw}').")
        key = slug(word)
        if not key:
            die(f"--form : '{word}' ne contient aucune lettre exploitable.")
        lexeme, slash, feature = value.rpartition("/")
        if slash and (not lexeme or not feature):
            die(f"--form attend 'MOT=LEXÈME/TRAIT' (reçu : '{raw}').")
        mapping[key] = (lexeme or None, feature if slash else value)
    return mapping


# The prompt/report vocabulary. Feature codes stay the artifact / --form contract;
# the TTY speaks morphology instead (#146), and only a remaining identity pick shows
# dictionary entries plus their complete forms.
_POS_LABELS = {"v": "verbe", "nc": "nom", "adj": "adjectif", "adv": "adverbe",
               "prep": "préposition", "conj": "conjonction", "intj": "interjection",
               "pro": "pronom", "det": "déterminant", "num": "nombre"}
_MOOD_LABELS = {"ind": "indicatif", "sub": "subjonctif", "cnd": "conditionnel",
                "imp": "impératif"}
_TENSE_LABELS = {"pre": "présent", "imp": "imparfait", "pas": "passé simple",
                 "fut": "futur"}
_GENDER_LABELS = {"m": "masculin", "f": "féminin"}
_NUMBER_LABELS = {"s": "singulier", "p": "pluriel"}


def _person_label(pn):
    """'2s' -> '2e pers. singulier'."""
    ordinal = "1re" if pn[0] == "1" else f"{pn[0]}e"
    return f"{ordinal} pers. {_NUMBER_LABELS.get(pn[1:], pn[1:])}"


def describe_feature(feature):
    """One feature code -> its French description, for the prompt and the errors.

    Falls back to the raw code for anything outside the known vocabulary — the
    description is a courtesy, never a gate."""
    parts = feature.split(":")
    try:
        if feature == CITATION_FEATURE:
            return "forme de citation (invariable)"
        if parts[0] == "n":
            return f"nom, {_NUMBER_LABELS[parts[1]]}"
        if parts[0] == "adj":
            return f"adjectif, {_GENDER_LABELS[parts[1]]} {_NUMBER_LABELS[parts[2]]}"
        if feature == "inf":
            return "infinitif"
        if parts[0] == "par":
            if parts[1] == "pre":
                return "participe présent"
            return (f"participe passé, {_GENDER_LABELS[parts[2]]} "
                    f"{_NUMBER_LABELS[parts[3]]}")
        return (f"{_MOOD_LABELS[parts[0]]} {_TENSE_LABELS[parts[1]]}, "
                f"{_person_label(parts[2])}")
    except (KeyError, IndexError):
        return feature


@dataclass(frozen=True)
class Morphology:
    """The usage-level answer transferred across paradigms (#146).

    `feature` is populated only for a verb: conjugation remains its whole cell.
    Nominals share gender+number; nouns consume only number and adjectives consume
    both. A noun cell itself carries no gender, so the TTY's author answer supplies
    it without changing the artifact or --form cell vocabulary."""

    family: str
    gender: str | None = None
    number: str | None = None
    feature: str | None = None


_PROMPT_BACK = object()


def morphology_from_feature(feature):
    """One stored/CLI cell -> the morphology it states (never more).

    A noun `n:p` states plural but no gender; an off-TTY --form therefore transfers
    number to nouns and honestly leaves adjective gender unspecified. The TTY adds
    the author's explicit gender to that same source cell. Verb cells retain their
    exact conjugation while exposing any number/gender they genuinely contain for
    cross-POS transfer."""
    if feature is None:
        return None
    parts = feature.split(":")
    if feature == CITATION_FEATURE:
        return Morphology("citation")
    if parts[0] == "n" and len(parts) == 2:
        return Morphology("nominal", number=parts[1])
    if parts[0] == "adj" and len(parts) == 3:
        return Morphology("nominal", gender=parts[1], number=parts[2])
    gender = number = None
    if parts[0] == "par" and len(parts) == 4 and parts[1] == "pas":
        gender, number = parts[2], parts[3]
    elif len(parts) >= 3 and re.fullmatch(r"[123][sp]", parts[-1]):
        number = parts[-1][1]
    return Morphology("verb", gender=gender, number=number, feature=feature)


def describe_morphology(morphology):
    """A morphology answer in the prompt's usage-level vocabulary."""
    if morphology.family == "nominal":
        parts = []
        if morphology.gender is not None:
            parts.append(_GENDER_LABELS.get(morphology.gender, morphology.gender))
        if morphology.number is not None:
            parts.append(_NUMBER_LABELS.get(morphology.number, morphology.number))
        return " ".join(parts) or "nominal (genre et nombre non précisés)"
    if morphology.family == "verb" and morphology.feature is not None:
        return describe_feature(morphology.feature)
    if morphology.family == "citation":
        return "forme de citation (invariable)"
    return "morphologie non précisée"


def describe_lexeme(key, table=None):
    """An opaque group key in curator-facing prose.

    With #146 metadata, describe every source paradigm a merged word carries rather
    than trusting the canonical key's suffix. The fallback keeps hand-built English
    and unit-test tables readable."""
    members = getattr(table, "members", {}).get(key, ()) if table is not None else ()
    if not members:
        lemma, _sep, pos = key.rpartition(":")
        label = _POS_LABELS.get(pos)
        return f"{lemma} ({label})" if label else key
    parsed = [member.rpartition(":") for member in members]
    lemmas = list(dict.fromkeys(lemma for lemma, _sep, _pos in parsed))
    poses = list(dict.fromkeys(pos for _lemma, _sep, pos in parsed))
    labels = [_POS_LABELS.get(pos, pos) for pos in poses]
    head = " / ".join(lemmas)
    return f"{head} ({' + '.join(labels)})" if labels else head


def describe_group_forms(key, table):
    """`fil : fil, fils` — the evidence shown for a real remaining identity pick."""
    members = getattr(table, "members", {}).get(key, ())
    lemmas = list(dict.fromkeys(member.rpartition(":")[0] for member in members))
    if not lemmas:
        lemmas = [key.rpartition(":")[0] or key]
    forms = getattr(table, "group_forms", {}).get(key, ())
    return f"{' / '.join(lemmas)} : {', '.join(forms) or 'aucune forme'}"


def load_form_table(lang, disabled=False):
    """Load the agreement views of the word-group inventory for a language.

    A language with no inventory (en — see FORM_LANGS) has no agreement pass at all:
    that is a decided non-goal, so it returns None silently rather than erroring. For
    a language that HAS one, a missing file is a hard error like the hors-dico
    wordlist (_load_lexicon, shared with the grouping so the file is parsed once);
    --no-inflect opts out explicitly and reproduces agreement-free output exactly.
    Loaded eagerly, before the vectors, so a missing or corrupt table fails fast —
    deferring the parse would buy nothing: deciding whether a secret is even a verb
    reads the table, so every fr run consults it on its first hole anyway."""
    if disabled or lang not in FORM_LANGS:
        return None
    return _load_lexicon(lang)


class FormResolver:
    """Decide the form a hole's displayed words agree with, and apply it.

    Every question is asked at most once per secret slug (`_chosen`), and every hole
    that was actually rewritten is recorded in `used` so the run can report it — the
    agreement is as visible in the preview as a borrowed vector is."""

    def __init__(self, table, explicit=None, interactive=False, typable=None):
        self.table = table
        # A plain-trait entry (the pre-#144 shape, still what tests and callers may
        # hand over) is an UNQUALIFIED answer: normalize to the (lexeme|None, trait)
        # pairs parse_form_args produces.
        self.explicit = {key: value if isinstance(value, tuple) else (None, value)
                         for key, value in (explicit or {}).items()}
        self.interactive = interactive
        # Reduced-vocabulary outcome equivalence (#146). Main passes the donor
        # resolver's slug-aware predicate; defaulting to "all forms typable" keeps
        # isolated table tests conservative (they collapse only truly equal sets).
        self._typable = typable or (lambda _word: True)
        self.used = {}     # secret slug -> (secret, feature, morphology, rewrite count)
        # both #134 reports carry the secret's DISPLAY form (the slug is only the
        # dedupe key — printing it would strip the very accents the pass is about):
        self.fallbacks = {}   # secret slug -> (secret, [(rank, canonical)]) — the *
        self.collisions = {}  # secret slug -> (secret, declined-rewrite count)
        # every secret slug the run settled a form for — --form keys outside it named
        # a word no hole used, which is nearly always a typo worth surfacing.
        self._chosen = {}  # secret slug -> feature or None
        # the lexeme the run's answer NAMED (#144: a numbered prompt pick or a
        # qualified --form), or None when the answer was a bare trait — then
        # confirmed_lexeme keeps its fail-closed unique-owner rule.
        self._claimed = {}  # secret slug -> lexeme key or None
        # Usage-level answer behind the per-POS feature. A noun's stored `n:p`
        # cannot carry lexical gender, so the TTY records the author's m/f choice
        # here without changing the artifact / --form vocabulary (#146).
        self._morphology = {}  # secret slug -> Morphology or None

    @property
    def answered(self):
        """The secret slugs this run actually settled a form for."""
        return frozenset(self._chosen)

    def analyses_of(self, word):
        """Every analysis of a surface, every POS: ((feature, lexeme key), ...).

        Duplicate entries have already merged in the artifact (#146), so repeated
        dictionary filings no longer appear here. A genuinely distinct remaining
        group still gets its own pair, but the TTY first collapses these pairs into
        usage-level morphology and asks for group identity only when their TYPABLE
        outcomes differ. Deliberately UNGATED: the sentence's human author remains
        the authority for a rarer reading."""
        if self.table is None:
            return ()
        pairs = []
        for key, feat in self.table.entries.get(word, ()):
            if (feat, key) not in pairs:
                pairs.append((feat, key))
        return tuple(sorted(pairs))

    def features_of(self, word):
        """The features a surface can carry, every POS, sorted. See analyses_of."""
        return tuple(dict.fromkeys(feat for feat, _key in self.analyses_of(word)))

    def confirmed_lexeme(self, secret):
        """The opaque group the settled answer names, or None when it names none.

        The method keeps its pre-#146 name because `--form` still calls the opaque
        identifier LEXÈME, but the returned key may now carry several source entries.

        This is what pulls the #133 question ahead of the walk (secret_claim calls
        it before any ranking): feature_for prompts on a TTY, reads --form off one,
        or dies — its normal contract, just earlier. An answer that NAMED its
        group (#144: an identity pick, or the qualified --form
        MOT=LEXÈME/TRAIT) is the claim outright. A bare trait keeps the fail-closed
        rule: it identifies a playable outcome only when exactly ONE remains after
        #146's typable-key collapse. A cell shared by distinct outcomes («fils» :
        n:p) or a trait outside the analyses (the warned case) identifies nothing,
        and the caller falls back to the surface-derived claim — never guessed."""
        feature = self.feature_for(secret)
        if feature is None or self.table is None:
            return None
        named = self._claimed.get(slug(secret))
        if named is not None:
            return named
        choices = self._owner_choices(secret, feature)
        return choices[0][0] if len(choices) == 1 else None

    def realize_cell(self, lexeme, feature):
        """Every spelling of an opaque group at one stored cell, preferred first.

        `feature` itself belongs to one POS; `target_features` separately decides
        which cells each group can express from the cross-POS #146 morphology.
        A citation-form target (`cit`) prescribes nothing to anyone.

        Keyed by the opaque GROUP (#134/#146), not by its surface: the walk already
        settled WHAT each group is, so there is nothing left to gate or arbitrate —
        the old surface-side `dom` gate and multi-lexeme refusal answered a
        question ("what is this word?") that no longer arises here. «durent» never
        heads a group anymore; durer:v and devoir:v each realize their own cells.

        A paradigm can spell one cell more than one way ("déblaies" / "déblayes"), so
        this returns the list rather than the winner: the caller knows which spellings
        a player could actually type, and this does not."""
        if self.table is None or feature_pos(feature) is None:
            return ()
        return self.table.realize.get((lexeme, feature), ())

    def group_poses(self, lexeme):
        """The paradigms an opaque #146 group carries, from explicit metadata."""
        if self.table is None:
            return frozenset()
        return getattr(self.table, "group_pos", {}).get(lexeme, frozenset())

    def group_forms(self, lexeme):
        """Every dictionary form of one group, for outcome equivalence / evidence."""
        if self.table is None:
            return ()
        forms = getattr(self.table, "group_forms", {}).get(lexeme)
        if forms is not None:
            return forms
        return tuple(sorted({form for (key, _feature), candidates
                             in self.table.realize.items() if key == lexeme
                             for form in candidates}))

    def _outcome(self, lexeme):
        """The playable key set a claim would add; differences outside vocab vanish."""
        return frozenset(slug(form) for form in self.group_forms(lexeme)
                         if self._typable(form) and slug(form))

    def _collapse_owners(self, owners):
        """Collapse group picks whose typable outcomes are exactly identical (#146).

        Returns `(representative, members)` entries, deterministically ordered. The
        representative is only an authoring claim shortcut: every member adds the
        same playable keys, so choosing it cannot change what solves."""
        by_outcome = {}
        for owner in sorted(set(owners)):
            by_outcome.setdefault(self._outcome(owner), []).append(owner)
        return tuple((members[0], tuple(members))
                     for _outcome, members in sorted(
                         by_outcome.items(), key=lambda item: item[1][0]))

    def _owner_choices(self, secret, feature):
        owners = [key for key, feat in self.table.entries.get(secret, ())
                  if feat == feature]
        return self._collapse_owners(owners)

    def morphology_for(self, secret):
        """The settled usage-level answer, prompting/validating exactly once."""
        self.feature_for(secret)
        return self._morphology.get(slug(secret))

    def target_features(self, lexeme, morphology):
        """Cells this group's paradigms can use from the author's answer (#146).

        Nominal morphology crosses noun/adjective boundaries: adjectives express
        gender+number, nouns express number. When one merged group carries both,
        the adjective target deliberately comes first because it consumes the more
        specific answer; the number-only noun target is its fallback. It prescribes
        no verb conjugation.
        A verb answer keeps its exact verb cell and — the issue's open sub-decision,
        resolved here in favour of useful stated information — lends NUMBER to nouns;
        a past participle also lends its stated gender+number to adjectives. No
        feature is guessed when the verb cell does not contain it."""
        if morphology is None or self.table is None:
            return ()
        poses = self.group_poses(lexeme)
        targets = []
        if morphology.family == "nominal":
            if ("adj" in poses and morphology.gender is not None
                    and morphology.number is not None):
                targets.append(f"adj:{morphology.gender}:{morphology.number}")
            if "nc" in poses and morphology.number is not None:
                targets.append(f"n:{morphology.number}")
        elif morphology.family == "verb":
            if "v" in poses and morphology.feature is not None:
                targets.append(morphology.feature)
            if ("adj" in poses and morphology.gender is not None
                    and morphology.number is not None):
                targets.append(f"adj:{morphology.gender}:{morphology.number}")
            if "nc" in poses and morphology.number is not None:
                targets.append(f"n:{morphology.number}")
        return tuple(targets)

    def realize_features(self, lexeme, features):
        """Preferred, deduped spellings in target priority order.

        `apply` takes the first typable spelling, so preserving `target_features`
        order is what makes a merged noun/adjective group prefer the more specific
        adjective agreement before its number-only noun fallback.
        """
        forms = []
        for feature in features:
            for form in self.realize_cell(lexeme, feature):
                if form not in forms:
                    forms.append(form)
        return tuple(forms)

    def _analysis_lines(self, analyses):
        """Raw stored/CLI analyses for errors and the rare identity evidence."""
        return [f"{i:>3}) {feature}  — {describe_feature(feature)} "
                f"({describe_group_forms(key, self.table)})"
                for i, (feature, key) in enumerate(analyses, 1)]

    @staticmethod
    def _morphology_sort_key(morphology):
        family = {"nominal": 0, "verb": 1, "citation": 2}.get(
            morphology.family, 9)
        gender = {"m": 0, "f": 1, None: 2}.get(morphology.gender, 3)
        number = {"s": 0, "p": 1, None: 2}.get(morphology.number, 3)
        return family, gender, number, morphology.feature or ""

    def _morphology_choices(self, analyses):
        """Usage-level options -> the raw pairs each option can represent.

        Noun cells deliberately expand to both genders: noun gender is lexical but
        the artifact's `n:s`/`n:p` cells do not carry it, and #146 says the human
        answer supplies it. Adjective/noun pairs then collapse onto the same nominal
        choice when their gender+number agree; verb conjugations remain distinct, so
        «pensée» still distinguishes the noun/adjective reading from the participle."""
        choices = {}
        for feature, key in analyses:
            morphology = morphology_from_feature(feature)
            variants = (morphology,)
            if (morphology is not None and morphology.family == "nominal"
                    and morphology.gender is None):
                variants = tuple(Morphology("nominal", gender, morphology.number)
                                 for gender in ("m", "f"))
            for variant in variants:
                choices.setdefault(variant, []).append((feature, key))
        return tuple((morphology, tuple(choices[morphology]))
                     for morphology in sorted(choices,
                                              key=self._morphology_sort_key))

    @staticmethod
    def _feature_preference(feature):
        # A merged noun/adjective word uses its noun cell as the stable source code;
        # morphology carries the author's gender separately. This keeps the stored
        # vocabulary honest without reintroducing the POS question the merge removed.
        if feature.startswith("n:"):
            return 0, feature
        if feature.startswith("adj:"):
            return 1, feature
        return 2, feature

    def _identity_choices(self, analyses):
        """Distinct playable outcomes for one selected morphology.

        Several raw pairs for one group (merged noun + adjective), and several
        groups whose every DIFFERING form is outside the reduced vocabulary, become
        one pick. A remaining pick carries the representative group plus the source
        cell used for --form/report compatibility."""
        per_owner = {}
        for feature, owner in analyses:
            per_owner.setdefault(owner, []).append(feature)
        choices = []
        for representative, equivalent in self._collapse_owners(per_owner):
            features = per_owner[representative]
            feature = min(features, key=self._feature_preference)
            choices.append((representative, feature, equivalent))
        return tuple(choices)

    def _prompt_identity(self, secret, morphology, analyses):
        """Ask only when dictionary distinctions change typable solve keys.

        Returns `_PROMPT_BACK` when the curator wants to revise the preceding
        usage-level morphology instead of declining agreement for the whole run.
        """
        choices = self._identity_choices(analyses)
        if len(choices) == 1:
            key, feature, _equivalent = choices[0]
            return feature, key, morphology

        print(f"\nSens de « {secret} » — les formes indiquent ce qui résoudra le trou :")
        for i, (key, feature, _equivalent) in enumerate(choices, 1):
            print(f"  {i:>3}) {feature}  — {describe_feature(feature)} "
                  f"({describe_group_forms(key, self.table)})")
        while True:
            try:
                raw = input(f"Sens [numéro (1–{len(choices)}), trait libre, "
                            "? = tous les traits, r = retour, "
                            "0 = aucun accord] > ").strip()
            except EOFError:
                return None, None, None
            if raw == "r":
                return _PROMPT_BACK
            if raw == "0":
                return None, None, None
            if raw == "?":
                for feature in sorted(self.table.features):
                    print(f"  {feature}")
                continue
            if raw.isdigit():
                idx = int(raw)
                if 1 <= idx <= len(choices):
                    key, feature, _equivalent = choices[idx - 1]
                    return feature, key, morphology
                print(f"  Numéro hors liste (1–{len(choices)}).")
                continue
            if raw in self.table.features:
                # Free text is the table-incomplete escape. It intentionally names
                # no group; confirmed_lexeme applies the same fail-closed outcome
                # rule as before.
                return raw, None, morphology_from_feature(raw)
            print(f"  « {raw} » n'est ni un numéro ni un trait connu.")

    def _prompt(self, secret):
        """Ask the sentence's morphology, then only a REAL remaining identity.

        Returns `(stored feature, named opaque group, Morphology)`. EVERY secret
        asks (#133): a single usage-level option is shown and confirmed with Enter;
        several gender/number/conjugation options require a number. Duplicate POS
        entries never appear. If the chosen morphology still spans groups with
        different typable form families, `_prompt_identity` shows those families.

        A typed feature remains the «sors» table-incomplete escape and names no
        group. Unknown surfaces accept the same free text. `0` declines; `?` lists
        the stored cell vocabulary; `r` at the identity step returns to morphology;
        closed stdin never confirms."""
        analyses = self.analyses_of(secret)
        if analyses:
            choices = self._morphology_choices(analyses)
            print(f"\nMorphologie de « {secret} » dans la phrase :")
            for i, (morphology, _pairs) in enumerate(choices, 1):
                print(f"  {i:>3}) {describe_morphology(morphology)}")
            if len(choices) == 1:
                hint = (f"Entrée = confirmer {describe_morphology(choices[0][0])}, "
                        f"trait libre, "
                        f"? = tous les traits, 0 = aucun accord")
            else:
                hint = (f"numéro (1–{len(choices)}), trait libre, "
                        f"? = tous les traits, 0 = aucun accord")
        else:
            print(f"\n« {secret} » n'a pas de forme connue dans la table.")
            choices = ()
            hint = ("trait libre (ex. ind:pre:2s), ? = tous les traits, "
                    "Entrée = aucun accord")
        while True:
            try:
                raw = input(f"Morphologie [{hint}] > ").strip()
            except EOFError:  # stdin closed mid-prompt: decline, never confirm.
                return None, None, None
            if not raw:
                if len(choices) == 1:
                    morphology, pairs = choices[0]
                    resolved = self._prompt_identity(secret, morphology, pairs)
                    if resolved is _PROMPT_BACK:
                        print("  Retour au choix de morphologie.")
                        continue
                    return resolved
                if not analyses:
                    return None, None, None  # nothing to confirm: no agreement
                print(f"  Plusieurs morphologies : choisis un numéro "
                      f"(1–{len(choices)}) ou un trait (0 = aucun accord).")
                continue
            if raw == "0":
                return None, None, None  # explicit decline, in every case
            if raw == "?":
                for feature in sorted(self.table.features):
                    print(f"  {feature}")
                continue
            if raw.isdigit() and choices:
                idx = int(raw)
                if 1 <= idx <= len(choices):
                    morphology, pairs = choices[idx - 1]
                    resolved = self._prompt_identity(secret, morphology, pairs)
                    if resolved is _PROMPT_BACK:
                        print("  Retour au choix de morphologie.")
                        continue
                    return resolved
                print(f"  Numéro hors liste (1–{len(choices)}).")
                continue
            if raw in self.table.features:
                return raw, None, morphology_from_feature(raw)
            print(f"  « {raw} » n'est pas un trait connu (? pour la liste).")

    def feature_for(self, secret):
        """The form this hole's displayed words must agree with, or None for no pass.

        NEVER inferred (#133): the script does not read the answer off the table,
        however unambiguous — a silent wrong pick corrupts a puzzle, a confirmation
        keystroke is cheap. --form settles it without a question (both on and off a
        TTY); otherwise a TTY always asks (see _prompt), and OFF a TTY the missing
        --form is a hard error — no prompt ever blocks a batch run, and no batch run
        ever guesses. --no-inflect is the explicit opt-out that reproduces
        agreement-free output byte for byte. Asked at most once per secret slug;
        None (a declined agreement) is an answer and is cached like one.

        A settled trait OUTSIDE the secret's listed analyses is a WARNING, not an
        error — deliberately, on both counts. The table can be incomplete for the
        surface while right about the cell («sors» carries no ind:pre:1s analysis,
        one of the pinned Morphalou holes, yet « je sors » is exactly that trait),
        so refusing would make such a sentence un-authorable; but when analyses
        exist, an unlisted trait is nearly always a typo, so it is said out loud.
        Checked here rather than in the --form parse so a trait typed at the prompt
        gets the same scrutiny as a flag."""
        if self.table is None:
            return None
        key = slug(secret)
        if key in self._chosen:
            return self._chosen[key]
        named, feature = self.explicit.get(key, (None, None))
        morphology = morphology_from_feature(feature)
        if feature is not None and feature not in self.table.features:
            die(f"--form : « {feature} » n'est pas un trait connu de la table des "
                f"formes (« {secret} »).")
        if named is not None:
            self._check_named_claim(secret, named, feature)
        elif feature is not None:
            # #144: a plain --form trait carried by several of the secret's lexemes
            # answers the cell but not the claim — a hard error, never a guess, on
            # and off a TTY alike (--form's contract is to settle without a
            # question). The prompt path stays fail-closed instead: a typed bare
            # trait claims nothing.
            owners = self._owner_choices(secret, feature)
            if len(owners) > 1:
                keys = [representative for representative, _equivalent in owners]
                spellings = " ou ".join(f"--form {secret}={k}/{feature}"
                                        for k in keys)
                die(f"--form : « {feature} » est porté par plusieurs lexèmes de "
                    f"« {secret} » "
                    f"({', '.join(describe_lexeme(k, self.table) for k in keys)}) — le "
                    f"trait seul ne nomme pas le lexème (#144). "
                    f"Précise : {spellings}.")
        if feature is None:
            if not self.interactive:
                analyses = self.analyses_of(secret)
                listing = "\n".join("         " + line
                                    for line in self._analysis_lines(analyses))
                example = ""
                if analyses:
                    # The example must be RUNNABLE: a shared cell's plain trait
                    # would itself die as ambiguous, so it shows qualified (#144).
                    # Outcome-identical owners have already collapsed (#146), so
                    # they correctly keep the plain spelling.
                    feat0, key0 = analyses[0]
                    shared = len(self._owner_choices(secret, feat0)) > 1
                    spelt = f"{key0}/{feat0}" if shared else feat0
                    example = f" — ex. --form {secret}={spelt}"
                die(f"la forme de « {secret} » doit être explicite hors mode "
                    f"interactif (#133 : jamais déduite, même sans ambiguïté).\n"
                    + (f"         Analyses connues :\n{listing}\n" if analyses
                       else "         Aucune analyse connue dans la table.\n")
                    + f"         Passe --form {secret}=TRAIT (ou "
                    f"{secret}=LEXÈME/TRAIT pour un trait partagé){example} — ou "
                    f"--no-inflect pour désactiver l'accord.")
            feature, named, morphology = self._prompt(secret)
        if feature is not None:
            if named is not None:
                # A NAMED claim narrows the check to the pair: another lexeme
                # listing the same cell must not mask the mismatch (`fils=
                # fil:nc/n:s` is unlisted for fil:nc even though fils:nc carries
                # n:s), or a typo silently claims a hole for the wrong word.
                listed = tuple(f for k, f in self.table.entries.get(secret, ())
                               if k == named)
                if feature not in listed:
                    print(f"  attention : « {feature} » n'est aucune des analyses "
                          f"connues de « {secret} » pour "
                          f"« {describe_lexeme(named, self.table)} » "
                          f"({', '.join(listed)}) — "
                          f"accord appliqué quand même (table incomplète, ou "
                          f"faute de frappe ?).", file=sys.stderr)
            else:
                known = self.features_of(secret)
                if known and feature not in known:
                    print(f"  attention : « {feature} » n'est aucune des analyses "
                          f"connues de « {secret} » ({', '.join(known)}) — accord "
                          f"appliqué quand même (table incomplète, ou faute de "
                          f"frappe ?).", file=sys.stderr)
        self._chosen[key] = feature
        self._claimed[key] = named if feature is not None else None
        self._morphology[key] = morphology if feature is not None else None
        return feature

    def _check_named_claim(self, secret, named, feature):
        """Refuse a qualified --form whose opaque group cannot be the claim.

        The named group must be one the table already analyses the SURFACE as (any
        cell — the «sors» pinned hole means the exact cell may be missing while the
        group is right, so an unlisted (group, trait) pair only has to match one of
        the group's POSes and rides the ordinary warning). Naming a group
        the surface never realizes would claim the hole for a stranger — typing its
        inflections would SOLVE a hole they don't answer — so that is a hard error,
        not a warning."""
        keys = sorted({k for k, _feat in self.table.entries.get(secret, ())})
        if named not in keys:
            listing = ", ".join(describe_lexeme(k, self.table) for k in keys) or "aucune"
            die(f"--form : « {named} » n'est pas une analyse connue de "
                f"« {secret} » (analyses : {listing}).")
        if ((named, feature) not in
                {(k, f) for k, f in self.table.entries.get(secret, ())}
                and feature_pos(feature) not in self.group_poses(named)):
            die(f"--form : le trait « {feature} » n'est pas une cellule du "
                f"paradigme de « {describe_lexeme(named, self.table)} ».")

    def apply(self, rank_map, secret, donors, *, lexemes):
        """Re-inflect every group's canonical to the secret's form.

        The scope is the WHOLE map (#133) — every group, not just the ones a hole
        can reach from its start rank: a group's displayed form is data wherever the
        map is consumed, and the lookup costs nothing. Rank 0 is skipped because it
        already holds the true sentence form. A group is left alone whenever its
        canonical is not admitted as the feature's POS, has no such form, would
        become a word nobody could type back, or would land on a slug a CLOSER group
        already owns — that last one is the one that would otherwise print a word at
        exponent N while typing it read M < N, a clue contradicting its own distance.

        Rewriting a group means rewriting every entry that carries it, aliases included,
        so typing any form of the group displays the agreed one.

        Taking an ALIAS key from a farther group is allowed (closest-first, exactly
        how the assembly resolves collisions). Taking the CANONICAL key of a
        farther group is not: with the whole map agreed, EVERY group prints its word
        somewhere, so stealing the very slug of the word a group prints leaves it
        showing that word at exponent N while typing it reads M < N — the same
        contradiction the closer-owner rule above refuses, only reached from the
        other side. The start hint is where a live collision bites hardest, because
        start_rank is captured BEFORE this pass runs: the hole would ship
        start.word="banque" at start_rank 5 while ranks[secret]["banque"] said 2, so the
        printed hint improves its own hole. Declining keeps map and hole in step, and
        `alias_start_display` could not have repaired it (the override short-circuits on
        an unchanged slug).

        `lexemes` maps rank -> the group's lexeme key (#134): realization is keyed
        by WHAT the group is, never by how its surface reads. A rank outside the
        mapping (a table-less singleton) has no cells and keeps its representative.
        REQUIRED, precisely because a forgotten argument would be a silent no-op
        pass — the very failure mode the --no-lemmas guard exists to reject;
        an explicit None says "no cells anywhere" on purpose.
        Both #134 report counters land in `fallbacks` (groups of the feature's own
        POS whose requested form is missing or untypable — they keep their closest
        clean form, marked `*` in generation output) and `collisions` (rewrites the
        collision rules declined; closest-wins itself is unchanged)."""
        feature = self.feature_for(secret)
        morphology = self._morphology.get(slug(secret))
        if feature is None or morphology is None or donors is None:
            return {}
        lexemes = lexemes or {}
        fell, collided = [], 0
        # Snapshot both the keys and each group's canonical BEFORE rewriting anything:
        # a closer group may reclaim one of these keys on an earlier pass, and reading
        # the word back out of the map would then hand this group the other one's form.
        by_rank, canonicals = {}, {}
        for key, entry in rank_map.items():
            by_rank.setdefault(entry["rank"], []).append(key)
            canonicals.setdefault(entry["rank"], entry["word"])
        changed = {}
        for rank, keys in sorted(by_rank.items()):
            if rank == 0:
                continue
            canonical = canonicals[rank]
            lexeme = lexemes.get(rank)
            if lexeme is None:
                continue  # a table-less singleton: no cells, nothing to agree
            targets = self.target_features(lexeme, morphology)
            forms = self.realize_features(lexeme, targets)
            if canonical in forms:
                continue  # the group already IS the agreed form
            if not forms:
                if targets:
                    # The group has a paradigm that can express this morphology,
                    # but none of its requested cells exists: MISSING — keep the
                    # representative (#134's fallback), marked *.
                    fell.append((rank, canonical))
                continue
            # The artifact's preference order is by corpus frequency, which knows
            # nothing about the reduced vocabulary; take the first spelling a player
            # could actually type rather than dropping the group when the favourite
            # happens to be untypable ("déblaies" loses to "déblayes" here).
            form = next((f for f in forms if donors.typable(f)), None)
            if form is None:
                fell.append((rank, canonical))  # requested form UNTYPABLE: *
                continue
            s = slug(form)
            owner = rank_map.get(s)
            if owner is not None and owner["rank"] != rank:
                if owner["rank"] < rank:
                    collided += 1
                    continue  # a closer group owns it: decline rather than contradict it
                if s == slug(canonicals[owner["rank"]]):
                    collided += 1
                    continue  # a farther group prints it: leave its word alone
            for key in keys:
                if rank_map[key]["rank"] == rank:  # a reclaimed key belongs elsewhere now
                    rank_map[key]["word"] = form
            # The agreed spelling is one more KEY of the same group, so it inherits the
            # group's geometry (#115) like any other alias key: `dq` has no opt-out, and an
            # entry carrying a rank but no distance is one every consumer of the map reads
            # as unplottable.
            group = next((rank_map[k] for k in keys if rank_map[k]["rank"] == rank), None)
            if group is None:
                # Every key this group had has been reclaimed by a closer one on an earlier
                # pass, so the rank is no longer in the map at all. Keying the agreed form
                # would RESURRECT it — and with nothing to inherit from, without dq: a rank
                # that scores a hit in the game and carries no distance to draw it by.
                # `dq` has no opt-out, so the honest outcome is to leave the group gone.
                continue
            rank_map[s] = {**group, "word": form}
            changed[rank] = (canonical, form)
        if changed:
            self.used[slug(secret)] = (secret, feature, morphology, len(changed))
        if fell:
            self.fallbacks[slug(secret)] = (secret, fell)
        if collided:
            self.collisions[slug(secret)] = (secret, collided)
        return changed


# --- Interactive hole selector (raw-mode TUI) ----------------------------------
# When the phrase is entered on a TTY WITHOUT --words, three distinct secret groups are
# chosen with a small full-screen selector instead of typing words: the arrow keys move
# between the sentence's content words and each one's start-word candidates are previewed
# live; Enter
# picks the hovered group's occurrences, then a number picks its shared start word
# (Esc cancels). It runs ONLY
# on a terminal — --words stays the non-interactive / batch path (holes_from_words), so
# piped / CI runs are unchanged. termios/tty are imported lazily inside the selector
# because they are Unix-only and this path is never reached off a TTY.

_ESC = "\x1b"


def _sgr(codes, text):
    """Wrap text in an ANSI SGR sequence, reset-terminated (plain text on a dumb term)."""
    return f"{_ESC}[{codes}m{text}{_ESC}[0m"


def extract_candidates(words, cfg, Vset, donors=None):
    """The selectable occurrences in a sentence: for each token, its first word-core
    whose DISPLAY form is in Vset (i.e. survived reduction). Returns [{pos, secret,
    prefix, suffix}] — one entry per holeable token position.

    Apostrophes / punctuation are core separators (core_re), so "l'animal" yields cores
    "l" then "animal" and only "animal" is selectable: "l" is a single letter the
    reduction dropped, so it is absent from Vset. Because the reduction already strips
    stopwords, single letters and non-dictionary tokens from V, "core in Vset" IS the
    content-word filter — no separate stopword list is needed. Keeping only the first
    in-vocab core per token means each occurrence has one position; the selector groups
    repeated occurrences by slug so one pick consumes one distinct secret.

    With a DonorResolver (#119) a core that has no vector is ALSO selectable when a
    same-lemma form can lend it one and the secret stays typable; the selector then
    asks which form before ranking it. Without one (or when nothing qualifies) such a
    core is simply not offered, exactly as before."""
    cands = []
    for pos, token in enumerate(words):
        for m in cfg["core_re"].finditer(token):
            secret = m.group()
            if not slug(secret):
                continue
            if secret in Vset or (donors is not None and donors.eligible(secret)):
                cands.append({"pos": pos, "secret": secret,
                              "prefix": token[:m.start()], "suffix": token[m.end():]})
                break
    return cands


def max_selectable_groups(cands, lemma_table, need=3):
    """The largest number (capped at `need`) of pairwise lemma-disjoint distinct-slug
    candidates — CAN three holes be committed, in SOME order?

    A greedy sentence-order count is wrong here: a multi-lemma form encountered first
    ("portes" → porte + porter) would occupy BOTH lemmas and hide that committing
    "porte" and "porter" separately still works. Sentences hold few distinct words, so
    an exact search over combinations is exhaustive and instant. It weighs IDENTITY
    (group_lemmas' question — could these two be the same word?), not what a group
    claims in the walk, so a homograph still blocks its own family here."""
    from itertools import combinations

    by_slug = {}
    for c in cands:  # one representative per distinct slug (first occurrence)
        by_slug.setdefault(slug(c["secret"]), set(lemmas_of(c["secret"], lemma_table)))
    lemma_sets = list(by_slug.values())
    for size in range(min(need, len(lemma_sets)), 0, -1):
        for combo in combinations(lemma_sets, size):
            union = set()
            for ls in combo:
                if union & ls:
                    break
                union |= ls
            else:
                return size
    return 0


def candidates_for_slug(cands, target_slug):
    """Return every selectable occurrence belonging to one secret slug.

    Interactive selection is by distinct secret identity, not by token position: picking
    one occurrence of a repeated word commits the complete group. Keeping this grouping
    helper separate makes the selection rule explicit and contract-testable.
    """
    return [c for c in cands if slug(c["secret"]) == target_slug]


def _read_key(fd):
    """Decode one keypress from a raw-mode fd into a symbolic token.

    Returns 'LEFT'/'RIGHT'/'UP'/'DOWN', 'ENTER', 'ESC', 'BACK', or the raw character
    (a digit / letter). A lone Esc is told apart from an arrow's CSI/SS3 escape sequence
    by a short read timeout — nothing follows a lone Esc."""
    b = os.read(fd, 1)
    if b == b"\x1b":
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            return "ESC"
        seq = os.read(fd, 2)  # e.g. b"[A" (CSI) or b"OA" (SS3)
        return {b"A": "UP", b"B": "DOWN", b"C": "RIGHT", b"D": "LEFT"}.get(seq[-1:], "ESC")
    if b in (b"\r", b"\n"):
        return "ENTER"
    if b in (b"\x7f", b"\x08"):
        return "BACK"
    if b == b"\x03":
        raise KeyboardInterrupt
    return b.decode("utf-8", "ignore") or "OTHER"


def select_holes_interactive(words, cfg, lang, kv, V, M, Vset,
                             lemma_table, forms_by_lemma, donors=None, forms=None,
                             reporter=None):
    """Pick three distinct secret groups on a TTY; return holes sorted by position.

    Full-screen loop: ←/→ move between the sentence's selectable content words (see
    extract_candidates) and the hovered word's start-word band is previewed live (its
    neighbor ranking is computed once per secret slug and cached). Enter commits the
    hovered word's whole repeated-word group; its shared start word is then chosen by
    number (Enter validates, Esc cancels and returns to navigation). Three distinct
    commits end the loop; Ctrl-C aborts cleanly. The holes / ranks produced are identical
    in shape to the --words path (build_puzzle_rank_map + _make_hole are shared), so
    nothing downstream needs to know which path chose the holes.

    A word with no vector (#119) is offered when a same-lemma form can lend it one:
    committing it opens ONE extra step — the same numbered grammar, on the donor list —
    before the start-word step, and the answer is cached per secret slug so the question
    is asked once. Nothing is ranked until a donor is known, so no hover can crash. The
    picked start word then gets the same display-form question as the --words path (the
    addendum to that issue), asked as a line prompt outside raw mode.

    The #133 form confirmation is part of the COMMIT step too, asked right before
    the start band renders (#134): its answer names the hole's lexeme, which is what
    group 0 claims, so the band the author picks from is drawn on the map that
    ships. The HOVER preview deliberately runs on the provisional (surface-derived)
    claim — browsing must not open questions — so committing a homographic secret
    can shift the band slightly once its identity is confirmed."""
    import shutil
    import termios
    import tty

    cands = extract_candidates(words, cfg, Vset, donors)

    # Feasibility pre-check, on the table's own groups. A word still waiting for a donor
    # counts as its own group here — its group is only decided by that choice (#119) —
    # so this can be optimistic; taken_word below is the exact rule, and running out of
    # words mid-selection has its own error. It never refuses a workable sentence.
    selectable = max_selectable_groups(cands, lemma_table)
    if selectable < 3:
        die(f"la phrase n'offre que {selectable} mot(s) sélectionnable(s) "
            f"compatible(s) ; il en faut 3 (mots présents dans le vocabulaire réduit "
            f"'{lang}', hors mots-outils). Les occurrences répétées et les formes d'un "
            "même mot (lemme commun) ne consomment qu'une sélection.")

    # Per-secret neighbor data, computed lazily on first hover and cached: the merged
    # rank map (lemma groups collapsed, aliases expanded), the start-word band on the
    # MERGED ranks, and display->merged-rank (0 = secret).
    cache = {}

    def donor_of(secret):
        """The vector source already known for a hovered word (itself when it has one),
        or None while its donor question is still open (#119). Never prompts: that
        answer is given inside the selector, in `donor` mode."""
        return secret if donors is None else donors.resolved(secret)

    def prep(secret, donor, confirmed=False):
        """The hovered/committed word's neighborhood, built once and rebuilt only
        when its CLAIM changes: the hover preview uses the provisional
        surface-derived claim (secret_claim with no resolver — never a prompt),
        and once the commit step has confirmed the form, the same call re-merges
        from the cached raw ranking with the confirmed group claimed. The walk
        starts from the DONOR's vector; everything the puzzle keeps (rank-0 word,
        aliases, start band) stays on the true sentence form."""
        secret_slug = slug(secret)
        claim = secret_claim(secret, donor, lemma_table, donors,
                             forms if confirmed else None)
        entry = cache.get(secret_slug)
        if entry is None or entry["claim"] != claim:
            ranking = entry["ranking"] if entry is not None \
                else cfg["module"].closest(donor, kv, V, M, n=None)
            merged, rank_map, groups = build_puzzle_rank_map(
                secret, ranking, lemma_table, forms_by_lemma, Vset,
                secret_lemmas=claim)
            rbd = {secret: 0}
            for w, r, _ in merged:
                rbd.setdefault(w, r + 1)
            entry = {"ranking": ranking, "claim": claim,
                     "rank_map": rank_map, "band": start_band(secret, merged),
                     "rbd": rbd, "groups": groups}
            cache[secret_slug] = entry
        return entry

    holes = []
    ranks = {}
    used_slugs = set()
    used_lemmas = set()  # lemmas claimed by committed groups: their forms block too

    def taken_word(c):
        """A candidate is spent when its group is already holed (see spent_candidate)."""
        return spent_candidate(c["secret"], used_slugs, used_lemmas, lemma_table, donors)

    def available():
        return [i for i, c in enumerate(cands) if not taken_word(c)]

    def frame(cursor, title, cells, error):
        """One full-screen render: the sentence, then the numbered panel the current
        step is asking about (start-word band, or donor list when one is needed)."""
        cols = shutil.get_terminal_size((80, 24)).columns
        cand_pos = {c["pos"]: c for c in cands}
        out = [_sgr("1", f"  Trou {len(used_slugs) + 1}/3"),
               _sgr("2", "  ← →  mot   ·   Entrée  choisir   ·   Échap  annuler   ·   Ctrl-C  quitter"),
               ""]
        # the sentence: hovered core = reverse, taken = struck, other content words = underline.
        rendered = []
        for pos, token in enumerate(words):
            c = cand_pos.get(pos)
            if c is None:
                rendered.append(_sgr("2", token))
                continue
            pre, core, suf = c["prefix"], c["secret"], c["suffix"]
            if taken_word(c):
                rendered.append(pre + _sgr("2;9", core) + suf)
            elif pos == cands[cursor]["pos"]:
                rendered.append(pre + _sgr("7;1", core) + suf)
            else:
                rendered.append(pre + _sgr("4", core) + suf)
        out += ["  " + " ".join(rendered), ""]
        out.append(_sgr("1", title))
        if cells:
            cw = max(len(x) for x in cells) + 2
            ncols = max(1, (cols - 2) // cw)
            for i in range(0, len(cells), ncols):
                out.append("  " + "".join(x.ljust(cw) for x in cells[i:i + ncols]))
        else:
            out.append(_sgr("2", "  (aucun candidat de départ)"))
        if error:
            out += ["", _sgr("1;31", "  " + error)]
        return f"{_ESC}[H{_ESC}[2J" + "\n".join(out) + "\n"

    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)

    def confirm_form(secret):
        """The #133 confirmation, at the head of the commit step (#134): asked once
        (feature_for caches per slug), outside raw mode, BEFORE the start band
        renders — its answer names the hole's lexeme, so the band the author picks
        from is drawn on the map that ships."""
        if forms is None:
            return
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        try:
            forms.feature_for(secret)
        finally:
            tty.setcbreak(fd)

    def ask_display(secret, entry, start, start_rank):
        """Leave raw mode for the free-text questions of the flow (#119 + addendum 2).

        Navigation and both numbered picks are single keypresses, so the loop reads them
        raw; the display override is a WORD — accented, worth editing with the arrow
        keys — which is precisely what canonical mode and readline already give the
        line prompts. The next frame clears the screen, so the detour leaves nothing
        behind.

        The agreement pass runs here (the form itself was confirmed before the band,
        so feature_for answers from its cache)."""
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        try:
            agreed = forms.apply(entry["rank_map"], secret, donors,
                                 lexemes=group_lexeme_map(entry["groups"])) \
                if forms is not None else {}
            if reporter is not None:
                feature = forms.feature_for(secret) if forms is not None else None
                reporter.capture(secret, entry["groups"], entry["rank_map"], feature)
            return choose_start_display(
                start, start_rank, donors,
                default=agreed.get(start_rank, (start, start))[1])
        finally:
            tty.setcbreak(fd)

    cursor = available()[0]
    mode, numbuf, error = "nav", "", ""
    aborted = False
    try:
        tty.setcbreak(fd)
        while len(used_slugs) < 3:
            c = cands[cursor]
            secret = c["secret"]
            donor = donor_of(secret)
            numero = ("   numéro : " + _sgr("1;7", f" {numbuf or ' '} "))
            if donor is None:
                # #119: no vector for this word — the donor is chosen FIRST, with the
                # same numbered grammar. Only the donors that keep this word its own
                # group are offered, so no choice can hole a committed lemma twice.
                dcands = free_donors(secret, used_lemmas, lemma_table, donors)
                entry, band, rbd = None, [], {}
                title = f"  « {secret} » n'a pas de vecteur — formes du même lemme"
                if mode == "donor":
                    title += numero + f"  (Entrée = {dcands[0]} · Échap annuler)"
                cells = donors.donor_lines(secret, dcands)
            else:
                dcands = []
                # Confirmed once the commit step has asked (feature_for caches per
                # slug), provisional while merely hovering — see prep.
                confirmed = forms is not None and slug(secret) in forms.answered
                entry = prep(secret, donor, confirmed)
                band, rbd = entry["band"], entry["rbd"]
                title = f"  Mots de départ pour « {secret} »"
                if mode == "start":
                    title += numero + "  (Entrée valider · Échap annuler)"
                cells = [f"{i:>3}) {w} ^-{rbd[w]}" for i, (w, _r) in enumerate(band, 1)]
            sys.stdout.write(frame(cursor, title, cells, error))
            sys.stdout.flush()
            error = ""
            key = _read_key(fd)
            if mode == "nav":
                avail = available()
                ai = avail.index(cursor)
                if key in ("LEFT", "UP"):
                    cursor = avail[(ai - 1) % len(avail)]
                elif key in ("RIGHT", "DOWN"):
                    cursor = avail[(ai + 1) % len(avail)]
                elif key == "ENTER":
                    if donor is None:
                        mode, numbuf = "donor", ""
                    else:
                        confirm_form(secret)  # #133/#134: names the hole's lexeme
                        mode, numbuf = "start", ""
            elif mode == "donor":  # which same-lemma form lends its vector (#119)
                if key == "ESC":
                    mode, numbuf = "nav", ""
                elif key == "BACK":
                    numbuf = numbuf[:-1]
                elif key == "ENTER":
                    if not numbuf:  # Entrée = the suggestion, as in the line prompt
                        donors.choose(secret, dcands[0])
                        confirm_form(secret)
                        mode, numbuf = "start", ""
                    elif numbuf.isdigit() and 1 <= int(numbuf) <= len(dcands):
                        donors.choose(secret, dcands[int(numbuf) - 1])
                        confirm_form(secret)
                        mode, numbuf = "start", ""
                    else:
                        error = f"Numéro invalide (1–{len(dcands)})."
                elif key.isdigit():
                    numbuf += key
            else:  # start-word selection for the committed word
                if key == "ESC":
                    mode, numbuf = "nav", ""
                elif key == "BACK":
                    numbuf = numbuf[:-1]
                elif key == "ENTER":
                    if numbuf.isdigit() and 1 <= int(numbuf) <= len(band):
                        rank_map = entry["rank_map"]
                        start = band[int(numbuf) - 1][0]
                        start_rank = rbd[start]
                        # Same last questions as the --words path: agree what this hole
                        # can display with the sentence, then let the author name the
                        # start word's own form (#119 addendum + addendum 2).
                        display = ask_display(secret, entry, start, start_rank)
                        alias_start_display(rank_map, start, display, start_rank)
                        secret_slug = slug(secret)
                        ranks[secret_slug] = rank_map
                        for occurrence in candidates_for_slug(cands, secret_slug):
                            holes.append(_make_hole(
                                occurrence["secret"], occurrence["prefix"],
                                occurrence["suffix"], occurrence["pos"], display,
                                start_rank,
                            ))
                        used_slugs.add(secret_slug)
                        used_lemmas.update(
                            group_lemmas(secret, donor, lemma_table))
                        if donors is not None:  # the hole exists now: the borrow is real
                            donors.note_used(secret, donor)
                        mode, numbuf = "nav", ""
                        if len(used_slugs) < 3:
                            remaining = available()
                            if not remaining:
                                die("plus aucun mot sélectionnable : les mots restants "
                                    "sont des formes des mots déjà choisis.")
                            cursor = remaining[0]
                    else:
                        error = f"Numéro invalide (1–{len(band)})."
                elif key.isdigit():
                    numbuf += key
    except KeyboardInterrupt:
        aborted = True
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write(f"{_ESC}[0m\n")
        sys.stdout.flush()

    if aborted:
        die("sélection interrompue.")

    holes.sort(key=lambda h: h["pos"])
    return holes, ranks


def _resolve_word_selectors(words_arg, cfg, lang):
    """Normalize exactly three ``--words`` selectors and reject slug duplicates."""
    if len(words_arg) != 3:
        die(f"--words doit contenir exactement 3 sélecteurs distincts (reçu : {len(words_arg)}).")
    selectors = []
    seen = {}
    for raw in words_arg:
        target = normalize(raw, cfg)
        target_slug = slug(target)
        if not target_slug:
            die(f"'{raw}' ne contient aucune lettre valide pour la langue '{lang}'.")
        if target_slug in seen:
            die(
                "--words doit contenir exactement 3 mots distincts après normalisation "
                f"(doublon : '{raw}' et '{seen[target_slug]}', slug '{target_slug}')."
            )
        seen[target_slug] = raw
        selectors.append((raw, target_slug))
    return selectors


def filename_slugs_from_holes(holes):
    """Return distinct secret slugs in first-occurrence sentence order."""
    seen = set()
    ordered = []
    for hole in sorted(holes, key=lambda h: h["pos"]):
        secret_slug = hole["secret"]["slug"]
        if secret_slug in seen:
            continue
        seen.add(secret_slug)
        ordered.append(secret_slug)
    return ordered


def holes_from_words(words_arg, words, cfg, lang, kv, V, M, Vset,
                     lemma_table, forms_by_lemma, donors=None, forms=None,
                     reporter=None):
    """Resolve three distinct ``--words`` selectors into all matching holes.

    Matching is slug-based. Each selected slug gets one ranking and one start hint, then
    that start is applied to every matching sentence occurrence. Holes are returned in
    sentence order; the ranks map has one entry per selected slug. Under lemma grouping
    (#104) the 3-distinct-secrets contract means 3 distinct GROUPS: two selectors whose
    secrets share a lemma are "the same word" and rejected.

    `donors` (a DonorResolver, #119) is what lets a secret whose surface form has no
    vector borrow one from a same-lemma form; without it a vector-less secret is the
    same hard error as before. `forms` (a FormResolver, #133) agrees the whole rank
    map with the sentence; without it every word keeps its dictionary form.
    """
    selectors = _resolve_word_selectors(words_arg, cfg, lang)
    holes = []
    ranks = {}
    used_lemmas = {}  # lemma -> the earlier selector that claimed it
    for raw, target_slug in selectors:
        # Resolve every occurrence by slug. A repeated selected word is one authoring
        # selection but produces one hole per matching sentence token.
        occurrences = []
        for pos, word in enumerate(words):
            decomposed = locate_core(word, target_slug, cfg)
            if decomposed is not None:
                occurrences.append((pos, decomposed))
        if not occurrences:
            die(f"'{raw}' n'apparaît pas dans la phrase : {' '.join(words)}")

        # Use the first occurrence that survived reduction as the canonical vector target
        # for this shared slug. Every occurrence still keeps its own display form and
        # affixes in the emitted hole object.
        canonical = next(
            (decomposed for _pos, decomposed in occurrences if decomposed[0] in Vset),
            None,
        )
        if canonical is None:
            # No occurrence has a vector. A same-lemma form may lend one (#119), but
            # only explicitly: donor_for prompts on a TTY and demands --donor otherwise.
            # With no candidate at all (or no resolver) the pre-#119 error stands.
            canonical = occurrences[0][1]
            secret = canonical[0]
            if donors is None or not donors.candidates(secret):
                die(f"'{raw}' (→ '{secret}') n'a pas survécu à la réduction : absent du "
                    f"vocabulaire réduit '{lang}'. Choisis un autre mot cible, ou "
                    f"ajuste puis relance la réduction (scripts/reduce_embedding.py).")
        canonical_secret = canonical[0]
        # The GEOMETRY source: the secret itself when it has a vector, else its donor.
        # Everything else below keeps using the true sentence form.
        donor = donors.donor_for(canonical_secret) if donors is not None else canonical_secret

        # Two selected secrets in one lemma group would be one word holed twice. A
        # borrowed vector carries the donor's lemmas too, so a sibling of the donor is
        # "the same word" as well (#119). This test weighs the FULL identity, while
        # the walk below claims only what is confirmed or unambiguous.
        identity = group_lemmas(canonical_secret, donor, lemma_table)
        for lemma in identity:
            if lemma in used_lemmas:
                die(f"'{raw}' et '{used_lemmas[lemma]}' sont des formes du même mot "
                    f"(lemme commun « {lemma} ») : choisis 3 mots distincts.")
        for lemma in identity:
            used_lemmas[lemma] = raw
        # Claim, ranking and lexeme merging happen ONCE per distinct secret slug, in
        # walk_secret's fixed order — the #133 question fires inside it, ahead of the
        # walk (#134), because its answer names the lexeme group 0 claims.
        merged, rank_map, groups = walk_secret(
            canonical_secret, donor, cfg, kv, V, M, Vset, lemma_table,
            forms_by_lemma, donors, forms)
        rank_by_display = {canonical_secret: 0}
        for w, r, _ in merged:
            rank_by_display.setdefault(w, r + 1)

        ranks[target_slug] = rank_map
        start = choose_start(canonical_secret, merged, rank_map, rank_by_display)
        start_rank = rank_map[slug(start)]["rank"]
        # Agree the whole map with the sentence (#133), the start word included — it
        # is just the rank == start_rank group. Realization is keyed by each group's
        # LEXEME (#134), which the walk just settled.
        agreed = forms.apply(rank_map, canonical_secret, donors,
                             lexemes=group_lexeme_map(groups)) \
            if forms is not None else {}
        if reporter is not None:
            feature = forms.feature_for(canonical_secret) if forms is not None else None
            reporter.capture(canonical_secret, groups, rank_map, feature)
        # The band only offers forms that HAVE a vector; the sentence may demand one it
        # lacks. The override is DISPLAY only (#119 addendum) — start_rank is untouched,
        # and it defaults to what the pass made of the band word. Read from `agreed`,
        # NOT from rank_map[slug(start)]: a closer group's rewrite may have reclaimed
        # that slug, and its word at ITS rank is not this hole's hint.
        start_display = choose_start_display(
            start, start_rank, donors, default=agreed.get(start_rank, (start, start))[1])
        alias_start_display(rank_map, start, start_display, start_rank)

        for pos, (secret, prefix, suffix) in occurrences:
            holes.append(_make_hole(secret, prefix, suffix, pos, start_display,
                                    start_rank))

    # Holes follow sentence order, not --words order. Filename construction dedupes the
    # repeated occurrence slugs separately via filename_slugs_from_holes().
    holes.sort(key=lambda h: h["pos"])
    return holes, ranks


# --- Interactive prompts -------------------------------------------------------
# The script is fully interactive on a TTY (#5): anything not given as a CLI flag is
# asked here. These helpers only run when stdin is a terminal (main() guards them),
# so piped / batch runs are never blocked — exactly like choose_start.

def _prompt(label, default=None):
    """Read one line from a terminal prompt. Blank or EOF returns `default`.

    `default` (when set) is shown in brackets and used for an empty answer, so
    optional fields can be skipped with Enter."""
    hint = f" [{default}]" if default not in (None, "") else ""
    try:
        raw = input(f"{label}{hint} : ").strip()
    except EOFError:  # stdin closed mid-prompt: fall back to the default.
        return default
    return raw or default


def _prefill_tty(text):
    """Best-effort: pre-load the terminal's input line with `text` so the NEXT input()
    starts populated AND editable — the arrow keys move within it, like a shell prompt.

    Pushes the bytes into our own tty input queue (TIOCSTI); libedit then reads them as
    if typed, echoes them after the prompt, and lets the user edit any portion before
    Enter. This route exists because libedit's set_startup_hook/set_pre_input_hook +
    insert_text prefill is a no-op on macOS. Silently does nothing when there's no text,
    stdin isn't a TTY, or the ioctl is unavailable/blocked (e.g. TIOCSTI disabled) — the
    prompt then simply starts empty and the user types the phrase fresh."""
    if not text or not sys.stdin.isatty():
        return
    try:
        import fcntl
        import termios
        for byte in text.encode("utf-8"):  # one byte at a time (accents are multi-byte)
            fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSTI, bytes([byte]))
    except Exception:  # pragma: no cover - platform/tty without TIOCSTI: no prefill
        pass


def prompt_lang(default="en"):
    """Ask for the language, reprompting until it is one of the supported codes."""
    while True:
        raw = _prompt("Langue (en/fr)", default)
        if raw in ("en", "fr"):
            return raw
        print("  Réponds 'en' ou 'fr'.")


def prompt_editable(label, prefill="", blank_error="La réponse ne peut pas être vide."):
    """Ask for one required value, reprompting until it is non-empty.

    On a TTY the prompt is pre-loaded with `prefill` (the flag-provided value, if any)
    so a portion can be edited with the arrow keys instead of retyping the whole line;
    Enter accepts it unchanged. If the answer comes back empty (the user cleared it) we
    reprompt from scratch — the original prefill is not re-injected."""
    first = True
    while True:
        _prefill_tty(prefill if first else "")
        first = False
        raw = _prompt(label)
        if raw:
            return raw
        print(f"  {blank_error}")


def prompt_sentence(prefill=""):
    """Ask for the sentence, pre-loaded with the flag value — see prompt_editable."""
    return prompt_editable("Phrase", prefill, "La phrase ne peut pas être vide.")


def prompt_kind():
    """Ask for the optional 'kind of piece'. Blank -> None (field omitted).

    Offers KNOWN_KINDS as a numbered shortcut but also accepts free-form text, so a
    kind outside the suggested set is allowed (the SourceKind union is open)."""
    listing = ", ".join(f"{i}={k}" for i, k in enumerate(KNOWN_KINDS, 1))
    while True:
        raw = _prompt(f"Type d'œuvre ({listing} ; ou texte libre ; Entrée = aucun)")
        if not raw:
            return None
        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(KNOWN_KINDS):
                return KNOWN_KINDS[idx - 1]
            print(f"  Numéro hors liste (1–{len(KNOWN_KINDS)}).")
            continue
        return raw


def build_source(kind=None, author=None, work=None):
    """Assemble the optional `source` metadata dict, dropping blank fields.

    Returns None when nothing is provided so the puzzle JSON stays byte-compatible
    with metadata-less puzzles (no empty `source` key). Values are DISPLAY forms
    (accents kept, never slugged), matching the rest of the schema."""
    src = {}
    for key, val in (("kind", kind), ("author", author), ("work", work)):
        if val is None:
            continue
        val = val.strip()
        if val:
            src[key] = val
    return src or None


def source_dir_segments(source):
    """The directory levels a puzzle files under, below its language (#137).

    <kind>/<author>/<work>, each a path_slug — readable ASCII, never a lookup key.
    `kind` is an OPEN union, so this validates nothing against KNOWN_KINDS: the
    corpus already carries kinds outside it.

    A missing level is OMITTED along with everything under it, rather than filled
    with a placeholder: a path cannot skip a component, so an author with no kind
    would read as a kind. The degenerate case is the point — a puzzle with no
    `source` at all returns [] and lands at <out-dir>/<lang>/, exactly where every
    puzzle landed before this layout existed.

    An UNNAMABLE level collapses the same way but is NOT the same event, so it is
    reported: the metadata was given, and path_slug just has nothing ASCII to make
    a name from (a title of pure punctuation, or any non-Latin script — 村上春樹,
    книга). The file then lands high in the tree carrying full metadata in its JSON,
    which looks exactly like a puzzle that was never given a source; a curator who
    typed the level deserves to be told the path dropped it."""
    source = source or {}
    segments = []
    for key in ("kind", "author", "work"):
        value = (source.get(key) or "").strip()
        segment = path_slug(value)
        if not segment:
            if value:
                print(f"  attention : « {value} » ({key}) n'a pas de nom de dossier "
                      f"ASCII — ce niveau et tout ce qui suit sont retirés du chemin "
                      f"(les métadonnées restent dans le JSON).", file=sys.stderr)
            break
        segments.append(segment)
    return segments


# --- Shared command scaffolding (#154) -------------------------------------------
# gen_phrase and gen_word share more than the per-secret pipeline (walk_secret): both
# load the same tables and vectors in the same fail-fast order, build the same three
# resolvers on top, and report the same substitution/agreement events after the run.
# Sharing the rules but copying this scaffolding would let the copies drift the way the
# rules no longer can (a new FormResolver reporting channel would need remembering in
# two mains), so it lives here, once.

@dataclass(frozen=True)
class PreparedRun:
    """Everything a generation command loads before its first walk (prepare_run)."""
    explicit_forms: dict
    lemma_table: dict
    forms_by_lemma: dict
    kv: object
    V: list
    M: object
    Vset: set
    donors: DonorResolver
    forms: FormResolver
    reporter: PlayabilityReporter


def add_shared_args(p):
    """The flags BOTH commands take, worded identically (gen_phrase + gen_word).

    Their per-secret pipeline is shared (walk_secret / prepare_run), so the switches
    that steer it are declared once here rather than restated in each parser.
    `--donor` and `--form` stay with each command: their help names what the command
    holes (a sentence's secret, or the day's word)."""
    p.add_argument("--lang", choices=("en", "fr"), default=None,
                   help="langue en/fr (défaut : en en mode non interactif)")
    p.add_argument("--no-lemmas", action="store_true",
                   help="désactive le regroupement par lexème (#104/#134) — chaque "
                        "forme fléchie garde son propre rang ; exige --no-inflect "
                        "quand la langue a une table de formes (l'accord est indexé "
                        "par les lexèmes du regroupement)")
    p.add_argument("--no-inflect", action="store_true",
                   help="désactive l'accord des mots affichés (#119/#133) — "
                        "chaque mot garde sa forme de dictionnaire")


def prepare_run(lang, interactive, args):
    """Load and wire the machinery a generation command needs before its first walk.

    The ORDER is the fail-fast contract, written once for both commands: a malformed
    --donor / --form pair dies before anything slow loads; the grouping table (#104)
    loads before the vectors so a missing table fails fast; the --no-lemmas/--no-inflect
    gate fires BEFORE the ~5 MB inventory parse (the reject path owes nobody a
    two-second parse); and the resolvers are built on the loaded vocabulary. `args`
    needs only the flags the two commands share: --no-lemmas, --no-inflect, --donor,
    --form. Command-specific validation (the --words selectors, the single-word guard)
    belongs before this call, so it too fails ahead of the loads."""
    cfg = CONFIG[lang]
    explicit_donors = parse_donor_args(args.donor)
    explicit_forms = parse_form_args(args.form)

    # Lemma table (#104): an empty table (--no-lemmas) reproduces the ungrouped walk.
    lemma_table = load_lemma_table(lang, disabled=args.no_lemmas)
    forms_by_lemma = invert_lemmas(lemma_table)

    # Since #134 the agreement pass is keyed by the walk's LEXEMES, which --no-lemmas
    # removes (every surface becomes its own table-less singleton, and nothing carries
    # a cell to realize). Running it anyway would take --form answers and silently
    # rewrite nothing — reject the combination instead of degrading it.
    if lang in FORM_LANGS and not args.no_inflect and args.no_lemmas:
        die("--no-lemmas retire les lexèmes sur lesquels l'accord d'affichage est "
            "indexé (#134) : ajoute --no-inflect pour générer sans regroupement, "
            "ou retire --no-lemmas.")

    # Form table (addendum 2). None for a language with no table (en) or under
    # --no-inflect: the agreement pass then never runs.
    form_table = load_form_table(lang, disabled=args.no_inflect)

    kv = cfg["module"].load_vectors()
    V = build_lang_vocab(kv, cfg)
    # V == kv == the whole reduced vocabulary, so there is no target to inject: a
    # target either survived reduction (it is in V) or it cannot be used — the
    # command's per-secret path errors clearly in the latter case.
    M = cfg["module"].build_matrix(kv, V)
    Vset = set(V)

    # A secret whose surface form never survived reduction may borrow a same-lemma
    # form's vector (#119) — explicitly: --donor off a TTY, a numbered question on one.
    donors = DonorResolver(lemma_table, forms_by_lemma, V, Vset, lang,
                           explicit=explicit_donors, interactive=interactive)
    # The whole rank map agrees with the secret's morphology (#133), which is NEVER
    # inferred: every secret confirms its form on a TTY (a single analysis included),
    # and off one --form is required per secret. --no-inflect is the explicit opt-out.
    forms = FormResolver(form_table, explicit=explicit_forms, interactive=interactive,
                         typable=donors.typable)
    reporter = PlayabilityReporter(V, lemma_table, forms_by_lemma, kv,
                                   resolver=forms)
    return PreparedRun(explicit_forms, lemma_table, forms_by_lemma, kv, V, M,
                       Vset, donors, forms, reporter)


def report_run_adjustments(donors, forms, explicit_forms, lang, no_inflect,
                           subject_fmt="secret « {} »",
                           unused_form_msg="n'a servi à aucun trou"):
    """Print what the run substituted or rewrote — never silently (#119/#133/#134).

    A borrowed vector says which form lent it; the agreement pass says which form was
    applied and how many groups it moved; #134's curator marks follow (`*` fallbacks,
    declined slug-collision rewrites); and a --form that named a word the run never
    used is called out as the probable typo it is. `subject_fmt` names the word the
    way the command's preview does (a sentence has secrets; a lone word is just the
    word), and `unused_form_msg` finishes the typo warning in the command's terms."""
    for secret_word, donor_word in donors.used.values():
        print(f"  {subject_fmt.format(secret_word)} : rangs calculés depuis le "
              f"donneur « {donor_word} »")
    for secret_word, feature, morphology, count in forms.used.values():
        print(f"  {subject_fmt.format(secret_word)} : {count} mot(s) affiché(s) "
              f"accordé(s) à {describe_morphology(morphology)} "
              f"(trait source {feature})")
    for secret_word, entries in forms.fallbacks.values():
        sample = ", ".join(f"*{w} (rang {r})" for r, w in entries[:5])
        more = f", … {len(entries)} au total" if len(entries) > 5 else ""
        print(f"  {subject_fmt.format(secret_word)} : {len(entries)} groupe(s) en "
              f"repli* — forme demandée absente ou intypable, forme nette gardée : "
              f"{sample}{more}")
    for secret_word, count in forms.collisions.values():
        print(f"  {subject_fmt.format(secret_word)} : {count} collision(s) de slug "
              f"après accord (le plus proche gagne, réécriture(s) déclinée(s))")
    if explicit_forms:
        if no_inflect:
            print("  attention : --form est ignoré sous --no-inflect.", file=sys.stderr)
        elif lang not in FORM_LANGS:
            print(f"  attention : --form est ignoré : pas de table de formes pour "
                  f"'{lang}'.", file=sys.stderr)
        else:
            for key in sorted(set(explicit_forms) - forms.answered):
                print(f"  attention : --form « {key} » {unused_form_msg}.",
                      file=sys.stderr)


def parse_args():
    p = argparse.ArgumentParser(
        description="Génère un fichier de jeu autonome pour une phrase "
                    "(interactif sur un terminal ; sinon fournir les arguments)."
    )
    # sentence / --words are optional: on a TTY the sentence is prompted and the holes are
    # chosen with the interactive selector when omitted; in a non-interactive run their
    # absence is a clear error (see main()).
    p.add_argument("sentence", nargs="?", help="la phrase complète (sinon demandée)")
    # default=None (not "en") so main() can tell "flag omitted" from an explicit
    # choice, and prompt for it on a TTY while keeping the old "en" default off-TTY.
    add_shared_args(p)
    p.add_argument("--words", nargs=3, metavar=("W1", "W2", "W3"),
                   help="exactement 3 mots distincts de la phrase ; chaque occurrence "
                        "d'un mot sélectionné devient un trou (sinon choisis via le "
                        "sélecteur interactif sur un terminal)")
    # Optional source metadata (#5); any flag given here is NOT re-prompted on a TTY.
    p.add_argument("--donor", action="append", metavar="MANQUANT=DONNEUR",
                   help="emprunte le vecteur d'une forme du même lemme pour un secret "
                        "absent de l'embedding (#119), ex. --donor accoutumes="
                        "accoutume ; répétable, requis hors mode interactif")
    p.add_argument("--form", action="append", metavar="MOT=TRAIT",
                   help="trait morphologique du secret, auquel son voisinage s'accorde "
                        "(#133), ex. --form accoutumes=ind:pre:2s ; répétable, requis "
                        "par secret hors mode interactif — la forme n'est jamais "
                        "déduite. Un trait porté par plusieurs lexèmes du secret "
                        "exige la forme qualifiée MOT=LEXÈME/TRAIT (#144), ex. "
                        "--form fils=fils:nc/n:p")
    p.add_argument("--kind", help="type d'œuvre (book, movie, music, quote, poem, …)")
    p.add_argument("--author", help="auteur / autrice")
    p.add_argument("--work", help="titre de l'œuvre")
    p.add_argument("--out-dir", default=os.path.join(GEN_OUTPUT, "word"), dest="out_dir",
                   help="racine de sortie des puzzles ; le fichier est classé dessous "
                        "en <lang>/<type>/<auteur>/<œuvre>/ (défaut : "
                        "packages/generation/output/word)")
    return p.parse_args()


def main():
    args = parse_args()
    interactive = sys.stdin.isatty()

    # Resolve every required input: a CLI flag wins; else prompt on a TTY; else keep
    # the old non-interactive contract (default lang / clear error for what's missing),
    # so piped and batch runs behave exactly as before.
    lang = args.lang
    if lang is None:
        lang = prompt_lang() if interactive else "en"

    sentence = args.sentence
    if interactive:
        # Always show the phrase in an editable prompt, pre-loaded with the flag value
        # (if any) so a portion can be tweaked with the arrow keys; Enter accepts it.
        sentence = prompt_sentence(prefill=sentence or "")
    elif sentence is None:
        die("aucune phrase fournie (argument positionnel requis hors mode interactif).")

    # Without --words we need a TTY: the holes are chosen with the interactive selector
    # (below). Off a TTY, --words stays required — the batch / piped contract is unchanged.
    words_arg = args.words
    if words_arg is None and not interactive:
        die("--words est requis hors mode interactif (exactement 3 mots distincts).")

    cfg = CONFIG[lang]
    random.seed(0)  # reproducible start words

    # Reject malformed/duplicate authoring selectors before the expensive vector load, so
    # a repeated --words slug fails immediately with the clear contract error.
    if words_arg is not None:
        _resolve_word_selectors(words_arg, cfg, lang)

    # Tables, gate, vectors and the three resolvers, in prepare_run's fixed fail-fast
    # order — the scaffolding both generation commands share (#154).
    run = prepare_run(lang, interactive, args)
    kv, V, M, Vset = run.kv, run.V, run.M, run.Vset
    lemma_table, forms_by_lemma = run.lemma_table, run.forms_by_lemma
    donors, forms, reporter = run.donors, run.forms, run.reporter

    # DISPLAY tokens of the sentence: lowercased, but accents AND punctuation /
    # apostrophes KEPT (see display_token), so words[] reproduces the sentence. Each
    # secret is located INSIDE its token by slug (locate_core), so a blanked word keeps
    # its surrounding clitic/punctuation as the hole's prefix/suffix.
    words = [display_token(t) for t in sentence.split()]

    # Existence set for the front: the whole (slugged) reduced vocabulary V.
    write_vocab(V, lang)

    # Two paths to the same (holes, ranks): --words is the explicit / batch path (each
    # distinct selector expands to all matching occurrences); with no --words on a TTY
    # the groups are chosen with the interactive selector, which also picks each shared
    # start word inline.
    if words_arg is not None:
        holes, ranks = holes_from_words(words_arg, words, cfg, lang, kv, V, M, Vset,
                                        lemma_table, forms_by_lemma, donors, forms,
                                        reporter=reporter)
    else:
        holes, ranks = select_holes_interactive(words, cfg, lang, kv, V, M, Vset,
                                                lemma_table, forms_by_lemma, donors,
                                                forms, reporter=reporter)

    # #135 is a report only: print after every selected map exists (and after raw
    # mode has restored the terminal), before metadata/file authoring continues.
    reporter.print()

    # --- Optional source metadata (#5) ----------------------------------------
    # Flags win; otherwise ask on a TTY (any flag already given is not re-prompted);
    # otherwise leave omitted. Asked here, after the holes are built, so a bad word
    # errors out before any metadata is entered.
    kind, author, work = args.kind, args.author, args.work
    if interactive:
        if kind is None:
            kind = prompt_kind()
        if author is None:
            author = _prompt("Auteur / autrice")
        if work is None:
            work = _prompt("Titre de l'œuvre")
    source = build_source(kind, author, work)

    phrase = {
        "lang": lang,
        "words": words,
        "holes": holes,
        "ranks": ranks,
    }
    # Only write `source` when there is metadata, keeping puzzles without it
    # byte-compatible with metadata-less output.
    if source:
        phrase["source"] = source

    # --- Write one self-contained file ----------------------------------------
    # Filed under its source (#137): <lang>/<kind>/<author>/<work>/. Missing levels
    # are omitted, so a puzzle without metadata still lands at <lang>/.
    out_dir = os.path.join(args.out_dir, lang, *source_dir_segments(source))
    os.makedirs(out_dir, exist_ok=True)
    fname = "_".join(filename_slugs_from_holes(holes)) + ".json"
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(phrase, f, ensure_ascii=False)

    # --- Preview ---------------------------------------------------------------
    print(f"\nPhrase ({lang}) écrite dans {out_path} :")
    for h in holes:
        print(f"  {h['start']['word']}^-{h['start_rank']} -> {h['secret']['word']}")
    # Substitutions, agreement, #134's curator marks and --form typo warnings — the
    # shared reporting block (#154), in the sentence path's own words.
    report_run_adjustments(donors, forms, run.explicit_forms, lang, args.no_inflect)
    if source:
        print("  source : " + ", ".join(f"{k}={v}" for k, v in source.items()))

    # A puzzle is not served from here: publish it into the daily store (local or S3).
    # --s3 discovers the bucket from the deployed stack output; no --bucket needed.
    print(f"\nPublier : pnpm puzzle:publish {out_path}"
          f"\n          pnpm puzzle:publish {out_path} --s3")


if __name__ == "__main__":
    main()
