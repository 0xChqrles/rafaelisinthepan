"""Curriculum orchestration contract (#84): fresh runs, retrospectives, holdout.

Network-free: a scripted provider factory stands in for paid adapters. Asserts
the issue's isolation rules — same incoming strategy for a puzzle's 3 fresh
runs, retrospection only afterwards, replace-not-append strategy revisions,
leak rejection, frozen holdout conditions, and resume-without-repeat.
"""

import json

import pytest

import curriculum_dataset as cd
import curriculum_run as cr
import strategy_profiles as sp
from slug import slug
import test_curriculum_dataset as world


V7_TEXT = "Frozen v7 strategy text, recovered verbatim."


@pytest.fixture(autouse=True)
def _api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    monkeypatch.setattr(cd, "COMMON_MAX_FREQ_RANK", 8)
    out_dir = tmp_path / "dataset"
    manifest = cd.build_dataset(
        {"generator": {"model": "test"}, "candidates": world.CANDIDATES},
        V=world.V,
        ranking_for=world.ranking_for,
        seed=42,
        out_dir=out_dir,
        quotas=world.QUOTAS,
    )
    return out_dir / "manifest.json", manifest


def secrets_for(dataset_dir, record):
    puzzle = json.loads((dataset_dir / record["path"]).read_text(encoding="utf-8"))
    return [hole["secret"]["word"] for hole in puzzle["holes"]]


def vocab_loader(_lang):
    words = set(world.V)
    return {slug(word) for word in words}


def retro_reply(lesson):
    return json.dumps(
        {
            "analysis": {
                "worked_well": "direct answers",
                "wasted_attempt_patterns": "none observed",
                "missed_evidence": "none",
                "strategy_adherence": f"followed ({lesson})",
                "run_comparison": "identical",
            },
            "revised_strategy": [f"Lesson {lesson}: explore opposites early."],
        }
    )


SYNTHESIS_REPLY = json.dumps(
    {
        "comprehensive_summary": "Across the curriculum, direct play won.",
        "final_strategy": ["Final rule: diversify semantic directions."],
    }
)


class ScriptedProvider:
    """Stands in for provider_reply; every construction is a fresh context."""

    def __init__(self, word_scripts, prose_scripts):
        self.word_scripts = iter(word_scripts)
        self.prose_scripts = iter(prose_scripts)
        self.constructed = []
        self.players = []

    def __call__(self, config, api_key, *, effort, auth, output):
        self.constructed.append(output)
        if output == "word":
            replies = iter(next(self.word_scripts))
            calls = []

            def player(messages):
                calls.append([m.copy() for m in messages])
                return next(replies)

            player.calls = calls
            self.players.append(player)
            return player
        replies = iter(next(self.prose_scripts))
        return lambda messages: next(replies)


def scripted_for(manifest_path, manifest, *, prose_scripts=None):
    dataset_dir = manifest_path.parent
    curriculum = [r for r in manifest["puzzles"] if r["split"] == "curriculum"]
    holdout = [r for r in manifest["puzzles"] if r["split"] == "holdout"]
    word_scripts = []
    for record in curriculum:
        word_scripts += [secrets_for(dataset_dir, record)] * cr.RUNS_PER_PUZZLE
    for _condition in cr.CONDITIONS:
        for record in holdout:
            word_scripts += [
                secrets_for(dataset_dir, record)
            ] * cr.HOLDOUT_RUNS_PER_CONDITION
    if prose_scripts is None:
        prose_scripts = [
            [retro_reply(lesson)] for lesson in ("alpha", "beta", "gamma")
        ] + [[SYNTHESIS_REPLY]]
    return ScriptedProvider(word_scripts, prose_scripts)


def run(dataset, tmp_path, provider, **kwargs):
    manifest_path, _manifest = dataset
    return cr.run_curriculum(
        manifest_path,
        model="OPUS",
        effort="none",
        auth="api",
        cap=50,
        provider_factory=provider,
        vocab_loader=vocab_loader,
        output_root=tmp_path / "artifacts",
        v7_strategy=V7_TEXT,
        **kwargs,
    )


