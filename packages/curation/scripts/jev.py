"""The two questions the curator asks TypeSafe's hosted Jev model, both calibrated on real
play: the SENTENCE filter (`score_sentences`, `sentence_passes`: what the model should not
have to read) and the GIVEAWAY (`giveaway`: how much a line hands a hidden word over — the
floor under which a word is never hidden, the bar under which a hole plays hard). Jev
orders no map: a sentence puzzle ranks by the plain static order, the words of another
sense removed or pushed farther (generation `AGENTS.md`).

ONE TEMPLATE PER LANGUAGE (#317): every question and the state keys it reads live in one
`Language`, written in the line's own language. French is the calibrated original (its
requests are byte-identical to the ones every threshold below was measured on); English
is its twin and carries the same thresholds until English play exists to re-tune them.

Stdlib only (json/urllib/threads) so the tests run with a fake judge and no network.
"""

import json
import random
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"

WORKERS = 6                 # concurrent requests
NOUL_BATCH = 40             # yes/no questions per request
SENTENCE_ALONE_MIN = 0.35   # a candidate sentence must stand without its page (published
                            # days: min 0.39; clears ~46 % of a novel's candidates)
SENTENCE_IMAGE_MIN = 0.3    # ... and carry an image or a turn (published days: min 0.31)
SENTENCE_FAMOUS_MAX = 0.6   # ... and not be a famous line (published days: max 0.5)
GIVEAWAY_MAX = 0.45         # a hole the sentence hands over (mean of the giveaway questions). Calibrated
                            # 2026-09-22 on 84 published holes labelled by REAL play (share of players
                            # typing the secret within 3 guesses; "too easy" = >= 35 %, 20 holes):
                            # AUC 0.73; at 0.45 it strikes 19 holes, 11 truly easy, 8 good ones lost
                            # of 64 (0.5: 8 easy / 6 lost; 0.4: 11 / 13) — in curation a lost good
                            # hole is cheap, a given-away day is not. It catches about HALF the easy
                            # holes: the rest are not predicted by these questions
GIVEAWAY_MIN = 0.10         # the floor: under it the line gives no path to the word, and the curator
                            # never hides it. On the same 84 holes, the two under it (« facho », 4 % of
                            # the players within 30 tries, and « cygne », both 0.097) played as hard as
                            # any; English « bloated » (0.07) and « rapacity » (0.06) beat a native
                            # speaker; the loved days' holes start at 0.127 (« mammifères »)
GIVEAWAY_HARD = 0.20        # under it a hole plays hard: 7 of the 13 holes under it were found by fewer
                            # than 60 % of their players, against 12 of the 71 above. The curator notes
                            # it to its start step (curation `AGENTS.md`), never a nearer band


class JevError(Exception):
    """A judge that cannot answer: no key, a refused request, a language it has no
    template for. Never caught into a guess — the caller dies."""


@dataclass(frozen=True)
class Language:
    """Every question the judge is asked, in ONE language (#317).

    The instructions name the shared-state keys (`phrases`, `phrase_a_trou`, …), so the
    key names travel with the texts: `keys` maps each role to the name THIS language's
    texts use. French is the calibrated original — byte-identical to the requests every
    threshold was measured on — and English its twin."""
    code: str
    keys: dict
    sentence_questions: dict  # {autonome, image, celebre}: (question, true, false)
    sentence_prefix: str      # .format(i=, q=)
    giveaway_questions: dict  # {exact, syn, colloc}: (question, true, false)


FRENCH = Language(
    code="fr",
    keys={"sentences": "phrases", "blanked": "phrase_a_trou", "word": "mot"},
    sentence_questions={
        "autonome": ("La phrase se comprend-elle seule, sans le texte qui l'entoure ?",
                     "On saisit la scène ou l'idée sans rien d'autre",
                     "Elle dépend d'un antécédent, d'un nom propre ou d'un fait absent"),
        "image": ("La phrase porte-t-elle une image concrète ou un retournement ?",
                  "Une image, une chute ou une tension qu'on a envie de partager",
                  "Plate, abstraite ou purement descriptive"),
        "celebre": ("Est-ce une citation célèbre, largement connue et reprise ?",
                    "Une phrase-culte qu'un lecteur reconnaît", "Une phrase ordinaire de l'œuvre"),
    },
    sentence_prefix="Pour la phrase `phrases[{i}]` : {q}",
    giveaway_questions={
        "exact": ("Un lecteur qui lit `phrase_a_trou` sans aucun autre indice écrirait-il spontanément "
                  "le mot `mot` (ou une de ses formes) dans le blanc ?",
                  "La plupart des lecteurs écriraient ce mot",
                  "Les lecteurs écriraient autre chose, ou hésiteraient entre des mots très différents"),
        "syn": ("Un lecteur qui lit `phrase_a_trou` sans aucun autre indice écrirait-il spontanément "
                "le mot `mot` OU un synonyme direct de ce mot dans le blanc ?",
                "La plupart des lecteurs écriraient ce mot ou un synonyme direct",
                "Les lecteurs écriraient des mots d'un autre sens, ou hésiteraient entre des idées différentes"),
        "colloc": ("Dans `phrase_a_trou`, les mots voisins du blanc forment-ils avec `mot` une expression "
                   "figée ou une association très fréquente qui le rend presque automatique ?",
                   "Oui, l'expression ou l'association appelle ce mot",
                   "Non, beaucoup de mots différents iraient aussi bien"),
    },
)

