"""CONTRACT: the unified lexeme inventory and the display-agreement pass it feeds
(#119 addenda 2/3, unified by #132).

A hole displays the player's current best word, so that word should agree with the
sentence: « tu t'___ » must read "t'distrais", never "t'distraire". The rules:

  - the set to agree is EXACTLY the groups at rank <= start_rank — a hole only ever
    improves and starts at start_rank, so no farther group is ever rendered;
  - rank 0 is never touched: it already holds the true sentence form;
  - the target form is the SECRET's own morphology, read off the committed table, and
    it decides EVERYWHERE: a batch run agrees too. Only an ambiguous or unknown secret
    needs a human (--form off a TTY, a prompt on one); --no-inflect is what reproduces
    the agreement-free output byte for byte;
  - a form carrying several verb lexemes is DECLINED, never arbitrated;
  - a group is left alone when its canonical is not a POS-admitted verb, has no such
    form, would become a word nobody could type back, would land on a slug a CLOSER
    group already owns, or would take the slug a farther but still DISPLAYABLE group
    prints — whatever a hole displays must type back at that hole's own exponent, never
    a closer one. Past start_rank nothing is displayed, so nothing is protected;
  - rewriting a group rewrites every entry carrying it (aliases included) and keys the
    new slug at that same rank, so typing any form of the group displays the agreed one.

#132 put ONE dictionary behind grouping, ranking and display alike, and the tests
below follow that split of responsibilities:

  - MORPHALOU 3.1 is the authority for the lexeme: every POS, every cell, one row per
    (lexeme, feature, form). A lexeme is (lemma, pos), so homography is DERIVABLE —
    «vers» the noun and «vers» the preposition are two lexemes sharing a surface. Its
    explicit agreement columns map into the internal feature vocabulary, an unnamed
    dimension expanding across all its values, never into an opaque feature.
  - the fusion glued a few wrong paradigms INSIDE otherwise-correct entries («je
    sortis» as a present), so the build drops UNCORROBORATED rows (origins without
    the curated core or a compiled morphology) from entries that have corroborated
    ones — measured on #131's enumerated cases — and PINS the source's enumerated
    basic-verb holes rather than patching them from another source.
  - LEXIQUE is frequency/POS evidence only. The `dom` gate keeps two cases: with
    corpus evidence the row's class must strictly beat every rival ("évident" is
    dominantly the adjective, so it is never read — nor written — as a verb); without
    evidence, the surface is admitted only when it is analysable as that class and
    nothing else ("accoutumes"), never guessed.
  - a gated form stays a legal TARGET: "pensée" realizes penser's par:pas:f:s.
"""

import functools
import gzip
import os
import zipfile

import pytest

import build_forms
import gen_phrase
from build_forms import (clean_entry, collect_rows, dominant_pos, forms_path,
                         lexeme_key, lexique_class, lexique_weights, load_forms,
                         morphalou_features, normalize_lemma)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TABLE = load_forms(os.path.join(FIXTURES, "forms.fr.tsv"))

# The reduced vocabulary these tests run against. "distrais" is deliberately ABSENT:
# it is the untypable-rewrite case (the table knows the form, the embedding does not).
VOCAB = ["jardin", "amuse", "amuses", "amusé", "amusait", "distraire", "marchait",
         "marches",
         "lasses", "lassés", "compris", "pensé", "évident", "évidé", "noyé", "noies",
         "accoutume", "accoutumer", "accoutumés", "noyait"]
VSET = set(VOCAB)

# The grouping the donor bridge walks, in the inventory's lexeme-key namespace —
# what makes could_be_a_verb's intersection with the verb view meaningful (#132).
# "accoutumes" has no row of its own here, so only its accent sibling can name the
# accoutumer group.
LEMMAS = {"accoutume": ("accoutumer:v",), "accoutumer": ("accoutumer:v",),
          "accoutumés": ("accoutumer:v",), "jardin": ("jardin:nc",)}


def _donors():
    """A resolver for its `typable` check and its lemma bridge."""
    return gen_phrase.DonorResolver(LEMMAS, gen_phrase.invert_lemmas(LEMMAS),
                                    VOCAB, VSET, "fr")


def _resolver(explicit=None, interactive=False, table=TABLE):
    return gen_phrase.FormResolver(table, explicit=explicit or {},
                                   interactive=interactive)


def _map(*entries):
    """Build a rank map from (slug, word, rank) triples."""
    return {s: {"word": w, "rank": r} for s, w, r in entries}


# --- the source mapping: Morphalou columns -> the internal feature vocabulary ------

def test_a_named_verb_row_names_one_cell():
    assert morphalou_features("v", "singular", "indicative", "-", "future",
                              "firstPerson") == ("ind:fut:1s",)
    assert morphalou_features("v", "singular", "imperative", "-", "present",
                              "secondPerson") == ("imp:pre:2s",)
    assert morphalou_features("v", "singular", "participle", "masculine", "past",
                              "-") == ("par:pas:m:s",)
    assert morphalou_features("v", "-", "infinitive", "-", "-", "-") == ("inf",)
    assert morphalou_features("v", "-", "participle", "-", "present",
                              "-") == ("par:pre",)


def test_an_unnamed_dimension_covers_every_value_it_does_not_discriminate():
    # «un code non renseigné est non pertinent ou non discriminant» — «pris» really
    # is both numbers. Folding that into one opaque feature would make the cells
    # unreachable and the form look unambiguous when it is not.
    assert morphalou_features("v", "-", "participle", "masculine", "past", "-") == (
        "par:pas:m:s", "par:pas:m:p")
    assert morphalou_features("v", "singular", "indicative", "-", "present", "-") == (
        "ind:pre:1s", "ind:pre:2s", "ind:pre:3s")
    assert morphalou_features("nc", "invariable", "-", "-", "-", "-") == ("n:s", "n:p")
    assert morphalou_features("adj", "-", "-", "masculine", "-", "-") == (
        "adj:m:s", "adj:m:p")


