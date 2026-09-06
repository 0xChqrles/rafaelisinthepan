"""Lyrics on the shelf (#262): the song file format, the cleanup, the couplet units the
curator mines, the famous-single cut and the artist cooldown. Stdlib only; the fetch
that talks to Genius is `shelf_lyrics.py`.

A song file is `<artist-slug>__<title-slug>.txt`: a header of `key: value` lines, a
`---` line, then the lyrics as Genius serves them (section headers already removed).
"""

from datetime import date, timedelta
import re

from sentences import MAX_WORDS, MIN_WORDS, word_count

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


def clean_lines(lyrics: str) -> list[str]:
    """Genius noise out (section headers, contributor counts, the trailing Embed);
    blank lines kept as stanza breaks, collapsed."""
    out: list[str] = []
    for raw in lyrics.splitlines():
        line = raw.strip()
        if _SECTION.match(line) or _NOISE.match(line):
            continue
        if not line:
            if out and out[-1] != "":
                out.append("")
            continue
        out.append(line)
    while out and out[-1] == "":
        out.pop()
    return out


def _join(lines: list[str]) -> str:
    parts = []
    for i, line in enumerate(lines):
        if i:
            # Genius capitalises every line; inside a unit only the first keeps it.
            line = line[0].lower() + line[1:]
            if parts[-1][-1] not in ".,;:!?…":
                parts[-1] += ","
        parts.append(line)
    return " ".join(parts)


def candidate_units(lines: list[str]) -> list[str]:
    """One unit per starting line: the shortest run of consecutive lines (within a
    stanza, at most MAX_LINES_PER_UNIT) that reaches MIN_WORDS without passing
    MAX_WORDS. A rap line alone rarely reaches 14 words; two to four adjacent lines are
    what the skill calls the micro-story."""
    out: list[str] = []
    seen: set[str] = set()
    stanzas: list[list[str]] = [[]]
    for line in lines:
        if line == "":
            if stanzas[-1]:
                stanzas.append([])
        else:
            stanzas[-1].append(line)
    for stanza in stanzas:
        for start in range(len(stanza)):
            for n in range(1, MAX_LINES_PER_UNIT + 1):
                if start + n > len(stanza):
                    break
                unit = _join(stanza[start:start + n])
                words = word_count(unit)
                if words > MAX_WORDS:
                    break
                if words >= MIN_WORDS:
                    if unit not in seen:
                        seen.add(unit)
                        out.append(unit)
                    break
    return out


def is_unit_candidate(unit: str) -> bool:
    """The lyric version of the sentence filter: no digits, no roll call of names; the
    capital and punctuation rules do not apply to a line of verse."""
    if re.search(r"\d", unit):
        return False
    words = unit.split()
    inner_capitals = sum(1 for w in words[1:] if w[:1].isupper())
    return inner_capitals <= 2


def famous_cut(songs: list[dict], share: float = FAMOUS_SHARE) -> list[dict]:
    """Drop the top-viewed `share` of an artist's songs (rounded up, at least one when
    there are two or more songs); the rest, most viewed first."""
    ranked = sorted(songs, key=lambda s: -int(s.get("pageviews") or 0))
    if len(ranked) < 2:
        return ranked
    drop = max(1, -(-len(ranked) * share // 1))
    return ranked[int(drop):]


def within_cooldown(last_used: date | None, today: date, days: int = ARTIST_COOLDOWN_DAYS) -> bool:
    return last_used is not None and today - last_used < timedelta(days=days)


def song_filename(artist: str, title: str, slug) -> str:
    return f"{slug(artist) or 'artist'}__{slug(title) or 'title'}.txt"
