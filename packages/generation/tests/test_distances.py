"""CONTRACT: the `dq` annotation in rank maps (#115, AGENTS.md "Per-puzzle
JSON schema").

  - dq quantizes the group's cosine distance to the secret onto one byte, per hole:
    rank 1 -> 255, the LAST kept group -> 0, non-increasing in between;
  - the per-hole affine map is lossless for the consumer: ratios of similarity
    DIFFERENCES survive it (that is what the client's journey ratio uses);
  - the secret's own entry (rank 0) carries NO dq — the terminus is off-scale;
  - a flat neighborhood (s1 == smin) is a HARD error, never silent all-zero dq;
  - dq is a GROUP property: every alias key of a lemma group carries it, and
    slug-collision resolution keeps the winning group's value.

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


def test_every_alias_key_of_a_group_carries_the_group_dq():
    ranking = [("privée", 0, 0.80), ("chien", 1, 0.40)]
    _merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, TABLE, FORMS, VSET)

    # privée is the walked canonical, privé an alias never seen in the walk: same group,
    # so the same rank AND the same annotations.
    assert rmap["privee"]["rank"] == rmap["prive"]["rank"] == 1
    assert rmap["prive"]["dq"] == rmap["privee"]["dq"] == 255
    assert rmap["chien"]["dq"] == 0


def test_the_secret_entry_carries_no_dq():
    ranking = [("privée", 0, 0.80), ("chien", 1, 0.40)]
    _merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, TABLE, FORMS, VSET)

    # the secret and its own inflections all sit at rank 0 — the terminus, off-scale.
    for key in ("vermine", "vermines"):
        assert rmap[key]["rank"] == 0
        assert "dq" not in rmap[key]


def test_slug_collision_keeps_the_winning_group_annotations():
    # "côté" (rank 1) and "coté" (rank 2) collide on the slug "cote": the smallest rank
    # wins, and it must bring ITS dq — not the loser's.
    table = {"côté": ("côté",), "coté": ("coté",), "chien": ("chien",)}
    forms = gen_phrase.invert_lemmas(table)
    ranking = [("côté", 0, 0.80), ("coté", 1, 0.60), ("chien", 2, 0.40)]
    _merged, rmap, _groups = gen_phrase.build_puzzle_rank_map(
        "vermine", ranking, table, forms, {"côté", "coté", "chien"})

    assert rmap["cote"] == {"word": "côté", "rank": 1, "dq": 255}


def test_a_flat_walk_aborts_generation_instead_of_shipping_zero_distances(capsys):
    ranking = [("privée", 0, 0.5), ("chien", 1, 0.5)]
    with pytest.raises(SystemExit):
        gen_phrase.build_puzzle_rank_map("vermine", ranking, TABLE, FORMS, VSET)
    assert "vermine" in capsys.readouterr().err