def test_full_curriculum_isolates_runs_and_freezes_holdout(dataset, tmp_path):
    manifest_path, manifest = dataset
    provider = scripted_for(manifest_path, manifest)

    artifact_path = run(dataset, tmp_path, provider)
    state = json.loads(artifact_path.read_text(encoding="utf-8"))

    # 3 curriculum puzzles x 3 runs, each from a genuinely fresh provider context.
    assert len(state["puzzles"]) == 3
    assert provider.constructed == (
        ["word"] * 3 + ["prose"]
    ) * 3 + ["prose"] + ["word"] * 9

    first_puzzle = state["puzzles"][0]
    openings = [r["conversation"][0]["content"] for r in first_puzzle["runs"]]
    # First puzzle: no learned strategy yet, and all 3 runs got the same prompt.
    assert all("YOUR STRATEGY" not in opening for opening in openings)
    assert len(set(openings)) == 1
    # The first play response is a guess, never a plan.
    for record in first_puzzle["runs"]:
        assert record["conversation"][1]["role"] == "assistant"
        assert record["conversation"][1]["content"] == record["tried_words"][0]
    # No run transcript leaks into another run: each fresh player saw no
    # assistant content besides its own replies.
    for player in provider.players[:3]:
        own = {call_msg["content"] for call in player.calls for call_msg in call
               if call_msg["role"] == "assistant"}
        assert own <= set(first_puzzle["runs"][provider.players.index(player)]["tried_words"])

    # Retrospection starts only after all three runs and stores the contract.
    retro = first_puzzle["retrospective"]
    assert retro["revised_strategy"] == ["Lesson alpha: explore opposites early."]
    for key in (
        "worked_well",
        "wasted_attempt_patterns",
        "missed_evidence",
        "strategy_adherence",
        "run_comparison",
    ):
        assert key in retro["analysis"]

    # Only the compact revision crosses puzzles, and it REPLACES the previous one.
    second_opening = state["puzzles"][1]["runs"][0]["conversation"][0]["content"]
    assert "Lesson alpha" in second_opening
    third_opening = state["puzzles"][2]["runs"][0]["conversation"][0]["content"]
    assert "Lesson beta" in third_opening
    assert "Lesson alpha" not in third_opening
    assert "worked_well" not in second_opening  # raw analysis never travels

    # Holdout: three distinct frozen conditions, three runs each, no retrospectives.
    assert set(state["holdout"]) == {"neutral", "learned", "v7"}
    for condition, entries in state["holdout"].items():
        assert len(entries) == 1
        assert len(entries[0]["runs"]) == 3
        opening = entries[0]["runs"][0]["conversation"][0]["content"]
        if condition == "neutral":
            assert "YOUR STRATEGY" not in opening
        elif condition == "learned":
            assert "Final rule: diversify semantic directions." in opening
        else:
            assert V7_TEXT in opening
            assert "Final rule" not in opening

    # Synthesis and the compact profile artifact.
    assert state["synthesis"]["final_strategy"] == [
        "Final rule: diversify semantic directions."
    ]
    profile = sp.load_profile(artifact_path.with_suffix(".profile.json"))
    sp.assert_profile_compatible(
        profile, model_id="claude-opus-4-8", transport="api", effort="none"
    )
    with pytest.raises(ValueError, match="never applied across models"):
        sp.assert_profile_compatible(
            profile, model_id="gpt-5.6-sol", transport="api", effort="none"
        )

    report = cr.evaluate_artifact(state)
    assert [t["median_tries"] for t in report["curriculum_trend"]] == [3, 3, 3]
    assert report["holdout"]["neutral"]["median_of_medians"] == 3
    assert report["paired_differences"]["learned_minus_neutral"]


def test_retrospective_leak_reprompts_once_then_fails(dataset, tmp_path):
    manifest_path, manifest = dataset
    dataset_dir = manifest_path.parent
    first = [r for r in manifest["puzzles"] if r["split"] == "curriculum"][0]
    secret = secrets_for(dataset_dir, first)[0]

    leaking = json.dumps(
        {
            "analysis": {key: "x" for key in (
                "worked_well", "wasted_attempt_patterns", "missed_evidence",
                "strategy_adherence", "run_comparison",
            )},
            "revised_strategy": [f"Always try {secret} first."],
        }
    )
    # Leak, then a corrected reply: accepted on the reprompt.
    provider = scripted_for(
        manifest_path,
        manifest,
        prose_scripts=[[leaking, retro_reply("alpha")]]
        + [[retro_reply("beta")], [retro_reply("gamma")], [SYNTHESIS_REPLY]],
    )
    artifact_path = run(dataset, tmp_path / "ok", provider)
    state = json.loads(artifact_path.read_text(encoding="utf-8"))
    retro_conv = state["puzzles"][0]["retrospective"]["conversation"]
    assert "rejected" in retro_conv[2]["content"]
    assert state["puzzles"][0]["retrospective"]["revised_strategy"] == [
        "Lesson alpha: explore opposites early."
    ]

    # Two leaking replies: fail clearly, never a third paid attempt.
    provider = scripted_for(
        manifest_path, manifest, prose_scripts=[[leaking, leaking]]
    )
    with pytest.raises(cr.CurriculumError, match="after one reprompt"):
        run(dataset, tmp_path / "fails", provider)


