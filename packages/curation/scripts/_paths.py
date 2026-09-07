"""Path wiring shared by every curation script.

The pipeline is a CONSUMER of the generation package (slug contract, start-word band,
vectors) and of the benchmark package's Claude subscription transport; both are plain
script directories, imported the way the benchmark imports generation's `slug.py`.
"""

from pathlib import Path
import sys

CURATION_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = CURATION_DIR.parent.parent
GENERATION_DIR = REPO_ROOT / "packages" / "generation"
GENERATION_SCRIPTS_DIR = GENERATION_DIR / "scripts"
BENCHMARK_SCRIPTS_DIR = REPO_ROOT / "packages" / "benchmark" / "scripts"
SHELF_DIR = CURATION_DIR / "shelf"
RUNS_DIR = CURATION_DIR / "runs"
SKILL_FILE = REPO_ROOT / ".claude" / "skills" / "find-sentences" / "SKILL.md"
GENERATION_OUTPUT_DIR = GENERATION_DIR / "output" / "word"
VOCAB_DIR = REPO_ROOT / "packages" / "web" / "public" / "vocab"

for directory in (GENERATION_SCRIPTS_DIR, BENCHMARK_SCRIPTS_DIR):
    path = str(directory)
    if path not in sys.path:
        sys.path.insert(0, path)
