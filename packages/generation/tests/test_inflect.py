"""CONTRACT: the unified lexeme inventory and the display-agreement pass it feeds
(#119 addenda 2/3, unified by #132, whole-vocabulary + never-inferred by #133).

A hole displays the player's current best word, so that word should agree with the
sentence: « tu t'___ » must read "t'distrais", never "t'distraire". The rules:

  - the set to agree is the WHOLE rank map (#133) — every group, not just the ones
    below start_rank; rank 0 is never touched: it already holds the true sentence form;
  - the target form is the SECRET's own morphology and it is NEVER inferred (#133):
    even a single-analysis secret is confirmed on a TTY (Enter confirms the shown
    analysis; several analyses are listed to pick from, described, never arbitrated),
    and OFF a TTY --form is required per secret — a batch run without it is a hard
    error, never a guess. --no-inflect is what reproduces the agreement-free output
    byte for byte;
  - #146 merges dictionary entries with exactly equal complete form sets and removes
    same-POS entries whose every (cell, spelling) row is already owned by a larger
    entry. The resulting group key is opaque and carries explicit source members/POS;
  - the TTY asks usage-level morphology, never a dictionary identity unless two
    remaining groups produce different typable form families. Noun gender is the
    author's answer; stored/--form cells stay unchanged;
  - transfer crosses the POSs that can express the answer: adjectives take
    gender+number, nouns take number, noun/adjective answers never guess a verb
    conjugation, and verb answers lend their stated number to nouns (plus participle
    gender+number to adjectives). A `cit` secret prescribes nothing;
  - realization is keyed by each GROUP's LEXEME (#134), which the walk settled: the
    old surface-side `dom` gate and multi-lexeme refusal answered "what is this
    word?", a question that no longer arises here — «durent» never heads a group,
    and the requested form is ALWAYS displayed when it exists and is typable (no
    drift guard: sentence context disambiguates for the player);
  - a group is left alone when its lexeme has no such cell or none of its spellings
    is typable — it keeps its clean representative, the #134 fallback, counted for
    the curator's `*` report — or when the rewrite would land on a slug a CLOSER
    group already owns, or take the slug a farther group's canonical: whatever a
    group prints must type back at its own exponent, never a closer one (declines
    counted as collisions);
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
  - LEXIQUE is frequency/POS evidence only. The `dom` column keeps two cases: with
    corpus evidence the row's class must strictly beat every rival ("évident" is
    dominantly the adjective); without evidence, the surface is admitted only when
    it is analysable as that class and nothing else ("accoutumes"), never guessed.
    Since #134 the DISPLAY side no longer consults it — realization is keyed by the
    group's lexeme — but the column still ships (the artifact is unchanged and #135
    reads it for its flags).
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
                         merge_entries, morphalou_features, normalize_lemma,
                         read_morphalou)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
TABLE = load_forms(os.path.join(FIXTURES, "forms.fr.tsv"))

# The reduced vocabulary these tests run against. "distrais" is deliberately ABSENT:
# it is the untypable-rewrite case (the table knows the form, the embedding does not).
VOCAB = ["jardin", "jardins", "amuse", "amuses", "amusé", "amusait", "distraire",
         "marchait", "marches",
         "lasses", "lassés", "compris", "pensé", "pensée", "pensées", "évident",
         "évidé", "noyé", "noies",
         "accoutume", "accoutumer", "accoutumés", "noyait",
         "grand", "grands", "grande", "grandes", "lent", "lentes",
         "doucement", "fil", "fils", "vers"]
VSET = set(VOCAB)

# The grouping the donor bridge walks, in the inventory's lexeme-key namespace
# (#132). "accoutumes" has no row of its own here, so only its accent sibling can
# name the accoutumer group.
LEMMAS = {"accoutume": ("accoutumer:v",), "accoutumer": ("accoutumer:v",),
          "accoutumés": ("accoutumer:v",), "jardin": ("jardin:nc",)}


def _donors():
    """A resolver for its `typable` check and its lemma bridge."""
    return gen_phrase.DonorResolver(LEMMAS, gen_phrase.invert_lemmas(LEMMAS),
                                    VOCAB, VSET, "fr")


def _resolver(explicit=None, interactive=False, table=TABLE, typable=None):
    return gen_phrase.FormResolver(table, explicit=explicit or {},
                                   interactive=interactive, typable=typable)


def _map(*entries):
    """Build a rank map from (slug, word, rank) triples."""
    return {s: {"word": w, "rank": r} for s, w, r in entries}


# --- the source mapping: Morphalou columns -> the internal feature vocabulary ------

def _morphalou_row(lemma="", category="", form="", *, number="singular",
                   mode="-", gender="-", tense="-", person="-",
                   origins="morphalou2"):
    """One 18-column source row for direct parser tests."""
    cols = [""] * 18
    cols[build_forms._L_GRAPHIE] = lemma
    cols[build_forms._L_CAT] = category
    cols[build_forms._F_GRAPHIE] = form
    cols[build_forms._F_NOMBRE] = number
    cols[build_forms._F_MODE] = mode
    cols[build_forms._F_GENRE] = gender
    cols[build_forms._F_TEMPS] = tense
    cols[build_forms._F_PERS] = person
    cols[build_forms._F_ORIG] = origins
    return ";".join(cols)


def test_read_morphalou_owns_entry_boundaries_and_normalization():
    """Exercise the real state machine without the gitignored 38 MB source archive."""
    text = "\n".join([
        "Morphalou preamble",
        _morphalou_row("jardin", "Nom commun", "jardin"),
        _morphalou_row(form="jardins", number="plural"),
        # An unknown-category entry and its continuation are skipped as one block;
        # neither may leak into the preceding noun.
        _morphalou_row("orphelin", "", "orphelin"),
        _morphalou_row(form="orphelins", number="plural"),
        # Pronominal and bare source entries intentionally merge into one verb lexeme.
        _morphalou_row("se laver", "Verbe", "lave", mode="indicative",
                       tense="present", person="firstPerson"),
        _morphalou_row(form="lavons", number="plural", mode="indicative",
                       tense="present", person="firstPerson"),
        _morphalou_row("laver", "Verbe", "laves", mode="indicative",
                       tense="present", person="secondPerson"),
        # A quoted semicolon is one CSV field; token filtering rejects its contents
        # without shifting every column after it.
        _morphalou_row(form='"R;D"', mode="indicative",
                       tense="present", person="thirdPerson"),
    ])
    lexemes, stats = read_morphalou(
        text, build_forms.red.token_pattern("fr"))

    assert lexemes[("jardin", "nc")] == {
        "n:s": {"jardin"}, "n:p": {"jardins"}}
    assert lexemes[("laver", "v")] == {
        "ind:pre:1s": {"lave"},
        "ind:pre:1p": {"lavons"},
        "ind:pre:2s": {"laves"},
    }
    assert not any(lemma == "orphelin" for lemma, _pos in lexemes)
    assert stats["entries_no_category"] == 1


def test_read_morphalou_rejects_a_short_row_inside_the_data():
    text = "\n".join([
        "Morphalou preamble",
        _morphalou_row("alpha", "Nom commun", "alpha"),
        "beta;Nom commun",  # malformed new lemma header: never glue its continuation
        _morphalou_row(form="betas", number="plural"),
    ])
    with pytest.raises(ValueError, match=r"ligne 3.*18 colonnes.*2 lues"):
        read_morphalou(text, build_forms.red.token_pattern("fr"))


def test_read_morphalou_caps_dropped_samples_exactly():
    rows = [
        _morphalou_row("tester", "Verbe", "teste", mode="indicative",
                       tense="present", person="thirdPerson"),
    ]
    for i in range(35):
        suffix = chr(ord("a") + i // 26) + chr(ord("a") + i % 26)
        rows.append(_morphalou_row(
            form=f"pollution{suffix}", mode="indicative", tense="present",
            person="thirdPerson", origins="dela"))
    _lexemes, stats = read_morphalou(
        "\n".join(rows), build_forms.red.token_pattern("fr"))
    assert stats["rows_dropped"] == 35
    assert len(stats["dropped_samples"]) == 30


# --- duplicate dictionary entries (#146) -----------------------------------------

def test_equal_form_sets_merge_across_pos_under_an_opaque_first_entry_key():
    lexemes = {
        ("rouge", "nc"): {"n:s": {"rouge"}, "n:p": {"rouges"}},
        ("rouge", "adj"): {
            "adj:m:s": {"rouge"}, "adj:f:s": {"rouge"},
            "adj:m:p": {"rouges"}, "adj:f:p": {"rouges"},
        },
        ("rouge", "adv"): {"cit": {"rouge"}},
    }
    groups, stats = merge_entries(lexemes)

    assert tuple(groups) == ("rouge:nc", "rouge:adv")
    assert [(lemma, pos) for lemma, pos, _cells in groups["rouge:nc"]] == [
        ("rouge", "nc"), ("rouge", "adj")]
    assert stats["twin_groups"] == 1
    assert stats["twin_entries"] == 2


def test_a_fully_contained_same_pos_entry_disappears_but_real_distinctions_stay():
    lexemes = {
        ("tropique", "nc"): {"n:s": {"tropique"}, "n:p": {"tropiques"}},
        ("tropiques", "nc"): {"n:p": {"tropiques"}},
        ("fil", "nc"): {"n:s": {"fil"}, "n:p": {"fils"}},
        # Same surface set as fil's plural, but NOT the same row set: its singular
        # claim is real information, so «fil» must never solve this word.
        ("fils", "nc"): {"n:s": {"fils"}, "n:p": {"fils"}},
        ("cafetier", "nc"): {"n:s": {"cafetier"}, "n:p": {"cafetiers"}},
        ("cafetière", "nc"): {"n:s": {"cafetière"}, "n:p": {"cafetières"}},
    }
    groups, stats = merge_entries(lexemes)

    assert "tropiques:nc" not in groups
    assert {"tropique:nc", "fil:nc", "fils:nc", "cafetier:nc",
            "cafetière:nc"} <= set(groups)
    assert stats["contained_entries"] == 1


def test_a_redundant_entry_shared_by_two_supersets_cannot_fuse_them():
    lexemes = {
        ("alpha", "nc"): {"n:s": {"alpha"}, "n:p": {"communs"}},
        ("beta", "nc"): {"n:s": {"beta"}, "n:p": {"communs"}},
        ("communs", "nc"): {"n:p": {"communs"}},
    }
    groups, _stats = merge_entries(lexemes)

    assert tuple(groups) == ("alpha:nc", "beta:nc")
    assert groups["alpha:nc"][0][2]["n:s"] == {"alpha"}
    assert groups["beta:nc"][0][2]["n:s"] == {"beta"}


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
    groups, _stats = merge_entries(lexemes)
    rows = {r[:6] for r in collect_rows(groups, weight)}
    # the gated verb reading stays in the table (a legal TARGET), marked dom=0...
    assert ("évider:v", "évider", "v", "ind:pre:3p", "évident", 0) in rows
    # ...while the dominant reading of the same surface carries dom=1. These two
    # one-form dictionary entries are exact #146 twins, so their opaque group id
    # is the first source entry's key — never evidence of the row's own POS.
    assert ("évider:v", "évident", "adj", "adj:m:s", "évident", 1) in rows
    assert ("penser:v", "penser", "v", "par:pas:m:s", "pensé", 1) in rows


# --- the loader: one artifact, two views -------------------------------------------

def test_grouping_and_agreement_views_span_every_pos():
    # grouping is the #104 merge-walk table: every POS, lexeme keys as group ids —
    # "pensée" the noun and penser's participle are two lexemes sharing a surface.
    assert TABLE.grouping["pensée"] == ("penser:v", "pensée:nc")
    assert TABLE.grouping["jardin"] == ("jardin:nc",)
    assert set(TABLE.grouping["évident"]) == {"évider:v", "évident:adj"}
    # since #133 the agreement views span every POS too: a noun row IS an analysis
    # and a cell, and the nominal/adjectival/citation features are in --form's
    # inventory (they name the per-POS transfer targets).
    assert TABLE.entries["jardin"] == (("jardin:nc", "n:s"),)
    assert TABLE.realize[("pensée:nc", "n:s")] == ("pensée",)
    assert TABLE.realize[("jardin:nc", "n:p")] == ("jardins",)
    assert {"n:s", "n:p", "adj:m:s", "adj:f:p", "cit"} <= set(TABLE.features)
    # `dominant` names the POS the `dom` gate admits a surface as — the loader's
    # side of dominant_pos: "évident" is the adjective, never the verb.
    assert TABLE.dominant.get("évident") == "adj"
    assert TABLE.dominant.get("marchait") == "v"
    assert TABLE.dominant.get("jardin") == "nc"

    # #146: one opaque group can carry several paradigms. The source entries remain
    # inspectable, while grouping/realization use only the canonical group key.
    assert TABLE.grouping["rouges"] == ("rouge:nc",)
    assert TABLE.members["rouge:nc"] == ("rouge:nc", "rouge:adj")
    assert TABLE.group_pos["rouge:nc"] == {"adj", "nc"}
    assert TABLE.group_forms["rouge:nc"] == ("rouge", "rouges")


def test_realization_is_keyed_by_the_lexeme_never_the_surface():
    resolver = _resolver()
    # the secret question still DESCRIBES every analysis of a surface (#133)...
    assert resolver.features_of("évident") == ("adj:m:s", "ind:pre:3p")
    # ...but realizing is per-LEXEME and per-POS: a cross-POS lexeme has no cell at
    # the feature, and a `cit` target prescribes nothing to anyone.
    assert resolver.realize_cell("jardin:nc", "ind:pre:2s") == ()
    assert resolver.realize_cell("marcher:v", "n:p") == ()
    assert resolver.realize_cell("doucement:adv", "cit") == ()
    # pensé -> pensée: the gender lives in the feature, so a masculine target stays
    # masculine.
    assert resolver.realize_cell("penser:v", "par:pas:m:s") == ("pensé",)
    assert resolver.realize_cell("penser:v", "par:pas:f:s") == ("pensée",)
    # Display is ALWAYS the requested form (#134): the walk settled WHAT each group
    # is, so évider:v states — and prints — «évident» when a verb secret's cell asks
    # for it. No drift guard; sentence context disambiguates for the player.
    assert resolver.realize_cell("évider:v", "ind:pre:3p") == ("évident",)
    # The key suffix is opaque after an exact-form merge: rouge:nc also carries
    # adjective cells, and realization reads the explicit table rather than parsing
    # `:nc` back into a false single POS.
    assert resolver.realize_cell("rouge:nc", "adj:f:p") == ("rouges",)


# --- 9. the secret's form is NEVER inferred (#133) --------------------------------

def test_a_single_analysis_is_confirmed_never_auto_resolved(monkeypatch):
    # "marchait" has exactly one analysis — the pre-#133 pass took it silently. Now
    # the analysis is SHOWN and Enter explicitly confirms it.
    asked = []
    monkeypatch.setattr("builtins.input", lambda p="": (asked.append(p), "")[1])
    assert _resolver(interactive=True).feature_for("marchait") == "ind:imp:3s"
    assert asked, "the single-analysis secret was not asked"
    assert "confirmer indicatif imparfait, 3e pers. singulier" in asked[0]
    assert "ind:imp:3s" not in asked[0]  # prompt speaks morphology, not storage


def test_a_noun_secret_asks_the_author_for_lexical_gender(monkeypatch, capsys):
    # The artifact's n:s cell states number only. The TTY asks the human for the
    # missing lexical gender without changing the stored/CLI feature vocabulary.
    monkeypatch.setattr("builtins.input", lambda _p="": "2")
    resolver = _resolver(interactive=True)
    assert resolver.feature_for("jardin") == "n:s"
    assert resolver.morphology_for("jardin") == gen_phrase.Morphology(
        "nominal", "f", "s")
    out = capsys.readouterr().out
    assert "masculin singulier" in out
    assert "féminin singulier" in out
    assert "jardin:nc" not in out


def test_the_question_is_asked_once_per_secret(monkeypatch):
    calls = []
    monkeypatch.setattr("builtins.input", lambda p="": (calls.append(p), "")[1])
    resolver = _resolver(interactive=True)
    assert resolver.feature_for("marchait") == "ind:imp:3s"
    assert resolver.feature_for("marchait") == "ind:imp:3s"
    assert len(calls) == 1


def test_zero_declines_agreement_explicitly(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _p="": "0")
    assert _resolver(interactive=True).feature_for("marchait") is None


def test_closed_stdin_declines_the_morphology_question(monkeypatch):
    def closed(_prompt=""):
        raise EOFError

    monkeypatch.setattr("builtins.input", closed)
    assert _resolver(interactive=True).feature_for("marchait") is None


def test_an_unknown_secret_takes_free_text_and_enter_declines(monkeypatch):
    # No analysis at all: nothing to confirm, so Enter declines — the only default
    # that is not a guess — and a typed feature is accepted.
    monkeypatch.setattr("builtins.input", lambda _p="": "")
    assert _resolver(interactive=True).feature_for("inconnu") is None
    monkeypatch.setattr("builtins.input", lambda _p="": "ind:pre:2s")
    assert _resolver(interactive=True).feature_for("inconnu") == "ind:pre:2s"


def test_an_ambiguous_secret_lists_its_analyses_and_enter_picks_nothing(monkeypatch):
    # "compris" is a past participle OR the 1s/2s past historic. Enter must not pick
    # one (described, never arbitrated) — the prompt re-asks until a number answers.
    answers = iter(["", "1"])
    monkeypatch.setattr("builtins.input", lambda _p="": next(answers))
    assert _resolver(interactive=True).feature_for("compris") == "par:pas:m:s"


# --- 10. off a TTY, --form is required per secret ----------------------------------

def test_every_secret_needs_an_explicit_form_off_a_tty(capsys):
    # ...the ambiguous one, as before:
    assert _resolver().features_of("compris") == (
        "ind:pas:1s", "ind:pas:2s", "par:pas:m:s")
    with pytest.raises(SystemExit):
        _resolver().feature_for("compris")
    err = capsys.readouterr().err
    assert "jamais déduite" in err
    # the fix stays copy-pastable but reads as an EXAMPLE, never a default: the
    # alphabetically-first analysis is the least likely reading of "compris", and
    # an error whose remedy line implies a pick would quietly contradict #133.
    assert "ex. --form compris=ind:pas:1s" in err
    assert "par:pas:m:s" in err                 # ...and every analysis listed
    # ...but ALSO the unambiguous one (#133's point: never inferred, even at 999/1000):
    with pytest.raises(SystemExit):
        _resolver().feature_for("marchait")
    assert "ex. --form marchait=ind:imp:3s" in capsys.readouterr().err
    # --form settles both without a prompt.
    assert _resolver(explicit={"compris": "par:pas:m:s"}).feature_for("compris") == \
        "par:pas:m:s"
    assert _resolver(explicit={"marchait": "ind:imp:3s"}).feature_for("marchait") == \
        "ind:imp:3s"


def test_unknown_form_flag_is_a_clear_error(capsys):
    with pytest.raises(SystemExit):
        _resolver(explicit={"compris": "ind:pre:9z"}).feature_for("compris")
    assert "n'est pas un trait connu" in capsys.readouterr().err


def test_a_trait_outside_the_secrets_analyses_warns_but_runs(capsys):
    # A KNOWN trait outside the secret's listed analyses is nearly always a typo —
    # --form compris=n:p would run a nominal transfer over a participle's
    # neighborhood — so it is said on stderr. But it is a WARNING, not an error:
    # the table can be right about the cell while incomplete for the surface
    # («sors» carries no ind:pre:1s analysis, a pinned Morphalou hole, yet
    # « je sors » is exactly that trait), so refusing would make such a sentence
    # un-authorable. The human stays the authority; the script just points.
    resolver = _resolver(explicit={"compris": "n:p"})
    assert resolver.feature_for("compris") == "n:p"
    err = capsys.readouterr().err
    assert "n'est aucune des analyses connues" in err
    assert "ind:pas:1s" in err   # the listed analyses ride along, for the re-check
    # a listed trait warns nothing...
    quiet = _resolver(explicit={"compris": "par:pas:m:s"})
    assert quiet.feature_for("compris") == "par:pas:m:s"
    assert capsys.readouterr().err == ""
    # ...and an unknown surface has no analyses to check against.
    free = _resolver(explicit={"inconnu": "ind:pre:2s"})
    assert free.feature_for("inconnu") == "ind:pre:2s"
    assert capsys.readouterr().err == ""


def test_the_analysis_warning_covers_the_prompt_path_too(monkeypatch, capsys):
    # The check lives where the trait is SETTLED, not in the --form parse: a trait
    # typed at the TTY prompt gets the same scrutiny as a flag.
    monkeypatch.setattr("builtins.input", lambda _p="": "n:p")
    assert _resolver(interactive=True).feature_for("compris") == "n:p"
    assert "n'est aucune des analyses connues" in capsys.readouterr().err


def test_form_flag_parsing_rejects_a_malformed_pair(capsys):
    # A plain trait is an UNQUALIFIED answer: no lexeme named (#144).
    assert gen_phrase.parse_form_args(["Accoutumes=ind:pre:2s"]) == {
        "accoutumes": (None, "ind:pre:2s")}
    # The qualified spelling names the (lexeme, cell) pair.
    assert gen_phrase.parse_form_args(["Fils=fils:nc/n:p"]) == {
        "fils": ("fils:nc", "n:p")}
    with pytest.raises(SystemExit):
        gen_phrase.parse_form_args(["accoutumes"])
    assert "MOT=TRAIT" in capsys.readouterr().err
    # A dangling qualifier is malformed on either side of the '/'.
    for bad in ("fils=/n:p", "fils=fil:nc/"):
        with pytest.raises(SystemExit):
            gen_phrase.parse_form_args([bad])
        assert "LEXÈME/TRAIT" in capsys.readouterr().err


# --- #146: morphology first; only real remaining identities show forms ------------

def test_the_prompt_asks_morphology_then_shows_forms_for_a_real_identity_pick(
        monkeypatch, capsys):
    answers = iter(["2", "1"])  # masculin pluriel, then fil:nc
    monkeypatch.setattr("builtins.input", lambda _p="": next(answers))
    resolver = _resolver(interactive=True)
    assert resolver.feature_for("fils") == "n:p"
    out = capsys.readouterr().out
    assert "Morphologie de « fils »" in out
    assert "masculin pluriel" in out
    assert "Sens de « fils »" in out
    assert "1) n:p" in out and "(fil : fil, fils)" in out
    assert "2) n:p" in out and "(fils : fils)" in out


def test_the_remaining_entry_pick_settles_the_claim(monkeypatch):
    answers = iter(["2", "1"])
    monkeypatch.setattr("builtins.input", lambda _p="": next(answers))
    resolver = _resolver(interactive=True)
    assert resolver.feature_for("fils") == "n:p"
    assert resolver.confirmed_lexeme("fils") == "fil:nc"
    # ...and picking the other form family claims the other word.
    answers = iter(["2", "2"])
    monkeypatch.setattr("builtins.input", lambda _p="": next(answers))
    other = _resolver(interactive=True)
    assert other.feature_for("fils") == "n:p"
    assert other.confirmed_lexeme("fils") == "fils:nc"


def test_duplicate_rouge_entries_are_one_morphology_only_question(monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", lambda _p="": "2")  # féminin pluriel
    resolver = _resolver(interactive=True)

    assert resolver.feature_for("rouges") == "n:p"
    assert resolver.confirmed_lexeme("rouges") == "rouge:nc"
    assert resolver.morphology_for("rouges") == gen_phrase.Morphology(
        "nominal", "f", "p")
    out = capsys.readouterr().out
    assert "masculin pluriel" in out and "féminin pluriel" in out
    assert "Sens de « rouges »" not in out
    assert "adjectif" not in out and "nom" not in out


def test_pensee_still_distinguishes_a_nominal_use_from_the_participle(
        monkeypatch, capsys):
    # Duplicate-entry removal must not erase a real verb/nominal distinction: the
    # sentence author can still choose penser's participle without naming entries.
    monkeypatch.setattr("builtins.input", lambda _p="": "3")
    resolver = _resolver(interactive=True)

    assert resolver.feature_for("pensée") == "par:pas:f:s"
    assert resolver.confirmed_lexeme("pensée") == "penser:v"
    out = capsys.readouterr().out
    assert "féminin singulier" in out
    assert "participe passé, féminin singulier" in out


def test_groups_with_identical_typable_outcomes_collapse_without_a_question():
    # If «fil» itself is outside this reduced vocabulary, fil:nc and fils:nc both
    # contribute exactly the playable key {fils}; choosing between them cannot alter
    # the puzzle, so plain --form is enough.
    resolver = _resolver(explicit={"fils": "n:p"},
                         typable=lambda form: form == "fils")
    assert resolver.feature_for("fils") == "n:p"
    assert resolver.confirmed_lexeme("fils") == "fil:nc"


def test_a_typed_bare_trait_keeps_the_fail_closed_claim(monkeypatch):
    # The free-text answer exists for table-incomplete cells; it names a lexeme
    # only when exactly one analysis carries it — a shared cell claims nothing.
    monkeypatch.setattr("builtins.input", lambda _p="": "n:p")
    resolver = _resolver(interactive=True)
    assert resolver.feature_for("fils") == "n:p"
    assert resolver.confirmed_lexeme("fils") is None


def test_an_ambiguous_plain_form_flag_is_a_hard_error(capsys):
    # --form settles without a question, so a plain trait that several lexemes
    # carry can neither claim nor silently fail closed: it dies, naming the
    # runnable qualified spellings.
    with pytest.raises(SystemExit):
        _resolver(explicit={"fils": "n:p"}).feature_for("fils")
    err = capsys.readouterr().err
    assert "plusieurs lexèmes" in err
    assert "--form fils=fil:nc/n:p" in err
    assert "--form fils=fils:nc/n:p" in err
    # An unambiguous plain trait still settles silently, exactly as before.
    assert _resolver(explicit={"fils": "n:s"}).feature_for("fils") == "n:s"
    assert _resolver(explicit={"fils": "n:s"}).confirmed_lexeme("fils") == "fils:nc"


def test_a_qualified_form_flag_names_the_claim(capsys):
    resolver = _resolver(explicit={"fils": ("fil:nc", "n:p")})
    assert resolver.feature_for("fils") == "n:p"
    assert resolver.confirmed_lexeme("fils") == "fil:nc"
    assert capsys.readouterr().err == ""


def test_a_qualified_form_flag_rejects_a_stranger_lexeme(capsys):
    # Naming a lexeme the table never analyses the surface as would claim the hole
    # for a stranger — its inflections would solve a hole they don't answer.
    with pytest.raises(SystemExit):
        _resolver(explicit={"fils": ("jardin:nc", "n:p")}).feature_for("fils")
    assert "n'est pas une analyse connue" in capsys.readouterr().err


def test_a_qualified_form_flag_rejects_a_cross_pos_cell(capsys):
    # fil:nc analyses the surface, but adj:f:p is no cell of a noun's paradigm.
    with pytest.raises(SystemExit):
        _resolver(explicit={"fils": ("fil:nc", "adj:f:p")}).feature_for("fils")
    assert "n'est pas une cellule du paradigme" in capsys.readouterr().err


def test_a_qualified_unlisted_cell_warns_but_claims(capsys):
    # The «sors» shape: the table lacks the exact cell while the lexeme is right.
    # The unlisted trait keeps its ordinary warning, and the named claim holds —
    # explicit is explicit.
    resolver = _resolver(explicit={"fils": ("fils:nc", "n:s")})
    assert resolver.feature_for("fils") == "n:s"
    assert resolver.confirmed_lexeme("fils") == "fils:nc"
    assert capsys.readouterr().err == ""   # (fils:nc, n:s) is listed: no warning
    quiet = _resolver(explicit={"marches": ("marcher:v", "ind:pre:1s")})
    assert quiet.feature_for("marches") == "ind:pre:1s"
    assert quiet.confirmed_lexeme("marches") == "marcher:v"
    assert "n'est aucune des analyses connues" in capsys.readouterr().err


def test_the_pair_warning_is_not_masked_by_another_lexeme(capsys):
    # A named claim narrows the unlisted-cell check to the PAIR: n:s exists for the
    # surface «fils» — but under fils:nc, not fil:nc. The surface-wide check would
    # stay silent, and a typo would silently claim a hole for the wrong word.
    resolver = _resolver(explicit={"fils": ("fil:nc", "n:s")})
    assert resolver.feature_for("fils") == "n:s"
    assert resolver.confirmed_lexeme("fils") == "fil:nc"   # explicit is explicit
    err = capsys.readouterr().err
    assert "n'est aucune des analyses connues" in err
    assert "fil (nom)" in err
    assert "n:p" in err   # the named lexeme's own listed cells ride along


# --- 11-13. what the pass rewrites, and what it declines --------------------------

# apply() calls feature_for, which off a TTY demands --form (#133): the apply tests
# therefore settle the secret's form explicitly, exactly like a batch run would.
def _settled(feature, secret="amuses", table=TABLE):
    return _resolver(explicit={secret: feature}, table=table)


def test_pass_agrees_the_groups_and_their_aliases():
    # secret "amuses" (ind:pre:2s). "marchait" is a verb that must become "marches";
    # its alias key "marche" must follow, so typing any form displays the agreed one.
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1),
                ("marche", "marchait", 1), ("jardin", "jardin", 2))
    changed = _settled("ind:pre:2s").apply(
        rmap, "amuses", _donors(), lexemes={1: "marcher:v", 2: "jardin:nc"})

    assert changed == {1: ("marchait", "marches")}
    assert rmap["marchait"] == {"word": "marches", "rank": 1}
    assert rmap["marche"] == {"word": "marches", "rank": 1}   # the alias followed
    assert rmap["marches"] == {"word": "marches", "rank": 1}  # ...and the new slug is keyed
    # 11. a cross-POS neighbour keeps its citation form (#133), as does the secret.
    assert rmap["jardin"] == {"word": "jardin", "rank": 2}
    assert rmap["amuses"] == {"word": "amuses", "rank": 0}


def test_a_rewrite_the_player_could_not_type_is_declined():
    # 12. the table knows distraire -> "distrais", but no reduced word folds to that
    # slug: displaying it would print a hint nobody can type back.
    rmap = _map(("amuses", "amuses", 0), ("distraire", "distraire", 1))
    resolver = _settled("ind:pre:2s")
    assert resolver.apply(rmap, "amuses", _donors(),
                          lexemes={1: "distraire:v"}) == {}
    assert rmap["distraire"] == {"word": "distraire", "rank": 1}
    # ...and the decline is a counted FALLBACK (#134's * report): the requested
    # form exists but nobody could type it, so the representative stays.
    assert resolver.fallbacks["amuses"] == ("amuses", [(1, "distraire")])


def test_the_whole_map_agrees_not_just_the_near_field():
    # 13 (#133): the scope is every group — a rank far past any start band agrees too.
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 2),
                ("lassés", "lassés", 400))
    changed = _settled("ind:pre:2s").apply(
        rmap, "amuses", _donors(), lexemes={2: "marcher:v", 400: "lasser:v"})

    assert changed == {2: ("marchait", "marches"), 400: ("lassés", "lasses")}
    assert rmap["lasses"] == {"word": "lasses", "rank": 400}
    assert rmap["lassés"] == {"word": "lasses", "rank": 400}


# --- 13bis. the per-POS transfer policy (#133) -------------------------------------

def test_a_noun_secret_numbers_the_nouns_and_only_the_nouns():
    # Off-TTY `--form jardins=n:p` states number but no gender: nouns can consume
    # that answer; adjectives cannot honestly choose an m/f cell, and verbs never
    # take a guessed conjugation.
    rmap = _map(("jardins", "jardins", 0), ("pensee", "pensée", 1),
                ("marchait", "marchait", 2), ("grand", "grand", 3),
                ("doucement", "doucement", 4))
    changed = _settled("n:p", "jardins").apply(
        rmap, "jardins", _donors(),
        lexemes={1: "pensée:nc", 2: "marcher:v", 3: "grand:adj",
                 4: "doucement:adv"})

    assert changed == {1: ("pensée", "pensées")}
    assert rmap["pensee"] == {"word": "pensées", "rank": 1}
    assert rmap["pensees"] == {"word": "pensées", "rank": 1}
    assert rmap["marchait"]["word"] == "marchait"
    assert rmap["grand"]["word"] == "grand"
    assert rmap["doucement"]["word"] == "doucement"


def test_an_adjective_secret_transfers_gender_and_number_where_expressible():
    # Adjectives consume both dimensions; nouns consume the same answer's number.
    # No POS identity question is charged for information both can express.
    rmap = _map(("grandes", "grandes", 0), ("lent", "lent", 1),
                ("jardin", "jardin", 2))
    changed = _settled("adj:f:p", "grandes").apply(
        rmap, "grandes", _donors(), lexemes={1: "lent:adj", 2: "jardin:nc"})

    assert changed == {1: ("lent", "lentes"), 2: ("jardin", "jardins")}
    assert rmap["lent"] == {"word": "lentes", "rank": 1}
    assert rmap["lentes"] == {"word": "lentes", "rank": 1}
    assert rmap["jardin"]["word"] == "jardins"
    assert rmap["jardins"]["rank"] == 2


def test_a_noun_tty_gender_answer_reinflects_adjectives_too(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _p="": "2")  # féminin pluriel
    resolver = _resolver(interactive=True)
    rmap = _map(("jardins", "jardins", 0), ("grand", "grand", 1),
                ("pensee", "pensée", 2), ("marchait", "marchait", 3))

    changed = resolver.apply(
        rmap, "jardins", _donors(),
        lexemes={1: "grand:adj", 2: "pensée:nc", 3: "marcher:v"})

    assert changed == {1: ("grand", "grandes"), 2: ("pensée", "pensées")}
    assert rmap["grandes"]["rank"] == 1
    assert rmap["pensees"]["rank"] == 2
    assert rmap["marchait"]["word"] == "marchait"


def test_a_verb_answer_lends_its_stated_number_to_nouns_only():
    # #146's open sub-decision is resolved as number-only: 2p is real information,
    # so a noun can use plural. An adjective would also need gender, which a finite
    # conjugation does not state, and therefore stays untouched.
    rmap = _map(("durent", "durent", 0), ("jardin", "jardin", 1),
                ("grand", "grand", 2), ("marchait", "marchait", 3))
    changed = _settled("ind:pas:3p", "durent").apply(
        rmap, "durent", _donors(),
        lexemes={1: "jardin:nc", 2: "grand:adj", 3: "marcher:v"})

    assert changed == {1: ("jardin", "jardins")}
    assert rmap["grand"]["word"] == "grand"


def test_a_citation_form_secret_prescribes_nothing():
    # secret "doucement" (cit): invariable — no target form is defined for anyone.
    rmap = _map(("doucement", "doucement", 0), ("marchait", "marchait", 1),
                ("jardin", "jardin", 2), ("grand", "grand", 3))
    before = {k: dict(v) for k, v in rmap.items()}
    assert _settled("cit", "doucement").apply(
        rmap, "doucement", _donors(),
        lexemes={1: "marcher:v", 2: "jardin:nc", 3: "grand:adj"}) == {}
    assert rmap == before


def test_a_shared_surface_no_longer_needs_arbitration():
    # "fils" carries TWO noun lexemes (fil:nc and fils:nc); the old surface-keyed
    # rewrite had to decline it. Under #134 it never heads a group — the walk hands
    # apply each group's LEXEME, and each realizes its own cells.
    resolver = _resolver()
    assert resolver.realize_cell("fil:nc", "n:s") == ("fil",)
    assert resolver.realize_cell("fil:nc", "n:p") == ("fils",)
    assert resolver.realize_cell("fils:nc", "n:s") == ("fils",)


# --- 14. the collision rule: decline, never contradict -----------------------------

def test_cross_group_collision_skips_the_rewrite():
    # "lassés" at rank 3 would become "lasses" — but a CLOSER group already owns that
    # slug at rank 1. Rewriting anyway would print "lasses" beside exponent 3 while
    # typing it read 1: a displayed clue improving its own hole. So it is declined.
    rmap = _map(("amuses", "amuses", 0), ("lasses", "autre", 1),
                ("lassés", "lassés", 3))
    resolver = _settled("ind:pre:2s")
    assert resolver.apply(rmap, "amuses", _donors(),
                          lexemes={3: "lasser:v"}) == {}
    assert rmap["lassés"] == {"word": "lassés", "rank": 3}   # original form kept
    assert rmap["lasses"] == {"word": "autre", "rank": 1}    # closer group untouched
    assert resolver.collisions["amuses"] == ("amuses", 1)   # ...and it is reported

    # positive control: with that slug free, the very same rewrite happens.
    free = _map(("amuses", "amuses", 0), ("lassés", "lassés", 3))
    assert _settled("ind:pre:2s").apply(free, "amuses", _donors(),
                                        lexemes={3: "lasser:v"}) == \
        {3: ("lassés", "lasses")}
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
    changed = _settled("ind:pre:2s").apply(
        rmap, "amuses", _donors(), lexemes={1: "lasser:v", 3: "marcher:v"})

    assert changed == {1: ("lassés", "lasses")}      # the closer rewrite still happens
    assert rmap["lasses"] == {"word": "lasses", "rank": 1, "dq": 255, "road": 0}
    assert "marches" not in rmap                     # rank 3 is NOT keyed back into the map
    # The invariant this protects, stated directly: nothing ranked ships without its geometry.
    for key, entry in rmap.items():
        if entry["rank"] != 0:
            assert "dq" in entry, f"{key} carries a rank but no dq"


def test_a_farther_key_is_reclaimed_like_any_closest_first_alias():
    # The mirror of the case above: the slug is held by a FARTHER group, so taking it
    # contradicts nothing — closest-first is exactly how the assembly resolves keys.
    rmap = _map(("amuses", "amuses", 0), ("lassés", "lassés", 2),
                ("lasses", "autre", 7))
    assert _settled("ind:pre:2s").apply(rmap, "amuses", _donors(),
                                        lexemes={2: "lasser:v"}) == \
        {2: ("lassés", "lasses")}
    assert rmap["lasses"] == {"word": "lasses", "rank": 2}


# --- 15. opting out -----------------------------------------------------------------

def test_no_inflect_leaves_the_map_exactly_as_it_was():
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1))
    before = {k: dict(v) for k, v in rmap.items()}
    assert _resolver(table=None).apply(rmap, "amuses", _donors(),
                                       lexemes=None) == {}
    assert rmap == before
    assert gen_phrase.load_form_table("fr", disabled=True) is None
    # en has no inventory at all — a decided non-goal, not a missing file.
    assert gen_phrase.load_form_table("en") is None


def test_a_rewritten_hole_is_reported():
    resolver = _settled("ind:pre:2s")
    rmap = _map(("amuses", "amuses", 0), ("marchait", "marchait", 1))
    resolver.apply(rmap, "amuses", _donors(), lexemes={1: "marcher:v"})
    assert resolver.used == {
        "amuses": ("amuses", "ind:pre:2s",
                    gen_phrase.Morphology("verb", number="s",
                                          feature="ind:pre:2s"), 1)
    }
    # a hole nothing moved is never announced
    quiet = _settled("ind:pre:2s")
    quiet.apply(_map(("amuses", "amuses", 0), ("jardin", "jardin", 1)), "amuses",
                _donors(), lexemes={1: "jardin:nc"})
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


def test_the_committed_146_acceptance_matrix():
    table = committed()

    assert table.grouping["rouges"] == ("rouge:nc",)
    assert set(table.members["rouge:nc"]) == {"rouge:nc", "rouge:adj"}
    assert table.group_pos["rouge:nc"] == {"nc", "adj"}

    assert table.grouping["tropiques"] == ("tropique:nc",)
    assert table.group_forms["tropique:nc"] == ("tropique", "tropiques")
    assert table.grouping["ciseaux"] == ("ciseau:nc",)
    assert table.grouping["ciseau"] == ("ciseau:nc",)

    assert table.grouping["hebdo"] == ("hebdomadaire:nc",)
    assert "hebdomadaire" in table.group_forms["hebdomadaire:nc"]
    assert table.grouping["ex-épouse"] == ("ex-épouse:nc",)
    assert set(table.members["ex-épouse:nc"]) == {
        "ex-épouse:nc", "ex-époux:nc"}

    assert set(table.grouping["pensée"]) >= {"penser:v", "pensée:nc"}
    assert set(table.grouping["fils"]) == {"fil:nc", "fils:nc"}
    assert table.group_forms["fil:nc"] == ("fil", "fils")
    assert table.group_forms["fils:nc"] == ("fils",)
    assert set(table.grouping["mois"]) == {"moi:nc", "mois:nc"}
    assert "moi" in table.group_forms["moi:nc"]
    assert table.group_forms["mois:nc"] == ("mois",)
    assert table.grouping["cafetière"] == ("cafetière:nc",)
    assert table.grouping["cafetier"] == ("cafetier:nc",)


@pytest.mark.parametrize("secret,singular,group", [
    ("tropiques", "tropique", "tropique:nc"),
    ("ciseaux", "ciseau", "ciseau:nc"),
])
def test_a_contained_plural_entry_is_solved_by_the_surviving_singular(
        secret, singular, group):
    table = committed()
    resolver = gen_phrase.FormResolver(table, explicit={secret: "n:p"})
    claim = gen_phrase.secret_claim(
        secret, secret, table.grouping, forms=resolver)
    assert claim == (group,)

    ranking = [(singular, 0, .9), ("jardin", 1, .8), ("grand", 2, .7)]
    _merged, rank_map, _groups = gen_phrase.build_merged_rank_map(
        secret, ranking, table.grouping,
        gen_phrase.invert_lemmas(table.grouping),
        {secret, singular, "jardin", "grand"}, secret_lemmas=claim)
    assert rank_map[gen_phrase.slug(secret)]["rank"] == 0
    assert rank_map[gen_phrase.slug(singular)]["rank"] == 0


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
    # since #133 the analyses span every POS: the participle AND the lexicalised
    # adjective — and for "pensée" the noun too, three lexemes on one surface.
    ("pensé", (("penser:v", "par:pas:m:s"), ("pensé:adj", "adj:m:s"))),
    ("pensée", (("penser:v", "par:pas:f:s"), ("pensé:adj", "adj:f:s"),
                ("pensée:nc", "n:s"))),
    ("jardin", (("jardin:nc", "n:s"),)),
    ("doucement", (("doucement:adv", "cit"),)),
])
def test_committed_table_analyses_the_form_exactly(form, analyses):
    assert tuple(sorted(committed().entries.get(form, ()))) == analyses


def test_the_dom_column_still_ships_and_display_is_lexeme_keyed():
    table = committed()
    # The `dom` data is unchanged in the artifact ("évident" is dominantly the
    # adjective) — but since #134 the display side realizes by LEXEME: évider:v
    # states «évident», and prints it when a verb secret's cell asks for it (no
    # drift guard — decided; sentence context disambiguates for the player).
    assert table.dominant.get("évident") == "adj"
    assert table.realize[("évider:v", "ind:pre:3p")] == ("évident",)
    resolver = gen_phrase.FormResolver(table)
    assert resolver.realize_cell("évider:v", "ind:pre:3p") == ("évident",)
    # "pensée": dominantly the noun, and penser's f:s participle all the same.
    assert table.dominant.get("pensée") == "nc"
    assert resolver.realize_cell("penser:v", "par:pas:f:s")[:1] == ("pensée",)
    # ...and the auxiliaries are ordinary verbs in the data.
    for form in ("avais", "ai", "ont", "avez", "étant", "été", "eu", "aurai"):
        assert table.dominant.get(form) == "v", form


def test_an_auxiliary_secret_still_refuses_to_guess_when_it_is_ambiguous():
    # Admitted is not the same as unambiguous: "avais" is 1s or 2s — off a TTY the
    # form must be explicit (#133: every secret's must, this one visibly so).
    resolver = gen_phrase.FormResolver(committed())
    assert resolver.features_of("avais") == ("ind:imp:1s", "ind:imp:2s")
    with pytest.raises(SystemExit):
        resolver.feature_for("avais")
    assert resolver.realize_cell("avoir:v", "par:pas:m:s")[:1] == ("eu",)


def test_a_number_invariable_participle_secret_is_asked_about():
    # "pris" genuinely covers BOTH masculine numbers (plus the past historic), so
    # « ils sont pris » must not silently agree its neighbours to the singular.
    resolver = gen_phrase.FormResolver(committed())
    assert {"par:pas:m:s", "par:pas:m:p"} <= set(resolver.features_of("pris"))
    with pytest.raises(SystemExit):
        resolver.feature_for("pris")
    settled = gen_phrase.FormResolver(committed(),
                                      explicit={"pris": "par:pas:m:p"})
    assert settled.feature_for("pris") == "par:pas:m:p"
    assert settled.realize_cell("amuser:v", "par:pas:m:p")[:1] == ("amusés",)


def test_a_rewrite_falls_back_to_a_typable_spelling():
    # A paradigm can spell one cell more than one way, and the artifact's preference
    # order is corpus frequency — which knows nothing about the reduced vocabulary.
    # Keeping only the favourite made the whole group decline when that spelling was
    # untypable, even with a typable alternative sitting right behind it.
    table = committed()
    assert table.realize[("déblayer:v", "ind:pre:2s")] == ("déblaies", "déblayes")
    resolver = gen_phrase.FormResolver(table)
    assert resolver.realize_cell("déblayer:v", "ind:pre:2s") == \
        ("déblaies", "déblayes")

    # "déblaies" is not typable here, "déblayes" is -> the group agrees on the latter.
    vocab = ["déblayer", "déblayes", "amuses"]
    donors = gen_phrase.DonorResolver({}, {}, vocab, set(vocab), "fr")
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    with pytest.raises(SystemExit):     # no --form, no TTY: never inferred (#133)
        resolver.apply(rmap, "amuses", donors, lexemes={1: "déblayer:v"})
    settled = gen_phrase.FormResolver(table, explicit={"amuses": "ind:pre:2s"})
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    assert settled.apply(rmap, "amuses", donors,
                         lexemes={1: "déblayer:v"}) == {1: ("déblayer", "déblayes")}
    assert rmap["deblayer"]["word"] == "déblayes"

    # ...and with NEITHER spelling typable the group is left alone — a counted
    # fallback for the * report (#134).
    bare = ["déblayer", "amuses"]
    none_typable = gen_phrase.DonorResolver({}, {}, bare, set(bare), "fr")
    rmap = _map(("amuses", "amuses", 0), ("deblayer", "déblayer", 1))
    fell = gen_phrase.FormResolver(table, explicit={"amuses": "ind:pre:2s"})
    assert fell.apply(rmap, "amuses", none_typable,
                      lexemes={1: "déblayer:v"}) == {}
    assert fell.fallbacks["amuses"] == ("amuses", [(1, "déblayer")])


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
    assert resolver.apply(rmap, "ont", donors, lexemes={1: "asseoir:v"}) == {}
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
    nominal = {"n:s", "n:p"}
    adjectival = {f"adj:{g}:{n}" for g in "mf" for n in "sp"}
    known = (finite | imperative | participles | nominal | adjectival
             | {"par:pre", "inf", "cit"})
    assert committed().features <= known
    assert "imp:pre:3s" not in committed().features
    # every feature names exactly one POS — the per-POS transfer's precondition
    for feature in committed().features:
        assert build_forms.feature_pos(feature) in ("v", "nc", "adj", None)


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


def test_an_inconsistent_empty_preference_pin_reports_instead_of_keyerror(
        monkeypatch, capsys):
    monkeypatch.setattr(
        build_forms, "EXPECTED_CELLS",
        (("fantôme:v", "ind:pre:1s", frozenset(), "fantôme"),))
    monkeypatch.setattr(build_forms, "EXPECTED_INVENTORY_CELLS", ())
    monkeypatch.setattr(build_forms, "EXPECTED_SURFACE_LEXEMES", ())

    with pytest.raises(SystemExit):
        build_forms.validate_rows([])
    err = capsys.readouterr().err
    assert "réalisation préférée « aucune »" in err
    assert "attendue « fantôme »" in err


@functools.lru_cache(maxsize=1)
def committed_all_pos_cells():
    """The shipped rows keyed by #146's opaque group and stored cell."""
    cells = {}
    with gzip.open(forms_path("fr"), "rt", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            group, _lemma, _pos, feature, form, _dom = \
                line.rstrip("\n").split("\t")
            cells.setdefault((group, feature), set()).add(form)
    return cells


@pytest.mark.parametrize("group,feature,expected", [
    ("jardin:nc", "n:s", {"jardin"}),
    ("jardin:nc", "n:p", {"jardins"}),
    ("oeil:nc", "n:p", {"oeils", "yeux"}),
    ("grand:adj", "adj:f:p", {"grandes"}),
    ("vers:nc", "cit", {"vers"}),
    ("celui:pro", "cit", {"celle", "celles", "celui", "ceux"}),
])
def test_the_132_all_pos_sentinels_ship_exactly_as_audited(
        group, feature, expected):
    assert committed_all_pos_cells().get((group, feature)) == expected


@pytest.mark.parametrize("form,expected", [
    ("vers", {"ver:nc", "vers:nc"}),
    ("mois", {"moi:nc", "mois:nc"}),
    ("celle", {"celle:nc", "celui:pro"}),
])
def test_the_132_homography_sentinels_ship_exactly_as_audited(form, expected):
    assert set(committed().grouping[form]) == expected


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
    # The preposition and poetry noun have identical complete form sets, so #146
    # merges them. The unrelated worm plural remains a distinct group.
    grouping = committed().grouping
    assert set(grouping["vers"]) == {"ver:nc", "vers:nc"}
    assert committed().members["vers:nc"] == ("vers:nc", "vers:prep")
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
    rows, stats = build_forms.build_rows("fr", csv_text, lexique)
    # The source measurements that motivated #146 are pinned to the digest-pinned
    # release: a parser or merge-rule drift must be reviewed, not silently blessed.
    assert stats["twin_groups"] == 5_712
    assert stats["twin_entries"] == 11_472
    assert stats["contained_entries"] == 1_496
    assert stats["groups"] == 147_868
    assert len(rows) == 994_497
    expected = [build_forms.row_line(g, l, p, ft, fo, d)
                for g, l, p, ft, fo, d, _freq in rows]
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

def test_durent_needs_no_arbitration_anymore():
    # "durent" is the present of durer AND the past historic of devoir — the case
    # the old surface-keyed rewrite had to DECLINE. Under #134 it never heads a
    # group (a homograph is only a key, resolved closest-first): durer:v and
    # devoir:v are separate groups, and each realizes its own paradigm.
    resolver = _resolver()
    assert {l for l, _f in TABLE.entries["durent"]} == {"devoir:v", "durer:v"}
    assert resolver.realize_cell("durer:v", "ind:pre:2s") == ("dures",)
    assert resolver.realize_cell("devoir:v", "ind:pre:2s") == ("dois",)


def test_reports_carry_the_secrets_display_form_not_its_slug():
    # The report keys are slugs (dedupe), but what prints is the DISPLAY form: a
    # «lassés» secret must be reported as « lassés », never « lasses ».
    # (--form keys are slugs too, exactly like the parse produces them.)
    resolver = _resolver(explicit={"lasses": "par:pas:m:p"})
    rmap = _map(("lasses", "lassés", 0), ("marchait", "marchait", 1))
    assert resolver.apply(rmap, "lassés", _donors(),
                          lexemes={1: "marcher:v"}) == {}
    assert resolver.fallbacks["lasses"] == ("lassés", [(1, "marchait")])


def test_no_lemmas_without_no_inflect_is_rejected(monkeypatch, capsys):
    # --no-lemmas removes the lexemes the agreement pass is keyed by (#134):
    # running it anyway would take --form answers and rewrite nothing, silently.
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False,
                        raising=False)
    monkeypatch.setattr(gen_phrase.sys, "argv", [
        "gen_phrase.py", "la scie coupe le bois sec", "--lang", "fr",
        "--words", "scie", "bois", "sec", "--no-lemmas"])
    with pytest.raises(SystemExit):
        gen_phrase.main()
    assert "--no-inflect" in capsys.readouterr().err