def test_an_unnamed_person_cannot_invent_an_imperative_cell():
    # Expanding an omitted dimension across all its values is right for the
    # indicative, but French has three imperative cells and no others: an unnamed
    # person must not mint "imp:pre:3p".
    assert morphalou_features("v", "-", "imperative", "-", "present", "-") == (
        "imp:pre:1p", "imp:pre:2s", "imp:pre:2p")
    assert morphalou_features("v", "plural", "imperative", "-", "present",
                              "firstPerson") == ("imp:pre:1p",)


def test_a_row_outside_the_vocabulary_is_a_skip_not_a_guess():
    # a (mode, temps) pair or an agreement value the vocabulary does not know yields
    # (): the row is counted and skipped, never mangled into a wrong cell.
    assert morphalou_features("v", "singular", "indicative", "-", "pluperfect",
                              "firstPerson") == ()
    assert morphalou_features("v", "sg?", "indicative", "-", "present",
                              "firstPerson") == ()


def test_closed_classes_carry_the_citation_cell_only():
    # they exist for grouping and homography (#132/#134); #133's transfer policy
    # gives them the citation form, so one cell says everything they can.
    for pos in ("adv", "prep", "conj", "intj", "pro", "det", "num"):
        assert morphalou_features(pos, "-", "-", "-", "-", "-") == ("cit",)


def test_lexeme_identity_is_lemma_plus_pos():
    assert lexeme_key("porte", "nc") == "porte:nc"
    assert lexeme_key("porter", "v") == "porter:v"
    # pronominal entries fold onto the bare verb: the flexions are bare forms anyway,
    # and «s'envoler» must be the same lexeme as «envoler».
    assert normalize_lemma("s'envoler") == "envoler"
    assert normalize_lemma("se laver") == "laver"
    assert normalize_lemma("Sortir") == "sortir"


# --- the mixed-paradigm cleanup (#131 hazard 1) ------------------------------------

def test_an_uncorroborated_row_is_dropped_from_a_corroborated_entry():
    # sortir, in miniature: the real paradigm carries the curated core, the glued-in
    # «-iss-» conjugation is dela-only. The wrong-only present cell must come out
    # EMPTY (an honest hole), never realize «je sortis».
    cells = {
        "ind:pre:3s": {"sort": frozenset({"morphalou2", "dela", "lefff"}),
                       "sortit": frozenset({"dela"})},
        "ind:pre:1s": {"sortis": frozenset({"dela"})},
        "ind:pas:3s": {"sortit": frozenset({"morphalou2", "lefff"})},
    }
    kept, dropped = clean_entry(cells)
    assert kept == {"ind:pre:3s": {"sort"}, "ind:pas:3s": {"sortit"}}
    assert sorted(dropped) == [("ind:pre:1s", "sortis"), ("ind:pre:3s", "sortit")]


def test_a_slug_variant_of_a_kept_form_survives_the_cleanup():
    # the 1990 rectifications fold onto the traditional slug (plait/plaît): dropping
    # them would lose exactly what the A/B credited Morphalou for carrying.
    cells = {"ind:pre:3s": {"plaît": frozenset({"morphalou2"}),
                            "plait": frozenset({"dicollecte"})}}
    kept, dropped = clean_entry(cells)
    assert kept == {"ind:pre:3s": {"plaît", "plait"}}
    assert dropped == []


def test_an_independently_compiled_row_counts_as_corroborated():
    # the dela+lefff repairs of the core's missing 1s rows are legitimate and must
    # survive («eus», «finirais», «assois») — lefff/lglexlefff corroborate.
    cells = {"ind:pas:1s": {"eus": frozenset({"dela", "lefff"})},
             "ind:pas:3s": {"eut": frozenset({"morphalou2", "lefff"})}}
    kept, dropped = clean_entry(cells)
    assert kept == {"ind:pas:1s": {"eus"}, "ind:pas:3s": {"eut"}}
    assert dropped == []


def test_a_single_source_entry_keeps_its_whole_paradigm():
    # the hazard is MIXING: an entry with no corroborated row at all is one source's
    # coherent paradigm, and provenance alone is not a reason to gut it.
    cells = {"ind:pre:1s": {"zorgle": frozenset({"dela"})},
             "inf": {"zorgler": frozenset()}}
    kept, dropped = clean_entry(cells)
    assert kept == {"ind:pre:1s": {"zorgle"}, "inf": {"zorgler"}}
    assert dropped == []


# --- the POS gate (`dom`): Lexique frequency, generalised to every POS -------------

def test_pos_gate_with_corpus_evidence_keeps_the_dominant_reading():
    # Case 1. "évident": 0.27 as a form of "évider", 20.14 as the adjective -> the
    # adjective dominates and the verb reading is gated. Summed per class, VER and
    # AUX merged (an auxiliary is a verb).
    token_re = gen_phrase.CONFIG["fr"]["token_regex"]
    weight = lexique_weights([("évident", "VER", 0.27), ("évident", "ADJ", 20.14),
                              ("pensé", "VER", 90.0), ("pensé", "AUX", 7.57),
                              ("pensée", "VER", 1.42), ("pensée", "NOM", 98.92)],
                             token_re)
    assert weight["pensé"] == {"v": 97.57}
    analyses = {"évident": {"v", "adj"}, "pensé": {"v"}, "pensée": {"v", "nc"}}
    dominant = dominant_pos(analyses, weight)
    assert dominant == {"évident": "adj", "pensé": "v", "pensée": "nc"}


def test_pos_gate_without_corpus_evidence_admits_only_an_uncontested_reading():
    # Case 2. Lexique never saw "accoutumes" — which is the whole reason the
    # agreement pass exists — so there is no frequency to weigh. Its analyses are
    # verbal and nothing else, so it is admitted. A cross-POS homograph with no
    # evidence either way is declined rather than guessed.
    analyses = {"accoutumes": {"v"}, "litige": {"v", "nc"}}
    assert dominant_pos(analyses, {}) == {"accoutumes": "v", "litige": None}
    # an all-zero Lexique entry is not evidence either — it falls through to case 2
    assert dominant_pos(analyses, {"accoutumes": {"v": 0.0}})["accoutumes"] == "v"
    # a dead-heat between two classes dominates nothing
    assert dominant_pos({"tie": {"v", "nc"}}, {"tie": {"v": 5.0, "nc": 5.0}}) == {
        "tie": None}


