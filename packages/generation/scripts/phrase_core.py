"""Stdlib-only core of the phrase/puzzle contract.

Like scripts/slug.py, this module holds pure logic shared beyond generation:
gen_phrase.py consumes it for daily puzzles, and the benchmark's curriculum
dataset builder (#84) imports it without pulling gensim/numpy. Moving code here
is a pure extraction — the ONE definition of target location, display tokens,
rank maps, and the hole schema lives here now; do not fork it back.
"""

import re

from slug import slug

# Generation-only knob: cap each secret's rank map to its K nearest words (the
# secret itself is always kept at rank 0). The front treats "absent from this
# map" as cold, so K bounds how far a guess can still register as "warm". Easy to
# change here; the front never sees K and stays K-agnostic.
TOP_K = 10_000

# char_class: allowed alphabet. It is used BOTH to validate a vocab token
# (token_regex) and to clean a word (normalize), to stay consistent.
# For "en", char_class = "a-z" keeps ASCII letters only (the GloVe alphabet).
LANG_CHAR_CLASSES = {
    "en": "a-z",
    "fr": "a-zàâäéèêëîïôöùûüÿçœæ",
}


def build_lang_config():
    """Per-language regex config (fresh dicts, so callers may annotate them)."""
    config = {}
    for lang, cc in LANG_CHAR_CLASSES.items():
        cfg = {"char_class": cc}
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
        config[lang] = cfg
    return config


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
    """Find the word-core inside a display token whose slug == target_slug.

    Returns (secret_display, prefix, suffix) — the matched core (accents kept, no
    punctuation) plus the display text before/after it (a leading clitic like "t'" /
    opening punctuation, and trailing punctuation). Returns None when no core in the
    token matches, so a secret can be located inside "t'attends" / "rien," while the
    token stays intact for display. The core is a pure word, so slug/fold are unchanged
    and the player still types only letters."""
    for m in cfg["core_re"].finditer(token):
        if slug(m.group()) == target_slug:
            return m.group(), token[:m.start()], token[m.end():]
    return None


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


def make_hole(secret, prefix, suffix, pos, start_display, start_rank):
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
