"""The DIFFICULTY FORECAST (user-decided 2026-10-22): how hard a day will play, in real-play
numbers, before it ships.

ONE mechanism. The model reads each hidden word once — the line, its start, the 15 nearest
words of its map (`llm.difficulty_prompt`) — and estimates its typical tries, never playing it
guess by guess; each word is read SAMPLES times and the answers averaged (`read`). Code turns
those reads into a forecast in real-play units — the typical tries to finish the day, the share
of the players who finish it, each word's chance to be a wall — by fitting them on the days
already played (`calibration`: the PLAY RECORD, `packages/generation/played.jsonl`, and the
reads of those days). Code refuses nothing on it: the forecast is shown to the model comparing
lines (`llm.choose_among`), to the model choosing the words against a main word, on the bank
page, and in the log before a day is published.

Why per word: a day is as hard as its hardest word (on 56 played French days its typical tries
follow its hardest word's at R² 0.92), and reading each word predicted the days better than
reading the whole day at once. Why two reads: one read repeats at about 0.8, the mean of two at
about 0.86. Why a fit on played days: the model's own numbers read easy and drift with the model;
the fit puts them in the players' units, and a refit follows the players.
"""

from dataclasses import dataclass
from datetime import date
import hashlib
import json
import math
import threading

import _paths
import llm

# Each word is read this many times, the answers averaged (in log tries).
SAMPLES = 2
# The map's nearest words the read is shown.
TOP_N = 15
# The fit weighs a played day by its age: half as much every HALF_LIFE_DAYS before the latest.
HALF_LIFE_DAYS = 30
# A fit needs at least this many French days with every word read.
MIN_DAYS = 10
# A WALL: fewer than half the players find the word within 30 tries.
WALL_WITHIN30 = 0.5
# A word chosen against the main word whose chance to be a wall is over this is told back once,
# as a note (`curate.bank_line`): the model keeps it when it is the punch, or chooses again.
# Main words and companions were walls equally often on played days; a companion can be
# chosen again without losing the line.
WALL_NOTE = 0.5
# The caps of the play record's tries (a word not found within 20 counts 20; a day not finished
# within 30 counts 30).
HOLE_CAP, DAY_CAP = 20, 30
# The forecast's range holds 80 % of the played days.
Z80 = 1.2816
# THE AIM (user-decided 2026-10-22): the share of the players who finish the day — the taste's
# own "at least 70%". A day under half is a frustrating one.
TARGET_FINISHED = 0.70
# The latest played days the fit is checked on, unseen (`drift`).
DRIFT_DAYS = 28


def nearest(rank_map: dict, n: int = TOP_N) -> list[tuple[int, str]]:
    """A map's first `n` ranks (rank 0, the word itself, left out), each with the display word of
    the first key the map holds at that rank."""
    by_rank: dict[int, str] = {}
    for entry in rank_map.values():
        by_rank.setdefault(entry["rank"], entry["word"])
    return [(r, by_rank[r]) for r in sorted(by_rank) if r > 0][:n]


def material(puzzle: dict, slug: str) -> dict:
    """One hidden word as the read is shown it, off a puzzle — written, a draft with its starts
    (`curate.static_draft`), or a played day of the play record, whose `nearest` stands for its
    maps: the line as players first see it, each blank showing its start (this word's marked),
    the line with every hidden word in braces (this one marked), the word, its start and the
    start's rank, and its map's nearest words."""
    at = {h["pos"]: h for h in puzzle["holes"]}
    seen, true = [], []
    for i, token in enumerate(puzzle["words"]):
        h = at.get(i)
        if h is None:
            seen.append(token)
            true.append(token)
            continue
        pre, suf = h.get("prefix", ""), h.get("suffix", "")
        if h["secret"]["slug"] == slug:
            seen.append(f"{pre}[>> {h['start']['word']} <<]{suf}")
            true.append(f"{pre}{{>> {h['secret']['word']} <<}}{suf}")
        else:
            seen.append(f"{pre}[{h['start']['word']}]{suf}")
            true.append(f"{pre}{{{h['secret']['word']}}}{suf}")
    first = next(h for h in puzzle["holes"] if h["secret"]["slug"] == slug)
    top = puzzle["nearest"][slug] if "nearest" in puzzle else nearest(puzzle["ranks"][slug])
    return {"secret": first["secret"]["word"], "start": first["start"]["word"], "start_rank": first["start_rank"],
            "seen": " ".join(seen), "true": " ".join(true), "top": [(r, w) for r, w in top]}