def test_lexique_classes_speak_the_artifacts_pos_vocabulary():
    assert lexique_class("VER") == lexique_class("AUX") == "v"
    assert lexique_class("NOM") == "nc"
    assert lexique_class("ADJ") == "adj"
    assert lexique_class("ADJ:pos") == lexique_class("ART:def") == "det"
    assert lexique_class("PRO:per") == "pro"
    # a category with no Morphalou counterpart still competes, as itself
    assert lexique_class("EXP") == "EXP"


def test_collect_rows_marks_dom_per_row_and_keeps_gated_targets():
    token_re = gen_phrase.CONFIG["fr"]["token_regex"]
    weight = lexique_weights([("évident", "VER", 0.27), ("évident", "ADJ", 20.14),
                              ("pensé", "VER", 97.57)], token_re)
    lexemes = {
        ("évider", "v"): {"ind:pre:3p": {"évident"}},
        ("évident", "adj"): {"adj:m:s": {"évident"}},
        ("penser", "v"): {"par:pas:m:s": {"pensé"}},
    }
    rows = {r[:5] for r in collect_rows(lexemes, weight)}
    # the gated verb reading stays in the table (a legal TARGET), marked dom=0...
    assert ("évider", "v", "ind:pre:3p", "évident", 0) in rows
    # ...while the dominant reading of the same surface carries dom=1.
    assert ("évident", "adj", "adj:m:s", "évident", 1) in rows
    assert ("penser", "v", "par:pas:m:s", "pensé", 1) in rows


# --- the loader: one artifact, two views -------------------------------------------

def test_grouping_spans_every_pos_and_the_verb_view_filters():
    # grouping is the #104 merge-walk table: every POS, lexeme keys as group ids —
    # "pensée" the noun and penser's participle are two lexemes sharing a surface.
    assert TABLE.grouping["pensée"] == ("penser:v", "pensée:nc")
    assert TABLE.grouping["jardin"] == ("jardin:nc",)
    assert set(TABLE.grouping["évident"]) == {"évider:v", "évident:adj"}
    # the agreement pass reads the VERB view only: a noun row is not an analysis,
    # not a cell, and no nominal feature leaks into --form's inventory.
    assert "jardin" not in TABLE.entries
    assert ("pensée:nc", "n:s") not in TABLE.realize
    assert not {"n:s", "n:p", "adj:m:s", "cit"} & set(TABLE.features)


def test_the_two_naive_rewrites_are_refused():
    resolver = _resolver()
    # évident -> évidé: the POS gate refuses to read "évident" as a verb at all.
    assert resolver.features_of("évident") == ()
    assert resolver.realize("évident", "par:pas:m:s") is None
    # pensé -> pensée: the gender lives in the feature, so a masculine target stays
    # masculine. (And "pensée" is gated as a source in its own right.)
    assert resolver.realize("pensé", "par:pas:m:s") == "pensé"
    assert resolver.realize("pensé", "par:pas:f:s") == "pensée"


# --- 9. the secret decides, silently, whenever its row is unambiguous -------------

def test_target_form_is_read_off_the_secret_with_no_prompt_and_no_flag(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _p="": pytest.fail("asked"))
    assert _resolver(interactive=True).feature_for("marchait") == "ind:imp:3s"
    # A noun is never asked "which verb form?" — most secrets are nouns, and the table
    # not knowing a word is not evidence that it is a verb.
    assert _resolver(interactive=True).feature_for("jardin", _donors()) is None


def test_only_a_word_that_could_be_a_verb_is_asked_about():
    resolver = _resolver(interactive=True)
    # "accoutumes" is a real 2sg the embedding lacks: the lemma bridge reaches
    # "accoutumer:v" through its accent sibling, so the question is worth asking —
    # and the bridge's keys and the verb view's keys are ONE namespace (#132).
    assert resolver.could_be_a_verb("accoutumes", _donors())
    # "jardin" reaches only its noun lexeme.
    assert not resolver.could_be_a_verb("jardin", _donors())
    # and with no bridge to walk, nothing is asked.
    assert not resolver.could_be_a_verb("accoutumes", None)


# --- 10. an ambiguous secret is never guessed -------------------------------------

def test_ambiguous_secret_needs_an_explicit_form_off_a_tty():
    # "compris" is past participle OR 1s/2s past historic: three features, no default.
    assert _resolver().features_of("compris") == (
        "ind:pas:1s", "ind:pas:2s", "par:pas:m:s")
    assert _resolver().feature_for("compris") is None
    assert _resolver(explicit={"compris": "par:pas:m:s"}).feature_for("compris") == \
        "par:pas:m:s"


def test_unknown_form_flag_is_a_clear_error(capsys):
    with pytest.raises(SystemExit):
        _resolver(explicit={"compris": "ind:pre:9z"}).feature_for("compris")
    assert "n'est pas un trait connu" in capsys.readouterr().err


def test_form_flag_parsing_rejects_a_malformed_pair(capsys):
    assert gen_phrase.parse_form_args(["Accoutumes=ind:pre:2s"]) == {
        "accoutumes": "ind:pre:2s"}
    with pytest.raises(SystemExit):
        gen_phrase.parse_form_args(["accoutumes"])
    assert "MOT=TRAIT" in capsys.readouterr().err


# --- 11-13. what the pass rewrites, and what it declines --------------------------

