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
from llm_play import (
    SUBSCRIPTION_CONFLICT_ENV,
    _agent_sdk_turn,
    _temporary_environment_without,
    validate_anthropic_subscription_auth,
)

MODEL = "claude-opus-5-5"
EFFORT = "high"

# The language each question is asked about (#317): its name, and what a start word must
# agree with in it — French elides and has gender, English has neither and picks its
# article by the next word's sound. French is the tuned original: its prompts read
# exactly as they did before English existed.
LANGUAGE = {"fr": "French", "en": "English"}
# The name with its article: « a French reader », « an English reader ».
A_LANGUAGE = {"fr": "a French", "en": "an English"}
AGREEMENT = {"fr": "gender, number, verb form, elision", "en": "number, verb form, the article a/an"}
# What a forms-table analysis is made of (the #133 question).
ANALYSIS = {"fr": "part of speech, gender, number, tense", "en": "part of speech, number, tense, degree"}


def _capital(text: str) -> str:
    return text[:1].upper() + text[1:]


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
# TASTE has ONE home, the `taste` skill, read WHOLE by every prompt that chooses a line,
# a trio or a start word. The `find-sentences` skill keeps the practical laws (the famous
# line, standing alone, the start word, the page); the prompts quote them.

def skill_section(heading: str) -> str:
    text = _paths.SKILL_FILE.read_text(encoding="utf-8")
    start = text.index(heading)
    nxt = re.search(r"^## ", text[start + len(heading):], re.M)
    end = start + len(heading) + nxt.start() if nxt else len(text)
    return text[start:end].strip()


def taste() -> str:
    text = _paths.TASTE_FILE.read_text(encoding="utf-8")
    return re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S).strip()


def laws() -> str:
    return "\n\n".join(skill_section(h) for h in ("## The quotation rule", "## Stands alone", "## The trio rules"))


def start_rules() -> str:
    return skill_section("## The start word")


def page_rules() -> str:
    return skill_section("## The page")


# ---------------------------------------------------------------------------
# Questions

def pick_from_chunk(claude: Claude, sentences: list[str], limit: int, *, lang: str) -> list[dict]:
    listing = "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
    answer = claude.json(f"""You curate a daily {LANGUAGE[lang]} word game: one sentence, three words removed, the
player rediscovers them from embedding-neighbour feedback. Below are sentences mined
from one book. Choose the at most {limit} that would make the best days, by this taste —
lines that DO something and are built for the game; skip plot, anything flat, anything
that merely describes. Choose none rather than weak ones.

{taste()}

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


def rank_sentences(claude: Claude, picks: list[dict], limit: int, *, lang: str) -> list[dict]:
    if len(picks) <= 1:
        return picks
    listing = "\n".join(f"{i}. {p['sentence']}  ({p['why']})" for i, p in enumerate(picks))
    answer = claude.json(f"""These sentences were shortlisted from one book for a daily {LANGUAGE[lang]} word game
(three words removed, rediscovered from embedding-neighbour feedback). Rank the best
{limit} by this taste — the line that would make the best day first:

{taste()}

Shortlist:
{listing}

Return {{"ranked": [<index>, ...]}}, best first, at most {limit} entries.""")
    ranked = []
    for n in answer.get("ranked", [])[:limit]:
        n = int(n)
        if 0 <= n < len(picks) and picks[n] not in ranked:
            ranked.append(picks[n])
    # The question asks for an ORDER, never a refusal: an empty or unreadable answer is no
    # judgement, and the reading's picks keep their reading order rather than being lost.
    return ranked or picks[:limit]


def stands_alone(claude: Claude, sentence: str, *, lang: str) -> dict:
    """Does the sentence make complete sense on its own, SOLVED, without its page? The
    user's rule of 2026-09-18 (the Svevo day: « c'étaient donc des nerfs parfaits »
    meant nothing even solved). A STRIKE, applied by code on the model's verdict; the
    rule is read from the skill file."""
    answer = claude.json(f"""{_capital(A_LANGUAGE[lang])} word game shows ONE sentence from a book or song, alone. The surrounding
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


