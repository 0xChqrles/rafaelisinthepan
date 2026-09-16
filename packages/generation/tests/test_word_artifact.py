"""CONTRACT: the single-word artifact (#154) — ONE word + its ranked neighborhood.

Asserted against the schema in AGENTS.md, not against the implementation:

  - shape: `lang`, `word` as a {word, slug} pair, and ONE FLAT `ranks` map. No
    `words` / `holes` / `start` / `start_rank` (there is no sentence) and no `source`
    (a lone word has no attribution);
  - the sentence schema's rank semantics, unchanged: rank 0 is the word itself and
    carries NO `dq`, every rank >= 1 entry carries one, and word/rank/dq are GROUP
    properties every alias key of the group repeats;
  - the rank map is the SAME artifact the sentence pipeline builds for that secret.
    Both commands walk through gen_phrase.walk_secret, so a word's neighborhood can
    never differ by which command built it.
"""

import gen_phrase  # noqa: E402
import gen_word  # noqa: E402
from slug import slug  # noqa: E402

# A small grouped neighborhood: two inflected groups around the word, so the walk has
# real merging to do and the parity check compares a map with alias keys in it.
TABLE = {
    "chat": ("chat",), "chats": ("chat",),
    "chien": ("chien",), "chiens": ("chien",),
    "félin": ("félin",), "félins": ("félin",),
    "noir": ("noir",), "dort": ("dort",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)
VSET = set(TABLE)
RANKING = [("chien", 0, 0.90), ("chiens", 1, 0.85),
           ("félin", 2, 0.80), ("félins", 3, 0.70)]
KV = {"chien": [1.0, 0.0, 0.0], "félin": [0.0, 1.0, 0.0]}


class _Embedding:
    """The stubbed per-language module: the pipeline only asks it for one walk."""

    def __init__(self, ranking):
        self.ranking = ranking
        self.calls = []

    def closest(self, word, _kv, _vocab, _matrix, *, n):
        self.calls.append((word, n))
        return self.ranking


def _word_map(word, ranking, kv, vset=VSET, table=TABLE, forms=FORMS):
    """gen_word's shipped rank map for `word`."""
    module = _Embedding(ranking)
    return gen_word.build_word_map(word, word, {"module": module}, kv, list(vset),
                                   object(), vset, table, forms)


# --- schema shape ---------------------------------------------------------------

def test_the_artifact_is_lang_a_word_pair_and_one_flat_rank_map():
    rank_map = _word_map("chat", RANKING, KV)
    artifact = gen_word.build_word_artifact("fr", "chat", rank_map)

    assert set(artifact) == {"lang", "word", "ranks"}
    assert artifact["lang"] == "fr"
    # {word, slug} carries BOTH, like every other pair in the schema.
    assert artifact["word"] == {"word": "chat", "slug": "chat"}
    # ONE flat map: the values are rank entries, NOT per-secret sub-maps.
    assert all(isinstance(entry, dict) and "rank" in entry
               for entry in artifact["ranks"].values())


def test_an_accented_word_keeps_its_display_form_and_folds_only_its_slug():
    rank_map = _word_map("forêt", RANKING, KV)
    artifact = gen_word.build_word_artifact("fr", "forêt", rank_map)

    # the slug is the KEY, the accented form is what the artifact displays — on the
    # word itself and on its neighbors alike
    assert artifact["word"] == {"word": "forêt", "slug": "foret"}
    assert artifact["ranks"]["foret"] == {"word": "forêt", "rank": 0}
    assert artifact["ranks"]["felin"]["word"] == "félin"
    assert "forêt" not in artifact["ranks"] and "félin" not in artifact["ranks"]


def test_rank_zero_is_the_word_itself_and_carries_no_dq():
    rank_map = _word_map("chat", RANKING, KV)

    # the word and its own inflections: rank 0, the terminus, off-scale by nature
    for key in ("chat", "chats"):
        assert rank_map[key]["rank"] == 0
        assert "dq" not in rank_map[key]
    # every OTHER entry carries a dq — it has no opt-out
    assert all("dq" in entry for entry in rank_map.values() if entry["rank"])


def test_alias_keys_of_a_group_repeat_their_group_values():
    rank_map = _word_map("chat", RANKING, KV)

    # chien/chiens are one group (#104): one rank, one display, one geometry.
    assert rank_map["chien"] == rank_map["chiens"]
    assert rank_map["chien"]["rank"] == 1
    assert rank_map["chien"]["dq"] == 255
    # the farther group is the last kept one: dq 0
    assert rank_map["felin"] == rank_map["felins"]
    assert rank_map["felin"]["rank"] == 2
    assert rank_map["felin"]["dq"] == 0


# --- parity with the sentence pipeline ------------------------------------------

def test_the_rank_map_is_the_one_the_sentence_pipeline_builds(monkeypatch):
    """One word, two commands, one neighborhood.

    Drives the sentence path end to end (holes_from_words) and the word path
    (build_word_map) over the same vocabulary and the same walk, then compares the
    maps key by key.
    """
    module = _Embedding(RANKING)
    cfg = dict(gen_phrase.CONFIG["fr"], module=module)
    monkeypatch.setattr(
        gen_phrase, "choose_start",
        lambda _secret, _ranking, _rank_map, _rbd: "chien")

    words = [gen_phrase.display_token(t) for t in "le chat noir dort".split()]
    _holes, ranks = gen_phrase.holes_from_words(
        ["chat", "noir", "dort"], words, cfg, "fr",
        kv=KV, V=list(VSET), M=object(), Vset=VSET,
        lemma_table=TABLE, forms_by_lemma=FORMS)

    word_map = _word_map("chat", RANKING, KV)

    # Same keys, same display forms, same ranks, same dq — including the rank-0
    # inflection alias and both grouped neighbors.
    assert ranks["chat"] == word_map
