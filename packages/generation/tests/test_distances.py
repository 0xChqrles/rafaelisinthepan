"""CONTRACT: `dq` + `road` annotations in rank maps (#115, AGENTS.md "Per-puzzle
JSON schema").

  - dq quantizes the group's cosine distance to the secret onto one byte, per hole:
    rank 1 -> 255, the LAST kept group -> 0, non-increasing in between;
  - the per-hole affine map is lossless for the consumer: ratios of similarity
    DIFFERENCES survive it (that is what the client's journey ratio uses);
  - the secret's own entry (rank 0) carries NO dq — the terminus is off-scale;
  - a flat neighborhood (s1 == smin) is a HARD error, never silent all-zero dq;
  - dq/road are GROUP properties: every alias key of a lemma group carries them, and
    slug-collision resolution keeps the winning group's values;
  - roads cluster the journey — the DEPARTURE and every group closer than it, the start
    word included — deterministically, numbered by their closest member's rank (the road
    holding rank 1 is road 0); ROAD_TOP is only the ceiling on that zone;
  - a neighborhood with no honest split falls back to ONE road (all zeros);
  - --no-roads emits no road field at all, dq is unaffected (scoring depends on it).

Synthetic vectors only — never the real embeddings.
"""

import math

import pytest

import distances
import gen_phrase


# --- dq: quantization -----------------------------------------------------------

def test_rank_one_is_pinned_at_255_and_the_last_group_at_zero():
    dq = distances.quantize_dq([0.90, 0.72, 0.51, 0.30])

    assert dq[0] == 255
    assert dq[-1] == 0
    assert all(isinstance(v, int) for v in dq)


def test_dq_is_non_increasing_with_rank():
    # A clumpy neighborhood: a tight pair, then a cliff, then a long flat tail.
    sims = [0.90, 0.89, 0.60, 0.59, 0.585, 0.58]
    dq = distances.quantize_dq(sims)

    assert dq == sorted(dq, reverse=True)
    # the cliff is VISIBLE in dq — that is the whole point of shipping it: the two
    # steps inside the clump cost far less of the byte than the single step across.
    assert dq[1] - dq[2] > (dq[0] - dq[1]) * 10


def test_affine_normalization_preserves_similarity_difference_ratios():
    # The client computes its journey ratio from dq alone; it must equal the ratio it
    # WOULD have computed from raw similarities, to within the 1/255 quantum.
    sims = [0.91, 0.83, 0.74, 0.66, 0.51, 0.40, 0.22]
    dq = distances.quantize_dq(sims)
    start = 4  # index of the start group (any rank in the band)

    for i in range(len(sims)):
        from_dq = (dq[i] - dq[start]) / (255 - dq[start])
        from_sims = (sims[i] - sims[start]) / (sims[0] - sims[start])
        assert math.isclose(from_dq, from_sims, abs_tol=2 / 255)


def test_flat_neighborhood_is_a_hard_error_not_all_zero_dq():
    with pytest.raises(ValueError, match="flat"):
        distances.quantize_dq([0.5, 0.5, 0.5])
    # a single group is the same degeneracy (it is both nearest and farthest)
    with pytest.raises(ValueError, match="flat"):
        distances.quantize_dq([0.7])


def test_a_walk_that_is_not_closest_first_is_rejected():
    with pytest.raises(ValueError, match="closest-first"):
        distances.quantize_dq([0.5, 0.8, 0.2])


# --- roads: clustering the near neighborhood ------------------------------------

def _cloud(center, n, spread=0.01):
    """n distinct unit-ish vectors bunched around `center` (deterministic, no rng)."""
    out = []
    for i in range(n):
        v = list(center)
        v[i % len(center)] += spread * (i + 1)
        out.append(v)
    return out


def _two_clear_clusters():
    # Two well-separated directions in 4-D: the silhouette of k=2 is unmistakable.
    return _cloud([1.0, 0.0, 0.0, 0.0], 6) + _cloud([0.0, 1.0, 0.0, 0.0], 6)


def test_roads_split_a_two_facet_neighborhood_and_number_by_closest_member():
    roads = distances.cluster_roads(_two_clear_clusters())

    assert len(set(roads)) == 2
    assert roads[0] == 0  # the road holding rank 1 is always road 0
    assert roads[:6] == [0] * 6
    assert roads[6:] == [1] * 6
    # Numbering follows the closest member: swapping which cluster leads swaps the ids.
    swapped = distances.cluster_roads(
        _cloud([0.0, 1.0, 0.0, 0.0], 6) + _cloud([1.0, 0.0, 0.0, 0.0], 6))
    assert swapped[0] == 0 and swapped[6] == 1


def test_roads_are_deterministic_across_runs():
    vectors = _two_clear_clusters() + _cloud([0.0, 0.0, 1.0, 0.0], 6)
    assert distances.cluster_roads(vectors) == distances.cluster_roads(vectors)


def _structureless(n, dim=300):  # dim = the real embedding width
    """n deterministic pseudo-random high-dimensional vectors: no facets to find, so
    every k-split is arbitrary — the real shape of a single-facet neighborhood."""
    out, state = [], 12345
    for _ in range(n):
        v = []
        for _d in range(dim):
            state = (1103515245 * state + 12345) % 2147483648
            v.append(state / 2147483648 - 0.5)
        out.append(v)
    return out


def test_the_road_zone_is_the_journey_from_the_departure_in():
    # The roads describe the journey: ranks 1..start_rank, the DEPARTURE included — the
    # player is put down on one of the roads, not on the trunk short of them.
    assert distances.road_zone(60) == 60
    assert distances.road_zone(150) == 150
    assert distances.road_zone(1) == 1
    # ROAD_TOP is the CEILING, for a start hand-picked far outside the 50-150 band.
    assert distances.ROAD_TOP == 150
    assert distances.road_zone(3000) == 150


