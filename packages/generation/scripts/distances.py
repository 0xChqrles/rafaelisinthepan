"""Distance annotations for a puzzle's rank maps (#115): `dq`.

Ranks are dense and uniformly spaced by construction, so they erase the real geometry
of a secret's neighborhood — the clumps and the cliffs. Cosine distance carries that
texture, and it is only available HERE: the client never sees vectors. So generation
ships the group's distance to the secret, quantized to one byte, inside the existing
per-puzzle JSON.

Stdlib-only, like slug.py: this module is pure arithmetic over plain float sequences
(anything indexable works, numpy rows included), so the contract tests keep running
without numpy/gensim.
"""

# One byte per group: rank 1 (the closest group) is pinned at DQ_MAX, the farthest
# kept group at 0. See quantize_dq for why the per-hole affine map is lossless.
DQ_MAX = 255


def quantize_dq(sims, dq_max=DQ_MAX):
    """Quantize one secret's group similarities into per-rank `dq` bytes.

    `sims` are the cosine similarities of the ranked groups in closest-first order
    (rank 1..N); the secret itself is NOT in the list — it is the terminus, off-scale
    by nature (its similarity is the degenerate 1.0). With s1 = the rank-1 similarity
    and smin = the last kept group's:

        dq = round(dq_max * (s - smin) / (s1 - smin))     # rank 1 -> 255, last -> 0

    The per-hole affine normalization is deliberate and lossless for consumers: the
    scoring built on top uses only RATIOS of similarity differences, which an affine
    map preserves exactly — so with rank 1 pinned at dq_max the client's journey ratio
    is (dq - dq_start) / (dq_max - dq_start), no floats shipped. Resolution 1/255 is
    ~0.4% of the journey.

    Raises ValueError on a walk that cannot be quantized: similarities that are not
    non-increasing (the walk and the quantization desynced) or a flat span
    (s1 == smin), which cannot happen on real vectors and would poison scoring if it
    silently produced all-zero dq.
    """
    values = [float(s) for s in sims]
    if not values:
        return []
    for i in range(1, len(values)):
        if values[i] > values[i - 1]:
            raise ValueError(
                "similarities are not closest-first (rank "
                f"{i} is closer than rank {i - 1})"
            )
    span = values[0] - values[-1]
    if span <= 0:
        raise ValueError(
            "flat neighborhood: the nearest and farthest kept groups have the same "
            f"similarity ({values[0]})"
        )
    out = [round(dq_max * (s - values[-1]) / span) for s in values]
    # The quantization is monotone on a non-increasing input, so this only fires if
    # the arithmetic above ever stops agreeing with the walk.
    for i in range(1, len(out)):
        if out[i] > out[i - 1]:
            raise ValueError(f"dq increased with rank at {i}: {out[i - 1]} -> {out[i]}")
    return out
