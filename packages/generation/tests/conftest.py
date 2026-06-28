"""Test setup for the generation package.

Makes scripts/ importable and stubs the heavy sibling modules that gen_phrase
imports at import time. french_neighbors / glove_neighbors / start_word only do real
work when LOADING vectors (gensim/numpy) at runtime, which these unit tests never
trigger. Stubbing them keeps the contract tests fast and dependency-free, so
`pnpm test` needs neither the embeddings nor gensim installed.
"""

import os
import sys
import types

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.abspath(os.path.join(TESTS_DIR, "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

# gen_phrase does `import french_neighbors as gn/frn` and stores the modules in
# CONFIG at import time (it never calls into them unless main() loads vectors).
for _name in ("french_neighbors", "glove_neighbors"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)

# gen_phrase does `from start_word import pick_start, start_band` at import time, so
# the stub must expose those names (unused in the unit tests).
if "start_word" not in sys.modules:
    _sw = types.ModuleType("start_word")
    _sw.pick_start = lambda *a, **k: None
    _sw.start_band = lambda *a, **k: []
    sys.modules["start_word"] = _sw
