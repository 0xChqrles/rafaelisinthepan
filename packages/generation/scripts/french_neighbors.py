"""
French fastText specifics for the sentence reconstruction game.

Common embedding logic lives in scripts/embedding_neighbors.py. This file keeps the
French-specific reduced-vector path, derived cache path, and vector format.

Dependencies: pip install gensim numpy
Expected file: embedding/fr/cc.fr.300_reduced.vec
  (produced by `npm run reduce:fr` from the raw cc.fr.300.vec —
   https://fasttext.cc/docs/en/crawl-vectors.html)
"""

import os

from embedding_neighbors import (
    ROOT,
    EmbeddingSpec,
    build_matrix,
    build_vocab as _build_vocab,
    closest as _closest,
    load_vectors as _load_vectors,
)

# The reduced (capped + filtered) vectors are the single source of truth for the game.
FASTTEXT_VEC = os.path.join(ROOT, "embedding/fr/cc.fr.300_reduced.vec")
# Cache derived from the vec path: different reduced files -> different caches, and a
# re-reduction (newer .vec) invalidates this cache (see embedding_neighbors).
CACHE = os.path.splitext(FASTTEXT_VEC)[0] + ".kv"

SPEC = EmbeddingSpec(
    name="French fastText",
    vectors_path=FASTTEXT_VEC,
    cache_path=CACHE,
    no_header=False,
    missing_hint="Run `npm run reduce:fr` first (needs the raw cc.fr.300.vec).",
)


def load_vectors():
    return _load_vectors(SPEC)


def build_vocab(kv):
    return _build_vocab(SPEC, kv)


def closest(word, kv, V, M, n=15000):
    return _closest(SPEC, word, kv, V, M, n=n)


if __name__ == "__main__":
    kv = load_vectors()
    V = build_vocab(kv)
    M = build_matrix(kv, V)

    target = "chaise"
    print(f"\n30 closest words to '{target}':")
    for w, rank, sim in closest(target, kv, V, M, n=30):
        print(f"  {rank:4d}  {w:20s}  {sim:.3f}")
