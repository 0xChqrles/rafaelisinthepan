"""Lyrics on the shelf (#262): the song file format, the cleanup, the couplet units the
curator mines, the famous-single cut and the artist cooldown. Stdlib only; the fetch
that talks to Genius is `shelf_lyrics.py`.

A song file is `<artist>__<title>__<genius id>.txt` (readable names, the id keeping two
songs of one title apart): a header of `key: value` lines, a `---` line, then the lyrics
as Genius serves them (section headers already removed).
"""

from datetime import date, timedelta
import re

from sentences import MAX_INNER_CAPITALS, MAX_WORDS, MIN_LINE_WORDS, MIN_WORDS, word_count

HEADER_KEYS = ("artist", "title", "album", "year", "pageviews")
# Top-viewed share of an artist's songs dropped before any lyric is read: the famous
# singles, which the skill forbids ("never the famous single").
FAMOUS_SHARE = 0.25
# Songs read per artist (most viewed first, so the cut above sees the real top).
MAX_SONGS_PER_ARTIST = 80
# Lines joined into one unit, at most; never across a blank line (a stanza break).
MAX_LINES_PER_UNIT = 4
# The same artist at most once a month on the calendar (user-decided 2026-09-06).
ARTIST_COOLDOWN_DAYS = 30

# The tag Genius gives namesakes: « miki (FRA) », the M.I.K.I. there being a German rapper.
_GENIUS_TAG = re.compile(r"\s*\([^()]*\)$")
# Ad-libs are not the line (user-decided 2026-10-16, after a day opening on « Yeah, »):
# a parenthesis of fillers or of words the line or its neighbours already say is the
# backing voice (« (yeah) », « J'suis dans l'game (dans l'game) »), and a FILLER word set
# off by a comma at a line's start or end (« Yeah, la tête… », « …s'en charge, eh ») goes
# with its comma. Any other parenthesis is the song's text — half a hook, a second voice,
# « on attise (le fuego) » — and stays. Only set off: « elle m'a dit ouais » keeps its
# word, and « Oh la la » its « Oh ». A word of fillers joined by hyphens is fillers too
# (« (Uh-huh) », « (oh-woah) »).
FILLERS = ("yeah", "yeh", "yah", "ouais", "ok", "okay", "hey", "han", "hun", "hein", "wow",
           "ouh", "wouh", "woh", "oh", "ah", "ay", "eh", "wah", "yo", "uh", "huh", "hum", "hmm",
           "hmmm", "mmh", "haha", "aïe", "wesh", "fuck", "gang", "bang", "brr", "brrr", "skrrt",
           "woo", "woah", "whoa", "ooh", "ohh", "hahaha", "skrt")
# A repeat marker, « (x2) », is no word of the song either (and its digit would refuse
# every unit around it); « se (lève x11) » is sung text, so only the marker goes.
_REPEAT = re.compile(r"\s*(?<!\w)[x×]\d+(?!\w)\s*")
# A GAP in the line: Genius's mark for a word nobody made out, « (?) », « (..) », and its
# bracketed guess at one, « avec [Lars, Medlar et le A ?] » — what Genius is unsure of is
# no line to play (the page shows it as Genius does).
_GAP = re.compile(r"\([^()\w]*\)|\[[^\[\]]*\]")
_FILLER = "(?:" + "|".join(FILLERS) + ")"
_WORD = re.compile(r"[\w'’]+")
_ADLIB = re.compile(r"\s*\([^()]*\)")
_LEAD = re.compile(rf"^(?:{_FILLER}[\s,!…-]+)*{_FILLER}\s*[,!…]+\s*", re.I)
_TAIL = re.compile(rf"\s*,\s*(?:{_FILLER}[\s,!…-]+)*{_FILLER}(?=\s*[!?.…]*\s*$)", re.I)
_ONLY_FILLERS = re.compile(rf"^(?:{_FILLER}[\s,!?.…-]*)+$", re.I)
_SECTION = re.compile(r"^\s*\[.*?\]\s*$")
_NOISE = re.compile(r"^\s*(\d+\s+Contributors?|You might also like|.*Embed|Translations?|.*Lyrics)\s*$", re.I)


