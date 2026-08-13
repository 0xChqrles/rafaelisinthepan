"""CONTRACT: word grouping in rank maps (#104/#146), ranked per group since #134.

  - a group is one playable word family: normally one dictionary lexeme, but #146
    first merges entries with identical complete form sets and removes a same-POS
    entry wholly contained in another. Its opaque id never supplies its POS;
  - a group is ranked by its REPRESENTATIVE: its closest embedded form
    that is not a cross-lexeme homograph (group-min over clean forms). A homograph's
    vector provably blends strangers' meanings, so it sets no lexeme's distance
    («vers» must not put lexeme VER next to «poème»); an unambiguous form owns its
    vector entirely, even when it diverges from its siblings («lunettes» near an eye
    secret is real sense signal, and its whole lexeme rides that closeness);
  - a lexeme with NO clean embedded form still ranks — representative = its closest
    form of any kind, flagged not-clean (take what exists, surfaced to the curator);
  - every reduced-vocab form of a group keys to it; an ambiguous form attaches to
    whichever of its groups ranked closest (#104, unchanged);
  - keys are assigned closest-first at assembly: a group left with NO key cannot be
    typed, displayed or found, so it is SKIPPED and consumes no rank — that is both
    the old aliasing compaction and what prevents any keyless residual group from
    minting a ghost rank;
  - a group's DISPLAY is its closest OWNED form: what the map prints types back at
    that group's own rank, never a closer one;
  - TOP_K counts surviving groups (filter-then-cap);
  - the secret is group 0 and claims the group the author CONFIRMED (#133, via
    secret_claim) — an inflection of a homographic secret then solves — falling
    back to the surface-derived claim (one lexeme or nothing) when nothing was
    confirmed: «moi» must never solve a «mois» hole;
  - with an empty table every surface is its own clean singleton lexeme: the
    ungrouped ranking, slug-collision losers compacted away;
  - two selected secrets in one lemma group are rejected.
"""

import functools
import os
import sys
import types

import pytest

import gen_phrase
from build_forms import load_forms

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

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


def _build(secret, ranking, table, vset, **kw):
    forms = gen_phrase.invert_lemmas(table)
    return gen_phrase.build_merged_rank_map(secret, ranking, table, forms,
                                            set(vset), **kw)


def test_closest_form_canonical_and_ranks_compacted():
    # raw walk: vermines (0), vermine (1), public (2)
    ranking = [("vermines", 0, .9), ("vermine", 1, .8), ("public", 2, .7)]
    merged, _rmap, groups = _build("chat", ranking, TABLE,
                                   {"vermines", "vermine", "public"})

    # vermine adds no new key to an already-keyed lexeme: no rank consumed, public
    # is promoted from raw rank 2 to compacted rank 1.
    assert [(w, r) for w, r, _ in merged] == [("vermines", 0), ("public", 1)]
    assert groups[0] == ("chat", 0, ("chat",), True, "chat")  # the secret: group 0
    assert ("vermines", 1, ("vermine",), True, "vermines") in groups


def test_top_k_counts_surviving_groups_not_raw_words():
    ranking = [("vermines", 0, .9), ("vermine", 1, .8),
               ("porte", 2, .7), ("public", 3, .6)]
    merged, _rmap, _groups = _build("chat", ranking, TABLE,
                                    {"vermines", "vermine", "porte", "public"},
                                    top_k=2)
    # vermine dissolves into its own lexeme's group: the cap of 2 still admits porte.
    assert [w for w, _r, _s in merged] == ["vermines", "porte"]


def test_secret_inflections_alias_to_rank_zero():
    ranking = [("vermines", 0, .9), ("porte", 1, .8)]
    _m, rmap, _g = _build("vermine", ranking, TABLE,
                          {"vermine", "vermines", "porte"})

    # typing the plural SOLVES the hole: rank 0, canonical display form.
    assert rmap["vermines"] == {"word": "vermine", "rank": 0}
    assert rmap["vermine"] == {"word": "vermine", "rank": 0}
    assert rmap["porte"] == {"word": "porte", "rank": 1}  # compacted past the alias


def test_strict_grouping_no_transitive_merge_and_ambiguous_attaches_closest():
    # porte (rank 1) then porter (rank 2): distinct lemmas, so DISTINCT groups even
    # though "portes" is a form of both.
    ranking = [("porte", 0, .9), ("porter", 1, .8)]
    merged, rmap, _g = _build("chat", ranking, TABLE,
                              {"porte", "portes", "porter"})
    assert [(w, r) for w, r, _ in merged] == [("porte", 0), ("porter", 1)]
    # the ambiguous form keys to its CLOSEST group (porte, rank 1), never porter.
    assert rmap["portes"] == {"word": "porte", "rank": 1}
    assert rmap["porter"] == {"word": "porter", "rank": 2}


