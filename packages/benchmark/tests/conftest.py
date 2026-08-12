"""Make the benchmark scripts importable in dependency-free contract tests."""

from pathlib import Path
import sys

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture(autouse=True)
def _isolated_lab_output(tmp_path, monkeypatch):
    """`main` appends every session's lab artifact unconditionally; keep tests out of
    the real benchmark/output directory."""
    import llm_play

    monkeypatch.setattr(llm_play, "BENCHMARK_OUTPUT_DIR", tmp_path / "lab-output")
