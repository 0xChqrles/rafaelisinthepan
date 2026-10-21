"""The bank: a finished line kept as JSON comes back as the run held it, the main word first,
each word with its other-sense check, and finishing it reads it against today's archive; a
line set aside is kept with why and its inputs; the page lists the lines by kind; `--rebank`
reads them again and chooses their words again, the main word first, with no judge."""

from datetime import date
import json
from types import SimpleNamespace

import pytest

import _paths
import bank
import curate
from rules import Token

SENTENCE = "The old dog sleeps under the warm stove"
STAMP = bank.taste_stamp()   # the taste the lines here were read under


def _tokens(sentence, lang):
    words = sentence.split()
    return [Token(i, w, w.lower(), "NOUN" if i in (2, 6, 7) else "ADJ" if i in (1, 5) else "VERB" if i == 3
                  else "DET", w.lower(), stop=i in (0, 4, 5)) for i, w in enumerate(words)]


@pytest.fixture
def fake_parse(monkeypatch, tmp_path):
    monkeypatch.setattr(bank, "parse", _tokens)
    monkeypatch.setattr(_paths, "BANK_DIR", tmp_path)


# A reading as `llm.read_line` returns it (`curate.read`).
_READ = {"about": "a dog asleep by the stove", "stands_alone": True, "why": "", "needs_book": [], "kind": 3,
         "anchor": "stove", "path": "where a dog sleeps warm", "path_words": ["dog"], "wide": False, "ladder": None,
         "mirror": False, "joke_hidden": True, "sibling": "oven"}
_GIVEN = {"old": 0.3, "dog": 0.5, "sleeps": 0.4, "stove": 0.2, "warm": 0.35}
_LADDER = {"slot": "a state", "family": "rest", "first": "the first named"}
# Each word's other-sense check (`curate.sense`): « old » loses two words of its other sense.
_SENSES = {"stove": {"used": "a cooker", "carried": True, "why": "cookers stand near", "off": []},
           "old": {"used": "aged", "carried": True, "why": "", "off": ["former", "erstwhile"]},
           "sleeps": {"used": "rests", "carried": True, "why": "", "off": []}}


def _finished():
    """A line finished as the run holds it: « stove » its main word, « old » and « sleeps »
    chosen against it, « sleeps » one of a wide kind."""
    tokens = _tokens(SENTENCE, "en")
    allowed = [t for t in tokens if t.slug in _GIVEN]
    line = {**curate.new_line(SENTENCE, tokens, allowed, dict(_GIVEN)), "read": _READ, "senses": dict(_SENSES)}
    line["measures"] = curate.Measures(readings={"old": (["young", "tired"], "young")}, says={"old": (0.8, None)},
                                       crowds={"old": 0.1}, frames={"old": [("the ___", "man")]})
    of = {t.slug: t for t in allowed}
    checked = curate.Checked([of["stove"], of["old"], of["sleeps"]],
                             {"stove": {"line": "where a dog sleeps warm", "words": ["dog"]},
                              "old": {"line": "a dog's age", "words": ["dog"]},
                              "sleeps": {"line": "what it does", "words": ["dog"]}},
                             {"sleeps": _LADDER}, {"stove": "notes"},
                             {"stove": ["the line gives little of it"], "old": [], "sleeps": ["one of a wide kind"]})
    return line, checked


def _started():
    words = SENTENCE.lower().split()
    holes = [{"pos": i, "secret": {"word": w, "slug": w}, "start": {"word": s, "slug": s}, "start_rank": r}
             for i, (w, s, r) in {1: ("old", "young", 120), 3: ("sleeps", "naps", 150), 7: ("stove", "oven", 101)}.items()]
    return {"starts": {"old": "young", "sleeps": "naps", "stove": "oven"},
            "draft": {"words": words, "holes": holes, "ranks": {}}}


def _archive(**over):
    return {"sentences": set(), "secrets": set(), "works": [], "pairs": {}, "last_used": {}, "last_music": None,
            **over}


def _entry(**over):
    line, checked = _finished()
    return {**bank.entry({"file": "a.epub", "kind": "book", "author": "A", "title": "T"}, line, checked, _started(),
                         "en", STAMP), **over}


_RESTORE = ("en", lambda s: True, lambda t: None, curate.Measures, curate.Checked)


