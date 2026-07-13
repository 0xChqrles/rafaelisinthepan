"""Deterministic curriculum dataset builder (#84).

The LLM authors candidate sentences/targets (recorded verbatim in
`generator-output.json`); everything that decides what enters the dataset is
deterministic code in this module: vocabulary membership, exact-once target
location, slugs, rank maps, start selection in the curriculum band, frequency
bands, balance quotas, split stratification, manifests, and hashes. Malformed
LLM output is rejected with a reason — never silently rewritten.

Reuses generation's canonical target-location / slug / rank-map / start-variant
logic; nothing here re-filters vocabulary or changes daily-generation defaults.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import random
import re
import sys
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_DIR = SCRIPT_DIR.parent
REPO_ROOT = BENCHMARK_DIR.parent.parent
GENERATION_SCRIPTS_DIR = REPO_ROOT / "packages" / "generation" / "scripts"
DATASETS_DIR = BENCHMARK_DIR / "datasets"

sys.path.insert(0, str(GENERATION_SCRIPTS_DIR))
sys.path.insert(0, str(SCRIPT_DIR))
from slug import slug  # noqa: E402
from phrase_core import (  # noqa: E402  (stdlib-only shared contract)
    TOP_K,
    build_lang_config,
    build_rank_map,
    display_token,
    locate_core,
    make_hole,
)
from start_word import is_variant  # noqa: E402

SCHEMA_VERSION = 1
DATASET_ID = "strategy-fr-v1"
LANG = "fr"

PUZZLE_COUNT = 20
CURRICULUM_COUNT = 15
HOLDOUT_COUNT = 5
TARGETS_PER_PUZZLE = 3

# Curriculum start band on the FINAL STORED start rank (secret = 0, nearest
# neighbor = 1). Independent of daily generation's 50-150 default; never falls
# back outside the band.
START_RANK_LO = 100
START_RANK_HI = 150

POS_VALUES = ("noun", "adjective", "verb", "adverb")
GENDERED_POS = ("noun", "adjective")
GENDER_VALUES = ("m", "f")
SEMANTIC_CLASSES = ("tangible", "abstract")

# Frequency source: the reduced vocabulary's order (V). A word's frequency rank
# is its 0-based index in V; `common` is the head of that ordering.
COMMON_MAX_FREQ_RANK = 20_000

# Sentences must not talk about the game itself.
META_LANGUAGE_SLUGS = frozenset(
    {"embedding", "cloze", "puzzle", "indice", "deviner", "rang", "guess", "slug"}
)

# The canonical fr regex config (word cores, alphabet) from phrase_core.
_FR_CFG = build_lang_config()[LANG]


@dataclass(frozen=True)
class Quotas:
    """Target-slot balance quotas. Defaults are the issue's 60-slot dataset."""

    puzzle_count: int = PUZZLE_COUNT
    curriculum_count: int = CURRICULUM_COUNT
    per_pos: dict[str, int] = field(
        default_factory=lambda: {pos: 15 for pos in POS_VALUES}
    )
    per_gender: dict[str, int] = field(default_factory=lambda: {"m": 15, "f": 15})
    per_frequency_band: dict[str, int] = field(
        default_factory=lambda: {"common": 30, "difficult": 30}
    )

    @property
    def holdout_count(self) -> int:
        return self.puzzle_count - self.curriculum_count


@dataclass
class Target:
    word: str
    pos: str
    semantic_class: str
    gender: str | None
    token_index: int
    prefix: str
    suffix: str
    frequency_rank: int

    @property
    def slug(self) -> str:
        return slug(self.word)

    @property
    def frequency_band(self) -> str:
        return "common" if self.frequency_rank < COMMON_MAX_FREQ_RANK else "difficult"


@dataclass
class Candidate:
    index: int
    sentence: str
    words: list[str]
    targets: list[Target]


@dataclass
class Rejection:
    index: int
    sentence: str
    reason: str


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def frequency_lookup(V: list[str]) -> dict[str, int]:
    """Word -> frequency rank, built ONCE from the reduced vocabulary order."""
    return {word: rank for rank, word in enumerate(V)}


