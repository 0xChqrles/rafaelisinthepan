import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))


@pytest.fixture(autouse=True)
def _no_play_record_nor_kept_reads(monkeypatch, tmp_path):
    """No test reads the real play record nor the difficulty reads kept on this machine: both
    point into the test's own directory (empty unless the test writes them), and the reads'
    in-memory copy starts empty."""
    import _paths
    import difficulty

    monkeypatch.setattr(_paths, "PLAY_RECORD", tmp_path / "difficulty" / "played.jsonl")
    monkeypatch.setattr(_paths, "READS_FILE", tmp_path / "difficulty" / "reads.jsonl")
    monkeypatch.setattr(difficulty, "_answers", None)
