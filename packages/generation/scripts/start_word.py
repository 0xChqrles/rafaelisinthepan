"""
Start-word (hint) selection for the puzzle generator.

The "start" word is the hint shown at a hole before the player guesses: close enough
to be a foothold, far enough that it is not the answer, and never a trivial
morphological variant of the secret.
"""

import random

# Rank band for the START word. Too low = the player has almost already won; too
# high = they start too far away. 100-200 on EVERY map, static or contextual
# (user-decided 2026-09-24; was 100-150, and 250-400 on a contextual map). The
# contextual band assumed a reranked rank "sits closer in sense"; real play says no:
# replayed on the Jev days, players' guesses landed as close on the contextual map as
# on a static rebuild, so 250-400 put the start 2-3x farther than 100-150 — and past
# the judge's pairwise-ordered top (PAIRWISE_TOP), where its order is loosest.
START_RANK_MIN = 100
START_RANK_MAX = 200
START_BAND = (START_RANK_MIN, START_RANK_MAX)


def is_variant(a, b):
    """Coarse filter for morphological variants: chair/chairs, run/running."""
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    return long.startswith(short) and len(long) - len(short) <= 3


def start_band(secret, ranking, band=START_BAND):
    """The pool of start-word candidates as (word, rank) pairs, nearest-first.

    Words in the rank band `band` = (min, max), START_BAND by default, that are not
    morphological variants of the secret; falls back to all non-variant words when the band is empty. This is the
    single definition of the band — pick_start and the interactive chooser both
    consume it, so the selection logic stays in sync.

    `ranking` is a list of (word, rank, similarity) nearest-first (as returned by
    closest()).
    """
    lo, hi = band
    band = [(w, r) for (w, r, _) in ranking
            if lo <= r <= hi and not is_variant(w, secret)]
    if not band:
        band = [(w, r) for (w, r, _) in ranking if not is_variant(w, secret)]
    return band


def pick_start(secret, ranking, band=START_BAND):
    """
    Choose the word displayed at the start: a word in the rank band that is not a
    variant of the secret. Fall back to a distant word if the band is empty, and to
    the secret itself if nothing qualifies.

    Uses the module-global RNG, so seed it in the caller for reproducible start
    words.
    """
    band = start_band(secret, ranking, band)
    return random.choice(band)[0] if band else secret
