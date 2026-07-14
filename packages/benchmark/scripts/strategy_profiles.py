"""Compact, model-specific strategy policy profiles (#84).

A profile freezes the final learned policy of ONE model/configuration on ONE
dataset. Profiles are lab-only artifacts: they never enter puzzle JSON and are
never applied to a different model or configuration.

Schema v2 replaces the free-form v1 strategy list with four controller rules.
Legacy profiles remain readable for evaluation, but artifacts from an earlier
curriculum prompt can never be resumed under a later prompt because the run
configuration is version-pinned.
"""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

PROFILE_SCHEMA_VERSION = 2
LEGACY_PROFILE_SCHEMA_VERSION = 1

# Kept only to validate/read already-paid prompt-v2 profiles. New runs never
# produce or inject this free-form format.
STRATEGY_MAX_ITEMS = 8
STRATEGY_MAX_CHARS = 2_000

POLICY_RULES = ("always", "stall", "warm", "invalid")
POLICY_MAX_ACTION_CHARS = 800
POLICY_MAX_ACTION_ITEM_CHARS = 300
POLICY_MAX_STALL_AFTER = 10_000
POLICY_MAX_WARM_RANK = 10_000
POLICY_MAX_WARM_FOLLOWUPS = 50

# The neutral arm uses the same auditable decision envelope without receiving a
# tactical reset or local-search instruction. Zero disables either conditional
# rule.
NEUTRAL_POLICY: dict[str, Any] = {
    "always": {
        "action": "Choose one valid untried word for an unsolved target."
    },
    "stall": {
        "after": 0,
        "action": "No additional neutral tactic is prescribed.",
    },
    "warm": {
        "rank_at_most": 0,
        "max_followups": 0,
        "action": "No additional neutral tactic is prescribed.",
    },
    "invalid": {
        "action": "Correct the rejected response with a valid untried word."
    },
}

_COMMON_PROFILE_FIELDS = (
    "schema_version",
    "strategy_id",
    "model_id",
    "provider",
    "transport",
    "effort",
    "lang",
    "dataset_id",
    "dataset_sha256",
    "prompt_version",
    "curriculum_prompt_version",
    "created_at",
)


def neutral_policy() -> dict[str, Any]:
    """Return a fresh neutral policy so callers cannot mutate the constant."""
    return deepcopy(NEUTRAL_POLICY)


def validate_strategy_items(items: Any) -> list[str]:
    """Validate the legacy prompt-v2 free-form strategy representation."""
    if not isinstance(items, list) or not items:
        raise ValueError("strategy must be a non-empty list of strings")
    if len(items) > STRATEGY_MAX_ITEMS:
        raise ValueError(f"strategy exceeds {STRATEGY_MAX_ITEMS} items")
    if not all(isinstance(item, str) and item.strip() for item in items):
        raise ValueError("every strategy item must be a non-empty string")
    total = sum(len(item) for item in items)
    if total > STRATEGY_MAX_CHARS:
        raise ValueError(
            f"strategy is {total} characters; the cap is {STRATEGY_MAX_CHARS}"
        )
    return [item.strip() for item in items]


def strategy_text(items: list[str]) -> str:
    """Render legacy prompt-v2 items for read-only artifact tooling."""
    return "\n".join(f"- {item}" for item in validate_strategy_items(items))


def _plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if extra:
            details.append("unexpected " + ", ".join(extra))
        raise ValueError(f"{label} has wrong fields ({'; '.join(details)})")


def _action(rule: Any, expected: set[str], label: str) -> str:
    if not isinstance(rule, dict):
        raise ValueError(f"policy {label} rule must be an object")
    _exact_keys(rule, expected, f"policy {label} rule")
    action = rule.get("action")
    if not isinstance(action, str) or not action.strip():
        raise ValueError(f"policy {label}.action must be a non-empty string")
    action = action.strip()
    if "\n" in action or "\r" in action:
        raise ValueError(f"policy {label}.action must be one line")
    if len(action) > POLICY_MAX_ACTION_ITEM_CHARS:
        raise ValueError(
            f"policy {label}.action exceeds {POLICY_MAX_ACTION_ITEM_CHARS} characters"
        )
    return action