def test_a_banked_line_comes_back_as_the_run_held_it_the_main_word_first(fake_parse):
    line, checked = _finished()
    bank.append("en", [_entry()])
    [stored] = bank.load("en")
    assert json.loads(json.dumps(stored)) == stored
    assert stored["taste"] == STAMP and len(STAMP) == 8
    assert stored["read"] == {"kind": 3, "anchor": "stove", "about": "a dog asleep by the stove",
                              "path": "where a dog sleeps warm", "pathWords": ["dog"], "wide": False, "ladder": None,
                              "sibling": "oven", "needsBook": []}
    assert stored["trio"] == ["stove", "old", "sleeps"]
    assert [(h["slug"], h["role"]) for h in stored["holes"]] == [("stove", "main"), ("old", "other"), ("sleeps", "other")]
    assert bank.chosen(stored)
    restored, why = bank.restore(stored, _archive(), *_RESTORE)
    assert why is None
    line2, checked2 = restored
    assert [t.slug for t in checked2.trio] == ["stove", "old", "sleeps"]
    assert (checked2.paths, checked2.ladders, checked2.context, checked2.tags) == \
        (checked.paths, checked.ladders, checked.context, checked.tags)
    assert line2["measures"] == line["measures"] and line2["given"] == line["given"]
    assert stored["senses"] == _SENSES and line2["senses"] == _SENSES
    assert line2["read"] == _READ
    assert bank.works("en") == {"a.epub"}


def test_finishing_refuses_a_line_set_aside_unchosen_published_or_with_a_word_back_in_its_cooldown(fake_parse):
    e = json.loads(json.dumps(_entry()))
    assert bank.restore(e, _archive(sentences={bank.shelf_mod.sentence_key(SENTENCE)}), *_RESTORE) == \
        (None, "the sentence was published")
    restored, why = bank.restore(e, _archive(secrets={"stove"}), *_RESTORE)
    assert restored is None and "stove" in why and "cooldown" in why
    restored, why = bank.restore({**e, "dropped": "a mirror: « stove »"}, _archive(), *_RESTORE)
    assert restored is None and why == "it was set aside: a mirror: « stove »"
    # a line whose words were chosen before the main word came first: no back-compat, --rebank
    old = {**e, "holes": [{k: v for k, v in h.items() if k != "role"} for h in e["holes"]]}
    restored, why = bank.restore(old, _archive(), *_RESTORE)
    assert restored is None and "--rebank" in why and not bank.chosen(old)
    # a line whose words were chosen before their other sense was asked: its starts were chosen on
    # another map than the one its puzzle would have
    unsensed = {k: v for k, v in e.items() if k != "senses"}
    assert bank.restore(unsensed, _archive(), *_RESTORE) == \
        (None, "its words have no other-sense check: `--rebank` takes it")
    assert bank.restore({**e, "senses": {"stove": _SENSES["stove"]}}, _archive(), *_RESTORE)[0] is None


def test_the_bank_keeps_the_calendar_s_mix_and_spreads_over_authors():
    today = date(2026, 10, 18)
    song = lambda f, a: {"file": f, "kind": "music", "author": a, "title": f}
    book = lambda f, a: {"file": f, "kind": "book", "author": a, "title": f}
    fresh = [song("s1", "X"), song("s2", "Y"), book("b1", "A"), book("b2", "B")]
    pick = lambda banked: curate.bank_pick(fresh, banked, _archive(), {"books": {}}, today)[0]
    assert pick([])["kind"] == "music"
    assert pick([song("s0", "X")])["kind"] == "book"
    # the song's turn: the artist with no banked song yet
    assert pick([song("s0", "X"), book("b0", "A"), book("b9", "C"), book("b8", "D")]) == song("s2", "Y")


def test_an_artist_s_next_song_waits_for_a_month_of_banked_works():
    today = date(2026, 10, 18)
    song = lambda f: {"file": f, "kind": "music", "author": "X", "title": f}
    book = lambda f: {"file": f, "kind": "book", "author": f, "title": f}
    fresh = [song("s1"), book("fresh")]
    pick = lambda banked: curate.bank_pick(fresh, banked, _archive(), {"books": {}}, today)[0]
    few = [song("s0")] + [book(f"b{i}") for i in range(10)]
    assert pick(few)["kind"] == "book"
    month = [song("s0")] + [book(f"b{i}") for i in range(curate.lyr.ARTIST_COOLDOWN_DAYS)]
    assert pick(month)["kind"] == "music"


