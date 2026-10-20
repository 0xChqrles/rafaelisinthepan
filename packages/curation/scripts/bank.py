"""The BANK: lines finished ahead, for the user to pick and finish (`pnpm curate --bank`, `--finish`).

A banked line is one the curator finished as a day but for the ranking — mined, through
the quotation test and the judge's sentence filter, shortlisted, READ (`curate.read`: its
kind, its main word and the path to it), its main word measured alone and two words chosen
against it with every check before the ranking passed (`curate.choose_trio`), its start
words chosen on the free static maps with the start step's own checks — with what it was
read and measured at, so finishing it asks none of that again. The ranking (the expensive
judge) runs only for a line the user finishes, its start words then checked on the ranked
map, nothing swapped. A line SET ASIDE is kept too, with why (`dropped`) and what it was
read, judged and measured at, never finished; each entry carries the taste it was read
under (`taste_stamp`), and `curate --rebank` takes again every line read under another, or
whose words were not chosen the main word first (`stale`), rewriting its work's entries in
place (`replace_work`).

One JSON line per banked line, `bank/<lang>.jsonl` (gitignored: the lines are the
work's text, and the trio spoils the day), read in `bank/<lang>.md` (`render`), where the
user picks the lines to finish (`curate --finish <id>`). The ledger stays the one record of what was
published: finishing a line re-reads the archive and refuses what it rules out since the
line was banked (the work or the sentence published, a word back in its cooldown).

Several `--bank` processes, and a normal run, may run at once: a work is CLAIMED
(`bank/<lang>.claims`, one `<shelf file>\t<pid>` per line) under the language's lock before
it is mined, so no two processes take the same work; a claim whose process is gone no
longer counts. Every read and write of the bank takes the same lock. A work that banked no
line is kept as a marker entry (`{"work", "empty": true}`), so it is never mined again.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import threading

import _paths
import contextual_rank  # generation/scripts: the giveaway floor
import llm
import rules
import shelf as shelf_mod
import starts as st
from parse import parse


def bank_file(lang: str) -> Path:
    return _paths.BANK_DIR / f"{lang}.jsonl"


def view_file(lang: str) -> Path:
    return _paths.BANK_DIR / f"{lang}.md"


def claims_file(lang: str) -> Path:
    return _paths.BANK_DIR / f"{lang}.claims"


_held = threading.local()


@contextmanager
def locked(lang: str):
    """The language's bank lock, across processes (`flock`); re-entrant within a thread."""
    depth = getattr(_held, "depth", 0)
    if depth:
        _held.depth = depth + 1
        try:
            yield
        finally:
            _held.depth -= 1
        return
    _paths.BANK_DIR.mkdir(parents=True, exist_ok=True)
    with open(_paths.BANK_DIR / f"{lang}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _held.depth = 1
        try:
            yield
        finally:
            _held.depth = 0
            fcntl.flock(lock, fcntl.LOCK_UN)


def load(lang: str) -> list[dict]:
    with locked(lang):
        path = bank_file(lang)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def append(lang: str, entries: list[dict]) -> None:
    if not entries:
        return
    with locked(lang):
        path = bank_file(lang)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write("".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries))


def works(lang: str) -> set[str]:
    """The shelf files the bank holds (lines, or the marker of a work that banked none): a
    work is mined once, banked or run."""
    return {entry["work"] for entry in load(lang)}


def lines(lang: str) -> list[dict]:
    """The banked lines, markers and lines set aside left out."""
    return [e for e in load(lang) if not e.get("empty") and not e.get("dropped")]


def replace_work(lang: str, work: str, entries: list[dict]) -> None:
    """A work's entries rewritten in place (`curate --rebank`), where its first one stood,
    through a temporary file renamed over the bank; every other work's entries, and the
    markers, untouched and in order."""
    with locked(lang):
        path = bank_file(lang)
        rows = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        out, placed = [], False
        for row in rows:
            if not row.strip():
                continue
            e = json.loads(row)
            if e["work"] != work or e.get("empty"):
                out.append(row)
            elif not placed:
                out.extend(json.dumps(x, ensure_ascii=False) for x in entries)
                placed = True
        if not placed:
            out.extend(json.dumps(x, ensure_ascii=False) for x in entries)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text("".join(row + "\n" for row in out), encoding="utf-8")
        os.replace(temporary, path)


def taste_stamp() -> str:
    """The taste a line was read under: the `taste` and `find-sentences` skills, hashed."""
    digest = hashlib.sha1()
    for path in (_paths.TASTE_FILE, _paths.SKILL_FILE):
        digest.update(path.read_bytes())
    return digest.hexdigest()[:8]


