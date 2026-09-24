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
from start_word import START_RANK_MAX, START_RANK_MIN
from llm_play import (
    SUBSCRIPTION_CONFLICT_ENV,
    _agent_sdk_turn,
    _temporary_environment_without,
    validate_anthropic_subscription_auth,
)

MODEL = "claude-opus-5-5"
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


def page_rules() -> str:
    return skill_section("## The page")


# ---------------------------------------------------------------------------
# Questions

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


def stands_alone(claude: Claude, sentence: str) -> dict:
    """Does the sentence make complete sense on its own, SOLVED, without its page? The
    user's rule of 2026-09-18 (the Svevo day: « c'étaient donc des nerfs parfaits »
    meant nothing even solved). A STRIKE, applied by code on the model's verdict; the
    rule is read from the skill file."""
    answer = claude.json(f"""A French word game shows ONE sentence from a book or song, alone. The surrounding
page is available only after solving. Judge the complete sentence below with no context at all.

{skill_section("## Stands alone")}

« {sentence} »

Return {{"about": "<one line: what the sentence says, from the sentence alone>",
"stands_alone": true/false, "why": "<one line: what leans on the page, or empty>"}}.""")
    if (not isinstance(answer, dict) or type(answer.get("stands_alone")) is not bool
            or not isinstance(answer.get("about"), str)
            or not isinstance(answer.get("why"), str)):
        raise LLMError("standalone check requires a boolean verdict and string about/why fields")
    ok = answer["stands_alone"]
    about, why = answer["about"].strip(), answer["why"].strip()
    if not (about if ok else why):
        raise LLMError("standalone check requires a summary when accepted or a reason when rejected")
    return {"ok": ok, "why": why, "about": about}


def widely_known(claude: Claude, sentence: str, author: str, work: str) -> dict:
    """Would a reader who has NOT read the book know this line? An ANNOTATION for the
    reviewer, never a strike (user-decided 2026-09-08): the model has memorised every
    line of a canonical book, so what it remembers says nothing about what a reader has
    met — the strike is the quotation test's (`quotes.quoted`), off the record."""
    answer = claude.json(f"""A French word game hides three words of a sentence from « {work} » by {author} and
the player rebuilds it. Would a French reader who has NOT read the book have met this
exact sentence before — is it widely quoted (quotation sites, the book's encyclopedia
article, school anthologies, titles, advertising)? Judge the SENTENCE's fame, not the
book's.

« {sentence} »

Return {{"known": true/false, "why": "<one line>"}}.""")
    return {"known": bool(answer.get("known")), "why": str(answer.get("why") or "")}


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