def test_pass_agrees_the_displayable_groups_and_their_aliases():
    # secret "amuses" (ind:pre:2s). "marchait" is a verb that must become "marches";
    # its alias key "marche" must follow, so typing any form displays the agreed one.
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1),
                ("marche", "marchait", 1), ("jardin", "jardin", 2))
    changed = _resolver().apply(rmap, 5, "amuses", _donors())

    assert changed == {1: ("marchait", "marches")}
    assert rmap["marchait"] == {"word": "marches", "rank": 1}
    assert rmap["marche"] == {"word": "marches", "rank": 1}   # the alias followed
    assert rmap["marches"] == {"word": "marches", "rank": 1}  # ...and the new slug is keyed
    # 11. a noun the verb view knows nothing about is left alone, as is the secret.
    assert rmap["jardin"] == {"word": "jardin", "rank": 2}
    assert rmap["amuses"] == {"word": "amuses", "rank": 0}


def test_a_rewrite_the_player_could_not_type_is_declined():
    # 12. the table knows distraire -> "distrais", but no reduced word folds to that
    # slug: displaying it would print a hint nobody can type back.
    rmap = _map(("amuses", "amuses", 0), ("distraire", "distraire", 1))
    assert _resolver().apply(rmap, 5, "amuses", _donors()) == {}
    assert rmap["distraire"] == {"word": "distraire", "rank": 1}


def test_groups_past_the_start_rank_are_never_touched():
    # 13. a hole starts at start_rank and only improves, so rank 4 can never be shown.
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 2),
                ("lassés", "lassés", 4))
    changed = _resolver().apply(rmap, 2, "amuses", _donors())

    assert changed == {2: ("marchait", "marches")}
    assert "lasses" not in rmap  # no key invented for a group nobody can reach
    assert rmap["lassés"] == {"word": "lassés", "rank": 4}


# --- 14. the collision rule: decline, never contradict -----------------------------

def test_cross_group_collision_skips_the_rewrite():
    # "lassés" at rank 3 would become "lasses" — but a CLOSER group already owns that
    # slug at rank 1. Rewriting anyway would print "lasses" beside exponent 3 while
    # typing it read 1: a displayed clue improving its own hole. So it is declined.
    rmap = _map(("amuses", "amuses", 0), ("lasses", "autre", 1),
                ("lassés", "lassés", 3))
    assert _resolver().apply(rmap, 5, "amuses", _donors()) == {}
    assert rmap["lassés"] == {"word": "lassés", "rank": 3}   # original form kept
    assert rmap["lasses"] == {"word": "autre", "rank": 1}    # closer group untouched

    # positive control: with that slug free, the very same rewrite happens.
    free = _map(("amuses", "amuses", 0), ("lassés", "lassés", 3))
    assert _resolver().apply(free, 5, "amuses", _donors()) == {3: ("lassés", "lasses")}
    assert free["lasses"] == {"word": "lasses", "rank": 3}


def test_a_group_reclaimed_down_to_nothing_is_not_resurrected_without_geometry():
    # The reclaim above, pushed one step: the CLOSER group takes the farther group's only
    # key, so by the time the pass reaches that farther rank it has no entry left to read a
    # dq off. Keying its agreed form anyway would put a rank back on the board carrying no
    # geometry — one that scores a hit in the game and cannot be drawn on its own route map
    # (a dq-less entry is neither a stop nor a miss there). `dq` has no opt-out, so the group
    # stays gone.
    rmap = {
        "amuses": {"word": "amuses", "rank": 0},
        "lassés": {"word": "lassés", "rank": 1, "dq": 255, "road": 0},
        "lasses": {"word": "marchait", "rank": 3, "dq": 200, "road": 0},
    }
    changed = _resolver().apply(rmap, 9, "amuses", _donors())

    assert changed == {1: ("lassés", "lasses")}      # the closer rewrite still happens
    assert rmap["lasses"] == {"word": "lasses", "rank": 1, "dq": 255, "road": 0}
    assert "marches" not in rmap                     # rank 3 is NOT keyed back into the map
    # The invariant this protects, stated directly: nothing ranked ships without its geometry.
    for key, entry in rmap.items():
        if entry["rank"] != 0:
            assert "dq" in entry, f"{key} carries a rank but no dq"


def test_a_farther_key_is_reclaimed_like_any_closest_first_alias():
    # The mirror of the case above: the slug is held by a FARTHER group, so taking it
    # contradicts nothing — closest-first is exactly what expand_aliases already does.
    rmap = _map(("amuses", "amuses", 0), ("lassés", "lassés", 2),
                ("lasses", "autre", 7))
    assert _resolver().apply(rmap, 9, "amuses", _donors()) == {2: ("lassés", "lasses")}
    assert rmap["lasses"] == {"word": "lasses", "rank": 2}


# --- 15. opting out -----------------------------------------------------------------

def test_no_inflect_leaves_the_map_exactly_as_it_was():
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1))
    before = {k: dict(v) for k, v in rmap.items()}
    assert _resolver(table=None).apply(rmap, 5, "amuses", _donors()) == {}
    assert rmap == before
    assert gen_phrase.load_form_table("fr", disabled=True) is None
    # en has no inventory at all — a decided non-goal, not a missing file.
    assert gen_phrase.load_form_table("en") is None


def test_a_rewritten_hole_is_reported():
    resolver = _resolver()
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1))
    resolver.apply(rmap, 5, "amuses", _donors())
    assert resolver.used == {"amuses": ("amuses", "ind:pre:2s", 1)}
    # a hole nothing moved is never announced
    quiet = _resolver()
    quiet.apply(_map(("amuses", "amuses", 0), ("jardin", "jardin", 1)), 5, "amuses",
                _donors())
    assert quiet.used == {}


# --- the COMMITTED artifact, not just the fixture ---------------------------------
# A fixture only holds rows someone wrote by hand, so it can never catch what the SOURCE
# does or does not say. These anchors read the real committed table, which is what ships.

@functools.lru_cache(maxsize=1)
def committed():
    """The real shipped inventory, loaded once through the production loader — as a
    function so a missing or corrupt artifact fails the tests that read it rather
    than collecting the whole module."""
    return gen_phrase.load_form_table("fr")


