"""
Embedding neighbors for the sentence reconstruction game: loading, vocabulary, matrix
and cosine ranking over each language's fastText Common Crawl vectors.

`for_lang(lang)` is what callers use: the language's object, carrying its SPEC and
load_vectors() / build_vocab(kv) / build_matrix(kv, V) / closest(word, kv, V, M).
The two languages differ only by their path — embedding/<lang>/cc.<lang>.300_reduced.vec,
produced by `pnpm reduce:<lang>` from the raw cc.<lang>.300.vec
(https://fasttext.cc/docs/en/crawl-vectors.html) — and the .kv cache derived from it.

The vectors are the *_reduced* files produced by scripts/reduce_embedding.py, which
already cap (TOP_N) and filter the vocabulary. So loading takes no frequency limit
and build_vocab is a pure pass-through — no re-filtering happens here.

Dependencies: gensim + numpy, provisioned by uv (see the callers' PEP-723 headers).
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


def closest(spec: EmbeddingSpec, word, kv, V, M):
    """
    Rank V by proximity to `word`.

    Return a list of (word, rank, similarity), sorted from nearest to farthest:
    ALL of V but the word itself.
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
    return out


class Neighbors:
    """One language's reduced vectors, called the way every consumer calls them."""

    def __init__(self, lang, name):
        # The reduced (capped + filtered) vectors are the single source of truth for
        # the game.
        vectors = os.path.join(ROOT, f"embedding/{lang}/cc.{lang}.300_reduced.vec")
        self.SPEC = EmbeddingSpec(
            name=f"{name} fastText",
            vectors_path=vectors,
            # Cache derived from the vec path: different reduced files -> different
            # caches, and a re-reduction (newer .vec) invalidates it (_cache_is_fresh).
            cache_path=os.path.splitext(vectors)[0] + ".kv",
            missing_hint=f"Run `pnpm reduce:{lang}` first (needs the raw cc.{lang}.300.vec).",
        )

    def load_vectors(self):
        return load_vectors(self.SPEC)

    def build_vocab(self, kv):
        return build_vocab(self.SPEC, kv)

    def build_matrix(self, kv, V):
        return build_matrix(kv, V)

    def closest(self, word, kv, V, M):
        return closest(self.SPEC, word, kv, V, M)


# One instance per language, built once: a caller that keeps it (gen_phrase's CONFIG)
# and one that asks again (curation) hold the same object.
_BY_LANG = {"en": Neighbors("en", "English"), "fr": Neighbors("fr", "French")}


def for_lang(lang):
    """The neighbor object of `lang` ("en" or "fr")."""
    return _BY_LANG[lang]