def test_a_claimed_work_is_taken_until_released(fake_parse):
    assert bank.claimed("en") == set()
    bank.claim("en", "a.epub")
    bank.claim("en", "b.epub")
    assert bank.claimed("en") == {"a.epub", "b.epub"}
    bank.unclaim("en", "a.epub")
    assert bank.claimed("en") == {"b.epub"}


def test_the_lock_is_re_entrant_within_a_process(fake_parse):
    with bank.locked("en"):
        bank.claim("en", "a.epub")  # takes the lock again: must not wait on itself
        bank.append("en", [_entry()])
        assert bank.works("en") == {"a.epub"}


def test_a_claim_dies_with_its_process(fake_parse):
    import subprocess, sys
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    bank.claims_file("en").write_text(f"dead.epub\t{gone.pid}\nlegacy.epub\n", encoding="utf-8")
    bank.claim("en", "mine.epub")
    assert bank.claimed("en") == {"legacy.epub", "mine.epub"}
    bank.unclaim("en", "mine.epub")
    assert bank.claimed("en") == {"legacy.epub"}


def test_a_work_that_banked_nothing_stays_mined_but_holds_no_line(fake_parse):
    bank.append("en", [bank.empty({"file": "dry.epub", "kind": "book"}), _entry()])
    assert bank.works("en") == {"dry.epub", "a.epub"}
    assert [e["work"] for e in bank.lines("en")] == ["a.epub"]


def test_a_banked_line_keeps_each_word_s_role_path_facts_and_start(fake_parse):
    e = _entry()
    assert e["id"] == bank.line_id("a.epub", SENTENCE) and len(e["id"]) == 8
    assert e["starts"] == {"old": "young", "sleeps": "naps", "stove": "oven"}
    assert e["marked"] == "the [old] dog [sleeps] under the warm [stove]"
    assert e["shown"] == "the young dog naps under the warm oven"
    assert [(h["secret"], h["role"], h["path"], h["pathWords"], h["ladder"], h["tags"], h["start"], h["startRank"])
            for h in e["holes"]] == [
        ("stove", "main", "where a dog sleeps warm", ["dog"], None, ["the line gives little of it"], "oven", 101),
        ("old", "other", "a dog's age", ["dog"], None, [], "young", 120),
        ("sleeps", "other", "what it does", ["dog"], _LADDER, ["one of a wide kind"], "naps", 150)]
    assert e["measures"] == {"readings": {"old": (["young", "tired"], "young")}, "says": {"old": (0.8, None)},
                             "crowds": {"old": 0.1}, "frames": {"old": [("the ___", "man")]}}
    assert not {"chain", "swaps", "levels"} & set(e)


def _aside(sentence="A cat. It sleeps.", why="does not stand alone: which cat?", **line):
    return bank.aside({"file": "b.epub", "kind": "book", "author": "B", "title": "U"},
                      {"sentence": sentence, "read": {**_READ, "stands_alone": False, "why": "which cat?",
                                                      "anchor": None}, "dropped": why, **line}, "en", STAMP)


def test_a_line_set_aside_counts_as_mined_but_is_no_line_and_keeps_its_inputs(fake_parse):
    line, _ = _finished()
    struck = bank.aside({"file": "a.epub", "kind": "book", "author": "A", "title": "T"},
                        {**line, "dropped": "no two words against the main word survived 3 asks"}, "en", STAMP)
    bank.append("en", [_aside(), struck])
    assert bank.works("en") == {"a.epub", "b.epub"} and bank.lines("en") == []
    [_, stored] = bank.load("en")
    assert stored["dropped"].startswith("no two words") and stored["read"]["anchor"] == "stove"
    assert stored["given"] == _GIVEN and stored["measures"]["says"] == {"old": [0.8, None]}
    assert stored["senses"] == _SENSES                     # asked once: a rebank asks none of them again
    assert not bank.chosen(stored) and "holes" not in stored


