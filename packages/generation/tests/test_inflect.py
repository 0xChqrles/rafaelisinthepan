"""CONTRACT: display agreement for every word a hole can show (#119 addendum 2).

A hole displays the player's current best word, so that word should agree with the
sentence: « tu t'___ » must read "t'distrais", never "t'distraire". The rules:

  - the set to agree is EXACTLY the groups at rank <= start_rank — a hole only ever
    improves and starts at start_rank, so no farther group is ever rendered;
  - rank 0 is never touched: it already holds the true sentence form;
  - the target form is the SECRET's own morphology, read off the committed table; the
    author is asked only when the secret has no row or an ambiguous one, and a batch
    run without --form applies NO agreement (byte-identical to before);
  - a group is left alone when its canonical is not a POS-admitted verb, has no such
    form, would become a word nobody could type back, or would land on a slug a CLOSER
    group already owns — never a rewrite that contradicts the smallest-rank rule;
  - rewriting a group rewrites every entry carrying it (aliases included) and keys the
    new slug at that same rank, so typing any form of the group displays the agreed one;
  - the POS gate is by Lexique frequency: "évident" is a form of "évider" on paper but
    dominantly the adjective, so it is never read — nor written — as a verb.
"""

import os

import pytest

import gen_phrase
from build_forms import (collect_rows, dominant_verbs, feature_key, load_forms)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TABLE = load_forms(os.path.join(FIXTURES, "forms.fr.tsv"))

# The reduced vocabulary these tests run against. "distrais" is deliberately ABSENT:
# it is the untypable-rewrite case (Lexique knows the form, the embedding does not).
VOCAB = ["jardin", "amuse", "amuses", "amusé", "distraire", "marchait", "marches",
         "lasses", "lassés", "compris", "pensé", "évident", "évidé", "noyé", "noies",
         "accoutume", "accoutumer", "accoutumés"]
VSET = set(VOCAB)

# The #104 table the donor bridge walks: "accoutumes" has no row of its own (as in the
# real Lexique), so only its accent sibling can name the accoutumer group.
LEMMAS = {"accoutume": ("accoutumer",), "accoutumer": ("accoutumer",),
          "accoutumés": ("accoutumer",), "jardin": ("jardin",)}


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


# --- the table itself -----------------------------------------------------------

def test_participles_carry_their_agreement_in_the_feature_key():
    # A bare "par:pas" would let a masculine target realize as "pensée"; Lexique keeps
    # the agreement in its own columns, so the key has to absorb it.
    assert feature_key("par:pas", "f", "p") == "par:pas:f:p"
    assert feature_key("ind:pre:2s", "", "") == "ind:pre:2s"
    # unmarked agreement reads as masculine singular, as in French
    assert feature_key("par:pas", "", "") == "par:pas:m:s"


def test_pos_gate_keeps_the_dominant_category(tmp_path):
    # "évident": 0.27 as a form of "évider", 20.14 as the adjective -> not a verb here.
    # "pensé": only ever the verb -> admitted. Frequencies are summed per category.
    rows = [("évident", "évider", "VER", "", "", "ind:pre:3p;", 0.27),
            ("évident", "évident", "ADJ", "m", "s", "", 20.14),
            ("pensé", "penser", "VER", "m", "s", "par:pas;", 97.57),
            ("pensée", "penser", "VER", "f", "s", "par:pas;", 1.42),
            ("pensée", "pensée", "NOM", "f", "s", "", 98.92)]
    token_re = gen_phrase.CONFIG["fr"]["token_regex"]
    dominant = dominant_verbs(rows, token_re)
    assert dominant == {"pensé"}
    # ...but a gated form still stays in the table: it can be someone else's correct
    # realization ("pensée" IS the f:s participle of "penser").
    built = collect_rows(rows, token_re, dominant)
    assert ("penser", "par:pas:f:s", "pensée", 0) in [r[:4] for r in built]
    assert ("évider", "ind:pre:3p", "évident", 0) in [r[:4] for r in built]


def test_the_two_naive_rewrites_are_refused(monkeypatch):
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
    # "accoutumes" is a real 2sg Lexique never attested: the lemma bridge reaches
    # "accoutumer" through its accent sibling, so the question is worth asking.
    assert resolver.could_be_a_verb("accoutumes", _donors())
    # "jardin" reaches only itself.
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
    # 11. a noun the table knows nothing about is left alone, as is the secret itself.
    assert rmap["jardin"] == {"word": "jardin", "rank": 2}
    assert rmap["amuses"] == {"word": "amuses", "rank": 0}


def test_a_rewrite_the_player_could_not_type_is_declined():
    # 12. Lexique knows distraire -> "distrais", but no reduced word folds to that slug:
    # displaying it would print a hint nobody can type back.
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
    # en has no table at all — a decided non-goal, not a missing file.
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
