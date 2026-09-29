"""CONTRACT (#317): the English word-group inventory, wordlist/en.forms.tsv.gz.

English is made like French, as far as the language allows:
  - ONE artifact, the fr columns (`group lemma pos feature form dom`): AGID states the
    lexeme, VarCon the American/British spellings, OANC the POS evidence;
  - AGID's own doubts are honoured: uncertain spellings (~ ! ?) and obscure variants
    (level >= 2) drop; the parser fails closed outside the README's grammar, the
    special paradigms (be, wit, the modals…) being skipped BY NAME;
  - a GUESSED entry (`POS?`) keeps only what no trusted entry already states — the
    twin of Morphalou's mixed-entry rule — so «parsed» is parse's, never «pars»'s;
  - an adjective needs both degrees (AGID files agent nouns as comparatives);
  - American and British spellings are ONE group (colour = color), a sense-restricted
    VarCon pair (check / cheque | bank) never joins;
  - a noun and a verb of one spelling are ONE group (a walk / to walk);
  - no gender: an English noun is asked its number, never a gender; an adjective's
    degree is confirmed and transferred to nobody; nouns take number, verbs tense.
"""

import functools
import gzip
import os
import tarfile

import pytest

import build_forms
import gen_phrase
from build_forms import (complete_adjectives, corroborate_agid, expand_variants,
                         forms_path, load_forms, merge_entries, read_agid, read_varcon)

TOKEN = build_forms.red.token_pattern("en")


# --- AGID ----------------------------------------------------------------------------

def test_agid_lines_parse_into_cells_and_a_three_slot_verb_has_one_past():
    lexemes, guessed, _stats = read_agid(
        "walk V: walked | walking | walks\n"
        "go V: went | gone | going | goes\n"
        "child N: children\n"
        "big A: bigger | biggest\n", TOKEN)
    assert {cell: set(forms) for cell, forms in lexemes[("walk", "v")].items()} == {
        "base": {"walk"}, "ind:pas": {"walked"}, "par:pas": {"walked"},
        "par:pre": {"walking"}, "ind:pre:3s": {"walks"}}
    assert set(lexemes[("go", "v")]["par:pas"]) == {"gone"}
    assert {cell: set(forms) for cell, forms in lexemes[("child", "nc")].items()} == {
        "n:s": {"child"}, "n:p": {"children"}}
    assert set(lexemes[("big", "adj")]["adj:sup"]) == {"biggest"}
    assert guessed == set()


def test_agid_doubts_drop_and_variant_levels_below_two_stay():
    lexemes, _g, stats = read_agid(
        "leaf N: leaves, leafs 2\n"
        "dream V: dreamed, dreamt 1 | dreaming | dreams\n"
        "cut A: cutter, cuter!< 1 | cutest\n"
        "go A: goer | goest?\n"
        "discus N: discuses, discusses< 1, disci 2\n", TOKEN)
    assert set(lexemes[("leaf", "nc")]["n:p"]) == {"leaves"}       # level 2 gone
    # level 1 kept, AGID's preferred spelling first (level, then place in the slot)
    assert lexemes[("dream", "v")]["ind:pas"] == {"dreamed": (0.0, 0), "dreamt": (1.0, 1)}
    assert set(lexemes[("cut", "adj")]["adj:cmp"]) == {"cutter"}   # «!» gone
    assert "adj:sup" not in lexemes[("go", "adj")]                 # «?» gone
    assert set(lexemes[("discus", "nc")]["n:p"]) == {"discuses"}   # «<» gone too
    assert stats["unsure"] == 3 and stats["obscure"] == 2


def test_a_zero_form_stays_only_where_agid_prefers_it():
    lexemes, _g, stats = read_agid(
        "sheep N: sheep\n"
        "duck N: ducks, duck {:1}\n"
        "cannon N: cannons, cannon 1\n"
        "beat V: beat | beaten, beat 1 | beating | beats\n", TOKEN)
    assert set(lexemes[("sheep", "nc")]["n:p"]) == {"sheep"}      # the zero plural IS it
    assert set(lexemes[("duck", "nc")]["n:p"]) == {"ducks"}       # a sense variant, gone
    assert set(lexemes[("cannon", "nc")]["n:p"]) == {"cannons"}
    assert set(lexemes[("beat", "v")]["ind:pas"]) == {"beat"}     # level 0: kept
    assert set(lexemes[("beat", "v")]["par:pas"]) == {"beaten"}   # level 1: gone
    assert stats["citation_variant"] == 3


