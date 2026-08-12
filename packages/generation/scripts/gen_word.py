#!/usr/bin/env python3
# /// script
# dependencies = ["gensim", "numpy"]
# ///
"""Generate one single-word artifact: ONE word plus its ranked neighborhood (#154).

"One word + its ranked neighborhood" is a first-class artifact, not a by-product of a
sentence. Getting one out of gen_phrase meant authoring a sentence, confirming three
secrets and banding three start words only to throw two thirds of it away — the wrong
tool. This script is the right one: give it a language and a word, get its map.

It is an EXTRACTION, not a second implementation. Every per-secret rule lives in
gen_phrase and is imported from there, so the two commands cannot drift: the merge
walk and group semantics (#104/#134/#146), the #133 explicit-form confirmation, donor
vectors (#119), the TOP_K group cap, the dq stamping and the slug-collision rule are
literally the same code (gen_phrase.walk_secret is the shared per-secret pipeline).

Exactly TWO things differ — one because there is no sentence, one because only
Word mode consumes it:

  - No `words` / `holes` / `start` / `start_rank`, and no `source`: a lone word has no
    attribution. The rank map is ONE flat map, not keyed by secret.
  - Every group carries its corpus rarity, `freq` (#163) — see annotate_freq. A
    sentence puzzle does not: nothing there consumes it, and those maps are already
    ~500 KB gzipped.

Schema (see WordPuzzle in packages/shared/src/types.ts):

    {"lang": "fr",
     "word": {"word": "phare", "slug": "phare"},
     "ranks": {"<input-slug>": {"word": "<accented>", "rank": 12, "dq": 231,
                                "freq": 8412}}}

The inner semantics are the sentence schema's rank-map semantics, unchanged: alias
keys per group, word/rank/dq/freq are GROUP properties, rank 0 = the word itself and
carries no dq, dq on every rank >= 1 entry.

Written to packages/generation/output/single-word/<lang>/<slug>.json (override the
root with --out-dir). Unlike gen:phrase this does NOT rewrite web/public/vocab —
the existence set is reduce's output, and a neighborhood map has no business
republishing a web asset.

On a terminal the script is interactive: the word and the language are asked when not
supplied as flags. Off a TTY they are flags, and the never-infer rule holds here
exactly as it does for a sentence secret: --form MOT=TRAIT is required for an fr word
(--no-inflect opts out), and a word with no vector needs --donor MANQUANT=DONNEUR.

Usage :
    uv run scripts/gen_word.py                      # interactive
    uv run scripts/gen_word.py phare --lang fr --form phare=n:s
    pnpm gen:word phare --lang fr --form phare=n:s
"""

import argparse
import json
import os
import re
import sys

