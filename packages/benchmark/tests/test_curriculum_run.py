"""Offline strategy-distillation and frozen-holdout contract (#84).

Network-free scripted adapters prove that curriculum data is distilled once,
never played, and that all holdout arms use fresh ordinary one-word contexts.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import curriculum_dataset as cd
from curriculum_io import read_data_bytes
import curriculum_run as cr
import strategy_profiles as sp
from slug import slug
import test_curriculum_dataset as world


V7_TEXT = "Frozen exact-v7 operational guidance."
SAFE_STRATEGY = [
    "Inspect grammatical constraints before selecting a candidate.",
    "Treat numeric movement as evidence; abandon flat hypotheses promptly.",
]
DISTILLATION_REPLY = json.dumps(
    {
        "analysis": "The labeled examples reward grammar-aware semantic search.",
        "strategy": SAFE_STRATEGY,
    }
)


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


def _records(manifest, split):
    return [record for record in manifest["puzzles"] if record["split"] == split]


def _secrets(dataset_dir, record):
    puzzle = cd.load_puzzle_json(dataset_dir / record["path"])
    return [hole["secret"]["word"] for hole in puzzle["holes"]]


def _vocab_loader(_lang):
    return {slug(word) for word in world.V}


class RecordingProvider:
    """Every construction is a fresh context with a scripted response stream."""

    def __init__(self, *, prose_replies=None, word_scripts=None, inspect=None):
        self.prose_replies = iter(prose_replies or [DISTILLATION_REPLY])
        self.word_scripts = iter(word_scripts or [])
        self.inspect = inspect
        self.constructions = []
        self.prose_callers = []
        self.word_players = []

    def __call__(self, config, api_key, *, effort, auth, output):
        construction = {
            "model_id": config["model_id"],
            "api_key": api_key,
            "effort": effort,
            "auth": auth,
            "output": output,
        }
        self.constructions.append(construction)
        if self.inspect is not None:
            self.inspect(construction)
        if output == "prose":
            response = next(self.prose_replies)
            calls = []

            def caller(messages):
                calls.append([message.copy() for message in messages])
                caller.last_token_usage = {"input_tokens": 10, "output_tokens": 2}
                return response

            caller.last_token_usage = None
            caller.calls = calls
            self.prose_callers.append(caller)
            return caller
        if output != "word":
            raise AssertionError(f"unexpected provider output mode {output!r}")
        replies = iter(next(self.word_scripts))
        calls = []

        def player(messages):
            calls.append([message.copy() for message in messages])
            player.last_token_usage = {"input_tokens": 3, "output_tokens": 1}
            return next(replies)

        player.last_token_usage = None
        player.calls = calls
        self.word_players.append(player)
        return player


def _provider_for_full_run(manifest_path, manifest, **kwargs):
    scripts = []
    holdout = _records(manifest, "holdout")
    for _condition in cr.CONDITIONS:
        for record in holdout:
            scripts.extend(
                [_secrets(manifest_path.parent, record)]
                * cr.HOLDOUT_RUNS_PER_CONDITION
            )
    return RecordingProvider(word_scripts=scripts, **kwargs)


def _run(dataset, tmp_path, provider, **kwargs):
    manifest_path, _manifest = dataset
    return cr.run_curriculum(
        manifest_path,
        model=kwargs.pop("model", "OPUS"),
        strategy_effort=kwargs.pop("strategy_effort", "max"),
        play_effort=kwargs.pop("play_effort", "none"),
        auth=kwargs.pop("auth", "api"),
        cap=kwargs.pop("cap", 50),
        provider_factory=provider,
        vocab_loader=_vocab_loader,
        output_root=tmp_path / "artifacts",
        v7_strategy=V7_TEXT,
        **kwargs,
    )


def _state(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _without_guidance(opening):
    marker = "\n\nYOUR STRATEGY\n"
    if marker not in opening:
        return opening
    prefix, remainder = opening.split(marker, 1)
    _guidance, suffix = remainder.split("\n\nCURRENT STATE\n", 1)
    return prefix + "\n\nCURRENT STATE\n" + suffix


def test_full_run_distils_once_then_uses_only_fresh_one_word_holdout_contexts(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    provider = _provider_for_full_run(manifest_path, manifest)
    artifact = _run(dataset, tmp_path, provider)
    state = _state(artifact)

    assert [item["output"] for item in provider.constructions] == ["prose"] + [
        "word"
    ] * 9
    assert provider.constructions[0]["effort"] == "max"
    assert all(item["effort"] == "none" for item in provider.constructions[1:])
    assert len(provider.prose_callers[0].calls) == 1
    first_distillation_messages = provider.prose_callers[0].calls[0]
    assert len(first_distillation_messages) == 1
    assert "EVIDENCE_PACKET_CANONICAL_JSON_BEGIN" in first_distillation_messages[0][
        "content"
    ]

    assert state["distillation"]["status"] == "complete"
    assert state["distillation"]["strategy"] == SAFE_STRATEGY
    assert "puzzles" not in state
    assert "synthesis" not in state
    assert "retrospective" not in json.dumps(state)
    assert sum(
        len(entry["runs"])
        for entries in state["holdout"].values()
        for entry in entries
    ) == 9

    # Every run gets a newly constructed player and starts from one opening message.
    assert len(provider.word_players) == 9
    assert all(len(player.calls[0]) == 1 for player in provider.word_players)
    assert all(
        player.calls[0][0]["role"] == "user" for player in provider.word_players
    )
    assert all(
        "Reply with exactly one word." in player.calls[0][0]["content"]
        for player in provider.word_players
    )
    assert all(
        forbidden not in player.calls[0][0]["content"]
        for player in provider.word_players
        for forbidden in ("required mode", '"family"', '"rule"', "decision JSON")
    )

    # Within one identical holdout start, guidance is the only opening difference.
    openings = [player.calls[0][0]["content"] for player in provider.word_players]
    assert all(_without_guidance(opening) == openings[0] for opening in openings)
    assert "YOUR STRATEGY" not in openings[0]
    assert sp.strategy_text(SAFE_STRATEGY) in openings[3]
    assert state["distillation"]["analysis"] not in openings[3]
    assert V7_TEXT in openings[6]

    # The first assistant action in every recorded run is an ordinary one-word guess.
    for entries in state["holdout"].values():
        for entry in entries:
            for run in entry["runs"]:
                assert run["conversation"][1]["role"] == "assistant"
                assert len(run["conversation"][1]["content"].split()) == 1
                assert "policy_attempts" not in run

    sidecar = Path(state["evidence_packet"]["path"])
    assert read_data_bytes(sidecar) == cr.build_evidence_packet(
        manifest, manifest_path.parent
    ).canonical_bytes
    assert hashlib.sha256(read_data_bytes(sidecar)).hexdigest() == state[
        "evidence_packet"
    ]["sha256"]
    profile = sp.load_profile(Path(state["profile"]["path"]))
    assert profile["final_strategy"] == SAFE_STRATEGY
    assert profile["evidence_packet_sha256"] == state["evidence_packet"]["sha256"]


def test_all_five_by_three_by_three_holdout_runs_use_fresh_identical_configs(
    dataset, tmp_path
):
    manifest_path, original = dataset
    manifest = json.loads(json.dumps(original))
    source = _records(manifest, "holdout")[0]
    source_path = manifest_path.parent / source["path"]
    for number in range(5, 9):
        duplicate = json.loads(json.dumps(source))
        duplicate["number"] = number
        duplicate["path"] = f"puzzles/{number:03d}-holdout-copy.json.gz"
        (manifest_path.parent / duplicate["path"]).write_bytes(source_path.read_bytes())
        manifest["puzzles"].append(duplicate)
    manifest["counts"].update({"puzzles": 8, "curriculum": 3, "holdout": 5})
    manifest["dataset_content_sha256"] = cd.dataset_content_sha256(manifest)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    provider = _provider_for_full_run(manifest_path, manifest)
    artifact = _run((manifest_path, manifest), tmp_path, provider)
    state = _state(artifact)

    assert len(provider.prose_callers) == 1
    assert len(provider.word_players) == 5 * 3 * 3 == 45
    assert cr._completed_play_count(state) == 45
    play_configs = provider.constructions[1:]
    assert len(
        {
            (
                item["model_id"],
                item["effort"],
                item["auth"],
                item["output"],
            )
            for item in play_configs
        }
    ) == 1
    assert all(len(player.calls[0]) == 1 for player in provider.word_players)


def test_strategy_is_checkpointed_and_frozen_before_first_holdout_provider(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    output_root = tmp_path / "artifacts"
    seen_word_construction = False

    def inspect(construction):
        nonlocal seen_word_construction
        artifacts = [
            path
            for path in output_root.rglob("*.json")
            if not path.name.endswith(".profile.json")
        ]
        assert len(artifacts) == 1
        state = _state(artifacts[0])
        if construction["output"] == "prose":
            assert state["distillation"]["status"] == "pending"
        else:
            seen_word_construction = True
            assert state["distillation"]["status"] == "complete"
            assert state["distillation"]["strategy"] == SAFE_STRATEGY
            assert state["distillation"]["frozen_strategy_sha256"]

    provider = _provider_for_full_run(
        manifest_path, manifest, inspect=inspect
    )
    cr.run_curriculum(
        manifest_path,
        model="OPUS",
        strategy_effort="max",
        play_effort="none",
        auth="api",
        cap=50,
        provider_factory=provider,
        vocab_loader=_vocab_loader,
        output_root=output_root,
        v7_strategy=V7_TEXT,
    )
    assert seen_word_construction


def test_verbose_mode_prints_frozen_strategy_and_each_counted_try(
    dataset, tmp_path, capsys
):
    manifest_path, manifest = dataset
    artifact = _run(
        dataset,
        tmp_path,
        _provider_for_full_run(manifest_path, manifest),
        verbose=True,
    )
    output = capsys.readouterr().out
    assert f"curriculum artifact: {artifact}" in output
    assert sp.strategy_text(SAFE_STRATEGY) in output
    assert "try=1 word=" in output
    assert "[play 9/9] DONE holdout/v7" in output


def test_malformed_and_leaking_replies_receive_exactly_three_bounded_attempts(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    packet = cr.build_evidence_packet(manifest, manifest_path.parent)
    leaked = packet.document["content"]["puzzles"][0]["targets"][0]["answer"]
    leaking_reply = json.dumps(
        {"analysis": "analysis", "strategy": [f"Always submit {leaked} first."]}
    )
    provider = _provider_for_full_run(
        manifest_path,
        manifest,
        prose_replies=["not json", leaking_reply, DISTILLATION_REPLY],
    )
    artifact = _run(dataset, tmp_path, provider)
    attempts = _state(artifact)["distillation"]["attempts"]

    assert len(attempts) == cr.STRUCTURED_MAX_ATTEMPTS == 3
    assert "valid JSON" in attempts[0]["validation_error"]
    assert "privileged evidence word" in attempts[1]["validation_error"]
    assert attempts[2]["validation_error"] is None
    assert all(attempt["response"] is not None for attempt in attempts)
    assert all(attempt["token_usage"] for attempt in attempts)
    assert all(attempt["wall_duration"] >= 0 for attempt in attempts)
    assert all(
        len(caller.calls[0]) == 1 for caller in provider.prose_callers
    )


def test_strategy_leak_validation_covers_starts_retained_words_and_sentence_runs(
    dataset, monkeypatch
):
    manifest_path, manifest = dataset
    packet = cr.build_evidence_packet(manifest, manifest_path.parent)
    first = packet.document["content"]["puzzles"][0]
    target = first["targets"][0]
    retained = target["rank_evidence"]["exact_rank_1_through_250"][0]["word"]

    for item in (
        f"Submit {target['start']['word']} when uncertain.",
        f"Use {retained} as a reusable clue.",
    ):
        with pytest.raises(ValueError, match="privileged evidence word"):
            cr.validate_distillation(
                {"analysis": "audit", "strategy": [item]}, packet
            )

    banned, sentence_runs, evidence_runs = cr._leak_corpus(packet)
    sentence_run = next(iter(sentence_runs))
    monkeypatch.setattr(
        cr,
        "_leak_corpus",
        lambda _packet: (banned - set(sentence_run), sentence_runs, evidence_runs),
    )
    with pytest.raises(ValueError, match="quotes a curriculum sentence"):
        cr.validate_distillation(
            {"analysis": "audit", "strategy": [" ".join(sentence_run)]}, packet
        )


def test_exhausted_strategy_repair_is_checkpointed(dataset, tmp_path):
    provider = RecordingProvider(prose_replies=["bad"] * 3)
    with pytest.raises(cr.CurriculumError, match="invalid after 3 attempts"):
        _run(dataset, tmp_path, provider)
    artifacts = list((tmp_path / "artifacts").rglob("*.json"))
    assert len(artifacts) == 1
    stage = _state(artifacts[0])["distillation"]
    assert stage["status"] == "failed"
    assert len(stage["attempts"]) == 3


def test_resume_continues_after_checkpointed_rejected_distillation_attempt(
    dataset, tmp_path
):
    manifest_path, manifest = dataset

    class StopBeforeSecondAttempt(RecordingProvider):
        def __call__(self, *args, **kwargs):
            if kwargs["output"] == "prose" and len(self.prose_callers) == 1:
                raise KeyboardInterrupt("simulated process interruption")
            return super().__call__(*args, **kwargs)

    interrupted = StopBeforeSecondAttempt(prose_replies=["bad json"])
    with pytest.raises(KeyboardInterrupt, match="process interruption"):
        _run(dataset, tmp_path, interrupted)
    artifact = next((tmp_path / "artifacts").rglob("*.json"))
    assert len(_state(artifact)["distillation"]["attempts"]) == 1

    resumed_provider = _provider_for_full_run(manifest_path, manifest)
    _run(dataset, tmp_path, resumed_provider, resume=artifact)
    attempts = _state(artifact)["distillation"]["attempts"]
    assert len(attempts) == 2
    assert attempts[0]["validation_error"]
    assert attempts[1]["validation_error"] is None
    assert len(resumed_provider.prose_callers) == 1


def test_holdout_cannot_exist_before_strategy_freeze():
    state = {
        "distillation": {"status": "pending", "attempts": []},
        "holdout": {
            "neutral": [{"runs": [{"tries": 1}]}],
            "learned": [],
            "v7": [],
        },
    }
    with pytest.raises(cr.CurriculumError, match="holdout play before strategy freeze"):
        cr._validate_distillation_state(state)


def test_resume_rejects_holdout_without_matching_frozen_strategy_hash(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    artifact = _run(
        dataset, tmp_path, _provider_for_full_run(manifest_path, manifest)
    )
    state = _state(artifact)

    state["distillation"].pop("frozen_strategy_sha256")
    cr.save_artifact(artifact, state)
    with pytest.raises(cr.CurriculumError, match="matching frozen strategy hash"):
        _run(dataset, tmp_path, RecordingProvider(), resume=artifact)

    state["distillation"]["frozen_strategy_sha256"] = "0" * 64
    cr.save_artifact(artifact, state)
    with pytest.raises(cr.CurriculumError, match="matching frozen strategy hash"):
        _run(dataset, tmp_path, RecordingProvider(), resume=artifact)


def test_successful_resume_repeats_no_paid_calls(dataset, tmp_path):
    manifest_path, manifest = dataset
    provider = _provider_for_full_run(manifest_path, manifest)
    artifact = _run(dataset, tmp_path, provider)

    class ExplodingProvider:
        def __call__(self, *_args, **_kwargs):
            raise AssertionError("resume repeated completed paid work")

    resumed = _run(
        dataset,
        tmp_path,
        ExplodingProvider(),
        resume=artifact,
    )
    assert resumed == artifact


def test_resume_rejects_identity_changes_and_force_only_rebuilds_packet_sidecar(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    artifact = _run(
        dataset, tmp_path, _provider_for_full_run(manifest_path, manifest)
    )
    sidecar = Path(_state(artifact)["evidence_packet"]["path"])
    expected_bytes = sidecar.read_bytes()
    sidecar.unlink()

    with pytest.raises(cr.CurriculumError, match="evidence packet.*missing"):
        _run(dataset, tmp_path, RecordingProvider(), resume=artifact)
    _run(
        dataset,
        tmp_path,
        RecordingProvider(),
        resume=artifact,
        force=True,
    )
    assert sidecar.read_bytes() == expected_bytes

    with pytest.raises(cr.CurriculumError, match="play_effort"):
        _run(
            dataset,
            tmp_path,
            RecordingProvider(),
            resume=artifact,
            play_effort="high",
        )


def test_resume_skips_completed_holdout_runs_after_partial_failure(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    all_scripts = []
    for _condition in cr.CONDITIONS:
        for record in _records(manifest, "holdout"):
            all_scripts.extend(
                [_secrets(manifest_path.parent, record)]
                * cr.HOLDOUT_RUNS_PER_CONDITION
            )

    class StopAfterTwo(RecordingProvider):
        def __call__(self, *args, **kwargs):
            if kwargs["output"] == "word" and len(self.word_players) == 2:
                raise RuntimeError("simulated provider outage")
            return super().__call__(*args, **kwargs)

    partial = StopAfterTwo(word_scripts=all_scripts)
    with pytest.raises(RuntimeError, match="provider outage"):
        _run(dataset, tmp_path, partial)
    artifact = next((tmp_path / "artifacts").rglob("*.json"))
    assert cr._completed_play_count(_state(artifact)) == 2

    remaining = RecordingProvider(word_scripts=all_scripts[2:])
    resumed = _run(dataset, tmp_path, remaining, resume=artifact)
    assert resumed == artifact
    assert len(remaining.prose_callers) == 0
    assert len(remaining.word_players) == 7
    assert cr._completed_play_count(_state(artifact)) == 9


def test_bounded_no_progress_reply_failure_is_checkpointed_as_dnf_and_continues(
    dataset, tmp_path
):
    manifest_path, manifest = dataset
    correct = []
    for _condition in cr.CONDITIONS:
        for record in _records(manifest, "holdout"):
            correct.extend(
                [_secrets(manifest_path.parent, record)]
                * cr.HOLDOUT_RUNS_PER_CONDITION
            )
    provider = RecordingProvider(
        word_scripts=[["nonesuch"] * 5, *correct[1:]]
    )
    artifact = _run(dataset, tmp_path, provider)
    state = _state(artifact)
    failed = state["holdout"]["neutral"][0]["runs"][0]

    assert failed["tries"] is None
    assert failed["counted_tries"] == 0
    assert failed["termination_reason"] == "no_progress_replies"
    assert failed["turns"] == 5
    assert cr._completed_play_count(state) == 9


def test_dry_run_builds_and_reports_packet_without_writes_or_calls(
    dataset, tmp_path, capsys
):
    class ExplodingProvider:
        def __call__(self, *_args, **_kwargs):
            raise AssertionError("dry-run constructed a provider")

    result = _run(dataset, tmp_path, ExplodingProvider(), dry_run=True)
    plan = json.loads(capsys.readouterr().out)
    assert result is None
    assert plan["curriculum_play_calls"] == 0
    assert plan["planned_distillation_stage"] == 1
    assert plan["planned_holdout_runs"] == 9
    assert plan["retrospectives"] == 0
    assert plan["evidence_packet"]["curriculum_puzzle_count"] == 3
    assert plan["evidence_packet"]["target_count"] == 9
    assert not (tmp_path / "artifacts").exists()


def test_max_strategy_effort_is_required_and_transport_support_is_preflighted(
    dataset, tmp_path
):
    with pytest.raises(cr.CurriculumError, match="must be 'max'"):
        _run(
            dataset,
            tmp_path,
            RecordingProvider(),
            strategy_effort="high",
            dry_run=True,
        )
    with pytest.raises(cr.CurriculumError, match="does not allow.*max"):
        _run(
            dataset,
            tmp_path,
            RecordingProvider(),
            model="GPT-SOL",
            auth="api",
            dry_run=True,
        )


@pytest.mark.parametrize(
    ("model", "validator_name", "verified"),
    [
        ("OPUS", "validate_anthropic_subscription_auth", "pro"),
        ("GPT-SOL", "validate_openai_subscription_auth", "ChatGPT"),
    ],
)
def test_subscription_preflight_is_recorded_and_repeated_before_resume(
    dataset, tmp_path, monkeypatch, model, validator_name, verified
):
    manifest_path, manifest = dataset
    calls = []
    monkeypatch.setattr(
        cr, validator_name, lambda: calls.append("verified") or verified
    )
    provider = _provider_for_full_run(manifest_path, manifest)
    artifact = _run(
        dataset,
        tmp_path,
        provider,
        model=model,
        auth="subscription",
        play_effort="medium",
    )
    assert calls == ["verified"]
    state = _state(artifact)
    assert state["auth_verifications"][-1]["provider_session"] == verified

    _run(
        dataset,
        tmp_path,
        RecordingProvider(),
        model=model,
        auth="subscription",
        play_effort="medium",
        resume=artifact,
    )
    assert calls == ["verified", "verified"]


def test_prompt_v2_v3_v4_artifacts_are_readable_but_cannot_resume(
    dataset, tmp_path
):
    legacy = {
        "config": {"curriculum_prompt_version": "4"},
        "puzzles": [],
        "holdout": {},
        "synthesis": None,
    }
    report = cr.evaluate_artifact(legacy)
    assert report["legacy"] is True

    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(legacy), encoding="utf-8")
    with pytest.raises(cr.CurriculumError, match="remain readable.*cannot resume"):
        _run(dataset, tmp_path, RecordingProvider(), resume=path)


def _metric_run(tries, *, non_improving=0, streak=0, after100=0):
    return {
        "tries": tries,
        "counted_tries": tries or 50,
        "turns": tries or 50,
        "duration": 1.0,
        "wall_duration": 1.0,
        "turn_token_usage": [],
        "metrics": {
            "non_improving_guesses": non_improving,
            "max_no_improvement_streak": streak,
            "guesses_after_rank100": after100,
        },
    }


def test_evaluation_keeps_dnf_nonnumeric_and_reports_all_five_pairs():
    neutral_entries = []
    learned_entries = []
    v7_entries = []
    for number in range(16, 21):
        neutral_runs = [_metric_run(10), _metric_run(12), _metric_run(None)]
        learned_runs = [_metric_run(8), _metric_run(9), _metric_run(10)]
        v7_runs = [_metric_run(7), _metric_run(11), _metric_run(12)]
        if number == 20:
            neutral_runs = [_metric_run(10), _metric_run(None), _metric_run(None)]
            learned_runs = [_metric_run(8), _metric_run(None), _metric_run(None)]
        neutral_entries.append({"number": number, "runs": neutral_runs})
        learned_entries.append({"number": number, "runs": learned_runs})
        v7_entries.append({"number": number, "runs": v7_runs})
    state = {
        "config": {"curriculum_prompt_version": "5"},
        "distillation": {"strategy": SAFE_STRATEGY, "attempts": []},
        "holdout": {
            "neutral": neutral_entries,
            "learned": learned_entries,
            "v7": v7_entries,
        },
    }
    report = cr.evaluate_artifact(state)

    assert report["holdout"]["neutral"]["per_puzzle_median"]["20"] is None
    assert report["holdout"]["neutral"]["dnf_puzzles"] == 1
    assert report["holdout"]["neutral"]["solved_only_median"] == 12
    assert len(
        report["paired_differences"]["learned_minus_neutral"]["per_puzzle"]
    ) == 5
    pair20 = report["paired_differences"]["learned_minus_neutral"][
        "per_puzzle"
    ]["20"]
    assert pair20["difference"] is None
    assert pair20["outcome"] == "tied_dnf"
    assert report["paired_differences"]["learned_minus_neutral"][
        "paired_dnf_aware_median"
    ] == {"difference": -3, "outcome": "improved"}
    assert report["decision_rule"]["distillation_success"] is True


def test_distilled_and_legacy_profiles_are_readable_but_not_cross_applied():
    profile = sp.build_profile(
        strategy_id="dataset/model/hash",
        model_id="claude-opus-4-8",
        provider="anthropic",
        transport="anthropic-api",
        auth="api",
        strategy_effort="max",
        play_effort="none",
        lang="fr",
        dataset_id="strategy-fr-v1",
        dataset_sha256="d" * 64,
        evidence_packet_schema_version=1,
        evidence_packet_sha256="e" * 64,
        distillation_prompt_sha256="p" * 64,
        prompt_version="16",
        curriculum_prompt_version="5",
        created_at="2026-07-14T00:00:00+00:00",
        final_strategy=SAFE_STRATEGY,
    )
    sp.validate_profile(profile)
    sp.assert_profile_compatible(
        profile,
        model_id="claude-opus-4-8",
        transport="anthropic-api",
        auth="api",
        strategy_effort="max",
        play_effort="none",
    )
    with pytest.raises(ValueError, match="play_effort"):
        sp.assert_profile_compatible(
            profile,
            model_id="claude-opus-4-8",
            transport="anthropic-api",
            auth="api",
            strategy_effort="max",
            play_effort="high",
        )

    legacy = {
        "schema_version": 2,
        "strategy_id": "legacy",
        "model_id": "claude-opus-4-8",
        "provider": "anthropic",
        "transport": "anthropic-api",
        "effort": "none",
        "lang": "fr",
        "dataset_id": "strategy-fr-v1",
        "dataset_sha256": "d" * 64,
        "prompt_version": "16",
        "curriculum_prompt_version": "4",
        "created_at": "2026-07-13T00:00:00+00:00",
        "final_policy": sp.neutral_policy(),
    }
    sp.validate_profile(legacy)
    with pytest.raises(ValueError, match="only distilled schema-v3"):
        sp.assert_profile_compatible(
            legacy,
            model_id="claude-opus-4-8",
            transport="anthropic-api",
            auth="api",
            strategy_effort="max",
            play_effort="none",
        )
