"""The quotation test (#260, user-decided 2026-09-08): quoted lines out of wikitext, and
a candidate matched against them. Dependency-free."""

from quotes import (QUOTE_TEMPLATES, clean_markup, extract_quotes, in_order_hits, load_quotes, quoted,
                    same_person, save_quotes, template_bodies)

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
    bodies = template_bodies(CAMUS, QUOTE_TEMPLATES["fr"])
    assert bodies[0].startswith("Aujourd'hui, maman est morte.")
    assert "[[Algérie]]" in bodies[1] and "précisions" not in bodies[1]
    assert bodies[2] == "Only a short one."          # the citation= parameter, not langue=
    assert bodies[3].startswith("Le contraire d'un [[peuple civilisé|peuple]]")


def test_clean_markup_strips_links_refs_and_inner_templates():
    assert clean_markup("Le [[peuple civilisé|peuple]] '''créateur''', en {{date|1957}}.<ref>x</ref>") == \
        "Le peuple créateur, en ."
    assert clean_markup("l'[[Algérie]],<br/> la façon") == "l'Algérie, la façon"


def test_extract_quotes_cleans_dedups_and_drops_fragments():
    quotes = extract_quotes(CAMUS + WIKIPEDIA, "fr")
    assert quotes[0].startswith("Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas. J'ai reçu")
    assert "Only a short one." not in quotes                 # under MIN_QUOTE_WORDS
    # A « … » span INSIDE a quote is its own line too — a telegram a reader may know alone.
    assert "Mère décédée. Enterrement demain. Sentiments distingués." in quotes
    # The encyclopedia's « … » incipit is its own line (a different span than the long one).
    assert "Aujourd'hui, maman est morte. Ou peut-être hier, je ne sais pas." in quotes
    assert all("[[" not in q and "'''" not in q for q in quotes)


def test_quoted_matches_the_line_its_first_sentence_and_nothing_else():
    quotes = extract_quotes(CAMUS + WIKIPEDIA, "fr")
    unit = "Aujourd’hui, maman est morte. Ou peut-être hier, je ne sais pas."
    assert quoted(unit, quotes, lang="fr") is not None
    # A two-sentence unit whose first sentence is the quote is out too.
    assert quoted("Aujourd’hui, maman est morte. Ou peut-être hier, je ne sais pas. La chaleur montait.", quotes, lang="fr")
    # Machado's line about the niece is nobody's quote.
    assert quoted("À cette époque également naquit ma nièce Vénancia, fille de Cotrim. Les uns mouraient, "
                  "les autres naissaient : je continuais à chasser les mouches.", quotes, lang="fr") is None
    # Function words in the quote's order are not a quotation.
    assert quoted("Je ne sais pas si c'est le chat qui est mort hier.", quotes, lang="fr") is None
    # The quote's own closing sentence, reshuffled a little, still is one.
    assert quoted("Cela ne veut rien dire, c'était peut-être hier.", quotes, lang="fr") is not None
    assert quoted("", quotes, lang="fr") is None


def test_in_order_hits_counts_in_order_only():
    assert in_order_hits(["a", "b", "c"], ["a", "x", "b", "c"]) == 3
    assert in_order_hits(["c", "b", "a"], ["a", "b", "c"]) == 1


def test_same_person_compares_name_parts_in_any_order():
    assert same_person("Camus, Albert", "Albert Camus")
    assert same_person("Fernando Pessoa (as Bernardo Soares)", "Pessoa Fernando")
    assert not same_person("Marguerite Duras", "Delphine de Vigan")
    assert not same_person("Jean de La Fontaine", "Pierre de Marivaux")   # particles never match
    assert not same_person("", "Pessoa Fernando")


