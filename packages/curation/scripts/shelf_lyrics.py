"""Fetch an artist list's deep cuts from Genius onto the shelf (#262).

    pnpm shelf:lyrics [--lang fr] [--artists shelf/<lang>/artists.txt] [--max-songs N]

The artist list is the user's, by hand, one name per line, on the language's shelf: it
is the whole whitelist, nothing outside it is ever fetched. Per artist: the songs from the API, most viewed
first, minus the top-viewed FAMOUS_SHARE (the singles), minus what is on the shelf
already; each remaining song is written as one `.txt` with a header. Needs
`GENIUS_ACCESS_TOKEN` (a free client access token, genius.com/api-clients), never a
file in the repo. The curator itself never touches the network.
"""

import argparse
import os
from pathlib import Path
import sys

import _paths
from slug import path_slug

import lyrics as lyr
from shelf import LANGS


def die(msg: str) -> None:
    print(f"[shelf:lyrics] {msg}", file=sys.stderr)
    sys.exit(1)


def read_artists(path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        die(f"no artist list at {path} (one name per line)")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def _name_key(name: str) -> str:
    return " ".join(name.split()).casefold()


def find_artist(genius, name: str) -> tuple[dict | None, list[str]]:
    """(the Genius artist the list names, the search's first names). A line is the artist's
    Genius name, case and spacing aside (« Népal », « miki (FRA) »), never a looser match:
    folded to letters, « miki » was the German rapper M.I.K.I. When no hit has the name,
    the search's first names come back so the line can be fixed."""
    hits = genius.search_artists(name).get("sections", [{}])[0].get("hits", [])
    results = [hit.get("result", {}) for hit in hits]
    match = next((r for r in results if _name_key(r.get("name", "")) == _name_key(name)), None)
    return match, [r.get("name", "") for r in results[:5]]


def artist_songs(genius, artist_id: int, max_songs: int) -> list[dict]:
    songs: list[dict] = []
    page = 1
    while page and len(songs) < max_songs:
        answer = genius.artist_songs(artist_id, per_page=50, page=page, sort="popularity")
        for song in answer.get("songs", []):
            if song.get("primary_artist", {}).get("id") != artist_id:
                continue  # a feature: the line belongs to someone else's song
            songs.append({
                "id": song["id"],
                "url": song.get("url", ""),
                "title": song.get("title", ""),
                "pageviews": (song.get("stats") or {}).get("pageviews") or 0,
            })
        page = answer.get("next_page")
    return songs[:max_songs]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=LANGS, default="fr", help="the shelf the songs go to")
    p.add_argument("--artists", help="the artist list (default: the shelf's artists.txt)")
    p.add_argument("--max-songs", type=int, default=lyr.MAX_SONGS_PER_ARTIST)
    args = p.parse_args()
    shelf = _paths.shelf_dir(args.lang)

    token = os.environ.get("GENIUS_ACCESS_TOKEN")
    if not token:
        die("GENIUS_ACCESS_TOKEN is not set (a client access token from genius.com/api-clients)")
    from lyricsgenius import Genius

    # Section headers are dropped by `lyrics.clean_lines`, never here: the library's removal
    # deletes EVERY bracket, Genius's inline guesses at a word included (« [Poto ?] »),
    # and leaves a hole in the line.
    genius = Genius(token, remove_section_headers=False, skip_non_songs=True, retries=2, timeout=15)
    genius.verbose = False

    path = Path(args.artists) if args.artists else shelf / "artists.txt"
    artists = read_artists(path if path.is_absolute() else _paths.CURATION_DIR / path)
    shelf.mkdir(parents=True, exist_ok=True)
    written = 0
    for name in artists:
        artist, nearest = find_artist(genius, name)
        if artist is None:
            print(f"- {name}: no Genius artist by this name"
                  + (f" (the search: {', '.join(nearest)})" if nearest else "") + ", skipped", flush=True)
            continue
        credited = lyr.artist_name(artist["name"])
        songs = artist_songs(genius, artist["id"], args.max_songs)
        kept = lyr.famous_cut(songs)
        print(f"- {artist['name']}: {len(songs)} songs, {len(songs) - len(kept)} most viewed dropped", flush=True)
        for song in kept:
            path = shelf / lyr.song_filename(credited, song["title"], song["id"], path_slug)
            if path.exists():
                continue
            # By its page when the listing gave it: by id alone, the library looks the song
            # up once more to find the page.
            text = genius.lyrics(song_id=song["id"], song_url=song["url"])
            if not text or not text.strip():
                continue
            detail = genius.song(song["id"]).get("song", {})
            header = {
                "artist": credited,
                "title": song["title"],
                "album": (detail.get("album") or {}).get("name", "") or "",
                # `release_date` (YYYY-MM-DD) is the official API's; it has no date components.
                "year": (detail.get("release_date") or "")[:4],
                "pageviews": song["pageviews"],
            }
            path.write_text(lyr.format_song(header, text), encoding="utf-8")
            written += 1
    print(f"{written} song(s) written to {shelf}")


if __name__ == "__main__":
    main()
