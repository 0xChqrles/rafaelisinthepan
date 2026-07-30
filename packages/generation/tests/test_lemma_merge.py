"""CONTRACT: lemma grouping in rank maps (#104, AGENTS.md "Per-puzzle JSON schema").

  - inflected forms of one word are ONE ranked group: the closest form is canonical,
    later forms alias to its {word, rank} and consume NO rank (compaction);
  - TOP_K counts distinct GROUPS (filter-then-cap);
  - the secret is group 0, so its own inflections alias to rank 0 (they solve);
  - strict grouping: groups sharing a form do NOT transitively merge; an ambiguous
    form attaches to whichever of its groups ranked closest;
  - a CROSS-LEXEME HOMOGRAPH opens a group at its own true rank like any other word,
    but CLAIMS NOTHING: its blended vector may not stand for either of its lexemes,
    so unrelated words never fuse ("moi" must not solve a "mois" hole) and no
    neighbour is ever demoted to a farther group's rank. The cost is compaction only;
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


# --- cross-lexeme homographs: a group may never claim two lexemes -----------------
# The inventory (#132) states every POS, so a surface can name genuinely unrelated
# lexemes: «mois» is both mois:nc and the plural of the noun moi:nc, «bois» is both
# bois:nc and a present of boire:v. Claiming those analyses would fuse the words.

HOMOGRAPHS = {
    "mois": ("moi:nc", "mois:nc"),
    "moi": ("moi:nc", "moi:pro"),
    "bois": ("bois:nc", "boire:v"),
    "boire": ("boire:v",),
    "buvait": ("boire:v",),
    "forêt": ("forêt:nc",),
    "arbre": ("arbre:nc",),
}
HOMOGRAPH_FORMS = gen_phrase.invert_lemmas(HOMOGRAPHS)


def test_an_ambiguous_secret_claims_nothing_so_no_unrelated_word_solves_it():
    # «moi» is not «mois». Claiming moi:nc at rank 0 would let an unrelated word SOLVE
    # the hole — the one outcome the merge walk may never produce.
    ranking = [("moi", 0, .8), ("arbre", 1, .7)]
    merged, groups = gen_phrase.merge_ranking("mois", ranking, HOMOGRAPHS)
    assert groups[0] == ("mois", 0, ())          # the secret claims nothing...
    assert [(w, r) for w, r, _ in merged] == [("moi", 0), ("arbre", 1)]

    rmap = gen_phrase.build_rank_map("mois", merged)
    gen_phrase.expand_aliases(rmap, groups, HOMOGRAPH_FORMS, {"moi", "mois", "arbre"})
    assert rmap["mois"] == {"word": "mois", "rank": 0}
    assert rmap["moi"] == {"word": "moi", "rank": 1}   # ...so «moi» keeps its own rank


def test_an_ambiguous_neighbour_keeps_its_own_true_rank_and_display():
    # The regression this rule replaced: skipping the homograph entirely left «bois»
    # to be aliased by whichever far-out form of boire:v happened to open that lexeme,
    # so a rank-1 neighbour was reported at the far end of the map — or vanished.
    ranking = [("bois", 0, .9), ("arbre", 1, .8), ("buvait", 2, .1)]
    merged, groups = gen_phrase.merge_ranking("forêt", ranking, HOMOGRAPHS)
    assert [(w, r) for w, r, _ in merged] == [("bois", 0), ("arbre", 1), ("buvait", 2)]

    rmap = gen_phrase.build_rank_map("forêt", merged)
    gen_phrase.expand_aliases(rmap, groups, HOMOGRAPH_FORMS,
                              {"bois", "arbre", "buvait", "boire"})
    assert rmap["bois"] == {"word": "bois", "rank": 1}     # its own rank, its own word
    # ...and it dragged NO form of boire to a wood's distance: they rank on their own.
    assert rmap["buvait"] == {"word": "buvait", "rank": 3}
    assert rmap["boire"] == {"word": "buvait", "rank": 3}


def test_an_ambiguous_form_still_aliases_into_a_group_that_claimed_its_lexeme():
    # Claiming is restricted; ALIASING is not. Once boire:v is opened by a clean form,
    # «bois» attaches to it exactly as #104 says — closest group wins.
    ranking = [("buvait", 0, .9), ("bois", 1, .8)]
    merged, groups = gen_phrase.merge_ranking("forêt", ranking, HOMOGRAPHS)
    assert [w for w, _r, _s in merged] == ["buvait"]   # bois aliased, consumed no rank
    rmap = gen_phrase.build_rank_map("forêt", merged)
    gen_phrase.expand_aliases(rmap, groups, HOMOGRAPH_FORMS, {"bois", "buvait"})
    assert rmap["bois"] == {"word": "buvait", "rank": 1}


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


def test_a_homograph_is_still_selectable_as_a_secret():
    # Roughly half the frequent French vocabulary names more than one lexeme (`amer`
    # is amer:adj + amer:nc, `maison` maison:adj + maison:nc). Refusing those as
    # secrets would gut the corpus; the merge walk makes them SAFE instead, by
    # claiming nothing, so authoring does not have to forbid them.
    cfg = gen_phrase.CONFIG["fr"]
    cands = gen_phrase.extract_candidates(
        ["ce", "mois", "reste", "sombre"], cfg, {"mois", "sombre"})
    assert [c["secret"] for c in cands] == ["mois", "sombre"]


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


def test_batch_authoring_holes_a_homograph_without_letting_it_claim_a_lexeme(
        monkeypatch):
    # End to end: «mois» is holed like any other secret, and «moi» — an unrelated
    # word sharing one of its lexemes — ranks on its own instead of solving it.
    cfg = gen_phrase.CONFIG["fr"]
    table = {
        "mois": ("moi:nc", "mois:nc"),
        "moi": ("moi:nc",),
        "jardin": ("jardin:nc",),
        "sombre": ("sombre:adj",),
    }
    fake = types.SimpleNamespace(
        closest=lambda secret, kv, V, M, n=None: [
            ("moi", 0, .9), ("jardin", 1, .8), ("sombre", 2, .5)],
    )
    monkeypatch.setitem(cfg, "module", fake)
    monkeypatch.setattr(gen_phrase, "pick_start", lambda secret, ranking: "sombre")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)

    holes, ranks = gen_phrase.holes_from_words(
        ["mois", "jardin", "sombre"],
        ["ce", "mois", "est", "sombre", "au", "jardin"],
        cfg, "fr", kv=None, V=[], M=None,
        Vset={"mois", "moi", "jardin", "sombre"},
        lemma_table=table, forms_by_lemma=gen_phrase.invert_lemmas(table),
    )
    assert {h["secret"]["word"] for h in holes} == {"mois", "jardin", "sombre"}
    assert ranks["mois"]["mois"]["rank"] == 0
    assert ranks["mois"]["moi"]["rank"] > 0   # never 0: «moi» must not solve «mois»