def format_song(header: dict, lyrics: str) -> str:
    lines = [f"{k}: {header.get(k, '')}" for k in HEADER_KEYS]
    return "\n".join(lines) + "\n---\n" + lyrics.strip() + "\n"


def parse_song(text: str) -> tuple[dict, str]:
    """(header, lyrics); a file with no `---` is all lyrics with an empty header."""
    head, sep, body = text.partition("\n---\n")
    if not sep:
        return {}, text
    header = {}
    for line in head.splitlines():
        key, colon, value = line.partition(":")
        if colon and key.strip() in HEADER_KEYS:
            header[key.strip()] = value.strip()
    return header, body


def _words(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def strip_adlibs(line: str, nearby: str = "") -> str:
    """The line without its ad-libs ("" when nothing else is left), `nearby` being the
    lines around it: a parenthesis whose words are all fillers or all said in the line or
    `nearby` goes; another stays, unbracketed when it is the whole line. The first letter
    is capitalised again when a filler opened the line."""
    # What a neighbour says in its own brackets is its ad-lib, not said: a call-and-response
    # « (ça fait switch) » on two lines is the song's text on both.
    said = _words(_ADLIB.sub(" ", line)) | _words(_ADLIB.sub(" ", nearby)) | set(FILLERS)

    def echo(m: re.Match) -> str:
        if _GAP.fullmatch(m.group(0).strip()):
            return m.group(0)
        inner = m.group(0).strip()[1:-1]
        if _REPEAT.search(inner):  # sung text, repeated (never an echo): only the marker goes
            inner = _REPEAT.sub(" ", inner).strip()
            return "" if _words(inner) <= set(FILLERS) else " " + inner
        return "" if _words(inner) <= said else m.group(0)
    line = _ADLIB.sub(echo, line).strip().lstrip(",;: ")
    if line.startswith("(") and line.endswith(")") and line.count("(") == 1 and not _GAP.fullmatch(line):
        line = line[1:-1].strip()
    if _ONLY_FILLERS.match(line):
        return ""
    lead = _LEAD.match(line)
    if lead:
        line = line[lead.end():]
        line = line[:1].upper() + line[1:]
    return _TAIL.sub("", line).strip()


def clean_lines(lyrics: str) -> list[str]:
    """Genius noise out (section headers, contributor counts, the trailing Embed) and the
    ad-libs (`strip_adlibs`; a line of ad-libs alone is no line, and no stanza break);
    blank lines kept as stanza breaks, collapsed."""
    raw = [line.strip() for line in lyrics.splitlines()]
    raw = [line for line in raw if not (_SECTION.match(line) or _NOISE.match(line))]
    out: list[str] = []
    for i, line in enumerate(raw):
        if not line:
            if out and out[-1] != "":
                out.append("")
            continue
        line = strip_adlibs(line, " ".join(raw[max(i - 1, 0):i] + raw[i + 1:i + 2]))
        if line:
            out.append(line)
    while out and out[-1] == "":
        out.pop()
    return out


# A line that opens on a NAME keeps its capital: two capitalised words (« Jack City »,
# « Keanu Reeves », « Nino B. »; the pronoun I is no second one: « Weight I'm… ») or a word
# in capitals (« EHPAD »). So does one opening on the English pronoun (« I could… »).
_NAME_START = re.compile(r"^(?:[A-ZÀ-Ý][\w'’.-]*\s+(?!I\b)[A-ZÀ-Ý]|[A-ZÀ-Ý]{2,}\b|I\b)")


def _bridge(lines: list[str]) -> list[str]:
    """Lines read as one run: Genius capitalises every line, so only the first keeps it
    (a line opening on a name or on the pronoun I keeps it too), and a comma bridges a line with no
    punctuation into the next."""
    out = []
    for i, line in enumerate(lines):
        if i and not _NAME_START.match(line):
            line = line[0].lower() + line[1:]
        if i < len(lines) - 1 and line[-1] not in ".,;:!?…":
            line += ","
        out.append(line)
    return out


def _join(lines: list[str]) -> str:
    return " ".join(_bridge(lines))


def _stanzas(lines: list[str]) -> list[list[str]]:
    stanzas: list[list[str]] = [[]]
    for line in lines:
        if line == "":
            if stanzas[-1]:
                stanzas.append([])
        else:
            stanzas[-1].append(line)
    return stanzas


def candidate_units(lines: list[str]) -> list[str]:
    """Per starting line, the runs of consecutive lines (within a stanza, at most
    MAX_LINES_PER_UNIT, never past MAX_WORDS) from the first that reaches MIN_LINE_WORDS
    — a short punchline, offered alone — to the first that reaches MIN_WORDS. A rap line
    alone rarely reaches 14 words; two to four adjacent lines are what the skill calls
    the micro-story."""
    out: list[str] = []
    seen: set[str] = set()
    for stanza in _stanzas(lines):
        for start in range(len(stanza)):
            for n in range(1, MAX_LINES_PER_UNIT + 1):
                if start + n > len(stanza):
                    break
                unit = _join(stanza[start:start + n])
                words = word_count(unit)
                if words > MAX_WORDS:
                    break
                if words >= MIN_LINE_WORDS and unit not in seen:  # a short punchline, offered alone too
                    seen.add(unit)
                    out.append(unit)
                if words >= MIN_WORDS:
                    break
    return out


def stanza_excerpt(lines: list[str], unit: str) -> dict | None:
    """A song day's PAGE (user-decided 2026-10-16: « full verse or chorus »): the whole
    stanza the unit was cut from, its lines before the unit and after it, never cut.
    Each side reads as the unit does (`_bridge`) and ends on a full stop: the solved page
    opens the line on a capital, and the side after it on its own. None when the unit is
    not cut from these lines, or is its whole stanza."""
    key = " ".join(unit.split()).lower()
    for stanza in _stanzas(lines):
        for start in range(len(stanza)):
            for n in range(1, min(MAX_LINES_PER_UNIT, len(stanza) - start) + 1):
                if " ".join(_join(stanza[start:start + n]).split()).lower() != key:
                    continue
                page = {"before": _bridge(stanza[:start]), "after": _bridge(stanza[start + n:])}
                for side in page.values():
                    if side and side[-1][-1] not in ".!?…":
                        side[-1] = side[-1].rstrip(",;:") + "."
                return page if page["before"] or page["after"] else None
    return None


def is_unit_candidate(unit: str) -> bool:
    """The lyric version of the sentence filter: no digits, no roll call of names; the
    capital and punctuation rules do not apply to a line of verse."""
    if re.search(r"\d", unit) or _GAP.search(unit):  # a gap: a word nobody made out
        return False
    words = unit.split()
    inner_capitals = sum(1 for w in words[1:] if w[:1].isupper())
    return inner_capitals <= MAX_INNER_CAPITALS


def famous_cut(songs: list[dict], share: float = FAMOUS_SHARE) -> list[dict]:
    """Drop the top-viewed `share` of an artist's songs (rounded up, at least one when
    there are two or more songs); the rest, most viewed first."""
    ranked = sorted(songs, key=lambda s: -int(s.get("pageviews") or 0))
    if len(ranked) < 2:
        return ranked
    drop = max(1, -(-len(ranked) * share // 1))
    return ranked[int(drop):]


def within_cooldown(last_used: date | None, today: date) -> bool:
    return last_used is not None and today - last_used < timedelta(days=ARTIST_COOLDOWN_DAYS)


def artist_name(genius_name: str) -> str:
    """The artist as a day credits them, and as the cooldown and the archive know them:
    the Genius name without its namesake tag (« miki (FRA) » is miki)."""
    return _GENIUS_TAG.sub("", genius_name) or genius_name


def song_filename(artist: str, title: str, song_id: int, path_slug) -> str:
    """Readable (`path_slug`: digits kept, words apart) and one per Genius song: an artist
    has an « Intro » on every record, and « Slow Mix 07/02/18 » is not « … 06/08/17 »."""
    return f"{path_slug(artist) or 'artist'}__{path_slug(title) or 'title'}__{song_id}.txt"