def test_one_road_fallback_when_no_split_is_honest():
    # No facet to name: every group shares the trunk rather than being told a lie.
    assert distances.cluster_roads(_structureless(60)) == [0] * 60
    # The threshold is what decides it: a genuinely split cloud collapses to one road
    # once the bar is raised above any achievable silhouette.
    assert distances.cluster_roads(_two_clear_clusters(), min_silhouette=1.1) == [0] * 12


# --- annotation on the shipped rank map -----------------------------------------

TABLE = {
    "vermine": ("vermine",),
    "vermines": ("vermine",),
    "privé": ("privé",),
    "privée": ("privé",),
    "chien": ("chien",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)
VSET = {"vermine", "vermines", "privé", "privée", "chien"}
KV = {
    "vermine": [1.0, 0.0, 0.0],
    "vermines": [1.0, 0.01, 0.0],
    "privée": [0.0, 1.0, 0.0],
    "chien": [0.0, 0.0, 1.0],
}


def _long_map(n=200):
    """A shipped rank map of `n` groups, with the vectors the roads need. Words are
    letters-only so each one is its own slug key, and the two facets alternate so any
    zone the clustering is handed has an honest split to find."""
    letters = "abcdefghijklmnopqrst"
    words = [letters[i // 10] + letters[i % 10] for i in range(n)]
    ranking = [(w, i, 0.9 - i * 0.001) for i, w in enumerate(words)]
    kv = {w: [1.0, 0.0, 0.0] if i % 2 else [0.0, 1.0, 0.0] for i, w in enumerate(words)}
    merged, rmap, _groups = gen_phrase.build_puzzle_rank_map("secret", ranking, {}, {},
                                                         set(words))
    return words, merged, rmap, kv


def test_every_alias_key_of_a_group_carries_the_group_dq_and_road():
    ranking = [("privée", 0, 0.80), ("chien", 1, 0.40)]
    merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, TABLE, FORMS, VSET)
    gen_phrase.annotate_roads(rmap, merged, KV, start_rank=2)

    # privée is the walked canonical, privé an alias never seen in the walk: same group,
    # so the same rank AND the same annotations.
    assert rmap["privee"]["rank"] == rmap["prive"]["rank"] == 1
    assert rmap["prive"]["dq"] == rmap["privee"]["dq"] == 255
    assert rmap["prive"]["road"] == rmap["privee"]["road"] == 0
    assert rmap["chien"]["dq"] == 0


def test_the_secret_entry_carries_no_dq_and_no_road():
    ranking = [("privée", 0, 0.80), ("chien", 1, 0.40)]
    merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, TABLE, FORMS, VSET)
    gen_phrase.annotate_roads(rmap, merged, KV, start_rank=2)

    # the secret and its own inflections all sit at rank 0 — the terminus, off-scale.
    for key in ("vermine", "vermines"):
        assert rmap[key]["rank"] == 0
        assert "dq" not in rmap[key]
        assert "road" not in rmap[key]


def test_slug_collision_keeps_the_winning_group_annotations():
    # "côté" (rank 1) and "coté" (rank 2) collide on the slug "cote": the smallest rank
    # wins, and it must bring ITS dq — not the loser's.
    table = {"côté": ("côté",), "coté": ("coté",), "chien": ("chien",)}
    forms = gen_phrase.invert_lemmas(table)
    ranking = [("côté", 0, 0.80), ("coté", 1, 0.60), ("chien", 2, 0.40)]
    _merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, table, forms, {"côté", "coté", "chien"})

    assert rmap["cote"] == {"word": "côté", "rank": 1, "dq": 255}


def test_roads_stop_at_the_departure():
    # The line is a journey: it begins where the puzzle put the player down, so the
    # roads cover the departure and everything ahead of it, and nothing behind.
    words, merged, rmap, kv = _long_map()
    gen_phrase.annotate_roads(rmap, merged, kv, start_rank=60)

    assert "road" in rmap[words[0]]  # rank 1
    assert "road" in rmap[words[59]]  # rank 60 IS the departure: it rides a road
    assert "road" not in rmap[words[60]]  # rank 61: behind the player, one trunk
    assert "road" not in rmap[words[149]]  # nothing out in the far field either
    assert all("dq" in rmap[w] for w in words)  # dq has no such cutoff


def test_the_road_ceiling_still_bounds_a_start_picked_outside_the_band():
    # choose_start accepts any word of the map, so a hand-picked far start must not
    # hand the clustering thousands of points (nor ship a road on each).
    words, merged, rmap, kv = _long_map()
    gen_phrase.annotate_roads(rmap, merged, kv, start_rank=190)

    assert "road" in rmap[words[149]]  # rank 150 = ROAD_TOP
    assert "road" not in rmap[words[150]]  # rank 151


def test_no_roads_flag_drops_roads_but_keeps_dq():
    # --no-roads reaches annotate_roads as "no vectors to cluster with".
    ranking = [("privée", 0, 0.80), ("chien", 1, 0.40)]
    merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, TABLE, FORMS, VSET)
    gen_phrase.annotate_roads(rmap, merged, None, start_rank=2)

    assert all("road" not in entry for entry in rmap.values())
    assert rmap["privee"]["dq"] == 255 and rmap["chien"]["dq"] == 0


def test_a_flat_walk_aborts_generation_instead_of_shipping_zero_distances(capsys):
    ranking = [("privée", 0, 0.5), ("chien", 1, 0.5)]
    with pytest.raises(SystemExit):
        gen_phrase.build_puzzle_rank_map("vermine", ranking, TABLE, FORMS, VSET)
    assert "vermine" in capsys.readouterr().err
