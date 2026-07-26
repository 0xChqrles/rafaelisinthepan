"""CONTRACT: display agreement for every word a hole can show (#119 addenda 2 and 3).

A hole displays the player's current best word, so that word should agree with the
sentence: « tu t'___ » must read "t'distrais", never "t'distraire". The rules:

  - the set to agree is EXACTLY the groups at rank <= start_rank — a hole only ever
    improves and starts at start_rank, so no farther group is ever rendered;
  - rank 0 is never touched: it already holds the true sentence form;
  - the target form is the SECRET's own morphology, read off the committed table, and
    it decides EVERYWHERE: a batch run agrees too. Only an ambiguous or unknown secret
    needs a human (--form off a TTY, a prompt on one); --no-inflect is what reproduces
    the pre-addendum output byte for byte;
  - a form carrying several verb lemmas is DECLINED, never arbitrated;
  - a group is left alone when its canonical is not a POS-admitted verb, has no such
    form, would become a word nobody could type back, would land on a slug a CLOSER
    group already owns, or would take the slug a farther but still DISPLAYABLE group
    prints — whatever a hole displays must type back at that hole's own exponent, never
    a closer one. Past start_rank nothing is displayed, so nothing is protected;
  - rewriting a group rewrites every entry carrying it (aliases included) and keys the
    new slug at that same rank, so typing any form of the group displays the agreed one.

Addendum 3 split the sources, and the tests below follow that split:

  - LEFFF is the authority for morphology. Its composite tags name several cells at
    once and must EXPAND into the internal feature vocabulary, never become opaque
    features: "PS13s" is indicative and subjunctive, 1s and 3s; "Km" is a masculine
    participle whose number does not discriminate, so both cells. Because the cells are
    stated, none of addendum 2's Lexique repair heuristics survive.
  - LEXIQUE is frequency/POS evidence only. The source-side gate keeps two cases: with
    corpus evidence the verbal category must beat every rival ("évident" is dominantly
    the adjective, so it is never read — nor written — as a verb); without evidence, the
    surface is admitted only when Lefff gives it verb analyses and no competing
    non-verbal one ("accoutumes"), never guessed.
  - a gated form stays a legal TARGET: "pensée" realizes penser's par:pas:f:s.
"""

import functools
import gzip
import os
import tarfile

import pytest

import build_forms
import gen_phrase
from build_forms import (collect_rows, dominant_verbs, expand_tag, forms_path,
                         lexique_weights, load_forms)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TABLE = load_forms(os.path.join(FIXTURES, "forms.fr.tsv"))

# The reduced vocabulary these tests run against. "distrais" is deliberately ABSENT:
# it is the untypable-rewrite case (Lexique knows the form, the embedding does not).
VOCAB = ["jardin", "amuse", "amuses", "amusé", "amusait", "distraire", "marchait",
         "marches",
         "lasses", "lassés", "compris", "pensé", "évident", "évidé", "noyé", "noies",
         "accoutume", "accoutumer", "accoutumés", "noyait"]
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

def test_a_simple_lefff_tag_names_one_cell():
    assert expand_tag("F1s") == ("ind:fut:1s",)
    assert expand_tag("Y2s") == ("imp:pre:2s",)
    assert expand_tag("Kms") == ("par:pas:m:s",)
    assert expand_tag("Kfp") == ("par:pas:f:p",)
    assert expand_tag("W") == ("inf",)
    assert expand_tag("G") == ("par:pre",)


def test_a_composite_lefff_tag_expands_into_every_cell_it_names():
    # "Lorsque plusieurs codes de même nature se suivent, cela signifie que la forme est
    # commune aux valeurs en question" — one spelling, several cells. Turning that into
    # a single opaque feature would make the cells unreachable and the form look
    # unambiguous when it is not.
    assert expand_tag("P12s") == ("ind:pre:1s", "ind:pre:2s")
    assert expand_tag("PS13s") == ("ind:pre:1s", "ind:pre:3s",
                                   "sub:pre:1s", "sub:pre:3s")
    assert expand_tag("PJ12s") == ("ind:pre:1s", "ind:pre:2s",
                                   "ind:pas:1s", "ind:pas:2s")
    assert expand_tag("ST2s") == ("sub:pre:2s", "sub:imp:2s")