# scripts/ -> generation package root, so the sibling modules import regardless of cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
for path in (ROOT, SCRIPT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# The per-secret machinery, imported whole: this command adds an entry point and a
# schema, never a second copy of the rules. prepare_run / report_run_adjustments are
# the shared command scaffolding around walk_secret (#154), so the setup order and the
# reporting channels cannot drift between the two commands either.
from gen_phrase import (CONFIG, GEN_OUTPUT, add_shared_args, die,  # noqa: E402
                        group_lexeme_map, normalize, prepare_run,
                        prompt_editable, prompt_lang, report_run_adjustments,
                        walk_secret)
from slug import slug  # noqa: E402


def annotate_freq(rank_map, V):
    """Stamp every group with `freq` — how common it is in the corpus (#163).

    Word mode pays a claim in SECONDS scaled by the claimed group's rarity, and
    rarity is orthogonal to the closeness the score already measures: it pays for
    vocabulary depth rather than double-paying the find. The client cannot compute
    it — it never sees the corpus — so the artifact ships it.

    The value is a FREQUENCY RANK over the EXISTENCE SET — the slugged, deduplicated
    vocabulary written to web/public/vocab/<lang>.json — in frequency order: 1 = the
    most frequent word the game admits, larger = rarer. The reduced file preserves the
    source embedding's frequency order (reduce_embedding streams it and keeps survivors
    in place), so this is a READ of a position, not a computation. 1-based on purpose: a
    0 would be indistinguishable from an absent field to a JS consumer testing the value.

    RANKED OVER SLUGS, not over raw forms, and that is load-bearing rather than tidy.
    The consumer divides this by the size of the existence set it loaded, to get a
    fraction of the corpus; if the numerator counted a population the denominator does
    not, the fraction is not one. V holds every reduced form while the existence set
    holds distinct SLUGS, and the two differ by exactly the accent/case collisions —
    measured, 4.1% in fr against 0.0% in en, i.e. a language-dependent skew in the one
    number that exists to make rarity mean the same thing in every language.

    A group's position is that of its most frequent OWNED KEY — the commonest thing a
    player can actually TYPE to claim it. Not the representative alone (a player's
    sense of a lexeme's rarity is its commonest inflection: « privées » is as rare as
    « privé » is common), and not the whole paradigm either: a surface owned by
    ANOTHER group is that group's key, and pricing this one by it would grade a rare
    lexeme by a word that can never claim it (« boire » must not be COMMON because
    « bois » is — « bois » claims the tree). The walk has already settled ownership
    closest-first (#104/#134), so the pricing READS the rank map's keys instead of
    re-deriving it from the paradigm. A GROUP property like word/rank/dq, stamped by
    RANK — every alias key of a group therefore repeats its group's value, and
    slug-collision resolution keeps the winning group's, both by construction.
    Stamped BEFORE the agreement pass so a rewritten display inherits its group's
    value like any other key.

    A group none of whose keys is in the existence set — the secret of a borrowed
    vector (#119), whose slug embeds nothing — simply gets no `freq`. The field is
    optional to every consumer."""
    # slug -> its 1-based place among distinct slugs in frequency order. Two forms that
    # fold together are ONE entry in the existence set and so must be one rank here; the
    # first (most frequent) occurrence names it, which is the same closest-wins rule the
    # rank map resolves slug collisions by.
    slug_rank = {}
    for form in V:
        key = slug(form)
        if key and key not in slug_rank:
            slug_rank[key] = len(slug_rank) + 1
    # Group-min over the group's OWNED keys, then stamped by rank so every alias key
    # repeats it (rank IS the group: the flat map is rank-unique per group).
    freq_by_rank = {}
    for key, entry in rank_map.items():
        position = slug_rank.get(key)
        if position is None:
            continue
        rank = entry["rank"]
        if rank not in freq_by_rank or position < freq_by_rank[rank]:
            freq_by_rank[rank] = position
    for entry in rank_map.values():
        freq = freq_by_rank.get(entry["rank"])
        if freq is not None:
            entry["freq"] = freq
    return rank_map


def build_word_map(word, donor, cfg, kv, V, M, Vset, lemma_table, forms_by_lemma,
                   donors=None, forms=None, reporter=None):
    """One word's rank map AS SHIPPED: walked, dq-stamped, priced, agreed.

    The sentence path's per-secret sequence with its two sentence-shaped steps
    removed. walk_secret settles the claim (#133 fires there, ahead of the walk) and
    builds the dq-stamped map; then:

      - FREQ (#163), this artifact's own annotation: what Word mode's clock pays a
        claim by, and — since 2026-08-10 — what its board paints each station word by. See
        annotate_freq; a sentence puzzle carries none.
      - AGREEMENT (#133/#134): the whole map agrees with the word's confirmed
        morphology. There is no start hint to alias afterwards — the display override
        a hole's start word gets (#119 addendum) has no counterpart here.

    Returns the rank map. Mutated in place by every pass, like the sentence path."""
    _merged, rank_map, groups = walk_secret(word, donor, cfg, kv, V, M, Vset,
                                            lemma_table, forms_by_lemma, donors, forms)
    annotate_freq(rank_map, V)
    if forms is not None:
        forms.apply(rank_map, word, donors, lexemes=group_lexeme_map(groups))
    if reporter is not None:
        feature = forms.feature_for(word) if forms is not None else None
        reporter.capture(word, groups, rank_map, feature)
    return rank_map


def build_word_artifact(lang, word, rank_map):
    """The single-word artifact (#154).

    `word` carries BOTH the accented display form and its slug, like every other
    {word, slug} pair in the schema — even when they are equal. `ranks` is ONE flat
    map (there is only one word to rank around), keyed by input slug. No `words` /
    `holes` / `start`: there is no sentence. No `source` either — attribution belongs
    to a quoted line, and a lone word quotes nobody."""
    return {
        "lang": lang,
        "word": {"word": word, "slug": slug(word)},
        "ranks": rank_map,
    }


def artifact_path(out_dir, lang, word):
    """<out-dir>/<lang>/<slug>.json — the word's own slug names the file.

    An ASCII slug like every generated filename (« forêt » -> foret.json), so the
    corpus is one flat, greppable directory per language. Regenerating a word
    overwrites its file: unlike a sentence puzzle there is no metadata to file it
    under and nothing to distinguish two runs of the same word (#137's source levels
    have no meaning for a word that quotes nobody)."""
    return os.path.join(out_dir, lang, slug(word) + ".json")


def parse_args():
    p = argparse.ArgumentParser(
        description="Génère l'artefact d'un mot seul : le mot et son voisinage classé "
                    "(interactif sur un terminal ; sinon fournir les arguments)."
    )
    # word / --lang are optional: both are prompted on a TTY (see main()).
    p.add_argument("word", nargs="?", help="le mot (sinon demandé)")
    add_shared_args(p)
    p.add_argument("--donor", action="append", metavar="MANQUANT=DONNEUR",
                   help="emprunte le vecteur d'une forme du même lemme quand le mot "
                        "est absent de l'embedding (#119), ex. --donor accoutumes="
                        "accoutume ; requis hors mode interactif")
    p.add_argument("--form", action="append", metavar="MOT=TRAIT",
                   help="trait morphologique du mot, auquel son voisinage s'accorde "
                        "(#133), ex. --form phare=n:s ; requis hors mode interactif — "
                        "la forme n'est jamais déduite. Un trait porté par plusieurs "
                        "lexèmes exige la forme qualifiée MOT=LEXÈME/TRAIT (#144)")
    p.add_argument("--out-dir", default=os.path.join(GEN_OUTPUT, "single-word"),
                   dest="out_dir",
                   help="racine de sortie ; le fichier est écrit dessous en "
                        "<lang>/<slug>.json (défaut : "
                        "packages/generation/output/single-word)")
    return p.parse_args()


def main():
    args = parse_args()
    interactive = sys.stdin.isatty()

    # A CLI flag wins; else prompt on a TTY; else the non-interactive contract (default
    # lang, clear error for the missing word) — gen_phrase's rule, unchanged.
    lang = args.lang
    if lang is None:
        lang = prompt_lang() if interactive else "en"

    word = args.word
    if interactive:
        # Always shown in an editable prompt, pre-loaded with the flag value, so a
        # typo can be fixed with the arrow keys instead of a rerun.
        word = prompt_editable("Mot", prefill=word or "",
                               blank_error="Le mot ne peut pas être vide.")
    elif word is None:
        die("aucun mot fourni (argument positionnel requis hors mode interactif).")

    # ONE word means one: whitespace or an apostrophe would otherwise be silently
    # stripped by normalize (« t'attends » -> « tattends ») and die three loads later
    # with a misleading not-in-vocabulary error. Say what is actually wrong, now.
    # Dashes stay legal — « arc-en-ciel » is one word.
    if re.search(r"[\s'’]", word):
        die(f"« {word} » n'est pas un mot seul (espace ou apostrophe) : cet artefact "
            f"décrit le voisinage d'UN mot — donne-le sans clitique ni espace "
            f"(ex. « attends », pas « t'attends »).")

    cfg = CONFIG[lang]
    target = normalize(word, cfg)
    if not slug(target):
        die(f"'{word}' ne contient aucune lettre valide pour la langue '{lang}'.")

    # Tables, gate, vectors and the three resolvers, in prepare_run's fixed fail-fast
    # order — the scaffolding both generation commands share (#154).
    run = prepare_run(lang, interactive, args)

    # The GEOMETRY source: the word itself when it has a vector, else the form lending
    # it one. donor_for asks on a TTY, reads --donor off one, and dies rather than
    # guess — the same three outcomes a sentence secret gets.
    donor = run.donors.donor_for(target)
    rank_map = build_word_map(target, donor, cfg, run.kv, run.V, run.M, run.Vset,
                              run.lemma_table, run.forms_by_lemma, run.donors,
                              run.forms, reporter=run.reporter)

    # #135 is a report only: printed once the map exists, before the file is written.
    run.reporter.print()

    artifact = build_word_artifact(lang, target, rank_map)
    out_path = artifact_path(args.out_dir, lang, target)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False)

    # --- Preview ---------------------------------------------------------------
    ranked = max((entry["rank"] for entry in rank_map.values()), default=0)
    print(f"\nMot « {target} » ({lang}) écrit dans {out_path} :")
    print(f"  {ranked} groupe(s) classé(s), {len(rank_map)} clé(s)")
    nearest = sorted({entry["rank"]: entry["word"] for entry in rank_map.values()
                      if entry["rank"]}.items())[:5]
    if nearest:
        print("  plus proches : "
              + ", ".join(f"{w}^-{r}" for r, w in nearest))
    # Substitutions, agreement, #134's curator marks and --form typo warnings — the
    # shared reporting block (#154). A lone word is not a secret, so it is named
    # plainly, and an unused --form named another word rather than another hole.
    report_run_adjustments(run.donors, run.forms, run.explicit_forms, lang,
                           args.no_inflect, subject_fmt="« {} »",
                           unused_form_msg="ne concerne pas ce mot")


if __name__ == "__main__":
    main()