def secrets(puzzle: dict) -> list[str]:
    """A puzzle's distinct hidden words, by slug, in the line's order."""
    return list(dict.fromkeys(h["secret"]["slug"] for h in sorted(puzzle["holes"], key=lambda h: h["pos"])))


# ---------------------------------------------------------------------------
# The reads, each answer kept by its question's hash and its sample number.

_lock = threading.Lock()
_answers: dict[tuple[str, int], dict] | None = None


def _cache() -> dict[tuple[str, int], dict]:
    global _answers
    if _answers is None:
        _answers = {}
        if _paths.READS_FILE.exists():
            for row in _paths.READS_FILE.read_text(encoding="utf-8").splitlines():
                if row.strip():
                    r = json.loads(row)
                    _answers[(r["key"], r["sample"])] = r
    return _answers


def _keep(key: str, sample: int, answer: dict) -> None:
    row = {"key": key, "sample": sample, **answer}
    _cache()[(key, sample)] = row
    _paths.READS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(_paths.READS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def key_of(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def read(claude: llm.Claude | None, hole: dict, lang: str) -> float | None:
    """One hidden word's read (`material`): the mean of its SAMPLES answers' log typical tries.
    An answer kept is never asked again; `claude` None asks nothing (the kept answers only). An
    unusable answer is asked once more. None when a sample is still missing."""
    prompt = llm.difficulty_prompt(hole, lang=lang)
    key = key_of(prompt)
    logs = []
    for sample in range(SAMPLES):
        with _lock:
            kept = _cache().get((key, sample))
        if kept is None and claude is not None:
            answer = llm.hole_difficulty(claude, prompt) or llm.hole_difficulty(claude, prompt)
            if answer is not None:
                with _lock:
                    _keep(key, sample, answer)
                kept = answer
        if kept is None:
            return None
        logs.append(math.log(kept["typical_tries"]))
    return sum(logs) / len(logs)


def reads(claude: llm.Claude | None, puzzle: dict, lang: str) -> dict[str, float] | None:
    """Each distinct hidden word's read (`read`), by slug; None when one has none."""
    out = {}
    for s in secrets(puzzle):
        r = read(claude, material(puzzle, s), lang)
        if r is None:
            return None
        out[s] = r
    return out


# ---------------------------------------------------------------------------
# The calibration: the reads of the played days, fitted on how their players did.

@dataclass(frozen=True)
class Fit:
    """y = coef[0] + coef[1]·x1 + …, weighted; `rmse`, the residual spread."""
    coef: tuple[float, ...]
    rmse: float

    def at(self, *x: float) -> float:
        return self.coef[0] + sum(c * v for c, v in zip(self.coef[1:], x))


@dataclass(frozen=True)
class Calibration:
    """The fits of the French days played (`fit`): each word's log tries and its share found
    within 30 tries on its read; the day's log tries to finish and its share finished on its
    hardest and second-hardest reads. `english`: what English words played harder than the
    French fit says, in log tries (None with no English day read) — English is forecast from
    the French fit plus it, and said to be uncalibrated on English players."""
    word_tries: Fit
    word_within: Fit
    day_tries: Fit
    day_finished: Fit
    english: float | None
    days: int
    latest: str


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [v] for row, v in zip(a, b)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[pivot] = m[pivot], m[col]
        if abs(m[col][col]) < 1e-12:
            raise ValueError("a flat fit")
        for r in range(n):
            if r != col:
                k = m[r][col] / m[col][col]
                m[r] = [x - k * y for x, y in zip(m[r], m[col])]
    return [m[i][n] / m[i][i] for i in range(n)]


def wls(xs: list[tuple[float, ...]], ys: list[float], ws: list[float]) -> Fit:
    """Weighted least squares with an intercept; the residual spread corrected for the terms fitted."""
    rows = [(1.0, *x) for x in xs]
    p = len(rows[0])
    a = [[sum(w * r[i] * r[j] for r, w in zip(rows, ws)) for j in range(p)] for i in range(p)]
    b = [sum(w * r[i] * y for r, y, w in zip(rows, ys, ws)) for i in range(p)]
    coef = _solve(a, b)
    res = [y - sum(c * v for c, v in zip(coef, r)) for r, y in zip(rows, ys)]
    n = len(ys)
    spread = sum(w * e * e for w, e in zip(ws, res)) / sum(ws) * n / max(1, n - p)
    return Fit(tuple(coef), math.sqrt(spread))


def played(lang: str | None = None) -> list[dict]:
    """The play record's days (`_paths.PLAY_RECORD`), oldest first; of one language when named."""
    if not _paths.PLAY_RECORD.exists():
        return []
    days = [json.loads(row) for row in _paths.PLAY_RECORD.read_text(encoding="utf-8").splitlines() if row.strip()]
    return sorted((d for d in days if lang in (None, d["lang"])), key=lambda d: (d["day"], d["lang"]))


def _two(rs: list[float]) -> tuple[float, float]:
    """A day's hardest and second-hardest reads."""
    top = sorted(rs, reverse=True)
    return top[0], top[1] if len(top) > 1 else top[0]


def fit(days: list[tuple[dict, dict[str, float]]], english: list[tuple[dict, dict[str, float]]] = ()) -> Calibration | None:
    """The calibration from played French days, each with its words' reads, weighed by age
    (HALF_LIFE_DAYS before the latest); and the English offset from English days with three or
    more players. None with fewer than MIN_DAYS French days."""
    if len(days) < MIN_DAYS:
        return None
    latest = max(date.fromisoformat(d["day"]) for d, _ in days)
    weight = lambda d: 0.5 ** ((latest - date.fromisoformat(d["day"])).days / HALF_LIFE_DAYS)
    words = [(r, d["found"][s], weight(d)) for d, rs in days for s, r in rs.items()]
    word_tries = wls([(r,) for r, _, _ in words], [f["logTries20"] for _, f, _ in words], [w for _, _, w in words])
    word_within = wls([(r,) for r, _, _ in words], [f["within30"] for _, f, _ in words], [w for _, _, w in words])
    xs = [_two(list(rs.values())) for _, rs in days]
    ws = [weight(d) for d, _ in days]
    day_tries = wls(xs, [d["logTries30"] for d, _ in days], ws)
    day_finished = wls(xs, [d["finished"] for d, _ in days], ws)
    off = [d["found"][s]["logTries20"] - word_tries.at(r) for d, rs in english if d["players"] >= 3 for s, r in rs.items()]
    return Calibration(word_tries, word_within, day_tries, day_finished,
                       sum(off) / len(off) if off else None, len(days), latest.isoformat())


def read_played(claude: llm.Claude | None, lang: str) -> tuple[list[tuple[dict, dict[str, float]]], int]:
    """The play record's days of one language with every word read (`reads`), and how many have
    a word unread. `claude` None reads only the kept answers."""
    out, missing = [], 0
    for d in played(lang):
        rs = reads(claude, d, lang)
        if rs is None:
            missing += 1
        else:
            out.append((d, rs))
    return out, missing


def calibration(claude: llm.Claude | None = None) -> Calibration | None:
    """The calibration as the play record and the kept reads now stand (`fit`). With `claude`,
    every played word not yet read under today's question is read first."""
    return fit(read_played(claude, "fr")[0], read_played(claude, "en")[0])


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _below(x: float, mean: float, spread: float) -> float:
    """The chance a normal(mean, spread) lands under x."""
    return 0.5 * (1 + math.erf((x - mean) / (spread * math.sqrt(2)))) if spread > 0 else float(mean < x)


def forecast(cal: Calibration, rs: list[float], lang: str) -> dict:
    """A day's forecast from its words' reads (in the line's order): the typical tries to finish
    (`tries`, its 80 % range `low`–`high`), the share of the players who finish (`finished`,
    `finished_low`–`finished_high`), and for each word its typical tries (capped at 20) and its
    chance to be a WALL (`wall`: fewer than half find it within 30 tries). An English day is
    read harder by the English offset and `calibrated` is False."""
    shift = (cal.english or 0.0) / cal.word_tries.coef[1] if lang != "fr" else 0.0
    rs = [r + shift for r in rs]
    hardest, second = _two(rs)
    top = math.log(DAY_CAP)
    t = cal.day_tries.at(hardest, second)
    f = cal.day_finished.at(hardest, second)
    spread_t, spread_f = Z80 * cal.day_tries.rmse, Z80 * cal.day_finished.rmse
    words = []
    for r in rs:
        within = cal.word_within.at(r)
        words.append({"tries": math.exp(_clip(cal.word_tries.at(r), 0.0, math.log(HOLE_CAP))),
                      "wall": _below(WALL_WITHIN30, within, cal.word_within.rmse)})
    return {"tries": math.exp(_clip(t, 0.0, top)), "low": math.exp(_clip(t - spread_t, 0.0, top)),
            "high": math.exp(_clip(t + spread_t, 0.0, top)),
            "finished": _clip(f, 0.0, 1.0), "finished_low": _clip(f - spread_f, 0.0, 1.0),
            "finished_high": _clip(f + spread_f, 0.0, 1.0), "words": words, "calibrated": lang == "fr"}


def pct(x: float) -> str:
    return f"{round(100 * x)}%"


def aim() -> str:
    """The aim, in the words the model and the user read."""
    return (f"about {pct(TARGET_FINISHED)} of the players finish the day; a day under half finished is a "
            "frustrating one")


def describe(fc: dict, names: list[str]) -> str:
    """A forecast in one plain line, each word under its name (a blind log names them by place)."""
    high = "30+" if fc["high"] >= DAY_CAP - 0.5 else f"{fc['high']:.0f}"
    day = (f"a typical player finishes in about {fc['tries']:.0f} tries ({fc['low']:.0f} to {high}), "
           f"{pct(fc['finished'])} of the players finish ({pct(fc['finished_low'])} to {pct(fc['finished_high'])})")
    words = "; ".join(f"« {n} » about {w['tries']:.0f} tries, {pct(w['wall'])} chance most players never find it"
                      for n, w in zip(names, fc["words"]))
    tail = "" if fc["calibrated"] else " — calibrated on French players, not English ones"
    return f"{day}; {words}{tail}"


def of_puzzle(cal: Calibration, puzzle: dict, rs: dict[str, float], lang: str) -> dict:
    """A puzzle's forecast (`forecast`) from its words' reads by slug (`reads`), in the line's order."""
    return forecast(cal, [rs[s] for s in secrets(puzzle)], lang)


def text(cal: Calibration | None, puzzle: dict, rs: dict[str, float] | None, lang: str, *,
         blind: bool = False) -> str | None:
    """A puzzle's forecast in one plain line (`describe`), each word under its own name — or, in
    a `blind` log, under its place in the line; None with no calibration or no reads."""
    if cal is None or rs is None:
        return None
    order = secrets(puzzle)
    words = {h["secret"]["slug"]: h["secret"]["word"] for h in puzzle["holes"]}
    names = [f"word {n}" for n in range(1, len(order) + 1)] if blind else [words[s] for s in order]
    return describe(of_puzzle(cal, puzzle, rs, lang), names)


def stamp() -> str:
    """The difficulty question's stamp: reads stored under another stamp were asked another
    question, and no forecast is made of them."""
    sample = {"secret": "x", "start": "y", "start_rank": 1, "seen": "s", "true": "t", "top": [(1, "z")]}
    return key_of(llm.difficulty_prompt(sample, lang="fr") + llm.difficulty_prompt(sample, lang="en"))[:8]


def drift(cal_days: list[tuple[dict, dict[str, float]]], english=()) -> dict | None:
    """How the fit does on the latest DRIFT_DAYS of French play it did not see: fitted on the days
    before them, the mean error (`bias`) and spread (`rmse`) of their log tries to finish, the
    mean error of their share finished, over `n` days. None when either side is too thin."""
    if not cal_days:
        return None
    latest = max(date.fromisoformat(d["day"]) for d, _ in cal_days)
    cut = (latest.toordinal() - DRIFT_DAYS)
    old = [(d, rs) for d, rs in cal_days if date.fromisoformat(d["day"]).toordinal() <= cut]
    new = [(d, rs) for d, rs in cal_days if date.fromisoformat(d["day"]).toordinal() > cut]
    cal = fit(old, english)
    if cal is None or not new:
        return None
    errors = [(cal.day_tries.at(*_two(list(rs.values()))) - d["logTries30"],
               cal.day_finished.at(*_two(list(rs.values()))) - d["finished"]) for d, rs in new]
    return {"n": len(new), "bias": sum(e for e, _ in errors) / len(errors),
            "rmse": math.sqrt(sum(e * e for e, _ in errors) / len(errors)),
            "finished_bias": sum(f for _, f in errors) / len(errors)}
