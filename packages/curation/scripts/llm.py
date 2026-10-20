"""Claude on the subscription, one fresh conversation per question.

The transport is the benchmark's (`llm_play._agent_sdk_turn` + its paid-Claude.ai
guard); this module only adds the questions the curator asks and the JSON it expects
back. Every question is stateless: the prompt carries everything the model needs.
"""

import asyncio
import json
import re
import tempfile
import threading

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
# Who the would-say question's players are. English is spoken in many countries, and a word
# (or a sense) only a small part of its speakers use is one most players never say
# (user-decided 2026-10-14, after « knickers » in « pull down your ___ »: "it works for only a
# small part of english speakers"). The French question stays worded exactly as it was
# calibrated on real play.
AUDIENCE = {"fr": "", "en": "\nThe players come from every English-speaking country: a word, or a sense of a word, that only\n"
                            "a small part of English speakers use is one most of them never say, however natural it is\n"
                            "where it is used. A word most English speakers say is not one of them."}


def _capital(text: str) -> str:
    return text[:1].upper() + text[1:]


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


class LLMError(RuntimeError):
    pass


def validate() -> str:
    """The subscription guard: refuses to run on anything but a paid Claude.ai login."""
    return validate_anthropic_subscription_auth()


def subscription_only():
    """The credentials that would take a call off the subscription, removed for a whole
    block. Each call removes them for its own duration and restores them after; calls on
    several threads at once would restore them under one another, so a block that runs
    them in parallel removes them once, around all of them."""
    return _temporary_environment_without(SUBSCRIPTION_CONFLICT_ENV)


class Claude:
    def __init__(self, model: str = MODEL, effort: str = EFFORT):
        self.model = model
        self.effort = effort
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-curation-")
        self.calls = 0
        self._counting = threading.Lock()  # lines are checked on several threads at once

    def text(self, prompt: str) -> str:
        with self._counting:
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
# line, standing alone, the start word, the page); the prompts quote them. A check that
# judges ONE rule of the taste quotes that section of it (`taste_section`), never a copy.

def skill_section(heading: str) -> str:
    text = _paths.SKILL_FILE.read_text(encoding="utf-8")
    start = text.index(heading)
    nxt = re.search(r"^## ", text[start + len(heading):], re.M)
    end = start + len(heading) + nxt.start() if nxt else len(text)
    return text[start:end].strip()


def taste() -> str:
    text = _paths.TASTE_FILE.read_text(encoding="utf-8")
    return re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S).strip()


def taste_section(heading: str) -> str:
    """One section of the `taste` skill, from its heading to the next heading of the same
    level or above — for a check that judges one rule, never chooses."""
    text = _paths.TASTE_FILE.read_text(encoding="utf-8")
    start = text.index(heading)
    level = len(heading) - len(heading.lstrip("#"))
    nxt = re.search(rf"^#{{1,{level}}} ", text[start + len(heading):], re.M)
    end = start + len(heading) + nxt.start() if nxt else len(text)
    return text[start:end].strip()


def start_idea_rule() -> str:
    return taste_section("### One idea, the start's first one")


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


# The seven kinds of line the taste names, by number (its `### <n>. <name>` headings; a test
# ties the two): the read says which one a line is, or none.
KINDS = {1: "Pairs and molds", 2: "The build-up and the drop", 3: "The small fact that proves a big thing",
         4: "The reasoning pushed to its end", 5: "The riddle", 6: "The cold exact word", 7: "The bent phrase"}
# The narrowing ladder of a word taken from a wide kind, in order: the kind the slot shapes,
# the smaller family a start can name, and the word as that family's first member (or the
# ranks climbing to it). A missing step makes the word a lottery.
LADDER = ("slot", "family", "first")


def ladder_text(ladder: dict | None) -> str:
    """A ladder in one line, its steps in order, a missing one as a dash."""
    return " › ".join((ladder or {}).get(step) or "—" for step in LADDER)


def kind_text(kind: int | None) -> str:
    """A line's kind as the taste names it, or none."""
    return f"kind {kind}, {KINDS[kind]}" if kind else "no kind"