def validate_policy(policy: Any) -> dict[str, Any]:
    """Validate and normalize the four-rule controller policy."""
    if not isinstance(policy, dict):
        raise ValueError("policy must be an object")
    _exact_keys(policy, set(POLICY_RULES), "policy")

    always_action = _action(policy["always"], {"action"}, "always")
    invalid_action = _action(policy["invalid"], {"action"}, "invalid")
    stall_action = _action(policy["stall"], {"after", "action"}, "stall")
    warm_action = _action(
        policy["warm"],
        {"rank_at_most", "max_followups", "action"},
        "warm",
    )

    stall_after = policy["stall"].get("after")
    if (
        not _plain_int(stall_after)
        or stall_after < 0
        or stall_after > POLICY_MAX_STALL_AFTER
    ):
        raise ValueError(
            "policy stall.after must be an integer from 0 to "
            f"{POLICY_MAX_STALL_AFTER}; 0 disables the standalone threshold"
        )

    warm_rank = policy["warm"].get("rank_at_most")
    if (
        not _plain_int(warm_rank)
        or warm_rank < 0
        or warm_rank > POLICY_MAX_WARM_RANK
    ):
        raise ValueError(
            "policy warm.rank_at_most must be an integer from 0 to "
            f"{POLICY_MAX_WARM_RANK}; 0 disables the rule"
        )
    warm_followups = policy["warm"].get("max_followups")
    if (
        not _plain_int(warm_followups)
        or warm_followups < 0
        or warm_followups > POLICY_MAX_WARM_FOLLOWUPS
    ):
        raise ValueError(
            "policy warm.max_followups must be an integer from 0 to "
            f"{POLICY_MAX_WARM_FOLLOWUPS}"
        )
    if (warm_rank == 0) != (warm_followups == 0):
        raise ValueError(
            "policy warm.rank_at_most and max_followups must either both be 0 "
            "(disabled) or both be positive"
        )

    actions = (always_action, stall_action, warm_action, invalid_action)
    total = sum(len(action) for action in actions)
    if total > POLICY_MAX_ACTION_CHARS:
        raise ValueError(
            f"policy is {total} action characters; the cap is "
            f"{POLICY_MAX_ACTION_CHARS}"
        )

    return {
        "always": {"action": always_action},
        "stall": {"after": stall_after, "action": stall_action},
        "warm": {
            "rank_at_most": warm_rank,
            "max_followups": warm_followups,
            "action": warm_action,
        },
        "invalid": {"action": invalid_action},
    }


def policy_text(policy: dict[str, Any]) -> str:
    """Canonical compact JSON used in play prompts and artifacts."""
    return json.dumps(
        validate_policy(policy), ensure_ascii=False, separators=(",", ":")
    )


def policy_actions(policy: dict[str, Any]) -> tuple[str, ...]:
    normalized = validate_policy(policy)
    return tuple(normalized[name]["action"] for name in POLICY_RULES)


def build_profile(
    *,
    strategy_id: str,
    model_id: str,
    provider: str,
    transport: str,
    effort: str,
    lang: str,
    dataset_id: str,
    dataset_sha256: str,
    prompt_version: str,
    curriculum_prompt_version: str,
    created_at: str,
    final_policy: dict[str, Any],
) -> dict[str, Any]:
    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "strategy_id": strategy_id,
        "model_id": model_id,
        "provider": provider,
        "transport": transport,
        "effort": effort,
        "lang": lang,
        "dataset_id": dataset_id,
        "dataset_sha256": dataset_sha256,
        "prompt_version": prompt_version,
        "curriculum_prompt_version": curriculum_prompt_version,
        "created_at": created_at,
        "final_policy": validate_policy(final_policy),
    }
    validate_profile(profile)
    return profile


def validate_profile(profile: Any) -> None:
    if not isinstance(profile, dict):
        raise ValueError("profile must be an object")
    missing = [field for field in _COMMON_PROFILE_FIELDS if field not in profile]
    if missing:
        raise ValueError(f"profile is missing fields: {', '.join(missing)}")
    schema_version = profile["schema_version"]
    if schema_version == PROFILE_SCHEMA_VERSION:
        if "final_policy" not in profile:
            raise ValueError("profile is missing fields: final_policy")
        validate_policy(profile["final_policy"])
        return
    if schema_version == LEGACY_PROFILE_SCHEMA_VERSION:
        # Read-only compatibility for already-paid pilot artifacts.
        if "final_strategy" not in profile:
            raise ValueError("legacy profile is missing fields: final_strategy")
        validate_strategy_items(profile["final_strategy"])
        return
    raise ValueError(f"unsupported profile schema_version {schema_version!r}")


def assert_profile_compatible(
    profile: dict[str, Any],
    *,
    model_id: str,
    transport: str,
    effort: str,
) -> None:
    """Profiles are model/configuration specific — never cross-applied."""
    validate_profile(profile)
    for field, expected in (
        ("model_id", model_id),
        ("transport", transport),
        ("effort", effort),
    ):
        if profile[field] != expected:
            raise ValueError(
                f"profile {field} {profile[field]!r} does not match the "
                f"requested {field} {expected!r}; profiles are never applied "
                "across models or configurations"
            )


def write_profile(path: Path, profile: dict[str, Any]) -> None:
    validate_profile(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def load_profile(path: Path) -> dict[str, Any]:
    profile = json.loads(path.read_text(encoding="utf-8"))
    validate_profile(profile)
    return profile
