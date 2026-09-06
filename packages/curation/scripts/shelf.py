"""The shelf (`packages/curation/shelf/`, gitignored), its state file, and what the
archive already holds (works and secrets), read off the local store and the generation
output — the two places a puzzle exists on this machine before it is published."""

from datetime import datetime, timezone
import json
from pathlib import Path

import _paths
from slug import slug

from epub import epub_metadata

INDEX_FILE = _paths.SHELF_DIR / "index.json"


def list_books(shelf: Path = _paths.SHELF_DIR) -> list[dict]:
    """Every epub on the shelf with its own metadata: [{file, title, author}]."""
    out = []
    for path in sorted(shelf.glob("*.epub")):
        try:
            meta = epub_metadata(path)
        except Exception as exc:  # a broken file is reported, not fatal
            meta = {"title": path.stem, "author": "", "error": str(exc)}
        out.append({"file": path.name, **meta})
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


def record(index: dict, file: str, sentences: list[str]) -> None:
    entry = index["books"].setdefault(file, {"read": None, "sentences": []})
    entry["read"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for s in sentences:
        if s not in entry["sentences"]:
            entry["sentences"].append(s)


def _puzzle_files(lang: str):
    yield from _paths.LOCAL_STORE_DIR.glob(f"*.{lang}.json")
    yield from (_paths.GENERATION_OUTPUT_DIR / lang).rglob("*.json")


def archive(lang: str) -> dict:
    """What exists already: {works: [{author, work}], secrets: {slug}, sentences: {..}}."""
    works, secrets, sentences = [], set(), set()
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
    return {"works": works, "secrets": secrets, "sentences": sentences}


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
