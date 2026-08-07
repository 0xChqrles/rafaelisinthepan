"""Distance annotations for a puzzle's rank maps (#115): `dq` and `road`.

Ranks are dense and uniformly spaced by construction, so they erase the real geometry
of a secret's neighborhood — the clumps and the cliffs. Cosine distance carries that
texture, and it is only available HERE: the client never sees vectors. So generation
ships two extra group properties inside the existing per-puzzle JSON:

  - `dq`  — the group's distance to the secret, quantized to one byte;
  - `road`— which semantic cluster of the travelled neighborhood the group belongs to
            (from the DEPARTURE in to the secret — see road_zone).

Stdlib-only, like slug.py: this module is pure arithmetic over plain float sequences
(anything indexable works, numpy rows included), so the contract tests keep running
without numpy/gensim, and the 250-point clustering costs a fraction of a second
(measured 0.34s at ROAD_TOP, against 0.11s at the 150 it superseded).
"""

import math

# One byte per group: rank 1 (the closest group) is pinned at DQ_MAX, the farthest
# kept group at 0. See quantize_dq for why the per-hole affine map is lossless.
DQ_MAX = 255

# `road` covers only the stretch the player actually travels: the departure and every
# group closer than it. The start word is where the puzzle puts you down — on one of the
# roads — so anything farther is behind you, and a fork out there is a fork of a route
# nobody walks (the far field reads as one trunk anyway). The extent is therefore the
# DEPARTURE's rank (see road_zone), not a constant.
#
# ROAD_TOP is only the CEILING on that zone. The start band tops out at 150
# (start_word.START_RANK_MAX), so it never bites on a band start; it exists for the
# author who hand-picks a start far outside the band, where it keeps the O(n^3)
# clustering (and the shipped road fields) bounded.
#
# It is ALSO the whole zone of a start-less single-word artifact (#154) — see road_zone —
# which is what actually sets this number: those groups are Word mode's playing field, and
# the client's CLAIM_ZONE restates it (packages/web/src/game/wordGame.ts, pinned to this
# literal by wordGame.test.ts). Raised 150 -> 250 on 2026-08-07 to give Word mode a longer
# run; a sentence hole is unaffected, since its zone is its departure's rank and the band
# tops out well below either value.
ROAD_TOP = 250
# Candidate cluster counts. Below ROAD_MIN_SILHOUETTE the neighborhood has no honest
# split and gets ONE road (some words genuinely have a single facet, and forcing a split
# there would teach a falsehood in the UI).
#
# Silhouette is the HONESTY GATE, not the ranking (decided 2026-08-07): among the splits
# that clear it, the one with the MOST roads wins. Ranking BY silhouette does not survive
# a zone this wide — measured across nine real neighborhoods at ROAD_TOP 250, the top
# score went to k=2 on eight of them, and on seven of those the winning split was one
# trunk plus a 1-3 word straggler (`ocean` 248/2, `vie` 249/1). The metric buys its score
# by isolating a tight outlier, and the wider the zone the more diffuse mass there is to
# make that trade look good — "several roads lead to the word" is the product claim, so a
# 2-way cut of 250 groups says less than the 4-way one sitting right beside it at a
# marginally lower score (`tropiques` 233/17 at k=2, against its real 113/107/17/13 at
# k=4). What stops "most roads" from manufacturing facets out of stragglers is the size
# floor below, applied BEFORE scoring.
#
# ROAD_KS caps the road count, so it is also the number of lanes the drawing must be able
# to paint: widening it past the web's LANE_COLORS would ship a road with no colour.
ROAD_KS = (2, 3, 4, 5, 6)
ROAD_MIN_SILHOUETTE = 0.05

# A road must hold at least this FRACTION of the zone, or it is not a road — it is an
# outlier, and drawing it as a lane advertises a whole route nobody can walk. Undersized
# clusters are folded back into their nearest neighbour before the silhouette is read
# (see _absorb_small_roads), which is what removes the metric's incentive to isolate one.
#
# A FRACTION, not a count, because the zone's size is not fixed: it is ROAD_TOP for a word
# artifact but the DEPARTURE's rank for a sentence hole, which can be 50. 4% is 10 groups
# at 250 and 2 at 50 — measured to clear every straggler observed (all <= 9 at 250) while
# keeping the smallest genuinely nameable facet (`tropiques`'s 13-group theme).
ROAD_MIN_FRACTION = 0.04


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