@pytest.mark.parametrize("lemma,feature,expected", [
    ("marcher:v", "ind:imp:3s", "marchait"),
    ("marcher:v", "ind:pre:2s", "marches"),
    ("vivre:v", "ind:imp:3s", "vivait"),
    ("venir:v", "inf", "venir"),
    ("devoir:v", "inf", "devoir"),
    ("abandonner:v", "ind:pre:2p", "abandonnez"),
    ("baisser:v", "ind:imp:3s", "baissait"),
    ("penser:v", "imp:pre:2s", "pense"),
    ("penser:v", "par:pas:m:s", "pensé"),      # ...and pensée below: distinct genders
    ("penser:v", "par:pas:f:s", "pensée"),
    ("comprendre:v", "ind:pas:1s", "compris"),
    ("engourdir:v", "ind:pre:2s", "engourdis"),
    ("avilir:v", "ind:pre:2s", "avilis"),
    # être/avoir are verbs, whatever tagged them auxiliaries elsewhere
    ("avoir:v", "par:pas:m:s", "eu"),          # "avais" may realize as "eu"
    ("être:v", "par:pas:m:s", "été"),
    ("avoir:v", "ind:pre:3p", "ont"),
    ("avoir:v", "ind:fut:1s", "aurai"),
    # a number-invariable participle realizes BOTH cells, not just the singular
    ("prendre:v", "par:pas:m:p", "pris"),
    ("prendre:v", "par:pas:m:s", "pris"),
    # ...while a participle that DOES distinguish still keeps them apart
    ("amuser:v", "par:pas:m:p", "amusés"),
    ("amuser:v", "par:pas:m:s", "amusé"),
    # the paradigm cells Lexique's corpus never attested, the agreement pass's point
    ("accoutumer:v", "ind:pre:2s", "accoutumes"),
    ("distraire:v", "ind:pre:2s", "distrais"),
])
def test_committed_table_realizes_the_real_form(lemma, feature, expected):
    # [0] is the PREFERRED spelling; a paradigm may hold more (see the fallback test).
    assert committed().realize.get((lemma, feature), ())[:1] == (expected,)


@pytest.mark.parametrize("form,analyses", [
    # exactly the future 1s of avoir — no invented "aurai / inf"
    ("aurai", (("avoir:v", "ind:fut:1s"),)),
    # the cell Lexique never saw, plus the subjunctive it genuinely shares
    ("accoutumes", (("accoutumer:v", "ind:pre:2s"), ("accoutumer:v", "sub:pre:2s"))),
    # present 1s, present 2s and imperative 2s, one spelling
    ("distrais", (("distraire:v", "imp:pre:2s"), ("distraire:v", "ind:pre:1s"),
                  ("distraire:v", "ind:pre:2s"))),
    ("pensé", (("penser:v", "par:pas:m:s"),)),
    ("pensée", (("penser:v", "par:pas:f:s"),)),
])
def test_committed_table_analyses_the_form_exactly(form, analyses):
    assert tuple(sorted(committed().entries.get(form, ()))) == analyses


def test_the_source_side_gate_still_declines_a_dominant_non_verb():
    table = committed()
    # "évident" is a form of "évider" on paper and overwhelmingly the adjective, so it
    # is never READ as a verb — while staying available as a target realization.
    assert "évident" not in table.dominant
    assert gen_phrase.FormResolver(table).features_of("évident") == ()
    assert table.realize[("évider:v", "ind:pre:3p")] == ("évident",)
    # "pensée" likewise: gated as a source, legal as penser's f:s participle.
    assert "pensée" not in table.dominant
    # ...and the auxiliaries ARE admitted, so an être/avoir hole can agree at all.
    for form in ("avais", "ai", "ont", "avez", "étant", "été", "eu", "aurai"):
        assert form in table.dominant, form


def test_an_auxiliary_secret_still_refuses_to_guess_when_it_is_ambiguous():
    # Admitted is not the same as unambiguous: "avais" is 1s or 2s and asks.
    resolver = gen_phrase.FormResolver(committed())
    assert resolver.features_of("avais") == ("ind:imp:1s", "ind:imp:2s")
    assert resolver.feature_for("avais") is None
    assert resolver.realize("avais", "par:pas:m:s") == "eu"


def test_a_number_invariable_participle_secret_is_asked_about():
    # "conquis" covers m:s and the past historic, so « j'ai conquis » must not
    # silently pick one. Several candidates -> the batch run declines and --form
    # settles it, exactly like any other ambiguous secret.
    resolver = gen_phrase.FormResolver(committed())
    assert len(resolver.features_of("conquis")) > 1
    assert "par:pas:m:s" in resolver.features_of("conquis")
    assert resolver.feature_for("conquis") is None
    settled = gen_phrase.FormResolver(committed(),
                                      explicit={"conquis": "par:pas:m:s"})
    assert settled.feature_for("conquis") == "par:pas:m:s"
    assert settled.realize("amusé", "par:pas:m:s") == "amusé"


def test_a_rewrite_falls_back_to_a_typable_spelling():
    # A paradigm can spell one cell more than one way, and the artifact's preference
    # order is corpus frequency — which knows nothing about the reduced vocabulary.
    # Keeping only the favourite made the whole group decline when that spelling was
    # untypable, even with a typable alternative sitting right behind it.
    table = committed()
    assert table.realize[("déblayer:v", "ind:pre:2s")] == ("déblaies", "déblayes")
    resolver = gen_phrase.FormResolver(table)
    assert resolver.realize("déblayer", "ind:pre:2s") == "déblaies"   # preferred...
    assert resolver.realizations("déblayer", "ind:pre:2s") == ("déblaies", "déblayes")

    # "déblaies" is not typable here, "déblayes" is -> the group agrees on the latter.
    vocab = ["déblayer", "déblayes", "amuses"]
    donors = gen_phrase.DonorResolver({}, {}, vocab, set(vocab), "fr")
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    assert resolver.apply(rmap, 5, "amuses", donors) == {}   # secret has no feature
    settled = gen_phrase.FormResolver(table, explicit={"amuses": "ind:pre:2s"})
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    assert settled.apply(rmap, 5, "amuses", donors) == {1: ("déblayer", "déblayes")}
    assert rmap["deblayer"]["word"] == "déblayes"

    # ...and with NEITHER spelling typable the group is left alone, as before.
    bare = ["déblayer", "amuses"]
    none_typable = gen_phrase.DonorResolver({}, {}, bare, set(bare), "fr")
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    assert gen_phrase.FormResolver(
        table, explicit={"amuses": "ind:pre:2s"}).apply(
            rmap, 5, "amuses", none_typable) == {}


