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

The phrase is written to packages/generation/output/word/<lang>/<slug1>_<slug2>_<slug3>.json
(the three distinct selected slugs in sentence order); rerunning with the same three words
overwrites it. A repeated selected word produces one hole per sentence occurrence, but one
rank map and one start hint for that secret. A puzzle is a generation artifact, NOT a web
asset: publish it to the backend store (local FS or S3) with `pnpm puzzle:publish` — the
front gets the day's puzzle from the backend (#6).

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

Usage :
    uv run scripts/gen_phrase.py                       # fully interactive
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c
    uv run scripts/gen_phrase.py "<phrase>" --lang fr --words a b c \
        --kind book --author "Victor Hugo" --work "Les Misérables"
    pnpm gen:phrase "<phrase>" --lang fr --words a b c
"""

import argparse
import json
import os
import random
import re
import select
import sys

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
from build_lemmas import lemmas_path, load_lemmas  # stdlib-only form→lemma table (#104)
from slug import slug, write_vocab  # shared stdlib slug/fold contract + vocab writer
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


def locate_cores(token, target_slug, cfg):
    """Find every matching word-core in one display token.

    Each result is ``(secret_display, prefix, suffix)``: the matched core (accents
    kept, no punctuation) plus the display text before/after it. Apostrophes and
    punctuation are separators, so a secret can be located inside ``t'attends`` /
    ``rien,`` while the token stays intact for display.
    """
    matches = []
    for m in cfg["core_re"].finditer(token):
        if slug(m.group()) == target_slug:
            matches.append((m.group(), token[:m.start()], token[m.end():]))
    return matches


def locate_core(token, target_slug, cfg):
    """Find the first matching word-core in a display token, or ``None``."""
    matches = locate_cores(token, target_slug, cfg)
    return matches[0] if matches else None


def ws(display):
    """A {word, slug} object: the displayed (accented) form plus its slug.

    Always carries both, even when slug == word (no conditional shortcuts)."""
    return {"word": display, "slug": slug(display)}


def build_rank_map(secret_display, ranking):
    """Slug-keyed rank map for one secret: { input_slug: {word, rank} }.

    Iterates closest-first (secret itself is rank 0), so on a slug collision
    (côté/coté -> cote) the first seen is the smallest rank: we keep it (collisions
    are resolved SILENTLY — no output). The kept entry's `word` is the form the front
    will display."""
    # Combined list in ascending-rank order: secret at 0, then neighbors at r+1.
    entries = [(secret_display, 0)]
    entries.extend((w, r + 1) for w, r, _ in ranking)

    rmap = {}
    for display, rank in entries:
        s = slug(display)
        if s in rmap:  # first-seen wins (smallest rank); drop the later duplicate.
            continue
        rmap[s] = {"word": display, "rank": rank}
    return rmap


# --- Lemma grouping (#104) ------------------------------------------------------
# Inflected forms of one word ("privé"/"privée"/"privés", "vermine"/"vermines") are
# ONE ranked group in a rank map. The committed form→lemma table (build_lemmas.py)
# says which forms belong together; merging itself happens HERE, at generation time,
# on the closest-first walk — a generalization of the slug-collision rule with a
# coarser key. Embeddings, the reduction and the vocab existence set are untouched.

def load_lemma_table(lang, disabled=False):
    """Load the committed form→lemma table for a language.

    Missing table -> hard error (like the hors-dico wordlist): silently generating
    without merging would ship near-duplicate ranks. --no-lemmas opts out explicitly
    and returns an empty table, under which every word is its own singleton group —
    byte-identical to pre-#104 output."""
    if disabled:
        return {}
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


def invert_lemmas(lemma_table):
    """Inverse index lemma -> [forms], in the table's deterministic (sorted) order.
    Used by expand_aliases to enumerate every inflected form of a surviving group."""
    inv = {}
    for form, lemmas in lemma_table.items():
        for lemma in lemmas:
            inv.setdefault(lemma, []).append(form)
    return inv


