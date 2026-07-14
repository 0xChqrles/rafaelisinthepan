"""Curriculum orchestration contract (#84): fresh runs, retrospectives, holdout.

Network-free: a scripted provider factory stands in for paid adapters. Asserts
the issue's isolation rules — same incoming strategy for a puzzle's 3 fresh
runs, retrospection only afterwards, replace-not-append strategy revisions,
leak rejection, frozen holdout conditions, and resume-without-repeat.
"""

import json
import re

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


def policy_with_action(action, *, stall_after=0, warm_rank=0, warm_followups=0):
    policy = sp.neutral_policy()
    policy["always"]["action"] = action
    policy["stall"]["after"] = stall_after
    policy["warm"]["rank_at_most"] = warm_rank
    policy["warm"]["max_followups"] = warm_followups
    return policy


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
            "revised_policy": policy_with_action(
                f"Lesson {lesson}: explore distinct semantic directions early."
            ),
        }
    )


SYNTHESIS_REPLY = json.dumps(
    {
        "comprehensive_summary": "Across the curriculum, direct play won.",
        "final_policy": policy_with_action(
            "Final rule: diversify semantic directions."
        ),
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
        if output == "decision":
            replies = iter(next(self.word_scripts))
            calls = []
            turn = 0
            active_families = {}

            def player(messages):
                nonlocal turn
                calls.append([m.copy() for m in messages])
                word = next(replies)
                turn += 1
                latest = messages[-1]["content"]
                rule = re.findall(r"^rule: ([a-z]+)$", latest, re.MULTILINE)[-1]
                mode = re.findall(
                    r"^required mode: ([a-z]+)$", latest, re.MULTILINE
                )[-1]
                if rule == "warm":
                    targets = latest.rsplit(
                        "warm targets allowed for this rule: ", 1
                    )[1].splitlines()[0]
                else:
                    targets = latest.rsplit(
                        "allowed unsolved targets: ", 1
                    )[1].splitlines()[0]
                target = int(targets.split(",", 1)[0])
                if "disabled by the neutral policy; family must be null" in latest:
                    family = None
                elif rule == "stall":
                    family = f"target-{target}-pivot-{turn}"
                    active_families[target] = family
                else:
                    family = active_families.setdefault(
                        target, f"target-{target}-hypothesis"
                    )
                return json.dumps(
                    {
                        "guess": word,
                        "rule": rule,
                        "mode": mode,
                        "target": target,
                        "family": family,
                    }
                )

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


def one_hole_policy_puzzle():
    return {
        "lang": "fr",
        "words": ["mot"],
        "holes": [
            {
                "pos": 0,
                "secret": {"word": "secret", "slug": "secret"},
                "start": {"word": "indice", "slug": "indice"},
                "start_rank": 5,
            }
        ],
        "ranks": {
            "secret": {"secret": {"word": "secret", "rank": 0}}
        },
    }


def decision(guess, rule, mode, *, family=None, target=1):
    return json.dumps(
        {
            "guess": guess,
            "rule": rule,
            "mode": mode,
            "target": target,
            "family": family,
        }
    )


def test_policy_schema_is_exact_bounded_and_normalized():
    neutral = sp.neutral_policy()
    assert sp.validate_policy(neutral) == neutral
    assert neutral["stall"]["after"] == 0
    assert neutral["warm"]["rank_at_most"] == 0

    missing = sp.neutral_policy()
    del missing["invalid"]
    with pytest.raises(ValueError, match="missing invalid"):
        sp.validate_policy(missing)

    mismatched_warm = sp.neutral_policy()
    mismatched_warm["warm"]["rank_at_most"] = 10
    with pytest.raises(ValueError, match="both be 0.*or both be positive"):
        sp.validate_policy(mismatched_warm)

    boolean_threshold = sp.neutral_policy()
    boolean_threshold["stall"]["after"] = True
    with pytest.raises(ValueError, match="stall.after must be an integer"):
        sp.validate_policy(boolean_threshold)

    multiline = sp.neutral_policy()
    multiline["always"]["action"] = "first\nsecond"
    with pytest.raises(ValueError, match="must be one line"):
        sp.validate_policy(multiline)

    overlong_action = sp.neutral_policy()
    overlong_action["always"]["action"] = "x" * 301
    with pytest.raises(ValueError, match="exceeds 300 characters"):
        sp.validate_policy(overlong_action)


def test_policy_controller_repairs_before_scoring_and_audits_the_decision():
    replies = iter(
        [
            decision("alpha", "stall", "pivot"),
            decision("secret", "invalid", "correct"),
        ]
    )
    attempts = []
    result = cr.play_policy_puzzle(
        one_hole_policy_puzzle(),
        {"alpha", "secret"},
        lambda _messages: next(replies),
        policy=sp.neutral_policy(),
        cap=10,
        on_policy_attempt=attempts.append,
    )

    assert result.termination_reason == "solved"
    assert result.tries == 1
    assert result.turns == 2
    assert result.tried_words == ("secret",)
    assert [attempt["accepted"] for attempt in attempts] == [False, True]
    assert attempts[0]["decision"]["guess"] == "alpha"
    assert attempts[1]["expected_rule"] == "invalid"
    assert attempts[1]["decision"]["family"] is None
    assert attempts[1]["family_event"] == "disabled"


def test_policy_controller_records_failure_instead_of_raising_or_looping():
    replies = iter(["not json"] * cr.POLICY_MAX_ATTEMPTS_PER_TRY)
    result = cr.play_policy_puzzle(
        one_hole_policy_puzzle(),
        {"secret"},
        lambda _messages: next(replies),
        policy=sp.neutral_policy(),
        cap=10,
    )

    assert result.termination_reason == "policy_failure"
    assert result.tries is None
    assert result.counted_tries == 0
    assert result.turns == cr.POLICY_MAX_ATTEMPTS_PER_TRY
    assert result.tried_words == ()
    assert all(not attempt["accepted"] for attempt in result.policy_attempts)


def test_stall_family_constraint_survives_the_invalid_correction_envelope():
    policy = policy_with_action(
        "Explore.", stall_after=1, warm_rank=0, warm_followups=0
    )
    policy["stall"]["action"] = "Change semantic family after one flat guess."
    replies = iter(
        [
            decision("alpha", "always", "explore", family="cluster"),
            decision("beta", "stall", "pivot", family="cluster"),
            decision("gamma", "invalid", "correct", family="cluster"),
            decision(
                "secret", "invalid", "correct", family="different-family"
            ),
        ]
    )
    calls = []

    def reply(messages):
        calls.append(messages)
        return next(replies)

    result = cr.play_policy_puzzle(
        one_hole_policy_puzzle(),
        {"alpha", "beta", "gamma", "secret"},
        reply,
        policy=policy,
        cap=10,
    )

    assert result.termination_reason == "solved"
    assert result.tries == 2
    assert result.tried_words == ("alpha", "secret")
    assert [attempt["accepted"] for attempt in result.policy_attempts] == [
        True,
        False,
        False,
        True,
    ]
    assert result.policy_attempts[-1]["tactical_rule"] == "stall"
    assert 'WORD 1: active family "cluster"' in calls[1][-1]["content"]
    assert "non-improving probes 1/1" in calls[1][-1]["content"]
    assert 'WORD 1: active family "cluster"' in calls[2][-1]["content"]


def test_model_created_family_is_locked_until_its_target_budget_expires():
    policy = policy_with_action(
        "Explore.", stall_after=2, warm_rank=0, warm_followups=0
    )
    policy["stall"]["action"] = "Create a new hypothesis after two flat probes."
    replies = iter(
        [
            decision("alpha", "always", "explore", family="mouvement"),
            decision("beta", "always", "explore", family="mouvement"),
            decision("gamma", "stall", "pivot", family="prudence"),
            decision("delta", "always", "explore", family="prudence"),
            decision("secret", "stall", "pivot", family="urgence"),
        ]
    )
    calls = []

    def reply(messages):
        calls.append(messages)
        return next(replies)

    result = cr.play_policy_puzzle(
        one_hole_policy_puzzle(),
        {"alpha", "beta", "gamma", "delta", "secret"},
        reply,
        policy=policy,
        cap=10,
    )

    assert result.tries == 5
    assert [
        attempt["tactical_rule"] for attempt in result.policy_attempts
    ] == ["always", "always", "stall", "always", "stall"]
    assert [
        attempt["family_event"] for attempt in result.policy_attempts
    ] == ["declare", "continue", "pivot", "continue", "pivot"]
    assert [
        (attempt["family_episode_after"] or {}).get("number")
        for attempt in result.policy_attempts
    ] == [1, 1, 2, 2, 3]
    assert [
        (attempt["family_episode_after"] or {}).get(
            "non_improving_probes"
        )
        for attempt in result.policy_attempts
    ] == [1, 2, 1, 2, 0]
    assert [
        attempt["target_outcome"]["improved"]
        for attempt in result.policy_attempts
    ] == [False, False, False, False, True]
    assert "rule: stall" in calls[2][-1]["content"]
    assert 'active family "mouvement"' in calls[2][-1]["content"]
    # The accepted pivot resets only the family-local counter. The referee's
    # global streak is already 3, but the new episode gets another probe.
    assert "NO-IMPROVEMENT STREAK: 3" in calls[3][-1]["content"]
    assert "rule: always" in calls[3][-1]["content"]
    assert 'active family "prudence"' in calls[3][-1]["content"]
    assert "non-improving probes 1/2" in calls[3][-1]["content"]


def test_family_stall_budget_is_target_local():
    puzzle = {
        "lang": "fr",
        "words": ["un", "deux"],
        "holes": [
            {
                "pos": 0,
                "secret": {"word": "secret", "slug": "secret"},
                "start": {"word": "indice", "slug": "indice"},
                "start_rank": 5,
            },
            {
                "pos": 1,
                "secret": {"word": "réponse", "slug": "reponse"},
                "start": {"word": "départ", "slug": "depart"},
                "start_rank": 5,
            },
        ],
        "ranks": {
            "secret": {"secret": {"word": "secret", "rank": 0}},
            "reponse": {"reponse": {"word": "réponse", "rank": 0}},
        },
    }
    referee = cr.PuzzleReferee(puzzle, {"secret", "reponse"})
    policy = policy_with_action(
        "Explore.", stall_after=2, warm_rank=0, warm_followups=0
    )
    families = {
        1: cr.FamilyEpisode("mouvement", "mouvement", 1, 2),
        2: cr.FamilyEpisode("animal", "animal", 1, 1),
    }

    context = cr.policy_rule_context(
        referee, policy, family_episodes=families, warm_followups={}
    )

    assert context.rule == "stall"
    assert context.targets == (1,)
    assert "2/2" in context.stall_reason(1)


def test_family_cannot_be_relabelled_between_authorized_pivots():
    policy = policy_with_action(
        "Explore.", stall_after=3, warm_rank=0, warm_followups=0
    )
    replies = iter(
        [
            decision("alpha", "always", "explore", family="mouvement"),
            decision("beta", "always", "explore", family="vitesse"),
            decision("secret", "invalid", "correct", family="mouvement"),
        ]
    )

    result = cr.play_policy_puzzle(
        one_hole_policy_puzzle(),
        {"alpha", "beta", "secret"},
        lambda _messages: next(replies),
        policy=policy,
        cap=10,
    )

    assert result.tries == 2
    assert [
        attempt["accepted"] for attempt in result.policy_attempts
    ] == [True, False, True]
    assert "exactly repeat" in result.policy_attempts[1]["error"]
    assert result.policy_attempts[-1]["family_event"] == "continue"


def test_warm_budget_counts_accepted_followups_even_when_they_improve():
    policy = policy_with_action(
        "Explore.", stall_after=0, warm_rank=5, warm_followups=2
    )
    policy["warm"]["action"] = "Follow the warm target for at most two guesses."
    policy["stall"]["action"] = "Pivot after the warm follow-up budget."
    puzzle = one_hole_policy_puzzle()
    puzzle["ranks"]["secret"].update(
        {
            "alpha": {"word": "alpha", "rank": 4},
            "beta": {"word": "beta", "rank": 3},
        }
    )
    replies = iter(
        [
            decision("alpha", "warm", "exploit", family="family-a"),
            decision("beta", "warm", "exploit", family="family-a"),
            decision("gamma", "stall", "pivot", family="family-b"),
            decision("secret", "warm", "exploit", family="family-b"),
        ]
    )
    calls = []

    def reply(messages):
        calls.append(messages)
        return next(replies)

    result = cr.play_policy_puzzle(
        puzzle,
        {"alpha", "beta", "gamma", "secret"},
        reply,
        policy=policy,
        cap=10,
    )

    assert result.tries == 4
    assert [
        attempt["tactical_rule"] for attempt in result.policy_attempts
    ] == ["warm", "warm", "stall", "warm"]
    assert [
        attempt["warm_followups_before"]
        for attempt in result.policy_attempts
    ] == [0, 1, 2, 0]
    assert [
        attempt["warm_followups_after"]
        for attempt in result.policy_attempts
    ] == [1, 2, 0, 0]
    assert [
        attempt["family_event"] for attempt in result.policy_attempts
    ] == ["declare", "continue", "pivot", "continue"]
    assert "accepted warm follow-ups by target: WORD 1 2/2" in (
        calls[2][-1]["content"]
    )
    assert "rule: stall" in calls[2][-1]["content"]
    assert "accepted warm follow-ups by target: WORD 1 0/2" in (
        calls[3][-1]["content"]
    )
    assert "rule: warm" in calls[3][-1]["content"]


def test_full_curriculum_isolates_runs_and_freezes_holdout(
    dataset, tmp_path, capsys
):
    manifest_path, manifest = dataset
    provider = scripted_for(manifest_path, manifest)

    artifact_path = run(dataset, tmp_path, provider)
    state = json.loads(artifact_path.read_text(encoding="utf-8"))

    # 3 curriculum puzzles x 3 runs, each from a genuinely fresh provider context.
    assert len(state["puzzles"]) == 3
    assert provider.constructed == (
        ["decision"] * 3 + ["prose"]
    ) * 3 + ["prose"] + ["decision"] * 9

    first_puzzle = state["puzzles"][0]
    openings = [r["conversation"][0]["content"] for r in first_puzzle["runs"]]
    # First puzzle: the neutral policy has no tactical trigger, and all 3 runs
    # get the same auditable controller prompt.
    assert all("FOUR-RULE POLICY" in opening for opening in openings)
    assert all("No additional neutral tactic" in opening for opening in openings)
    assert all("FROZEN V7 GUIDANCE" not in opening for opening in openings)
    assert len(set(openings)) == 1
    for forbidden in (
        "YOUR METHOD",
        "JUDGMENT:",
        "Embedding relatedness is not transitive",
        "independent sources of evidence",
        "A sequence of related guesses",
    ):
        assert all(forbidden not in opening for opening in openings)
    assert all("FIXED GAME RULES" in opening for opening in openings)
    for record in first_puzzle["runs"]:
        assert all(
            "JUDGMENT:" not in message["content"]
            for message in record["conversation"]
            if message["role"] == "user"
        )
    # The first play response is an auditable decision; only its guess scores.
    for record in first_puzzle["runs"]:
        assert record["conversation"][1]["role"] == "assistant"
        decision = json.loads(record["conversation"][1]["content"])
        assert decision["guess"] == record["tried_words"][0]
        assert decision["rule"] == "always"
        assert decision["family"] is None
        assert record["termination_reason"] == "solved"
        assert record["policy_compliance"]["rejected_decisions"] == 0
        assert record["policy_compliance"]["family_declarations"] == 0
        assert record["policy_attempts"][0]["family_event"] == "disabled"
    # No run transcript leaks into another run: each fresh player saw no
    # assistant content besides its own replies.
    for player in provider.players[:3]:
        own = {
            call_msg["content"]
            for call in player.calls
            for call_msg in call
            if call_msg["role"] == "assistant"
        }
        recorded = {
            message["content"]
            for message in first_puzzle["runs"][
                provider.players.index(player)
            ]["conversation"]
            if message["role"] == "assistant"
        }
        assert own <= recorded

    # Retrospection starts only after all three runs and stores the contract.
    retro = first_puzzle["retrospective"]
    assert retro["revised_policy"]["always"]["action"] == (
        "Lesson alpha: explore distinct semantic directions early."
    )
    assert len(retro["telemetry"]["attempts"]) == 1
    retro_prompt = retro["conversation"][0]["content"]
    assert "authoritative replay trace:" in retro_prompt
    assert "policy decision audit:" in retro_prompt
    assert '"family_episode_after"' in retro_prompt
    assert '"target_outcome"' in retro_prompt
    assert "Semantic families are never supplied by the controller" in retro_prompt
    assert "DECISION OUTPUT CONTRACT" not in retro_prompt
    synthesis_prompt = state["synthesis"]["conversation"][0]["content"]
    for structured_prompt in (retro_prompt, synthesis_prompt):
        assert (
            "non-empty single-line string of at most 300 characters"
            in structured_prompt
        )
        assert "all four actions together may contain at most 800" in (
            structured_prompt
        )
        assert "stall.after must be an integer from 0 to 10000" in (
            structured_prompt
        )
        assert "warm.rank_at_most must be an integer from 0 to 10000" in (
            structured_prompt
        )
        assert "warm.max_followups must be an integer from 0 to 50" in (
            structured_prompt
        )
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
            assert "No additional neutral tactic" in opening
            assert "FROZEN V7 GUIDANCE" not in opening
        elif condition == "learned":
            assert "Final rule: diversify semantic directions." in opening
        else:
            assert V7_TEXT in opening
            assert "FROZEN V7 GUIDANCE — VERBATIM CONTROL TEXT" in opening
            assert "Final rule" not in opening

    # Synthesis and the compact profile artifact.
    assert state["synthesis"]["final_policy"]["always"]["action"] == (
        "Final rule: diversify semantic directions."
    )
    profile = sp.load_profile(artifact_path.with_suffix(".profile.json"))
    assert profile["schema_version"] == 2
    assert profile["final_policy"] == state["synthesis"]["final_policy"]
    assert profile["dataset_sha256"] == manifest["dataset_content_sha256"]
    assert state["config"]["dataset_sha256"] == manifest[
        "dataset_content_sha256"
    ]
    assert state["config"]["policy_family_lifecycle"] == (
        "model_created_per_target_episode"
    )
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
    assert report["holdout"]["neutral"]["policy_compliance"][
        "family_declarations"
    ] == 0
    assert report["holdout"]["v7"]["policy_compliance"][
        "family_declarations"
    ] == 9
    assert report["paired_differences"]["learned_minus_neutral"]
    assert report["cost_split"]["retrospective"]["calls"] == 3
    assert report["cost_split"]["synthesis"]["calls"] == 1

    output = capsys.readouterr().out
    assert "curriculum progress: 0/18 plays checkpointed" in output
    assert "[play 1/18] START curriculum puzzle 1/4 run 1/3" in output
    assert "[play 1/18] DONE curriculum puzzle 1/4 run 1/3 — 3 tries" in output
    assert "[strategy 1/3] START retrospective after puzzle 1/4" in output
    assert "[synthesis] DONE — final 4-rule policy" in output
    assert "[play 18/18] DONE holdout/v7 puzzle 4/4 run 3/3" in output
    assert "curriculum complete:" in output
    assert "try=" not in output
    assert "Lesson alpha" not in output
    assert "Final rule: diversify" not in output


def test_verbose_curriculum_prints_tries_analysis_and_strategies(
    dataset, tmp_path, capsys
):
    manifest_path, manifest = dataset
    provider = scripted_for(manifest_path, manifest)

    run(dataset, tmp_path, provider, verbose=True)
    output = capsys.readouterr().out

    assert '[play 1/18] curriculum puzzle 1/4 run 1/3 try=1 word=' in output
    assert "progress=" in output
    assert "policy=accepted rule=always mode=explore" in output
    assert "[strategy 1/3] retrospective analysis:" in output
    assert "[strategy 1/3] revised policy:" in output
    assert "Lesson alpha: explore distinct semantic directions early." in output
    assert "[synthesis] comprehensive summary:" in output
    assert "[synthesis] final policy:" in output
    assert "Final rule: diversify semantic directions." in output


def test_initial_checkpoint_exists_before_first_provider_turn(
    dataset, tmp_path, capsys
):
    manifest_path, _manifest = dataset
    output_root = tmp_path / "artifacts"

    def inspect_then_stop(*_args, **_kwargs):
        artifacts = list(output_root.rglob("*.json"))
        assert len(artifacts) == 1
        state = json.loads(artifacts[0].read_text(encoding="utf-8"))
        assert state["puzzles"] == []
        assert state["synthesis"] is None
        raise RuntimeError("stop after checkpoint inspection")

    with pytest.raises(RuntimeError, match="checkpoint inspection"):
        cr.run_curriculum(
            manifest_path,
            model="OPUS",
            effort="none",
            auth="api",
            cap=50,
            provider_factory=inspect_then_stop,
            vocab_loader=vocab_loader,
            output_root=output_root,
            v7_strategy=V7_TEXT,
        )

    output = capsys.readouterr().out
    assert "curriculum artifact:" in output
    assert "[play 1/18] START curriculum puzzle 1/4 run 1/3" in output


def test_retrospective_retries_validation_and_resume_skips_completed_plays(
    dataset, tmp_path
):
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
            "revised_policy": policy_with_action(f"Always try {secret} first."),
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
    assert state["puzzles"][0]["retrospective"]["revised_policy"]["always"][
        "action"
    ] == "Lesson alpha: explore distinct semantic directions early."
    assert len(state["puzzles"][0]["retrospective"]["telemetry"]["attempts"]) == 2

    # Four leaking replies exhaust the bounded repair attempts.
    failure_root = tmp_path / "fails"
    provider = scripted_for(
        manifest_path,
        manifest,
        prose_scripts=[[leaking] * cr.STRUCTURED_MAX_ATTEMPTS],
    )
    with pytest.raises(cr.CurriculumError, match="after 4 attempts"):
        run(dataset, failure_root, provider)

    # All three expensive plays precede the retrospective and remain checkpointed.
    artifacts = list((failure_root / "artifacts").rglob("*.json"))
    assert len(artifacts) == 1
    partial_state = json.loads(artifacts[0].read_text(encoding="utf-8"))
    first_puzzle = partial_state["puzzles"][0]
    assert len(first_puzzle["runs"]) == cr.RUNS_PER_PUZZLE
    assert first_puzzle["retrospective"] is None

    # Resume starts at that retrospective; no completed word-play call repeats.
    remaining = scripted_for(manifest_path, manifest)
    remaining.word_scripts = iter(
        list(remaining.word_scripts)[cr.RUNS_PER_PUZZLE :]
    )
    artifact_path = run(
        dataset, failure_root, remaining, resume=artifacts[0]
    )
    resumed_state = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert resumed_state["puzzles"][0]["runs"] == first_puzzle["runs"]
    assert resumed_state["puzzles"][0]["retrospective"] is not None
    assert remaining.constructed[0] == "prose"


def test_strategy_leak_validation_covers_targets_starts_guesses_and_quotes(dataset):
    manifest_path, manifest = dataset
    dataset_dir = manifest_path.parent
    record = [r for r in manifest["puzzles"] if r["split"] == "curriculum"][0]
    puzzle = cd.load_puzzle_json(dataset_dir / record["path"])
    start_word = puzzle["holes"][0]["start"]["word"]
    records = [{"tried_words": ["intrus"]}]

    for item, match in (
        (f"Use {puzzle['holes'][0]['secret']['word']} again.", "leaks puzzle word"),
        (f"The clue {start_word} was useful.", "leaks puzzle word"),
        ("Remember intrus next time.", "leaks puzzle word"),
    ):
        with pytest.raises(ValueError, match=match):
            cr.validate_revised_policy(policy_with_action(item), puzzle, records)

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
        cr.validate_revised_policy(
            policy_with_action("Sentence said: les nuages flottent sur."),
            scenic,
            records,
        )

    # Whole-token and segment checks work in both directions.
    with pytest.raises(ValueError, match="leaks puzzle word"):
        cr.validate_revised_policy(
            policy_with_action("Revisit montagne-neige after a miss."),
            scenic,
            records,
        )
    hyphenated_target = json.loads(json.dumps(scenic))
    hyphenated_target["holes"][0]["secret"] = {
        "word": "nuages-froids",
        "slug": "nuages-froids",
    }
    with pytest.raises(ValueError, match="leaks puzzle word"):
        cr.validate_revised_policy(
            policy_with_action("Revisit nuages after a miss."),
            hyphenated_target,
            records,
        )

    # Quote matching follows word-core slugs, so punctuation/case/accents cannot
    # disguise a three-word sentence run.
    accented = dict(scenic, words=["L'été,", "brille", "sur", "la", "montagne"])
    with pytest.raises(ValueError, match="quotes the puzzle"):
        cr.validate_revised_policy(
            policy_with_action("Remember: ÉTÉ — BRILLE, SUR!"),
            accented,
            records,
        )

    assert cr.validate_revised_policy(
        policy_with_action("Pivot to an opposite after three flat guesses."),
        puzzle,
        records,
    )


def test_resume_never_repeats_completed_paid_calls(dataset, tmp_path, capsys):
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
    capsys.readouterr()

    # Resume: only the REMAINING calls run (total scripts = full set minus 2).
    remaining = scripted_for(manifest_path, manifest)
    remaining.word_scripts = iter(list(remaining.word_scripts)[2:])
    artifact_path = run(
        dataset, tmp_path, remaining, resume=artifacts[0], verbose=True
    )
    state = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert len(state["puzzles"]) == 3
    assert all(len(p["runs"]) == 3 for p in state["puzzles"])
    # The first two recorded runs are the pre-crash ones, byte-identical.
    assert state["puzzles"][0]["runs"][:2] == partial_state["puzzles"][0]["runs"]

    output = capsys.readouterr().out
    assert "curriculum progress: 2/18 plays checkpointed" in output
    assert "[play 3/18] START curriculum puzzle 1/4 run 3/3" in output
    assert "[play 3/18] curriculum puzzle 1/4 run 3/3 try=1" in output

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


def test_prompt_v3_artifact_is_readable_but_not_resumable_as_v4(dataset, tmp_path):
    manifest_path, _manifest = dataset
    artifact = tmp_path / "pilot-v3.json"
    artifact.write_text(
        json.dumps({"config": {"curriculum_prompt_version": "3"}}),
        encoding="utf-8",
    )

    with pytest.raises(cr.CurriculumError, match="readable pilot.*cannot be resumed"):
        cr.run_curriculum(
            manifest_path,
            model="OPUS",
            effort="none",
            auth="api",
            resume=artifact,
            provider_factory=lambda *_args, **_kwargs: pytest.fail(
                "provider must not be built"
            ),
            vocab_loader=vocab_loader,
            output_root=tmp_path / "artifacts",
            v7_strategy=V7_TEXT,
        )


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


def test_structured_call_repairs_overlong_policy_with_below_cap_margin():
    too_long = policy_with_action("x" * 250)
    too_long["stall"]["action"] = "y" * 250
    too_long["warm"]["action"] = "z" * 250
    too_long["invalid"]["action"] = "q" * 250
    overlong = json.dumps({"policy": too_long})
    corrected_policy = policy_with_action("Keep the policy concise.")
    corrected = json.dumps({"policy": corrected_policy})

    class Caller:
        def __init__(self):
            self.replies = iter(
                [overlong] * (cr.STRUCTURED_MAX_ATTEMPTS - 1) + [corrected]
            )

        def __call__(self, _messages):
            return next(self.replies)

    retries = []
    parsed, messages, telemetry = cr.structured_call(
        Caller(),
        "prompt",
        lambda payload: sp.validate_policy(payload["policy"]),
        on_retry=lambda attempt, error: retries.append((attempt, error)),
    )

    assert parsed == corrected_policy
    assert len(telemetry["attempts"]) == cr.STRUCTURED_MAX_ATTEMPTS
    assert [attempt for attempt, _error in retries] == [2, 3, 4]
    repair_messages = messages[2::2]
    assert len(repair_messages) == 3
    assert all(
        str(cr.STRUCTURED_POLICY_REPAIR_TARGET_CHARS)
        in message["content"]
        for message in repair_messages
    )
    assert all(
        f"hard {sp.POLICY_MAX_ACTION_CHARS}-character cap" in message["content"]
        for message in repair_messages
    )


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
