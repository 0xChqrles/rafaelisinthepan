"""CONTRACT: other-sense words are taken off a sentence map (generation AGENTS.md
"Other-sense words").

A sentence map is the static walk's order; the line chooses the secret's sense only by
TAKING OFF the groups a player reaches through another sense of it:

  - an off word is read the way a player reaches it, by its slug on the first assembly;
    the group it reaches is taken off and the map assembled again without it;
  - a removed group claims no key and consumes no rank: the groups after it move up,
    and TOP_K still counts kept groups (filter-then-cap);
  - a surface a removed group held attaches to the next group that claims it, unless
    that group had no key before and is then SHOWN as an off word — the same word under
    another lexeme, taken off in turn; a group already on the map that gains it stays;
  - dq is quantized over the KEPT groups' similarities: rank 1 = 255, last = 0;
  - the secret's own group is never removed, and a word that reaches no group is
    ignored — both reported, neither touching the map;
  - no off words = the map exactly as before;
  - CLI: --other-sense needs --words and exactly the three secrets' slugs as keys, and
    dies before anything loads otherwise; the puzzle's sidecar
    <puzzle>.other-sense.json rebuilds the identical puzzle.

Synthetic tables and rankings only — never the real embeddings.
"""

import json

import pytest

import distances
import gen_phrase


FR = gen_phrase.CONFIG["fr"]