def test_one_shared_name_part_is_not_the_same_person():
    # every real part of the shorter name must be in the longer: a shared first name
    # sent the fetch to the wrong author's page (Charles Parish -> Charles Dickens)
    assert not same_person("Charles Dickens", "Charles Parish")
    assert not same_person("Jean Racine", "Jean Rolin")
    assert same_person("Machado de Assis", "Joaquim Maria Machado de Assis")
    assert same_person("J. G. Ballard", "J. G. Ballard")
    assert same_person("Amélie Nothomb", "Nothomb")
    assert same_person("Kōbō Abe", "Kôbô Abé")
    # a given name transliterated two ways is still the man, the family name deciding
    assert same_person("Fedor Dostoïevski", "Fiodor Dostoïevski")
    assert same_person("Lev Tolstoï", "Léon Tolstoï")
    assert not same_person("Gilbert & George", "Gilbert White")


def test_quotes_file_round_trips_and_none_when_never_fetched(tmp_path):
    assert load_quotes("x.epub", tmp_path) is None
    save_quotes("x.epub", ["Une   ligne citée.", "Une autre."], ["https://fr.wikiquote.org/wiki/X"], tmp_path)
    assert load_quotes("x.epub", tmp_path) == ["Une ligne citée.", "Une autre."]


def test_dedupe_quotes_is_lossless():
    from quotes import dedupe_quotes
    piped = "Il dit : « je pars | je reste » et sort."
    assert dedupe_quotes([piped, "Il dit : « je pars | je reste » et sort.", "Autre ligne ici."]) == [piped, "Autre ligne ici."]


def test_quote_sources_tell_no_page_from_no_fetch(tmp_path):
    from quotes import load_quotes, quote_sources, save_quotes
    assert quote_sources("x.epub", tmp_path) == []
    save_quotes("x.epub", [], [], tmp_path)            # the fetch ran and found no page
    assert load_quotes("x.epub", tmp_path) == [] and quote_sources("x.epub", tmp_path) == []
    save_quotes("y.epub", ["Une ligne citée ici."], ["https://fr.wikiquote.org/wiki/Y"], tmp_path)
    assert quote_sources("y.epub", tmp_path) == ["https://fr.wikiquote.org/wiki/Y"]


# English (#317): en.wikiquote files a quote as a top-level `* ` bullet, its source as a
# `** ` sub-bullet below; an English article quotes between “…” or "…", or in a block
# quote template. Shapes as the MediaWiki API serves them (Slaughterhouse-Five, 2026-09-28).
VONNEGUT = """== Quotes ==
:<small> All page numbers from the mass market paperback edition </small>

* '''So it goes.'''
** Recurring statement throughout the novel.

* The nicest veterans in Schenectady, I thought, the kindest and funniest ones, were the ones who’d really fought. (p. 11)

* "I think the climax of the book will be the execution of poor old Edgar Derby," I said. "The [[irony]] is ''so'' great."
** A reply, see [http://example.org/interview the interview in full]

== External links ==
* [http://www.vonnegut.com Kurt Vonnegut's official website online]
"""

ARTICLE = """The novel opens with "All this happened, more or less." The narrator<ref name="bloom">{{cite book |title=Short}}</ref> calls it
“a novel somewhat in the telegraphic schizophrenic manner of tales” and moves on.
{{blockquote|text=Listen: Billy Pilgrim has come unstuck in time.|author=Vonnegut}}
* ''Slaughterhouse-Five'' (1969), a novel in the author's own list of works
"""


def test_english_wikiquote_bullets_are_the_quotes_and_sub_bullets_their_sources():
    quotes = extract_quotes(VONNEGUT, "en", wikiquote=True)
    # a bullet is a quote, its page reference dropped
    assert ("The nicest veterans in Schenectady, I thought, the kindest and funniest ones, were the ones "
            "who’d really fought.") in quotes
    assert any(q.startswith('"I think the climax of the book') for q in quotes)
    # the "…" inside a bullet is a line of its own too, as « … » inside a French citation
    assert "I think the climax of the book will be the execution of poor old Edgar Derby," in quotes
    assert not any("Recurring statement" in q or "A reply" in q for q in quotes)   # ** : the sources
    assert "So it goes." not in quotes                                   # under MIN_QUOTE_WORDS
    assert "Kurt Vonnegut's official website online" in quotes           # a link keeps its label only
    assert not any("http" in q for q in quotes)


