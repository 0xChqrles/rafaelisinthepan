"""Build the committed French POS/gender reference for curriculum validation."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from curriculum_dataset import (
    FR_LEXICON_PATH,
    LEXIQUE_SOURCE_PATH,
    build_fr_lexicon,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lexique-source", type=Path, default=LEXIQUE_SOURCE_PATH)
    parser.add_argument("--out", type=Path, default=FR_LEXICON_PATH)
    args = parser.parse_args(argv)

    import french_neighbors

    kv = french_neighbors.load_vectors()
    vocabulary = french_neighbors.build_vocab(kv)
    metadata = build_fr_lexicon(
        vocabulary, source_path=args.lexique_source, out_path=args.out
    )
    entry_count = sum(len(entries) for entries in metadata.values())
    print(
        f"French curriculum lexicon written to {args.out} "
        f"({len(metadata)} words, {entry_count} canonical entries)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
