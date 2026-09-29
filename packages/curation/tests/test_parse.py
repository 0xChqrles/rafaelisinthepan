"""The parser's pure half: which character spans are one hyphenated word to the game.
spaCy splits some of them; `parse` merges each back so a piece is never offered (#317)."""

from parse import compound_spans


def _words(sentence):
    return [sentence[a:b] for a, b in compound_spans(sentence)]


def test_a_hyphenated_compound_is_one_word():
    assert _words("Her hand-painted cup was ice-cold, said my mother-in-law.") == \
        ["hand-painted", "ice-cold", "mother-in-law"]


def test_the_same_shape_as_gen_phrase_s_word_cores_in_french():
    # an apostrophe separates, as in gen_phrase's core_re: « l'arc-en-ciel » holds one core
    assert _words("« Viens », répondit-il ; l'arc-en-ciel a-t-il pâli ? Peut-être.") == \
        ["répondit-il", "arc-en-ciel", "a-t-il", "Peut-être"]


def test_a_dash_that_does_not_join_two_letters_joins_nothing():
    assert _words("He began to cry—but then - quietly - stopped; the anti- and pro- camps.") == []
    assert _words("A plain line with no compound at all.") == []
