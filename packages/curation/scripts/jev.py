"""The one question the curator asks TypeSafe's hosted Jev model, calibrated on real play:
the SENTENCE filter (`score_sentences`, `sentence_passes`: what the model should not have to
read). How hard a hidden word plays is the difficulty forecast's (`difficulty.py`). Jev
orders no map: a sentence puzzle ranks by the plain static order, the words of another
sense removed or pushed farther (generation `AGENTS.md`).

ONE TEMPLATE PER LANGUAGE (#317): every question and the state keys it reads live in one
`Language`, written in the line's own language. French is the calibrated original (its
requests are byte-identical to the ones the thresholds below were measured on); English
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


class JevError(Exception):
    """A judge that cannot answer: no key, a refused request, a language it has no
    template for. Never caught into a guess — the caller dies."""


@dataclass(frozen=True)
class Language:
    """Every question the judge is asked, in ONE language (#317).

    The instructions name the shared-state key (`phrases`), so the key names travel with
    the texts: `keys` maps each role to the name THIS language's
    texts use. French is the calibrated original — byte-identical to the requests every
    threshold was measured on — and English its twin."""
    code: str
    keys: dict
    sentence_questions: dict  # {autonome, image, celebre}: (question, true, false)
    sentence_prefix: str      # .format(i=, q=)


FRENCH = Language(
    code="fr",
    keys={"sentences": "phrases"},
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
)

ENGLISH = Language(
    code="en",
    keys={"sentences": "sentences"},
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
            raise JevError("JEV_API_KEY is missing: the sentence filter asks "
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


def read_api_key(env):
    """The judge's key from the environment (never a flag, never logged)."""
    key = env.get("JEV_API_KEY", "").strip()
    if not key:
        raise JevError("JEV_API_KEY is not set in the environment: the sentence filter asks "
                       "TypeSafe's Jev judge.")
    return key
