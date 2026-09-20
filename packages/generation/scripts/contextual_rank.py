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

The same judge also runs three PRE-FILTERS for the curator (recall-checked on every
published day, 2026-09-20 — a filter only ever REMOVES, the curator still chooses):
a START candidate must read as correct French shown in the sentence
(`START_FIT_MIN`); a HOLE candidate must leave a readable sentence when blanked
(`HOLE_READABLE_MIN`); two holes must not name one concept (`SAME_CONCEPT_MAX`).
Rejected as a filter: "the context fixes the meaning" — the curator picks words the
context does NOT give away — and a register line, which scored the darkest published
lines lowest.

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
NOUL_BATCH = 40             # yes/no questions per filter request
START_FIT_MIN = 0.5         # a start shown in the sentence must read as French: the band
                            # loses ~20 % here (wrong number/category), 3/157 published picks
                            # sat below (0.34-0.47) and were borderline; 0.4 let «la rutilent» through
HOLE_READABLE_MIN = 0.6     # blanked sentence still readable (published holes: min 0.66)
SAME_CONCEPT_MAX = 0.6      # two holes naming one concept (published pairs: max 0.48)
SENTENCE_ALONE_MIN = 0.35   # a candidate sentence must stand without its page (published
                            # days: min 0.39; clears ~46 % of a novel's candidates)
SENTENCE_IMAGE_MIN = 0.3    # ... and carry an image or a turn (published days: min 0.31)
SENTENCE_FAMOUS_MAX = 0.6   # ... and not be a famous line (published days: max 0.5)

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


START_FIT_QUESTION = (
    "Avec ce mot affiché à cette place, la phrase est-elle du français correct et naturel "
    "(accord, catégorie grammaticale) ?",
    "Elle se lit comme une vraie phrase, même si le sens est étrange",
    "Faute d'accord, mauvaise catégorie, ou illisible")
HOLE_READABLE_QUESTION = (
    "Avec ce mot retiré (le blanc), la phrase reste-t-elle une phrase française correcte, "
    "lisible, dont on devine la structure ?",
    "Elle se lit naturellement avec un blanc à cet endroit",
    "Le blanc rend la phrase incompréhensible ou agrammaticale")
SAME_CONCEPT_QUESTION = (
    "Dans cette phrase, « {a} » et « {b} » désignent-ils le même concept, ou sont-ils "
    "synonymes l'un de l'autre ?",
    "Même notion, ou synonymes", "Deux idées distinctes")


SENTENCE_QUESTIONS = {
    "autonome": ("La phrase se comprend-elle seule, sans le texte qui l'entoure ?",
                 "On saisit la scène ou l'idée sans rien d'autre",
                 "Elle dépend d'un antécédent, d'un nom propre ou d'un fait absent"),
    "image": ("La phrase porte-t-elle une image concrète ou un retournement ?",
              "Une image, une chute ou une tension qu'on a envie de partager",
              "Plate, abstraite ou purement descriptive"),
    "celebre": ("Est-ce une citation célèbre, largement connue et reprise ?",
                "Une phrase-culte qu'un lecteur reconnaît", "Une phrase ordinaire de l'œuvre"),
}


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

    def noul(self, state, questions):
        """Yes/no probabilities: `questions` = {key: (instructions, true, false)} over
        one shared `state`; returns {key: P(yes)}. Batched, keys preserved."""
        keys = list(questions)
        def work(batch):
            qs = {k: {"type": "noul", "instructions": questions[k][0],
                      "criteria": {"true": questions[k][1], "false": questions[k][2]}}
                  for k in batch}
            answers = self._call(state, qs)
            return [(k, float(answers[k]["noul"])) for k in batch]
        return dict(self._batched(keys, NOUL_BATCH, work))


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


# --- the curator's pre-filters ---------------------------------------------------
def shown_sentence(words, occurrences, word):
    """The sentence with `word` displayed at every occurrence (pos, prefix, suffix) —
    what a player sees when it is a hole's start, what a curator reads when it is
    blanked ("_____")."""
    out = list(words)
    for pos, prefix, suffix in occurrences:
        out[pos] = f"{prefix}{word}{suffix}"
    return " ".join(out)


