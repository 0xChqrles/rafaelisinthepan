"""The quotation test (#260, user-decided 2026-09-08): quoted lines out of wikitext, and
a candidate matched against them. Dependency-free."""

from quotes import (clean_markup, extract_quotes, in_order_hits, load_quotes, quoted, same_person,
                    save_quotes, template_bodies)

CAMUS = """=== ''[[w:L'Étranger|L'Étranger]]'', [[w:1942 en littérature|1942]] ===
{{Citation|Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas. J'ai reçu un télégramme de l'asile : « Mère décédée. Enterrement demain. Sentiments distingués. » Cela ne veut rien dire. C'était peut-être hier.}}
{{Réf livre
|référence=L'Étranger/Gallimard-Folio
|page=9
}}
{{citation| Je sais les prestiges et le pouvoir sournois de ce pays [l'[[Algérie]]], la façon '''insinuante''' dont il retient ceux qui s'y attardent.<ref>note</ref>
|précisions=Dans « Annexes ».}}
{{citation|langue=en|citation=Only a short one.|original=Short.}}
{{citation|citation=Le contraire d'un [[peuple civilisé|peuple]] civilisé, c'est un peuple créateur, disait-il en {{date|1957}}.}}
"""

WIKIPEDIA = """L'[[incipit]] de ''L'Étranger'' est considéré comme l'un des plus célèbres passages.
Les premières phrases du roman, « Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas. », ouvrent sur le télégramme.
Il écrit à « Grenier » que tout va bien."""


def test_template_bodies_take_the_quote_and_keep_nested_pipes():
    bodies = template_bodies(CAMUS)
    assert bodies[0].startswith("Aujourd'hui, maman est morte.")
    assert "[[Algérie]]" in bodies[1] and "précisions" not in bodies[1]
    assert bodies[2] == "Only a short one."          # the citation= parameter, not langue=
    assert bodies[3].startswith("Le contraire d'un [[peuple civilisé|peuple]]")


def test_clean_markup_strips_links_refs_and_inner_templates():
    assert clean_markup("Le [[peuple civilisé|peuple]] '''créateur''', en {{date|1957}}.<ref>x</ref>") == \
        "Le peuple créateur, en ."
    assert clean_markup("l'[[Algérie]],<br/> la façon") == "l'Algérie, la façon"


def test_extract_quotes_cleans_dedups_and_drops_fragments():
    quotes = extract_quotes(CAMUS + WIKIPEDIA)
    assert quotes[0].startswith("Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas. J'ai reçu")
    assert "Only a short one." not in quotes                 # under MIN_QUOTE_WORDS
    # A « … » span INSIDE a quote is its own line too — a telegram a reader may know alone.
    assert "Mère décédée. Enterrement demain. Sentiments distingués." in quotes
    # The encyclopedia's « … » incipit is its own line (a different span than the long one).
    assert "Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas." in quotes
    assert all("[[" not in q and "'''" not in q for q in quotes)


def test_quoted_matches_the_line_its_first_sentence_and_nothing_else():
    quotes = extract_quotes(CAMUS + WIKIPEDIA)
    unit = "Aujourd’hui, maman est morte. Ou peut-être hier, je ne sais pas."
    assert quoted(unit, quotes) is not None
    # A two-sentence unit whose first sentence is the quote is out too.
    assert quoted("Aujourd’hui, maman est morte. Ou peut-être hier, je ne sais pas. La chaleur montait.", quotes)
    # Machado's line about the niece is nobody's quote.
    assert quoted("À cette époque également naquit ma nièce Vénancia, fille de Cotrim. Les uns mouraient, "
                  "les autres naissaient : je continuais à chasser les mouches.", quotes) is None
    # Function words in the quote's order are not a quotation.
    assert quoted("Je ne sais pas si c'est le chat qui est mort hier.", quotes) is None
    # The quote's own closing sentence, reshuffled a little, still is one.
    assert quoted("Cela ne veut rien dire, c'était peut-être hier.", quotes) is not None
    assert quoted("", quotes) is None


def test_in_order_hits_counts_in_order_only():
    assert in_order_hits(["a", "b", "c"], ["a", "x", "b", "c"]) == 3
    assert in_order_hits(["c", "b", "a"], ["a", "b", "c"]) == 1


def test_same_person_compares_name_parts_in_any_order():
    assert same_person("Camus, Albert", "Albert Camus")
    assert same_person("Fernando Pessoa (as Bernardo Soares)", "Pessoa Fernando")
    assert not same_person("Marguerite Duras", "Delphine de Vigan")
    assert not same_person("Jean de La Fontaine", "Pierre de Marivaux")   # particles never match
    assert not same_person("", "Pessoa Fernando")


def test_quotes_file_round_trips_and_none_when_never_fetched(tmp_path):
    assert load_quotes("x.epub", tmp_path) is None
    save_quotes("x.epub", ["Une   ligne citée.", "Une autre."], ["https://fr.wikiquote.org/wiki/X"], tmp_path)
    assert load_quotes("x.epub", tmp_path) == ["Une ligne citée.", "Une autre."]