# «vers» is two words: the poetry line (vers:nc, its only form) and the worm's plural
# (ver:nc) — a homograph, so it ranks neither group cleanly. The poetry group and
# «strophe» stand for the neighbours of another sense.
TABLE = {
    "asticot": ("asticot:nc",),
    "asticots": ("asticot:nc",),
    "vers": ("ver:nc", "vers:nc"),
    "ver": ("ver:nc",),
    "larve": ("larve:nc",),
    "lombric": ("lombric:nc",),
    "strophe": ("strophe:nc",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)
VSET = set(TABLE)
# closest-first, as the walk hands it over
RANKING = [("vers", 0, 0.95), ("larve", 1, 0.90), ("ver", 2, 0.85),
           ("asticots", 3, 0.80), ("lombric", 4, 0.70), ("strophe", 5, 0.60)]


def _map(off=(), report=None):
    return gen_phrase.build_puzzle_rank_map(
        "asticot", RANKING, TABLE, FORMS, VSET, off=off, off_report=report)


def _ranked(merged):
    return [w for w, _r, _s in merged]


# --- the map ----------------------------------------------------------------------

def test_without_off_words_the_map_is_exactly_the_static_one():
    merged, rmap, groups = gen_phrase.build_merged_rank_map(
        "asticot", RANKING, TABLE, FORMS, VSET)
    gen_phrase.annotate_rank_map(rmap, merged)

    assert _map() == (merged, rmap, groups)
    assert _ranked(merged) == ["vers", "larve", "ver", "lombric", "strophe"]


def test_a_removed_group_claims_no_key_and_the_groups_after_it_move_up():
    report = {}
    merged, rmap, _groups = _map(off=["larve"], report=report)

    assert _ranked(merged) == ["vers", "ver", "lombric", "strophe"]
    assert "larve" not in rmap  # off the map: reads as far to the player
    assert [rmap[w]["rank"] for w in ("vers", "ver", "lombric", "strophe")] == [1, 2, 3, 4]
    assert report == {"removed": ["larve"], "ignored": []}


def test_a_surface_the_removed_group_held_goes_to_the_next_group_claiming_it():
    # «vers» first keys the poetry line at rank 1 (closer than the worm); taking that
    # group off hands the surface to the worm, which keys it from then on.
    static = _map()[1]
    assert static["vers"]["rank"] == 1 and static["ver"]["rank"] == 3
    report = {}
    merged, rmap, _groups = _map(off=["vers"], report=report)

    assert _ranked(merged) == ["larve", "ver", "lombric", "strophe"]
    assert rmap["vers"] == {"word": "ver", "rank": 2, "dq": rmap["ver"]["dq"]}
    assert rmap["ver"]["rank"] == 2
    assert report["removed"] == ["vers"]


def test_a_group_that_comes_back_shown_as_an_off_word_is_taken_off_too():
    # «rime» is the poetry noun and a form of the verb «rimer», both ranked by the same
    # vector: the noun keys it first and the verb, keyless, never opens. Taking the noun
    # off opens the verb SHOWN as «rime» — the same word back near its rank, typing warm —
    # so it is taken off in turn; a surface that only aliases another word stays (above).
    table = {**TABLE, "rime": ("rime:nc", "rimer:v")}
    ranking = [*RANKING, ("rime", 6, 0.50)]
    def build(off=(), report=None):
        return gen_phrase.build_puzzle_rank_map("asticot", ranking, table, gen_phrase.invert_lemmas(table),
                                                set(table), off=off, off_report=report)
    static = build()[1]
    assert static["rime"]["rank"] == 6
    report = {}
    merged, rmap, _groups = build(off=["rime"], report=report)

    assert _ranked(merged) == ["vers", "larve", "ver", "lombric", "strophe"]
    assert "rime" not in rmap
    assert report == {"removed": ["rime", "rime"], "ignored": []}


def test_a_group_already_on_the_map_that_gains_an_off_word_s_surface_stays():
    # «rime» keys the poetry noun; the verb «rimer», ranked by that same homograph (it has
    # no clean form), is already on the map under «rimait». Taking the noun off hands the
    # verb the surface and its display: it stays, at its own rank — only a group that had no
    # key before is taken off for coming back as an off word.
    table = {**TABLE, "rime": ("rime:nc", "rimer:v"), "rimait": ("rimer:v", "rimait:x")}
    ranking = [*RANKING, ("rime", 6, 0.50), ("rimait", 7, 0.45)]
    def build(off=(), report=None):
        return gen_phrase.build_puzzle_rank_map("asticot", ranking, table, gen_phrase.invert_lemmas(table),
                                                set(table), off=off, off_report=report)
    _m, static, groups = build()
    verb = next(r for _d, r, claims, *_ in groups if claims == ("rimer:v",))
    assert static["rime"]["rank"] == 6 and static["rimait"]["rank"] == verb
    report = {}
    merged, rmap, groups = build(off=["rime"], report=report)

    assert report["removed"] == ["rime"]
    assert rmap["rime"]["rank"] == rmap["rimait"]["rank"]  # the verb, at its own rank, keeps both


def test_dq_is_quantized_over_the_kept_groups():
    merged, rmap, _groups = _map(off=["vers", "strophe"])

    kept = [s for _w, _r, s in merged]
    assert kept == [0.90, 0.85, 0.70]  # each group's own representative similarity
    assert [rmap[w]["dq"] for w in ("larve", "ver", "lombric")] == \
        distances.quantize_dq(kept)
    assert rmap["larve"]["dq"] == 255 and rmap["lombric"]["dq"] == 0
    assert "dq" not in rmap["asticot"]


def test_top_k_counts_the_kept_groups(monkeypatch):
    monkeypatch.setattr(gen_phrase, "TOP_K", 3)
    assert _ranked(_map()[0]) == ["vers", "larve", "ver"]
    # filter-then-cap: the group taken off frees its place for the next one
    assert _ranked(_map(off=["larve"])[0]) == ["vers", "ver", "lombric"]


def test_any_case_and_every_removed_group_is_reported_closest_first():
    report = {}
    merged, _rmap, _groups = _map(off=["STROPHE", "Vers"], report=report)

    assert _ranked(merged) == ["larve", "ver", "lombric"]
    assert report == {"removed": ["vers", "strophe"], "ignored": []}


def test_the_secrets_own_group_is_never_removed_and_an_unknown_word_is_ignored():
    report = {}
    assert _map(off=["asticot", "asticots", "papillon"], report=report) == _map()
    assert report == {"removed": [], "ignored": ["asticot", "asticots", "papillon"]}


def test_a_word_past_top_k_has_no_key_and_is_ignored(monkeypatch):
    monkeypatch.setattr(gen_phrase, "TOP_K", 2)
    report = {}
    assert _map(off=["lombric"], report=report) == _map()
    assert report["ignored"] == ["lombric"]


def test_walk_secret_takes_the_off_words_through(monkeypatch):
    # The curator's walks and the sentence path both go through walk_secret.
    monkeypatch.setattr(FR["module"], "closest", lambda *_a: RANKING, raising=False)
    merged, rmap, groups = gen_phrase.walk_secret(
        "asticot", "asticot", FR, None, [], None, VSET, TABLE, FORMS,
        off=frozenset({"vers"}))

    assert _ranked(merged) == ["larve", "ver", "lombric", "strophe"]
    assert rmap["vers"]["rank"] == 2
    assert [g[0] for g in groups] == ["asticot", "larve", "ver", "lombric", "strophe"]


# --- the CLI ----------------------------------------------------------------------

SENTENCE = "Le chat poursuit le chat dans le jardin."
WORDS = ["jardin", "chat", "poursuit"]
VOCAB = ["chat", "poursuit", "jardin", "indice", "proche", "loin"]
WALK = [("indice", 0, 0.9), ("proche", 1, 0.8), ("loin", 2, 0.5)]


def _stub_run(monkeypatch, loaded=None):
    monkeypatch.setattr(FR["module"], "load_vectors",
                        lambda: (loaded.append("vectors") if loaded is not None else None)
                        or {w: [1.0, float(i)] for i, w in enumerate(VOCAB)},
                        raising=False)
    monkeypatch.setattr(FR["module"], "build_vocab", lambda _kv: VOCAB, raising=False)
    monkeypatch.setattr(FR["module"], "build_matrix", lambda _kv, _v: object(),
                        raising=False)
    monkeypatch.setattr(FR["module"], "closest", lambda *_a: WALK, raising=False)
    monkeypatch.setattr(gen_phrase, "load_lemma_table",
                        lambda _lang, disabled=False: {})
    monkeypatch.setattr(gen_phrase, "write_vocab", lambda *_a, **_k: None)
    # the start is the nearest kept group: what the map ships decides it
    monkeypatch.setattr(gen_phrase, "choose_start",
                        lambda _secret, merged, _rmap, _rbd: merged[0][0])
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)


