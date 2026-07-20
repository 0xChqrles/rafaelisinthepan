"""CONTRACT: lemma grouping in rank maps (#104, AGENTS.md "Per-puzzle JSON schema").

  - inflected forms of one word are ONE ranked group: the closest form is canonical,
    later forms alias to its {word, rank} and consume NO rank (compaction);
  - TOP_K counts distinct GROUPS (filter-then-cap);
  - the secret is group 0, so its own inflections alias to rank 0 (they solve);
  - strict grouping: groups sharing a form do NOT transitively merge; an ambiguous
    form attaches to whichever of its groups ranked closest;
  - alias expansion covers EVERY reduced-vocab form of a surviving group, including
    forms absent from the walk, and never overwrites an existing (closer) entry;
  - the slug-collision rule is unchanged on top of merging;
  - with an empty table the output is byte-identical to the pre-#104 rank map;
  - two selected secrets in one lemma group are rejected.
"""

import sys
import types

import pytest

import gen_phrase


# Lexique-shaped table for the issue's own examples: privé (adjective) and priver
# (verb) are DISTINCT lemmas that share forms; vermine has a plural.
TABLE = {
    "privé": ("privé", "priver"),
    "privée": ("privé", "priver"),
    "privés": ("privé", "priver"),
    "priver": ("priver",),
    "privait": ("priver",),
    "vermine": ("vermine",),
    "vermines": ("vermine",),
    "porte": ("porte",),
    "portes": ("porte", "porter"),
    "porter": ("porter",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)


def test_merge_ranking_closest_form_canonical_and_ranks_compacted():
    # raw walk: privée (0), privé (1), public (2), vermines (3)
    ranking = [("privée", 0, .9), ("privé", 1, .8), ("public", 2, .7), ("vermines", 3, .6)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)

    # privé aliases into privée's group (both carry lemma privé), consuming no rank:
    # public is promoted from raw rank 2 to compacted rank 1.
    assert [(w, r) for w, r, _ in merged] == [("privée", 0), ("public", 1), ("vermines", 2)]
    assert groups[0] == ("chat", 0, ("chat",))  # the secret is group 0
    assert ("privée", 1, ("privé", "priver")) in groups


def test_merge_ranking_top_k_counts_groups_not_raw_words():
    ranking = [("privée", 0, .9), ("privé", 1, .8), ("vermine", 2, .7), ("porte", 3, .6)]
    merged, _groups = gen_phrase.merge_ranking("chat", ranking, TABLE, top_k=2)
    # privé is an alias: the cap of 2 still admits vermine (filter-then-cap).
    assert [w for w, _r, _s in merged] == ["privée", "vermine"]


def test_secret_inflections_alias_to_rank_zero():
    ranking = [("vermines", 0, .9), ("porte", 1, .8)]
    merged, groups = gen_phrase.merge_ranking("vermine", ranking, TABLE)
    rmap = gen_phrase.build_rank_map("vermine", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"vermine", "vermines", "porte"})

    # typing the plural SOLVES the hole: rank 0, canonical display form.
    assert rmap["vermines"] == {"word": "vermine", "rank": 0}
    assert rmap["vermine"] == {"word": "vermine", "rank": 0}
    assert rmap["porte"] == {"word": "porte", "rank": 1}  # compacted past the alias


def test_strict_grouping_no_transitive_merge_and_ambiguous_attaches_closest():
    # porte (rank 1) then porter (rank 2): distinct lemmas, so DISTINCT groups even
    # though "portes" is a form of both.
    ranking = [("porte", 0, .9), ("porter", 1, .8)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)
    assert [(w, r) for w, r, _ in merged] == [("porte", 0), ("porter", 1)]

    rmap = gen_phrase.build_rank_map("chat", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"porte", "portes", "porter"})
    # the ambiguous form aliases to its CLOSEST group (porte, rank 1), never porter.
    assert rmap["portes"] == {"word": "porte", "rank": 1}
    assert rmap["porter"] == {"word": "porter", "rank": 2}