def test_a_group_already_in_the_right_cell_is_not_respelled():
    # The mirror of the fallback: when the canonical is ANY spelling of the target cell
    # it is already agreed, so there is nothing to fix. Matching only the PREFERRED
    # spelling turned "asseyent" into "assoient" — same cell, different spelling, no
    # agreement gained, and one more chance to land on an untypable word.
    table = committed()
    assert table.realize[("asseoir:v", "ind:pre:3p")] == ("assoient", "asseyent")
    vocab = ["asseyent", "assoient", "ont"]
    donors = gen_phrase.DonorResolver({}, {}, vocab, set(vocab), "fr")
    rmap = _map(("ont", "ont", 0), ("asseyent", "asseyent", 1))
    resolver = gen_phrase.FormResolver(table, explicit={"ont": "ind:pre:3p"})
    assert resolver.apply(rmap, 5, "ont", donors) == {}
    assert rmap["asseyent"] == {"word": "asseyent", "rank": 1}


# --- whole-table checks required by the schema ------------------------------------

def test_every_feature_in_the_committed_table_is_a_known_cell():
    # Source agreement columns must EXPAND into the internal vocabulary. An
    # unexpanded value would show up here as an unknown feature — and would be
    # unreachable from --form.
    #
    # The allowed set is the REAL cell inventory, not the mood x person x number
    # product: the product would wave through "imp:pre:3s", which is not a French
    # cell and which the old (Lexique) artifact actually contained.
    finite = {f"{m}:{p}{n}"
              for m in ("ind:pre", "ind:fut", "ind:imp", "ind:pas", "cnd:pre",
                        "sub:pre", "sub:imp")
              for p in "123" for n in "sp"}
    imperative = {"imp:pre:2s", "imp:pre:1p", "imp:pre:2p"}
    participles = {f"par:pas:{g}:{n}" for g in "mf" for n in "sp"}
    known = finite | imperative | participles | {"par:pre", "inf"}
    assert committed().features <= known
    assert "imp:pre:3s" not in committed().features


def test_the_committed_table_has_no_duplicate_row():
    rows = [(lemma, feature, form)
            for form, pairs in committed().entries.items()
            for lemma, feature in pairs]
    assert len(rows) == len(set(rows))


def test_every_realization_is_deterministic():
    # `realize` holds the candidates in the artifact's order, so the sort must be
    # total: same inputs, same order, every build. And the candidate list must be
    # exactly the spellings the table actually gives that cell — no more, no fewer.
    table = committed()
    by_pair = {}
    for form, pairs in table.entries.items():
        for lemma, feature in pairs:
            by_pair.setdefault((lemma, feature), set()).add(form)
    for pair, forms in by_pair.items():
        assert set(table.realize[pair]) == forms
        assert len(table.realize[pair]) == len(forms)   # ordered, deduped
    assert len(table.realize) == len(by_pair)


# --- the #131 pins, asserted against what actually ships ---------------------------
# The COMPLETE audit set, restated here from the #131 report rather than imported
# from the builder: EXPECTED_CELLS failing the build and this table failing the tests
# are two independent statements of the same audit, so weakening one cannot silently
# weaken the other. The wrong-paradigm cells must hold ONLY the real forms (a
# wrong-only cell comes out EMPTY — a missing agreement degrades to the dictionary
# form, a wrong one ships «je sortis»), and the known-lost cells stay lost until a
# re-audited source bump.

AUDITED_CELLS = [
    # the two cell-level holes
    ("pouvoir", "sub:pre:2s", None),
    ("asseoir", "par:pas:m:p", None),
    # the cells Morphalou lacks a Lefff-attested spelling in
    ("asseoir", "ind:pre:1s", {"assieds"}),
    ("asseoir", "sub:pre:1s", {"asseye"}),
    ("essayer", "cnd:pre:1s", {"essaierais"}),
    ("foutre", "cnd:pre:1s", {"fouterais"}),
    ("fuir", "ind:imp:1s", None),
    ("fuir", "sub:pre:1s", None),
    ("payer", "cnd:pre:1s", {"paierais"}),
    ("pouvoir", "ind:pre:1s", {"puis"}),
    ("repartir", "ind:imp:1s", None),
    ("repartir", "ind:pre:1s", None),
    ("repartir", "sub:pre:1s", None),
    ("sortir", "ind:imp:1s", None),
    ("sortir", "ind:pre:1s", None),
    ("sortir", "sub:pre:1s", None),
    # the polluted cells, purged down to the real paradigm
    ("fuir", "sub:pre:3s", {"fuie"}),
    ("pouvoir", "sub:pre:3s", {"puisse", "puisses"}),
    ("repartir", "imp:pre:1p", {"repartons"}),
    ("repartir", "imp:pre:2p", {"repartez"}),
    ("repartir", "imp:pre:2s", {"repars"}),
    ("repartir", "ind:imp:3p", {"repartaient"}),
    ("repartir", "ind:imp:3s", {"repartait"}),
    ("repartir", "ind:pre:1p", {"repartons"}),
    ("repartir", "ind:pre:2p", {"repartez"}),
    ("repartir", "ind:pre:2s", {"repars"}),
    ("repartir", "ind:pre:3p", {"repartent"}),
    ("repartir", "ind:pre:3s", {"repart"}),
    ("repartir", "par:pre", {"repartant"}),
    ("repartir", "sub:pre:3p", {"repartent"}),
    ("sortir", "imp:pre:2s", {"sors"}),
    ("sortir", "ind:pre:2s", {"sors"}),
    ("sortir", "ind:pre:3s", {"sort"}),
    ("foutre", "imp:pre:2s", {"fous", "fouts"}),
    # spot checks + legitimate-variation controls
    ("conquérir", "par:pas:m:p", None),
    ("payer", "ind:pre:1s", {"paie", "paye"}),
    ("finir", "ind:pre:1s", {"finis"}),
]


