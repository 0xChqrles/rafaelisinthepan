from datetime import date

from lyrics import (
    ARTIST_COOLDOWN_DAYS,
    FAMOUS_SHARE,
    MAX_LINES_PER_UNIT,
    artist_name,
    candidate_units,
    clean_lines,
    famous_cut,
    format_song,
    is_unit_candidate,
    parse_song,
    song_filename,
    stanza_excerpt,
    strip_adlibs,
    within_cooldown,
)
from shelf_lyrics import find_artist
from slug import path_slug

RAW = """3 Contributors
[Couplet 1]
Une michetonneuse, un mec fauché, ça va pas ensemble
Top model et clic-clac, les rolex, les flik flak
L'alcool dans l'sang et les routes en zigzag

[Refrain]
Ça va pas ensemble
Ça va pas ensemble

Trois mots seuls ici
Et puis quatre mots de plus
Cinq mots pour finir la strophe là
Embed"""


def test_header_round_trip():
    header = {"artist": "Alpha Wann", "title": "Ça va ensemble", "album": "UMLA", "year": 2018, "pageviews": 12}
    text = format_song(header, "ligne un\nligne deux")
    parsed, body = parse_song(text)
    assert parsed == {k: str(v) for k, v in header.items()}
    assert body.strip() == "ligne un\nligne deux"
    assert parse_song("just lyrics") == ({}, "just lyrics")


def test_clean_lines_drops_genius_noise_and_keeps_stanza_breaks():
    lines = clean_lines(RAW)
    assert lines[0].startswith("Une michetonneuse")
    assert "" in lines and "[Refrain]" not in lines and "Embed" not in lines
    assert not any(l.endswith("Contributors") for l in lines)


def test_candidate_units_join_adjacent_lines_within_a_stanza():
    units = candidate_units(clean_lines(RAW))
    # Two lines of the first stanza reach the band; later lines lowercase their first letter
    # and a comma bridges a line with no punctuation.
    assert units[0] == ("Une michetonneuse, un mec fauché, ça va pas ensemble, "
                        "top model et clic-clac, les rolex, les flik flak")
    # A unit never crosses a blank line: the refrain's two short lines make none.
    assert not any("ça va pas ensemble, ça va pas ensemble" in u.lower() for u in units)
    # The last stanza needs three lines to reach 14 words — one unit, from its first line.
    assert any(u.startswith("Trois mots seuls ici, et puis") for u in units)


TEN = "un deux trois quatre cinq six sept huit neuf dix"


def test_a_ten_word_line_is_offered_alone_and_a_nine_word_one_is_not():
    assert candidate_units([TEN]) == [TEN]
    assert candidate_units([TEN.rsplit(" ", 1)[0]]) == []


def test_a_run_goes_from_the_first_line_worth_offering_to_the_first_that_reaches_the_band():
    # 10 words alone, 14 with the next line — and no further
    assert candidate_units([TEN, "Onze douze treize quatorze", "Quinze seize"]) == [
        TEN, TEN + ", onze douze treize quatorze"]


def test_a_unit_never_passes_thirty_three_words():
    nine, long = TEN.rsplit(" ", 1)[0], " ".join(["mot"] * 25)
    assert candidate_units([" ".join(["mot"] * 34)]) == []
    assert candidate_units([nine, long]) == [long]      # joined they would be 34: never one unit


def test_a_unit_is_at_most_four_lines():
    # five lines of two words: four make 8, short of a line worth offering, and a fifth is never joined
    assert MAX_LINES_PER_UNIT == 4
    assert candidate_units(["Un deux", "Trois quatre", "Cinq six", "Sept huit", "Neuf dix"]) == []


def test_unit_candidate_filter():
    assert is_unit_candidate("une phrase sans chiffre ni noms propres, longue assez")
    assert not is_unit_candidate("en 1998 tout allait bien")
    assert not is_unit_candidate("Pierre Paul Jacques et Marie sont venus")