def test_the_adjective_check_runs_before_corroboration_so_agent_nouns_keep_their_word():
    lexemes, guessed, _s = read_agid("stone A: stoner | stonest?\nstone N: stones\n"
                                     "stoner N?: stoners\n", TOKEN)
    kept, _n = complete_adjectives(lexemes)       # stone A has no superlative: gone
    kept, dropped = corroborate_agid(kept, guessed)
    assert ("stoner", "nc") in kept and dropped["entries"] == 0


def test_agid_special_paradigms_are_skipped_by_name_and_proper_names_left_out():
    lexemes, _g, stats = read_agid(
        "be V: was, wast 2 | were | been | being | am | are, art 2 | is | are\n"
        "may V: might | may, mayst 2\n"
        "March N: Marches\n"
        "march N: marches\n", TOKEN)
    assert set(lexemes) == {("march", "nc")}
    assert stats["special"] == 2 and stats["proper"] == 1


@pytest.mark.parametrize("line", [
    "walk V: walked | walks\n",            # two slots: not a verb's grammar
    "walk X: walked\n",                    # unknown POS
    "walk V: walked | walk ing | walks\n",  # an unreadable form
])
def test_the_agid_parser_fails_closed(line):
    with pytest.raises(ValueError):
        read_agid(line, TOKEN)


def test_a_guessed_entry_keeps_only_what_no_trusted_entry_states():
    lexemes, guessed, _s = read_agid(
        "parse V: parsed | parsing | parses\n"
        "par N: pars\n"
        "pars V?: parsed | parsing | parses\n"            # another word's forms
        "low A: lower | lowest\n"
        "lowe A?: lower | lowest\n"
        "newspaper N: newspapers\n"
        "newspaper V?: newspapered? | newspapering? | newspapers\n"  # the plural, as a verb
        "scammer N?: scammers\n"                          # a real word of its own
        "socialize V: socialized | socializing | socializes\n"
        "socialise V?: socialised | socialising | socialises\n", TOKEN)
    kept, dropped = corroborate_agid(lexemes, guessed)
    assert ("pars", "v") not in kept          # its lemma is par's plural
    assert ("newspaper", "v") not in kept     # nothing of its own left
    assert ("lowe", "adj") not in kept        # both degrees were low's
    assert ("scammer", "nc") in kept and ("socialise", "v") in kept
    assert dropped == {"entries": 3, "rows": 3}  # lower, lowest, newspapers


def test_an_adjective_needs_both_degrees():
    lexemes, _g, _s = read_agid("travel A: traveler | travelest?\n"
                                "big A: bigger | biggest\n", TOKEN)
    kept, dropped = complete_adjectives(lexemes)
    assert set(kept) == {("big", "adj")} and dropped == 1


# --- VarCon --------------------------------------------------------------------------

VARCON = """# color <verified> (level 10)
A Cv DV: color / B C D: colour
A Cv DV: colors / B C D: colours

# check (level 10)
A B C: check | :1
A C: check / B: cheque | bank

# practice <verified> (level 35)
A B C: practice / AV Cv: practise | <N>
A Cv: practice / AV B C: practise | <V>

# gray (level 35)
A Cv: gray / AV B C: grey

# rare (level 70)
A: tsar / A- B-: czar
_: fuehrer / _v: f\xfchrer
"""


def test_varcon_joins_pure_spelling_lines_and_never_a_sense_restricted_one():
    variants, stats = read_varcon(VARCON, TOKEN)
    assert variants["colour"] == frozenset({"color", "colour"})
    assert variants["colours"] == frozenset({"colors", "colours"})
    assert variants["grey"] == frozenset({"gray", "grey"})
    # a part-of-speech tag restricts nothing: practice/practise are one word
    assert variants["practise"] == frozenset({"practice", "practise"})
    # a sense annotation would fuse two words: cheque never joins check
    assert "cheque" not in variants and "check" not in variants
    # a «possible» variant (A- B-) is no spelling of the word; «_» is no variety
    assert "czar" not in variants and "fuehrer" not in variants
    assert stats["sense"] == 2


