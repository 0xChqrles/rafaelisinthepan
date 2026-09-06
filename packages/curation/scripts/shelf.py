"""The shelf (`packages/curation/shelf/`, gitignored), its state file, and what the
archive already holds (works and secrets), read off the local store and the generation
output — the two places a puzzle exists on this machine before it is published."""

from datetime import date, datetime, timezone
import json
from pathlib import Path
import re

import _paths
from slug import slug

from epub import epub_metadata
from lyrics import parse_song

INDEX_FILE = _paths.SHELF_DIR / "index.json"


def list_works(shelf: Path = _paths.SHELF_DIR) -> list[dict]:
    """Every work on the shelf with its own metadata: epubs as `kind: book`
    (title/author from the OPF), song files as `kind: music` (from the header):
    [{file, kind, title, author, ...}]."""
    out = []
    for path in sorted(shelf.glob("*.epub")):
        try:
            meta = epub_metadata(path)
        except Exception as exc:  # a broken file is reported, not fatal
            meta = {"title": path.stem, "author": "", "error": str(exc)}
        out.append({"file": path.name, "kind": "book", **meta})
    for path in sorted(shelf.glob("*.txt")):
        if path.name == "artists.txt":
            continue
        header, _ = parse_song(path.read_text(encoding="utf-8"))
        out.append({"file": path.name, "kind": "music", "title": header.get("title", path.stem),
                    "author": header.get("artist", ""), "album": header.get("album", ""),
                    "year": header.get("year", "")})
    return out


def load_index() -> dict:
    """{books: {file: {read: iso, sentences: [..]}}} — which books were read and which
    sentences were already proposed, so a rerun never re-offers a sentence."""
    if INDEX_FILE.exists():
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    return {"books": {}}


def save_index(index: dict) -> None:
    INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def record(index: dict, file: str, sentences: list[str], author: str = "") -> None:
    entry = index["books"].setdefault(file, {"read": None, "sentences": []})
    entry["read"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry["author"] = author
    for s in sentences:
        if s not in entry["sentences"]:
            entry["sentences"].append(s)


def last_proposed(index: dict, author: str) -> date | None:
    """When a run last proposed a work by this author, off the index."""
    key = slug(author)
    latest = None
    for entry in index["books"].values():
        if key and slug(entry.get("author", "")) == key and entry.get("read"):
            day = date.fromisoformat(entry["read"][:10])
            latest = day if latest is None or day > latest else latest
    return latest


def _puzzle_files(lang: str):
    yield from _paths.LOCAL_STORE_DIR.glob(f"*.{lang}.json")
    yield from (_paths.GENERATION_OUTPUT_DIR / lang).rglob("*.json")


_DATED = re.compile(r"^(\d{4}-\d{2}-\d{2})\.")


def archive(lang: str) -> dict:
    """What exists already: {works: [{author, work}], secrets: {slug}, sentences: {..},
    last_used: {author slug: date}} — the last date read off the DATED store files
    (`<date>.<lang>.json`), the calendar the artist cooldown is judged on."""
    works, secrets, sentences = [], set(), set()
    last_used: dict[str, date] = {}
    seen = set()
    for path in _puzzle_files(lang):
        try:
            puzzle = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for hole in puzzle.get("holes", ()):
            secrets.add(hole["secret"]["slug"])
        sentences.add(" ".join(puzzle.get("words", ())))
        src = puzzle.get("source") or {}
        key = (slug(src.get("author", "")), slug(src.get("work", "")))
        if src and key not in seen:
            seen.add(key)
            works.append({"author": src.get("author", ""), "work": src.get("work", "")})
        dated = _DATED.match(path.name)
        if src and dated and key[0]:
            day = date.fromisoformat(dated.group(1))
            if key[0] not in last_used or day > last_used[key[0]]:
                last_used[key[0]] = day
    return {"works": works, "secrets": secrets, "sentences": sentences, "last_used": last_used}


def in_archive(book: dict, works: list[dict]) -> bool:
    """A shelf book already used: same folded title, or the archived work's title
    contained in the book's (editions pad titles with subtitles)."""
    title = slug(book.get("title", ""))
    if not title:
        return False
    for w in works:
        archived = slug(w.get("work", ""))
        if archived and (archived == title or archived in title or title in archived):
            return True
    return False


def forget(index: dict, work: dict, lang: str) -> list[str]:
    """Erase an attempt: the work's index entry and every candidate puzzle written for it
    under the GENERATION OUTPUT (never the store — a published day is not an attempt).
    Returns what was deleted."""
    index["books"].pop(work["file"], None)
    author, title = slug(work.get("author", "")), slug(work.get("title", ""))
    deleted = []
    for path in (_paths.GENERATION_OUTPUT_DIR / lang).rglob("*.json"):
        try:
            src = json.loads(path.read_text(encoding="utf-8")).get("source") or {}
        except (OSError, ValueError):
            continue
        if slug(src.get("author", "")) == author and slug(src.get("work", "")) == title:
            path.unlink()
            deleted.append(str(path))
            parent = path.parent
            while parent != _paths.GENERATION_OUTPUT_DIR and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
    return deleted
