"""Distance annotations for a puzzle's rank maps (#115): `dq` and `road`.

Ranks are dense and uniformly spaced by construction, so they erase the real geometry
of a secret's neighborhood — the clumps and the cliffs. Cosine distance carries that
texture, and it is only available HERE: the client never sees vectors. So generation
ships two extra group properties inside the existing per-puzzle JSON:

  - `dq`  — the group's distance to the secret, quantized to one byte;
  - `road`— which semantic cluster of the near neighborhood the group belongs to.

Stdlib-only, like slug.py: this module is pure arithmetic over plain float sequences
(anything indexable works, numpy rows included), so the contract tests keep running
without numpy/gensim, and the 150-point clustering costs a fraction of a second.
"""

import math

# One byte per group: rank 1 (the closest group) is pinned at DQ_MAX, the farthest
# kept group at 0. See quantize_dq for why the per-hole affine map is lossless.
DQ_MAX = 255

# `road` covers only the near neighborhood — the zone where the routes to the secret
# actually fork. Beyond it the far field is undifferentiated and reads as one trunk.
ROAD_TOP = 150
# Candidate cluster counts, evaluated by mean silhouette; below the threshold the
# neighborhood has no honest split and gets ONE road (some words genuinely have a
# single facet, and forcing a split there would teach a falsehood in the UI).
ROAD_KS = (2, 3, 4)
ROAD_MIN_SILHOUETTE = 0.05


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


# --- Roads: clusters of the near neighborhood ----------------------------------
# "Several roads lead to the word": the top-ROAD_TOP groups are clustered by cosine
# distance so the route visualization can show the forks. Everything below is
# deterministic — average-linkage agglomerative clustering with index-ordered tie
# breaking, no random init — so regenerating a puzzle yields the same road ids.

def _unit(vec):
    """A length-1 copy of one vector (rows arrive raw from the embedding)."""
    v = [float(x) for x in vec]
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        raise ValueError("cannot cluster a zero vector")
    return [x / norm for x in v]


def _distance_matrix(vectors):
    """Full pairwise cosine-distance matrix (1 - cosine similarity), clamped to >= 0
    so float error on identical vectors cannot produce a negative distance."""
    units = [_unit(v) for v in vectors]
    n = len(units)
    dist = [[0.0] * n for _ in range(n)]
    for i in range(n):
        ui = units[i]
        for j in range(i + 1, n):
            uj = units[j]
            d = 1.0 - sum(a * b for a, b in zip(ui, uj))
            if d < 0.0:
                d = 0.0
            dist[i][j] = dist[j][i] = d
    return dist


def _labels_of(alive, members, n):
    """Cluster labels per point, numbered by the cluster's smallest member index."""
    labels = [0] * n
    for cluster, root in enumerate(alive):
        for member in members[root]:
            labels[member] = cluster
    return labels


def _linkage_labelings(dist, ks):
    """Average-linkage agglomerative clustering, snapshotting the labels at each k.

    Merges the closest pair (Lance-Williams average update) until min(ks) clusters
    remain, recording the labeling every time the live cluster count is one of `ks`.
    Ties pick the lowest index pair, so the whole cascade is deterministic.
    """
    n = len(dist)
    wanted = {k for k in ks if 2 <= k <= n}
    if not wanted:
        return {}
    stop = min(wanted)

    dm = [row[:] for row in dist]
    members = [[i] for i in range(n)]
    alive = list(range(n))  # stays sorted: a merge always keeps the smaller index
    out = {}
    if n in wanted:
        out[n] = _labels_of(alive, members, n)
    while len(alive) > stop:
        best = None
        for a in range(len(alive)):
            row = dm[alive[a]]
            for b in range(a + 1, len(alive)):
                d = row[alive[b]]
                if best is None or d < best[0]:
                    best = (d, a, b)
        _d, a, b = best
        i, j = alive[a], alive[b]
        ni, nj = len(members[i]), len(members[j])
        for k in alive:
            if k == i or k == j:
                continue
            merged = (ni * dm[i][k] + nj * dm[j][k]) / (ni + nj)
            dm[i][k] = dm[k][i] = merged
        members[i] = members[i] + members[j]
        alive.pop(b)
        if len(alive) in wanted:
            out[len(alive)] = _labels_of(alive, members, n)
    return out


def _silhouette(dist, labels):
    """Mean silhouette of a labeling (singleton clusters contribute 0, by convention)."""
    clusters = {}
    for i, label in enumerate(labels):
        clusters.setdefault(label, []).append(i)
    if len(clusters) < 2:
        return -1.0
    total = 0.0
    for i, label in enumerate(labels):
        own = clusters[label]
        if len(own) == 1:
            continue
        a = sum(dist[i][j] for j in own if j != i) / (len(own) - 1)
        b = min(
            sum(dist[i][j] for j in other) / len(other)
            for lbl, other in clusters.items()
            if lbl != label
        )
        widest = max(a, b)
        if widest > 0:
            total += (b - a) / widest
    return total / len(labels)


def _renumber_by_first_appearance(labels):
    """Renumber clusters by their closest member's rank.

    `labels` arrives in rank order, so first appearance IS closest member: the road
    holding the rank-1 group becomes road 0, the next-closest-led road 1, and so on.
    """
    mapping = {}
    out = []
    for label in labels:
        if label not in mapping:
            mapping[label] = len(mapping)
        out.append(mapping[label])
    return out


def cluster_roads(vectors, ks=ROAD_KS, min_silhouette=ROAD_MIN_SILHOUETTE):
    """Road id per input vector, which must arrive in ascending rank order.

    Evaluates k in `ks` by mean silhouette and keeps the best (ties -> the smaller k).
    When the best split is weaker than `min_silhouette` the neighborhood has no honest
    fork and everything falls back to ONE road (all zeros) — mandatory, not an escape
    hatch. Road ids are then renumbered by closest member (see above).
    """
    n = len(vectors)
    if n < 2:
        return [0] * n
    dist = _distance_matrix(vectors)
    labelings = _linkage_labelings(dist, ks)
    best_score, best_labels = None, None
    for k in sorted(labelings):
        score = _silhouette(dist, labelings[k])
        if best_score is None or score > best_score:  # strict: ties keep the smaller k
            best_score, best_labels = score, labelings[k]
    if best_labels is None or best_score < min_silhouette:
        return [0] * n
    return _renumber_by_first_appearance(best_labels)
