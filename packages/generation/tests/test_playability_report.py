"""CONTRACT: #135's playability report observes a rank map; it never edits it.

For each secret, ranks 1..150 expose neutral curator evidence:
  - exhaustive form fractions (agreed / * fallback / citation, with collision kept
    distinct because #134 does not call a collision a fallback);
  - reduced-vocabulary frequency ranks and distribution landmarks;
  - every no-clean, homograph-only lexeme in the window;
  - the largest clean intra-lexeme vector divergences as measured values.

The report is stdout only. No metric filters a group, changes a rank, or fails an
otherwise valid generation run.
"""

import copy
from types import SimpleNamespace

import pytest

import gen_phrase


VOCAB = [
    "courantes",  # frequency #1; the agreed display of rank 1
    "nom",        # #2
    "vers",       # #3
    "courant",    # #4; rank 1's representative
    "repli",      # #5
    "collision",  # #6
    "collées",    # #7; realizable but declined by closest-wins in this fixture
    "lointain",   # #8; outside the report window
    "lointaine",  # #9; outside the report window
]

LEMMA_TABLE = {
    "courant": ("courant:adj",),
    "courantes": ("courant:adj",),
    "repli": ("repli:adj",),
    "nom": ("nom:nc",),
    "vers": ("vers:nc", "vers:prep"),
    "collision": ("collision:adj",),
    "collées": ("collision:adj",),
    "lointain": ("lointain:adj",),
    "lointaine": ("lointain:adj",),
}
FORMS_BY_LEMMA = gen_phrase.invert_lemmas(LEMMA_TABLE)

GROUPS = [
    ("secrète", 0, ("secret:adj",), True, "secrète"),
    ("courant", 1, ("courant:adj",), True, "courant"),
    ("repli", 2, ("repli:adj",), True, "repli"),
    ("nom", 3, ("nom:nc",), True, "nom"),
    # Every embedded form of vers:prep is shared: #134's unavoidable residue.
    ("vers", 4, ("vers:prep",), False, "vers"),
    ("collision", 5, ("collision:adj",), True, "collision"),
    # A larger divergence outside rank 150 must not leak into the near-field report.
    ("lointain", 151, ("lointain:adj",), True, "lointain"),
]

RANK_MAP = {
    "secrete": {"word": "secrète", "rank": 0},
    "courantes": {"word": "courantes", "rank": 1},
    "repli": {"word": "repli", "rank": 2},
    "nom": {"word": "nom", "rank": 3},
    "vers": {"word": "vers", "rank": 4},
    "collision": {"word": "collision", "rank": 5},
    "lointain": {"word": "lointain", "rank": 151},
}

KV = {
    "courant": [1.0, 0.0],
    "courantes": [0.0, 1.0],       # cosine distance 1 from representative
    "repli": [1.0, 0.0],
    "nom": [1.0, 0.0],
    "vers": [1.0, 0.0],
    "collision": [1.0, 0.0],
    "collées": [1.0, 0.0],         # comparable, distance 0
    "lointain": [1.0, 0.0],
    "lointaine": [-1.0, 0.0],      # distance 2, but rank 151 is out of scope
}


def _resolver():
    table = SimpleNamespace(realize={
        ("courant:adj", "adj:f:p"): ("courantes",),
        # Same POS but the requested spelling is absent from the reduced vocab: *.
        ("repli:adj", "adj:f:p"): ("repliées",),
        # Typable target exists, but final display stayed put: collision, not *.
        ("collision:adj", "adj:f:p"): ("collées",),
    })
    return gen_phrase.FormResolver(table)


def _report(**kwargs):
    return gen_phrase.build_playability_report(
        "secrète", GROUPS, RANK_MAP, VOCAB, LEMMA_TABLE, FORMS_BY_LEMMA,
        KV, resolver=_resolver(), feature="adj:f:p", **kwargs)