def merge_ranking(secret_display, ranking, lemma_table, top_k=TOP_K):
    """Collapse a raw closest-first ranking into TOP_K distinct lemma groups.

    Walk closest-first. A word sharing ANY lemma with an earlier (closer) group is an
    alias of that group: it consumes NO rank (its slug keys are added later by
    expand_aliases). A word opening a new group is a survivor: it gets the next
    compacted rank and claims ALL of its lemmas — so a later ambiguous form
    ("portes" -> porte/porter) attaches to whichever of its groups ranked closest.
    The secret itself is group 0, so its own inflections alias to rank 0 (they SOLVE
    the hole — decided in #104). Filter-then-cap: the walk stops once top_k groups
    have PASSED, not after top_k raw neighbors.

    Returns (merged, groups):
      merged: [(word, rank_index, sim)] — the survivors, same shape as `ranking`
              but with COMPACTED rank indices, so start_band / pick_start / the
              interactive band preview all operate on merged ranks unchanged;
      groups: [(canonical_display, rank, lemmas)] — every group INCLUDING the
              secret at rank 0, ascending by rank (expand_aliases' input).
    """
    secret_lemmas = lemmas_of(secret_display, lemma_table)
    taken = set(secret_lemmas)
    groups = [(secret_display, 0, secret_lemmas)]
    merged = []
    for w, _r, sim in ranking:
        lemmas = lemmas_of(w, lemma_table)
        if any(lemma in taken for lemma in lemmas):
            continue  # alias of a closer group: no rank consumed.
        merged.append((w, len(merged), sim))
        groups.append((w, len(merged), lemmas))
        taken.update(lemmas)
        if len(merged) >= top_k:
            break
    return merged, groups


def expand_aliases(rmap, groups, forms_by_lemma, Vset):
    """Add alias keys to a rank map: every REDUCED-VOCAB form of each surviving
    group's lemma(s) points at that group's canonical {word, rank}.

    Covers forms that never appeared in the walk ("privait" hits "privé"'s rank even
    when it is not among the fetched neighbors). Groups arrive ascending by rank and
    an existing entry is never overwritten (first-seen wins, like the slug-collision
    rule), so an ambiguous form aliases to its closest group and a canonical entry is
    never clobbered. Filtering by Vset keeps the map aligned with the existence set:
    a key the front can never look up is never emitted."""
    for canonical, rank, lemmas in groups:
        for lemma in lemmas:
            for form in forms_by_lemma.get(lemma, ()):
                if form not in Vset:
                    continue
                s = slug(form)
                if s and s not in rmap:
                    rmap[s] = {"word": canonical, "rank": rank}
    return rmap


def build_merged_rank_map(secret_display, ranking, lemma_table, forms_by_lemma, Vset,
                          top_k=TOP_K):
    """One secret's complete rank map under lemma grouping, plus its merged ranking.

    merge_ranking compacts the raw walk into distinct groups, build_rank_map keys the
    survivors (slug-collision rule unchanged), expand_aliases adds every vocab form
    of each group. With an empty lemma_table the output is byte-identical to the
    pre-#104 rank map capped at top_k."""
    merged, groups = merge_ranking(secret_display, ranking, lemma_table, top_k)
    rmap = build_rank_map(secret_display, merged)
    expand_aliases(rmap, groups, forms_by_lemma, Vset)
    return merged, rmap


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


