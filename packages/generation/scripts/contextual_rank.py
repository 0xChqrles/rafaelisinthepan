"""Contextual reranking of a hole's static candidates with a hosted judge (#308).

The static embedding retrieves a hole's TOP_K word groups (gen_phrase's walk); this
module orders THEM by the sense the sentence gives the secret, with TypeSafe's Jev
model as the judge, in two passes:

  pass 1  one independent Score per candidate — the shared state carries the
          sentence, the secret, the excerpt around the line and the rubric; each
          question names one candidate lemma and rates its proximity of SENSE to
          the secret AS USED in the sentence, on SCORE_LEVELS (0..4). Grammar,
          agreement and the ability to replace the secret in the sentence are
          explicitly excluded (the cloze guard), and so is a candidate's presence
          in the sentence (the leak guard). The result is a coarse global order.
  pass 2  a round-robin of pairwise Choice questions over the PAIRWISE_TOP best of
          pass 1: every pair is judged once (orientation drawn from a seeded RNG,
          so position bias averages out), and a word's score is its mean win
          probability. That order replaces pass 1's front; the win rates are mapped
          affinely onto the pass-1 score span they replace, so the merged series
          stays non-increasing and quantizes to `dq` like any similarity.

Then a code rule: an ENGLISH-DOMINANT label (its French corpus rank more than
EN_DOMINANCE_RATIO times its English rank, past EN_DOMINANCE_FLOOR) is scored 0 —
the rubric alone did not keep «retirement» or «feeling» off the top. Ties are broken
by static position, then never by dict order.

Contract kept: the map's groups are the static walk's; only their ORDER and their
similarities change; gen_phrase re-assembles keys closest-first in the new order.
No blend of static and contextual scores exists here — static similarity only picks
the candidates and breaks exact ties.

Stdlib only (json/urllib/threads) so the contract tests run with a fake judge and
no network. The hosted judge is the ONE decided exception to offline generation
(user-decided 2026-09-19): a puzzle records the scores it was built from in a
sidecar, and `ReplayJudge` rebuilds the same map from it without a call.
"""

import json
import random
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
RUBRIC_VERSION = 2

PAIRWISE_TOP = 200          # pass 2 sorts this many of pass 1's best
SCORE_BATCH = 50            # candidates per pass-1 request (one shared state)
PAIR_BATCH = 40             # pairs per pass-2 request
WORKERS = 6                 # concurrent requests
EN_DOMINANCE_RATIO = 3      # a label whose fr rank > ratio x en rank ...
EN_DOMINANCE_FLOOR = 8000   # ... and past this fr rank is demoted

SCORE_INSTRUCTIONS = (
    "Dans la phrase `phrase`, le mot secret `secret` (lexème `lexeme_secret`) est employé "
    "dans un sens précis. Juge la proximité de SENS entre le candidat indiqué et le mot "
    "secret TEL QU'IL EST EMPLOYÉ dans la phrase. Ne tiens aucun compte de la grammaire : "
    "genre, nombre, conjugaison, catégorie grammaticale, ou le fait que le candidat puisse "
    "ou non remplacer le secret dans la phrase. Une ressemblance d'orthographe sans lien de "
    "sens ne compte pas. Seul le sens compte. Le sens à retenir est celui, éventuellement "
    "ironique ou paradoxal, que la phrase (et le contexte `avant` / `apres` s'il est donné) "
    "donne au mot secret. Un candidat qui figure dans la phrase, ou qui décrit ce que la "
    "phrase FAIT du mot secret (par exemple l'étouffer, le cacher, le perdre), n'est pas "
    "plus proche pour autant : juge uniquement la parenté de sens entre les deux mots. "
    "Un candidat qui n'est pas un mot français (anglais, italien, latin...) est au niveau "
    "le plus bas."
)
SCORE_LEVELS = [
    "Aucun rapport de sens avec le mot secret tel qu'employé dans la phrase",
    "Rapport lointain : même domaine très général, ou association vague",
    "Lié : même champ lexical, idée voisine, ou souvent associé au mot secret dans ce sens",
    "Très proche : quasi-synonyme, ou la même notion à une nuance près",
    "Même sens : synonyme direct du mot secret dans ce contexte",
]
PAIR_INSTRUCTIONS = (
    "Dans la phrase `phrase`, le mot secret `secret` (lexème `lexeme_secret`) est employé "
    "dans un sens précis. Lequel des deux candidats est le plus proche par le SENS du mot "
    "secret tel qu'il est employé dans la phrase ? Ne tiens aucun compte de la grammaire "
    "(genre, nombre, conjugaison, catégorie) ni de la possibilité de remplacer le secret "
    "dans la phrase ; une ressemblance d'orthographe sans lien de sens ne compte pas. "
    "Seul le sens compte."
)


