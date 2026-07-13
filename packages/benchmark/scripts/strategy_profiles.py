"""Compact, model-specific strategy profiles (#84).

A profile freezes the final learned strategy of ONE model/configuration on ONE
dataset. Profiles are lab-only artifacts: they never enter puzzle JSON and are
never applied to a different model or configuration.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PROFILE_SCHEMA_VERSION = 1

# The bounded operational-strategy format shared by every strategy revision:
# at most 8 items, at most 2,000 characters total, reusable on unseen puzzles.
STRATEGY_MAX_ITEMS = 8
STRATEGY_MAX_CHARS = 2_000

_REQUIRED_FIELDS = (
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
    "final_strategy",
)


def validate_strategy_items(items: Any) -> list[str]:
    """The bounded strategy format: a list of up to 8 strings, ≤ 2000 chars total."""
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
    """The exact prompt block injected under YOUR STRATEGY, one item per line."""
    return "\n".join(f"- {item}" for item in items)


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
    final_strategy: list[str],
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
        "final_strategy": validate_strategy_items(final_strategy),
    }
    validate_profile(profile)
    return profile


def validate_profile(profile: Any) -> None:
    if not isinstance(profile, dict):
        raise ValueError("profile must be an object")
    missing = [field for field in _REQUIRED_FIELDS if field not in profile]
    if missing:
        raise ValueError(f"profile is missing fields: {', '.join(missing)}")
    if profile["schema_version"] != PROFILE_SCHEMA_VERSION:
        raise ValueError(
            f"unsupported profile schema_version {profile['schema_version']!r}"
        )
    validate_strategy_items(profile["final_strategy"])


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