def read_line(claude: Claude, sentence: str, hideable: list[str], refused: list[str], *, lang: str) -> dict | None:
    """The line READ as its curator reads it, before any word is chosen or any judge paid:
    whether it stands alone, SOLVED, without its page (the find-sentences skill's `## Stands
    alone`, read whole), which of its words need the work to mean anything, its kind (`KINDS`,
    or none), its MAIN word — the word the line is about, one of `hideable` — with the visible
    words its path runs through, the main word's narrowing ladder when it is one of a wide
    kind, whether it is the partner of a visible word, whether hiding it hides the joke, and
    one sibling making the same joke. `refused` is what code told back of an earlier reading.
    The verdicts are the model's; code applies them (`curate.read`). Returns {about,
    stands_alone, why, needs_book, kind, anchor, path, path_words, wide, ladder: {slot,
    family, first} | None, mirror, joke_hidden, sibling} (a line that does not stand alone, or
    names no main word, leaves the rest unanswered); None when its kind is none of `KINDS`;
    raises LLMError when the answer is malformed."""
    again = ("\nTold back of your earlier reading — read the line again:\n"
             + "\n".join(f"- {r}" for r in refused) + "\n") if refused else ""
    kinds = "; ".join(f"{n} {name}" for n, name in KINDS.items())
    answer = claude.json(f"""You read one line for a daily {LANGUAGE[lang]} word game, as its curator does, before any word
is chosen. One line, three words hidden; the player rebuilds each from how close every guess
lands, starting from a START word chosen later. A word once found stays revealed and becomes
context for the others. The page around the line is shown only once the day is solved.

What makes a day worth playing:
{taste()}

The line must stand alone:
{skill_section("## Stands alone")}

The line, from one work:

« {sentence} »
   words that can be hidden: {', '.join(hideable)}
{again}
Read it in this order:
1. Does it stand alone once solved? Which of the words that can be hidden need the work to
   mean anything?
2. Its kind, by each kind's *Spot it* ({kinds}), or none.
3. Its MAIN word: the word the line is about — the punch its kind names or, with no kind, the
   word the line lands on — one of the words that can be hidden; null when that word cannot be
   hidden or the line gives it no path. Name the 1 to 3 words of the line, left in sight, that
   its path runs through (single words of the line, never the main word itself), and give the
   path in one line.
4. By *The narrowing ladder*: is the main word one member of a wide kind? If so, its ladder:
   the kind the slot shapes; the smaller family a start can name; and whether the word is the
   first member players name in that family, or the ranks climb to it. Null for any step that
   is missing.
5. By *No mirror*, its exception included: is it the first word players would type as the
   partner of a visible word?
6. By *The blank read*: with only the main word hidden, is the joke hidden too?
7. One sibling that makes the same joke, if any (a warning only).

Return {{"about": "<one line: what the line says, from the line alone>", "stands_alone": true/false,
"why": "<one line: what leans on the page, or empty>", "needs_book": ["<a word that needs the work>", ...],
"kind": <1 to 7, or null>, "anchor": "<the main word>" or null, "path": "<one line: how the line leads to it>",
"path_words": ["<a word of the line>", ...], "wide": true/false,
"ladder": {{"slot": "<the kind the slot shapes>" or null, "family": "<the smaller family a start can name>" or null, "first": "<the first member players name there, or how the ranks climb to it>" or null}} or null,
"mirror": true/false, "joke_hidden": true/false, "sibling": "<another word making the same joke>" or null}}.""")
    if (not isinstance(answer, dict) or type(answer.get("stands_alone")) is not bool
            or not isinstance(answer.get("about"), str) or not isinstance(answer.get("why"), str)):
        raise LLMError("the reading requires a boolean stands_alone and string about/why fields")
    read = {"about": answer["about"].strip(), "stands_alone": answer["stands_alone"], "why": answer["why"].strip(),
            "needs_book": [], "kind": None, "anchor": None, "path": "", "path_words": [], "wide": None,
            "ladder": None, "mirror": None, "joke_hidden": None, "sibling": None}
    if not (read["about"] if read["stands_alone"] else read["why"]):
        raise LLMError("the reading requires a summary when the line stands alone or a reason when it does not")
    if not read["stands_alone"]:
        return read
    kind, anchor = answer.get("kind"), answer.get("anchor")
    if ("kind" not in answer or "anchor" not in answer or isinstance(kind, bool)
            or not (kind is None or isinstance(kind, int)) or not (anchor is None or isinstance(anchor, str))):
        raise LLMError("the reading requires a kind (a number or null) and a main word (a word or null)")
    if kind is not None and kind not in KINDS:
        return None
    read.update(needs_book=_words(answer.get("needs_book"), "needs_book"), kind=kind,
                anchor=(anchor or "").strip() or None)
    if read["anchor"] is None:
        return read
    ladder, sibling = answer.get("ladder"), answer.get("sibling")
    if (not isinstance(answer.get("path"), str)
            or any(type(answer.get(k)) is not bool for k in ("wide", "mirror", "joke_hidden"))
            or answer["wide"] and "ladder" not in answer
            or not (ladder is None or isinstance(ladder, dict)
                    and all(ladder.get(k) is None or isinstance(ladder.get(k), str) for k in LADDER))
            or not (sibling is None or isinstance(sibling, str))):
        raise LLMError("the reading of a main word requires a path, the wide/mirror/joke_hidden verdicts, "
                       "and a ladder when the word is one of a wide kind")
    read.update(path=answer["path"].strip(), path_words=_words(answer.get("path_words"), "path_words"),
                wide=answer["wide"], mirror=answer["mirror"], joke_hidden=answer["joke_hidden"],
                ladder=None if ladder is None else {k: (ladder.get(k) or "").strip() or None for k in LADDER},
                sibling=(sibling or "").strip() or None)
    return read