def test_a_work_s_entries_are_replaced_in_place_and_nothing_else_moves(fake_parse):
    one = _entry()
    two = {**one, "id": "two"}
    bank.append("en", [one, two, bank.empty({"file": "dry.epub", "kind": "book"}), _aside()])
    new = {**one, "id": "new"}
    bank.replace_work("en", "a.epub", [new])
    assert [(e["work"], e.get("id")) for e in bank.load("en")] == \
        [("a.epub", "new"), ("dry.epub", None), ("b.epub", _aside()["id"])]
    assert not bank.bank_file("en").with_name("en.jsonl.tmp").exists()


def _unchosen(**over):
    """A line banked before the main word came first: its words carry no role."""
    e = _entry(**over)
    return {**e, "holes": [{k: v for k, v in h.items() if k != "role"} for h in e["holes"]]}


def test_stale_lines_are_those_unread_read_under_another_taste_or_waiting_for_their_words(fake_parse):
    current = _entry()
    older = _entry(id="older", taste="00000000")
    unread = {k: v for k, v in _unchosen(id="unread").items() if k not in ("taste", "read")}
    waiting = _unchosen(id="waiting")
    unsensed = {k: v for k, v in _entry(id="unsensed").items() if k != "senses"}
    struck = _aside(sentence="x", given=dict(_GIVEN))
    struck_older = {**_aside(sentence="y", given=dict(_GIVEN)), "id": "struckolder", "taste": "00000000"}
    bank.append("en", [current, older, unread, waiting, unsensed, _aside(), struck, struck_older])
    # a line set aside before its giveaway was paid can be taken again by nothing: no word was judged
    assert [e["id"] for e in bank.stale("en")] == ["older", "unread", "waiting", "unsensed", "struckolder"]


def test_the_page_lists_the_lines_by_kind_then_no_kind_then_set_aside_then_waiting(fake_parse):
    base = _entry()
    pairs = {**base, "id": "pairs1", "read": {**base["read"], "kind": 1}}
    fact = {**base, "id": "fact3"}
    loose = {**base, "id": "nokind", "read": {**base["read"], "kind": None}}
    waiting = _unchosen(id="waiting")
    unsensed = {**{k: v for k, v in base.items() if k != "senses"}, "id": "unsensed"}
    bank.append("en", [loose, fact, waiting, _aside(), pairs, unsensed])
    bank.render("en")
    page = bank.view_file("en").read_text(encoding="utf-8")
    order = [page.index(h) for h in ("## 1. Pairs and molds", "`pairs1`", "## 3. The small fact that proves a big thing",
                                     "`fact3`", "## No kind", "`nokind`", "## Set aside",
                                     "## Waiting for a rebank", "`waiting`", "`unsensed`")]
    assert order == sorted(order)
    assert "3 line(s) kept, 1 set aside, 2 waiting for a rebank, from 2 work(s)" in page
    assert "## 2." not in page                                          # an empty kind is not listed
    rows = page[page.index("`fact3`"):page.index("## No kind")]
    assert "  - main word « stove »: where a dog sleeps warm (through « dog »)" in rows
    assert "  - sibling: « oven » makes the same joke (a warning)" in rows
    assert "  - « old »: a dog's age (through « dog »)" in rows
    assert "  - « sleeps »: what it does (through « dog ») — one of a wide kind: a state › rest › the first named" in rows
    assert "**stove** ← oven (rank 101): the line gives little of it" in rows
    assert "old ← young (rank 120): other sense set aside: 2 words" in rows
    assert rows.rstrip().endswith("sleeps ← naps (rank 150): one of a wide kind")   # nothing set aside, nothing said
    assert "FLAG" not in page and "free-map" not in page
    assert "does not stand alone: which cat?" in page[page.index("## Set aside"):]
    assert ("2 line(s) were never read, were read under another taste, or wait for their words or their "
            "other-sense check") in page


# --- `--rebank`: the bank taken again, with no judge -----------------------------------------