def test_british_and_american_filings_become_one_group():
    lexemes, _g, _s = read_agid("color N: colors\ncolour N: colours\n"
                                "color V: colored | coloring | colors\n", TOKEN)
    variants, _st = read_varcon(VARCON, TOKEN)
    lexemes, added = expand_variants(lexemes, variants)
    groups, stats = merge_entries(lexemes, same_lemma=True)
    assert list(groups) == ["color:nc"]
    members = {(lemma, pos) for lemma, pos, _cells in groups["color:nc"]}
    assert members == {("color", "nc"), ("colour", "nc"), ("color", "v")}
    assert stats["twin_groups"] == 1 and added > 0


def test_a_noun_and_a_verb_of_one_spelling_are_one_group_and_homographs_stay_two():
    lexemes, _g, _s = read_agid(
        "walk N: walks\nwalk V: walked | walking | walks\n"
        "leaf N: leaves\nleave N: leaves\nleave V: left | leaving | leaves\n", TOKEN)
    groups, _st = merge_entries(lexemes, same_lemma=True)
    assert {k: {m[:2] for m in v} for k, v in groups.items()} == {
        "walk:nc": {("walk", "nc"), ("walk", "v")},
        "leaf:nc": {("leaf", "nc")},
        "leave:nc": {("leave", "nc"), ("leave", "v")},
    }
    # French keeps its rules: without same_lemma a noun and a verb stay apart
    groups, _st = merge_entries(lexemes)
    assert "walk:v" in groups


def test_penn_tags_map_onto_the_artifact_classes():
    assert [build_forms.anc_class(t) for t in
            ("VBD", "MD", "NNS", "NNP", "JJR", "RB", "IN", "DT", "PRP$", "CD", "UH", "SYM")] \
        == ["v", "v", "nc", "np", "adj", "adv", "prep", "det", "pro", "num", "intj", "SYM"]


# --- the committed artifact -----------------------------------------------------------

@functools.lru_cache(maxsize=1)
def committed():
    return load_forms(forms_path("en"))