def _words(value, field: str) -> list[str]:
    """A list of words in an answer (missing = none), stripped, the empty ones dropped."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(w, str) for w in value):
        raise LLMError(f"the reading's {field} must be a list of words")
    return [w.strip() for w in value if w.strip()]


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


def _through(words: list[str]) -> str:
    return ", ".join(f"« {w} »" for w in words)


def choose_companions(claude: Claude, marked_line: str, read: dict, notes: str, pool: list[dict],
                      refused: list[str], *, lang: str) -> dict | None:
    """The two words chosen AGAINST a line's MAIN word — the user's own method: the word he
    is sure of first, then two that work with it (the taste's *The three words*) — by its
    kind's *Holes and punch*. `marked_line`: the line, its main word in brackets; `read`: the
    line's read (its kind, the main word's path and ladder); `notes`: what code measured of
    the main word; `pool`: [{word, options: [{word, rank}]}], each word that can be hidden
    with it and the start words of its band; `refused`: what code told back of earlier
    choices. The verdicts are the model's; code checks them (`curate.choose_others`).
    Returns {"words": [{word, path, path_words, mirror, wide, ladder, lands}, two], "why"}
    (a ladder only for a word of a wide kind), or {"words": None, "why"} when the model
    declines; None when the answer is unusable."""
    again = ("\nRefused so far — never choose a refused word again, and mind what held against the three:\n"
             + "\n".join(f"- {r}" for r in refused) + "\n") if refused else ""
    kind = read["kind"]
    built = f"Its kind: {kind}. {KINDS[kind]}." if kind else "Its kind: none of the seven."
    main = f"Its MAIN word « {read['anchor']} »: {read['path']} (through {_through(read['path_words'])})"
    if read["wide"]:
        main += f"\n  one of a wide kind: {ladder_text(read['ladder'])}"
    rule = f"the *Holes and punch* of kind {kind}, *{KINDS[kind]}*" if kind else "*Lines that fit no kind*"
    listing = "\n".join(f"- « {p['word']} »: " + ", ".join(f"{o['word']} ({o['rank']})" for o in p["options"])
                        for p in pool)
    answer = claude.json(f"""You choose the hidden words of a day for a daily {LANGUAGE[lang]} word game, its main word