def test_famous_cut_drops_the_top_viewed_share():
    songs = [{"id": i, "pageviews": i * 100} for i in range(1, 9)]
    kept = famous_cut(songs, share=0.25)
    assert [s["id"] for s in kept] == [6, 5, 4, 3, 2, 1]  # 2 of 8 dropped, most viewed first
    assert FAMOUS_SHARE == 0.25 and famous_cut(songs) == kept   # the share the fetch cuts by
    assert famous_cut([songs[0]]) == [songs[0]]           # a lone song stays
    assert len(famous_cut(songs[:2])) == 1                # two songs: the top one goes


def test_within_cooldown():
    today = date(2026, 9, 6)
    assert within_cooldown(today, today)
    assert within_cooldown(date(2026, 8, 10), today)
    assert not within_cooldown(today.replace(month=8, day=6), today)
    assert not within_cooldown(None, today)
    assert ARTIST_COOLDOWN_DAYS == 30


class _Search:
    """Genius's artist search, answering the same hits whatever is asked."""

    def __init__(self, *names):
        self.names = names

    def search_artists(self, _name):
        return {"sections": [{"hits": [{"result": {"id": i, "name": n}} for i, n in enumerate(self.names)]}]}


def test_the_fetch_takes_only_the_artist_the_list_names():
    # The list is the whole whitelist: a line is the artist's Genius name, case and spacing aside.
    search = _Search("Mikill Pane", "M.I.K.I.", "miki (FRA)")
    assert find_artist(search, "miki (fra)")[0] == {"id": 2, "name": "miki (FRA)"}
    assert find_artist(_Search("Népal"), "népal")[0]["name"] == "Népal"
    # Never a looser match: « miki » is not the German rapper M.I.K.I. The search's names come
    # back, to fix the line.
    assert find_artist(search, "miki") == (None, ["Mikill Pane", "M.I.K.I.", "miki (FRA)"])
    assert find_artist(_Search("JeanJass"), "Jean Jass")[0] is None
    assert find_artist(_Search(), "Personne") == (None, [])


def test_a_day_credits_the_artist_without_the_genius_namesake_tag():
    assert artist_name("miki (FRA)") == "miki"
    assert artist_name("Népal") == "Népal" and artist_name("Feu! Chatterton") == "Feu! Chatterton"


def test_every_genius_song_gets_its_own_readable_file():
    assert song_filename("Népal", "0 à 100", 7, path_slug) == "nepal__0-a-100__7.txt"
    # A file on the shelf is a song already fetched: two songs must never share one.
    assert song_filename("Népal", "Slow Mix 07/02/18", 1, path_slug) != \
        song_filename("Népal", "Slow Mix 06/08/17", 2, path_slug)
    assert song_filename("Népal", "Intro", 1, path_slug) != song_filename("Népal", "Intro", 2, path_slug)


def test_ad_libs_are_not_the_line():
    # Genius's parentheses are the backing voice; a filler set off by a comma at either end
    # goes with its comma, and the line keeps its capital.
    assert strip_adlibs("Yeah, la tête de mon frère dans ses pâtes bolo") == "La tête de mon frère dans ses pâtes bolo"
    assert strip_adlibs("Yeah yeah, j'suis là") == "J'suis là"
    assert strip_adlibs("J'me creuse la tête avant qu'une balle ne s'en charge, eh") == \
        "J'me creuse la tête avant qu'une balle ne s'en charge"
    assert strip_adlibs("Tu vois, hein ?") == "Tu vois ?"
    assert strip_adlibs("J'suis dans l'game (dans l'game) depuis longtemps (yeah)") == "J'suis dans l'game depuis longtemps"
    assert strip_adlibs("Ouais, ouais (han)") == ""
    assert strip_adlibs("(J'suis là)", nearby="J'suis là, toujours là") == ""   # an echo of the line before
    assert strip_adlibs("On tourne en rond (fuck) depuis des années (x2)") == "On tourne en rond depuis des années"
    # « Nan » can be the answer: never a filler.
    assert strip_adlibs("Nan, j'reste ici") == "Nan, j'reste ici"


