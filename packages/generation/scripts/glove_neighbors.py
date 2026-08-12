"""
English GloVe specifics for the sentence reconstruction game.

Common embedding logic lives in scripts/embedding_neighbors.py. This file keeps the
English-specific reduced-vector path, derived cache path, and vector format.

Dependencies: gensim + numpy, provisioned by uv (see the callers' PEP-723 headers).
Expected file: embedding/en/glove.6B.300d_reduced.txt
  (produced by `pnpm reduce:en` from the raw glove.6B.300d.txt —
   https://nlp.stanford.edu/projects/glove/)
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
GLOVE_TXT = os.path.join(ROOT, "embedding/en/glove.6B.300d_reduced.txt")
# Cache derived from the vec path: different reduced files -> different caches, and a
# re-reduction (newer .vec) invalidates this cache (see embedding_neighbors).
CACHE = os.path.splitext(GLOVE_TXT)[0] + ".kv"

SPEC = EmbeddingSpec(
    name="English GloVe",
    vectors_path=GLOVE_TXT,
    cache_path=CACHE,
    no_header=True,
    missing_hint="Run `pnpm reduce:en` first (needs the raw glove.6B.300d.txt).",
)


def load_vectors():
    return _load_vectors(SPEC)


def build_vocab(kv):
    return _build_vocab(SPEC, kv)


def closest(word, kv, V, M, n=None):
    return _closest(SPEC, word, kv, V, M, n=n)