already chosen. One line, three words hidden; the player rebuilds each from how close every guess
lands, starting from a START word chosen later. A word once found stays revealed and becomes
context for the others.

What makes a day worth playing:
{taste()}

The game's laws and practical rules:
{laws()}

The line, from one work, its main word in brackets:

« {marked_line} »

{built}
{main}
  measured: {notes}

The words that can be hidden with it, each with the start words its band offers (word (rank), closest first):
{listing}
{again}
Choose TWO of these words AGAINST the main word, by the taste's *The three words* — not too
close, not too easy, not too hard, a good start word in its band, balancing the line, fun to
find — and by {rule}. For each: its path in one line, and the 1 to 3 words of the line it runs
through (single words of the line, never the word itself); by *No mirror*, whether it is the
first word players would type as the partner of a visible word; by *The narrowing ladder*,
whether it is one member of a wide kind and, if so, its ladder (null for a missing step); and
what it does when it lands. Decline when no two of these words go with this main word.

Return {{"words": [{{"word": "<a word offered>", "path": "<one line: how the line leads to it>", "path_words": ["<a word of the line>", ...], "mirror": true/false, "wide": true/false, "ladder": {{"slot": "<the kind the slot shapes>" or null, "family": "<the smaller family a start can name>" or null, "first": "<the first member players name there, or how the ranks climb to it>" or null}} or null, "lands": "<one line: what it does when it lands>"}}, <the second, the same>], "why": "<one line: the day as the player will get it>"}},
or {{"words": null, "why": "<one line>"}} to decline.""")
    if not isinstance(answer, dict):
        return None
    words = answer.get("words")
    if words is None and "words" in answer:
        return {"words": None, "why": str(answer.get("why") or "")}
    if not isinstance(words, list) or len(words) != 2:
        return None
    out = []
    for w in words:
        if not isinstance(w, dict):
            return None
        ladder, path_words = w.get("ladder"), w.get("path_words")
        if (not isinstance(w.get("word"), str) or not w["word"].strip() or not isinstance(w.get("path"), str)
                or not isinstance(path_words, list) or not all(isinstance(x, str) for x in path_words)
                or type(w.get("mirror")) is not bool or type(w.get("wide")) is not bool
                or w["wide"] and "ladder" not in w
                or not (ladder is None or isinstance(ladder, dict)
                        and all(ladder.get(k) is None or isinstance(ladder.get(k), str) for k in LADDER))):
            return None
        out.append({"word": w["word"].strip(), "path": w["path"].strip(),
                    "path_words": [x.strip() for x in path_words if x.strip()], "mirror": w["mirror"],
                    "wide": w["wide"],
                    "ladder": ({k: (ladder.get(k) or "").strip() or None for k in LADDER}
                               if w["wide"] and ladder is not None else None),
                    "lands": str(w.get("lands") or "").strip()})
    return {"words": out, "why": str(answer.get("why") or "")}


def choose_among(claude: Claude, days: list[dict], *, lang: str) -> dict | None:
    """The day, chosen by COMPARISON among FINISHED candidates (user-decided 2026-10-13):
    each `days` entry is a line whose three words were chosen and checked — {"marked": the
    line with its hidden words in brackets, "kind": its kind (`KINDS`) or None, "words":
    [{"word", "path", "path_words", "tags"}], the main word first, then the two chosen
    against it, each with what leads to it and code's facts about it}. The model orders
    them, best day first, leaving out any that would not make a day worth playing. Returns
    {"order": [indices], "why": str} (an empty order declines them all), or None when the
    answer is unusable."""
    listing = "\n\n".join(
        f"{n}. « {d['marked']} »\n   {kind_text(d['kind'])}"
        + "".join(f"\n   - {'main word ' if i == 0 else ''}« {w['word']} »: {w['path']} (through "
                  f"{_through(w['path_words'])})" + (f"; {', '.join(w['tags'])}" if w["tags"] else "")
                  for i, w in enumerate(d["words"]))
        for n, d in enumerate(days, 1))
    answer = claude.json(f"""You choose tomorrow's day for a daily {LANGUAGE[lang]} word game. One line, three words hidden;
the player rebuilds each from how close every guess lands, starting from a START word
chosen later. A word once found stays revealed and becomes context for the others.

What makes a day worth playing:
{taste()}

Below are candidate days from one work. Each line's three hidden words (in [brackets]) were
already chosen and checked on readers: under the line, its kind, then its main word and the two
words chosen against it, each with what leads to it, the words of the line its path runs
through, and what code measured of it.

{listing}

Compare them as the player will get them, and order them, best day first. A line with no kind
goes first only when, read aloud, it beats the built ones. Leave out any that would not make a
day worth playing.

Return {{"order": [<number>, ...], "why": "<one line: what makes the first one the best day>"}}.""")
    order = answer.get("order")
    if not isinstance(order, list):
        return None
    picked: list[int] = []
    for n in order:
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= len(days) or n - 1 in picked:
            return None
        picked.append(n - 1)
    return {"order": picked, "why": str(answer.get("why") or "")}


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
    was calibrated on real play (`rules.WOULD_SAY_HARD`); English adds who its players
    are (`AUDIENCE`)."""
    shown = holed(tokens, blanks, mark, lang=lang)
    answer = claude.json(f"""You judge one hidden word of a daily {LANGUAGE[lang]} word game. The player sees this line with the
word hidden and rebuilds it by guessing: each guess tells them how close it is in meaning.
Players think by association; most get roughly what goes there, and type words around its
meaning. The question here is the LAST step.

« {shown} »

The hidden word is « {word} ».

A player who has understood roughly what goes there and is typing words around its meaning:
would they ever say THIS word? Or would they keep saying commoner words that mean nearly
the same, and never think of this one?{AUDIENCE[lang]}

Return {{"instead": "<the commoner word they would keep saying, or null when this is the word they'd say>", "would_say": <the chance, 0 to 1, that such a player comes up with this exact word>}}""")
    chance = answer.get("would_say") if isinstance(answer, dict) else None
    instead = answer.get("instead") if isinstance(answer, dict) else None
    if isinstance(chance, bool) or not isinstance(chance, (int, float)) or not 0 <= chance <= 1:
        chance = None
    return chance, instead.strip() if isinstance(instead, str) and instead.strip() else None


def neighbours_complete(claude: Claude, fragment: str, *, lang: str) -> str | None:
    """The words right around a hole, the rest of the line hidden (`rules.neighbourhood`):
    the word most speakers write in the blank first. When it is the hidden word, the
    neighbours alone hand the hole over — « le droit de ___ » is « vote », « cinq semaines
    de ___ payés » « congés » — and it is no search (user-decided 2026-10-13). The share
    the model gives is not asked: told the word or not, it hedges (« vote » at 0.3,
    « cardiaque » after « arrêt » at 0.3); its FIRST word is the measure. None when the
    answer is unusable."""
    answer = claude.json(f"""A fragment of a sentence in {LANGUAGE[lang]}, one word missing:

« {fragment} »

Which single word do most {LANGUAGE[lang]} speakers write in the blank first, without thinking — the word
the words around it call for?

Return {{"word": "<one word>"}}""")
    word = answer.get("word") if isinstance(answer, dict) else None
    return word.strip() if isinstance(word, str) and word.strip() else None


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


def start_ideas(claude: Claude, sentence: str, starts: list[dict], *,
                lang: str) -> tuple[dict[str, str], set[str]]:
    """Each start's FIRST idea, read where it stands in the displayed sentence, and whether
    its hidden word shares it — the taste's one-idea rule (user-decided 2026-10-14, after
    « berceau » for « cercueil »). `starts`: [{start, secret}]. Returns (riddles, judged):
    {start word: why} for every RIDDLE, a start its hidden word shares only a side meaning
    with; and the starts the answer gave a real verdict for. A start missing from `judged`
    was not judged: an unusable answer refuses nothing, and is never read as a pass."""
    blocks = "\n".join(f"- « {s['start']} » stands where the hidden word « {s['secret']} » is" for s in starts)
    answer = claude.json(f"""You check the START words of a daily {LANGUAGE[lang]} word game. Each start word stands in the
sentence in place of a hidden word: it is the player's first clue, and the player's guesses
set off from it toward the hidden word.

The sentence as the player first sees it:
« {sentence} »

{blocks}

The rule:
{start_idea_rule()}

For each start word, read it where it stands, as {A_LANGUAGE[lang]} reader would, and name the FIRST
idea it brings there. Does its hidden word share that idea? A start the hidden word shares
only a side meaning with — while the start's stronger ideas lead elsewhere — is a riddle.

Return {{"starts": [{{"start": "<start word>", "idea": "<its first idea there>", "shared": true/false, "why": "<one line>"}}, ...]}}.""")
    items = answer.get("starts") if isinstance(answer, dict) else None
    # The start as the answer echoes it, matched whatever its case or quotes.
    known = {s["start"].strip().lower(): s["start"] for s in starts}
    riddles: dict[str, str] = {}
    judged: set[str] = set()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("start"), str):
            continue
        start = known.get(item["start"].strip().strip("«»").strip().lower())
        shared = item.get("shared")
        if start is None or not isinstance(shared, bool):
            continue
        judged.add(start)
        if shared:
            continue
        idea = str(item.get("idea") or "").strip()
        why = str(item.get("why") or "").strip()
        riddles[start] = ((f"a riddle: its first idea there, {idea}, is not one its hidden word shares"
                           if idea else "a riddle: its first idea there is not one its hidden word shares")
                          + (f" ({why})" if why else ""))
    return riddles, judged


