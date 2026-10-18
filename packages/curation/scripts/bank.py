"""The BANK: finished lines kept for a later day (`pnpm curate --bank`, `--pull`).

A banked line is one the curator finished up to the ranking — mined, through the quotation
test and the judge's sentence filter, shortlisted, its three words chosen and every check
before the ranking passed (`curate.check_trio`) — with what it was measured at, so a pull
compares, ranks and gives start words without asking any of it again. The ranking (the
expensive judge) and everything after it run only for the day pulled.

One JSON line per banked line, `bank/<lang>.jsonl` (gitignored: the lines are the
work's text, and the trio spoils the day). The ledger stays the one record of what was
published: a pull re-reads the archive and skips what it rules out since the line was
banked (the work or the sentence published, a word back in its cooldown).

Several `--bank` processes, and a normal run, may run at once: a work is CLAIMED
(`bank/<lang>.claims`, one `<shelf file>\t<pid>` per line) under the language's lock before
it is mined, so no two processes take the same work; a claim whose process is gone no
longer counts. Every read and write of the bank takes the same lock. A work that banked no
line is kept as a marker entry (`{"work", "empty": true}`), so it is never mined again.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import threading

import _paths
import contextual_rank  # generation/scripts: the giveaway floor
import rules
import shelf as shelf_mod
from parse import parse


def bank_file(lang: str) -> Path:
    return _paths.BANK_DIR / f"{lang}.jsonl"


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
    """The banked lines, markers left out."""
    return [e for e in load(lang) if not e.get("empty")]


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


def entry(book: dict, line: dict, checked) -> dict:
    """A finished line as the bank keeps it: its source, the judge's giveaway for every
    word it can hide, and the checked trio with every measure taken on the line."""
    m = checked.measures
    return {
        "bankedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "work": book["file"], "kind": book["kind"],
        "author": book.get("author", ""), "title": book.get("title", ""),
        "sentence": line["sentence"],
        "given": line["given"],
        "trio": [t.slug for t in checked.trio],
        "chain": checked.chain, "swaps": checked.swaps,
        "context": checked.context, "levels": checked.levels,
        "measures": {"readings": m.readings, "says": m.says, "crowds": m.crowds,
                     "neighbours": m.neighbours, "out": sorted(m.out)},
    }


def restore(e: dict, archive: dict, lang: str, in_vocab, frequency_rank, measures_cls, checked_cls):
    """A banked line as the curator's `day` holds a finished one — (line, checked) — read
    against TODAY's archive; or (None, why) when the archive now rules it out."""
    if shelf_mod.sentence_key(e["sentence"]) in archive["sentences"]:
        return None, "the sentence was published"
    tokens = parse(e["sentence"], lang)
    allowed = rules.initial_candidates(tokens, lang=lang, in_vocab=in_vocab,
                                       past_secrets=archive["secrets"], frequency_rank=frequency_rank)
    given = e["given"]
    # A word unjudged at banking (it was cooling then) is not offered to a swap.
    allowed = [t for t in allowed if t.slug in given and given[t.slug] >= contextual_rank.GIVEAWAY_MIN]
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