# --- a batch run agrees ONLY when told the form (#133) -----------------------------

def test_a_batch_run_agrees_with_form_and_dies_without():
    # Off a TTY nothing is inferred, however unambiguous: --form per secret or bust.
    batch = _resolver(explicit={"marchait": "ind:imp:3s"}, interactive=False)
    assert batch.feature_for("marchait") == "ind:imp:3s"
    rmap = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1))
    assert batch.apply(rmap, "marchait", _donors(),
                       lexemes={1: "amuser:v"}) == {1: ("amuse", "amusait")}
    assert rmap["amuse"] == {"word": "amusait", "rank": 1}
    assert batch.used == {
        "marchait": ("marchait", "ind:imp:3s",
                      gen_phrase.Morphology("verb", number="s",
                                            feature="ind:imp:3s"), 1)
    }
    # ...and without the flag the same unambiguous secret is a hard error.
    with pytest.raises(SystemExit):
        _resolver(interactive=False).feature_for("marchait")


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
        rmap, "amuses", _donors(), lexemes={2: "amuser:v", 5: "amuser:v"})

    assert 2 not in agreed                      # the closer group declined...
    assert agreed == {5: ("amuse", "amusé")}    # ...and rank 5 kept its own slug
    assert rmap["amusait"] == {"word": "amusait", "rank": 2}

    # THE invariant, stated as the call sites see it: whatever the hole ends up printing
    # looks up at the hole's own start_rank, never at a closer one.
    start_rank = 5
    start_display = agreed.get(start_rank, ("amuse", "amuse"))[1]
    assert start_display == "amusé"
    assert rmap[gen_phrase.slug(start_display)]["rank"] == start_rank