# A banked line's starts were chosen on the free map, before the ranking (`curate --bank`):
# finishing it shows each to the start step, kept unless the ranked map moved it out or
# offers better (user-decided 2026-10-18).
PRIOR_RULE = """
A hole may show the start chosen for it before this map was ranked. Keep it when it is
still a candidate, unless another candidate here is clearly the better start by the
taste; when it is no longer a candidate, choose another."""


def _start_rule(kind: int | None) -> str:
    """Where each hole's start comes from, by its role and the line's kind (the taste's *The
    start words*)."""
    main = (f"the *Start words* of its kind, kind {kind}, *{KINDS[kind]}*" if kind
            else "the taste's *The start words* (the line has no kind)")
    return (f"The main word's start comes first, by {main}. Then the two others' starts, so the day is "
            "neither handed over nor out of reach. For a word of a wide kind, main or not, a start whose FIRST "
            "idea names its ladder's smaller family, never the whole kind.")


def _hole_block(h: dict) -> str:
    """One hole as the start step reads it: the hidden word and its role, its path, its ladder
    when it is one of a wide kind, and what code measured."""
    role = "the MAIN word" if h["role"] == "main" else "one of the two others"
    block = (f"Hole « {h['secret']} », {role} (slot: {h.get('slot', 'as the hidden word')})\n"
             f"  its path: {h['path']['line']} (through {_through(h['path']['words'])})")
    if h.get("ladder"):
        block += f"\n  one of a wide kind: {ladder_text(h['ladder'])}"
    return block + f"\n  measured: {h.get('notes', 'nothing')}"