def validate_candidate(
    index: int, raw: Any, freq: dict[str, int]
) -> Candidate | Rejection:
    """Deterministically validate one LLM-authored candidate.

    Checks structure, vocabulary membership (pre-slug display form must be in the
    reduced vocabulary), exact-once location of every target inside the sentence's
    word-cores, distinct slugs, per-sentence POS/domain caps, and meta-language.
    """
    sentence = raw.get("sentence") if isinstance(raw, dict) else None
    try:
        _require(isinstance(raw, dict), "candidate must be an object")
        _require(
            isinstance(sentence, str) and sentence.strip(), "missing sentence"
        )
        raw_targets = raw.get("targets")
        _require(
            isinstance(raw_targets, list) and len(raw_targets) == TARGETS_PER_PUZZLE,
            f"needs exactly {TARGETS_PER_PUZZLE} targets",
        )

        words = [display_token(tok) for tok in sentence.split()]
        for core in (m.group() for tok in words for m in _FR_CFG["core_re"].finditer(tok)):
            _require(
                slug(core) not in META_LANGUAGE_SLUGS,
                f"meta-language word {core!r} in sentence",
            )

        targets: list[Target] = []
        for raw_target in raw_targets:
            _require(isinstance(raw_target, dict), "target must be an object")
            word = raw_target.get("word")
            pos = raw_target.get("pos")
            semantic_class = raw_target.get("semantic_class")
            gender = raw_target.get("gender")
            _require(isinstance(word, str) and bool(word), "target missing word")
            word = unicodedata.normalize("NFC", word.lower())
            _require(pos in POS_VALUES, f"invalid pos {pos!r}")
            _require(
                semantic_class in SEMANTIC_CLASSES,
                f"invalid semantic_class {semantic_class!r}",
            )
            if pos in GENDERED_POS:
                _require(
                    gender in GENDER_VALUES,
                    f"{pos} target {word!r} needs gender m|f",
                )
            else:
                gender = None
            _require(
                word in freq,
                f"target {word!r} is not in the reduced vocabulary",
            )

            target_slug = slug(word)
            locations = []
            for token_index, token in enumerate(words):
                located = locate_core(token, target_slug, _FR_CFG)
                if located is not None:
                    locations.append((token_index, located))
            _require(
                len(locations) == 1,
                f"target {word!r} must appear exactly once "
                f"(found {len(locations)})",
            )
            token_index, (core, prefix, suffix) = locations[0]
            _require(
                core == word,
                f"target {word!r} must appear as its exact inflection "
                f"(sentence has {core!r})",
            )
            targets.append(
                Target(
                    word=word,
                    pos=pos,
                    semantic_class=semantic_class,
                    gender=gender,
                    token_index=token_index,
                    prefix=prefix,
                    suffix=suffix,
                    frequency_rank=freq[word],
                )
            )

        slugs = [target.slug for target in targets]
        _require(len(set(slugs)) == TARGETS_PER_PUZZLE, "target slugs must be distinct")
        token_indexes = [target.token_index for target in targets]
        _require(
            len(set(token_indexes)) == TARGETS_PER_PUZZLE,
            "targets must occupy distinct tokens",
        )
        pos_counts: dict[str, int] = {}
        class_counts: dict[str, int] = {}
        for target in targets:
            pos_counts[target.pos] = pos_counts.get(target.pos, 0) + 1
            class_counts[target.semantic_class] = (
                class_counts.get(target.semantic_class, 0) + 1
            )
        _require(
            max(pos_counts.values()) < TARGETS_PER_PUZZLE,
            "three targets share one POS",
        )
        _require(
            max(class_counts.values()) < TARGETS_PER_PUZZLE,
            "three targets share one semantic domain",
        )
    except ValueError as exc:
        return Rejection(
            index=index,
            sentence=sentence if isinstance(sentence, str) else "",
            reason=str(exc),
        )

    return Candidate(
        index=index,
        sentence=sentence.strip(),
        words=words,
        targets=targets,
    )


def _candidate_key(candidate: Candidate) -> str:
    return hashlib.sha256(candidate.sentence.encode("utf-8")).hexdigest()