def widely_known(claude: Claude, sentence: str, author: str, work: str, *, lang: str) -> dict:
    """Would a reader who has NOT read the book know this line? An ANNOTATION for the
    reviewer, never a strike (user-decided 2026-09-08): the model has memorised every
    line of a canonical book, so what it remembers says nothing about what a reader has
    met — the strike is the quotation test's (`quotes.quoted`), off the record."""
    answer = claude.json(f"""{_capital(A_LANGUAGE[lang])} word game hides three words of a sentence from « {work} » by {author} and
the player rebuilds it. Would {A_LANGUAGE[lang]} reader who has NOT read the book have met this
exact sentence before — is it widely quoted (quotation sites, the book's encyclopedia
article, school anthologies, titles, advertising)? Judge the SENTENCE's fame, not the
book's.

« {sentence} »

Return {{"known": true/false, "why": "<one line>"}}.""")
    return {"known": bool(answer.get("known")), "why": str(answer.get("why") or "")}


def holed(tokens, blanks: set[int], mark: int | None = None, *, lang: str) -> str:
    """The sentence with the picked tokens blanked (`____`) and the one under test marked
    (`[____]`). French is rebuilt with a space between words, then its elisions and
    guillemets closed up — the rendering the giveaway threshold was calibrated on; English
    with the source's own spacing (#317: « don't » is two tokens, « the dog's » too)."""
    parts = []
    for t in tokens:
        if t.i == mark:
            parts.append("[____]")
        elif t.i in blanks:
            parts.append("____")
        else:
            parts.append(t.text)
    return _joined(tokens, parts, lang)


def marked(tokens, hidden: set[int], *, lang: str) -> str:
    """The sentence with the hidden tokens in brackets (`[word]`), rendered as `holed`."""
    return _joined(tokens, [f"[{t.text}]" if t.i in hidden else t.text for t in tokens], lang)


def _joined(tokens, parts: list[str], lang: str) -> str:
    if lang == "fr":
        return re.sub(r"\s+([,.;:!?…»)])", r"\1", re.sub(r"([«(]|\w')\s+", r"\1", " ".join(parts)))
    return "".join(part + t.space for part, t in zip(parts, tokens)).strip()


def choose_day(claude: Claude, lines: list[dict], refused: list[str], *, lang: str) -> dict | None:
    """The day, chosen by COMPARISON (2026-09-24): `lines` are shortlisted lines, each with
    the words code allows as its secrets ({"sentence", "allowed"}); the model picks the one
    that makes the best day and the three words to hide, in the order players will find
    them. `refused` says what was already turned down and why. Returns {"line": index,
    "words": [3], "path": [lines], "why": str}, or {"line": None, "why": str} when the
    model declines (the reason is logged), or None when the answer is unusable."""
    listing = "\n\n".join(f"{n}. « {line['sentence']} »\n   words that can be hidden: {', '.join(line['allowed'])}"
                           for n, line in enumerate(lines, 1))
    again = ("\nAlready turned down — do not choose these again:\n"
             + "\n".join(f"- {r}" for r in refused) + "\n") if refused else ""
    answer = claude.json(f"""You choose tomorrow's day for a daily {LANGUAGE[lang]} word game. One line, three words hidden;
the player rebuilds each from how close every guess lands, starting from a START word
chosen later. A word once found stays revealed and becomes context for the others.

What makes a day worth playing:
{taste()}

The game's laws and practical rules:
{laws()}

The candidate lines, from one work:

{listing}
{again}
Compare them. For the best one, choose the three words to hide — the punch first among
them — in the order players should find them: for each word, what in the line (and in
the words found before it) leads toward it, and what it does when it lands. Decline only
when no line here would make a day worth playing.

Return {{"line": <number>, "words": ["<first found>", "<second>", "<third>"], "path": ["<word>: <what leads toward it and what it does when it lands>", ...], "why": "<one line: what the player will feel>"}},
or {{"line": null, "why": "<one line>"}} to decline.""")
    n = answer.get("line")
    words = answer.get("words")
    if n is None:
        return {"line": None, "why": str(answer.get("why") or "")}
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= len(lines):
        return None
    if not isinstance(words, list) or len(words) != 3 or not all(isinstance(w, str) and w.strip() for w in words):
        return None
    path = [str(x) for x in answer.get("path") or [] if isinstance(x, str) and x.strip()]
    return {"line": n - 1, "words": [w.strip() for w in words], "path": path, "why": str(answer.get("why") or "")}