def test_expand_aliases_covers_vocab_forms_absent_from_walk_and_respects_vset():
    # privait never appeared among the neighbors; it still hits privée's rank.
    ranking = [("privée", 0, .9)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)
    rmap = gen_phrase.build_rank_map("chat", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"privée", "privait"})

    assert rmap["privait"] == {"word": "privée", "rank": 1}
    # privés is a form of the group but NOT in the reduced vocab: no unreachable key.
    assert "prives" not in rmap


def test_closer_alias_wins_slug_collision_against_farther_canonical():
    # The secret "côté" has the inflection "côtés", whose slug ("cotes") collides with
    # the DISTINCT canonical word "cotes" at rank 1. Smallest rank wins, exactly like
    # build_rank_map's collision rule: typing côtés/cotes must SOLVE (rank 0), never
    # land on the farther word that happens to share the slug.
    table = {
        "côté": ("côté",), "côtés": ("côté",),
        "cote": ("cote",), "cotes": ("cote",),
    }
    forms = gen_phrase.invert_lemmas(table)
    ranking = [("cotes", 0, .9)]
    _merged, rmap = gen_phrase.build_merged_rank_map(
        "côté", ranking, table, forms, {"côté", "côtés", "cote", "cotes"})

    assert rmap["cotes"] == {"word": "côté", "rank": 0}
    # An equal-or-farther alias still never clobbers an existing entry.
    assert rmap["cote"] == {"word": "côté", "rank": 0}  # secret's own slug, rank 0


def test_max_selectable_groups_is_exact_not_greedy():
    # Sentence order offers the ambiguous "portes" FIRST (lemmas porte + porter). A
    # greedy walk would let it claim both lemmas and count only 2 groups; committing
    # "porte", "porter" and "chien" separately is still a valid trio.
    def cand(word, pos):
        return {"pos": pos, "secret": word, "prefix": "", "suffix": ""}

    cands = [cand("portes", 0), cand("porte", 1), cand("porter", 2), cand("chien", 3)]
    assert gen_phrase.max_selectable_groups(cands, TABLE) == 3

    # Without the third independent word, no conflict-free trio exists.
    cands = [cand("portes", 0), cand("porte", 1), cand("porter", 2)]
    assert gen_phrase.max_selectable_groups(cands, TABLE) == 2


def test_empty_table_reproduces_pre_104_rank_map():
    ranking = [("chien", 0, .9), ("félin", 1, .8), ("côté", 2, .7), ("coté", 3, .6)]
    merged, rmap = gen_phrase.build_merged_rank_map("chat", ranking, {}, {}, set())
    assert merged == [(w, r, s) for (w, r, s) in ranking]
    assert rmap == gen_phrase.build_rank_map("chat", ranking)
    # the slug-collision rule still applies unchanged (côté kept, coté dropped).
    assert rmap["cote"] == {"word": "côté", "rank": 3}


def test_same_group_selected_secrets_rejected(monkeypatch):
    # "vermine" and "vermines" are one lemma group: holing both is one word twice.
    cfg = gen_phrase.CONFIG["fr"]
    fake = types.SimpleNamespace(
        closest=lambda secret, kv, V, M, n=None: [("porte", 0, .9), ("chien", 1, .8)],
    )
    monkeypatch.setitem(cfg, "module", fake)
    monkeypatch.setattr(gen_phrase, "pick_start", lambda secret, ranking: "porte")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)

    words = ["la", "vermine", "et", "les", "vermines", "du", "chien"]
    vset = {"vermine", "vermines", "chien", "porte"}
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["vermine", "vermines", "chien"], words, cfg, "fr",
            kv=None, V=[], M=None, Vset=vset,
            lemma_table=TABLE, forms_by_lemma=FORMS,
        )
    # sanity: three genuinely distinct groups DO build.
    holes, ranks = gen_phrase.holes_from_words(
        ["vermine", "porte", "chien"], ["la", "vermine", "porte", "chien"],
        cfg, "fr", kv=None, V=[], M=None,
        Vset={"vermine", "vermines", "porte", "chien"},
        lemma_table=TABLE, forms_by_lemma=FORMS,
    )
    assert {h["secret"]["slug"] for h in holes} == {"vermine", "porte", "chien"}
    # every rank map got its aliases: vermines solves the vermine hole.
    assert ranks["vermine"]["vermines"]["rank"] == 0