def select_balanced(
    candidates: list[Candidate], *, seed: int, quotas: Quotas
) -> list[Candidate]:
    """Deterministic quota-exact selection via seeded, ordered backtracking.

    Raises with a shortfall report when no subset satisfies the quotas — the
    remedy is generating more candidates, never relaxing a quota silently.
    """
    ordered = sorted(candidates, key=_candidate_key)
    random.Random(seed).shuffle(ordered)

    need_pos = dict(quotas.per_pos)
    need_gender = dict(quotas.per_gender)
    need_band = dict(quotas.per_frequency_band)
    chosen: list[Candidate] = []
    used_slugs: set[str] = set()

    def fits(candidate: Candidate) -> bool:
        if any(target.slug in used_slugs for target in candidate.targets):
            return False
        pos_take: dict[str, int] = {}
        gender_take: dict[str, int] = {}
        band_take: dict[str, int] = {}
        for target in candidate.targets:
            pos_take[target.pos] = pos_take.get(target.pos, 0) + 1
            if target.gender is not None:
                gender_take[target.gender] = gender_take.get(target.gender, 0) + 1
            band_take[target.frequency_band] = (
                band_take.get(target.frequency_band, 0) + 1
            )
        return (
            all(need_pos.get(pos, 0) >= n for pos, n in pos_take.items())
            and all(need_gender.get(g, 0) >= n for g, n in gender_take.items())
            and all(need_band.get(b, 0) >= n for b, n in band_take.items())
        )

    def apply(candidate: Candidate, sign: int) -> None:
        for target in candidate.targets:
            need_pos[target.pos] -= sign
            if target.gender is not None:
                need_gender[target.gender] -= sign
            need_band[target.frequency_band] -= sign
            if sign > 0:
                used_slugs.add(target.slug)
            else:
                used_slugs.discard(target.slug)

    def search(start: int) -> bool:
        if len(chosen) == quotas.puzzle_count:
            return all(v == 0 for v in need_pos.values()) and all(
                v == 0 for v in need_gender.values()
            ) and all(v == 0 for v in need_band.values())
        if len(ordered) - start < quotas.puzzle_count - len(chosen):
            return False
        for i in range(start, len(ordered)):
            candidate = ordered[i]
            if not fits(candidate):
                continue
            chosen.append(candidate)
            apply(candidate, +1)
            if search(i + 1):
                return True
            apply(candidate, -1)
            chosen.pop()
        return False

    if not search(0):
        raise ValueError(
            "no balanced selection exists for these candidates; generate more. "
            f"Remaining quota when search failed: pos={need_pos} "
            f"gender={need_gender} frequency={need_band}"
        )
    return list(chosen)


