"""Claude on the subscription, one fresh conversation per question.

The transport is the benchmark's (`llm_play._agent_sdk_turn` + its paid-Claude.ai
guard); this module only adds the questions the curator asks and the JSON it expects
back. Every question is stateless: the prompt carries everything the model needs.
"""

import asyncio
import json
import re
import tempfile

import _paths  # noqa: F401
from slug import slug
from llm_play import (
    SUBSCRIPTION_CONFLICT_ENV,
    _agent_sdk_turn,
    _temporary_environment_without,
    validate_anthropic_subscription_auth,
)

MODEL = "claude-opus-5"
EFFORT = "high"

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


class LLMError(RuntimeError):
    pass


def validate() -> str:
    """The subscription guard: refuses to run on anything but a paid Claude.ai login."""
    return validate_anthropic_subscription_auth()


class Claude:
    def __init__(self, model: str = MODEL, effort: str = EFFORT):
        self.model = model
        self.effort = effort
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-curation-")
        self.calls = 0

    def text(self, prompt: str) -> str:
        self.calls += 1
        with _temporary_environment_without(SUBSCRIPTION_CONFLICT_ENV):
            reply, _session, _usage = asyncio.run(
                _agent_sdk_turn(
                    prompt,
                    model_id=self.model,
                    effort=self.effort,
                    cwd=self._workspace.name,
                    resume=None,
                )
            )
        return reply

    def json(self, prompt: str):
        """Ask, expecting a JSON value; one retry with a reminder when the reply is not."""
        prompt = prompt.rstrip() + "\n\nAnswer with the JSON only, no prose around it."
        reply = self.text(prompt)
        try:
            return parse_json(reply)
        except ValueError:
            reply = self.text(prompt + "\nYour previous answer was not valid JSON. JSON only.")
            try:
                return parse_json(reply)
            except ValueError as exc:
                raise LLMError(f"the model did not return JSON: {reply[:200]!r}") from exc


def parse_json(reply: str):
    m = _JSON_FENCE.search(reply)
    body = m.group(1) if m else reply
    starts = [i for i in (body.find("{"), body.find("[")) if i >= 0]
    if not starts:
        raise ValueError("no JSON")
    start = min(starts)
    closer = "}" if body[start] == "{" else "]"
    end = body.rfind(closer)
    if end < start:
        raise ValueError("no JSON")
    return json.loads(body[start:end + 1])


# ---------------------------------------------------------------------------
# The skill file is the ONE source of the editorial line: the prompts quote it.

def skill_section(heading: str) -> str:
    text = _paths.SKILL_FILE.read_text(encoding="utf-8")
    start = text.index(heading)
    nxt = re.search(r"^## ", text[start + len(heading):], re.M)
    end = start + len(heading) + nxt.start() if nxt else len(text)
    return text[start:end].strip()


def taste_profile() -> str:
    return skill_section("## Taste profile")


def secret_rules() -> str:
    return skill_section("## The two laws") + "\n\n" + skill_section("## The trio rules")


def start_rules() -> str:
    return skill_section("## The start word")


# ---------------------------------------------------------------------------
# Questions

def pick_book(claude: Claude, books: list[dict], archive_works: list[dict]) -> dict:
    listing = "\n".join(f"{i}. [{b.get('kind', 'book')}] {b.get('author') or '?'} — {b.get('title') or b['file']}"
                        + (f" ({b['album']})" if b.get('album') else "")
                        + (" — already mined once; prefer an unread work when one fits" if b.get("read") else "")
                        for i, b in enumerate(books))
    used = "\n".join(f"- {w['author']} — {w['work']}" for w in archive_works) or "- (none yet)"
    answer = claude.json(f"""You curate a daily French word game: one sentence from a book or a song, three
words removed, the player rediscovers them. Pick the next work to mine from the shelf
below, following this editorial line:

{taste_profile()}

Works already used in the archive (never the same work twice; vary authors, artists
and eras — music is a minority stream, one or two days a week):
{used}

The shelf (index. [kind] author — title):
{listing}

Return {{"index": <int>, "why": "<one line>"}}.""")
    idx = int(answer["index"])
    if not 0 <= idx < len(books):
        raise LLMError(f"book index out of range: {idx}")
    return {**books[idx], "why": answer.get("why", "")}


def pick_from_chunk(claude: Claude, sentences: list[str], limit: int) -> list[dict]:
    listing = "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
    answer = claude.json(f"""You curate a daily French word game: one sentence, three words removed, the
player rediscovers them from embedding-neighbour feedback. Below are sentences mined
from one book. Choose the at most {limit} that best fit this editorial line — they must
be self-contained (understandable with no context), felt, and DO something (a turn,
an image carrying a thought, a dry joke). Skip anything flat, abstract, or that merely
describes.

{taste_profile()}

Sentences:
{listing}

Return {{"picks": [{{"n": <index>, "why": "<one line>"}}, ...]}}, best first.""")
    picks = answer.get("picks", [])
    out = []
    for p in picks[:limit]:
        n = int(p["n"])
        if 0 <= n < len(sentences):
            out.append({"sentence": sentences[n], "why": p.get("why", "")})
    return out