def choose_trio(claude: Claude, tokens, candidates, refused: list[str],
                apart: list[tuple[str, str, str]] = ()) -> dict | None:
    """TASTE FIRST (2026-09-24): the model reads the sentence as the curator does by hand
    and names the three words worth hiding, in the order players will find them, from the
    words code allows (`candidates`). `refused` tells it what code already refused and
    why, and `apart` the pairs code forbids together (`rules.conflicts`). Returns
    {"words": [3 display words], "path": [lines], "why": str}, or None when it declines
    the sentence. Code checks the answer (`rules.refusals`)."""
    allowed = ", ".join(dict.fromkeys(t.text for t in candidates))
    never = ("\nPairs that can never share a trio (code's rules):\n"
             + "\n".join(f"- {a} + {b}: {why}" for a, b, why in apart) + "\n") if apart else ""
    again = ("\nAlready refused by the checks (measured on real play) — propose another trio:\n"
             + "\n".join(f"- {r}" for r in refused) + "\n") if refused else ""
    answer = claude.json(f"""You curate today's puzzle for a daily French word game. Three words of a sentence
are hidden. Each hole first shows a START word (a word ranked {START_RANK_MIN}–{START_RANK_MAX}
from its secret, chosen later); the player then types guesses and reads, for every
hole, how close each guess lands. A word once found stays revealed, so it becomes
context for the holes still open. The target: about 80% of players find all three
within 30 tries.

The game's voice:
{taste_profile()}

How a trio is chosen:
{secret_rules()}

The curator's method, done by hand for months — do it yourself, word by word: blank the
word and read the sentence as a player who has never seen it, with no start word. What
would you put there? If it is the word you would write first, it is not a hole (except
ONE easy word that opens the day). If nothing you would put there is anywhere near it,
players cannot reach it. Then think of the day as a chain: which word players find
first, and what each found word gives the next.

The sentence:
{holed(tokens, set())}

The words code allows as secrets (word type, frequency and cooldown already checked):
{allowed}
{never}{again}
Think it through, then name the three words in the order players will find them.
Return {{"words": ["<first>", "<second>", "<third>"], "path": ["<first>: <why players reach it first>", "<second>: <what the first gives it>", "<third>: <what the first two give it>"], "why": "<one line: why this day is worth playing>"}},
or {{"words": null, "why": "<one line>"}} to decline — only when you cannot find three
words worth finding in this sentence. A trio of good words is a good day even if the
sentence could be better.""")
    words = answer.get("words")
    if not isinstance(words, list) or len(words) != 3 or not all(isinstance(w, str) and w.strip() for w in words):
        return None
    path = [str(line) for line in answer.get("path") or [] if isinstance(line, str) and line.strip()]
    return {"words": [w.strip() for w in words], "path": path, "why": str(answer.get("why") or "")}


def context_guesses(claude: Claude, tokens, blanks: set[int], mark: int, n: int) -> tuple[list[str], str | None]:
    """What a reader could really put in ONE blank, the rest of the sentence intact and
    no start word, and the ONE word most readers would write there when readers agree
    (None when they split) — the obviousness filter's question (`rules.open_candidates`),
    which counts the list and strikes the expected word. `blanks` holds the other
    occurrences of the same word, hidden so they cannot give it away. The model is told
    to set the book aside: it has memorised a canonical text, and the true word is not
    what a reader who has never seen it writes — the position of the true word in its
    list was the verdict until 2026-09-15 and struck nearly every word of an Orwell."""
    shown = holed(tokens, blanks, mark)
    answer = claude.json(f"""You are a French reader. In this sentence one word is hidden, marked [____]
(____ marks the same word hidden again). You may recognise the sentence: set the book
aside and answer for a reader who has NEVER seen it, from this sentence alone.

{shown}

Two answers:
- "guesses": what else could it be? The single words that could really stand there —
  only words that would not surprise a reader in this exact sentence, at most {n}. Be
  honest about the count: when only one or two words can really be there, list only those.
- "expected": the ONE word most readers would write there, when readers would agree on
  it (an idiom completed, a fixed pair, the word the rest of the sentence calls for);
  null when readers would split between several words.

Return {{"guesses": ["...", ...], "expected": "..." or null}}.""")
    guesses = [g for g in answer.get("guesses", []) if isinstance(g, str)][:n]
    expected = answer.get("expected")
    return guesses, expected.strip() if isinstance(expected, str) and expected.strip() else None


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
agreement, verb forms, and each inserted word's CONSTRUCTION with what surrounds it (a
verb must accept the object or preposition that follows it: « il avait hérité d'un
prénom » is French, « il avait affublé d'un prénom » is not — affubler needs an object
before « de »)? The words {', '.join(f'« {w} »' for w in start_words)} were inserted into
an existing sentence; only they can be wrong. Judge the grammar and the construction,
not the meaning.

« {sentence} »

