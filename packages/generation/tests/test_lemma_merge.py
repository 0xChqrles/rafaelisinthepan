"""CONTRACT: lemma grouping in rank maps (#104, AGENTS.md "Per-puzzle JSON schema").

  - inflected forms of one word are ONE ranked group: the closest form is canonical,
    later forms alias to its {word, rank} and consume NO rank (compaction);
  - TOP_K counts distinct GROUPS (filter-then-cap);
  - the secret is group 0, so its own inflections alias to rank 0 (they solve);
  - strict grouping: a cross-lexeme homograph NEVER opens/fuses groups; once a clean
    form opens one of its lexemes, the ambiguous form aliases to the closest group;
  - an ambiguous secret is rejected until authoring can select its exact lexeme;
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


def test_merge_ranking_closest_clean_form_canonical_and_ranks_compacted():
    # raw walk: vermines (0), vermine (1), public (2)
    ranking = [("vermines", 0, .9), ("vermine", 1, .8), ("public", 2, .7)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)

    # vermine aliases into vermines' group, consuming no rank: public is promoted
    # from raw rank 2 to compacted rank 1.
    assert [(w, r) for w, r, _ in merged] == [("vermines", 0), ("public", 1)]
    assert groups[0] == ("chat", 0, ("chat",))  # the secret is group 0
    assert ("vermines", 1, ("vermine",)) in groups


def test_merge_ranking_top_k_counts_groups_not_raw_words():
    ranking = [("vermines", 0, .9), ("vermine", 1, .8),
               ("porte", 2, .7), ("public", 3, .6)]
    merged, _groups = gen_phrase.merge_ranking("chat", ranking, TABLE, top_k=2)
    # vermine is an alias: the cap of 2 still admits porte (filter-then-cap).
    assert [w for w, _r, _s in merged] == ["vermines", "porte"]


def test_secret_inflections_alias_to_rank_zero():
    ranking = [("vermines", 0, .9), ("porte", 1, .8)]
    merged, groups = gen_phrase.merge_ranking("vermine", ranking, TABLE)
    rmap = gen_phrase.build_rank_map("vermine", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"vermine", "vermines", "porte"})

    # typing the plural SOLVES the hole: rank 0, canonical display form.
    assert rmap["vermines"] == {"word": "vermine", "rank": 0}
    assert rmap["vermine"] == {"word": "vermine", "rank": 0}
    assert rmap["porte"] == {"word": "porte", "rank": 1}  # compacted past the alias


def test_strict_grouping_skips_an_ambiguous_opener_and_attaches_it_closest():
    # "portes" has the closest raw vector but mixes porte + porter, so it may not
    # open or fuse either group. Their clean forms remain DISTINCT survivors.
    ranking = [("portes", 0, .95), ("porte", 1, .9), ("porter", 2, .8)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)
    assert [(w, r) for w, r, _ in merged] == [("porte", 0), ("porter", 1)]

    rmap = gen_phrase.build_rank_map("chat", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"porte", "portes", "porter"})
    # the ambiguous form aliases to its CLOSEST group (porte, rank 1), never porter.
    assert rmap["portes"] == {"word": "porte", "rank": 1}
    assert rmap["porter"] == {"word": "porter", "rank": 2}


def test_an_ambiguous_secret_is_rejected_instead_of_claiming_every_lexeme():
    table = {
        "mois": ("moi:nc", "mois:nc"),
        "moi": ("moi:nc",),
        "année": ("année:nc",),
    }
    with pytest.raises(ValueError, match="secret ambigu.*moi:nc.*mois:nc"):
        gen_phrase.merge_ranking("mois", [("année", 0, .9)], table)
    with pytest.raises(ValueError, match="exactement un lexème"):
        gen_phrase.merge_ranking(
            "mois", [("année", 0, .9)], table,
            secret_lemmas=("moi:nc", "mois:nc"))


def test_expand_aliases_covers_vocab_forms_absent_from_walk_and_respects_vset():
    # privait never appeared among the neighbors; it still hits priver's rank.
    ranking = [("priver", 0, .9)]
    merged, groups = gen_phrase.merge_ranking("chat", ranking, TABLE)
    rmap = gen_phrase.build_rank_map("chat", merged)
    gen_phrase.expand_aliases(rmap, groups, FORMS, {"priver", "privait"})

    assert rmap["privait"] == {"word": "priver", "rank": 1}
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
    # Sentence order offers the ambiguous "portes" first; it is not selectable until
    # #133 can name one lexeme. The clean porte, porter and chien remain a valid trio.
    def cand(word, pos):
        return {"pos": pos, "secret": word, "prefix": "", "suffix": ""}

    cands = [cand("portes", 0), cand("porte", 1), cand("porter", 2), cand("chien", 3)]
    assert gen_phrase.max_selectable_groups(cands, TABLE) == 3

    # Without the third independent word, no conflict-free trio exists.
    cands = [cand("portes", 0), cand("porte", 1), cand("porter", 2)]
    assert gen_phrase.max_selectable_groups(cands, TABLE) == 2


def test_interactive_candidates_hide_cross_lexeme_homographs():
    cfg = gen_phrase.CONFIG["fr"]
    words = ["ce", "mois", "reste", "sombre"]
    table = {
        "mois": ("moi:nc", "mois:nc"),
        "sombre": ("sombre:adj",),
    }
    cands = gen_phrase.extract_candidates(
        words, cfg, {"mois", "sombre"}, lemma_table=table)
    assert [c["secret"] for c in cands] == ["sombre"]


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
    # Three neighbors so the walk leaves at least two distinct groups after "porte"
    # aliases into its own secret: a one-group walk has no distance span to quantize
    # (#115) and is rejected upstream.
    fake = types.SimpleNamespace(
        closest=lambda secret, kv, V, M, n=None: [
            ("porte", 0, .9), ("chien", 1, .8), ("jardin", 2, .5)],
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


def test_batch_authoring_rejects_a_cross_lexeme_homograph(capsys):
    table = {
        "mois": ("moi:nc", "mois:nc"),
        "moi": ("moi:nc",),
        "jardin": ("jardin:nc",),
        "sombre": ("sombre:adj",),
    }
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["mois", "jardin", "sombre"],
            ["ce", "mois", "est", "sombre", "au", "jardin"],
            gen_phrase.CONFIG["fr"], "fr",
            kv=None, V=[], M=None, Vset={"mois", "jardin", "sombre"},
            lemma_table=table, forms_by_lemma=gen_phrase.invert_lemmas(table),
        )
    err = capsys.readouterr().err
    assert "plusieurs lexèmes" in err
    assert "moi:nc" in err and "mois:nc" in err