ENGLISH = Language(
    code="en",
    keys={"sentences": "sentences", "blanked": "blanked_sentence", "word": "word"},
    sentence_questions={
        "autonome": ("Can the sentence be understood on its own, without the text around it?",
                     "One grasps the scene or the idea with nothing else",
                     "It depends on an antecedent, a proper name or a missing fact"),
        "image": ("Does the sentence carry a concrete image or a twist?",
                  "An image, a punchline or a tension one wants to share",
                  "Flat, abstract or purely descriptive"),
        "celebre": ("Is it a famous quotation, widely known and repeated?",
                    "A cult line a reader recognises", "An ordinary sentence of the work"),
    },
    sentence_prefix="For the sentence `sentences[{i}]`: {q}",
    giveaway_questions={
        "exact": ("Would a reader who reads `blanked_sentence` with no other clue spontaneously "
                  "write the word `word` (or one of its forms) in the blank?",
                  "Most readers would write this word",
                  "Readers would write something else, or hesitate between very different words"),
        "syn": ("Would a reader who reads `blanked_sentence` with no other clue spontaneously "
                "write the word `word` OR a direct synonym of it in the blank?",
                "Most readers would write this word or a direct synonym",
                "Readers would write words of another meaning, or hesitate between different ideas"),
        "colloc": ("In `blanked_sentence`, do the words around the blank form with `word` a fixed "
                   "expression or a very frequent association that makes it almost automatic?",
                   "Yes, the expression or the association calls for this word",
                   "No, many different words would fit as well"),
    },
)

LANGUAGES = {language.code: language for language in (FRENCH, ENGLISH)}


def language(code):
    """The judge's template for a line's language; any other is a hard error."""
    try:
        return LANGUAGES[code]
    except KeyError:
        raise JevError(f"no judge for the language « {code} » (languages: {', '.join(LANGUAGES)})") from None


class JevJudge:
    """The hosted judge: TypeSafe's System One HTTP API, one shared state per request.

    `noul(state, questions)` -> P(yes) per question. A request is retried on 429 /
    529 / 5xx-gateway / transport errors with capped backoff; any other refusal is a
    JevError. Usage is accumulated in `usage` (input/output tokens) for the log, and
    `requests` counts the requests answered."""

    def __init__(self, api_key, model=JEV_MODEL, workers=WORKERS):
        if not api_key:
            raise JevError("JEV_API_KEY is missing: the sentence filter and the giveaways ask "
                           "TypeSafe's hosted Jev judge.")
        self.api_key, self.model, self.workers = api_key, model, workers
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self.requests = 0
        self._counting = threading.Lock()  # _call runs on the worker threads

    def _call(self, state, questions, tries=12):
        body = json.dumps({"state": state, "model": self.model, "questions": questions},
                          ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(JEV_URL, data=body, headers={
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"})
        for attempt in range(tries):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    answer = json.load(r)
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 502, 503, 504, 529) and attempt < tries - 1:  # throttled or briefly down
                    time.sleep(min(30, 2 ** attempt) + random.random())
                    continue
                raise JevError(f"judge HTTP {exc.code}: {exc.read()[:300]!r}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt < tries - 1:
                    time.sleep(min(30, 2 ** attempt))
                    continue
                raise JevError(f"judge unreachable: {exc}") from exc
        usage = answer.get("usage", {})
        with self._counting:
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


# The sentence questions are the same three in every language (the keys are the scores'
# names, which `sentence_passes` reads).
SENTENCE_KEYS = ("autonome", "image", "celebre")


def score_sentences(judge, sentences, *, lang, per_request=NOUL_BATCH // len(SENTENCE_KEYS)):
    """[{autonome, image, celebre}] per candidate sentence — the curator's sentence
    pre-filter, a few sentences per request."""
    L = language(lang)
    out = []
    for start in range(0, len(sentences), per_request):
        chunk = sentences[start:start + per_request]
        questions = {f"{k}{i}": (L.sentence_prefix.format(i=i, q=q), yes, no)
                     for i in range(len(chunk))
                     for k, (q, yes, no) in L.sentence_questions.items()}
        probs = judge.noul({L.keys["sentences"]: list(chunk)}, questions)
        out.extend({k: probs[f"{k}{i}"] for k in SENTENCE_KEYS} for i in range(len(chunk)))
    return out


def sentence_passes(scores):
    """The loose sentence filter: what the curator should not have to read."""
    return (scores["autonome"] >= SENTENCE_ALONE_MIN and scores["image"] >= SENTENCE_IMAGE_MIN
            and scores["celebre"] <= SENTENCE_FAMOUS_MAX)


def giveaway(judge, blanked, word, *, lang):
    """How strongly the sentence hands a hole over, 0..1: the mean of three yes/no
    probabilities on the sentence with the word blanked — would a reader write it, would
    they write it or a direct synonym, does a fixed expression call for it. One request
    per word, the state shaped exactly as it was when GIVEAWAY_MAX was calibrated (on
    French play; English carries it over, #317)."""
    L = language(lang)
    questions = L.giveaway_questions
    probs = judge.noul({L.keys["blanked"]: blanked, L.keys["word"]: word}, questions)
    return sum(probs[k] for k in questions) / len(questions)


def read_api_key(env):
    """The judge's key from the environment (never a flag, never logged)."""
    key = env.get("JEV_API_KEY", "").strip()
    if not key:
        raise JevError("JEV_API_KEY is not set in the environment: the sentence filter and the "
                       "giveaways ask TypeSafe's Jev judge.")
    return key
