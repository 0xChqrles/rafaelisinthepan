"""CONTRACT: display tokens keep punctuation/apostrophes, and a secret is located
INSIDE its token, decomposed into a pure word-core + display prefix/suffix (the fix
for apostrophes/punctuation being stripped from `words[]`).

Rules asserted (AGENTS.md "Per-puzzle JSON schema"):

  - display_token keeps accents AND punctuation/apostrophes, only lowercasing — so
    words[] reproduces the sentence ("t'attends", "rien,", "«mot»");
  - locate_core(token, target_slug) finds the word-core whose slug == target_slug and
    returns (secret_display, prefix, suffix): the pure word (accents kept, NO
    punctuation) + the text before/after it (leading clitic + surrounding punctuation);
  - a hyphenated compound is ONE core (arc-en-ciel), so a sub-word can't be holed out;
  - the returned secret always slugs back to the target (so it stays matchable/typable);
  - no matching core -> None.
"""

from slug import slug  # noqa: E402

import gen_phrase  # noqa: E402

FR = gen_phrase.CONFIG["fr"]
EN = gen_phrase.CONFIG["en"]


def core(token, word, cfg=FR):
    """Helper: decompose a raw token around the word `word` (given by its display)."""
    return gen_phrase.locate_core(gen_phrase.display_token(token), slug(word), cfg)


def test_display_token_keeps_accents_punctuation_apostrophe_only_lowercases():
    assert gen_phrase.display_token("Aujourd'hui,") == "aujourd'hui,"
    assert gen_phrase.display_token("«Forêt»") == "«forêt»"
    assert gen_phrase.display_token("T'ATTENDS") == "t'attends"


def test_elision_splits_clitic_into_prefix():
    # "t'attends": the clitic "t'" is display prefix, the secret is the pure "attends".
    assert core("t'attends", "attends") == ("attends", "t'", "")
    assert core("L'amour,", "amour") == ("amour", "l'", ",")


def test_trailing_and_wrapping_punctuation_go_to_suffix_prefix():
    assert core("rien,", "rien") == ("rien", "", ",")
    assert core("«amour»", "amour") == ("amour", "«", "»")


def test_secret_keeps_accents_but_no_punctuation():
    assert core("Déçu,", "déçu") == ("déçu", "", ",")


def test_curly_apostrophe_is_a_separator_too():
    # U+2019 works like a straight apostrophe: clitic split, char kept for display.
    assert core("j’aime", "aime") == ("aime", "j’", "")


def test_hyphenated_compound_is_one_core():
    assert core("arc-en-ciel", "arc-en-ciel") == ("arc-en-ciel", "", "")
    # a sub-word of the compound is NOT a separate core -> cannot be holed out.
    assert core("arc-en-ciel", "ciel") is None


def test_no_matching_core_returns_none():
    assert core("bonjour", "salut") is None
    assert core("—", "quoi") is None  # punctuation-only token has no core


def test_returned_secret_slugs_back_to_the_target():
    secret, _prefix, _suffix = core("l'Été,", "été")
    assert slug(secret) == slug("été")  # stays matchable / typable by the player


def test_english_alphabet_splits_on_apostrophe():
    # en char_class is ASCII a-z; "don't" -> cores "don"/"t", so "don" is holeable.
    assert core("don't", "don", EN) == ("don", "", "'t")