@functools.lru_cache(maxsize=1)
def committed_cells():
    cells = {}
    with gzip.open(forms_path("en"), "rt", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            group, _lemma, _pos, feature, form, _dom = line.rstrip("\n").split("\t")
            cells.setdefault((group, feature), []).append(form)
    return cells


@pytest.mark.parametrize("group,feature,expected,first", build_forms.EXPECTED_CELLS_EN)
def test_the_317_cells_ship_exactly_as_audited(group, feature, expected, first):
    forms = committed_cells().get((group, feature), [])
    assert frozenset(forms) == expected
    if first is not None:
        assert forms[0] == first  # the artifact's row order is the preference


@pytest.mark.parametrize("form,expected", build_forms.EXPECTED_SURFACE_LEXEMES_EN)
def test_the_317_homography_and_cleanup_sentinels_ship_as_audited(form, expected):
    assert set(committed().grouping[form]) == expected


def test_a_noun_and_its_verb_are_one_group_in_the_shipped_table():
    walk = committed().group_pos["walk:nc"]
    assert walk == {"nc", "v"}
    assert committed().grouping["walked"] == ("walk:nc",)
    assert committed().grouping["travelled"] == committed().grouping["traveled"]


def test_the_english_grouping_is_the_inventory():
    # one artifact for grouping and agreement, parsed once
    assert gen_phrase.load_lemma_table("en") is gen_phrase.load_form_table("en").grouping
    assert gen_phrase.load_lemma_table("en") == committed().grouping


def test_the_committed_artifact_carries_its_provenance_and_licences():
    with gzip.open(forms_path("en"), "rt", encoding="utf-8") as f:
        header = "".join(line for line in f if line.startswith("#"))
    for pin in (build_forms.AGID_SHA256, build_forms.VARCON_SHA256,
                build_forms.ANC_SHA256, build_forms.AGID_URL, build_forms.ANC_URL):
        assert pin in header
    licence = open(build_forms.license_path("en"), encoding="utf-8").read()
    assert "==== AGID ====" in licence and "==== VarCon ====" in licence
    assert licence.count("Permission to use, copy, modify") >= 2


def test_a_fresh_build_reproduces_the_committed_artifact_exactly():
    """The committed table must be builder output, not a hand patch. Skipped — never
    silently passed — when a source is not cached (CI has no network)."""
    cache = build_forms.bw.CACHE_DIR
    paths = {name: os.path.join(cache, name)
             for name in (build_forms.AGID_ARCHIVE, "en.varcon.txt", "en.anc.tsv")}
    if not all(os.path.exists(p) for p in paths.values()):
        pytest.skip("sources not cached (offline builders); run `pnpm forms:en` first")
    with tarfile.open(paths[build_forms.AGID_ARCHIVE], "r:gz") as tar:
        infl = tar.extractfile(build_forms.AGID_MEMBER).read().decode("latin-1")
    varcon = open(paths["en.varcon.txt"], encoding="latin-1").read()
    rows, _stats = build_forms.build_rows_en(infl, varcon, paths["en.anc.tsv"])
    expected = [build_forms.row_line(g, l, p, ft, fo, d) for g, l, p, ft, fo, d, _f in rows]
    with gzip.open(forms_path("en"), "rt", encoding="utf-8") as f:
        actual = [line.rstrip("\n") for line in f if not line.startswith("#")]
    assert actual == expected


# --- through gen_phrase: English morphology --------------------------------------------

def _english(explicit=None, interactive=False):
    return gen_phrase.FormResolver(committed(), explicit=explicit or {},
                                   interactive=interactive, lang="en")


def test_an_english_noun_is_asked_its_number_never_a_gender(monkeypatch, capsys):
    answers = iter(["1"])
    monkeypatch.setattr("builtins.input", lambda _p="": next(answers))
    resolver = _english(interactive=True)
    assert resolver.feature_for("walks") == "n:p"
    out = capsys.readouterr().out
    assert "pluriel" in out and "indicatif présent, 3e pers. singulier" in out
    assert "masculin" not in out and "féminin" not in out
    assert resolver.morphology_for("walks") == gen_phrase.Morphology("nominal", number="p")


def test_english_cells_are_described_in_the_prompt_vocabulary():
    d = gen_phrase.describe_feature
    assert d("base").startswith("forme de base")
    assert d("ind:pas") == "prétérit" and d("par:pas") == "participe passé"
    assert d("par:pre") == "participe présent"
    assert d("adj:cmp") == "adjectif, comparatif" and d("n:p") == "nom, pluriel"


@pytest.mark.parametrize("secret,feature,lexeme,expected", [
    ("walks", "n:p", "dream:nc", "dreams"),        # nouns take number
    ("walked", "ind:pas", "dream:nc", "dreamed"),  # verbs take tense
    ("walks", "ind:pre:3s", "run:nc", "runs"),
    ("walked", "par:pas", "run:nc", "run"),
    ("walking", "par:pre", "travel:nc", "traveling"),
])
def test_english_neighbours_take_number_and_tense(secret, feature, lexeme, expected):
    resolver = _english(explicit={secret: feature})
    morphology = resolver.morphology_for(secret)
    targets = resolver.target_features(lexeme, morphology)
    assert resolver.realize_features(lexeme, targets)[0] == expected


@pytest.mark.parametrize("feature", ["n:p", "ind:pas", "ind:pre:3s"])
@pytest.mark.parametrize("adjective", ["brief:adj", "complete:adj", "free:adj"])
def test_an_adjective_dominant_group_keeps_its_form_beside_any_secret(feature, adjective):
    # English merges brief's adjective, noun and verb filings into one group; its
    # dominant reading is the adjective, and an English adjective agrees with nothing:
    # never «briefs» beside a plural, «completed» beside a past (#317 review).
    resolver = _english(explicit={"walks": feature})
    assert committed().group_pos[adjective] >= {"adj", "v"}
    assert resolver.target_features(adjective, resolver.morphology_for("walks")) == ()


def test_a_word_with_no_analysis_is_answered_cit_and_the_error_says_so(capsys):
    # AGID lists only what inflects: an English adverb has no analysis, and «cit»
    # («no agreement») is its one answer, on the flag as at the prompt.
    assert committed().entries.get("slowly") is None
    resolver = _english(explicit={"slowly": "cit"})
    assert resolver.feature_for("slowly") == "cit"
    assert resolver.morphology_for("slowly") == gen_phrase.Morphology("citation")
    with pytest.raises(SystemExit):
        _english().feature_for("slowly")
    assert "--form slowly=cit" in capsys.readouterr().err


def test_an_english_adjective_degree_is_confirmed_and_transferred_to_nobody():
    resolver = _english(explicit={"bigger": "adj:cmp"})
    morphology = resolver.morphology_for("bigger")
    assert morphology == gen_phrase.Morphology("degree", degree="cmp")
    assert resolver.target_features("good:adj", morphology) == ()
    assert gen_phrase.describe_morphology(morphology) == "adjectif comparatif"
