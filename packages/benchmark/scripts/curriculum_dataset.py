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
import csv
from dataclasses import dataclass, field
import hashlib
import io
import json
from pathlib import Path
import random
import shutil
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
from curriculum_io import (  # noqa: E402
    load_json as load_puzzle_json,  # noqa: F401 (public test/script convenience)
    read_data_bytes,
    sha256_bytes,
    write_deterministic_gzip,
)

SCHEMA_VERSION = 2
CALIBRATED_DATASET_SCHEMA_VERSION = 4
CALIBRATION_POOL_SCHEMA_VERSION = 1
CALIBRATION_POOL_KIND = "holdout_calibration_candidates"
CALIBRATION_CANDIDATE_SPLIT = "calibration_candidate"
CALIBRATION_TRAINING_MANIFEST_KIND = "calibration_training_split"
CALIBRATION_TEST_MANIFEST_KIND = "calibration_test_split"
MIN_CALIBRATION_CANDIDATES = 45
DATASET_ID = "strategy-fr-v1"
CALIBRATED_DATASET_ID = "strategy-fr-v2"
LANG = "fr"

LEXIQUE_SOURCE_PATH = (
    REPO_ROOT / "packages" / "generation" / "wordlist" / ".cache" / "fr.lexique.tsv"
)
FR_LEXICON_PATH = DATASETS_DIR / "fr-lexicon.tsv.gz"

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

CanonicalMetadata = dict[str, set[tuple[str, str | None]]]


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


def _canonical_rows(metadata: CanonicalMetadata) -> list[tuple[str, str, str]]:
    return sorted(
        (word, pos, gender or "")
        for word, entries in metadata.items()
        for pos, gender in entries
    )


def canonical_metadata_bytes(metadata: CanonicalMetadata) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter="\t", lineterminator="\n")
    writer.writerow(("word", "pos", "gender"))
    writer.writerows(_canonical_rows(metadata))
    return output.getvalue().encode("utf-8")


def build_fr_lexicon(
    V: list[str],
    *,
    source_path: Path = LEXIQUE_SOURCE_PATH,
    out_path: Path = FR_LEXICON_PATH,
) -> CanonicalMetadata:
    """Build the committed V∩Lexique POS/gender reference deterministically."""
    if not source_path.is_file():
        raise FileNotFoundError(
            f"missing cached Lexique source at {source_path}; run pnpm wordlist:fr "
            "once to download the offline source"
        )
    vocabulary = set(V)
    metadata: CanonicalMetadata = {}
    with source_path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            word = unicodedata.normalize("NFC", row.get("ortho", "").lower())
            if word not in vocabulary:
                continue
            cgram = row.get("cgram")
            lexique_gender = row.get("genre")
            entries: tuple[tuple[str, str | None], ...] = ()
            if cgram == "NOM" and lexique_gender in GENDER_VALUES:
                entries = (("noun", lexique_gender),)
            elif cgram == "ADJ":
                # Lexique leaves gender blank for epicene adjective forms.
                genders = (
                    (lexique_gender,)
                    if lexique_gender in GENDER_VALUES
                    else GENDER_VALUES
                )
                entries = tuple(("adjective", gender) for gender in genders)
            elif cgram in {"VER", "AUX"}:
                entries = (("verb", None),)
            elif cgram == "ADV":
                entries = (("adverb", None),)
            if entries:
                metadata.setdefault(word, set()).update(entries)

    write_deterministic_gzip(out_path, canonical_metadata_bytes(metadata))
    return metadata


def load_fr_lexicon(path: Path = FR_LEXICON_PATH) -> CanonicalMetadata:
    if not path.is_file():
        raise FileNotFoundError(
            f"missing committed French canonical metadata at {path}; run "
            "pnpm bench:curriculum:lexicon"
        )
    text = read_data_bytes(path).decode("utf-8")
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    if reader.fieldnames != ["word", "pos", "gender"]:
        raise ValueError(f"malformed canonical metadata header in {path}")
    metadata: CanonicalMetadata = {}
    for row in reader:
        word = row["word"]
        pos = row["pos"]
        gender = row["gender"] or None
        gender_is_valid = (
            gender in GENDER_VALUES if pos in GENDERED_POS else gender is None
        )
        if pos not in POS_VALUES or not gender_is_valid:
            raise ValueError(f"malformed canonical metadata row for {word!r}")
        metadata.setdefault(word, set()).add((pos, gender))
    return metadata


