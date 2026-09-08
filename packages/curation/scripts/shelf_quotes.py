"""Fetch the QUOTED lines of every book on the shelf (the quotation test, #260,
user-decided 2026-09-08).

    pnpm shelf:quotes [--work FILE] [--force]

Per book: the author's page on fr.wikiquote.org, the work's page there when it has one,
and the work's article on fr.wikipedia.org — the record of what a French reader has met
without opening the book. Their quoted lines are written to shelf/quotes/<file>.txt,
which the curator reads OFFLINE. A book already fetched is skipped unless --force. The
MediaWiki API asks for one request at a time and a User-Agent that names the caller;
both are honoured. Like the lyrics fetch, this is a shelf step: the curator itself never
touches the network.
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request

import _paths
from slug import slug

import quotes as qt
import shelf as shelf_mod

WIKIQUOTE = "fr.wikiquote.org"
WIKIPEDIA = "fr.wikipedia.org"
USER_AGENT = "whippin-curation/0.1 (https://whippin.ai; hello@whippin.ai)"
# One request at a time, with a breath between: the API's own etiquette.
PAUSE_S = 0.5
# Edition noise the epub metadata carries and the encyclopedia does not.
_TITLE_NOISE = re.compile(r"\(.*?\)|@\w+|\bV\d\b|\bed\.?\s*\d{4}\b|\bfrench edition\b", re.I)


def api(host: str, **params) -> dict:
    params.update(format="json", formatversion="2")
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    time.sleep(PAUSE_S)
    return data


def search(host: str, query: str, limit: int = 5) -> list[str]:
    hits = api(host, action="query", list="search", srsearch=query, srlimit=limit)
    return [h["title"] for h in hits.get("query", {}).get("search", [])]


def page_wikitext(host: str, title: str) -> str | None:
    data = api(host, action="parse", page=title, prop="wikitext", redirects=1)
    return data.get("parse", {}).get("wikitext")


def title_words(title: str) -> list[str]:
    return [slug(w) for w in _TITLE_NOISE.sub(" ", title).split() if slug(w)]


def same_title(hit: str, title: str) -> bool:
    """A search hit names the work when its title, edition noise aside, is the work's
    title — as words, so `L'Étranger (film, 2025)` is not `L'Étranger` but `Le Désert
    Des Tartares` is `Le Désert des Tartares`."""
    a, b = title_words(hit), title_words(title)
    return bool(a) and a == b


def author_page(host: str, author: str) -> str | None:
    for hit in search(host, author):
        if qt.same_person(hit, author):
            return hit
    return None


def work_page(host: str, title: str, author: str) -> str | None:
    for hit in search(host, f"{_TITLE_NOISE.sub(' ', title)} {author}"):
        if same_title(hit, title):
            return hit
    return None


def fetch_work(work: dict) -> tuple[list[str], list[str]]:
    """(quoted lines, the pages they came from) for one book of the shelf."""
    author, title = work.get("author", ""), work.get("title", "")
    pages: list[tuple[str, str]] = []
    if author:
        page = author_page(WIKIQUOTE, author)
        if page:
            pages.append((WIKIQUOTE, page))
    if title:
        page = work_page(WIKIQUOTE, title, author)
        if page and (WIKIQUOTE, page) not in pages:
            pages.append((WIKIQUOTE, page))
        page = work_page(WIKIPEDIA, title, author)
        if page:
            pages.append((WIKIPEDIA, page))
    quotes: list[str] = []
    sources: list[str] = []
    for host, page in pages:
        text = page_wikitext(host, page)
        if text is None:
            continue
        sources.append(f"https://{host}/wiki/{urllib.parse.quote(page.replace(' ', '_'))}")
        quotes.extend(qt.extract_quotes(text))
    return qt.extract_quotes("\n".join(f"{{{{citation|{q}}}}}" for q in quotes)), sources


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--work", help="one shelf file (default: every book without a quotes file)")
    p.add_argument("--force", action="store_true", help="refetch books that already have a file")
    args = p.parse_args()
    books = [w for w in shelf_mod.list_works() if w["kind"] == "book"]
    if args.work:
        books = [w for w in books if w["file"] == args.work]
        if not books:
            print(f"[shelf:quotes] {args.work} is not a book on the shelf", file=sys.stderr)
            sys.exit(1)
    for work in books:
        if not args.force and qt.quotes_file(work["file"]).exists():
            continue
        try:
            found, sources = fetch_work(work)
        except Exception as exc:  # the network, or a page shape we do not read
            print(f"[shelf:quotes] {work['file']}: FAILED ({exc})", file=sys.stderr)
            continue
        path = qt.save_quotes(work["file"], found, sources)
        print(f"[shelf:quotes] {work.get('author', '')} — {work.get('title', '')}: "
              f"{len(found)} quoted line(s) from {len(sources)} page(s) -> {path.name}")


if __name__ == "__main__":
    main()
