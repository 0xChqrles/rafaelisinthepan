"""
Start-word (hint) selection for the puzzle generator.

The "start" word is the hint shown at a hole before the player guesses: close enough
to be a foothold, far enough that it is not the answer, and never a trivial
morphological variant of the secret.
"""

# SHIPPED-rank band for the START word, on EVERY map, static or contextual. Too low =
# the player has almost already won; too high = they start too far away. One band
# because players' guesses land as close on a contextual map as on a static one, so a
# rank means the same distance on either; it tops out at the judge's pairwise-ordered
# front (contextual_rank.PAIRWISE_TOP), past which its order is loosest. The curation
# package reads the same constant on the ranks a puzzle ships.
START_BAND = (100, 200)


def is_variant(a, b):
    """Coarse filter for morphological variants: chair/chairs, walk/walking."""
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    return long.startswith(short) and len(long) - len(short) <= 3


def start_band(secret, ranking):
    """The pool of start-word candidates as (word, shipped rank) pairs, nearest-first.

    `ranking` is a list of (word, position, similarity) nearest-first — the merge
    walk's `merged` — whose 0-based position is one below the rank the map ships (the
    secret holds rank 0). The band is START_BAND on the SHIPPED rank, and each pair
    carries that rank. Morphological variants of the secret are never offered; when
    the band is empty, every non-variant word is. This is the single definition of
    the band — choose_start and the interactive selector both consume it.
    """
    lo, hi = START_BAND
    shipped = [(w, r + 1) for (w, r, _) in ranking if not is_variant(w, secret)]
    return [(w, r) for (w, r) in shipped if lo <= r <= hi] or shipped