class ContextualError(Exception):
    """A judge that cannot answer: no key, a refused request, a replay without the
    needed score. NEVER caught into a static fallback — the caller dies."""


@dataclass(frozen=True)
class Candidate:
    """One static group offered to the judge: its opaque key, the lemma the judge
    reads, and its static position (0 = closest), the deterministic tie-break."""
    key: str
    label: str
    static_pos: int


@dataclass(frozen=True)
class Ranked:
    key: str
    label: str
    similarity: float   # the contextual similarity `dq` is quantized from
    static_pos: int
    score: float        # pass-1 score (0..len(SCORE_LEVELS)-1)
    win_rate: float | None = None  # pass-2 mean win probability, front only
    demoted: bool = False


@dataclass
class Context:
    """What every question of one hole shares."""
    sentence: str
    secret: str
    secret_label: str
    before: tuple = ()
    after: tuple = ()

    def state(self, **extra):
        state = {"phrase": self.sentence, "secret": self.secret,
                 "lexeme_secret": self.secret_label}
        if self.before or self.after:
            state["avant"], state["apres"] = list(self.before), list(self.after)
        state.update(extra)
        return state


# --- the judge -------------------------------------------------------------------
class JevJudge:
    """The hosted judge: TypeSafe's System One HTTP API, one shared state per request.

    `score(context, candidates)` -> one float per candidate (the judge reads
    `.label`); `compare(context, pairs)` over (Candidate, Candidate) -> the
    probability that the first of each pair is the closer one. Both retry 429 /
    529 / transport errors with capped backoff; any other refusal is a ContextualError.
    Usage is accumulated in `usage` (input/output tokens) for the report."""

    def __init__(self, api_key, model=JEV_MODEL, workers=WORKERS, timeout=120):
        if not api_key:
            raise ContextualError("JEV_API_KEY manquante : le classement contextuel "
                                  "appelle un juge hébergé et ne se rabat jamais sur "
                                  "le classement statique.")
        self.api_key, self.model, self.workers, self.timeout = api_key, model, workers, timeout
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self.requests = 0

    def _call(self, state, questions, tries=12):
        body = json.dumps({"state": state, "model": self.model, "questions": questions},
                          ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(JEV_URL, data=body, headers={
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"})
        for attempt in range(tries):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    answer = json.load(r)
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 529) and attempt < tries - 1:
                    time.sleep(min(30, 2 ** attempt) + random.random())
                    continue
                raise ContextualError(f"juge HTTP {exc.code} : {exc.read()[:300]!r}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt < tries - 1:
                    time.sleep(min(30, 2 ** attempt))
                    continue
                raise ContextualError(f"juge injoignable : {exc}") from exc
        usage = answer.get("usage", {})
        for k in self.usage:
            self.usage[k] += int(usage.get(k, 0))
        self.requests += 1
        return answer["answers"]

    def _batched(self, items, size, work):
        batches = [items[i:i + size] for i in range(0, len(items), size)]
        out = []
        with ThreadPoolExecutor(self.workers) as ex:
            for part in ex.map(work, batches):
                out.extend(part)
        return out

    def score(self, context, candidates):
        def work(batch):
            batch = [c.label for c in batch]
            state = context.state(candidats=list(batch), consigne=SCORE_INSTRUCTIONS)
            questions = {
                f"c{i}": {"type": "score",
                          "instructions": f"Applique `consigne` au candidat `candidats[{i}]` (« {w} »).",
                          "criteria": SCORE_LEVELS}
                for i, w in enumerate(batch)}
            answers = self._call(state, questions)
            return [float(answers[f"c{i}"]["score"]) for i in range(len(batch))]
        return self._batched(list(candidates), SCORE_BATCH, work)

    def compare(self, context, pairs):
        def work(batch):
            batch = [(a.label, b.label) for a, b in batch]
            state = context.state(consigne=PAIR_INSTRUCTIONS)
            questions = {
                f"p{i}": {"type": "choice", "instructions": "Applique `consigne` à cette paire.",
                          "criteria": {"A": f"« {a} »", "B": f"« {b} »"}}
                for i, (a, b) in enumerate(batch)}
            answers = self._call(state, questions)
            return [float(answers[f"p{i}"]["probabilities"]["A"]) for i in range(len(batch))]
        return self._batched(list(pairs), PAIR_BATCH, work)


class ReplayJudge:
    """Answers from a sidecar written by a previous run (reproducibility): the same
    sentence, secret and candidates give the same map without a network call. The
    sidecar is keyed by GROUP KEY (two groups may share a lemma string); a group or
    pair it never judged is a hard error, never a guess."""

    def __init__(self, sidecar):
        self.sentence = sidecar["sentence"]
        self.before = tuple(sidecar["before"])
        self.after = tuple(sidecar["after"])
        self.holes = {h["secret"]: h for h in sidecar["holes"]}
        self.model = sidecar.get("model", "replay")
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self.requests = 0

    def _hole(self, context):
        if (context.sentence != self.sentence or tuple(context.before) != self.before
                or tuple(context.after) != self.after):
            raise ContextualError("rejeu : la phrase ou son contexte diffère des scores enregistrés")
        try:
            hole = self.holes[context.secret]
        except KeyError:
            raise ContextualError(f"rejeu : aucun score enregistré pour « {context.secret} »")
        if context.secret_label != hole["secret_label"]:
            raise ContextualError(f"rejeu : le lexème de « {context.secret} » diffère "
                                  "des scores enregistrés")
        return hole

    def score(self, context, candidates):
        scores = self._hole(context)["scores"]
        try:
            return [float(scores[c.key]) for c in candidates]
        except KeyError as exc:
            raise ContextualError(f"rejeu : le groupe {exc.args[0]} n'a pas de score "
                                  f"pour « {context.secret} »") from exc

    def compare(self, context, pairs):
        wins = self._hole(context)["pairs"]
        out = []
        for a, b in pairs:
            if f"{a.key}|{b.key}" in wins:
                out.append(float(wins[f"{a.key}|{b.key}"]))
            elif f"{b.key}|{a.key}" in wins:
                out.append(1.0 - float(wins[f"{b.key}|{a.key}"]))
            else:
                raise ContextualError(f"rejeu : la paire {a.key} / {b.key} n'a pas été "
                                      f"jugée pour « {context.secret} »")
        return out


# --- the two passes ---------------------------------------------------------------
def pairwise_order(context, front, judge, seed=0):
    """Round-robin over the Candidates `front`: every pair once, orientation seeded,
    a word's score is its mean win probability. Returns [(index, win_rate)]
    best-first, ties by index (= pass-1 order), and the judged pairs (keyed by
    group key) for the sidecar."""
    rng = random.Random(seed)
    n = len(front)
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs.append((i, j) if rng.random() < 0.5 else (j, i))
    probs = judge.compare(context, [(front[i], front[j]) for i, j in pairs])
    wins, played = [0.0] * n, [0] * n
    judged = {}
    for (i, j), p in zip(pairs, probs):
        wins[i] += p
        wins[j] += 1.0 - p
        played[i] += 1
        played[j] += 1
        judged[f"{front[i].key}|{front[j].key}"] = p
    rate = [wins[i] / played[i] if played[i] else 0.0 for i in range(n)]
    order = sorted(range(n), key=lambda i: (-rate[i], i))
    return [(i, rate[i]) for i in order], judged


def rerank(context, candidates, judge, *, pairwise_top=PAIRWISE_TOP, foreign=None,
           seed=0):
    """Order `candidates` by contextual similarity to the secret.

    Returns (ranked, record): `ranked` best-first with a non-increasing `similarity`
    (pass-2 front mapped onto pass-1's span, demoted labels at 0), `record` the
    sidecar entry (scores, judged pairs, demotions, timings) this order derives from.
    Every candidate comes back; nothing is cut here (TOP_K is the walk's).
    `foreign(label) -> bool` is the English-dominance rule built by the caller from
    the two corpora (None = no demotion)."""
    if not candidates:
        return [], {"secret": context.secret, "scores": {}, "pairs": {}, "demoted": []}
    labels = [c.label for c in candidates]
    t0 = time.time()
    scores = judge.score(context, candidates)
    t1 = time.time()
    # pass 1: score desc, static position asc — never dict order
    order = sorted(range(len(candidates)),
                   key=lambda i: (-scores[i], candidates[i].static_pos))
    n_front = min(pairwise_top, len(order))
    front = order[:n_front]
    judged, win = {}, {}
    if n_front >= 2:
        pair_order, judged = pairwise_order(context, [candidates[i] for i in front], judge, seed)
        hi, lo = scores[front[0]], scores[front[-1]]
        span = hi - lo
        reordered = []
        for k, rate in pair_order:
            i = front[k]
            win[i] = rate
            reordered.append(i)
        front = reordered
        sim = {i: lo + span * win[i] for i in front}
    else:
        sim = {i: scores[i] for i in front}
    t2 = time.time()
    for i in order[n_front:]:
        sim[i] = scores[i]
    demoted = []
    if foreign is not None:
        for i in front + order[n_front:]:
            if foreign(labels[i]):
                sim[i] = 0.0
                demoted.append(labels[i])
    # final order: similarity desc, static position asc
    final = sorted(front + order[n_front:],
                   key=lambda i: (-sim[i], candidates[i].static_pos))
    ranked = [Ranked(candidates[i].key, labels[i], sim[i], candidates[i].static_pos,
                     scores[i], win.get(i), labels[i] in demoted) for i in final]
    record = {
        "secret": context.secret, "secret_label": context.secret_label,
        "scores": {candidates[i].key: scores[i] for i in range(len(labels))},
        "pairs": judged, "demoted": demoted,
        "timing": {"score_s": round(t1 - t0, 1), "pairs_s": round(t2 - t1, 1)},
    }
    return ranked, record


def english_dominance(fr_rank, en_rank, ratio=EN_DOMINANCE_RATIO, floor=EN_DOMINANCE_FLOOR):
    """The demotion rule as a predicate over two frequency orders (word -> rank, 0 =
    most frequent): English-dominant when the word is past `floor` in French and its
    French rank exceeds `ratio` times its English rank. A word absent from either
    corpus is never demoted by this rule."""
    def foreign(label):
        f, e = fr_rank.get(label), en_rank.get(label)
        return f is not None and e is not None and f > floor and e * ratio < f
    return foreign


def format_report(secret, ranked, record, *, model, top=25, front=PAIRWISE_TOP):
    """The per-hole report gen_phrase prints: what the judge changed, at a glance.
    The front is the pass-2 window; "deep" counts its members the static walk had
    past rank 1000 — how much the judge disagrees with the embedding up close."""
    n = len(ranked)
    head = ranked[:min(front, n)]
    deep = sum(1 for r in head if r.static_pos >= 1000)
    furthest = max((r.static_pos + 1 for r in head), default=0)
    lines = [f"\nClassement contextuel : {secret}  (lexème « {record['secret_label']} »)",
             f"  juge {model}  rubrique v{RUBRIC_VERSION}  candidats {n}  "
             f"score {record['timing']['score_s']}s  paires {record['timing']['pairs_s']}s",
             f"  dans les {len(head)} premiers : {deep} venu(s) d'au-delà du 1000e rang "
             f"statique, le plus lointain du {furthest}e",
             f"  rétrogradés (anglais dominant) : {len(record['demoted'])}"
             + (f" — {', '.join(record['demoted'][:8])}" if record["demoted"] else ""),
             f"  {'ctx':>5} {'stat':>6} {'score':>5}  mot"]
    for i, r in enumerate(ranked[:top], 1):
        lines.append(f"  {i:>5} {r.static_pos + 1:>6} {r.score:>5.2f}  {r.label}")
    return "\n".join(lines)


def read_api_key(env):
    """The judge's key from the environment (never a flag, never logged)."""
    key = env.get("JEV_API_KEY", "").strip()
    if not key:
        raise ContextualError("JEV_API_KEY absente de l'environnement (le juge Jev de "
                              "TypeSafe) : exporte-la, ou génère sans --contextual.")
    return key


def load_sidecar(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if "holes" not in data:
        raise ContextualError(f"{path} n'est pas un fichier de scores contextuels.")
    return data


def write_sidecar(path, *, model, sentence, before, after, records, usage, replayed_from=None):
    data = {"model": model, "rubric": RUBRIC_VERSION, "sentence": sentence,
            "before": list(before), "after": list(after),
            "usage": usage, "holes": records}
    if replayed_from:
        data["replayed_from"] = replayed_from
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return path


if __name__ == "__main__":
    sys.exit("contextual_rank.py est un module de gen_phrase (--contextual), pas une commande.")