def context_guesses(claude: Claude, tokens, blanks: set[int], mark: int, n: int,
                    *, lang: str) -> tuple[list[str], str | None]:
    """What a reader could really put in ONE blank, the rest of the sentence intact and
    no start word, and the ONE word most readers would write there when readers agree
    (None when they split) — the reader's question, whose answer becomes a note for the
    model (`rules.reading`), never a verdict. `blanks` holds the other
    occurrences of the same word, hidden so they cannot give it away. The model is told
    to set the book aside: it has memorised a canonical text, and the true word is not
    what a reader who has never seen it writes — the position of the true word in its
    list was the verdict until 2026-09-15 and struck nearly every word of an Orwell."""
    shown = holed(tokens, blanks, mark, lang=lang)
    answer = claude.json(f"""You are {A_LANGUAGE[lang]} reader. In this sentence one word is hidden, marked [____]
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


def would_say(claude: Claude, tokens, blanks: set[int], mark: int, word: str,
              *, lang: str) -> tuple[float | None, str | None]:
    """The user's test for a hidden word (2026-10-06, after « faux-monnayeur »): a player
    who has roughly the meaning types the words they would use for it — would they ever say
    THIS one, or keep to commoner words meaning nearly the same? The chance they come up
    with it (None when the answer is unusable) and the word they would keep saying
    instead; a note for the model (`rules.said`), never a verdict. Worded exactly as it
    was calibrated on real play (`rules.WOULD_SAY_HARD`)."""
    shown = holed(tokens, blanks, mark, lang=lang)
    answer = claude.json(f"""You judge one hidden word of a daily {LANGUAGE[lang]} word game. The player sees this line with the
word hidden and rebuilds it by guessing: each guess tells them how close it is in meaning.
Players think by association; most get roughly what goes there, and type words around its
meaning. The question here is the LAST step.

« {shown} »

The hidden word is « {word} ».

A player who has understood roughly what goes there and is typing words around its meaning:
would they ever say THIS word? Or would they keep saying commoner words that mean nearly
the same, and never think of this one?

Return {{"instead": "<the commoner word they would keep saying, or null when this is the word they'd say>", "would_say": <the chance, 0 to 1, that such a player comes up with this exact word>}}""")
    chance = answer.get("would_say") if isinstance(answer, dict) else None
    instead = answer.get("instead") if isinstance(answer, dict) else None
    if isinstance(chance, bool) or not isinstance(chance, (int, float)) or not 0 <= chance <= 1:
        chance = None
    return chance, instead.strip() if isinstance(instead, str) and instead.strip() else None


def pick_form(claude: Claude, sentence: str, secret: str, choices: list[str], *, lang: str) -> int:
    listing = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(choices))
    answer = claude.json(f"""In the {LANGUAGE[lang]} sentence below, which analysis is the word « {secret} »? The analyses
are morphological readings from a forms table ({ANALYSIS[lang]}).

« {sentence} »

{listing}

Return {{"choice": <1-based number>}}.""")
    choice = int(answer["choice"])
    if not 1 <= choice <= len(choices):
        raise LLMError(f"form choice out of range: {choice}")
    return choice


def sentence_check(claude: Claude, sentence: str, start_words: list[str], *, lang: str) -> dict:
    """Does the displayed sentence read right? The start words are the only things that
    can be wrong; the model reads it as a native reader would and names the ones that do
    not belong — wrong as language, or leaving the sentence meaning nothing."""
    answer = claude.json(f"""The words {', '.join(f'« {w} »' for w in start_words)} were each put into an existing
{LANGUAGE[lang]} sentence in place of another word; only they can be wrong.

« {sentence} »

Read it as {A_LANGUAGE[lang]} reader would. Does each inserted word belong where it stands: the
sentence correct {LANGUAGE[lang]}, and still meaning something? An inserted word is a clue,
not the author's word: it may be less apt, odd or funny. Name only a word that breaks the
language, or one the sentence cannot be about where it stands.

Return {{"valid": true/false, "faulty": [{{"word": "<inserted word that does not belong>", "why": "<one line>"}}, ...]}}.""")
    faulty: dict[str, str] = {}
    for item in answer.get("faulty", []) or []:
        if isinstance(item, dict) and isinstance(item.get("word"), str):
            faulty[item["word"]] = item.get("why", "") or "does not belong"
        elif isinstance(item, str):
            faulty[item] = "does not belong"
    return {"valid": bool(answer.get("valid")) and not faulty, "faulty": faulty}


def _chain_block(chain: list[str] | None) -> str:
    if not chain:
        return ""
    lines = "\n".join(f"{i}. {step}" for i, step in enumerate(chain, 1))
    return f"\nHow the day was chosen to play — the order players should find the words in:\n{lines}\n"


def drop_unsaid(claude: Claude, sentence_marked: str, holes: list[dict], unsaid: list[str], allowed: list[str],
                chain: list[str] | None = None, *, lang: str) -> dict | None:
    """Asked only when the trio hides two or more words players don't say (`rules.unsaid`),
    BEFORE the day's ranking is paid for: the taste keeps at most one, so the model names
    ONE of `unsaid` to swap for another word of the line. `holes`: [{secret, notes}].
    Returns {"secret", "with", "why"}, or None when the answer is unusable."""
    blocks = "\n".join(f"Hole « {h['secret']} »\n  measured: {h['notes']}" for h in holes)
    answer = claude.json(f"""You check the three hidden words of a day for a daily {LANGUAGE[lang]} word game before it
is built: each hole shows a start word in place of the hidden word; the player types
guesses and reads, for every hole, how close each lands.

What makes a day worth playing:
{taste()}

The sentence, holes marked with the hidden word in brackets:
{sentence_marked}
{_chain_block(chain)}
{blocks}

This trio hides {len(unsaid)} words players don't say: {", ".join(f"« {w} »" for w in unsaid)}. The taste
keeps at most one: swap the DULL one and keep the one more fun to find. Name ONE of them
to swap, and its replacement from the other words of the line that can be hidden:
{", ".join(allowed)}.

Return {{"replace": {{"secret": "<one of the words players don't say>", "with": "<another word of the line>", "why": "<one line>"}}}}.""")
    replace = answer.get("replace") if isinstance(answer, dict) else None
    if isinstance(replace, dict) and isinstance(replace.get("secret"), str) and isinstance(replace.get("with"), str):
        return {"secret": replace["secret"].strip(), "with": replace["with"].strip(), "why": str(replace.get("why") or "")}
    return None


def replace_word(claude: Claude, sentence_marked: str, holes: list[dict], word: str, allowed: list[str],
                 chain: list[str] | None = None, *, lang: str) -> dict | None:
    """Code refused `word` (BURIED: half-said, among commoner near-words — `rules.buried`),
    BEFORE the day's ranking is paid for: the model names the word of the line to hide in
    its place, by the taste. `holes`: [{secret, notes}]. Returns {"with", "why"}, or None
    when the answer is unusable."""
    blocks = "\n".join(f"Hole « {h['secret']} »\n  measured: {h['notes']}" for h in holes)
    answer = claude.json(f"""You check the three hidden words of a day for a daily {LANGUAGE[lang]} word game before it
is built: each hole shows a start word in place of the hidden word; the player types
guesses and reads, for every hole, how close each lands.

What makes a day worth playing:
{taste()}

The sentence, holes marked with the hidden word in brackets:
{sentence_marked}
{_chain_block(chain)}
{blocks}

« {word} » cannot be hidden: players only half-say it and it sits among commoner words
meaning nearly the same, so they reach the idea, circle the commoner neighbours and stall.
Name the word of the line to hide in its place, from: {", ".join(allowed)}.

Return {{"with": "<another word of the line>", "why": "<one line>"}}.""")
    pick = answer.get("with") if isinstance(answer, dict) else None
    if isinstance(pick, str) and pick.strip():
        return {"with": pick.strip(), "why": str(answer.get("why") or "")}
    return None


def pick_starts(claude: Claude, sentence_marked: str, holes: list[dict],
                chain: list[str] | None = None, *, lang: str) -> dict:
    """The three start words, chosen TOGETHER by the taste. `holes`: [{secret,
    slug, slot, notes, options: [{word, rank}]}] — `notes` is what code measured (what a
    reader puts in the blank, how much the line gives of the word, where the reader's words
    land in the hole's own map). The model may instead name ONE hidden word to
    REPLACE, when no start can save it. Returns {"starts": {slug: word}, "replace":
    {"secret": word, "with": word, "why": str} | None, "why": str}; starts only from the
    options."""
    blocks = []
    for h in holes:
        # A hole with no candidate cannot get a start: say so, so the model names a
        # replacement instead of leaving the hole out.
        opts = (", ".join(f"{o['word']} ({o['rank']})" for o in h["options"])
                or "NONE — no start fits this slot; name a replacement for this word")
        blocks.append(f"Hole « {h['secret']} » (slot: {h.get('slot', 'as the hidden word')})\n"
                      f"  measured: {h.get('notes', 'nothing')}\n"
                      f"  start candidates (word (rank), closest first): {opts}")
    answer = claude.json(f"""You choose the START words of a day for a daily {LANGUAGE[lang]} word game: each hole shows a
start word in place of the hidden word, the first clue; the player then types guesses and
reads, for every hole, how close each lands.

What makes a day worth playing — the start words included:
{taste()}

The start word's practical rules:
{start_rules()}

The start word replaces the hidden word in the sentence: same part of speech, agreeing with
its surroundings ({AGREEMENT[lang]}), taking the SAME CONSTRUCTION.

The sentence, holes marked with the hidden word in brackets:
{sentence_marked}
{_chain_block(chain)}
{chr(10).join(blocks)}

Choose the three starts together, by the taste's start words: for each hole, how much the
line gives of the word (read in its notes and in the line) and how hard the other holes
already are decide its start. If one hidden word is dead or out of reach whatever its
start — or none of its candidates links to it in its everyday sense (only by spelling, or
not at all) — say so and name ONE replacement from the line instead of starts.

Return {{"starts": {{"<hidden word>": "<chosen candidate, exactly>", ...}}, "why": "<one line per hole: how much the line gives of the word, and what the start says of the word>"}},
or {{"replace": {{"secret": "<hidden word>", "with": "<another word of the line>", "why": "<one line>"}}}}.""")
    replace = answer.get("replace")
    if isinstance(replace, dict) and isinstance(replace.get("secret"), str) and isinstance(replace.get("with"), str):
        return {"starts": {}, "replace": {"secret": replace["secret"].strip(), "with": replace["with"].strip(),
                                          "why": str(replace.get("why") or "")}, "why": ""}
    chosen = answer.get("starts", {}) if isinstance(answer.get("starts"), dict) else {}
    out: dict[str, str] = {}
    for h in holes:
        word = chosen.get(h["secret"]) or chosen.get(h["slug"])
        if isinstance(word, str) and word in {o["word"] for o in h["options"]}:
            out[h["slug"]] = word
    return {"starts": out, "replace": None, "why": str(answer.get("why") or "")}


def choose_excerpt(claude: Claude, unit: str, window: dict, *, lang: str) -> dict | None:
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
    answer = claude.json(f"""You curate a daily {LANGUAGE[lang]} word game. A player has just rebuilt the LINE below and is
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
               refused: str = "", context: str = "unknown", chain: list[str] | None = None,
               *, lang: str, others: list[dict] | None = None) -> str | None:
    """One hole's start, chosen again after a refusal, reading the day as `pick_starts`
    does: `context` is the hole's notes, `others` [{secret, start | None, notes}] the other
    holes as the day stands. Returns a candidate, exactly, or None."""
    listing = ", ".join(f"{o['word']} ({o['rank']})" for o in options)
    rest = ""
    if others:
        rest = "\nThe other holes, as the day stands:\n" + "\n".join(
            f"Hole « {o['secret']} », " + (f"shown as « {o['start']} »" if o.get("start") else "no start yet")
            + f"\n  measured: {o.get('notes') or 'nothing'}" for o in others) + "\n"
    answer = claude.json(f"""You curate a daily {LANGUAGE[lang]} word game: three words of a sentence are hidden and the
player rediscovers each from embedding-neighbour feedback. One hole's START word (its
first clue, shown in place of the hidden word « {secret} ») was refused: {refused or 'it did not belong in the sentence'}.
Choose another, following these rules:

{start_rules()}

And this taste (the start words part above all):
{taste()}

The start word replaces the hidden word: same part of speech, agreeing with its
surroundings ({AGREEMENT[lang]}). Read the sentence with your choice in
place before answering.

The sentence, the hole marked [____]:
{sentence_marked}
{_chain_block(chain)}
Hole « {secret} »
  measured: {context}
  candidates (word (rank), closest first): {listing}
{rest}
Return {{"word": "<one candidate, exactly>"}} or {{"word": null}} if none leaves correct {LANGUAGE[lang]} that still means something.""")
    word = answer.get("word")
    return word if isinstance(word, str) and word in {o["word"] for o in options} else None