def validate_candidate(
    index: int,
    raw: Any,
    freq: dict[str, int],
    canonical_metadata: CanonicalMetadata,
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
                _require(
                    gender is None,
                    f"{pos} target {word!r} must not declare a gender",
                )
                gender = None
            _require(
                word in freq,
                f"target {word!r} is not in the reduced vocabulary",
            )
            _require(
                (pos, gender) in canonical_metadata.get(word, set()),
                f"target {word!r} metadata {(pos, gender)!r} is not attested "
                "by Lexique",
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
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _puzzle_json_bytes(puzzle: dict[str, Any]) -> bytes:
    return (json.dumps(puzzle, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _dataset_puzzle_identity(record: dict[str, Any]) -> dict[str, Any]:
    identity = {
        "number": record["number"],
        "split": record["split"],
        "sha256": record["sha256"],
        "targets": record["targets"],
    }
    if "calibration" in record:
        identity["calibration"] = record["calibration"]
    return identity


def dataset_content_sha256(manifest: dict[str, Any]) -> str:
    """Stable dataset identity: scientific content only, never timestamps."""
    identity = {
        "schema_version": manifest["schema_version"],
        "dataset_id": manifest["dataset_id"],
        "lang": manifest["lang"],
        "seed": manifest["seed"],
        "generator_output_sha256": manifest["generator_output"]["sha256"],
        "vocabulary": manifest["vocabulary"],
        "embedding": manifest["embedding"],
        "canonical_metadata": {
            "sha256": manifest["canonical_metadata"]["sha256"],
            "verified_fields": manifest["canonical_metadata"]["verified_fields"],
            "declared_fields": manifest["canonical_metadata"]["declared_fields"],
        },
        "frequency_bands": manifest["frequency_bands"],
        "start_band": manifest["start_band"],
        "counts": manifest["counts"],
        "balance": manifest["balance"],
        "puzzles": sorted(
            (_dataset_puzzle_identity(record) for record in manifest["puzzles"]),
            key=lambda record: record["number"],
        ),
    }
    if "manifest_kind" in manifest:
        identity["manifest_kind"] = manifest["manifest_kind"]
    if "calibration" in manifest:
        identity["calibration"] = {
            key: value
            for key, value in manifest["calibration"].items()
            if key not in {"artifact_file_sha256", "run_artifact_file_sha256"}
        }
    if "curriculum_base" in manifest:
        identity["curriculum_base"] = manifest["curriculum_base"]
    if "strategy_evidence" in manifest:
        identity["strategy_evidence"] = {
            key: value
            for key, value in manifest["strategy_evidence"].items()
            # Schema-v4 split manifests self-identify their evidence with the
            # manifest's own semantic hash.  Excluding that one self-reference
            # makes the identity computable while every evidence file/hash remains
            # pinned by the surrounding object.
            if not (
                manifest.get("schema_version") >= 4
                and manifest.get("manifest_kind")
                == CALIBRATION_TRAINING_MANIFEST_KIND
                and key == "dataset_content_sha256"
            )
        }
    encoded = json.dumps(
        identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256_bytes(encoded)


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
    canonical_metadata: CanonicalMetadata | None = None,
    canonical_metadata_source: str = "datasets/fr-lexicon.tsv.gz",
    embedding_source: str | None = None,
    embedding_sha256: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Validate, select, split, build, and write the dataset deterministically.

    Returns the manifest. `dry_run` stops after validation/selection and writes
    nothing (no ranking_for calls either).
    """
    quotas = quotas or Quotas()
    canonical_metadata = canonical_metadata or load_fr_lexicon()
    raw_candidates = generator_output.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise ValueError('generator output needs a non-empty "candidates" array')

    freq = frequency_lookup(V)
    validated: list[Candidate] = []
    rejections: list[Rejection] = []
    for index, raw in enumerate(raw_candidates):
        result = validate_candidate(index, raw, freq, canonical_metadata)
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

    if not embedding_source or not embedding_sha256:
        raise ValueError(
            "a real dataset build requires the reduced embedding source and sha256"
        )

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
        path = puzzles_dir / f"{stem}.json.gz"
        uncompressed = _puzzle_json_bytes(built)
        write_deterministic_gzip(path, uncompressed)
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
                "path": f"puzzles/{stem}.json.gz",
                "sha256": sha256_bytes(uncompressed),
                "sentence": candidate.sentence,
                "targets": target_records,
            }
        )

    generator = generator_output.get("generator", {})
    generator_output_bytes = (
        json.dumps(generator_output, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "dataset_id": DATASET_ID,
        "lang": LANG,
        "seed": seed,
        "generator": generator,
        "generator_output": {
            "path": "generator-output.json",
            "sha256": sha256_bytes(generator_output_bytes),
        },
        "vocabulary": {
            "source": "reduced-vocabulary order (V)",
            "size": len(V),
            "sha256": _sha256_text("\n".join(V)),
        },
        "embedding": {
            "source": embedding_source,
            "sha256": embedding_sha256,
        },
        "canonical_metadata": {
            "source": canonical_metadata_source,
            "sha256": sha256_bytes(canonical_metadata_bytes(canonical_metadata)),
            "verified_fields": ["pos", "gender"],
            "declared_fields": ["semantic_class"],
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
        "balance": {
            "verified": {
                "pos": balance["pos"],
                "gender": balance["gender"],
                "frequency_band": balance["frequency_band"],
            },
            "declared": {"semantic_class": balance["semantic_class"]},
        },
        "puzzles": puzzle_records,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest["dataset_content_sha256"] = dataset_content_sha256(manifest)
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "generator-output.json").write_bytes(generator_output_bytes)
    return manifest


def _validate_curriculum_base(
    manifest_path: Path, *, expected_curriculum_count: int
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("lang") != LANG:
        raise ValueError("calibration curriculum base must be French")
    if dataset_content_sha256(manifest) != manifest.get("dataset_content_sha256"):
        raise ValueError("calibration curriculum base content hash does not replay")
    records = [
        record for record in manifest["puzzles"] if record.get("split") == "curriculum"
    ]
    if len(records) != expected_curriculum_count:
        raise ValueError(
            "calibration curriculum base needs exactly "
            f"{expected_curriculum_count} curriculum puzzles"
        )
    seen_slugs: set[str] = set()
    for record in records:
        actual = sha256_bytes(read_data_bytes(manifest_path.parent / record["path"]))
        if actual != record.get("sha256"):
            raise ValueError(
                f"curriculum base puzzle {record.get('path')} does not match its sha256"
            )
        for target in record["targets"]:
            if target["slug"] in seen_slugs:
                raise ValueError("curriculum base target slugs are not unique")
            seen_slugs.add(target["slug"])
    generator = manifest["generator_output"]
    if _sha256_file(manifest_path.parent / generator["path"]) != generator["sha256"]:
        raise ValueError("curriculum base generator output hash does not replay")
    return manifest, sorted(records, key=lambda record: record["number"]), _sha256_file(
        manifest_path
    )


def _pool_record_identity(record: dict[str, Any]) -> dict[str, Any]:
    identity = {
        "split": record["split"],
        "sha256": record["sha256"],
        "targets": record["targets"],
    }
    if record["split"] == "curriculum":
        identity["number"] = record["number"]
    else:
        identity["candidate_id"] = record["candidate_id"]
        identity["pool_index"] = record["pool_index"]
    return identity


def calibration_pool_content_sha256(manifest: dict[str, Any]) -> str:
    """Stable identity for curriculum plus the pre-calibration candidate pool."""
    identity = {
        "schema_version": manifest["schema_version"],
        "manifest_kind": manifest["manifest_kind"],
        "dataset_id": manifest["dataset_id"],
        "lang": manifest["lang"],
        "seed": manifest["seed"],
        "curriculum_base": manifest["curriculum_base"],
        "generator_output_sha256": manifest["generator_output"]["sha256"],
        "vocabulary": manifest["vocabulary"],
        "embedding": manifest["embedding"],
        "canonical_metadata": {
            "sha256": manifest["canonical_metadata"]["sha256"],
            "verified_fields": manifest["canonical_metadata"]["verified_fields"],
            "declared_fields": manifest["canonical_metadata"]["declared_fields"],
        },
        "frequency_bands": manifest["frequency_bands"],
        "start_band": manifest["start_band"],
        "minimum_calibration_candidates": manifest[
            "minimum_calibration_candidates"
        ],
        "counts": manifest["counts"],
        "balance": manifest["balance"],
        "rejections": manifest["rejections"],
        "puzzles": sorted(
            (_pool_record_identity(record) for record in manifest["puzzles"]),
            key=lambda record: (
                record["split"],
                record.get("number", 0),
                record.get("candidate_id", ""),
            ),
        ),
    }
    return sha256_bytes(
        json.dumps(
            identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )


def _counts_for_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, dict[str, int]] = {
        "pos": {},
        "gender": {},
        "frequency_band": {},
        "semantic_class": {},
    }
    for record in records:
        for target in record["targets"]:
            for attribute in counts:
                value = target.get(attribute)
                if attribute == "gender" and value is None:
                    continue
                counts[attribute][value] = counts[attribute].get(value, 0) + 1
    return {
        "verified": {
            "pos": counts["pos"],
            "gender": counts["gender"],
            "frequency_band": counts["frequency_band"],
        },
        "declared": {"semantic_class": counts["semantic_class"]},
    }


def _target_records(candidate: Candidate, puzzle: dict[str, Any]) -> list[dict[str, Any]]:
    records = []
    for target, hole in zip(
        sorted(candidate.targets, key=lambda item: item.token_index), puzzle["holes"]
    ):
        records.append(
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
    return records


def build_calibration_pool(
    generator_output: dict[str, Any],
    *,
    curriculum_manifest_path: Path,
    V: list[str],
    ranking_for: RankingFor,
    seed: int,
    out_dir: Path,
    dataset_id: str = CALIBRATED_DATASET_ID,
    minimum_candidates: int = MIN_CALIBRATION_CANDIDATES,
    expected_curriculum_count: int = CURRICULUM_COUNT,
    canonical_metadata: CanonicalMetadata | None = None,
    canonical_metadata_source: str = "datasets/fr-lexicon.tsv.gz",
    embedding_source: str | None = None,
    embedding_sha256: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Build the frozen, statically validated pool consumed by calibration.

    The original curriculum records are copied byte-for-byte and never selected
    again.  Every authored calibration candidate passes the same schema, vocab,
    target-location, POS/gender/frequency, rank-map, and start-band code as the
    original dataset builder before it can enter the pool.
    """
    if not isinstance(minimum_candidates, int) or minimum_candidates <= 0:
        raise ValueError("minimum_candidates must be a positive integer")
    if not isinstance(dataset_id, str) or not dataset_id.strip():
        raise ValueError("dataset_id must be a non-empty string")
    curriculum_manifest_path = curriculum_manifest_path.resolve()
    base, curriculum_records, base_manifest_sha = _validate_curriculum_base(
        curriculum_manifest_path,
        expected_curriculum_count=expected_curriculum_count,
    )
    canonical_metadata = canonical_metadata or load_fr_lexicon()
    vocabulary = {
        "source": "reduced-vocabulary order (V)",
        "size": len(V),
        "sha256": _sha256_text("\n".join(V)),
    }
    canonical_record = {
        "source": canonical_metadata_source,
        "sha256": sha256_bytes(canonical_metadata_bytes(canonical_metadata)),
        "verified_fields": ["pos", "gender"],
        "declared_fields": ["semantic_class"],
    }
    if vocabulary != base["vocabulary"]:
        raise ValueError("candidate pool vocabulary does not match the frozen curriculum")
    if canonical_record["sha256"] != base["canonical_metadata"]["sha256"]:
        raise ValueError(
            "candidate pool canonical metadata does not match the frozen curriculum"
        )
    if not dry_run:
        if not embedding_source or not embedding_sha256:
            raise ValueError(
                "a real calibration pool build requires embedding source and sha256"
            )
        if embedding_sha256 != base["embedding"]["sha256"]:
            raise ValueError(
                "candidate pool embedding does not match the frozen curriculum"
            )

    raw_candidates = generator_output.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise ValueError('generator output needs a non-empty "candidates" array')
    freq = frequency_lookup(V)
    validated: list[Candidate] = []
    rejections: list[Rejection] = []
    seen_candidate_ids: set[str] = set()
    curriculum_slugs = {
        target["slug"] for record in curriculum_records for target in record["targets"]
    }
    for index, raw in enumerate(raw_candidates):
        result = validate_candidate(index, raw, freq, canonical_metadata)
        if isinstance(result, Rejection):
            rejections.append(result)
            continue
        overlap = sorted(
            target.slug
            for target in result.targets
            if target.slug in curriculum_slugs
        )
        if overlap:
            rejections.append(
                Rejection(
                    index=index,
                    sentence=result.sentence,
                    reason=(
                        "target slug overlaps frozen curriculum: "
                        + ", ".join(overlap)
                    ),
                )
            )
            continue
        candidate_id = _candidate_key(result)
        if candidate_id in seen_candidate_ids:
            rejections.append(
                Rejection(
                    index=index,
                    sentence=result.sentence,
                    reason="duplicate candidate sentence identity",
                )
            )
            continue
        seen_candidate_ids.add(candidate_id)
        validated.append(result)

    if dry_run:
        return {
            "dry_run": True,
            "dataset_id": dataset_id,
            "valid_static_candidates": len(validated),
            "minimum_calibration_candidates": minimum_candidates,
            "meets_minimum_before_rank_map_build": len(validated)
            >= minimum_candidates,
            "rejections": [vars(rejection) for rejection in rejections],
            "provider_calls": 0,
            "ranking_calls": 0,
        }

    built_records: list[dict[str, Any]] = []
    built_bytes: list[tuple[Path, bytes]] = []
    for candidate in sorted(validated, key=_candidate_key):
        candidate_id = _candidate_key(candidate)
        candidate_seed = int(
            hashlib.sha256(f"{seed}:{candidate_id}".encode("utf-8")).hexdigest(),
            16,
        )
        puzzle = build_puzzle(
            candidate,
            ranking_for=ranking_for,
            rng=random.Random(candidate_seed),
        )
        if isinstance(puzzle, Rejection):
            rejections.append(puzzle)
            continue
        uncompressed = _puzzle_json_bytes(puzzle)
        relative_path = Path("puzzles") / "candidates" / f"{candidate_id}.json.gz"
        built_bytes.append((relative_path, uncompressed))
        built_records.append(
            {
                "candidate_id": candidate_id,
                "split": CALIBRATION_CANDIDATE_SPLIT,
                "path": relative_path.as_posix(),
                "sha256": sha256_bytes(uncompressed),
                "sentence": candidate.sentence,
                "targets": _target_records(candidate, puzzle),
            }
        )
    if len(built_records) < minimum_candidates:
        raise ValueError(
            "calibration candidate shortfall after static/rank/start validation: "
            f"need at least {minimum_candidates}, built {len(built_records)}; "
            "generate more candidates"
        )
    for pool_index, record in enumerate(built_records, start=1):
        record["pool_index"] = pool_index

    out_dir.mkdir(parents=True, exist_ok=True)
    for record in curriculum_records:
        source = curriculum_manifest_path.parent / record["path"]
        destination = out_dir / record["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    for relative_path, uncompressed in built_bytes:
        write_deterministic_gzip(out_dir / relative_path, uncompressed)

    generator_envelope = {
        "curriculum_base": {
            "dataset_id": base["dataset_id"],
            "dataset_content_sha256": base["dataset_content_sha256"],
            "manifest_sha256": base_manifest_sha,
        },
        "calibration_candidates": generator_output,
    }
    generator_output_bytes = (
        json.dumps(generator_envelope, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    (out_dir / "generator-output.json").write_bytes(generator_output_bytes)
    records = json.loads(json.dumps(curriculum_records))
    records.extend(built_records)
    manifest = {
        "schema_version": CALIBRATION_POOL_SCHEMA_VERSION,
        "manifest_kind": CALIBRATION_POOL_KIND,
        "dataset_id": dataset_id,
        "lang": LANG,
        "seed": seed,
        "curriculum_base": generator_envelope["curriculum_base"],
        "generator": {
            "curriculum": base.get("generator", {}),
            "calibration_candidates": generator_output.get("generator", {}),
        },
        "generator_output": {
            "path": "generator-output.json",
            "sha256": sha256_bytes(generator_output_bytes),
        },
        "vocabulary": vocabulary,
        "embedding": {
            "source": embedding_source,
            "sha256": embedding_sha256,
        },
        "canonical_metadata": canonical_record,
        "frequency_bands": base["frequency_bands"],
        "start_band": base["start_band"],
        "minimum_calibration_candidates": minimum_candidates,
        "counts": {
            "curriculum": len(curriculum_records),
            "calibration_candidates": len(built_records),
            "puzzles": len(curriculum_records) + len(built_records),
        },
        "balance": {
            "curriculum": _counts_for_records(curriculum_records),
            "calibration_candidates": _counts_for_records(built_records),
        },
        "rejections": [vars(rejection) for rejection in rejections],
        "puzzles": records,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest["candidate_pool_content_sha256"] = calibration_pool_content_sha256(
        manifest
    )
    (out_dir / "candidate-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def _real_embedding() -> tuple[list[str], RankingFor, Path]:
    """Load the fr reduced embedding once and expose the canonical ranking."""
    import french_neighbors

    kv = french_neighbors.load_vectors()
    V = french_neighbors.build_vocab(kv)
    M = french_neighbors.build_matrix(kv, V)

    def ranking_for(word: str) -> list[tuple[str, int, float]]:
        return french_neighbors.closest(word, kv, V, M, n=TOP_K)

    return V, ranking_for, Path(french_neighbors.FASTTEXT_VEC)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from-output",
        type=Path,
        required=True,
        help="generator-output.json with LLM-authored candidates",
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument(
        "--calibration-pool",
        action="store_true",
        help="build a frozen candidate pool around the unchanged 15-puzzle curriculum",
    )
    parser.add_argument(
        "--curriculum-manifest",
        type=Path,
        help="existing frozen dataset whose curriculum records are copied unchanged",
    )
    parser.add_argument(
        "--dataset-id",
        help=f"candidate-pool dataset id (default: {CALIBRATED_DATASET_ID})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and select without loading the embedding or writing",
    )
    args = parser.parse_args(argv)
    if args.calibration_pool and args.curriculum_manifest is None:
        parser.error("--calibration-pool requires --curriculum-manifest")
    if not args.calibration_pool and (
        args.curriculum_manifest is not None or args.dataset_id is not None
    ):
        parser.error("--curriculum-manifest/--dataset-id require --calibration-pool")

    dataset_id = args.dataset_id or CALIBRATED_DATASET_ID
    out_dir = args.out_dir or DATASETS_DIR / (
        dataset_id if args.calibration_pool else DATASET_ID
    )

    generator_output = json.loads(args.from_output.read_text(encoding="utf-8"))
    if args.dry_run:
        import french_neighbors

        kv = french_neighbors.load_vectors()
        V = french_neighbors.build_vocab(kv)
        if args.calibration_pool:
            report = build_calibration_pool(
                generator_output,
                curriculum_manifest_path=args.curriculum_manifest,
                V=V,
                ranking_for=lambda word: [],
                seed=args.seed,
                out_dir=out_dir,
                dataset_id=dataset_id,
                dry_run=True,
            )
        else:
            report = build_dataset(
                generator_output,
                V=V,
                ranking_for=lambda word: [],
                seed=args.seed,
                out_dir=out_dir,
                dry_run=True,
            )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    V, ranking_for, embedding_path = _real_embedding()
    if args.calibration_pool:
        manifest = build_calibration_pool(
            generator_output,
            curriculum_manifest_path=args.curriculum_manifest,
            V=V,
            ranking_for=ranking_for,
            seed=args.seed,
            out_dir=out_dir,
            dataset_id=dataset_id,
            embedding_source=str(embedding_path.relative_to(REPO_ROOT)),
            embedding_sha256=_sha256_file(embedding_path),
        )
        print(
            f"calibration candidate pool {manifest['dataset_id']} written to "
            f"{out_dir} ({manifest['counts']['calibration_candidates']} candidates)"
        )
    else:
        manifest = build_dataset(
            generator_output,
            V=V,
            ranking_for=ranking_for,
            seed=args.seed,
            out_dir=out_dir,
            embedding_source=str(embedding_path.relative_to(REPO_ROOT)),
            embedding_sha256=_sha256_file(embedding_path),
        )
        print(
            f"dataset {manifest['dataset_id']} written to {out_dir} "
            f"({manifest['counts']['curriculum']} curriculum + "
            f"{manifest['counts']['holdout']} holdout)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