def test_the_ad_lib_rule_on_the_shelf_s_hard_cases():
    # off the real fr shelf (#262 review, round 2)
    assert strip_adlibs("Là où le Soleil se (lève x11)", nearby="Là où le Soleil se lève") == "Là où le Soleil se lève"
    assert strip_adlibs("(Pauvre garçon), con", nearby="D'laquelle t'es amoureux, pauvre garçon") == "con"
    # a call-and-response is the song's text, even when the next line brackets it too
    line = "Chaque phase (ça fait switch), chaque line (ça fait switch)"
    assert strip_adlibs(line, nearby="Chaque track, chaque live, chaque bail (ça fait switch)") == line
    # a word nobody made out stays a gap, and no unit is cut across it
    assert strip_adlibs("Jamais mon (..) dans la (..)") == "Jamais mon (..) dans la (..)"
    assert not is_unit_candidate("(?), c'est la mort que je smoke tous les soirs dans ma tête")
    # Genius's bracketed guess at a word: kept as Genius shows it, never played
    line = "J'rappais Rue du Retrait avec [Lars, Medlar et le A ?], quand j'y r'pense en vrai tout a démarré d'là"
    assert clean_lines("[Couplet 1 : Jungle Jack]\n" + line) == [line]
    assert not is_unit_candidate(line)
    # a shout repeated is still a shout
    assert strip_adlibs("Envoie la teille de sky (aïe x12)") == "Envoie la teille de sky"


def test_a_parenthesis_that_is_the_song_s_text_stays():
    # cases off the real fr shelf (#262 review): a word that finishes the line, half a hook
    assert strip_adlibs("Pas les derniers d'la liste, avec NeS, on attise (le fuego)") == \
        "Pas les derniers d'la liste, avec NeS, on attise (le fuego)"
    assert strip_adlibs("(Dans la chambre avec le chanvre sans beaucoup d'dents mais beaucoup de gens)",
                        nearby="Chill zen avec mes G'ser on fume on hiberne") == \
        "Dans la chambre avec le chanvre sans beaucoup d'dents mais beaucoup de gens"
    assert strip_adlibs("(Ah, on sait quand ça commence mais jamais quand ça termine)") == \
        "On sait quand ça commence mais jamais quand ça termine"
    # Never a word the line says: not set off by a comma, or not a filler.
    for line in ("Elle m'a dit ouais", "Oh la la, la vie", "Ahmed, viens", "Eh bien, voilà"):
        assert strip_adlibs(line) == line


def test_a_line_of_ad_libs_alone_is_no_line_and_no_stanza_break():
    assert clean_lines("Première ligne\n(Yeah, yeah)\nDeuxième ligne") == ["Première ligne", "Deuxième ligne"]


STANZA = ["Il pleuvait sur la ville", "Yeah, la tête de mon frère dans ses pâtes bolo",
          "J'ai pas compris tout d'suite que mes grands-parents étaient alcoolos",
          "Au fond c'était pas si drôle", "On riait quand même"]


def test_a_song_s_page_is_its_whole_stanza():
    lines = clean_lines("Autre strophe, autre chose\n\n" + "\n".join(STANZA) + "\n\nRefrain d'après")
    unit = ("La tête de mon frère dans ses pâtes bolo, "
            "j'ai pas compris tout d'suite que mes grands-parents étaient alcoolos")
    assert unit in candidate_units(lines)
    # Each side reads as the unit does and ends on a full stop; never another stanza.
    assert stanza_excerpt(lines, unit) == {"before": ["Il pleuvait sur la ville."],
                                           "after": ["Au fond c'était pas si drôle,", "on riait quand même."]}
    assert stanza_excerpt(lines, "une ligne qui n'y est pas") is None
    assert stanza_excerpt(["Une seule ligne de dix mots pour faire toute la strophe"],
                          "Une seule ligne de dix mots pour faire toute la strophe") is None