def chosen(e: dict) -> bool:
    """Whether a banked line's words were chosen the main word first: each hole carries its role."""
    return bool(e.get("holes")) and all("role" in h for h in e["holes"])


def is_stale(e: dict, stamp: str) -> bool:
    """Whether `curate --rebank` takes the entry: a line it can take with no judge (its
    giveaways stored at banking) that was never read or was read under another taste; or
    read under this one and kept, its words not chosen the main word first. A line set aside
    before its giveaway was paid is not: nothing it could hide was judged."""
    if not e.get("given"):
        return False
    if e.get("taste") != stamp:
        return True
    return bool(e.get("read")) and not e.get("dropped") and not chosen(e)


def stale(lang: str) -> list[dict]:
    """The entries `curate --rebank` takes (`is_stale`), in the bank's order."""
    stamp = taste_stamp()
    return [e for e in load(lang) if is_stale(e, stamp)]


def empty(book: dict) -> dict:
    """The marker of a work that banked no line."""
    return {"bankedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "work": book["file"], "kind": book["kind"], "empty": True}


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _claims(lang: str) -> list[str]:
    path = claims_file(lang)
    return [c for c in path.read_text(encoding="utf-8").split("\n") if c] if path.exists() else []


def claimed(lang: str) -> set[str]:
    """The works a live process has taken (a claim whose process is gone does not count)."""
    with locked(lang):
        taken = set()
        for c in _claims(lang):
            file, _, pid = c.partition("\t")
            if not pid.isdigit() or _alive(int(pid)):
                taken.add(file)
        return taken


def claim(lang: str, file: str) -> None:
    with locked(lang):
        with open(claims_file(lang), "a", encoding="utf-8") as f:
            f.write(f"{file}\t{os.getpid()}\n")


def unclaim(lang: str, file: str) -> None:
    """The work is no longer being mined: banked, recorded by a run, or failed (then free
    for a later `--bank`)."""
    with locked(lang):
        left = [c for c in _claims(lang) if c.partition("\t")[0] != file]
        claims_file(lang).write_text("".join(c + "\n" for c in left), encoding="utf-8")


def stored(read: dict | None) -> dict | None:
    """A line's read as the bank keeps it (`curate.read`): its kind (`llm.KINDS`, None for
    none), its main word, what it says, the path and the words it runs through, the ladder
    of a wide main word, the sibling warning, the words that need the work."""
    if read is None:
        return None
    return {"kind": read["kind"], "anchor": read["anchor"], "about": read["about"], "path": read["path"],
            "pathWords": read["path_words"], "wide": read["wide"], "ladder": read["ladder"],
            "sibling": read["sibling"], "needsBook": read["needs_book"]}


def read_of(r: dict) -> dict:
    """A kept line's read as `curate.read` gives it, from the bank's (`stored`): it stands
    alone, its main word is no mirror and hiding it hides the joke — the verdicts it was kept on."""
    return {"about": r["about"], "stands_alone": True, "why": "", "needs_book": r["needsBook"], "kind": r["kind"],
            "anchor": r["anchor"], "path": r["path"], "path_words": r["pathWords"], "wide": r["wide"],
            "ladder": r["ladder"], "mirror": False, "joke_hidden": True, "sibling": r["sibling"]}


def _measures(m) -> dict:
    return {"readings": m.readings, "says": m.says, "crowds": m.crowds, "neighbours": m.neighbours}


def measures_of(e: dict, measures_cls):
    """What a banked line's words were measured at, as the curator holds it (`curate.Measures`):
    a measure is never asked twice, and a neighbours answer keeps the fragment it was asked on."""
    m = e.get("measures") or {}
    return measures_cls(readings={k: tuple(v) for k, v in m.get("readings", {}).items()},
                        says={k: tuple(v) for k, v in m.get("says", {}).items()},
                        crowds=dict(m.get("crowds", {})),
                        neighbours={k: tuple(v) for k, v in m.get("neighbours", {}).items()})


def book_of(e: dict) -> dict:
    """The work a banked line comes from, as the shelf lists it."""
    return {"file": e["work"], "kind": e["kind"], "author": e.get("author", ""), "title": e.get("title", "")}


def line_id(work: str, sentence: str) -> str:
    """A banked line's id, the one `--finish` takes: stable for (work, sentence)."""
    return hashlib.sha1(f"{work}\n{sentence}".encode("utf-8")).hexdigest()[:8]


def entry(book: dict, line: dict, checked, started: dict, lang: str, stamp: str) -> dict:
    """A banked line as the bank keeps it: its source, its read and the taste it was read
    under (`stamp`, taken before the read), the judge's giveaway for every word it can hide,
    its three words — the MAIN word first, then the two chosen against it, each with its role,
    its path and the words it runs through, its ladder when it is one of a wide kind, its
    facts, and its start word with where it stands on its free map — code's notes, every
    measure taken on the line, and the line as the player would first see it."""
    draft, starts = started["draft"], started["starts"]
    first = {}
    for h in draft["holes"]:
        first.setdefault(h["secret"]["slug"], h)
    return {
        "id": line_id(book["file"], line["sentence"]),
        "bankedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lang": lang, "work": book["file"], "kind": book["kind"],
        "author": book.get("author", ""), "title": book.get("title", ""),
        "sentence": line["sentence"],
        "taste": stamp, "read": stored(line["read"]),
        "marked": st.displayed(draft["words"], draft["holes"], {k: f"[{h['secret']['word']}]" for k, h in first.items()}),
        "shown": st.displayed(draft["words"], draft["holes"]),
        "holes": [{"secret": first[t.slug]["secret"]["word"], "slug": t.slug, "role": "main" if n == 0 else "other",
                   "path": checked.paths[t.slug]["line"], "pathWords": checked.paths[t.slug]["words"],
                   "ladder": checked.ladders.get(t.slug), "tags": checked.tags[t.slug],
                   "start": starts[t.slug], "startRank": first[t.slug].get("start_rank")}
                  for n, t in enumerate(checked.trio)],
        "starts": dict(starts),
        "given": line["given"],
        "trio": [t.slug for t in checked.trio],
        "context": checked.context,
        "measures": _measures(line["measures"]),
    }


def aside(book: dict, line: dict, lang: str, stamp: str) -> dict:
    """A line SET ASIDE (`curate`: at its read, its giveaway, its main word, the two words
    against it or its start words), kept with why, its read, the taste it was read under, the
    giveaways paid and what was measured — so a later `--rebank` takes it again with no
    judge: listed with its reason, never finished."""
    return {"id": line_id(book["file"], line["sentence"]),
            "bankedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "lang": lang, "work": book["file"], "kind": book["kind"],
            "author": book.get("author", ""), "title": book.get("title", ""),
            "sentence": line["sentence"], "taste": stamp, "read": stored(line.get("read")),
            "dropped": line["dropped"], "given": line.get("given") or {},
            "measures": _measures(line["measures"]) if line.get("measures") else {}}


def pool(tokens, given: dict, lang: str, in_vocab, cooling=frozenset(), frequency_rank=lambda t: None) -> list:
    """The words a banked line can hide: those code allows, but the secrets `cooling` (the
    archive's cooldown, a fact of the day: `restore` and the rebank's choice of words leave
    them out, the rebank's read is shown them), whose giveaway, judged at banking, is at or
    above the floor — a word unjudged then (it was cooling) is never offered. Every word
    judged had passed the commonest-word floor, so `frequency_rank` may be left out."""
    allowed = rules.initial_candidates(tokens, lang=lang, in_vocab=in_vocab,
                                       past_secrets=cooling, frequency_rank=frequency_rank)
    return [t for t in allowed if t.slug in given and given[t.slug] >= contextual_rank.GIVEAWAY_MIN]


def restore(e: dict, archive: dict, lang: str, in_vocab, frequency_rank, measures_cls, checked_cls):
    """A banked line as the curator's `day` holds a finished one — (line, checked), the main
    word first — read against TODAY's archive; or (None, why) when the line was set aside,
    its words were not chosen the main word first (`curate --rebank` chooses them), or the
    archive now rules it out (the sentence published, a word back in its cooldown)."""
    if e.get("dropped"):
        return None, f"it was set aside: {e['dropped']}"
    if not chosen(e):
        return None, "its words were not chosen the main word first: `--rebank` chooses them"
    if shelf_mod.sentence_key(e["sentence"]) in archive["sentences"]:
        return None, "the sentence was published"
    tokens = parse(e["sentence"], lang)
    allowed = pool(tokens, e["given"], lang, in_vocab, archive["secrets"], frequency_rank)
    first_of: dict = {}
    for t in allowed:
        first_of.setdefault(t.slug, t)
    missing = [s for s in e["trio"] if s not in first_of]
    if missing:
        return None, f"« {', '.join(missing)} » can no longer be hidden (a secret in its cooldown)"
    holes = {h["slug"]: h for h in e["holes"]}
    line = {"sentence": e["sentence"], "tokens": tokens, "allowed": allowed, "given": e["given"], "pathless": [],
            "read": read_of(e["read"]), "measures": measures_of(e, measures_cls)}
    checked = checked_cls([first_of[s] for s in e["trio"]],
                          {s: {"line": holes[s]["path"], "words": holes[s]["pathWords"]} for s in e["trio"]},
                          {s: holes[s]["ladder"] for s in e["trio"] if holes[s]["ladder"]},
                          e["context"], {s: holes[s]["tags"] for s in e["trio"]})
    return (line, checked), None


def render(lang: str) -> None:
    """`bank/<lang>.md`, the bank to read — SPOILERS: every word of every line. The lines kept,
    by kind (`llm.KINDS`, 1 to 7), then those with no kind, each with its main word and the
    path to it, its ladder when it is one of a wide kind, the sibling warning, each of the two
    words chosen against it with its path, and the line as it opens with each word's start
    and facts (the main word in bold); then the lines set aside, each with why; then the lines
    waiting for `curate --rebank` to choose their words. Written under the bank's lock: two
    processes never write the page over each other."""
    with locked(lang):
        held = [e for e in load(lang) if not e.get("empty")]
        older = len(stale(lang))
        kept = [e for e in held if not e.get("dropped") and chosen(e)]
        dropped = [e for e in held if e.get("dropped")]
        waiting = [e for e in held if not e.get("dropped") and not chosen(e)]
        out = [f"# The {lang} bank — SPOILERS", "",
               f"{len(kept)} line(s) kept, {len(dropped)} set aside, {len(waiting)} waiting for their words, from "
               f"{len({e['work'] for e in held})} work(s). Finish one into a candidate day: "
               f"`pnpm curate --lang {lang} --finish <id>` (the ranking runs then).", ""]
        if older:
            out += [f"{older} line(s) were never read, were read under another taste, or wait for their words: "
                    f"`pnpm curate --lang {lang} --rebank` takes them again.", ""]
        for kind in [*llm.KINDS, None]:
            group = [e for e in kept if e["read"]["kind"] == kind]
            if group:
                out += [f"## {kind}. {llm.KINDS[kind]}" if kind else "## No kind", ""]
                for e in group:
                    out += _kept(e)
                out.append("")
        if dropped:
            out += ["## Set aside", ""]
            for e in dropped:
                anchor = (e.get("read") or {}).get("anchor")
                out.append(f"- `{e['id']}` « {e['sentence']} » — {_source(e)}: {e['dropped']}"
                           + (f" (main word « {anchor} »)" if anchor else ""))
            out.append("")
        if waiting:
            out += ["## Waiting for their words", ""]
            for e in waiting:
                out += [f"- `{e['id']}` « {e['marked']} » — {_source(e)}", *_holes(e, None)]
            out.append("")
        view_file(lang).write_text("\n".join(out), encoding="utf-8")


def _source(e: dict) -> str:
    return f"{e['author']}, *{e['title']}* ({e['kind']})"


def _holes(e: dict, anchor: str | None) -> list[str]:
    """A banked line as the player first sees it, then its hidden words (the main word in
    bold), each with its start and its facts."""
    words = []
    for h in e["holes"]:
        secret = f"**{h['secret']}**" if h["slug"] == anchor else h["secret"]
        tags = h.get("tags")
        words.append(f"{secret} ← {h['start']} (free-map rank {h['startRank']})" + (f": {', '.join(tags)}" if tags else ""))
    return [f"  - opens as: « {e['shown']} »", "  - " + "; ".join(words)]


def _through(words: list[str]) -> str:
    return f" (through {', '.join(f'« {w} »' for w in words)})" if words else ""


def _kept(e: dict) -> list[str]:
    r = e["read"]
    main, *others = e["holes"]
    rows = [f"- `{e['id']}` « {e['marked']} » — {_source(e)}",
            f"  - main word « {main['secret']} »: {main['path']}{_through(main['pathWords'])}"]
    if main["ladder"]:
        rows.append(f"  - one of a wide kind: {llm.ladder_text(main['ladder'])}")
    if r["sibling"]:
        rows.append(f"  - sibling: « {r['sibling']} » makes the same joke (a warning)")
    for h in others:
        rows.append(f"  - « {h['secret']} »: {h['path']}{_through(h['pathWords'])}"
                    + (f" — one of a wide kind: {llm.ladder_text(h['ladder'])}" if h["ladder"] else ""))
    return rows + _holes(e, main["slug"])
