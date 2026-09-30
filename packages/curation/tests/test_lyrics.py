from datetime import date

from lyrics import (
    ARTIST_COOLDOWN_DAYS,
    FAMOUS_SHARE,
    MAX_LINES_PER_UNIT,
    candidate_units,
    clean_lines,
    famous_cut,
    format_song,
    is_unit_candidate,
    parse_song,
    within_cooldown,
)

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