def _main(monkeypatch, out_dir, *flags, words=WORDS):
    argv = ["gen_phrase.py", SENTENCE, "--lang", "fr", "--no-inflect",
            "--out-dir", str(out_dir), *flags]
    if words is not None:
        argv += ["--words", *words]
    monkeypatch.setattr(gen_phrase.sys, "argv", argv)
    gen_phrase.main()


def _write(path, data, **kw):
    path.write_text(json.dumps(data, ensure_ascii=False, **kw), encoding="utf-8")
    return str(path)


def test_each_hole_takes_its_own_list_off_and_the_preview_says_so(
        monkeypatch, tmp_path, capsys):
    _stub_run(monkeypatch)
    lists = _write(tmp_path / "off.json",
                   {"poursuit": ["inconnu"], "chat": ["Indice"], "jardin": []})
    _main(monkeypatch, tmp_path / "out", "--other-sense", lists)

    puzzle_path = tmp_path / "out" / "fr" / "proche_indice_indice.json"
    puzzle = json.loads(puzzle_path.read_text(encoding="utf-8"))
    chat = puzzle["ranks"]["chat"]
    assert "indice" not in chat
    assert chat["proche"]["rank"] == 1 and chat["loin"]["rank"] == 2
    assert puzzle["ranks"]["jardin"]["indice"]["rank"] == 1
    assert puzzle["ranks"]["poursuit"]["indice"]["rank"] == 1

    sidecar = tmp_path / "out" / "fr" / "proche_indice_indice.other-sense.json"
    out = capsys.readouterr().out
    assert f"autres sens : {sidecar}" in out
    assert "secret « chat » : 1 groupe(s) d'un autre sens retiré(s)" in out
    assert "secret « jardin » : 0 groupe(s)" in out
    assert ("secret « poursuit » : 0 groupe(s) d'un autre sens retiré(s) ; ignoré(s) "
            "(sans groupe, ou le secret lui-même) : inconnu") in out


