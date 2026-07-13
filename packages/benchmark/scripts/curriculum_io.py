"""Small deterministic I/O helpers for committed curriculum data."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any


def read_data_bytes(path: Path) -> bytes:
    """Read raw content, transparently decompressing a gzip container."""
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as handle:
            return handle.read()
    return path.read_bytes()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(read_data_bytes(path).decode("utf-8"))


def write_deterministic_gzip(path: Path, content: bytes) -> None:
    """Write gzip bytes without a filename or wall-clock timestamp."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as zipped:
            zipped.write(content)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