def can_filter(judge):
    """A replay carries no yes/no answers: the filters step aside (the map itself is
    what a replay reproduces; the curator's choices are explicit there)."""
    return hasattr(judge, "noul")


def filter_start_band(judge, words, occurrences, band, threshold=START_FIT_MIN):
    """`band` = [(word, rank)] -> (kept, removed) where removed = [(word, rank, p)]:
    a start that does not read as French shown in the sentence is dropped."""
    if not band:
        return [], []
    variants = [shown_sentence(words, occurrences, w) for w, _r in band]
    state = {"variantes": variants}
    q, yes, no = START_FIT_QUESTION
    probs = judge.noul(state, {f"v{i}": (f"Pour la phrase `variantes[{i}]` : {q}", yes, no)
                               for i in range(len(band))})
    kept, removed = [], []
    for i, (w, r) in enumerate(band):
        p = probs[f"v{i}"]
        if p >= threshold:
            kept.append((w, r))
        else:
            removed.append((w, r, p))
    return kept, removed


def filter_hole_candidates(judge, words, cands, threshold=HOLE_READABLE_MIN):
    """`cands` = [{pos, secret, prefix, suffix}] -> (kept, removed) where removed =
    [(secret, p)]: a word whose blanking leaves the sentence unreadable is not
    offered as a hole."""
    if not cands:
        return [], []
    sentence = " ".join(words)
    variants = [shown_sentence(words, [(c["pos"], c["prefix"], c["suffix"])], "_____")
                for c in cands]
    state = {"phrase": sentence, "variantes": variants}
    q, yes, no = HOLE_READABLE_QUESTION
    probs = judge.noul(state, {f"v{i}": (f"Pour `variantes[{i}]` (mot retiré : « {c['secret']} ») : {q}", yes, no)
                               for i, c in enumerate(cands)})
    kept, removed = [], []
    for i, c in enumerate(cands):
        if probs[f"v{i}"] >= threshold:
            kept.append(c)
        else:
            removed.append((c["secret"], probs[f"v{i}"]))
    return kept, removed


def same_concept(judge, sentence, pairs):
    """{(a, b): P(same concept)} for word pairs of one sentence."""
    if not pairs:
        return {}
    q, yes, no = SAME_CONCEPT_QUESTION
    probs = judge.noul({"phrase": sentence},
                       {f"p{i}": (q.format(a=a, b=b), yes, no) for i, (a, b) in enumerate(pairs)})
    return {pair: probs[f"p{i}"] for i, pair in enumerate(pairs)}


def score_sentences(judge, sentences, per_request=NOUL_BATCH // len(SENTENCE_QUESTIONS)):
    """[{autonome, image, celebre}] per candidate sentence — the curator's sentence
    pre-filter and its shortlist order (`image`), a few sentences per request."""
    out = []
    for start in range(0, len(sentences), per_request):
        chunk = sentences[start:start + per_request]
        questions = {f"{k}{i}": (f"Pour la phrase `phrases[{i}]` : {q}", yes, no)
                     for i in range(len(chunk)) for k, (q, yes, no) in SENTENCE_QUESTIONS.items()}
        probs = judge.noul({"phrases": list(chunk)}, questions)
        out.extend({k: probs[f"{k}{i}"] for k in SENTENCE_QUESTIONS} for i in range(len(chunk)))
    return out


def sentence_passes(scores):
    """The loose sentence filter: what the curator should not have to read."""
    return (scores["autonome"] >= SENTENCE_ALONE_MIN and scores["image"] >= SENTENCE_IMAGE_MIN
            and scores["celebre"] <= SENTENCE_FAMOUS_MAX)


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
                              "TypeSafe) : exporte-la, ou passe --static pour un "
                              "classement statique de référence.")
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
