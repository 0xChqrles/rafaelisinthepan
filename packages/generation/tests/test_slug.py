"""CONTRACT: Python slug() == JS/TS fold() on the SAME shared case table.

The fixture (packages/shared/fixtures/slug-cases.json) is the single source of truth
consumed by both this test and packages/shared/src/slug.test.ts. If the two ever
disagree on any row, the cross-language slug/fold contract is broken.
"""

import json
from pathlib import Path

import pytest

import gen_phrase  # noqa: E402  (importable via conftest's sys.path + stubs)

# tests/ -> generation -> packages -> <repo root>
FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages" / "shared" / "fixtures" / "slug-cases.json"
)


def _cases():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_shared_fixture_is_present_and_substantive():
    cases = _cases()
    assert len(cases) > 15


@pytest.mark.parametrize("case", _cases(), ids=lambda c: repr(c["in"]))
def test_slug_matches_shared_table(case):
    assert gen_phrase.slug(case["in"]) == case["out"]


def test_collisions_fold_to_the_same_key():
    assert gen_phrase.slug("côté") == gen_phrase.slug("coté") == "cote"


def test_slug_is_idempotent():
    for case in _cases():
        assert gen_phrase.slug(case["out"]) == case["out"]