def pick_starts(claude: Claude, sentence_marked: str, holes: list[dict], kind: int | None, *, lang: str) -> dict:
    """The three start words, chosen by the taste, the main word's first by the line's kind
    (`kind`, `KINDS`, or None), then the two others' so the day is neither handed over nor out
    of reach. `holes`: [{secret, slug, role ("main" or "other"), path: {line, words}, ladder,
    slot, notes, options: [{word, rank}], prior}], the main word first — `notes` is what code
    measured (what a reader puts in the blank, how much the line gives of the word, where the
    reader's words land in the hole's own map). The model may instead name ONE hidden word no
    candidate gives a path to (`unsaveable`, its slug). Returns {"starts": {slug: word},
    "unsaveable": slug | None, "why": str}; starts only from the options."""
    blocks = []
    for h in holes:
        block = (_hole_block(h) + "\n  start candidates (word (rank), closest first): "
                 + ", ".join(f"{o['word']} ({o['rank']})" for o in h["options"]))
        if h.get("prior"):
            p = h["prior"]
            where = ("not on this map" if p["rank"] is None else f"rank {p['rank']} on this map") + (
                ", still a candidate" if p["candidate"] else ", no longer a candidate: choose another")
            named = (f"« {p['word']} »" if p.get("banked", p["word"]) == p["word"]
                     else f"« {p['banked']} », shown here as « {p['word']} »")
            block += f"\n  chosen before this map was ranked: {named} ({where})"
        blocks.append(block)
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