def test_every_groups_canonical_key_is_protected():
    # With the whole map agreed (#133) every group prints its word somewhere, so a
    # farther group's canonical slug is protected WHEREVER it ranks — the pre-#133
    # "past start_rank is reclaimable" carve-out is gone with the start_rank bound.
    far = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1),
               ("amusait", "amusait", 20))
    assert _settled("ind:imp:3s", "marchait").apply(
        far, "marchait", _donors(),
        lexemes={1: "amuser:v", 20: "amuser:v"}) == {}
    assert far["amusait"] == {"word": "amusait", "rank": 20}
    assert far["amuse"] == {"word": "amuse", "rank": 1}

    near = _map(("marchait", "marchait", 0), ("amuse", "amuse", 1),
                ("amusait", "amusait", 4))
    assert _settled("ind:imp:3s", "marchait").apply(
        near, "marchait", _donors(),
        lexemes={1: "amuser:v", 4: "amuser:v"}) == {}
    assert near["amusait"] == {"word": "amusait", "rank": 4}
    assert near["amuse"] == {"word": "amuse", "rank": 1}


# --- artifact integrity ------------------------------------------------------------

def test_a_truncated_table_fails_loudly(tmp_path):
    # Silently skipping short lines would load half a table and agree half a puzzle.
    broken = tmp_path / "forms.tsv"
    broken.write_text("amuser:v\tamuser\tv\tind:pre:2s\tamuses\t1\n"
                      "marcher:v\tmarcher\tv\tind:imp:3s\n",
                      encoding="utf-8")
    with pytest.raises(ValueError, match="champs attendus"):
        load_forms(str(broken))