def rank_sentences(claude: Claude, picks: list[dict], limit: int) -> list[dict]:
    if len(picks) <= limit:
        return picks
    listing = "\n".join(f"{i}. {p['sentence']}  ({p['why']})" for i, p in enumerate(picks))
    answer = claude.json(f"""These sentences were shortlisted from one book for a daily French word game
(three words removed, rediscovered from embedding-neighbour feedback). Rank the best
{limit} for this editorial line — a sentence must be self-contained and DO something:

{taste_profile()}

Shortlist:
{listing}

Return {{"ranked": [<index>, ...]}}, best first, at most {limit} entries.""")
    ranked = []
    for n in answer.get("ranked", [])[:limit]:
        n = int(n)
        if 0 <= n < len(picks) and picks[n] not in ranked:
            ranked.append(picks[n])
    return ranked or picks[:limit]


def recognizes_source(claude: Claude, sentence: str, author: str) -> tuple[bool, dict]:
    """The memorization test, two probes: does the model name the author, and does it
    complete the line verbatim from its first half? Either = the line is known (the very
    famous quote), next sentence. The completion probe is the reliable one: a model
    under-claims authorship, but it cannot help finishing a line it has memorized."""
    answer = claude.json(f"""Who wrote this French sentence, and in which work? If you do not know, say so:
do not guess from style.

« {sentence} »

Return {{"author": "<name or null>", "work": "<title or null>", "confidence": <0..1>}}.""")
    head, tail = split_for_completion(sentence)
    completion = claude.json(f"""Complete this French sentence exactly as it was written, if you know it. If you do
not recognize it, return an empty string.

« {head} …

Return {{"continuation": "<the rest of the sentence, verbatim, or empty>"}}.""")
    continuation = completion.get("continuation") or ""
    answer["continuation"] = continuation
    known = same_author(answer.get("author") or "", author) or completion_matches(tail, continuation)
    return known, answer


def split_for_completion(sentence: str) -> tuple[str, str]:
    words = sentence.split()
    k = max(3, len(words) // 2)
    return " ".join(words[:k]), " ".join(words[k:])


# Share of the true continuation's words the model reproduces, in order, to count as
# memorized (a paraphrase from style lands far below; a verbatim line at 1.0).
COMPLETION_MATCH = 0.6


def completion_matches(tail: str, continuation: str) -> bool:
    truth = [slug(w) for w in tail.split() if slug(w)]
    given = [slug(w) for w in continuation.split() if slug(w)]
    if not truth or not given:
        return False
    i = 0
    hits = 0
    for w in truth:
        try:
            j = given.index(w, i)
        except ValueError:
            continue
        hits += 1
        i = j + 1
    return hits / len(truth) >= COMPLETION_MATCH


# Name particles that two different authors share.
_NAME_PARTICLES = frozenset({"de", "du", "la", "le", "les", "von", "van", "der", "as", "and", "et"})


def same_author(guessed: str, actual: str) -> bool:
    """Two author strings name the same person when they share a real name part
    (slug() fuses words, so compare per word: `Pessoa Fernando` vs `Fernando Pessoa (as
    Bernardo Soares)`)."""

    def parts(text: str) -> set[str]:
        return {slug(w) for w in re.split(r"[\s,()\-]+", text)} - {""} - _NAME_PARTICLES

    return bool({p for p in parts(guessed) if len(p) >= 3} & parts(actual))


def holed(tokens, blanks: set[int], mark: int | None = None) -> str:
    """The sentence with the picked tokens blanked (`____`) and the one under test marked
    (`[____]`), rebuilt from the tokens with a space between words."""
    parts = []
    for t in tokens:
        if t.i == mark:
            parts.append("[____]")
        elif t.i in blanks:
            parts.append("____")
        else:
            parts.append(t.text)
    return re.sub(r"\s+([,.;:!?…»)])", r"\1", re.sub(r"([«(]|\w')\s+", r"\1", " ".join(parts)))


def pick_secret(claude: Claude, tokens, remaining, picked) -> str | None:
    blanks = {t.i for t in picked}
    shown = holed(tokens, blanks)
    options = ", ".join(f"{t.text} ({t.pos.lower()})" for t in remaining)
    already = ", ".join(t.text for t in picked) or "none yet"
    answer = claude.json(f"""You curate a daily French word game: three words of a sentence are hidden and the
player rediscovers each from embedding-neighbour feedback (a hint word ranked 50–150
from the secret, then warm/cold ranks on every guess). Pick the NEXT secret word.

The sentence as the player sees it so far (____ = already hidden):
{shown}

Already hidden: {already}.

Rules (the list below already excludes what the rules forbid mechanically):
{secret_rules()}

Pick ONE word from this list only — the word that makes the best hole: many plausible
fillers in context, an interesting neighbourhood to explore, a difficulty comparable to
the other holes. Options: {options}

Return {{"word": "<exact word from the list>", "why": "<one line>"}} or {{"word": null}}
if none of the options makes a good hole.""")
    word = answer.get("word")
    return word if isinstance(word, str) and word.strip() else None


def context_guesses(claude: Claude, tokens, blanks: set[int], mark: int, n: int) -> list[str]:
    shown = holed(tokens, blanks, mark)
    answer = claude.json(f"""In this French sentence, ____ marks hidden words and [____] the one to guess.
Give your {n} best guesses for [____], most likely first, single words.

{shown}

Return {{"guesses": ["...", ...]}}.""")
    return [g for g in answer.get("guesses", []) if isinstance(g, str)][:n]


def pick_form(claude: Claude, sentence: str, secret: str, choices: list[str]) -> int:
    listing = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(choices))
    answer = claude.json(f"""In the French sentence below, which analysis is the word « {secret} »? The analyses
are morphological readings from a forms table (part of speech, gender, number, tense).

« {sentence} »

{listing}

Return {{"choice": <1-based number>}}.""")
    choice = int(answer["choice"])
    if not 1 <= choice <= len(choices):
        raise LLMError(f"form choice out of range: {choice}")
    return choice