def _old(sentence=SENTENCE, **over):
    """An entry as the bank kept it before the main word came first: its words picked side by
    side, with their levels, a chain, its swaps, the words swapped out — the trio « dog ·
    sleeps · stove » measured at banking."""
    m = {"readings": {s: [[], None] for s in ("dog", "sleeps", "stove")},
         "says": {s: [0.8, None] for s in ("dog", "sleeps", "stove")},
         "crowds": {s: None for s in ("dog", "sleeps", "stove")},
         "neighbours": {s: ["the ___", "man"] for s in ("dog", "sleeps", "stove")}, "out": ["old"]}
    return {"id": bank.line_id("a.epub", sentence), "bankedAt": "2026-10-18T10:00:00+00:00", "lang": "en",
            "work": "a.epub", "kind": "book", "author": "A", "title": "T", "sentence": sentence, "marked": "the old [dog] [sleeps] under the warm [stove]",
            "shown": "the old cat naps under the warm oven",
            "holes": [{"secret": s, "slug": s, "level": "medium", "start": "x", "startRank": 120}
                      for s in ("dog", "sleeps", "stove")],
            "starts": {"dog": "cat", "sleeps": "naps", "stove": "oven"}, "given": dict(_GIVEN),
            "trio": ["dog", "sleeps", "stove"], "chain": ["dog: first"], "swaps": 1, "context": {},
            "levels": {"dog": "medium"}, "measures": m, **over}


# Every word's plain map: the word, and one neighbour.
_SIMS = curate.Vectors(static_map=lambda t, off=frozenset(): {t.slug: {"word": t.text, "rank": 0},
                                                               "near": {"word": "near", "rank": 1}})


def _free_maps(monkeypatch):
    """The maps, faked: every word's band offers « <word>-start » at 150, and the draft the
    start step reads is the line with its holes; each word's other sense is asked, and its map
    carries the line's sense with nothing set aside."""
    monkeypatch.setattr(curate, "band_of", lambda line, t, sims, pairs, lang: [{"word": f"{t.slug}-start", "rank": 150}])
    monkeypatch.setattr(curate.llm, "other_sense", lambda _c, _s, word, _words, lang, off=(): {
        "used": f"{word}, plainly", "other": False, "words": [], "carried": True, "why": ""})

    def draft(line, trio, sims, lang):
        holes = [{"pos": t.i, "secret": {"word": t.text, "slug": t.slug}, "start": {"word": t.text, "slug": t.slug},
                  "start_rank": 0} for t in trio]
        return {"words": [t.text.lower() for t in line["tokens"]], "holes": sorted(holes, key=lambda h: h["pos"]),
                "ranks": {t.slug: {f"{t.slug}-start": {"word": f"{t.slug}-start", "rank": 150}} for t in trio}}

    monkeypatch.setattr(curate, "static_draft", draft)
    monkeypatch.setattr(curate.llm, "pick_starts", lambda _c, _m, holes, kind, lang: {
        "starts": {h["slug"]: h["options"][0]["word"] for h in holes}, "unsaveable": None, "why": ""})
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda _c, _s, starts, lang: ({}, {s["start"] for s in starts}))


def _against_stove(monkeypatch):
    """Two words against « stove »: « old » and « sleeps », each with its path through « dog »."""
    asked = []
    monkeypatch.setattr(curate.llm, "choose_companions", lambda _c, marked, read, notes, pool, refused, lang: (
        asked.append([p["word"] for p in pool]),
        {"words": [{"word": w, "path": f"to {w}", "path_words": ["dog"], "mirror": False, "wide": False,
                    "ladder": None, "lands": ""} for w in ("old", "sleeps")], "why": "w"})[1])
    return asked