def test_the_sidecar_replays_to_the_identical_puzzle(monkeypatch, tmp_path):
    _stub_run(monkeypatch)
    lists = _write(tmp_path / "off.json",
                   {"poursuit": ["loin", "inconnu"], "chat": ["indice"], "jardin": []},
                   indent=2)
    _main(monkeypatch, tmp_path / "first", "--other-sense", lists)
    first = tmp_path / "first" / "fr" / "proche_indice_indice.json"
    sidecar = first.with_name("proche_indice_indice.other-sense.json")

    # the same object, keys sorted, lists as given
    assert sidecar.read_text(encoding="utf-8") == json.dumps(
        {"chat": ["indice"], "jardin": [], "poursuit": ["loin", "inconnu"]},
        ensure_ascii=False)

    _main(monkeypatch, tmp_path / "again", "--other-sense", str(sidecar))
    again = tmp_path / "again" / "fr" / "proche_indice_indice.json"
    assert again.read_bytes() == first.read_bytes()
    assert again.with_name(sidecar.name).read_bytes() == sidecar.read_bytes()


def test_a_build_without_other_sense_drops_the_sidecar_left_beside_it(
        monkeypatch, tmp_path):
    _stub_run(monkeypatch)
    lists = _write(tmp_path / "off.json", {"poursuit": [], "chat": [], "jardin": []})
    _main(monkeypatch, tmp_path / "out", "--other-sense", lists)
    sidecar = tmp_path / "out" / "fr" / "indice_indice_indice.other-sense.json"
    assert sidecar.is_file()

    _main(monkeypatch, tmp_path / "out")  # the same puzzle path, built without lists
    assert not sidecar.exists()  # it would describe a map that is no longer there


@pytest.mark.parametrize("data, refusal", [
    ({"chat": [], "jardin": []}, "manquante(s) : poursuit"),
    ({"chat": [], "jardin": [], "poursuit": [], "chien": []}, "en trop : chien"),
    ({"chat": [], "jardin": [], "poursuivre": []},
     "manquante(s) : poursuit ; en trop : poursuivre"),
    (["chat", "jardin", "poursuit"], "doit être un objet"),
    ({"chat": "indice", "jardin": [], "poursuit": []}, "doit être un objet"),
], ids=["missing", "extra", "misspelled", "not-an-object", "not-a-list"])
def test_an_other_sense_file_not_naming_the_three_secrets_dies_before_anything_loads(
        monkeypatch, capsys, tmp_path, data, refusal):
    loaded = []
    _stub_run(monkeypatch, loaded)
    with pytest.raises(SystemExit):
        _main(monkeypatch, tmp_path, "--other-sense", _write(tmp_path / "off.json", data))
    assert refusal in capsys.readouterr().err
    assert loaded == []


@pytest.mark.parametrize("flags, refusal", [
    (["--url", "youtu.be/x"], "--url must be a web link"),
    (["--other-sense", "off.json"], "--other-sense exige --words"),
], ids=["url", "other-sense-without-words"])
def test_a_flag_error_dies_before_anything_loads(monkeypatch, capsys, tmp_path, flags,
                                                 refusal):
    loaded = []
    monkeypatch.setattr(FR["module"], "load_vectors",
                        lambda: loaded.append("vectors"), raising=False)
    monkeypatch.setattr(gen_phrase, "load_lemma_table",
                        lambda *_a, **_k: loaded.append("tables"))
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    words = None if "--other-sense" in flags else WORDS
    with pytest.raises(SystemExit) as exit_:
        _main(monkeypatch, tmp_path, *flags, words=words)
    assert refusal in capsys.readouterr().err + str(exit_.value.code)
    assert loaded == []  # no table, no vector — and so no walk