{chr(10).join(blocks)}

{_start_rule(kind)}{PRIOR_RULE if any(h.get("prior") for h in holes) else ""} If no candidate gives a hidden word a path
— none links to it in its everyday sense (only by spelling, or not at all), or the word is dead or
out of reach whatever its start — name that word instead of starts.

Return {{"starts": {{"<hidden word>": "<chosen candidate, exactly>", ...}}, "why": "<one line per hole: what the start says of the word>"}},
or {{"unsaveable": "<hidden word>", "why": "<one line>"}}.""")
    if not isinstance(answer, dict):
        answer = {}
    named = answer.get("unsaveable")
    unsaveable = next((h["slug"] for h in holes if isinstance(named, str) and named.strip() in (h["secret"], h["slug"])),
                      None)
    if unsaveable:
        return {"starts": {}, "unsaveable": unsaveable, "why": str(answer.get("why") or "")}
    chosen = answer.get("starts", {}) if isinstance(answer.get("starts"), dict) else {}
    out: dict[str, str] = {}
    for h in holes:
        word = chosen.get(h["secret"]) or chosen.get(h["slug"])
        if isinstance(word, str) and word in {o["word"] for o in h["options"]}:
            out[h["slug"]] = word
    return {"starts": out, "unsaveable": None, "why": str(answer.get("why") or "")}


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




def pick_start(claude: Claude, sentence_marked: str, hole: dict, options: list[dict], refused: str = "",
               *, kind: int | None, lang: str, others: list[dict] | None = None) -> str | None:
    """One hole's start, chosen again after a refusal, reading the day as `pick_starts` does:
    `hole` is its block ({secret, role, path, ladder, notes}), `kind` the line's, `others`
    [{secret, role, start | None, notes}] the other holes as the day stands. Returns a
    candidate, exactly, or None."""
    listing = ", ".join(f"{o['word']} ({o['rank']})" for o in options)
    rest = ""
    if others:
        rest = "\nThe other holes, as the day stands:\n" + "\n".join(
            f"Hole « {o['secret']} », " + ("the MAIN word" if o["role"] == "main" else "one of the two others")
            + ", " + (f"shown as « {o['start']} »" if o.get("start") else "no start yet")
            + f"\n  measured: {o.get('notes') or 'nothing'}" for o in others) + "\n"
    answer = claude.json(f"""You curate a daily {LANGUAGE[lang]} word game: three words of a sentence are hidden and the
player rediscovers each from embedding-neighbour feedback. One hole's START word (its
first clue, shown in place of the hidden word « {hole['secret']} ») was refused: {refused or 'it did not belong in the sentence'}.
Choose another, following these rules:

{start_rules()}

And this taste (the start words part above all):
{taste()}

The start word replaces the hidden word: same part of speech, agreeing with its
surroundings ({AGREEMENT[lang]}). Read the sentence with your choice in
place before answering.

The sentence, the hole marked [____]:
{sentence_marked}

{_hole_block(hole)}
  candidates (word (rank), closest first): {listing}
{rest}
{_start_rule(kind)}

Return {{"word": "<one candidate, exactly>"}} or {{"word": null}} if none leaves correct {LANGUAGE[lang]} that still means something.""")
    word = answer.get("word")
    return word if isinstance(word, str) and word in {o["word"] for o in options} else None