def stratify_split(
    selected: list[Candidate], *, quotas: Quotas
) -> tuple[list[Candidate], list[Candidate]]:
    """Deterministic 15/5 split with the holdout mirroring the POS mix."""
    holdout_slots = quotas.holdout_count * TARGETS_PER_PUZZLE
    per_pos_cap = -(-holdout_slots // len(POS_VALUES))  # ceil
    holdout: list[Candidate] = []
    holdout_pos: dict[str, int] = {pos: 0 for pos in POS_VALUES}

    for candidate in sorted(selected, key=_candidate_key):
        if len(holdout) == quotas.holdout_count:
            break
        counts = {pos: 0 for pos in POS_VALUES}
        for target in candidate.targets:
            counts[target.pos] += 1
        if all(
            holdout_pos[pos] + counts[pos] <= per_pos_cap for pos in POS_VALUES
        ):
            holdout.append(candidate)
            for pos in POS_VALUES:
                holdout_pos[pos] += counts[pos]

    if len(holdout) < quotas.holdout_count:  # fill deterministically if caps bind
        for candidate in sorted(selected, key=_candidate_key):
            if len(holdout) == quotas.holdout_count:
                break
            if candidate not in holdout:
                holdout.append(candidate)

    holdout_keys = {_candidate_key(c) for c in holdout}
    curriculum = [c for c in selected if _candidate_key(c) not in holdout_keys]
    return curriculum, holdout


def curriculum_start(
    secret: str,
    rank_map: dict[str, Any],
    *,
    rng: random.Random,
    used_start_slugs: set[str],
) -> tuple[str, int] | None:
    """Pick a start by FINAL STORED rank in [START_RANK_LO, START_RANK_HI].

    Excludes morphological variants of the secret; prefers starts unused in the
    puzzle; NEVER falls back outside the band (None -> reject the candidate).
    """
    band = sorted(
        (
            (entry["word"], entry["rank"])
            for entry in rank_map.values()
            if START_RANK_LO <= entry["rank"] <= START_RANK_HI
            and not is_variant(entry["word"], secret)
        ),
        key=lambda pair: (pair[1], pair[0]),
    )
    if not band:
        return None
    fresh = [pair for pair in band if slug(pair[0]) not in used_start_slugs]
    return rng.choice(fresh or band)


RankingFor = Callable[[str], list[tuple[str, int, float]]]


def build_puzzle(
    candidate: Candidate, *, ranking_for: RankingFor, rng: random.Random
) -> dict[str, Any] | Rejection:
    """One candidate -> one canonical puzzle JSON (same schema as generation)."""
    holes = []
    ranks: dict[str, Any] = {}
    used_start_slugs: set[str] = set()
    for target in sorted(candidate.targets, key=lambda t: t.token_index):
        rank_map = build_rank_map(target.word, ranking_for(target.word))
        start = curriculum_start(
            target.word, rank_map, rng=rng, used_start_slugs=used_start_slugs
        )
        if start is None:
            return Rejection(
                index=candidate.index,
                sentence=candidate.sentence,
                reason=(
                    f"target {target.word!r} has no eligible start in "
                    f"[{START_RANK_LO}, {START_RANK_HI}]"
                ),
            )
        start_word, start_rank = start
        used_start_slugs.add(slug(start_word))
        holes.append(
            make_hole(
                target.word,
                target.prefix,
                target.suffix,
                target.token_index,
                start_word,
                start_rank,
            )
        )
        ranks[target.slug] = rank_map
    return {
        "lang": LANG,
        "words": candidate.words,
        "holes": holes,
        "ranks": ranks,
    }


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _puzzle_stem(number: int, candidate: Candidate) -> str:
    slugs = "_".join(
        target.slug
        for target in sorted(candidate.targets, key=lambda t: t.token_index)
    )
    return f"{number:03d}-{slugs}"


def build_dataset(
    generator_output: dict[str, Any],
    *,
    V: list[str],
    ranking_for: RankingFor,
    seed: int,
    out_dir: Path,
    quotas: Quotas | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Validate, select, split, build, and write the dataset deterministically.

    Returns the manifest. `dry_run` stops after validation/selection and writes
    nothing (no ranking_for calls either).
    """
    quotas = quotas or Quotas()
    raw_candidates = generator_output.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise ValueError('generator output needs a non-empty "candidates" array')

    freq = frequency_lookup(V)
    validated: list[Candidate] = []
    rejections: list[Rejection] = []
    for index, raw in enumerate(raw_candidates):
        result = validate_candidate(index, raw, freq)
        (validated if isinstance(result, Candidate) else rejections).append(result)

    selected = select_balanced(validated, seed=seed, quotas=quotas)
    curriculum, holdout = stratify_split(selected, quotas=quotas)

    if dry_run:
        return {
            "dry_run": True,
            "valid_candidates": len(validated),
            "rejections": [vars(r) for r in rejections],
            "curriculum": [c.sentence for c in curriculum],
            "holdout": [c.sentence for c in holdout],
        }

    rng = random.Random(seed)
    puzzles_dir = out_dir / "puzzles"
    puzzles_dir.mkdir(parents=True, exist_ok=True)

    puzzle_records = []
    balance: dict[str, dict[str, int]] = {
        "pos": {}, "gender": {}, "frequency_band": {}, "semantic_class": {}
    }
    ordered = curriculum + holdout
    for number, candidate in enumerate(ordered, start=1):
        built = build_puzzle(candidate, ranking_for=ranking_for, rng=rng)
        if isinstance(built, Rejection):
            raise ValueError(
                f"selected candidate failed the start band and must be replaced: "
                f"{built.reason} (sentence: {built.sentence!r})"
            )
        stem = _puzzle_stem(number, candidate)
        path = puzzles_dir / f"{stem}.json"
        path.write_text(
            json.dumps(built, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        split = "curriculum" if number <= quotas.curriculum_count else "holdout"
        target_records = []
        for target, hole in zip(
            sorted(candidate.targets, key=lambda t: t.token_index), built["holes"]
        ):
            balance["pos"][target.pos] = balance["pos"].get(target.pos, 0) + 1
            if target.gender:
                balance["gender"][target.gender] = (
                    balance["gender"].get(target.gender, 0) + 1
                )
            balance["frequency_band"][target.frequency_band] = (
                balance["frequency_band"].get(target.frequency_band, 0) + 1
            )
            balance["semantic_class"][target.semantic_class] = (
                balance["semantic_class"].get(target.semantic_class, 0) + 1
            )
            target_records.append(
                {
                    "word": target.word,
                    "slug": target.slug,
                    "pos": target.pos,
                    "gender": target.gender,
                    "frequency_rank": target.frequency_rank,
                    "frequency_band": target.frequency_band,
                    "semantic_class": target.semantic_class,
                    "start": hole["start"]["word"],
                    "start_rank": hole["start_rank"],
                }
            )
        puzzle_records.append(
            {
                "number": number,
                "split": split,
                "path": f"puzzles/{stem}.json",
                "sha256": _sha256_file(path),
                "sentence": candidate.sentence,
                "targets": target_records,
            }
        )

    generator = generator_output.get("generator", {})
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "dataset_id": DATASET_ID,
        "lang": LANG,
        "seed": seed,
        "generator": generator,
        "vocabulary": {
            "source": "reduced-vocabulary order (V)",
            "size": len(V),
            "sha256": _sha256_text("\n".join(V)),
        },
        "frequency_bands": {
            "common": f"frequency rank < {COMMON_MAX_FREQ_RANK}",
            "difficult": f"frequency rank >= {COMMON_MAX_FREQ_RANK}",
        },
        "start_band": {"lo": START_RANK_LO, "hi": START_RANK_HI},
        "counts": {
            "puzzles": quotas.puzzle_count,
            "curriculum": quotas.curriculum_count,
            "holdout": quotas.holdout_count,
        },
        "balance": balance,
        "puzzles": puzzle_records,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "generator-output.json").write_text(
        json.dumps(generator_output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def _real_embedding() -> tuple[list[str], RankingFor]:
    """Load the fr reduced embedding once and expose the canonical ranking."""
    import french_neighbors

    kv = french_neighbors.load_vectors()
    V = french_neighbors.build_vocab(kv)
    M = french_neighbors.build_matrix(kv, V)

    def ranking_for(word: str) -> list[tuple[str, int, float]]:
        return french_neighbors.closest(word, kv, V, M, n=TOP_K)

    return V, ranking_for


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from-output",
        type=Path,
        required=True,
        help="generator-output.json with LLM-authored candidates",
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument(
        "--out-dir", type=Path, default=DATASETS_DIR / DATASET_ID
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and select without loading the embedding or writing",
    )
    args = parser.parse_args(argv)

    generator_output = json.loads(args.from_output.read_text(encoding="utf-8"))
    if args.dry_run:
        import french_neighbors

        kv = french_neighbors.load_vectors()
        V = french_neighbors.build_vocab(kv)
        report = build_dataset(
            generator_output,
            V=V,
            ranking_for=lambda word: [],
            seed=args.seed,
            out_dir=args.out_dir,
            dry_run=True,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    V, ranking_for = _real_embedding()
    manifest = build_dataset(
        generator_output,
        V=V,
        ranking_for=ranking_for,
        seed=args.seed,
        out_dir=args.out_dir,
    )
    print(
        f"dataset {manifest['dataset_id']} written to {args.out_dir} "
        f"({manifest['counts']['curriculum']} curriculum + "
        f"{manifest['counts']['holdout']} holdout)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