def test_english_quotation_marks_and_block_quotes_on_an_article():
    quotes = extract_quotes(ARTICLE, "en")
    assert "a novel somewhat in the telegraphic schizophrenic manner of tales" in quotes
    assert "Listen: Billy Pilgrim has come unstuck in time." in quotes
    assert "All this happened, more or less." in quotes
    assert not any("bloom" in q or "cite" in q for q in quotes)         # a ref's attribute opens no span
    assert not any("list of works" in q for q in quotes)                 # an article's bullets are no quotes
    # French pages are read the French way: « … » and {{citation}}, nothing else
    assert extract_quotes(ARTICLE, "fr") == []


def test_english_quoted_uses_english_function_words():
    quotes = extract_quotes(VONNEGUT + ARTICLE, "en", wikiquote=True)
    assert quoted("I think the climax will be the execution of poor old Edgar Derby.", quotes, lang="en")
    assert quoted("The kindest and funniest veterans in Schenectady were the ones who really fought.",
                  quotes, lang="en")
    # English function words in a quote's order are no quotation
    assert quoted("I think it was the one who had been there, and so it was, more or less.", quotes,
                  lang="en") is None


def test_the_fetch_reads_the_day_s_language_wikis_and_skips_an_adaptation(monkeypatch):
    import shelf_quotes
    hits = {"en.wikiquote.org": ["Kurt Vonnegut"],
            "en.wikipedia.org": ["Slaughterhouse-Five (film)", "Slaughterhouse-Five", "Kurt Vonnegut"]}
    wikitext = {"en.wikiquote.org": "* A quoted line of five words here.",
                "en.wikipedia.org": "* A list item of the article, never a quote."}
    pages = []
    monkeypatch.setattr(shelf_quotes, "search", lambda host, query, limit=5: hits[host])
    monkeypatch.setattr(shelf_quotes, "page_wikitext",
                        lambda host, title: pages.append((host, title)) or wikitext[host])
    work = {"author": "Kurt Vonnegut", "title": "Slaughterhouse-Five (Kurt Vonnegut Series)"}
    found, sources = shelf_quotes.fetch_work(work, "en")
    # the author's en.wikiquote page and the NOVEL's en.wikipedia article, never the film's
    assert pages == [("en.wikiquote.org", "Kurt Vonnegut"), ("en.wikipedia.org", "Slaughterhouse-Five")]
    assert found == ["A quoted line of five words here."]    # bullets are quotes on Wikiquote only
    assert sources == ["https://en.wikiquote.org/wiki/Kurt_Vonnegut", "https://en.wikipedia.org/wiki/Slaughterhouse-Five"]


def test_an_edition_subtitle_does_not_hide_the_work_s_article(monkeypatch):
    import shelf_quotes
    assert shelf_quotes.same_title("Chimpanzee Politics", "Chimpanzee Politics: Power and Sex among Apes")
    assert shelf_quotes.same_title("Severance (Ma novel)", "Severance: A Novel")
    assert not shelf_quotes.same_title("Star Wars: A New Hope", "Star Wars")
    # digits are part of a title: the sequel is not the book, one volume not another
    assert not shelf_quotes.same_title("American Psycho 2", "American Psycho")
    assert not shelf_quotes.same_title("Vernon Subutex 2", "Vernon Subutex 1")
    assert shelf_quotes.same_title("Catch-22", "Catch-22")
    assert shelf_quotes.same_title("Vernon Subutex", "Vernon Subutex 1")   # a volume: its series
    queries = []
    monkeypatch.setattr(shelf_quotes, "search", lambda host, query, limit=5: queries.append(query) or
                        ["Severance (TV series)", "Severance (Ma novel)"])
    assert shelf_quotes.work_page("en.wikipedia.org", "Severance: A Novel", "Ling Ma") == "Severance (Ma novel)"
    assert queries == ["Severance Ling Ma"]                  # searched without the subtitle