def grammar_check(claude: Claude, sentence: str, start_words: list[str]) -> dict:
    """Is the displayed sentence valid French? The start words are the only things that
    can be wrong (elision, gender, number, agreement); the model names the faulty ones."""
    answer = claude.json(f"""Is this French sentence grammatically valid — elision, gender and number
agreement, verb forms? The words {', '.join(f'« {w} »' for w in start_words)} were inserted
into an existing sentence; only they can be wrong. Judge the grammar only, not the meaning.

« {sentence} »

Return {{"valid": true/false, "faulty": [{{"word": "<inserted word that breaks the grammar>", "why": "<one line>"}}, ...]}}.""")
    faulty: dict[str, str] = {}
    for item in answer.get("faulty", []) or []:
        if isinstance(item, dict) and isinstance(item.get("word"), str):
            faulty[item["word"]] = item.get("why", "") or "ungrammatical"
        elif isinstance(item, str):
            faulty[item] = "ungrammatical"
    return {"valid": bool(answer.get("valid")) and not faulty, "faulty": faulty}


def pick_starts(claude: Claude, sentence_marked: str, holes: list[dict]) -> dict[str, str]:
    """The three start words chosen TOGETHER. `holes`: [{secret, slug, context, options:
    [{word, rank}]}] — `context` is the context-check annotation (where the model's own
    guess of the blank landed, or "not guessed"). Returns {slug: word}, only words from
    the options."""
    blocks = []
    for h in holes:
        opts = ", ".join(f"{o['word']} ({o['rank']})" for o in h["options"])
        blocks.append(f"Hole « {h['secret']} » (slot: {h.get('slot', 'as the hidden word')}) — "
                      f"context check: {h['context']}.\n"
                      f"Candidates (word (rank), closest first): {opts}")
    answer = claude.json(f"""You curate a daily French word game: three words of a sentence are hidden and the
player rediscovers each from embedding-neighbour feedback. Each hole shows a START word
as its first clue, IN PLACE of the hidden word. Choose the three start words, together.

{start_rules()}

The start word replaces the hidden word in the sentence: it must be the same part of
speech and agree with its surroundings (gender, number, verb form, elision). Before
answering, read the sentence with each choice in place and reject what does not read as
correct French — an infinitive where a noun stands, a feminine noun after « un ».

The sentence, holes marked with the hidden word in brackets:
{sentence_marked}

{chr(10).join(blocks)}

Return {{"starts": {{"<hidden word>": "<chosen candidate, exactly>", ...}}, "why": "<one line per hole>"}}.""")
    chosen = answer.get("starts", {}) if isinstance(answer.get("starts"), dict) else {}
    out: dict[str, str] = {}
    for h in holes:
        word = chosen.get(h["secret"]) or chosen.get(h["slug"])
        if isinstance(word, str) and word in {o["word"] for o in h["options"]}:
            out[h["slug"]] = word
    return out


def pick_start(claude: Claude, sentence_marked: str, secret: str, options: list[dict],
               refused: str = "", context: str = "unknown") -> str | None:
    listing = ", ".join(f"{o['word']} ({o['rank']})" for o in options)
    answer = claude.json(f"""You curate a daily French word game: three words of a sentence are hidden and the
player rediscovers each from embedding-neighbour feedback. One hole's START word (its
first clue, shown in place of the hidden word « {secret} ») was refused: {refused or 'it broke the grammar'}.
Choose another, following these rules:

{start_rules()}

The start word replaces the hidden word: same part of speech, agreeing with its
surroundings (gender, number, verb form, elision). Read the sentence with your choice in
place before answering. Context check for this hole: {context}.

The sentence, the hole marked [____]:
{sentence_marked}

Candidates (word (rank), closest first): {listing}

Return {{"word": "<one candidate, exactly>"}} or {{"word": null}} if none makes valid French.""")
    word = answer.get("word")
    return word if isinstance(word, str) and word in {o["word"] for o in options} else None