def test_alias_expansion_covers_vocab_forms_absent_from_walk_and_respects_vset():
    # privait never appeared among the neighbors; it still hits priver's rank.
    ranking = [("priver", 0, .9)]
    _m, rmap, _g = _build("chat", ranking, TABLE, {"priver", "privait"})

    assert rmap["privait"] == {"word": "priver", "rank": 1}
    # privés is a form of the group but NOT in the reduced vocab: no unreachable key.
    assert "prives" not in rmap


# --- the #134 ranking rule: clean representatives -----------------------------------
# The inventory (#132) states every POS, so a surface can name genuinely unrelated
# lexemes. Homography is stated by the data — nothing is guessed.

POETRY = {
    # #146 exact-merges the noun/preposition twins; the real remaining ambiguity
    # is between that merged group and the worm plural.
    "vers": ("ver:nc", "vers:nc"),
    "ver": ("ver:nc",),
    "strophe": ("strophe:nc",),
    "poème": ("poème:nc",),
}


def test_a_lexeme_is_ranked_by_its_clean_representative_never_a_homograph():
    # «vers» sits next to «poème»; «ver» (the worm, clean) sits far away. Lexeme
    # ver:nc must rank by «ver» — ranking it by the blended «vers» vector would put
    # "earthworm" next to poetry, a nonsense reward.
    ranking = [("vers", 0, .9), ("strophe", 1, .8), ("ver", 2, .2)]
    merged, rmap, _groups = _build("poème", ranking, POETRY,
                                   {"vers", "strophe", "ver"})

    assert [(w, r) for w, r, _ in merged] == \
        [("vers", 0), ("strophe", 1), ("ver", 2)]
    assert rmap["ver"] == {"word": "ver", "rank": 3}   # the worm, at worm distance
    assert rmap["vers"]["rank"] == 1                   # the blend, where it sits


def test_exact_twins_are_one_group_not_ghost_ranks():
    # The exact noun/preposition twins already share ONE opaque group. It has no
    # clean vector because « vers » is also ver:nc, but it can mint only one rank.
    ranking = [("vers", 0, .9), ("strophe", 1, .8), ("ver", 2, .2)]
    _m, _rmap, groups = _build("poème", ranking, POETRY,
                               {"vers", "strophe", "ver"})

    assert ("vers", 1, ("vers:nc",), False, "vers") in groups   # take what exists...
    assert [g[1] for g in groups] == [0, 1, 2, 3]            # ...and no ghost rank


def test_a_divergent_clean_plural_is_its_lexemes_representative():
    # «lunettes» (glasses) genuinely diverges from «lunette»; both are clean forms
    # of one lexeme, so the group rides the CLOSEST one — a player typing it near an
    # eye-related secret made a contextually excellent guess and is rewarded.
    table = {"lunette": ("lunette:nc",), "lunettes": ("lunette:nc",),
             "oeil": ("oeil:nc",)}
    ranking = [("lunettes", 0, .9), ("lunette", 1, .3)]
    merged, rmap, _g = _build("oeil", ranking, table, {"lunette", "lunettes"})

    assert [(w, r) for w, r, _ in merged] == [("lunettes", 0)]
    assert rmap["lunettes"] == {"word": "lunettes", "rank": 1}
    assert rmap["lunette"] == {"word": "lunettes", "rank": 1}


ROUGE = {
    # The adjective/noun twins are one #146 group. The adverb is a real remaining
    # homograph, so the plural is the merged group's clean representative.
    "rouge": ("rouge:adv", "rouge:nc"),
    "rouges": ("rouge:nc",),
    "écarlate": ("écarlate:adj",),
    "forêt": ("forêt:nc",),
}


def test_merged_twins_use_their_clean_form_and_drop_the_false_flag():
    # Merging the adjective/noun duplicates makes « rouges » clean for their one
    # group. The real adverb still owns the closer singular at its own rank.
    ranking = [("écarlate", 0, .9), ("rouge", 1, .85), ("rouges", 2, .8)]
    merged, rmap, groups = _build("forêt", ranking, ROUGE,
                                  {"écarlate", "rouge", "rouges"})

    assert [(w, r) for w, r, _ in merged] == [
        ("écarlate", 0), ("rouge", 1), ("rouges", 2)]
    assert rmap["rouge"]["rank"] == 2
    assert rmap["rouges"]["rank"] == 3
    assert ("rouges", 3, ("rouge:nc",), True, "rouges") in groups