# --- Roads: clusters of the travelled neighborhood ------------------------------
# "Several roads lead to the word": the departure and every group closer than it are
# clustered by cosine distance so the route visualization can show the forks. Everything
# below is deterministic — average-linkage agglomerative clustering with index-ordered
# tie breaking, no random init — so regenerating a puzzle yields the same road ids.

def road_zone(start_rank, top=ROAD_TOP):
    """How many of the closest groups the roads cover, given the departure's rank.

    Ranks 1..start_rank, the departure INCLUDED: the player is put down ON one of the
    roads, not on the trunk short of them, so the fork happens before the first station
    of the journey rather than after it. Never more than `top` — see ROAD_TOP.

    A START-LESS artifact (a single word, #154) passes None: with no departure to stop
    at, there is no stretch to cut short and the zone IS the ceiling — the top-`top`
    groups are Word mode's whole playing field. That is the one case where ROAD_TOP
    stops being a bound on the journey and becomes the journey.
    """
    if start_rank is None:
        return top
    return max(0, min(int(start_rank), top))


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


def _absorb_small_roads(dist, labels, min_size):
    """Fold every cluster below `min_size` into its nearest surviving one.

    A handful of groups sitting slightly apart is not a road — it is an outlier, and a
    lane drawn for it claims a route that has nowhere to go. So it goes back where it
    actually belongs: repeatedly take the smallest undersized cluster and merge it into
    the cluster it is closest to by AVERAGE linkage, the same measure that built the
    tree, until every survivor clears the floor or only one is left.

    Doing this BEFORE the silhouette is read is the point (see ROAD_KS): it takes away
    the score a split could earn by isolating a tight straggler, because the straggler is
    no longer isolated by the time the split is judged.

    Ties break on the lowest cluster label, so the fold is deterministic like the rest of
    this module. Returns fresh labels; ids are renumbered by the caller as usual.
    """
    members = {}
    for i, label in enumerate(labels):
        members.setdefault(label, []).append(i)
    while len(members) > 1:
        smallest = min(members, key=lambda l: (len(members[l]), l))
        if len(members[smallest]) >= min_size:
            break
        orphans = members.pop(smallest)
        host = min(members, key=lambda l: (
            sum(dist[i][j] for i in orphans for j in members[l])
            / (len(orphans) * len(members[l])), l))
        members[host].extend(orphans)
    out = list(labels)
    for label, group in members.items():
        for i in group:
            out[i] = label
    return out


def cluster_roads(vectors, ks=ROAD_KS, min_silhouette=ROAD_MIN_SILHOUETTE,
                  min_fraction=ROAD_MIN_FRACTION):
    """Road id per input vector, which must arrive in ascending rank order.

    For each k in `ks`: cluster, fold the undersized roads back in
    (`_absorb_small_roads`), and read the mean silhouette of what is left. A split must
    clear `min_silhouette` to be considered honest at all; among those that do, the one
    with the MOST roads wins — silhouette is the gate, not the ranking (see ROAD_KS for
    the measurements behind that). Ties on both keep the smaller k.

    When nothing clears the gate the neighborhood has no honest fork and everything falls
    back to ONE road (all zeros) — mandatory, not an escape hatch. Road ids are then
    renumbered by closest member (see above).
    """
    n = len(vectors)
    if n < 2:
        return [0] * n
    # At least 2: a single group is never a road, but on a zone too short for the
    # fraction to mean anything the floor must not swallow every split.
    min_size = max(2, round(n * min_fraction))
    dist = _distance_matrix(vectors)
    labelings = _linkage_labelings(dist, ks)
    best_key, best_labels = None, None
    for k in sorted(labelings):
        labels = _absorb_small_roads(dist, labelings[k], min_size)
        roads = len(set(labels))
        if roads < 2:
            continue
        score = _silhouette(dist, labels)
        if score < min_silhouette:
            continue
        key = (roads, score)
        if best_key is None or key > best_key:  # strict: ties keep the smaller k
            best_key, best_labels = key, labels
    if best_labels is None:
        return [0] * n
    return _renumber_by_first_appearance(best_labels)