def test_strategy_leak_validation_covers_targets_starts_guesses_and_quotes(dataset):
    manifest_path, manifest = dataset
    dataset_dir = manifest_path.parent
    record = [r for r in manifest["puzzles"] if r["split"] == "curriculum"][0]
    puzzle = json.loads(
        (dataset_dir / record["path"]).read_text(encoding="utf-8")
    )
    start_word = puzzle["holes"][0]["start"]["word"]
    records = [{"tried_words": ["intrus"]}]

    for item, match in (
        ([f"Use {puzzle['holes'][0]['secret']['word']} again."], "leaks puzzle word"),
        ([f"The clue {start_word} was useful."], "leaks puzzle word"),
        (["Remember intrus next time."], "leaks puzzle word"),
    ):
        with pytest.raises(ValueError, match=match):
            cr.validate_revised_strategy(item, puzzle, records)

    # Quoting the sentence is rejected even when the quote contains no target.
    scenic = {
        "words": ["les", "nuages", "flottent", "sur", "la", "montagne"],
        "holes": [
            {
                "pos": 5,
                "secret": {"word": "montagne", "slug": "montagne"},
                "start": {"word": "colline", "slug": "colline"},
                "start_rank": 120,
            }
        ],
    }
    with pytest.raises(ValueError, match="quotes the puzzle"):
        cr.validate_revised_strategy(
            ["Sentence said: les nuages flottent sur."], scenic, records
        )

    assert cr.validate_revised_strategy(
        ["Pivot to an opposite after three flat guesses."], puzzle, records
    )


def test_resume_never_repeats_completed_paid_calls(dataset, tmp_path):
    manifest_path, manifest = dataset
    # Scripts for the first two runs only: the third play crashes the run.
    dataset_dir = manifest_path.parent
    first = [r for r in manifest["puzzles"] if r["split"] == "curriculum"][0]
    partial = ScriptedProvider(
        [secrets_for(dataset_dir, first)] * 2, prose_scripts=[]
    )
    with pytest.raises(StopIteration):
        run(dataset, tmp_path, partial)

    artifacts = list((tmp_path / "artifacts").rglob("*.json"))
    assert len(artifacts) == 1
    partial_state = json.loads(artifacts[0].read_text(encoding="utf-8"))
    assert len(partial_state["puzzles"][0]["runs"]) == 2

    # Resume: only the REMAINING calls run (total scripts = full set minus 2).
    remaining = scripted_for(manifest_path, manifest)
    remaining.word_scripts = iter(list(remaining.word_scripts)[2:])
    artifact_path = run(dataset, tmp_path, remaining, resume=artifacts[0])
    state = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert len(state["puzzles"]) == 3
    assert all(len(p["runs"]) == 3 for p in state["puzzles"])
    # The first two recorded runs are the pre-crash ones, byte-identical.
    assert state["puzzles"][0]["runs"][:2] == partial_state["puzzles"][0]["runs"]

    # A resume under a different configuration is refused.
    with pytest.raises(cr.CurriculumError, match="does not match"):
        cr.run_curriculum(
            manifest_path,
            model="SONNET",
            effort="none",
            auth="api",
            cap=50,
            resume=artifact_path,
            provider_factory=remaining,
            vocab_loader=vocab_loader,
            output_root=tmp_path / "artifacts",
            v7_strategy=V7_TEXT,
        )


def test_dry_run_plans_without_provider_calls(dataset, tmp_path, capsys):
    class Exploding:
        def __call__(self, *args, **kwargs):
            raise AssertionError("dry-run must not construct providers")

    result = run(dataset, tmp_path, Exploding(), dry_run=True)
    assert result is None
    plan = json.loads(capsys.readouterr().out)
    assert plan["dry_run"] is True
    assert plan["planned_play_calls"] == 3 * 3 + 1 * 3 * 3
    assert plan["planned_retrospectives"] == 3
    assert not (tmp_path / "artifacts").exists()


def test_modified_dataset_is_refused(dataset, tmp_path):
    manifest_path, manifest = dataset
    tampered = manifest_path.parent / manifest["puzzles"][0]["path"]
    tampered.write_text(
        tampered.read_text(encoding="utf-8").replace("fr", "fr "), encoding="utf-8"
    )
    with pytest.raises(cr.CurriculumError, match="sha256"):
        cr.load_manifest(manifest_path)


def test_median_tries_keeps_dnf_honest():
    runs = lambda values: [{"tries": v} for v in values]  # noqa: E731
    assert cr._median_tries(runs([None, 5, 3])) == 5
    assert cr._median_tries(runs([None, None, 3])) is None
    assert cr._median_tries(runs([4, 2, 6])) == 4


def test_derive_run_metrics_replays_the_real_rules():
    puzzle = world.CANDIDATES  # not a puzzle; build a real one from the fixture
    import random

    candidate = cd.validate_candidate(
        2, world.CANDIDATES[2], cd.frequency_lookup(world.V)
    )
    built = cd.build_puzzle(
        candidate, ranking_for=world.ranking_for, rng=random.Random(3)
    )
    vocab = vocab_loader("fr") | {"intrus", "autre"}
    secrets = [hole["secret"]["word"] for hole in built["holes"]]

    metrics = cr.derive_run_metrics(
        built, vocab, ("intrus", "autre", *secrets)
    )
    assert metrics["solved"] is True
    assert metrics["max_no_improvement_streak"] == 2
    assert metrics["non_improving_guesses"] == 2

    with pytest.raises(cr.CurriculumError, match="non-counting"):
        cr.derive_run_metrics(built, vocab, ("intrus", "intrus"))