def test_display_is_the_closest_owned_form_never_a_stolen_slug():
    # cote:nc's representative «cotes» folds to the slug the secret's own «côtés»
    # already holds: whatever the group prints must type back at ITS rank, so the
    # display falls back to the closest form the group actually owns («cotation»).
    table = {
        "côté": ("côté:nc",), "côtés": ("côté:nc",),
        "cotes": ("cote:nc",), "cotation": ("cote:nc",),
    }
    ranking = [("cotes", 0, .9), ("cotation", 1, .8)]
    merged, rmap, _g = _build("côté", ranking, table,
                              {"côté", "côtés", "cotes", "cotation"})

    assert rmap["cotes"] == {"word": "côté", "rank": 0}   # closer alias keeps the key
    assert rmap["cotation"] == {"word": "cotation", "rank": 1}  # owned display
    # ...while the group still RANKS by its representative's similarity.
    assert [(w, r, s) for w, r, s in merged] == [("cotation", 0, .9)]


def test_a_borrowed_secret_sharing_its_donors_slug_keeps_its_own_display():
    # #119 x #134: «abattît» has no vector and borrows «abattit»'s; both fold to
    # one slug and BOTH sit outside the ranking (the donor is the walk's origin).
    # The head keys FIRST, so rank 0 displays the true sentence form — the solved
    # sentence must never lose its accent to the donor's spelling.
    table = {"abattît": ("abattre:v",), "abattit": ("abattre:v",),
             "hache": ("hache:nc",)}
    ranking = [("hache", 0, .9)]
    _m, rmap, groups = _build("abattît", ranking, table, {"abattit", "hache"},
                              secret_lemmas=("abattre:v",))
    assert rmap["abattit"] == {"word": "abattît", "rank": 0}
    assert groups[0][0] == "abattît"


def test_a_group_with_no_free_key_dissolves_and_consumes_no_rank():
    # Same collision, but cote:nc's every slug belongs to the secret's family:
    # nothing left to type, so the group never exists — no ghost rank shifts public.
    table = {
        "côté": ("côté:nc",), "côtés": ("côté:nc",),
        "cotes": ("cote:nc",), "public": ("public:adj",),
    }
    ranking = [("cotes", 0, .9), ("public", 1, .8)]
    merged, rmap, _g = _build("côté", ranking, table,
                              {"côté", "côtés", "cotes", "public"})

    assert rmap["cotes"] == {"word": "côté", "rank": 0}
    assert [(w, r) for w, r, _ in merged] == [("public", 0)]
    assert rmap["public"]["rank"] == 1


# --- the secret's claim: confirmed identity first, fail-closed second ---------------

@functools.lru_cache(maxsize=1)
def _lexicon():
    return load_forms(os.path.join(FIXTURES, "forms.fr.tsv"))


def test_secret_claim_uses_the_confirmed_lexeme():
    # «rouges» confirmed adj:f:p belongs to the merged adjective/noun group: the
    # author says the usage morphology, and group 0 claims its opaque family.
    table = _lexicon()
    forms = gen_phrase.FormResolver(table, explicit={"rouges": "adj:f:p"})
    claim = gen_phrase.secret_claim("rouges", "rouges", table.grouping, forms=forms)
    assert claim == ("rouge:nc",)


def test_secret_claim_falls_back_when_the_bare_trait_names_several_lexemes(
        monkeypatch):
    # «fils» : n:p is carried by fil:nc AND fils:nc — a bare TYPED trait (#144: the
    # prompt's free-text path) identifies nothing, and the surface names two
    # lexemes, so the claim falls back to NOTHING. (The --form equivalent is a hard
    # error instead — see test_inflect.)
    table = _lexicon()
    monkeypatch.setattr("builtins.input", lambda _p="": "n:p")
    forms = gen_phrase.FormResolver(table, interactive=True)
    assert gen_phrase.secret_claim("fils", "fils", table.grouping,
                                   forms=forms) == ()
    # ...while an unambiguous surface keeps its ordinary claim with no resolver.
    assert gen_phrase.secret_claim("jardin", "jardin", table.grouping) == \
        ("jardin:nc",)


def test_a_qualified_form_resolves_the_shared_cell_and_the_singular_solves():
    # A real identity choice remains for « fils »: naming fil:nc makes its singular
    # solve, while the distinct fils:nc family remains a separate answer below.
    table = _lexicon()
    forms = gen_phrase.FormResolver(table,
                                    explicit={"fils": ("fil:nc", "n:p")})
    claim = gen_phrase.secret_claim("fils", "fils", table.grouping, forms=forms)
    assert claim == ("fil:nc",)
    ranking = [("corde", 0, .9), ("fil", 1, .85), ("jardin", 2, .5)]
    _m, rmap, _g = gen_phrase.build_merged_rank_map(
        "fils", ranking, table.grouping, gen_phrase.invert_lemmas(table.grouping),
        {"fil", "fils", "corde", "jardin"}, secret_lemmas=claim)

    assert rmap["fil"] == {"word": "fils", "rank": 0}    # solves