def test_report_covers_the_near_field_without_mutating_the_map():
    before = copy.deepcopy(RANK_MAP)
    report = _report()

    assert RANK_MAP == before
    assert report["groups"] == 5
    assert report["last_rank"] == 5
    assert report["forms"] == {
        "agreed": 1,
        "fallback": 1,
        "citation": 2,
        "collision": 1,
    }

    # Five displays land at frequency ranks [1, 5, 2, 3, 6]. Nearest-rank p50/p90
    # are therefore 3 and 6, and the actual rarest display is named.
    assert report["frequency"] == {
        "measured": 5,
        "unmeasured": 0,
        "proxy": 0,
        "p50": 3,
        "p90": 6,
        "max": 6,
        "rarest": [
            {"rank": 5, "word": "collision", "frequency_rank": 6,
             "proxy": False},
            {"rank": 2, "word": "repli", "frequency_rank": 5,
             "proxy": False},
            {"rank": 4, "word": "vers", "frequency_rank": 3,
             "proxy": False},
            {"rank": 3, "word": "nom", "frequency_rank": 2,
             "proxy": False},
            {"rank": 1, "word": "courantes", "frequency_rank": 1,
             "proxy": False},
        ],
    }


def test_homograph_and_divergence_flags_are_measured_not_gated():
    report = _report()

    assert report["no_clean"] == [
        {"rank": 4, "word": "vers", "lexeme": "vers:prep"}
    ]
    assert report["divergences"][0] == {
        "rank": 1,
        "lexeme": "courant:adj",
        "representative": "courant",
        "form": "courantes",
        "distance": pytest.approx(1.0),
    }
    assert all(item["lexeme"] != "lointain:adj"
               for item in report["divergences"])
    # The zero-distance comparable lexeme is retained in the model: no arbitrary
    # divergence threshold decides what evidence exists.
    assert report["divergences"][-1]["lexeme"] == "collision:adj"
    assert report["divergences"][-1]["distance"] == pytest.approx(0.0)


def test_formatter_prints_every_requested_section_without_a_verdict(capsys):
    reporter = gen_phrase.PlayabilityReporter(
        VOCAB, LEMMA_TABLE, FORMS_BY_LEMMA, KV, _resolver())
    reporter.capture("secrète", GROUPS, RANK_MAP, "adj:f:p")
    reporter.print()
    out = capsys.readouterr().out

    assert "Rapport de jouabilité (informatif — aucun filtrage)" in out
    assert "accord net 1/5 (20.0 %)" in out
    assert "repli* 1/5 (20.0 %)" in out
    assert "citation inter-POS/invariable 2/5 (40.0 %)" in out
    assert "collision de slug 1/5 (20.0 %)" in out
    assert "p50 #3 · p90 #6 · max #6" in out
    assert "vecteur uniquement homographe : 1/5 (20.0 %)" in out
    assert "vers (préposition) → « vers » (rang 4)" in out
    assert "« courant » ↔ « courantes » = 1.000" in out
    assert "bon" not in out.lower()
    assert "mauvais" not in out.lower()


def test_report_still_describes_frequency_when_agreement_is_disabled():
    report = gen_phrase.build_playability_report(
        "secrète", GROUPS, RANK_MAP, VOCAB, LEMMA_TABLE, FORMS_BY_LEMMA,
        KV, resolver=None, feature=None)

    assert report["forms"] is None
    assert report["frequency"]["measured"] == 5
    assert report["no_clean"][0]["lexeme"] == "vers:prep"


def test_frequency_uses_the_slug_sibling_that_makes_a_display_typable():
    # A requested spelling may be absent verbatim while an accent sibling in the
    # reduced vocab supplies its existence key. Its frequency evidence is therefore
    # that first slug sibling, explicitly marked as a proxy rather than dropped.
    groups = [GROUPS[0], GROUPS[1]]
    rank_map = {
        "secrete": {"word": "secrète", "rank": 0},
        "courantes": {"word": "courantés", "rank": 1},
    }
    report = gen_phrase.build_playability_report(
        "secrète", groups, rank_map, VOCAB, LEMMA_TABLE, FORMS_BY_LEMMA,
        KV, resolver=None, feature=None)

    assert report["frequency"]["p50"] == 1
    assert report["frequency"]["proxy"] == 1
    assert report["frequency"]["rarest"] == [
        {"rank": 1, "word": "courantés", "frequency_rank": 1,
         "proxy": True}
    ]


def test_missing_report_vectors_do_not_turn_generation_into_a_failure():
    report = gen_phrase.build_playability_report(
        "secrète", GROUPS, RANK_MAP, VOCAB, LEMMA_TABLE, FORMS_BY_LEMMA,
        {}, resolver=_resolver(), feature="adj:f:p")

    assert report["groups"] == 5
    assert report["divergences"] == []