Return {{"valid": true/false, "faulty": [{{"word": "<inserted word that breaks the grammar>", "why": "<one line>"}}, ...]}}.""")
    faulty: dict[str, str] = {}
    for item in answer.get("faulty", []) or []:
        if isinstance(item, dict) and isinstance(item.get("word"), str):
            faulty[item["word"]] = item.get("why", "") or "ungrammatical"
        elif isinstance(item, str):
            faulty[item] = "ungrammatical"
    return {"valid": bool(answer.get("valid")) and not faulty, "faulty": faulty}


def _chain_block(chain: list[str] | None) -> str:
    if not chain:
        return ""
    lines = "\n".join(f"{i}. {step}" for i, step in enumerate(chain, 1))
    return f"\nThe chain the day was designed on — the order players should find the words in:\n{lines}\n"


def pick_starts(claude: Claude, sentence_marked: str, holes: list[dict],
                chain: list[str] | None = None) -> dict[str, str]:
    """The three start words chosen TOGETHER. `holes`: [{secret, slug, context, options:
    [{word, rank}]}] — `context` is what a reader puts in the blank. `chain` is the path
    the trio was proposed on (`choose_trio`): the starts are set along it. Returns
    {slug: word}, only words from the options."""
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
speech, agree with its surroundings (gender, number, verb form, elision) and take the
SAME CONSTRUCTION — a verb must accept the object or preposition that follows (« hérité
d'un prénom » cannot become « affublé d'un prénom »: affubler needs an object before
« de »). Before answering, read the sentence with each choice in place and reject what
does not read as correct French — an infinitive where a noun stands, a feminine noun
after « un », a verb cut off from its complement.

The sentence, holes marked with the hidden word in brackets:
{sentence_marked}
{_chain_block(chain)}
{chr(10).join(blocks)}

Return {{"starts": {{"<hidden word>": "<chosen candidate, exactly>", ...}}, "why": "<one line per hole>"}}.""")
    chosen = answer.get("starts", {}) if isinstance(answer.get("starts"), dict) else {}
    out: dict[str, str] = {}
    for h in holes:
        word = chosen.get(h["secret"]) or chosen.get(h["slug"])
        if isinstance(word, str) and word in {o["word"] for o in h["options"]}:
            out[h["slug"]] = word
    return out


def choose_excerpt(claude: Claude, unit: str, window: dict) -> dict | None:
    """Where the PAGE around the unit starts and ends (#270): the model is shown the
    window — B1 is the sentence right before the line, A1 the one right after — and
    answers two counts. None when the answer is not two integers (the caller falls back);
    the clamp is `sentences.cut_excerpt`'s. A window with nothing in it asks nothing."""
    before, after = window["before"], window["after"]
    if not before and not after:
        return {"before": 0, "after": 0}
    listing = "\n".join(
        [f"B{len(before) - i}: {s}" for i, s in enumerate(before)]
        + [f"LINE: {unit}"]
        + [f"A{i + 1}: {s}" for i, s in enumerate(after)]
    )
    answer = claude.json(f"""You curate a daily French word game. A player has just rebuilt the LINE below and is
shown its page: the sentences of the book around it, verbatim. Decide how much of the
page to keep, following these rules:

{page_rules()}

The text, in reading order — B1 is the sentence right before the line, A1 the one right
after (at most {len(before)} before and {len(after)} after are available):

{listing}

Return {{"before": <how many B sentences to keep, 0..{len(before)}>, "after": <how many A sentences, 0..{len(after)}>}}.""")
    b, a = answer.get("before"), answer.get("after")
    if any(isinstance(v, bool) or not isinstance(v, int) for v in (b, a)):
        return None
    return {"before": b, "after": a}


def pick_start(claude: Claude, sentence_marked: str, secret: str, options: list[dict],
               refused: str = "", context: str = "unknown", chain: list[str] | None = None) -> str | None:
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
{_chain_block(chain)}
Candidates (word (rank), closest first): {listing}

Return {{"word": "<one candidate, exactly>"}} or {{"word": null}} if none makes valid French.""")
    word = answer.get("word")
    return word if isinstance(word, str) and word in {o["word"] for o in options} else None