def test_confirming_the_fils_family_never_lets_fil_solve():
    table = _lexicon()
    forms = gen_phrase.FormResolver(
        table, explicit={"fils": ("fils:nc", "n:p")})
    claim = gen_phrase.secret_claim("fils", "fils", table.grouping, forms=forms)
    assert claim == ("fils:nc",)

    ranking = [("fil", 0, .9), ("corde", 1, .8), ("jardin", 2, .5)]
    _m, rmap, _g = gen_phrase.build_merged_rank_map(
        "fils", ranking, table.grouping, gen_phrase.invert_lemmas(table.grouping),
        {"fil", "fils", "corde", "jardin"}, secret_lemmas=claim)

    assert rmap["fils"]["rank"] == 0
    assert rmap["fil"]["rank"] == 1


def test_a_confirmed_homograph_secret_is_solved_by_its_own_inflection():
    # The «rouges» case end to end: the morphology identifies the merged noun /
    # adjective group, so «rouge» keys at rank 0 and typing the singular SOLVES.
    table = _lexicon()
    forms = gen_phrase.FormResolver(table, explicit={"rouges": "adj:f:p"})
    claim = gen_phrase.secret_claim("rouges", "rouges", table.grouping, forms=forms)
    ranking = [("écarlate", 0, .9), ("rouge", 1, .85), ("grande", 2, .5)]
    _m, rmap, _g = gen_phrase.build_merged_rank_map(
        "rouges", ranking, table.grouping, gen_phrase.invert_lemmas(table.grouping),
        {"rouge", "rouges", "écarlate", "grande"}, secret_lemmas=claim)

    assert rmap["rouge"] == {"word": "rouges", "rank": 0}    # solves
    assert rmap["rouges"]["rank"] == 0
    assert rmap["ecarlate"]["rank"] == 1


def test_an_unconfirmed_ambiguous_secret_still_claims_nothing():
    # «moi» is not «mois». With nothing confirmed the secret claims nothing, so no
    # unrelated word can solve its hole — «moi» keys at its own true rank.
    table = {"mois": ("moi:nc", "mois:nc"), "moi": ("moi:nc", "moi:pro"),
             "arbre": ("arbre:nc",)}
    ranking = [("moi", 0, .8), ("arbre", 1, .7)]
    merged, rmap, groups = _build("mois", ranking, table,
                                  {"moi", "mois", "arbre"})

    assert groups[0] == ("mois", 0, (), True, "mois")
    assert [(w, r) for w, r, _ in merged] == [("moi", 0), ("arbre", 1)]
    assert rmap["mois"] == {"word": "mois", "rank": 0}
    assert rmap["moi"]["rank"] == 1


def test_a_confirmed_mois_still_never_lets_moi_solve():
    # Confirming «mois» as mois:nc claims exactly that lexeme: moi:nc stays
    # unclaimed, «moi» keeps its own rank — the confirmation can never over-claim.
    table = {"mois": ("moi:nc", "mois:nc"), "moi": ("moi:nc", "moi:pro"),
             "arbre": ("arbre:nc",)}
    ranking = [("moi", 0, .8), ("arbre", 1, .7)]
    _m, rmap, _g = _build("mois", ranking, table, {"moi", "mois", "arbre"},
                          secret_lemmas=("mois:nc",))
    assert rmap["moi"]["rank"] == 1
    assert rmap["mois"]["rank"] == 0


def test_an_ambiguous_form_keys_into_the_closest_group_of_its_lexemes():
    # Once boire:v is opened by a clean form, «bois» attaches to it closest-first —
    # and with bois:nc's only form spoken for, the wood dissolves entirely.
    table = {"bois": ("bois:nc", "boire:v"), "boire": ("boire:v",),
             "buvait": ("boire:v",), "forêt": ("forêt:nc",)}
    ranking = [("buvait", 0, .9), ("bois", 1, .8)]
    merged, rmap, _g = _build("forêt", ranking, table,
                              {"bois", "buvait", "boire"})
    assert [w for w, _r, _s in merged] == ["buvait"]
    assert rmap["bois"] == {"word": "buvait", "rank": 1}