def test_an_omitted_lefff_code_covers_every_value_of_its_dimension():
    # "un code non renseigné est non pertinent ou non discriminant pour la forme".
    # "Km" is how Lefff states outright what addendum 2 had to guess from a blank
    # Lexique column: a masculine participle whose number does not discriminate.
    assert expand_tag("Km") == ("par:pas:m:s", "par:pas:m:p")
    assert expand_tag("K") == ("par:pas:m:s", "par:pas:m:p",
                               "par:pas:f:s", "par:pas:f:p")
    assert expand_tag("PS3") == ("ind:pre:3s", "ind:pre:3p",
                                 "sub:pre:3s", "sub:pre:3p")
    # a tag with no mood code is a skip, not a crash (Lefff's `_error`, `voilà`)
    assert expand_tag("") == ()
    assert expand_tag("ms") == ()


def test_pos_gate_with_corpus_evidence_keeps_the_dominant_category():
    # Case 1. "évident": 0.27 as a form of "évider", 20.14 as the adjective -> not read
    # as a verb. "pensé": only ever the verb -> admitted. Summed per category.
    token_re = gen_phrase.CONFIG["fr"]["token_regex"]
    weight = lexique_weights([("évident", "VER", 0.27), ("évident", "ADJ", 20.14),
                              ("pensé", "VER", 97.57),
                              ("pensée", "VER", 1.42), ("pensée", "NOM", 98.92)],
                             token_re)
    lefff = [("évident", "v", "évider", "PS3p"), ("évident", "adj", "évident", "ms"),
             ("pensé", "v", "penser", "Kms"), ("pensée", "v", "penser", "Kfs"),
             ("pensée", "nc", "pensée", "fs")]
    dominant = dominant_verbs(weight, lefff, token_re)
    assert dominant == {"pensé"}
    # ...but a gated form still stays in the table: it can be someone else's correct
    # realization ("pensée" IS the f:s participle of "penser").
    built = {r[:4] for r in collect_rows(lefff, token_re, dominant, weight)}
    assert ("penser", "par:pas:f:s", "pensée", 0) in built
    assert ("évider", "ind:pre:3p", "évident", 0) in built


def test_pos_gate_without_corpus_evidence_admits_only_an_uncontested_verb():
    # Case 2. Lexique never saw "accoutumes" — which is the whole reason this feature
    # exists — so there is no frequency to weigh. Lefff analyses it as a verb and
    # nothing else, so it is admitted. A cross-POS homograph with no evidence either
    # way is declined rather than guessed.
    token_re = gen_phrase.CONFIG["fr"]["token_regex"]
    lefff = [("accoutumes", "v", "accoutumer", "PS2s"),
             ("litige", "v", "litiger", "PS13s"), ("litige", "nc", "litige", "ms")]
    assert dominant_verbs({}, lefff, token_re) == {"accoutumes"}
    # an all-zero Lexique entry is not evidence either — it falls through to case 2
    weight = lexique_weights([("accoutumes", "VER", 0.0)], token_re)
    assert dominant_verbs(weight, lefff, token_re) == {"accoutumes"}


def test_the_two_naive_rewrites_are_refused():
    resolver = _resolver()
    # évident -> évidé: the POS gate refuses to read "évident" as a verb at all.
    assert resolver.features_of("évident") == ()
    assert resolver.realize("évident", "par:pas:m:s") is None
    # pensé -> pensée: the gender lives in the feature, so a masculine target stays
    # masculine. (And "pensée" is gated as a source in its own right.)
    assert resolver.realize("pensé", "par:pas:m:s") == "pensé"
    assert resolver.realize("pensé", "par:pas:f:s") == "pensée"


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


# --- the COMMITTED artifact, not just the fixture ---------------------------------
# A fixture only holds rows someone wrote by hand, so it can never catch what the SOURCE
# does or does not say. These anchors read the real committed table, which is what ships.

@functools.lru_cache(maxsize=1)
def committed():
    """The real shipped table, loaded once — as a function so a missing or corrupt
    artifact fails the tests that read it rather than collecting the whole module."""
    return load_forms(forms_path("fr"))