def test_a_rebank_reads_and_chooses_again_from_what_was_stored_and_never_asks_the_judge(fake_parse, monkeypatch,
                                                                                         tmp_path):
    import jev
    monkeypatch.setattr(jev, "giveaway", lambda *_a, **_k: pytest.fail("the rebank never asks the judge"))
    monkeypatch.setattr(curate, "parse", _tokens)
    monkeypatch.setattr(_paths, "RUNS_DIR", tmp_path / "runs")
    _free_maps(monkeypatch)
    companions = _against_stove(monkeypatch)
    read, measured = [], []
    verdicts = {SENTENCE: _READ, "The cold dog sleeps under the warm stove": {**_READ, "mirror": True},
                "The old dog sleeps under the hot stove": _READ}
    monkeypatch.setattr(curate.llm, "read_line", lambda _c, sentence, hideable, refused, lang:
                        read.append(hideable) or verdicts[sentence])
    monkeypatch.setattr(curate.llm, "context_guesses", lambda _c, toks, _b, mark, _n, lang:
                        measured.append(toks[mark].text) or ([], None))
    monkeypatch.setattr(curate.llm, "would_say", lambda _c, _t, _b, _m, word, lang: measured.append(word) or (0.8, None))
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda _c, fragment, lang: "man")
    unread = _old()                                                                 # never read
    waiting = _old("The old dog sleeps under the hot stove", taste=STAMP, read=bank.stored(_READ))   # read today
    mirror = _old("The cold dog sleeps under the warm stove")
    published = _old("The young dog sleeps under the warm stove")
    done = _entry(sentence="The old dog sleeps by the warm stove", id=bank.line_id("a.epub", "done"))
    bank.append("en", [unread, waiting, mirror, published, done, _aside()])
    args = SimpleNamespace(lang="en", work=None)
    archive = _archive(secrets={"warm"}, sentences={bank.shelf_mod.sentence_key(published["sentence"])})
    assert curate.rebank_works(object(), curate.Log("rebank"), args, archive, lambda s: True, _SIMS) == 0
    # the read is shown every word judged at banking, « warm » cooling today included (« cold »
    # never was); a line read under today's taste is not read again
    assert read == [["old", "dog", "sleeps", "warm", "stove"], ["dog", "sleeps", "warm", "stove"]]
    # the words are chosen from those out of their cooldown, the main word apart
    assert companions == [["old", "dog", "sleeps"], ["old", "dog", "sleeps"]]
    # what was measured at banking is never asked again: only « old », new to the trio
    assert sorted(measured) == ["old", "old", "old", "old"]
    after = {e.get("id"): e for e in bank.load("en")}
    assert [e.get("id") for e in bank.load("en")] == [e["id"] for e in (unread, waiting, mirror, published, done,
                                                                         _aside())]
    for key in (unread["id"], waiting["id"]):
        e = after[key]
        assert e["trio"] == ["stove", "old", "sleeps"] and [h["role"] for h in e["holes"]] == ["main", "other", "other"]
        assert e["starts"] == {"stove": "stove-start", "old": "old-start", "sleeps": "sleeps-start"}
        assert e["senses"]["old"] == {"used": "old, plainly", "carried": True, "why": "", "off": []}
        assert bank.finishable(e)
        assert e["bankedAt"] == "2026-10-18T10:00:00+00:00" and e["taste"] == STAMP
        assert not {"chain", "swaps", "levels", "dropped"} & set(e) and "out" not in e["measures"]
    assert after[mirror["id"]]["dropped"].startswith("a mirror") and after[mirror["id"]]["given"] == _GIVEN
    assert after[mirror["id"]]["measures"]["says"]["stove"] == [0.8, None]        # kept for a later rebank
    assert after[published["id"]]["dropped"] == "the sentence was published"
    assert after[done["id"]] == json.loads(json.dumps(done))                      # taken under today's taste
    assert bank.stale("en") == [] and bank.claimed("en") == set()
    # resumable: nothing left to take
    assert curate.rebank_works(object(), curate.Log("rebank2"), args, archive, lambda s: True, _SIMS) == 2
    assert len(read) == 2


def test_a_rebank_stamps_the_taste_taken_before_the_reads(fake_parse, monkeypatch):
    # the taste edited while the line is read: it keeps the stamp it was read under, and
    # the next rebank takes it again
    monkeypatch.setattr(curate, "parse", _tokens)
    _free_maps(monkeypatch)
    _against_stove(monkeypatch)
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda *_a, **_k: "man")
    monkeypatch.setattr(curate.llm, "context_guesses", lambda *_a, **_k: ([], None))
    monkeypatch.setattr(curate.llm, "would_say", lambda *_a, **_k: (0.8, None))

    def read_line(*_a, **_k):
        monkeypatch.setattr(bank, "taste_stamp", lambda: "edited0")
        return _READ

    monkeypatch.setattr(curate.llm, "read_line", read_line)
    [after] = curate.reread_work(object(), lambda *_: None, [_old()], _archive(), "en", lambda s: True, _SIMS)
    assert after["taste"] == STAMP and bank.is_stale(after, bank.taste_stamp())


