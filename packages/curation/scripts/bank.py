"""The BANK: lines finished ahead, for the user to pick and finish (`pnpm curate --bank`, `--finish`).

A banked line is one the curator finished as a day but for the ranking — mined, through
the quotation test and the judge's sentence filter, shortlisted, READ (`curate.read`: its
kind, its main word and the path to it), its three words chosen and every check before the
ranking passed (`curate.check_trio`), its start words chosen on the free static maps with
the start step's own checks — with what it was read and measured at, so finishing it asks
none of that again. The ranking (the expensive judge) runs only for a line the user
finishes, its start words then checked on the ranked map. A line SET ASIDE is kept too,
with why (`dropped`) and what it was read and judged at, never finished; each entry carries
the taste it was read under (`taste_stamp`), and `curate --rebank` reads again every line
read under another (`stale`), rewriting its work's entries in place (`replace_work`).

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
from slug import slug
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


def is_stale(e: dict, stamp: str) -> bool:
    """Whether `curate --rebank` reads the entry again: a banked line (its words chosen)
    never read, or read under another taste. A line set aside before its words were chosen
    is not: the rebank chooses no words."""
    return bool(e.get("trio")) and e.get("taste") != stamp


def stale(lang: str) -> list[dict]:
    """The entries `curate --rebank` reads again (`is_stale`), in the bank's order."""
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


def line_id(work: str, sentence: str) -> str:
    """A banked line's id, the one `--finish` takes: stable for (work, sentence)."""
    return hashlib.sha1(f"{work}\n{sentence}".encode("utf-8")).hexdigest()[:8]


def entry(book: dict, line: dict, checked, started: dict, lang: str) -> dict:
    """A banked line as the bank keeps it: its source, its read and the taste it was read
    under, the judge's giveaway for every word it can hide, the checked trio with every
    measure taken on the line, and its start words with where each stands on its free map —
    and the line as the player would first see it."""
    m = checked.measures
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
        "taste": taste_stamp(), "read": stored(line["read"]),
        "marked": st.displayed(draft["words"], draft["holes"], {k: f"[{h['secret']['word']}]" for k, h in first.items()}),
        "shown": st.displayed(draft["words"], draft["holes"]),
        "holes": [{"secret": first[t.slug]["secret"]["word"], "slug": t.slug, "level": checked.levels.get(t.slug, ""),
                   "start": starts[t.slug], "startRank": first[t.slug].get("start_rank")} for t in checked.trio],
        "starts": dict(starts),
        "given": line["given"],
        "trio": [t.slug for t in checked.trio],
        "chain": checked.chain, "swaps": checked.swaps,
        "context": checked.context, "levels": checked.levels,
        "measures": {"readings": m.readings, "says": m.says, "crowds": m.crowds,
                     "neighbours": m.neighbours, "out": sorted(m.out)},
    }


def aside(book: dict, line: dict, lang: str) -> dict:
    """A line SET ASIDE before its words were chosen (`curate.candidate`: at its read, or its
    giveaway), kept with why, its read and the giveaways paid: listed with its reason, never
    finished."""
    return {"id": line_id(book["file"], line["sentence"]),
            "bankedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "lang": lang, "work": book["file"], "kind": book["kind"],
            "author": book.get("author", ""), "title": book.get("title", ""),
            "sentence": line["sentence"], "taste": taste_stamp(), "read": stored(line.get("read")),
            "dropped": line["dropped"], "given": line.get("given") or {}}


def reread(e: dict, read: dict | None, why: str | None) -> dict:
    """A banked line read again (`curate --rebank`) under today's taste: kept, or set aside
    with why — its words, start words and measures untouched either way, so a later rebank
    reads it again with no judge."""
    out = {k: v for k, v in e.items() if k != "dropped"}
    out.update(taste=taste_stamp(), read=stored(read))
    if why:
        out["dropped"] = why
    return out


def pool(tokens, given: dict, archive: dict, lang: str, in_vocab, frequency_rank=lambda t: None) -> list:
    """The words a banked line can hide TODAY: those code allows against today's archive (a
    word back in its cooldown leaves) whose giveaway, judged at banking, is at or above the
    floor — a word unjudged then (it was cooling) is never offered. Every word judged had
    passed the commonest-word floor, so `frequency_rank` may be left out."""
    allowed = rules.initial_candidates(tokens, lang=lang, in_vocab=in_vocab,
                                       past_secrets=archive["secrets"], frequency_rank=frequency_rank)
    return [t for t in allowed if t.slug in given and given[t.slug] >= contextual_rank.GIVEAWAY_MIN]


