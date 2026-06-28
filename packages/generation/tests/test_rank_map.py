"""CONTRACT: build_rank_map() shape + slug-collision rule (AGENTS.md "Per-puzzle
JSON schema").

  - secret keyed at rank 0;
  - ranks keyed by SECRET slug, inner keys by INPUT slug -> {word, rank};
  - rank semantics: secret 0, nearest neighbor 1, farther = larger;
  - slug collision keeps the SMALLEST-rank entry (built closest-first), keeps its
    accented display `word`, and warns.
"""

import gen_phrase  # noqa: E402


def test_secret_at_rank_zero_keys_are_input_slugs_values_keep_accents():
    # ranking is closest-first (rank index 0..), stored as rank index + 1.
    ranking = [("chien", 0, 0.9), ("félin", 1, 0.8)]
    rmap = gen_phrase.build_rank_map("chat", ranking)

    # secret keyed by its slug, at rank 0 (perfect)
    assert rmap["chat"] == {"word": "chat", "rank": 0}
    # neighbors keyed by INPUT slug; rank = neighbor index + 1
    assert rmap["chien"] == {"word": "chien", "rank": 1}
    # key is the SLUG (ascii), value keeps the accented display word
    assert rmap["felin"] == {"word": "félin", "rank": 2}
    assert "félin" not in rmap  # never key by the displayed form


def test_slug_collision_keeps_smallest_rank_and_warns(capsys):
    # closest-first: secret "chat" (0), then "côté" (rank 1), then "coté" (rank 2);
    # the latter two both slug to "cote".
    ranking = [("côté", 0, 0.9), ("coté", 1, 0.8)]
    rmap = gen_phrase.build_rank_map("chat", ranking)

    # the first-seen (smallest rank) wins; its accented form is kept for display
    assert rmap["cote"] == {"word": "côté", "rank": 1}
    # exactly one entry survives for the colliding slug
    assert list(rmap).count("cote") == 1
    # the discard is surfaced (warning on stderr)
    assert "collision" in capsys.readouterr().err.lower()
