"""CONTRACT: the single-word artifact (#154) — ONE word + its ranked neighborhood.

Asserted against the schema in AGENTS.md, not against the implementation:

  - shape: `lang`, `word` as a {word, slug} pair, and ONE FLAT `ranks` map. No
    `words` / `holes` / `start` / `start_rank` (there is no sentence) and no `source`
    (a lone word has no attribution);
  - the sentence schema's rank semantics, unchanged: rank 0 is the word itself and
    carries NO `dq`, every rank >= 1 entry carries one, and word/rank/dq/freq are
    GROUP properties every alias key of the group repeats;
  - `freq` (#163), this artifact's OWN annotation: the 1-based position, in the
    frequency-ordered EXISTENCE SET (distinct slugs, which is what the client loads),
    of the group's most frequent OWNED KEY — the commonest thing a player can type to
    claim it, never a surface another group owns — a group property like the rest, on
    every entry including rank 0, and emitted by this command alone (a sentence puzzle
    has no consumer for it);
  - NO `road`, ever (2026-08-10; the `--roads` opt-in retired 2026-08-11 with the
    tutorial's themes lesson, its only consumer). Word mode paints station words by
    RARITY on one trunk, so a word artifact ships no semantic clustering at all — the road rules
    are the sentence path's alone (test_distances.py);
  - the rank map is the SAME artifact the sentence pipeline builds for that secret.
    Both commands walk through gen_phrase.walk_secret, so a word's neighborhood can
    never differ by which game asked for it.
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


def _word_map(word, ranking, kv, vset=VSET, table=TABLE, forms=FORMS, vocab=None):
    """gen_word's shipped rank map for `word`.

    `vocab` is V — the reduced vocabulary in FREQUENCY order, which is what `freq`
    reads positions out of. Tests that do not care about rarity leave it unordered."""
    module = _Embedding(ranking)
    return gen_word.build_word_map(word, word, {"module": module}, kv,
                                   list(vset) if vocab is None else vocab,
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


def test_no_semantic_roads_are_emitted_but_dq_stays():
    """Word mode paints station words by RARITY on one trunk (#163), so a word
    artifact has no consumer for semantic clustering and never runs it — no opt-in remains
    (the tutorial's themes lesson, `--roads`' one reader, retired 2026-08-11). `dq`
    has no opt-out — the drawing spaces its stations by it, and scoring depends on
    it."""
    rank_map = _word_map("chat", RANKING, KV)

    assert all("road" not in entry for entry in rank_map.values())
    assert rank_map["chien"]["dq"] == 255 and rank_map["felin"]["dq"] == 0


# --- freq: the group's corpus rarity, what Word mode's clock pays by (#163) ------

# The reduced vocabulary in FREQUENCY order. Built so that one group's commonest
# key is NOT its representative: félins (position 6) outranks félin (position 8),
# which is the whole point of "most frequent owned key, not the representative".
FREQ_VOCAB = ["chat", "chien", "noir", "chiens", "dort", "félins", "chats", "félin"]


def test_freq_is_the_group_most_frequent_owned_key_one_based():
    rank_map = _word_map("chat", RANKING, KV, vocab=FREQ_VOCAB)

    # 1-based, so the commonest word the game admits is 1 and never a falsy 0.
    assert rank_map["chat"]["freq"] == 1                       # chat, position 1
    assert rank_map["chien"]["freq"] == 2                      # chien, position 2
    # félin's group: its representative sits at position 8, but the group is as
    # common as its commonest typable key — félins, position 6.
    assert rank_map["felin"]["freq"] == 6
    assert rank_map["felin"]["word"] == "félin"                # display is untouched


def test_freq_prices_a_group_by_its_owned_keys_never_a_stolen_surface():
    """« bois » embeds both the tree and « je bois », but the walk keys an ambiguous
    surface to ONE group, closest-first (#104/#134). Pricing must read that settled
    ownership: grading « boire » by « bois »'s position would call a rare lexeme
    COMMON by a word that can never claim it, and the error only ever runs cheaper
    (min over a superset). Unit-level on the settled map, because ownership is the
    walk's job and already tested there."""
    rank_map = {
        "bois": {"word": "bois", "rank": 1, "dq": 255},
        "boire": {"word": "boire", "rank": 2, "dq": 128},
        "buvait": {"word": "boire", "rank": 2, "dq": 128},
        "arbre": {"word": "arbre", "rank": 3, "dq": 0},
    }
    gen_word.annotate_freq(rank_map, ["bois", "boire", "buvait", "arbre"])

    assert rank_map["bois"]["freq"] == 1
    # boire's group is priced over ITS keys (boire 2, buvait 3) — never bois's 1.
    assert rank_map["boire"]["freq"] == 2
    assert rank_map["buvait"]["freq"] == 2                     # alias repeats the group's
    assert rank_map["arbre"]["freq"] == 4


def test_a_group_with_no_key_in_the_existence_set_ships_no_freq():
    """The borrowed-vector case (#119): a secret whose slug embeds nothing has no
    position to read, so its entry simply has no `freq` — the field is OPTIONAL to
    consumers, which floor an unknown rarity at COMMON rather than minting a
    windfall (web/src/game/wordGame.ts rarityOf)."""
    rank_map = {
        "zzyzx": {"word": "zzyzx", "rank": 0},
        "chat": {"word": "chat", "rank": 1, "dq": 255},
    }
    gen_word.annotate_freq(rank_map, ["chat", "chien"])

    assert "freq" not in rank_map["zzyzx"]
    assert rank_map["chat"]["freq"] == 1


def test_freq_is_a_group_property_every_alias_key_repeats():
    rank_map = _word_map("chat", RANKING, KV, vocab=FREQ_VOCAB)

    # Like word/rank/dq: one value per group, on every key that reaches it —
    # including the word's own rank-0 aliases, which carry no dq.
    assert rank_map["chat"] == rank_map["chats"]
    assert rank_map["chien"] == rank_map["chiens"]
    assert rank_map["felin"] == rank_map["felins"]
    assert all("freq" in entry for entry in rank_map.values())


def test_freq_ranks_the_existence_set_not_the_raw_forms():
    """The consumer divides `freq` by the size of the existence set it loaded, so the
    numerator has to count that same population. Two forms that FOLD TOGETHER are one
    entry there and must be one rank here — otherwise the fraction is not a fraction,
    and it is wrong by a language-dependent amount (measured 4.1% in fr, 0.0% in en)."""
    # « coté » and « côté » are two reduced forms and ONE slug, so everything after them
    # in frequency order shifts down by exactly one against a raw-form ranking.
    vocab = ["chat", "coté", "côté", "chien", "chiens", "félin", "félins", "chats"]
    rank_map = _word_map("chat", RANKING, KV, vocab=vocab)

    # chat 1, cote 2 (both spellings), chien 3 — not 4, which is what counting raw
    # forms would give.
    assert rank_map["chat"]["freq"] == 1
    assert rank_map["chien"]["freq"] == 3
    # And no group can be ranked past the existence set it is a position in — the
    # denominator pinned by ITS producer's own expression (slug.write_vocab), so the
    # two populations cannot drift apart without failing here.
    existence_set = {s for s in (slug(w) for w in vocab) if s}
    assert all(entry["freq"] <= len(existence_set) for entry in rank_map.values())


# --- parity with the sentence pipeline ------------------------------------------

def test_the_rank_map_is_the_one_the_sentence_pipeline_builds(monkeypatch):
    """One word, two games, one neighborhood.

    Drives the sentence path end to end (holes_from_words) and the word path
    (build_word_map) over the same vocabulary and the same walk, then compares the
    maps key by key. Roads are off on the sentence side too (a word artifact never
    has them), so the walks compare clean. `freq` is the one annotation only the
    word path stamps: it is asserted here as absent from the sentence map and
    stripped from the word map before the comparison.
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
        lemma_table=TABLE, forms_by_lemma=FORMS, roads=False)

    word_map = _word_map("chat", RANKING, KV)

    # A sentence puzzle carries no rarity: nothing there consumes it, and those maps
    # are already ~500 KB gzipped.
    assert all("freq" not in entry for entry in ranks["chat"].values())

    # Otherwise: same keys, same display forms, same ranks, same dq — including the
    # rank-0 inflection alias and both grouped neighbors.
    stripped = {key: {k: v for k, v in entry.items() if k != "freq"}
                for key, entry in word_map.items()}
    assert ranks["chat"] == stripped
