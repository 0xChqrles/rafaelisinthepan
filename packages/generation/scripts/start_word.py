"""
Start-word (hint) selection for the puzzle generator.

The "start" word is the hint shown at a hole before the player guesses: close enough
to be a foothold, far enough that it is not the answer, and never a trivial
morphological variant of the secret.
"""

import random

# Rank band for the START word. Too low = the player has almost already won; too
# high = they start too far away. 50-150 is a good band to tune.
START_RANK_MIN = 50
START_RANK_MAX = 150


def is_variant(a, b):
    """Coarse filter for morphological variants: chair/chairs, run/running."""
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    return long.startswith(short) and len(long) - len(short) <= 3


def pick_start(secret, ranking):
    """
    Choose the word displayed at the start: a word in the rank band that is not a
    variant of the secret. Fall back to a distant word if the band is empty, and to
    the secret itself if nothing qualifies.

    `ranking` is a list of (word, rank, similarity) nearest-first (as returned by
    closest()). Uses the module-global RNG, so seed it in the caller for
    reproducible start words.
    """
    band = [(w, r) for (w, r, _) in ranking
            if START_RANK_MIN <= r <= START_RANK_MAX and not is_variant(w, secret)]
    if not band:
        band = [(w, r) for (w, r, _) in ranking if not is_variant(w, secret)]
    return random.choice(band)[0] if band else secret
