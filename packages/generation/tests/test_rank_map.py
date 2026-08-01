"""CONTRACT: rank-map shape + slug-collision rule (AGENTS.md "Per-puzzle
JSON schema"), asserted through the one assembly both authoring paths use.

  - secret keyed at rank 0;
  - ranks keyed by SECRET slug, inner keys by INPUT slug -> {word, rank};
  - rank semantics: secret 0, nearest group 1, farther = larger;
  - slug collision keeps the SMALLEST-rank entry (built closest-first), keeps its
    accented display `word`, and resolves SILENTLY (no collision output). Since
    #134 the loser consumes no rank either: a group with no key left dissolves.
"""

import gen_phrase  # noqa: E402


def _build(secret, ranking):
    # An empty lemma table: every surface is its own singleton clean lexeme, so
    # this exercises the bare map shape with no grouping in the way.
    return gen_phrase.build_merged_rank_map(secret, ranking, {}, {}, set())


def test_secret_at_rank_zero_keys_are_input_slugs_values_keep_accents():
    # ranking is closest-first (rank index 0..), stored as rank index + 1.
    _merged, rmap, _groups = _build("chat", [("chien", 0, 0.9), ("félin", 1, 0.8)])

    # secret keyed by its slug, at rank 0 (perfect)
    assert rmap["chat"] == {"word": "chat", "rank": 0}
    # neighbors keyed by INPUT slug; rank = group index + 1
    assert rmap["chien"] == {"word": "chien", "rank": 1}
    # key is the SLUG (ascii), value keeps the accented display word
    assert rmap["felin"] == {"word": "félin", "rank": 2}
    assert "félin" not in rmap  # never key by the displayed form


def test_slug_collision_keeps_smallest_rank_silently(capsys):
    # closest-first: secret "chat" (0), then "côté" (rank 1), then "coté" — the
    # latter two both slug to "cote".
    _merged, rmap, _groups = _build("chat", [("côté", 0, 0.9), ("coté", 1, 0.8)])

    # the first-seen (smallest rank) wins; its accented form is kept for display
    assert rmap["cote"] == {"word": "côté", "rank": 1}
    # exactly one entry survives for the colliding slug
    assert list(rmap).count("cote") == 1
    # the discard is SILENT: nothing is printed to stdout or stderr
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
