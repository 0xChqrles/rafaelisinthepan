"""Contextual reranking of a hole's static candidates with a hosted judge (#308).

The static embedding retrieves a hole's TOP_K word groups (gen_phrase's walk); this
module orders THEM by the sense the sentence gives the secret, with TypeSafe's Jev
model as the judge, in two passes:

  pass 1  one independent Score per candidate — the shared state carries the
          sentence, the secret, the excerpt around the line and the rubric; each
          question names one candidate lemma and rates its proximity of SENSE to
          the secret AS USED in the sentence, on the rubric's levels (0..4). Grammar,
          agreement and the ability to replace the secret in the sentence are
          explicitly excluded (the cloze guard), and so is a candidate's presence
          in the sentence (the leak guard). The result is a coarse global order.
  pass 2  a round-robin of pairwise Choice questions over the PAIRWISE_TOP best of
          pass 1: every pair is judged once (orientation drawn from a seeded RNG,
          so position bias averages out), and a word's score is its mean win
          probability. That order replaces pass 1's front; the win rates are mapped
          affinely onto the pass-1 score span they replace, so the merged series
          stays non-increasing and quantizes to `dq` like any similarity.

Then one more question, on the front only: is this label a word of the puzzle's
LANGUAGE (`Language.word_question`; below LANGUAGE_MIN it is scored 0). The rubric's
"not French → lowest level" line was ignored inside the scoring, and a frequency rule
(French rank vs English rank, 2026-09-19) threw out «apparent», «suspect», «laid»,
«partial» — French words common in English, which sit at the same French rank as
«feeling». Asked on its own the question separates them (2026-09-22: «apparent» 0.88,
«laid» 0.85 vs «retirement» 0.11, «feeling» 0.11, «desk» 0.16). Ties are broken by
static position, then never by dict order.

ONE TEMPLATE PER LANGUAGE (#317): every question the judge is asked — the rubric, the
pairwise question, the three filters, the sentence and giveaway questions, the
"word of the language" check — and the state keys it reads live in one `Language`,
written in the puzzle's own language. French is the calibrated original (its requests
are byte-identical to the ones every threshold below was measured on); English is its
twin and carries the same thresholds until English play exists to re-tune them.

Contract kept: the map's groups are the static walk's; only their ORDER and their
similarities change; gen_phrase re-assembles keys closest-first in the new order.
No blend of static and contextual scores exists here — static similarity only picks
the candidates and breaks exact ties.

The same judge also runs three PRE-FILTERS for the curator (recall-checked on every
published day, 2026-09-20 — a filter only ever REMOVES, the curator still chooses):
a START candidate must read as correct language shown in the sentence
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
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"

PAIRWISE_TOP = 200          # pass 2 sorts this many of pass 1's best
SCORE_BATCH = 50            # candidates per pass-1 request (one shared state)
PAIR_BATCH = 40             # pairs per pass-2 request
WORKERS = 6                 # concurrent requests
LANGUAGE_MIN = 0.2          # P(word of the language) below which a front label is demoted (English
                            # loanwords a French map should not crown: all true English <= 0.16 and
                            # every French word >= 0.21 on the 2026-09-22 sample, «partial» 0.31,
                            # «affect» 0.38, «nervi» 0.25 kept; carried over to English, #317)
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
GIVEAWAY_MAX = 0.45         # a hole the sentence hands over (mean of the giveaway questions). Calibrated
                            # 2026-09-22 on 84 published holes labelled by REAL play (share of players
                            # typing the secret within 3 guesses; "too easy" = >= 35 %, 20 holes):
                            # AUC 0.73; at 0.45 it strikes 19 holes, 11 truly easy, 8 good ones lost
                            # of 64 (0.5: 8 easy / 6 lost; 0.4: 11 / 13) — in curation a lost good
                            # hole is cheap, a given-away day is not. It catches about HALF the easy
                            # holes: the rest are not predicted by these questions

class ContextualError(Exception):
    """A judge that cannot answer: no key, a refused request, a replay without the
    needed score. NEVER caught into a static fallback — the caller dies."""


@dataclass(frozen=True)
class Language:
    """Everything the judge is asked, in ONE language (#317).

    The instructions name the shared-state keys (`phrase`, `candidats[i]`, …), so the
    key names travel with the texts: `keys` maps each role to the name THIS language's
    texts use. French is the calibrated original — byte-identical to the requests every
    threshold was measured on — and English its twin. `verdict_key` names the sidecar
    field holding the word-of-the-language verdicts (French sidecars keep `french`, so
    every published day still replays); `name` is the language as the curator-facing
    report (French prose) names it."""
    code: str
    name: str
    rubric: int
    keys: dict
    score_instructions: str
    score_levels: tuple
    score_question: str       # .format(i=, w=): one pass-1 question per candidate
    pair_instructions: str
    pair_question: str
    quoted: str               # .format(w): a word as a criterion shows it
    start_fit: tuple          # (question, true, false)
    start_fit_prefix: str     # .format(i=, q=)
    hole_readable: tuple
    hole_prefix: str          # .format(i=, w=, q=)
    same_concept: tuple       # question .format(a=, b=)
    sentence_questions: dict  # {autonome, image, celebre}: (question, true, false)
    sentence_prefix: str      # .format(i=, q=)
    giveaway_questions: dict  # {exact, syn, colloc}: (question, true, false)
    word_question: tuple      # question .format(i=, w=)
    verdict_key: str


FRENCH = Language(
    code="fr",
    name="français",
    rubric=2,
    keys={"sentence": "phrase", "secret": "secret", "lexeme": "lexeme_secret",
          "before": "avant", "after": "apres", "candidates": "candidats",
          "rubric": "consigne", "variants": "variantes", "words": "mots",
          "sentences": "phrases", "blanked": "phrase_a_trou", "word": "mot"},
    score_instructions=(
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
        "le plus bas."),
    score_levels=(
        "Aucun rapport de sens avec le mot secret tel qu'employé dans la phrase",
        "Rapport lointain : même domaine très général, ou association vague",
        "Lié : même champ lexical, idée voisine, ou souvent associé au mot secret dans ce sens",
        "Très proche : quasi-synonyme, ou la même notion à une nuance près",
        "Même sens : synonyme direct du mot secret dans ce contexte",
    ),
    score_question="Applique `consigne` au candidat `candidats[{i}]` (« {w} »).",
    pair_instructions=(
        "Dans la phrase `phrase`, le mot secret `secret` (lexème `lexeme_secret`) est employé "
        "dans un sens précis. Lequel des deux candidats est le plus proche par le SENS du mot "
        "secret tel qu'il est employé dans la phrase ? Ne tiens aucun compte de la grammaire "
        "(genre, nombre, conjugaison, catégorie) ni de la possibilité de remplacer le secret "
        "dans la phrase ; une ressemblance d'orthographe sans lien de sens ne compte pas. "
        "Seul le sens compte."),
    pair_question="Applique `consigne` à cette paire.",
    quoted="« {} »",
    start_fit=(
        "Avec ce mot affiché à cette place, la phrase est-elle du français correct et naturel "
        "(accord, catégorie grammaticale) ?",
        "Elle se lit comme une vraie phrase, même si le sens est étrange",
        "Faute d'accord, mauvaise catégorie, ou illisible"),
    start_fit_prefix="Pour la phrase `variantes[{i}]` : {q}",
    hole_readable=(
        "Avec ce mot retiré (le blanc), la phrase reste-t-elle une phrase française correcte, "
        "lisible, dont on devine la structure ?",
        "Elle se lit naturellement avec un blanc à cet endroit",
        "Le blanc rend la phrase incompréhensible ou agrammaticale"),
    hole_prefix="Pour `variantes[{i}]` (mot retiré : « {w} ») : {q}",
    same_concept=(
        "Dans cette phrase, « {a} » et « {b} » désignent-ils le même concept, ou sont-ils "
        "synonymes l'un de l'autre ?",
        "Même notion, ou synonymes", "Deux idées distinctes"),
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
    word_question=(
        "Le mot `mots[{i}]` (« {w} ») est-il un mot de la langue française, courant ou "
        "littéraire, qu'un dictionnaire français ordinaire enregistre comme mot français ?",
        "Oui, c'est un mot français (emprunts installés compris)",
        "Non, c'est un mot anglais ou d'une autre langue, ou un nom propre, une marque, un sigle"),
    verdict_key="french",
)

ENGLISH = Language(
    code="en",
    name="anglais",
    rubric=1,
    keys={"sentence": "sentence", "secret": "secret", "lexeme": "secret_lexeme",
          "before": "before", "after": "after", "candidates": "candidates",
          "rubric": "rubric", "variants": "variants", "words": "words",
          "sentences": "sentences", "blanked": "blanked_sentence", "word": "word"},
    score_instructions=(
        "In the sentence `sentence`, the secret word `secret` (lexeme `secret_lexeme`) is "
        "used in a precise sense. Judge how close in MEANING the given candidate is to the "
        "secret word AS IT IS USED in the sentence. Take no account of grammar: number, "
        "tense, verb form, part of speech, or whether the candidate could replace the "
        "secret in the sentence. A resemblance in spelling with no link in meaning does not "
        "count. Only meaning counts. The sense to keep is the one, possibly ironic or "
        "paradoxical, that the sentence (and the context `before` / `after` when given) "
        "gives the secret word. A candidate that appears in the sentence, or that describes "
        "what the sentence DOES to the secret word (for example smothering it, hiding it, "
        "losing it), is not closer for that: judge only the kinship of meaning between the "
        "two words. A candidate that is not an English word (French, Italian, Latin...) is "
        "at the lowest level."),
    score_levels=(
        "No link in meaning with the secret word as it is used in the sentence",
        "Distant link: the same very general domain, or a vague association",
        "Related: the same lexical field, a neighbouring idea, or often associated with "
        "the secret word in this sense",
        "Very close: a near-synonym, or the same notion but for a nuance",
        "Same meaning: a direct synonym of the secret word in this context",
    ),
    score_question="Apply `rubric` to the candidate `candidates[{i}]` (“{w}”).",
    pair_instructions=(
        "In the sentence `sentence`, the secret word `secret` (lexeme `secret_lexeme`) is "
        "used in a precise sense. Which of the two candidates is closer in MEANING to the "
        "secret word as it is used in the sentence? Take no account of grammar (number, "
        "tense, verb form, part of speech) or of whether either could replace the secret in "
        "the sentence; a resemblance in spelling with no link in meaning does not count. "
        "Only meaning counts."),
    pair_question="Apply `rubric` to this pair.",
    quoted="“{}”",
    start_fit=(
        "With this word shown in this place, is the sentence correct, natural English "
        "(agreement, article, part of speech)?",
        "It reads as a real sentence, even if the meaning is strange",
        "An agreement error, the wrong part of speech, or unreadable"),
    start_fit_prefix="For the sentence `variants[{i}]`: {q}",
    hole_readable=(
        "With this word removed (the blank), is the sentence still a correct, readable "
        "English sentence whose structure one can make out?",
        "It reads naturally with a blank in this place",
        "The blank makes the sentence incomprehensible or ungrammatical"),
    hole_prefix="For `variants[{i}]` (word removed: “{w}”): {q}",
    same_concept=(
        "In this sentence, do “{a}” and “{b}” name the same concept, or are they synonyms "
        "of each other?",
        "The same notion, or synonyms", "Two distinct ideas"),
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
    word_question=(
        "Is the word `words[{i}]` (“{w}”) a word of the English language, common or literary, "
        "that an ordinary English dictionary records as an English word?",
        "Yes, it is an English word (established loanwords included)",
        "No, it is a French word or a word of another language, or a proper name, a brand, "
        "an acronym"),
    verdict_key="english",
)

LANGUAGES = {language.code: language for language in (FRENCH, ENGLISH)}


def language(code):
    """The judge's template for a puzzle language; any other is a hard error."""
    try:
        return LANGUAGES[code]
    except KeyError:
        raise ContextualError(f"aucun juge pour la langue « {code} » "
                              f"(langues : {', '.join(LANGUAGES)}).") from None


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
    score: float        # pass-1 score (0..len(score_levels)-1)
    win_rate: float | None = None  # pass-2 mean win probability, front only
    demoted: bool = False


@dataclass
class Context:
    """What every question of one hole shares. `lang` picks the judge's template
    (required: a French rubric asked about an English line would still answer)."""
    sentence: str
    secret: str
    secret_label: str
    before: tuple = ()
    after: tuple = ()
    lang: str = field(kw_only=True)

    @property
    def language(self):
        return language(self.lang)

    def state(self, **extra):
        k = self.language.keys
        state = {k["sentence"]: self.sentence, k["secret"]: self.secret,
                 k["lexeme"]: self.secret_label}
        if self.before or self.after:
            state[k["before"]], state[k["after"]] = list(self.before), list(self.after)
        state.update({k[role]: value for role, value in extra.items()})
        return state


# --- the judge -------------------------------------------------------------------
class JevJudge:
    """The hosted judge: TypeSafe's System One HTTP API, one shared state per request.

    `score(context, candidates)` -> one float per candidate (the judge reads
    `.label`); `compare(context, pairs)` over (Candidate, Candidate) -> the
    probability that the first of each pair is the closer one. Both retry 429 /
    529 / 5xx-gateway / transport errors with capped backoff; any other refusal is a ContextualError.
    Usage is accumulated in `usage` (input/output tokens) for the report."""

    def __init__(self, api_key, model=JEV_MODEL, workers=WORKERS):
        if not api_key:
            raise ContextualError("JEV_API_KEY manquante : le classement contextuel "
                                  "appelle un juge hébergé et ne se rabat jamais sur "
                                  "le classement statique.")
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
                raise ContextualError(f"juge HTTP {exc.code} : {exc.read()[:300]!r}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt < tries - 1:
                    time.sleep(min(30, 2 ** attempt))
                    continue
                raise ContextualError(f"juge injoignable : {exc}") from exc
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

    def score(self, context, candidates):
        L = context.language

        def work(batch):
            batch = [c.label for c in batch]
            state = context.state(candidates=list(batch), rubric=L.score_instructions)
            questions = {
                f"c{i}": {"type": "score",
                          "instructions": L.score_question.format(i=i, w=w),
                          "criteria": list(L.score_levels)}
                for i, w in enumerate(batch)}
            answers = self._call(state, questions)
            return [float(answers[f"c{i}"]["score"]) for i in range(len(batch))]
        return self._batched(list(candidates), SCORE_BATCH, work)

    def compare(self, context, pairs):
        L = context.language

        def work(batch):
            batch = [(a.label, b.label) for a, b in batch]
            state = context.state(rubric=L.pair_instructions)
            questions = {
                f"p{i}": {"type": "choice", "instructions": L.pair_question,
                          "criteria": {"A": L.quoted.format(a), "B": L.quoted.format(b)}}
                for i, (a, b) in enumerate(batch)}
            answers = self._call(state, questions)
            return [float(answers[f"p{i}"]["probabilities"]["A"]) for i in range(len(batch))]
        return self._batched(list(pairs), PAIR_BATCH, work)

    def in_language(self, candidates, lang):
        """P(a word of the language) per candidate label, one batched yes/no question
        each."""
        L = language(lang)
        labels = [c.label for c in candidates]
        q, yes, no = L.word_question
        probs = self.noul({L.keys["words"]: labels},
                          {f"m{i}": (q.format(i=i, w=w), yes, no)
                           for i, w in enumerate(labels)})
        return [probs[f"m{i}"] for i in range(len(labels))]

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
        hole = self._hole(context)
        scores = hole["scores"]
        self._current = hole
        try:
            return [float(scores[c.key]) for c in candidates]
        except KeyError as exc:
            raise ContextualError(f"rejeu : le groupe {exc.args[0]} n'a pas de score "
                                  f"pour « {context.secret} »") from exc

    def in_language(self, candidates, lang):
        L = language(lang)
        probs = self._current.get(L.verdict_key, {})
        try:
            return [float(probs[c.key]) for c in candidates]
        except KeyError as exc:
            raise ContextualError(f"rejeu : le groupe {exc.args[0]} n'a pas de verdict "
                                  f"« mot {L.name} »") from exc

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


def rerank(context, candidates, judge, *, pairwise_top=PAIRWISE_TOP, seed=0):
    """Order `candidates` by contextual similarity to the secret.

    Returns (ranked, record): `ranked` best-first with a non-increasing `similarity`
    (pass-2 front mapped onto pass-1's span, demoted groups at 0), `record` the
    sidecar entry (scores, judged pairs, demotions, timings) this order derives from.
    Every candidate comes back; nothing is cut here (TOP_K is the walk's).
    The front is then asked the language's word question; a group whose label scores
    under LANGUAGE_MIN is demoted."""
    verdict_key = context.language.verdict_key
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
    # Demotion is a verdict on ONE group: tracked by index, since two groups can
    # share a lemma string and only one of them fall under the threshold.
    demoted, verdicts = set(), {}
    if front:
        probs = judge.in_language([candidates[i] for i in front], context.lang)
        for i, p in zip(front, probs):
            verdicts[candidates[i].key] = p
            if p < LANGUAGE_MIN:
                sim[i] = 0.0
                demoted.add(i)
    # A flat pass-1 span collapses distinct win rates onto one similarity.
    # Preserve the pairwise verdict there (and ahead of tied tail candidates);
    # only equal verdicts fall back to static position. Demotions still tie at 0.
    final = sorted(front + order[n_front:],
                   key=lambda i: (-sim[i],
                                  -win.get(i, -1.0) if i not in demoted else 1.0,
                                  candidates[i].static_pos))
    ranked = [Ranked(candidates[i].key, labels[i], sim[i], candidates[i].static_pos,
                     scores[i], win.get(i), i in demoted) for i in final]
    record = {
        "secret": context.secret, "secret_label": context.secret_label,
        "scores": {candidates[i].key: scores[i] for i in range(len(labels))},
        "pairs": judged, verdict_key: verdicts,
        "demoted": [labels[i] for i in front if i in demoted],
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


def filter_start_band(judge, words, occurrences, band, *, lang):
    """`band` = [(word, rank)] -> (kept, removed) where removed = [(word, rank, p)]:
    a start that does not read as the language, shown in the sentence, is dropped."""
    if not band:
        return [], []
    L = language(lang)
    variants = [shown_sentence(words, occurrences, w) for w, _r in band]
    state = {L.keys["variants"]: variants}
    q, yes, no = L.start_fit
    probs = judge.noul(state, {f"v{i}": (L.start_fit_prefix.format(i=i, q=q), yes, no)
                               for i in range(len(band))})
    kept, removed = [], []
    for i, (w, r) in enumerate(band):
        p = probs[f"v{i}"]
        if p >= START_FIT_MIN:
            kept.append((w, r))
        else:
            removed.append((w, r, p))
    return kept, removed


def filter_hole_candidates(judge, words, cands, *, lang):
    """`cands` = [{pos, secret, prefix, suffix}] -> (kept, removed) where removed =
    [(secret, p)]: a word whose blanking leaves the sentence unreadable is not
    offered as a hole."""
    if not cands:
        return [], []
    L = language(lang)
    sentence = " ".join(words)
    variants = [shown_sentence(words, [(c["pos"], c["prefix"], c["suffix"])], "_____")
                for c in cands]
    state = {L.keys["sentence"]: sentence, L.keys["variants"]: variants}
    q, yes, no = L.hole_readable
    probs = judge.noul(state, {f"v{i}": (L.hole_prefix.format(i=i, w=c["secret"], q=q), yes, no)
                               for i, c in enumerate(cands)})
    kept, removed = [], []
    for i, c in enumerate(cands):
        if probs[f"v{i}"] >= HOLE_READABLE_MIN:
            kept.append(c)
        else:
            removed.append((c["secret"], probs[f"v{i}"]))
    return kept, removed


def same_concept(judge, sentence, pairs, *, lang):
    """{(a, b): P(same concept)} for word pairs of one sentence."""
    if not pairs:
        return {}
    L = language(lang)
    q, yes, no = L.same_concept
    probs = judge.noul({L.keys["sentence"]: sentence},
                       {f"p{i}": (q.format(a=a, b=b), yes, no) for i, (a, b) in enumerate(pairs)})
    return {pair: probs[f"p{i}"] for i, pair in enumerate(pairs)}


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


def format_report(secret, ranked, record, *, model, lang):
    """The per-hole report gen_phrase prints: what the judge changed, at a glance.
    The front is the pass-2 window; "deep" counts its members the static walk had
    past rank 1000 — how much the judge disagrees with the embedding up close."""
    n = len(ranked)
    head = ranked[:min(PAIRWISE_TOP, n)]
    deep = sum(1 for r in head if r.static_pos >= 1000)
    furthest = max((r.static_pos + 1 for r in head), default=0)
    lines = [f"\nClassement contextuel : {secret}  (lexème « {record['secret_label']} »)",
             f"  juge {model}  rubrique v{language(lang).rubric}  candidats {n}  "
             f"score {record['timing']['score_s']}s  paires {record['timing']['pairs_s']}s",
             f"  dans les {len(head)} premiers : {deep} venu(s) d'au-delà du 1000e rang "
             f"statique, le plus lointain du {furthest}e",
             f"  rétrogradés (pas un mot {language(lang).name}) : {len(record['demoted'])}"
             + (f" — {', '.join(record['demoted'][:8])}" if record["demoted"] else ""),
             f"  {'ctx':>5} {'stat':>6} {'score':>5}  mot"]
    for i, r in enumerate(ranked[:25], 1):
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


def write_sidecar(path, *, lang, model, sentence, before, after, records, usage,
                  replayed_from=None):
    data = {"model": model, "rubric": language(lang).rubric, "sentence": sentence,
            "before": list(before), "after": list(after),
            "usage": usage, "holes": records}
    if replayed_from:
        data["replayed_from"] = replayed_from
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return path


if __name__ == "__main__":
    sys.exit("contextual_rank.py est un module de gen_phrase, pas une commande.")
