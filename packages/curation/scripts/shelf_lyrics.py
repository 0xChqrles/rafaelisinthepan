"""Fetch an artist list's deep cuts from Genius onto the shelf (#262).

    pnpm shelf:lyrics [--artists shelf/artists.txt] [--max-songs N]

The artist list is the user's, by hand, one name per line: it is the whole whitelist,
nothing outside it is ever fetched. Per artist: the songs from the API, most viewed
first, minus the top-viewed FAMOUS_SHARE (the singles), minus what is on the shelf
already; each remaining song is written as one `.txt` with a header. Needs
`GENIUS_ACCESS_TOKEN` (a free client access token, genius.com/api-clients), never a
file in the repo. The curator itself never touches the network.
"""

import argparse
import os
import sys

import _paths
from slug import slug

import lyrics as lyr

ARTISTS_FILE = _paths.SHELF_DIR / "artists.txt"


def die(msg: str) -> None:
    print(f"[shelf:lyrics] {msg}", file=sys.stderr)
    sys.exit(1)


def read_artists(path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        die(f"no artist list at {path} (one name per line)")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def find_artist(genius, name: str) -> dict | None:
    hits = genius.search_artists(name).get("sections", [{}])[0].get("hits", [])
    wanted = slug(name)
    for hit in hits:
        result = hit.get("result", {})
        if slug(result.get("name", "")) == wanted:
            return result
    return hits[0]["result"] if hits else None


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
                "title": song.get("title", ""),
                "pageviews": (song.get("stats") or {}).get("pageviews") or 0,
            })
        page = answer.get("next_page")
    return songs[:max_songs]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--artists", default=str(ARTISTS_FILE))
    p.add_argument("--max-songs", type=int, default=lyr.MAX_SONGS_PER_ARTIST)
    args = p.parse_args()

    token = os.environ.get("GENIUS_ACCESS_TOKEN")
    if not token:
        die("GENIUS_ACCESS_TOKEN is not set (a client access token from genius.com/api-clients)")
    from lyricsgenius import Genius

    genius = Genius(token, remove_section_headers=True, skip_non_songs=True, retries=2, timeout=15)
    genius.verbose = False

    artists = read_artists(_paths.CURATION_DIR / args.artists if not os.path.isabs(args.artists) else args.artists)
    _paths.SHELF_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for name in artists:
        artist = find_artist(genius, name)
        if artist is None:
            print(f"- {name}: not found on Genius", flush=True)
            continue
        songs = artist_songs(genius, artist["id"], args.max_songs)
        kept = lyr.famous_cut(songs)
        print(f"- {artist['name']}: {len(songs)} songs, {len(songs) - len(kept)} most viewed dropped", flush=True)
        for song in kept:
            path = _paths.SHELF_DIR / lyr.song_filename(artist["name"], song["title"], slug)
            if path.exists():
                continue
            text = genius.lyrics(song_id=song["id"], remove_section_headers=True)
            if not text or not text.strip():
                continue
            detail = genius.song(song["id"]).get("song", {})
            header = {
                "artist": artist["name"],
                "title": song["title"],
                "album": (detail.get("album") or {}).get("name", "") or "",
                "year": (detail.get("release_date_components") or {}).get("year", "") or "",
                "pageviews": song["pageviews"],
            }
            path.write_text(lyr.format_song(header, text), encoding="utf-8")
            written += 1
    print(f"{written} song(s) written to {_paths.SHELF_DIR}")


if __name__ == "__main__":
    main()