def test_an_unclaimed_homograph_group_keeps_its_own_rank_and_display():
    # bois:nc has no clean form, so it ranks on the blend it owns — its own rank,
    # its own word — and drags NO form of boire to a wood's distance.
    table = {"bois": ("bois:nc", "boire:v"), "boire": ("boire:v",),
             "buvait": ("boire:v",), "arbre": ("arbre:nc",),
             "forêt": ("forêt:nc",)}
    ranking = [("bois", 0, .9), ("arbre", 1, .8), ("buvait", 2, .1)]
    merged, rmap, _g = _build("forêt", ranking, table,
                              {"bois", "arbre", "buvait", "boire"})
    assert [(w, r) for w, r, _ in merged] == \
        [("bois", 0), ("arbre", 1), ("buvait", 2)]
    assert rmap["bois"] == {"word": "bois", "rank": 1}
    assert rmap["buvait"] == {"word": "buvait", "rank": 3}
    assert rmap["boire"] == {"word": "buvait", "rank": 3}


def test_empty_table_reproduces_the_ungrouped_ranking():
    ranking = [("chien", 0, .9), ("félin", 1, .8), ("côté", 2, .7), ("coté", 3, .6)]
    merged, rmap, _g = gen_phrase.build_merged_rank_map("chat", ranking, {}, {},
                                                        set())
    # every surface is its own singleton clean lexeme; the slug-collision loser
    # («coté») keys nothing and is compacted away instead of holding an empty rank.
    assert [(w, r) for w, r, _ in merged] == \
        [("chien", 0), ("félin", 1), ("côté", 2)]
    assert rmap == {"chat": {"word": "chat", "rank": 0},
                    "chien": {"word": "chien", "rank": 1},
                    "felin": {"word": "félin", "rank": 2},
                    "cote": {"word": "côté", "rank": 3}}


def test_max_selectable_groups_is_exact_not_greedy():
    # Sentence order offers the ambiguous "portes" first. It IS selectable (see the
    # homograph test below) — but its FULL identity spans porte AND porter, so it
    # cannot join a trio holding either; a greedy walk stopping on it would miss that
    # committing the clean porte, porter and chien separately is a valid trio.
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
    # secrets would gut the corpus; the walk makes them SAFE instead — and since
    # #134 the author's confirmation even makes their inflections solve.
    cfg = gen_phrase.CONFIG["fr"]
    cands = gen_phrase.extract_candidates(
        ["ce", "mois", "reste", "sombre"], cfg, {"mois", "sombre"})
    assert [c["secret"] for c in cands] == ["mois", "sombre"]


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


def test_batch_authoring_confirms_the_secret_before_the_walk(monkeypatch):
    # The full #134 path through holes_from_words: --form names each secret's
    # lexeme, the claim precedes the ranking, and typing the singular of a
    # homographic plural secret SOLVES its hole.
    cfg = gen_phrase.CONFIG["fr"]
    table = _lexicon()
    fake = types.SimpleNamespace(
        closest=lambda secret, kv, V, M, n=None: [
            ("écarlate", 0, .9), ("rouge", 1, .85), ("jardin", 2, .5),
            ("doucement", 3, .4), ("grande", 4, .3)],
    )
    monkeypatch.setitem(cfg, "module", fake)
    monkeypatch.setattr(gen_phrase, "pick_start", lambda s, r: "écarlate")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)

    forms = gen_phrase.FormResolver(table, explicit={
        "rouges": "adj:f:p", "jardin": "n:s", "doucement": "cit"})
    vset = {"rouges", "rouge", "écarlate", "jardin", "doucement", "grande"}
    donors = gen_phrase.DonorResolver(table.grouping,
                                      gen_phrase.invert_lemmas(table.grouping),
                                      sorted(vset), vset, "fr")
    holes, ranks = gen_phrase.holes_from_words(
        ["rouges", "jardin", "doucement"],
        ["les", "pommes", "rouges", "du", "jardin", "brillent", "doucement"],
        cfg, "fr", kv=None, V=[], M=None, Vset=vset,
        lemma_table=table.grouping,
        forms_by_lemma=gen_phrase.invert_lemmas(table.grouping),
        donors=donors, forms=forms,
    )
    # the confirmed morphology claimed the merged rouge:nc group: singular solves.
    assert ranks["rouges"]["rouge"]["rank"] == 0
    assert ranks["rouges"]["rouges"]["rank"] == 0
    assert ranks["rouges"]["ecarlate"]["rank"] == 1
    # ...and the other secrets went through the same explicit gate.
    assert ranks["jardin"]["jardin"]["rank"] == 0
    assert {h["secret"]["slug"] for h in holes} == \
        {"rouges", "jardin", "doucement"}


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