def test_a_line_with_no_usable_reading_or_its_main_word_cooling_is_left_for_the_next_rebank(fake_parse, monkeypatch):
    monkeypatch.setattr(curate, "parse", _tokens)
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: None)   # a kind none of the seven, each time
    older = _old(dropped="a mirror: « stove »", taste="00000000")
    [after] = curate.reread_work(object(), lambda *_: None, [older], _archive(), "en", lambda s: True, curate.Vectors())
    assert after is older and bank.is_stale(after, STAMP)
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: _READ)
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("its words wait"))
    [after] = curate.reread_work(object(), lambda *_: None, [older], _archive(secrets={"stove"}), "en",
                                 lambda s: True, curate.Vectors())
    assert after is older


def test_a_rebank_sets_aside_a_line_of_a_published_work_with_no_call(fake_parse, monkeypatch):
    # `--finish` refuses a work already published (never the same work twice): nothing is paid
    monkeypatch.setattr(curate, "parse", _tokens)
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: pytest.fail("a published work is never read"))
    [after] = curate.reread_work(object(), lambda *_: None, [_old()], _archive(works=[{"author": "A", "work": "T"}]),
                                 "en", lambda s: True, curate.Vectors())
    assert after["dropped"] == "the work was published: never the same work twice"
    assert after["bankedAt"] == "2026-10-18T10:00:00+00:00" and not bank.is_stale(after, STAMP)


def test_a_line_set_aside_with_a_word_in_its_cooldown_left_out_waits_for_a_later_rebank(fake_parse, monkeypatch):
    # « dog » in its cooldown today: the words against « stove » are chosen without it, so the
    # line set aside then is left as it was; with nothing cooling, it is kept set aside
    monkeypatch.setattr(curate, "parse", _tokens)
    _free_maps(monkeypatch)
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: _READ)
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda *_a, **_k: "man")
    monkeypatch.setattr(curate.llm, "context_guesses", lambda *_a, **_k: ([], None))
    monkeypatch.setattr(curate.llm, "would_say", lambda *_a, **_k: (0.8, None))
    offered = []
    monkeypatch.setattr(curate.llm, "choose_companions", lambda _c, _m, _r, _n, pool, _t, lang: (
        offered.append([p["word"] for p in pool]), {"words": None, "why": "nothing goes"})[1])
    older, log = _old(), []
    [after] = curate.reread_work(object(), log.append, [older], _archive(secrets={"dog"}), "en", lambda s: True,
                                 curate.Vectors())
    assert offered == [["old", "sleeps", "warm"]]
    assert after is older and "- chosen without « dog », in their cooldown: left for a later rebank" in log
    [after] = curate.reread_work(object(), lambda *_: None, [older], _archive(), "en", lambda s: True,
                                 curate.Vectors())
    assert after["dropped"] == "no two words go with the main word: nothing goes" and after["taste"] == STAMP


def test_a_rebank_sets_aside_a_line_left_short_by_the_words_that_need_the_work(fake_parse, monkeypatch):
    monkeypatch.setattr(curate, "parse", _tokens)
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: {**_READ, "needs_book": ["old", "dog", "warm"]})
    [after] = curate.reread_work(object(), lambda *_: None, [_old()], _archive(), "en", lambda s: True,
                                 curate.Vectors())
    assert after["dropped"] == "fewer than 3 words can be hidden once those that need the work leave"
    assert after["read"]["needsBook"] == ["old", "dog", "warm"] and after["taste"] == STAMP


def test_a_rebank_never_asks_a_word_s_other_sense_twice(fake_parse, monkeypatch):
    # read under another taste, the line is read and its words chosen again: the other-sense
    # checks it carries are its words' own, and kept
    monkeypatch.setattr(curate, "parse", _tokens)
    _free_maps(monkeypatch)
    _against_stove(monkeypatch)
    monkeypatch.setattr(curate.llm, "other_sense", lambda *_a, **_k: pytest.fail("asked at banking already"))
    monkeypatch.setattr(curate.llm, "read_line", lambda *_a, **_k: _READ)
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda *_a, **_k: "man")
    monkeypatch.setattr(curate.llm, "context_guesses", lambda *_a, **_k: ([], None))
    monkeypatch.setattr(curate.llm, "would_say", lambda *_a, **_k: (0.8, None))
    older = json.loads(json.dumps(_entry(taste="00000000")))
    [after] = curate.reread_work(object(), lambda *_: None, [older], _archive(), "en", lambda s: True, _SIMS)
    assert after["taste"] == STAMP and after["senses"] == _SENSES and bank.finishable(after)