@pytest.mark.parametrize("lemma,feature,expected", [
    ("marcher", "ind:imp:3s", "marchait"),
    ("marcher", "ind:pre:2s", "marches"),
    ("vivre", "ind:imp:3s", "vivait"),
    ("venir", "inf", "venir"),
    ("devoir", "inf", "devoir"),
    ("abandonner", "ind:pre:2p", "abandonnez"),
    ("baisser", "ind:imp:3s", "baissait"),
    ("penser", "imp:pre:2s", "pense"),
    ("penser", "par:pas:m:s", "pensé"),      # ...and pensée below: distinct genders
    ("penser", "par:pas:f:s", "pensée"),
    ("comprendre", "ind:pas:1s", "compris"),
    ("engourdir", "ind:pre:2s", "engourdis"),
    ("avilir", "ind:pre:2s", "avilis"),
    # être/avoir are verbs, and the auxiliary is the only tag they carry
    ("avoir", "par:pas:m:s", "eu"),          # "avais" may realize as "eu"
    ("être", "par:pas:m:s", "été"),
    ("avoir", "ind:pre:3p", "ont"),
    ("avoir", "ind:fut:1s", "aurai"),
    # a number-invariable participle realizes BOTH cells, not just the singular
    ("prendre", "par:pas:m:p", "pris"),
    ("prendre", "par:pas:m:s", "pris"),
    ("conquérir", "par:pas:m:p", "conquis"),
    ("conquérir", "par:pas:m:s", "conquis"),
    # ...while a participle that DOES distinguish still keeps them apart
    ("amuser", "par:pas:m:p", "amusés"),
    ("amuser", "par:pas:m:s", "amusé"),
    # the paradigm cells Lexique's corpus never attested, which is the whole point
    ("accoutumer", "ind:pre:2s", "accoutumes"),
    ("distraire", "ind:pre:2s", "distrais"),
])
def test_committed_table_realizes_the_real_form(lemma, feature, expected):
    assert committed().realize.get((lemma, feature)) == expected


@pytest.mark.parametrize("form,analyses", [
    # exactly the future 1s of avoir — no invented "aurai / inf"
    ("aurai", (("avoir", "ind:fut:1s"),)),
    # the cell Lexique never saw, plus the subjunctive it genuinely shares
    ("accoutumes", (("accoutumer", "ind:pre:2s"), ("accoutumer", "sub:pre:2s"))),
    # present 1s, present 2s and imperative 2s, one spelling (P12s + Y2s)
    ("distrais", (("distraire", "imp:pre:2s"), ("distraire", "ind:pre:1s"),
                  ("distraire", "ind:pre:2s"))),
    # participle masculine singular AND plural (Km), plus the past historic (J12s)
    ("conquis", (("conquérir", "ind:pas:1s"), ("conquérir", "ind:pas:2s"),
                 ("conquérir", "par:pas:m:p"), ("conquérir", "par:pas:m:s"))),
    ("pensé", (("penser", "par:pas:m:s"),)),
    ("pensée", (("penser", "par:pas:f:s"),)),
])
def test_committed_table_analyses_the_form_exactly(form, analyses):
    assert tuple(sorted(committed().entries.get(form, ()))) == analyses


def test_the_source_side_gate_still_declines_a_dominant_non_verb():
    table = committed()
    # "évident" is a form of "évider" on paper and overwhelmingly the adjective, so it
    # is never READ as a verb — while staying available as a target realization.
    assert "évident" not in table.dominant
    assert gen_phrase.FormResolver(table).features_of("évident") == ()
    assert table.realize[("évider", "ind:pre:3p")] == "évident"
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
    # "conquis" covers m:s and m:p, so « ils sont conquis » must not silently agree its
    # neighbours to the singular. Several candidates -> the batch run declines and
    # --form settles it, exactly like any other ambiguous secret.
    resolver = gen_phrase.FormResolver(committed())
    assert "par:pas:m:p" in resolver.features_of("conquis")
    assert "par:pas:m:s" in resolver.features_of("conquis")
    assert resolver.feature_for("conquis") is None
    settled = gen_phrase.FormResolver(committed(),
                                      explicit={"conquis": "par:pas:m:p"})
    assert settled.feature_for("conquis") == "par:pas:m:p"
    assert settled.realize("amusé", "par:pas:m:p") == "amusés"


