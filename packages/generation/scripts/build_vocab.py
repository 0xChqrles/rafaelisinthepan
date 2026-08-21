#!/usr/bin/env python3
# /// script
# dependencies = ["gensim", "numpy"]
# ///
"""
Rebuild the front's existence set web/public/vocab/<lang>.json — and its backend-facing
metadata, packages/shared/src/vocab.generated.json (#200) — from the CURRENT *_reduced
vectors, WITHOUT generating a puzzle.

The vocab is otherwise only written as a side effect of gen_phrase.py, which forces you
to fabricate a puzzle just to refresh it. Run this after `pnpm reduce:<lang>` (the step
that actually applies the filters, incl. hors-dico) to publish the refreshed vocabulary.

It reuses gen_phrase's loader (`CONFIG[...].module.load_vectors`), pass-through vocab
(`build_lang_vocab`) and writer (`write_vocab`), so the output is byte-identical to what
gen_phrase emits — the vocab contract stays single-sourced.

Usage:
    uv run scripts/build_vocab.py --lang fr
    uv run scripts/build_vocab.py --lang en
"""

import argparse

from gen_phrase import CONFIG, build_lang_vocab, write_vocab


def main():
    # --help is the only text an operator checking what this touches will read, so it
    # names BOTH files it rewrites — the second one lives in another package.
    p = argparse.ArgumentParser(
        description="Réécrit web/public/vocab/<lang>.json et ses métadonnées "
                    "packages/shared/src/vocab.generated.json depuis les vecteurs réduits.")
    p.add_argument("--lang", choices=("en", "fr"), required=True)
    args = p.parse_args()

    cfg = CONFIG[args.lang]
    kv = cfg["module"].load_vectors()          # the reduced vectors (via the .kv cache)
    V = build_lang_vocab(kv, cfg)              # pass-through: the whole reduced vocabulary
    # -> web/public/vocab/<lang>.json + shared/src/vocab.generated.json, the corpus named
    # by the very file the vectors came from.
    write_vocab(V, args.lang, cfg["module"].SPEC.vectors_path)


if __name__ == "__main__":
    main()
