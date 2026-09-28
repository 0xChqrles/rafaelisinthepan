from sentences import candidate_sentences, is_candidate, split_sentences

LONG = "Il aimait ce moment où la ville s'apaise, et le gémissement étrange de l'asphalte, à la nuit tombée, comme si la rue rendait sa violence contenue."


def test_split_on_terminal_punctuation_and_paragraphs():
    text = "Il partit. Elle resta là… Puis rien.\n\nUn nouveau paragraphe sans point"
    assert split_sentences(text, lang="fr") == ["Il partit.", "Elle resta là…", "Puis rien.",
                                     "Un nouveau paragraphe sans point"]


def test_abbreviation_without_capital_does_not_split():
    assert split_sentences("M. Dupont vint le soir. Il dormit.", lang="fr") == ["M. Dupont vint le soir.", "Il dormit."]


def test_candidate_filters():
    assert is_candidate(LONG)
    assert not is_candidate("Trop court pour être une phrase du jeu.")
    assert not is_candidate("— " + LONG)               # dialogue
    assert not is_candidate("« Il sait qu’il meurt » " + LONG)   # opens by quoting
    assert not is_candidate("“Il sait qu’il meurt” " + LONG)
    assert not is_candidate(LONG.replace("ville", "ville en 1984"))  # digits
    assert not is_candidate("Il vit Pierre, Paul, Jacques et Marie près de la ville et du gémissement étrange de la nuit tombée.")
    assert not is_candidate(LONG[:-1])                 # no terminal punctuation


def test_candidate_sentences_dedup_in_order():
    text = f"{LONG} {LONG} Court. "
    assert candidate_sentences(text, lang="fr") == [LONG]


def test_short_sentences_join_into_a_unit_within_a_paragraph():
    text = ("Selon les paroles des anciens, on doit prendre ses décisions en sept respirations. "
            "C'est une question de détermination et de courage.\n\n"
            "Puis rien. Le silence.")
    units = candidate_sentences(text, lang="fr")
    # The first sentence (13 words) is offered alone — a short line can be the best one —
    # and, joined with the next, as the micro-story; « Puis rien. Le silence. » is neither.
    assert units == ["Selon les paroles des anciens, on doit prendre ses décisions en sept respirations.",
                     "Selon les paroles des anciens, on doit prendre ses décisions en sept respirations. "
                     "C'est une question de détermination et de courage."]
    # A unit never crosses the paragraph break, and a capital opening a joined sentence
    # is not counted as a proper noun.
    assert is_candidate("Il partit sans un mot. Elle resta là, devant la porte, à compter les pas qui s'éloignaient. Puis Marie revint.")


# The page around a unit (#270): raw neighbouring sentences, crossing paragraph breaks,
# never the unit itself, both sides bounded.
def test_excerpt_around_a_unit_crosses_paragraphs_and_stops_at_the_edges():
    from sentences import excerpt_around
    text = ("Un. Deux. Trois.\n\n"
            "Quatre. Cinq. Six. Sept.\n\n"
            "Huit. Neuf.")
    assert excerpt_around(text, "Cinq. Six.", n=3, lang="fr") == {"before": ["Deux.", "Trois.", "Quatre."],
                                                      "after": ["Sept.", "Huit.", "Neuf."]}
    assert excerpt_around(text, "Un.", n=2, lang="fr") == {"before": [], "after": ["Deux.", "Trois."]}
    assert excerpt_around(text, "Neuf.", n=2, lang="fr") == {"before": ["Sept.", "Huit."], "after": []}
    assert excerpt_around(text, "Trois. Quatre.", n=2, lang="fr") is None  # a unit never crosses a paragraph
    assert excerpt_around(text, "Dix.", lang="fr") is None


def test_cut_excerpt_clamps_the_counts_into_the_window():
    from sentences import cut_excerpt
    window = {"before": ["B3.", "B2.", "B1."], "after": ["A1.", "A2."]}
    assert cut_excerpt(window, 2, 1) == {"before": ["B2.", "B1."], "after": ["A1."]}
    assert cut_excerpt(window, 9, 9) == window            # never past the window
    assert cut_excerpt(window, 0, 0) == {"before": [], "after": []}
    assert cut_excerpt(window, -3, -1) == {"before": [], "after": []}


# English prose (#317): titles, quotation marks, the pronoun « I ».
def test_an_english_title_never_ends_a_sentence():
    assert split_sentences("It was Mr. Smith who called Dr. Jekyll from St. Louis. He hung up.", lang="en") == \
        ["It was Mr. Smith who called Dr. Jekyll from St. Louis.", "He hung up."]
    assert split_sentences("“Do you mean Mrs. Dalloway?” She nodded.", lang="en") == ["“Do you mean Mrs. Dalloway?”", "She nodded."]


def test_a_closing_quote_stays_with_its_sentence():
    assert split_sentences('He called it "the end." Then he left.', lang="en") == ['He called it "the end."', "Then he left."]
    assert split_sentences("‘I am tired.’ ‘So am I.’", lang="en") == ["‘I am tired.’", "‘So am I.’"]


def test_the_pronoun_i_is_no_proper_noun():
    line = "When I was young I thought I knew what I wanted, and I was wrong about all of it."
    assert is_candidate(line)
    assert not is_candidate("When I met Tom, Dick and Harry in the square I knew what the evening would bring.")


def test_english_i_ends_a_sentence_and_initials_still_do_not():
    # the French guard read « I. » as an initial; in English it is the pronoun
    assert split_sentences("Nobody was more surprised than I. She had always been the clever one.", lang="en") == \
        ["Nobody was more surprised than I.", "She had always been the clever one."]
    assert split_sentences("It was written by J. K. Jerome. He was funny.", lang="en") == \
        ["It was written by J. K. Jerome.", "He was funny."]
    # a French « I. » is an initial, as before
    assert split_sentences("Il le tenait de I. Kant lui-même. Puis rien.", lang="fr") == \
        ["Il le tenait de I. Kant lui-même.", "Puis rien."]
