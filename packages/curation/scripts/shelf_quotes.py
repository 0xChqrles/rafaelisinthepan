"""Fetch the QUOTED lines of every book on the shelf (the quotation test, #260,
user-decided 2026-09-08).

    pnpm shelf:quotes [--lang fr] [--work FILE] [--force]

Per book of the language's shelf: the author's page on that language's Wikiquote
(fr.wikiquote.org, en.wikiquote.org), the work's page there when it has one, and the
work's article on that language's Wikipedia — the record of what a reader of the
language has met without opening the book. Their quoted lines are written to
shelf/<lang>/quotes/<file>.txt, which the curator reads OFFLINE. A book already fetched is skipped unless --force. The
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

# (Wikiquote, Wikipedia) per language: a reader meets a line in their own language.
HOSTS = {"fr": ("fr.wikiquote.org", "fr.wikipedia.org"),
         "en": ("en.wikiquote.org", "en.wikipedia.org")}
USER_AGENT = "whippin-curation/0.1 (https://whippin.ai; hello@whippin.ai)"
# One request at a time, with a breath between: the API's own etiquette.
PAUSE_S = 0.5
# A disambiguator naming an adaptation: the film's article is not the book's.
_ADAPTATION = re.compile(r"\([^)]*\b(?:film|téléfilm|tv|television|série|series|miniseries|opéra|opera|"
                         r"musical|comédie musicale|album|song|chanson)\b[^)]*\)", re.I)
# Edition noise the epub metadata carries and the encyclopedia does not.
_TITLE_NOISE = re.compile(r"\(.*?\)|@\w+|\bV\d\b|\bed\.?\s*\d{4}\b|\b(?:french|english) edition\b", re.I)


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
    """A title as comparable words. A word keeps its DIGITS (`slug` drops them): «
    American Psycho 2 » is not « American Psycho », « Vernon Subutex 2 » not « … 1 »."""
    words = []
    for w in _TITLE_NOISE.sub(" ", title).split():
        key = slug(w) + "".join(ch for ch in w if ch.isdigit())
        if key:
            words.append(key)
    return words


def main_title(title: str) -> str:
    """The title before an edition's subtitle: `Severance: A Novel` is `Severance`."""
    return title.split(":")[0]


def same_title(hit: str, title: str) -> bool:
    """A search hit names the work when its title, edition noise and a disambiguator
    aside, is the work's title, with or without its subtitle — as words: `Le Désert Des
    Tartares` is `Le Désert des Tartares`, `Mes amis (roman)` is `Mes amis`, and
    `Chimpanzee Politics` is `Chimpanzee Politics: Power and Sex among Apes`."""
    a = title_words(hit)
    own = title_words(title)
    # a numbered volume is its series' page (« Vernon Subutex 1 » / « Vernon Subutex »),
    # never the other way round (« American Psycho 2 » is not « American Psycho »)
    series = own[:-1] if len(own) > 1 and own[-1].isdigit() else own
    return bool(a) and a in (own, title_words(main_title(title)), series)


def author_page(host: str, author: str) -> str | None:
    for hit in search(host, author):
        if qt.same_person(hit, author):
            return hit
    return None


def work_page(host: str, title: str, author: str) -> str | None:
    """The first search hit that names the work and is not an adaptation's page — the
    search ranks `Slaughterhouse-Five (film)` above the novel."""
    for hit in search(host, f"{_TITLE_NOISE.sub(' ', main_title(title))} {author}"):
        if same_title(hit, title) and not _ADAPTATION.search(hit):
            return hit
    return None


def fetch_work(work: dict, lang: str) -> tuple[list[str], list[str]]:
    """(quoted lines, the pages they came from) for one book of the language's shelf."""
    wikiquote, wikipedia = HOSTS[lang]
    author, title = work.get("author", ""), work.get("title", "")
    pages: list[tuple[str, str]] = []
    if author:
        page = author_page(wikiquote, author)
        if page:
            pages.append((wikiquote, page))
    if title:
        page = work_page(wikiquote, title, author)
        if page and (wikiquote, page) not in pages:
            pages.append((wikiquote, page))
        page = work_page(wikipedia, title, author)
        if page:
            pages.append((wikipedia, page))
    quotes: list[str] = []
    sources: list[str] = []
    for host, page in pages:
        text = page_wikitext(host, page)
        if text is None:
            continue
        sources.append(f"https://{host}/wiki/{urllib.parse.quote(page.replace(' ', '_'))}")
        quotes.extend(qt.extract_quotes(text, lang, wikiquote=host == wikiquote))
    return qt.dedupe_quotes(quotes), sources


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=shelf_mod.LANGS, default="fr", help="the shelf, and the wikis read")
    p.add_argument("--work", help="one shelf file (default: every book without a quotes file)")
    p.add_argument("--force", action="store_true", help="refetch books that already have a file")
    args = p.parse_args()
    root = qt.quotes_dir(args.lang)
    books = [w for w in shelf_mod.list_works(_paths.shelf_dir(args.lang))
             if w["kind"] == "book" and not w.get("error")]
    if args.work:
        books = [w for w in books if w["file"] == args.work]
        if not books:
            print(f"[shelf:quotes] {args.work} is not a book on the shelf", file=sys.stderr)
            sys.exit(1)
    for work in books:
        if not args.force and qt.quotes_file(work["file"], root).exists():
            continue
        try:
            found, sources = fetch_work(work, args.lang)
        except Exception as exc:  # the network, or a page shape we do not read
            print(f"[shelf:quotes] {work['file']}: FAILED ({exc})", file=sys.stderr)
            continue
        path = qt.save_quotes(work["file"], found, sources, root)
        print(f"[shelf:quotes] {work.get('author', '')} — {work.get('title', '')}: "
              f"{len(found)} quoted line(s) from {len(sources)} page(s) -> {path.name}")


if __name__ == "__main__":
    main()