@pytest.mark.parametrize("lemma,feature,expected", AUDITED_CELLS)
def test_every_audited_131_cell_ships_exactly_as_audited(lemma, feature, expected):
    forms = committed().realize.get((f"{lemma}:v", feature))
    if expected is None:
        assert forms is None, (lemma, feature, forms)
    else:
        assert forms is not None and set(forms) == expected, (lemma, feature, forms)


def test_the_audited_preference_orders_hold():
    # where a pinned cell holds several spellings, frequency must order the real one
    # first — «fous» over the Lefff-import class error, «puisse» over the mis-tag.
    table = committed()
    assert table.realize[("foutre:v", "imp:pre:2s")][0] == "fous"
    assert table.realize[("pouvoir:v", "sub:pre:3s")][0] == "puisse"
    assert table.realize[("payer:v", "ind:pre:1s")][0] == "paie"
    # the mis-tagged «puisses» may not resurface as the 2s it actually is.
    assert ("pouvoir:v", "sub:pre:2s") not in set(
        committed().entries.get("puisses", ()))
    # and the cleanup must not gut asseoir-style genuine variation elsewhere.
    assert "assois" in set(table.realize[("asseoir:v", "ind:pre:2s")])


def test_the_grouping_is_the_same_artifact_as_the_agreement_pass():
    """#132's point, stated as the call sites see it: gen_phrase's fr lemma_table IS
    the inventory's grouping — one dictionary, one namespace, so the merge walk and
    the display pass cannot disagree about what a form belongs to."""
    assert gen_phrase.load_lemma_table("fr") is committed().grouping
    assert gen_phrase.load_lemma_table("fr", disabled=True) == {}
    # the verb view's lexeme keys resolve inside the grouping's namespace
    grouping = committed().grouping
    assert "porter:v" in grouping["porte"] or "porter:v" in grouping["portes"]
    for key, _feat in committed().entries["marchait"]:
        assert key in grouping["marchait"]


def test_homography_is_derivable_from_the_inventory():
    # the #134 discriminator must be readable straight off the rows: «vers» belongs
    # to several lexemes (the worm's plural, the poetry noun, the preposition) while
    # «lunettes» stays resolvable to a nominal lexeme of its own.
    grouping = committed().grouping
    assert {"ver:nc", "vers:nc", "vers:prep"} <= set(grouping["vers"])
    assert "oeil:nc" in grouping["yeux"]
    assert {"priver:v", "privé:adj"} <= set(grouping["privées"])
    # closed classes ride along: their surfaces are grouped and homography-visible
    assert "celui:pro" in grouping["celle"]


def test_a_fresh_build_reproduces_the_committed_artifact_exactly():
    """The committed table must be builder output, not a hand patch.

    Runs the REAL deterministic core over the cached downloads and compares line for
    line. Skipped — never silently passed — when a source is not cached, since the
    builders are offline by design and CI has no network."""
    archive = os.path.join(build_forms.bw.CACHE_DIR, build_forms.MORPHALOU_ARCHIVE)
    lexique = os.path.join(build_forms.bw.CACHE_DIR, "fr.lexique.tsv")
    if not (os.path.exists(archive) and os.path.exists(lexique)):
        pytest.skip("sources not cached (offline builders); run `pnpm forms:fr` first")

    with zipfile.ZipFile(archive) as z:
        csv_text = z.read(build_forms.MORPHALOU_MEMBER).decode("utf-8")
    rows, _stats = build_forms.build_rows("fr", csv_text, lexique)
    expected = [build_forms.row_line(l, p, ft, fo, d)
                for l, p, ft, fo, d, _freq in rows]
    with gzip.open(forms_path("fr"), "rt", encoding="utf-8") as f:
        actual = [line.rstrip("\n") for line in f if not line.startswith("#")]
    assert actual == expected


def test_the_committed_artifact_carries_its_provenance_and_licence():
    # A derived linguistic resource that names no source is not auditable, and the
    # LGPL-LR asks for the notice to travel with the work — so it travels IN the file,
    # and the licence text is committed beside it rather than linked.
    with gzip.open(forms_path("fr"), "rt", encoding="utf-8") as f:
        header = [line for line in f if line.startswith("#")]
    blob = "".join(header)
    assert build_forms.MORPHALOU_SHA256 in blob
    assert build_forms.MORPHALOU_URL in blob
    assert "LGPL-LR" in blob
    licence = build_forms.license_path("fr")
    assert os.path.exists(licence)
    assert "Lesser General Public License" in open(licence, encoding="utf-8").read()


def test_paradigm_coverage_cannot_collapse_back_to_a_corpus_baseline():
    # The reason for the compiled/curated source. Lexique attested `ind:pre:2s` for
    # 1,901 lemmas because a corpus lexicon only holds what it saw; Lefff compiled
    # ~7,800; Morphalou states ~13,000. A regression to a corpus-shaped source would
    # show up here first.
    lemmas = {l for (l, ft) in committed().realize if ft == "ind:pre:2s"}
    assert len(lemmas) > 12_000
    # ...and the cell is not a special case: the ordinary paradigm is just as complete.
    for feature in ("ind:imp:3s", "sub:pre:1s", "par:pas:f:p", "cnd:pre:2p"):
        assert len({l for (l, ft) in committed().realize if ft == feature}) > 12_000


# --- a form with several verb lemmas is declined, not arbitrated -------------------