# --- whole-table checks required by addendum 3 ------------------------------------

def test_every_feature_in_the_committed_table_is_a_known_cell():
    # Composite Lefff tags must EXPAND into the internal vocabulary. An unexpanded tag
    # would show up here as an unknown feature — and would be unreachable from --form.
    finite = {f"{m}:{p}{n}"
              for m in ("ind:pre", "ind:fut", "ind:imp", "ind:pas", "cnd:pre",
                        "imp:pre", "sub:pre", "sub:imp")
              for p in "123" for n in "sp"}
    participles = {f"par:pas:{g}:{n}" for g in "mf" for n in "sp"}
    assert committed().features <= finite | participles | {"par:pre", "inf"}


def test_the_committed_table_has_no_duplicate_row():
    rows = [(lemma, feature, form)
            for form, pairs in committed().entries.items()
            for lemma, feature in pairs]
    assert len(rows) == len(set(rows))


def test_every_realization_is_deterministic():
    # `realize` keeps the FIRST row of a (lemma, feature) pair, so the sort must be
    # total: same inputs, same preferred spelling, every build.
    table = committed()
    by_pair = {}
    for form, pairs in table.entries.items():
        for lemma, feature in pairs:
            by_pair.setdefault((lemma, feature), set()).add(form)
    for pair, forms in by_pair.items():
        assert table.realize[pair] in forms
    assert len(table.realize) == len(by_pair)


def test_a_fresh_build_reproduces_the_committed_artifact_exactly():
    """The committed table must be builder output, not a hand patch.

    Runs the REAL deterministic core over the cached downloads and compares line for
    line. Skipped — never silently passed — when a source is not cached, since the
    builders are offline by design and CI has no network."""
    lefff_archive = os.path.join(build_forms.bw.CACHE_DIR, build_forms.LEFFF_ARCHIVE)
    lexique = os.path.join(build_forms.bw.CACHE_DIR, "fr.lexique.tsv")
    if not (os.path.exists(lefff_archive) and os.path.exists(lexique)):
        pytest.skip("sources not cached (offline builders); run `pnpm forms:fr` first")

    with tarfile.open(lefff_archive, "r:gz") as tar:
        mlex = tar.extractfile(build_forms.LEFFF_MEMBER).read().decode("utf-8")
    expected = [build_forms.row_line(l, ft, fo, d)
                for l, ft, fo, d, _freq in build_forms.build_rows("fr", mlex, lexique)]
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
    assert build_forms.LEFFF_SHA256 in blob
    assert build_forms.LEFFF_URL in blob
    assert "LGPL-LR" in blob
    licence = build_forms.license_path("fr")
    assert os.path.exists(licence)
    assert "Lesser General Public License" in open(licence, encoding="utf-8").read()


def test_present_2sg_coverage_cannot_collapse_back_to_the_corpus_baseline():
    # The reason for addendum 3. Lexique attested `ind:pre:2s` for 1,901 lemmas because
    # a corpus lexicon only holds what it saw; Lefff compiles the paradigm, so the cell
    # exists ~7,800 times. A regression to the old source would show up here first.
    lemmas = {l for (l, ft) in committed().realize if ft == "ind:pre:2s"}
    assert len(lemmas) > 7_000
    # ...and the cell is not a special case: the ordinary paradigm is just as complete.
    for feature in ("ind:imp:3s", "sub:pre:1s", "par:pas:f:p", "cnd:pre:2p"):
        assert len({l for (l, ft) in committed().realize if ft == feature}) > 7_000


# --- a form with several verb lemmas is declined, not arbitrated -------------------

def test_an_ambiguous_paradigm_is_refused():
    # "durent" is the present of durer AND the past historic of devoir. Lexique is right
    # about both and the embedding vector means the first, so realizing devoir's
    # paradigm would print "dois" for a word the geometry placed as "durer".
    resolver = _resolver()
    assert {l for l, _f in TABLE.entries["durent"]} == {"devoir", "durer"}
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
    broken.write_text("amuser\tind:pre:2s\tamuses\t1\nmarcher\tind:imp:3s\n",
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
