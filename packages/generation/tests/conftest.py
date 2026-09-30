"""Test setup for the generation package.

Makes scripts/ importable and stubs the one heavy sibling module gen_phrase imports
at import time: embedding_neighbors imports gensim/numpy and only does real work when
LOADING vectors, which these unit tests never trigger. Stubbing it keeps the contract
tests fast and dependency-free, so `pnpm test` needs neither the embeddings nor gensim
installed.
"""

import os
import sys
import types

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.abspath(os.path.join(TESTS_DIR, "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

# gen_phrase stores `embedding_neighbors.for_lang(lang)` in CONFIG at import time (it
# never calls into it unless main() loads vectors); tests patch that object's
# attributes, so each language gets ONE assignable object. It carries a SPEC because
# main() reads its `vectors_path` to name the corpus the vocab metadata records (#200)
# — the stub never loads the file, only names it.
if "embedding_neighbors" not in sys.modules:
    _neighbors = {
        lang: types.SimpleNamespace(SPEC=types.SimpleNamespace(
            vectors_path=f"embedding/{lang}/cc.{lang}.300_reduced.vec"))
        for lang in ("en", "fr")
    }
    _mod = types.ModuleType("embedding_neighbors")
    _mod.for_lang = _neighbors.__getitem__
    sys.modules["embedding_neighbors"] = _mod


@pytest.fixture
def selector(monkeypatch):
    """Script the raw-mode terminal select_holes_interactive drives.

    `selector(keys, replies=None)`: `keys` are the keypresses _read_key returns, in
    order; `replies` the answers to the line prompts (input()), in order — every
    prompt answers Entrée when none are given. stdin is a TTY over a real descriptor
    (/dev/null, closed when the test ends) and termios / tty are no-ops."""
    import termios
    import tty

    import gen_phrase

    fds = []

    def script(keys, replies=None):
        fd = os.open(os.devnull, os.O_RDONLY)
        fds.append(fd)
        monkeypatch.setattr(gen_phrase.sys, "stdin",
                            type("Stdin", (), {"fileno": lambda self: fd,
                                               "isatty": lambda self: True})())
        monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
        monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
        monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
        keys = iter(keys)
        monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))
        if replies is None:
            monkeypatch.setattr("builtins.input", lambda _p="": "")
        else:
            replies = iter(replies)
            monkeypatch.setattr("builtins.input", lambda _p="": next(replies))

    yield script
    for fd in fds:
        os.close(fd)