def extract_candidates(words, cfg, Vset):
    """The selectable occurrences in a sentence: for each token, its first word-core
    whose DISPLAY form is in Vset (i.e. survived reduction). Returns [{pos, secret,
    prefix, suffix}] — one entry per holeable token position.

    Apostrophes / punctuation are core separators (core_re), so "l'animal" yields cores
    "l" then "animal" and only "animal" is selectable: "l" is a single letter the
    reduction dropped, so it is absent from Vset. Because the reduction already strips
    stopwords, single letters and non-dictionary tokens from V, "core in Vset" IS the
    content-word filter — no separate stopword list is needed. Keeping only the first
    in-vocab core per token means each occurrence has one position; the selector groups
    repeated occurrences by slug so one pick consumes one distinct secret."""
    cands = []
    for pos, token in enumerate(words):
        for m in cfg["core_re"].finditer(token):
            secret = m.group()
            if slug(secret) and secret in Vset:
                cands.append({"pos": pos, "secret": secret,
                              "prefix": token[:m.start()], "suffix": token[m.end():]})
                break
    return cands


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
                             lemma_table, forms_by_lemma):
    """Pick three distinct secret groups on a TTY; return holes sorted by position.

    Full-screen loop: ←/→ move between the sentence's selectable content words (see
    extract_candidates) and the hovered word's start-word band is previewed live (its
    neighbor ranking is computed once per secret slug and cached). Enter commits the
    hovered word's whole repeated-word group; its shared start word is then chosen by
    number (Enter validates, Esc cancels and returns to navigation). Three distinct
    commits end the loop; Ctrl-C aborts cleanly. The holes / ranks produced are identical
    in shape to the --words path (build_rank_map + _make_hole are shared), so nothing
    downstream needs to know which path chose the holes."""
    import shutil
    import termios
    import tty

    cands = extract_candidates(words, cfg, Vset)

    # Selectable DISTINCT GROUPS (#104): committing a word blocks every other form of
    # its lemma group, so feasibility is counted greedily in sentence order — the same
    # first-committed-wins rule the selection loop itself enforces.
    def count_selectable_groups():
        taken, seen, n = set(), set(), 0
        for c in cands:
            s = slug(c["secret"])
            lemmas = set(lemmas_of(c["secret"], lemma_table))
            if s in seen or lemmas & taken:
                continue
            seen.add(s)
            taken |= lemmas
            n += 1
        return n

    if count_selectable_groups() < 3:
        die(f"la phrase n'a que {count_selectable_groups()} mot(s) sélectionnable(s) "
            f"distinct(s) ; il en faut 3 (mots présents dans le vocabulaire réduit "
            f"'{lang}', hors mots-outils). Les occurrences répétées et les formes d'un "
            "même mot (lemme commun) ne consomment qu'une sélection.")

    # Per-secret neighbor data, computed lazily on first hover and cached: the merged
    # rank map (lemma groups collapsed, aliases expanded), the start-word band on the
    # MERGED ranks, and display->merged-rank (0 = secret).
    cache = {}

    def prep(secret):
        secret_slug = slug(secret)
        if secret_slug not in cache:
            ranking = cfg["module"].closest(secret, kv, V, M, n=None)
            merged, rank_map = build_merged_rank_map(
                secret, ranking, lemma_table, forms_by_lemma, Vset)
            rbd = {secret: 0}
            for w, r, _ in merged:
                rbd[w] = r + 1
            cache[secret_slug] = (
                secret,
                rank_map,
                start_band(secret, merged),
                rbd,
            )
        return cache[secret_slug]

    holes = []
    ranks = {}
    used_slugs = set()
    used_lemmas = set()  # lemmas claimed by committed groups: their forms block too

    def taken_word(c):
        """A candidate is spent when its slug is committed OR it is another form of a
        committed group — one word, one hole set (#104)."""
        return (slug(c["secret"]) in used_slugs
                or any(lemma in used_lemmas for lemma in lemmas_of(c["secret"], lemma_table)))

    def available():
        return [i for i, c in enumerate(cands) if not taken_word(c)]

    def frame(cursor, band, rbd, secret, mode, numbuf, error):
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
        # the hovered word's start-word band (numbered), the pick target in start mode.
        title = f"  Mots de départ pour « {secret} »"
        if mode == "start":
            title += "   numéro : " + _sgr("1;7", f" {numbuf or ' '} ") + "  (Entrée valider · Échap annuler)"
        out.append(_sgr("1", title))
        cells = [f"{i:>3}) {w} ^-{rbd[w]}" for i, (w, _r) in enumerate(band, 1)]
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
    cursor = available()[0]
    mode, numbuf, error = "nav", "", ""
    aborted = False
    try:
        tty.setcbreak(fd)
        while len(used_slugs) < 3:
            c = cands[cursor]
            canonical_secret, rank_map, band, rbd = prep(c["secret"])
            sys.stdout.write(frame(cursor, band, rbd, c["secret"], mode, numbuf, error))
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
                    mode, numbuf = "start", ""
            else:  # start-word selection for the committed word
                if key == "ESC":
                    mode, numbuf = "nav", ""
                elif key == "BACK":
                    numbuf = numbuf[:-1]
                elif key == "ENTER":
                    if numbuf.isdigit() and 1 <= int(numbuf) <= len(band):
                        start = band[int(numbuf) - 1][0]
                        secret_slug = slug(c["secret"])
                        ranks[secret_slug] = rank_map
                        for occurrence in candidates_for_slug(cands, secret_slug):
                            holes.append(_make_hole(
                                occurrence["secret"], occurrence["prefix"],
                                occurrence["suffix"], occurrence["pos"], start,
                                rbd[start],
                            ))
                        used_slugs.add(secret_slug)
                        used_lemmas.update(lemmas_of(canonical_secret, lemma_table))
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
                     lemma_table, forms_by_lemma):
    """Resolve three distinct ``--words`` selectors into all matching holes.

    Matching is slug-based. Each selected slug gets one ranking and one start hint, then
    that start is applied to every matching sentence occurrence. Holes are returned in
    sentence order; the ranks map has one entry per selected slug. Under lemma grouping
    (#104) the 3-distinct-secrets contract means 3 distinct GROUPS: two selectors whose
    secrets share a lemma are "the same word" and rejected.
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
            secret = occurrences[0][1][0]
            die(f"'{raw}' (→ '{secret}') n'a pas survécu à la réduction : absent du "
                f"vocabulaire réduit '{lang}'. Choisis un autre mot cible, ou "
                f"ajuste puis relance la réduction (scripts/reduce_embedding.py).")
        canonical_secret = canonical[0]

        # Two selected secrets in one lemma group would be one word holed twice.
        for lemma in lemmas_of(canonical_secret, lemma_table):
            if lemma in used_lemmas:
                die(f"'{raw}' et '{used_lemmas[lemma]}' sont des formes du même mot "
                    f"(lemme commun « {lemma} ») : choisis 3 mots distincts.")
        for lemma in lemmas_of(canonical_secret, lemma_table):
            used_lemmas[lemma] = raw

        # Ranking, lemma merging and start selection happen ONCE per distinct secret
        # slug. The walk needs the FULL raw ranking: merging collapses inflections,
        # so reaching TOP_K distinct groups can consume well over TOP_K raw neighbors.
        ranking = cfg["module"].closest(canonical_secret, kv, V, M, n=None)
        merged, rank_map = build_merged_rank_map(
            canonical_secret, ranking, lemma_table, forms_by_lemma, Vset)
        rank_by_display = {canonical_secret: 0}
        for w, r, _ in merged:
            rank_by_display[w] = r + 1

        ranks[target_slug] = rank_map
        start = choose_start(canonical_secret, merged, rank_map, rank_by_display)
        start_rank = rank_map[slug(start)]["rank"]

        for pos, (secret, prefix, suffix) in occurrences:
            holes.append(_make_hole(secret, prefix, suffix, pos, start, start_rank))

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


def prompt_sentence(prefill=""):
    """Ask for the sentence, reprompting until it is non-empty.

    On a TTY the prompt is pre-loaded with `prefill` (the flag-provided phrase, if any)
    so a portion can be edited with the arrow keys instead of retyping the whole line;
    Enter accepts it unchanged. If the answer comes back empty (the user cleared it) we
    reprompt from scratch — the original prefill is not re-injected."""
    first = True
    while True:
        _prefill_tty(prefill if first else "")
        first = False
        raw = _prompt("Phrase")
        if raw:
            return raw
        print("  La phrase ne peut pas être vide.")


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
    p.add_argument("--lang", choices=("en", "fr"), default=None,
                   help="langue en/fr (défaut : en en mode non interactif)")
    p.add_argument("--words", nargs=3, metavar=("W1", "W2", "W3"),
                   help="exactement 3 mots distincts de la phrase ; chaque occurrence "
                        "d'un mot sélectionné devient un trou (sinon choisis via le "
                        "sélecteur interactif sur un terminal)")
    # Optional source metadata (#5); any flag given here is NOT re-prompted on a TTY.
    p.add_argument("--no-lemmas", action="store_true",
                   help="désactive le regroupement par lemme (#104) — chaque forme "
                        "fléchie garde son propre rang")
    p.add_argument("--kind", help="type d'œuvre (book, movie, music, quote, poem, …)")
    p.add_argument("--author", help="auteur / autrice")
    p.add_argument("--work", help="titre de l'œuvre")
    p.add_argument("--out-dir", default=os.path.join(GEN_OUTPUT, "word"), dest="out_dir",
                   help="dossier de sortie des puzzles (défaut : packages/generation/output/word)")
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

    # Lemma table (#104), loaded before the vectors so a missing table fails fast.
    # An empty table (--no-lemmas) reproduces the pre-#104 behaviour exactly.
    lemma_table = load_lemma_table(lang, disabled=args.no_lemmas)
    forms_by_lemma = invert_lemmas(lemma_table)

    kv = cfg["module"].load_vectors()
    V = build_lang_vocab(kv, cfg)

    # DISPLAY tokens of the sentence: lowercased, but accents AND punctuation /
    # apostrophes KEPT (see display_token), so words[] reproduces the sentence. Each
    # secret is located INSIDE its token by slug (locate_core), so a blanked word keeps
    # its surrounding clitic/punctuation as the hole's prefix/suffix.
    words = [display_token(t) for t in sentence.split()]

    # V == kv == the whole reduced vocabulary, so there is no target to inject: a
    # target either survived reduction (it is in V) or it cannot be used. The
    # per-secret loop below errors clearly in the latter case.
    M = cfg["module"].build_matrix(kv, V)
    Vset = set(V)

    # Existence set for the front: the whole (slugged) reduced vocabulary V.
    write_vocab(V, lang)

    # Two paths to the same (holes, ranks): --words is the explicit / batch path (each
    # distinct selector expands to all matching occurrences); with no --words on a TTY
    # the groups are chosen with the interactive selector, which also picks each shared
    # start word inline.
    if words_arg is not None:
        holes, ranks = holes_from_words(words_arg, words, cfg, lang, kv, V, M, Vset,
                                        lemma_table, forms_by_lemma)
    else:
        holes, ranks = select_holes_interactive(words, cfg, lang, kv, V, M, Vset,
                                                lemma_table, forms_by_lemma)

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
    out_dir = os.path.join(args.out_dir, lang)
    os.makedirs(out_dir, exist_ok=True)
    fname = "_".join(filename_slugs_from_holes(holes)) + ".json"
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(phrase, f, ensure_ascii=False)

    # --- Preview ---------------------------------------------------------------
    print(f"\nPhrase ({lang}) écrite dans {out_path} :")
    for h in holes:
        print(f"  {h['start']['word']}^-{h['start_rank']} -> {h['secret']['word']}")
    if source:
        print("  source : " + ", ".join(f"{k}={v}" for k, v in source.items()))

    # A puzzle is not served from here: publish it into the daily store (local or S3).
    # --s3 discovers the bucket from the deployed stack output; no --bucket needed.
    print(f"\nPublier : pnpm puzzle:publish {out_path}"
          f"\n          pnpm puzzle:publish {out_path} --s3")


if __name__ == "__main__":
    main()