def restore(e: dict, archive: dict, lang: str, in_vocab, frequency_rank, measures_cls, checked_cls):
    """A banked line as the curator's `day` holds a finished one — (line, checked) — read
    against TODAY's archive; or (None, why) when the line was set aside or the archive now
    rules it out."""
    if e.get("dropped"):
        return None, f"it was set aside: {e['dropped']}"
    if shelf_mod.sentence_key(e["sentence"]) in archive["sentences"]:
        return None, "the sentence was published"
    tokens = parse(e["sentence"], lang)
    given = e["given"]
    allowed = pool(tokens, given, archive, lang, in_vocab, frequency_rank)
    first_of: dict = {}
    for t in allowed:
        first_of.setdefault(t.slug, t)
    missing = [s for s in e["trio"] if s not in first_of]
    if missing:
        return None, f"« {', '.join(missing)} » can no longer be hidden (a secret in its cooldown)"
    m = e["measures"]
    measures = measures_cls(
        readings={k: tuple(v) for k, v in m["readings"].items()},
        says={k: tuple(v) for k, v in m["says"].items()},
        crowds=dict(m["crowds"]),
        neighbours={k: tuple(v) for k, v in m["neighbours"].items()},
        out=set(m["out"]))
    line = {"sentence": e["sentence"], "tokens": tokens, "allowed": allowed, "given": given, "pathless": []}
    checked = checked_cls([first_of[s] for s in e["trio"]], e["chain"], e["swaps"], e["context"],
                          e["levels"], measures)
    return (line, checked), None



def render(lang: str) -> None:
    """`bank/<lang>.md`, the bank to read — SPOILERS: every word of every line. The lines kept,
    by kind (`llm.KINDS`, 1 to 7), then those with no kind, each with its main word marked and
    the path to it (flagged when the trio it was banked with does not hide it), the sibling
    warning, its hidden words, how each plays and the start words it would open with; then
    the lines set aside, each with why; then the lines not read yet (`curate --rebank`)."""
    with locked(lang):
        held = [e for e in load(lang) if not e.get("empty")]
        older = len(stale(lang))
    kept = [e for e in held if e.get("read") and not e.get("dropped")]
    dropped = [e for e in held if e.get("dropped")]
    unread = [e for e in held if not e.get("read") and not e.get("dropped")]
    out = [f"# The {lang} bank — SPOILERS", "",
           f"{len(kept)} line(s) kept, {len(dropped)} set aside, {len(unread)} not read yet, from "
           f"{len({e['work'] for e in held})} work(s). Finish one into a candidate day: "
           f"`pnpm curate --lang {lang} --finish <id>` (the ranking runs then).", ""]
    if older:
        out += [f"{older} line(s) were never read, or were read under another taste: "
                f"`pnpm curate --lang {lang} --rebank` reads them again.", ""]
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
            out.append(f"- `{e['id']}` « {e.get('marked') or e['sentence']} » — {_source(e)}: {e['dropped']}"
                       + (f" (main word « {anchor} »)" if anchor else ""))
        out.append("")
    if unread:
        out += ["## Not read yet", ""]
        for e in unread:
            out += [f"- `{e['id']}` « {e['marked']} » — {_source(e)}", *_holes(e, None)]
        out.append("")
    view_file(lang).write_text("\n".join(out), encoding="utf-8")


def _source(e: dict) -> str:
    return f"{e['author']}, *{e['title']}* ({e['kind']})"


def _holes(e: dict, anchor: str | None) -> list[str]:
    """A banked line as the player first sees it, then its hidden words (the main word in
    bold), how each plays and its start."""
    words = []
    for h in e["holes"]:
        secret = f"**{h['secret']}**" if h["slug"] == anchor else h["secret"]
        words.append(f"{secret} ← {h['start']} (free-map rank {h['startRank']}): {h['level']}")
    return [f"  - opens as: « {e['shown']} »", "  - " + "; ".join(words)]


def _kept(e: dict) -> list[str]:
    r = e["read"]
    anchor = slug(r["anchor"])
    rows = [f"- `{e['id']}` « {e['marked']} » — {_source(e)}",
            f"  - main word « {r['anchor']} »: {r['path']}"
            + (f" (through {', '.join(f'« {w} »' for w in r['pathWords'])})" if r["pathWords"] else "")]
    if anchor not in e["trio"]:
        rows.append("  - FLAG: the trio it was banked with does not hide its main word")
    if r["wide"]:
        rows.append("  - one of a wide kind: " + " › ".join((r["ladder"] or {}).get(step) or "—"
                                                             for step in llm.LADDER))
    if r["sibling"]:
        rows.append(f"  - sibling: « {r['sibling']} » makes the same joke (a warning)")
    return rows + _holes(e, anchor)
