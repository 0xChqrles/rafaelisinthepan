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
        canonical_metadata=world.CANONICAL_METADATA,
        **world.SYNTHETIC_EMBEDDING,
    )
    return out_dir / "manifest.json", manifest


def secrets_for(dataset_dir, record):
    puzzle = cd.load_puzzle_json(dataset_dir / record["path"])
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
    auth = kwargs.pop("auth", "api")
    effort = kwargs.pop("effort", "none")
    model = kwargs.pop("model", "OPUS")
    return cr.run_curriculum(
        manifest_path,
        model=model,
        effort=effort,
        auth=auth,
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
    for forbidden in (
        "YOUR METHOD",
        "JUDGMENT:",
        "Embedding relatedness is not transitive",
        "independent sources of evidence",
        "A sequence of related guesses",
    ):
        assert all(forbidden not in opening for opening in openings)
    assert all("EMBEDDING INFO" in opening for opening in openings)
    for record in first_puzzle["runs"]:
        assert all(
            "JUDGMENT:" not in message["content"]
            for message in record["conversation"]
            if message["role"] == "user"
        )
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
    assert len(retro["telemetry"]["attempts"]) == 1
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
    assert profile["dataset_sha256"] == manifest["dataset_content_sha256"]
    assert state["config"]["dataset_sha256"] == manifest[
        "dataset_content_sha256"
    ]
    assert state["manifest_sha256"] != manifest["dataset_content_sha256"]
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
    assert report["holdout"]["neutral"]["solved_only_median"] == 3
    assert report["holdout"]["neutral"]["dnf_puzzles"] == 0
    assert report["paired_differences"]["learned_minus_neutral"]
    assert report["cost_split"]["retrospective"]["calls"] == 3
    assert report["cost_split"]["synthesis"]["calls"] == 1


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
    assert len(state["puzzles"][0]["retrospective"]["telemetry"]["attempts"]) == 2

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
    puzzle = cd.load_puzzle_json(dataset_dir / record["path"])
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

    # Whole-token and segment checks work in both directions.
    with pytest.raises(ValueError, match="leaks puzzle word"):
        cr.validate_revised_strategy(
            ["Revisit montagne-neige after a miss."], scenic, records
        )
    hyphenated_target = json.loads(json.dumps(scenic))
    hyphenated_target["holes"][0]["secret"] = {
        "word": "nuages-froids",
        "slug": "nuages-froids",
    }
    with pytest.raises(ValueError, match="leaks puzzle word"):
        cr.validate_revised_strategy(
            ["Revisit nuages after a miss."], hyphenated_target, records
        )

    # Quote matching follows word-core slugs, so punctuation/case/accents cannot
    # disguise a three-word sentence run.
    accented = dict(scenic, words=["L'été,", "brille", "sur", "la", "montagne"])
    with pytest.raises(ValueError, match="quotes the puzzle"):
        cr.validate_revised_strategy(
            ["Remember: ÉTÉ — BRILLE, SUR!"], accented, records
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


@pytest.mark.parametrize(
    ("model", "effort", "validator_name", "verified_session"),
    [
        ("OPUS", "none", "validate_anthropic_subscription_auth", "pro"),
        ("GPT-SOL", "medium", "validate_openai_subscription_auth", "ChatGPT"),
    ],
)
def test_subscription_preflight_is_recorded_and_repeated_before_resume(
    dataset,
    tmp_path,
    monkeypatch,
    model,
    effort,
    validator_name,
    verified_session,
):
    manifest_path, manifest = dataset
    preflights = []
    monkeypatch.setattr(
        cr,
        validator_name,
        lambda: preflights.append("preflight") or verified_session,
    )
    other_validator = (
        "validate_openai_subscription_auth"
        if validator_name == "validate_anthropic_subscription_auth"
        else "validate_anthropic_subscription_auth"
    )

    def wrong_preflight():
        raise AssertionError("preflighted the unselected provider")

    monkeypatch.setattr(cr, other_validator, wrong_preflight)
    provider = scripted_for(manifest_path, manifest)
    artifact_path = run(
        dataset,
        tmp_path,
        provider,
        auth="subscription",
        model=model,
        effort=effort,
    )
    state = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert state["config"]["auth_verification"] == {
        "mode": "subscription",
        "status": "verified",
        "provider_session": verified_session,
    }

    completed_provider = scripted_for(manifest_path, manifest)
    run(
        dataset,
        tmp_path,
        completed_provider,
        auth="subscription",
        model=model,
        effort=effort,
        resume=artifact_path,
    )
    assert preflights == ["preflight", "preflight"]
    assert completed_provider.constructed == []


def test_modified_dataset_is_refused(dataset, tmp_path):
    manifest_path, manifest = dataset
    tampered = manifest_path.parent / manifest["puzzles"][0]["path"]
    content = cd.read_data_bytes(tampered).replace(b'"fr"', b'"fr "', 1)
    cd.write_deterministic_gzip(tampered, content)
    with pytest.raises(cr.CurriculumError, match="sha256"):
        cr.load_manifest(manifest_path)


def test_manifest_timestamp_changes_file_hash_but_not_dataset_identity(dataset):
    manifest_path, _manifest = dataset
    _, content_before, file_before = cr.load_manifest(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["generated_at"] = "2099-01-01T00:00:00+00:00"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    _, content_after, file_after = cr.load_manifest(manifest_path)
    assert content_after == content_before
    assert file_after != file_before


def test_median_tries_keeps_dnf_honest():
    runs = lambda values: [{"tries": v} for v in values]  # noqa: E731
    assert cr._median_tries(runs([None, 5, 3])) == 5
    assert cr._median_tries(runs([None, None, 3])) is None
    assert cr._median_tries(runs([4, 2, 6])) == 4


def test_median_of_medians_is_dnf_aware_and_keeps_solved_only_detail():
    values = [7, 9, None, None, None]
    state = {
        "config": {},
        "puzzles": [],
        "synthesis": None,
        "holdout": {
            "neutral": [
                {"number": number, "runs": [{"tries": value}] * 3}
                for number, value in enumerate(values, start=1)
            ]
        },
    }
    neutral = cr.evaluate_artifact(state)["holdout"]["neutral"]
    assert neutral["median_of_medians"] is None
    assert neutral["solved_only_median"] == 8.0
    assert neutral["dnf_puzzles"] == 3


def test_structured_call_captures_each_attempt_usage_and_duration():
    class MeteredCaller:
        def __init__(self):
            self.replies = iter(['{"wrong": true}', '{"ok": true}'])
            self.calls = 0
            self.last_token_usage = None

        def __call__(self, _messages):
            self.calls += 1
            self.last_token_usage = {
                "input_tokens": self.calls * 10,
                "output_tokens": self.calls,
            }
            return next(self.replies)

    caller = MeteredCaller()

    def validate(payload):
        if payload.get("ok") is not True:
            raise ValueError("missing ok")
        return payload

    parsed, messages, telemetry = cr.structured_call(caller, "prompt", validate)
    assert parsed == {"ok": True}
    assert "rejected" in messages[2]["content"]
    assert [attempt["token_usage"] for attempt in telemetry["attempts"]] == [
        {"input_tokens": 10, "output_tokens": 1},
        {"input_tokens": 20, "output_tokens": 2},
    ]
    assert telemetry["wall_duration"] >= 0
    assert all(attempt["wall_duration"] >= 0 for attempt in telemetry["attempts"])


def test_evaluation_aggregates_play_retrospective_and_synthesis_costs():
    state = {
        "config": {},
        "puzzles": [
            {
                "number": 1,
                "runs": [
                    {
                        "tries": 1,
                        "turns": 2,
                        "wall_duration": 1.5,
                        "turn_token_usage": [
                            {"input_tokens": 3, "output_tokens": 1},
                            {"input_tokens": 4, "output_tokens": 1},
                        ],
                    }
                ],
                "retrospective": {
                    "analysis": {},
                    "telemetry": {
                        "wall_duration": 2.0,
                        "attempts": [
                            {
                                "token_usage": {
                                    "input_tokens": 10,
                                    "output_tokens": 5,
                                }
                            }
                        ],
                    },
                },
            }
        ],
        "synthesis": {
            "final_strategy": [],
            "telemetry": {
                "wall_duration": 3.0,
                "attempts": [
                    {
                        "token_usage": {
                            "input_tokens": 20,
                            "output_tokens": 6,
                        }
                    }
                ],
            },
        },
        "holdout": {},
    }
    costs = cr.evaluate_artifact(state)["cost_split"]
    assert costs["play"] == {
        "calls": 2,
        "wall_duration": 1.5,
        "token_usage": {"input_tokens": 7, "output_tokens": 2},
    }
    assert costs["retrospective"]["token_usage"] == {
        "input_tokens": 10,
        "output_tokens": 5,
    }
    assert costs["synthesis"]["token_usage"] == {
        "input_tokens": 20,
        "output_tokens": 6,
    }


def test_derive_run_metrics_replays_the_real_rules():
    puzzle = world.CANDIDATES  # not a puzzle; build a real one from the fixture
    import random

    candidate = cd.validate_candidate(
        2,
        world.CANDIDATES[2],
        cd.frequency_lookup(world.V),
        world.CANONICAL_METADATA,
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
