"""
English fastText specifics for the sentence reconstruction game.

Common embedding logic lives in scripts/embedding_neighbors.py. This file keeps the
English-specific reduced-vector path, derived cache path, and vector format — the
twin of french_neighbors.py: English moved to the same family as French (#317).

Dependencies: gensim + numpy, provisioned by uv (see the callers' PEP-723 headers).
Expected file: embedding/en/cc.en.300_reduced.vec
  (produced by `pnpm reduce:en` from the raw cc.en.300.vec —
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
FASTTEXT_VEC = os.path.join(ROOT, "embedding/en/cc.en.300_reduced.vec")
# Cache derived from the vec path: different reduced files -> different caches, and a
# re-reduction (newer .vec) invalidates this cache (see embedding_neighbors).
CACHE = os.path.splitext(FASTTEXT_VEC)[0] + ".kv"

SPEC = EmbeddingSpec(
    name="English fastText",
    vectors_path=FASTTEXT_VEC,
    cache_path=CACHE,
    no_header=False,
    missing_hint="Run `pnpm reduce:en` first (needs the raw cc.en.300.vec).",
)


def load_vectors():
    return _load_vectors(SPEC)


def build_vocab(kv):
    return _build_vocab(SPEC, kv)


def closest(word, kv, V, M, n=None):
    return _closest(SPEC, word, kv, V, M, n=n)
