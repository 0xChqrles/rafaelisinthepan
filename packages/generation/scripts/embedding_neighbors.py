"""
Shared embedding-neighbor utilities for the sentence reconstruction game.

Language modules provide only their embedding file path, derived cache path, and
vector format (header or not). This module owns the common loading, vocabulary,
matrix, and cosine-ranking logic.

The vectors are the *_reduced* files produced by scripts/reduce_embedding.py, which
already cap (TOP_N) and filter the vocabulary. So loading takes no frequency limit
and build_vocab is a pure pass-through — no re-filtering happens here.
"""

import os
from dataclasses import dataclass

import numpy as np
from gensim.models import KeyedVectors

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@dataclass(frozen=True)
class EmbeddingSpec:
    name: str
    vectors_path: str
    cache_path: str
    no_header: bool
    missing_hint: str


def _cache_is_fresh(spec: EmbeddingSpec) -> bool:
    """The .kv cache is usable when it exists AND is at least as new as its source
    .vec. If the source is gone (e.g. the big file was deleted to save space) we
    trust the cache; otherwise a newer .vec (a re-reduction) forces a rebuild, so we
    never serve stale vectors."""
    if not os.path.exists(spec.cache_path):
        return False
    if not os.path.exists(spec.vectors_path):
        return True
    return os.path.getmtime(spec.cache_path) >= os.path.getmtime(spec.vectors_path)


def load_vectors(spec: EmbeddingSpec):
    """Load the reduced vectors through a binary cache (path derived from the .vec).

    The cache is rebuilt whenever the .vec is newer than it (see _cache_is_fresh),
    so re-reducing then regenerating never serves stale vectors. The reduced file is
    already small, so it is loaded whole — no frequency limit."""
    if _cache_is_fresh(spec):
        return KeyedVectors.load(spec.cache_path, mmap="r")
    if not os.path.exists(spec.vectors_path):
        raise FileNotFoundError(
            f"Missing {spec.name} vectors: {spec.vectors_path}\n{spec.missing_hint}"
        )
    print(f"Loading {spec.name} from {spec.vectors_path}, slow once...")
    kv = KeyedVectors.load_word2vec_format(
        spec.vectors_path,
        binary=False,
        no_header=spec.no_header,
    )
    os.makedirs(os.path.dirname(spec.cache_path), exist_ok=True)
    kv.save(spec.cache_path)
    print(f"Cache written to {spec.cache_path}")
    return kv


def build_vocab(spec: EmbeddingSpec, kv):
    """Pass-through vocabulary V: ALL words of the loaded (reduced) vectors, in the
    file's frequency order. The reduction script is the single source of truth, so
    there is no filtering or truncation here."""
    V = list(kv.index_to_key)
    print(f"{spec.name} vocabulary V: {len(V)} words")
    return V


def build_matrix(kv, V):
    """Matrix (len(V), dim) of normalized V vectors -> dot product = cosine."""
    M = np.vstack([kv[w] for w in V]).astype(np.float32)
    M /= np.linalg.norm(M, axis=1, keepdims=True)
    return M


def closest(spec: EmbeddingSpec, word, kv, V, M, n=15000):
    """
    Rank V by proximity to `word`.

    Return a list of (word, rank, similarity), sorted from nearest to farthest.
    The word itself is excluded. n=None -> return all ranked V.
    """
    if word not in kv:
        raise KeyError(f"'{word}' is absent from {spec.name}")
    q = kv[word].astype(np.float32)
    q /= np.linalg.norm(q)

    sims = M @ q
    order = np.argsort(-sims)

    out = []
    rank = 0
    for idx in order:
        w = V[idx]
        if w == word:
            continue
        out.append((w, rank, float(sims[idx])))
        rank += 1
        if n is not None and rank >= n:
            break
    return out