def test_conflicting_dominant_rows_fail_loudly(tmp_path):
    # dominant_pos marks exactly ONE POS per surface, so two dom=1 POS for one form
    # can only come from a hand-edited or corrupt table — which must fail like a
    # truncated one, not load last-writer-wins.
    broken = tmp_path / "forms.tsv"
    broken.write_text("porte:nc\tporte\tnc\tn:s\tporte\t1\n"
                      "porter:v\tporter\tv\tind:pre:3s\tporte\t1\n",
                      encoding="utf-8")
    with pytest.raises(ValueError, match="dom=1 pour deux POS"):
        load_forms(str(broken))
    # ...while several dom=1 LEXEMES of one POS stay legal («durent» in the fixture).
    assert TABLE.dominant.get("durent") == "v"


def test_form_flag_is_case_insensitive_on_both_sides():
    assert gen_phrase.parse_form_args(["Marchait=IND:IMP:3S"]) == {
        "marchait": (None, "ind:imp:3s")}
    assert gen_phrase.parse_form_args(["Fils=FIL:NC/N:P"]) == {
        "fils": ("fil:nc", "n:p")}


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
    changed = _settled("ind:imp:3s", "marchait").apply(
        rmap, "marchait", _donors(), lexemes={2: "amuser:v", 5: "noyer:v"})

    assert changed == {2: ("amuse", "amusait"), 5: ("noies", "noyait")}
    # the reclaimed key belongs to the closer group now, and kept ITS form — without
    # the rank check it would have been overwritten with rank 5's "noyait".
    assert rmap["amusait"] == {"word": "amusait", "rank": 2}
    assert rmap["amuse"] == {"word": "amusait", "rank": 2}
    # ...while the group that lost it still agreed, on the keys it still owns
    assert rmap["noies"] == {"word": "noyait", "rank": 5}
    assert rmap["noyait"] == {"word": "noyait", "rank": 5}
