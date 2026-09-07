from sentences import candidate_sentences, is_candidate, split_sentences

LONG = "Il aimait ce moment où la ville s'apaise, et le gémissement étrange de l'asphalte, à la nuit tombée, comme si la rue rendait sa violence contenue."


def test_split_on_terminal_punctuation_and_paragraphs():
    text = "Il partit. Elle resta là… Puis rien.\n\nUn nouveau paragraphe sans point"
    assert split_sentences(text) == ["Il partit.", "Elle resta là…", "Puis rien.",
                                     "Un nouveau paragraphe sans point"]


def test_abbreviation_without_capital_does_not_split():
    assert split_sentences("M. Dupont vint le soir. Il dormit.") == ["M. Dupont vint le soir.", "Il dormit."]


def test_candidate_filters():
    assert is_candidate(LONG)
    assert not is_candidate("Trop court pour être une phrase du jeu.")
    assert not is_candidate("— " + LONG)               # dialogue
    assert not is_candidate(LONG.replace("ville", "ville en 1984"))  # digits
    assert not is_candidate("Il vit Pierre, Paul, Jacques et Marie près de la ville et du gémissement étrange de la nuit tombée.")
    assert not is_candidate(LONG[:-1])                 # no terminal punctuation


def test_candidate_sentences_dedup_in_order():
    text = f"{LONG} {LONG} Court. "
    assert candidate_sentences(text) == [LONG]


def test_short_sentences_join_into_a_unit_within_a_paragraph():
    text = ("Selon les paroles des anciens, on doit prendre ses décisions en sept respirations. "
            "C'est une question de détermination et de courage.\n\n"
            "Puis rien. Le silence.")
    units = candidate_sentences(text)
    # The first sentence alone (13 words) is short; with the next it is a unit.
    assert units == ["Selon les paroles des anciens, on doit prendre ses décisions en sept respirations. "
                     "C'est une question de détermination et de courage."]
    # A unit never crosses the paragraph break, and a capital opening a joined sentence
    # is not counted as a proper noun.
    assert is_candidate("Il partit sans un mot. Elle resta là, devant la porte, à compter les pas qui s'éloignaient. Puis Marie revint.")