def test_an_ambiguous_paradigm_is_refused():
    # "durent" is the present of durer AND the past historic of devoir. The table is
    # right about both and the embedding vector means the first, so realizing
    # devoir's paradigm would print "dois" for a word the geometry placed as "durer".
    resolver = _resolver()
    assert {l for l, _f in TABLE.entries["durent"]} == {"devoir:v", "durer:v"}
    assert resolver.realize("durent", "ind:pre:2s") is None
    # the unambiguous neighbour right beside it still agrees.
    assert resolver.realize("marchait", "ind:pre:2s") == "marches"


# --- a batch run DOES agree when the secret's row is unambiguous -------------------

def test_an_unambiguous_secret_agrees_off_a_tty_too():
    # The secret decides everywhere: reading the form off the secret is exactly what
    # lets a piped run agree without being told anything. --no-inflect is the opt-out.
    batch = _resolver(interactive=False)
    assert batch.feature_for("marchait") == "ind:imp:3s"
    rmap = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1))
    assert batch.apply(rmap, 3, "marchait", _donors()) == {1: ("amuse", "amusait")}
    assert rmap["amuse"] == {"word": "amusait", "rank": 1}
    assert batch.used == {"marchait": ("marchait", "ind:imp:3s", 1)}
    # ...and an ambiguous one still refuses to guess, TTY or not.
    assert batch.feature_for("compris") is None


# --- a rewrite may never take the slug another group PRINTS ------------------------

def test_a_rewrite_never_takes_a_farther_groups_canonical_key():
    """The hint a hole prints must type back at that hole's own exponent.

    A closer group's rewrite can land on a farther group's CANONICAL key: "amusait" at
    rank 2 agrees to "amusé", whose slug IS "amuse" — the word rank 5 prints. Taking it
    would leave rank 5 showing "amuse" while typing "amuse" read 2. It bites hardest on
    the start hint, whose start_rank is captured BEFORE the pass runs, so the hole would
    ship start.word="amuse" at start_rank 5 against a map that said 2 — a printed clue
    improving its own hole, which is exactly what the closer-owner rule refuses from the
    other side. So the closer group declines, and the start group agrees for itself."""
    rmap = _map(("amuses", "amuses", 0), ("amusait", "amusait", 2),
                ("amuse", "amuse", 5))
    agreed = _resolver(explicit={"amuses": "par:pas:m:s"}).apply(
        rmap, 5, "amuses", _donors())

    assert 2 not in agreed                      # the closer group declined...
    assert agreed == {5: ("amuse", "amusé")}    # ...and rank 5 kept its own slug
    assert rmap["amusait"] == {"word": "amusait", "rank": 2}

    # THE invariant, stated as the call sites see it: whatever the hole ends up printing
    # looks up at the hole's own start_rank, never at a closer one.
    start_rank = 5
    start_display = agreed.get(start_rank, ("amuse", "amuse"))[1]
    assert start_display == "amusé"
    assert rmap[gen_phrase.slug(start_display)]["rank"] == start_rank


def test_only_a_displayable_groups_canonical_key_is_protected():
    # The protection exists because the owner still PRINTS that word. Past start_rank no
    # hole can ever render it, so there is nothing to strand and the slug is as
    # reclaimable as any alias — guarding it would only cost live rewrites.
    far = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1),
               ("amusait", "amusait", 20))          # canonical, but rank 20 > start 5
    assert _resolver().apply(far, 5, "marchait", _donors()) == {1: ("amuse", "amusait")}
    assert far["amusait"] == {"word": "amusait", "rank": 1}

    # ...and the control: the very same collision INSIDE the displayable range declines.
    near = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1),
                ("amusait", "amusait", 4))          # canonical at rank 4 <= start 5
    assert _resolver().apply(near, 5, "marchait", _donors()) == {}
    assert near["amusait"] == {"word": "amusait", "rank": 4}
    assert near["amuse"] == {"word": "amuse", "rank": 1}


# --- artifact integrity ------------------------------------------------------------

def test_a_truncated_table_fails_loudly(tmp_path):
    # Silently skipping short lines would load half a table and agree half a puzzle.
    broken = tmp_path / "forms.tsv"
    broken.write_text("amuser\tv\tind:pre:2s\tamuses\t1\nmarcher\tv\tind:imp:3s\n",
                      encoding="utf-8")
    with pytest.raises(ValueError, match="champs attendus"):
        load_forms(str(broken))


def test_form_flag_is_case_insensitive_on_both_sides():
    assert gen_phrase.parse_form_args(["Marchait=IND:IMP:3S"]) == {
        "marchait": "ind:imp:3s"}


def test_a_reclaimed_key_is_not_dragged_along_by_its_old_group():
    """The other half of the finding-4 fix: a group can have one of its keys reclaimed
    by a CLOSER group and still rewrite legitimately. Writing its new form over every
    key it used to hold would hand the closer group this group's word."""
    # Secret "marchait" (ind:imp:3s). Rank 5 holds two keys — "noies" its canonical and
    # "amusait" an alias. Rank 2 agrees to "amusait" and takes that slug; rank 5 then
    # agrees to the still-free "noyait", so BOTH groups rewrite and one of rank 5's keys
    # is no longer its own.
    rmap = _map(("marchait", "marchait", 0), ("amuse", "amuse", 2),
                ("noies", "noies", 5), ("amusait", "noies", 5))
    changed = _resolver().apply(rmap, 9, "marchait", _donors())

    assert changed == {2: ("amuse", "amusait"), 5: ("noies", "noyait")}
    # the reclaimed key belongs to the closer group now, and kept ITS form — without
    # the rank check it would have been overwritten with rank 5's "noyait".
    assert rmap["amusait"] == {"word": "amusait", "rank": 2}
    assert rmap["amuse"] == {"word": "amusait", "rank": 2}
    # ...while the group that lost it still agreed, on the keys it still owns
    assert rmap["noies"] == {"word": "noyait", "rank": 5}
    assert rmap["noyait"] == {"word": "noyait", "rank": 5}
