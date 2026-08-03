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

Exactly TWO things differ, both because there is no sentence:

  - No start word, so no `start_rank` to size the road zone. It is the flat
    top-ROAD_TOP (150) instead — deliberate: those groups ARE Word mode's playing
    field, so the whole field gets its roads (distances.road_zone(None)).
  - No `words` / `holes` / `start` / `start_rank`, and no `source`: a lone word has no
    attribution. The rank map is ONE flat map, not keyed by secret.

Schema (see WordPuzzle in packages/shared/src/types.ts):

    {"lang": "fr",
     "word": {"word": "phare", "slug": "phare"},
     "ranks": {"<input-slug>": {"word": "<accented>", "rank": 12, "dq": 231, "road": 1}}}

The inner semantics are the sentence schema's rank-map semantics, unchanged: alias
keys per group, word/rank/dq/road are GROUP properties, rank 0 = the word itself and
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
import sys

# scripts/ -> generation package root, so the sibling modules import regardless of cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
for path in (ROOT, SCRIPT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# The per-secret machinery, imported whole: this command adds an entry point and a
# schema, never a second copy of the rules.
from build_forms import FORM_LANGS  # noqa: E402
from gen_phrase import (CONFIG, GEN_OUTPUT, DonorResolver, FormResolver,  # noqa: E402
                        PlayabilityReporter, annotate_roads, build_lang_vocab,
                        describe_morphology, die, group_lexeme_map, group_reps,
                        invert_lemmas, load_form_table, load_lemma_table, normalize,
                        parse_donor_args, parse_form_args, prompt_editable,
                        prompt_lang, walk_secret)
from slug import slug  # noqa: E402


def build_word_map(word, donor, cfg, kv, V, M, Vset, lemma_table, forms_by_lemma,
                   donors=None, forms=None, roads=True, reporter=None):
    """One word's rank map AS SHIPPED: walked, dq-stamped, roaded, agreed.

    The sentence path's per-secret sequence with its two sentence-shaped steps
    removed. walk_secret settles the claim (#133 fires there, ahead of the walk) and
    builds the dq-stamped map; then:

      - ROADS over the FLAT top-ROAD_TOP zone. A hole cuts the zone at its departure
        because a fork farther out than the start word is a fork of a route nobody
        walks; a lone word has no departure, so nothing cuts it short and the ceiling
        IS the zone (annotate_roads' start_rank=None). Stamped BEFORE the agreement
        pass, exactly as in a sentence, so a rewritten form inherits its group's road
        like any other key.
      - AGREEMENT (#133/#134): the whole map agrees with the word's confirmed
        morphology. There is no start hint to alias afterwards — the display override
        a hole's start word gets (#119 addendum) has no counterpart here.

    Returns the rank map. Mutated in place by both passes, like the sentence path."""
    merged, rank_map, groups = walk_secret(word, donor, cfg, kv, V, M, Vset,
                                           lemma_table, forms_by_lemma, donors, forms)
    annotate_roads(rank_map, merged, kv if roads else None, start_rank=None,
                   reps=group_reps(groups))
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
    p.add_argument("--lang", choices=("en", "fr"), default=None,
                   help="langue en/fr (défaut : en en mode non interactif)")
    p.add_argument("--no-lemmas", action="store_true",
                   help="désactive le regroupement par lexème (#104/#134) — chaque "
                        "forme fléchie garde son propre rang ; exige --no-inflect "
                        "quand la langue a une table de formes (l'accord est indexé "
                        "par les lexèmes du regroupement)")
    p.add_argument("--no-roads", action="store_true",
                   help="n'émet aucun champ `road` (#115) — les distances `dq` "
                        "restent écrites (le score en dépend)")
    p.add_argument("--donor", action="append", metavar="MANQUANT=DONNEUR",
                   help="emprunte le vecteur d'une forme du même lemme quand le mot "
                        "est absent de l'embedding (#119), ex. --donor accoutumes="
                        "accoutume ; requis hors mode interactif")
    p.add_argument("--no-inflect", action="store_true",
                   help="désactive l'accord des mots affichés (#119/#133) — "
                        "chaque mot garde sa forme de dictionnaire")
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

    cfg = CONFIG[lang]
    target = normalize(word, cfg)
    if not slug(target):
        die(f"'{word}' ne contient aucune lettre valide pour la langue '{lang}'.")

    # Malformed --donor / --form pairs fail before the expensive vector load.
    explicit_donors = parse_donor_args(args.donor)
    explicit_forms = parse_form_args(args.form)

    # Grouping table (#104), loaded before the vectors so a missing table fails fast.
    lemma_table = load_lemma_table(lang, disabled=args.no_lemmas)
    forms_by_lemma = invert_lemmas(lemma_table)

    # The agreement pass is keyed by the walk's lexemes (#134), which --no-lemmas
    # removes: reject the pair rather than silently rewriting nothing.
    if lang in FORM_LANGS and not args.no_inflect and args.no_lemmas:
        die("--no-lemmas retire les lexèmes sur lesquels l'accord d'affichage est "
            "indexé (#134) : ajoute --no-inflect pour générer sans regroupement, "
            "ou retire --no-lemmas.")

    form_table = load_form_table(lang, disabled=args.no_inflect)

    kv = cfg["module"].load_vectors()
    V = build_lang_vocab(kv, cfg)
    # V == kv == the whole reduced vocabulary: nothing is injected. A word either
    # survived reduction or it borrows a vector explicitly (#119), or it errors.
    M = cfg["module"].build_matrix(kv, V)
    Vset = set(V)

    donors = DonorResolver(lemma_table, forms_by_lemma, V, Vset, lang,
                           explicit=explicit_donors, interactive=interactive)
    forms = FormResolver(form_table, explicit=explicit_forms, interactive=interactive,
                         typable=donors.typable)
    reporter = PlayabilityReporter(V, lemma_table, forms_by_lemma, kv, resolver=forms)

    # The GEOMETRY source: the word itself when it has a vector, else the form lending
    # it one. donor_for asks on a TTY, reads --donor off one, and dies rather than
    # guess — the same three outcomes a sentence secret gets.
    donor = donors.donor_for(target)
    rank_map = build_word_map(target, donor, cfg, kv, V, M, Vset, lemma_table,
                              forms_by_lemma, donors, forms,
                              roads=not args.no_roads, reporter=reporter)

    # #135 is a report only: printed once the map exists, before the file is written.
    reporter.print()

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
              + ", ".join(f"{w} ^-{r}" for r, w in nearest))
    # A borrowed vector (#119) is never silent: say which form lent it.
    for secret_word, donor_word in donors.used.values():
        print(f"  « {secret_word} » : rangs calculés depuis le donneur "
              f"« {donor_word} »")
    # Same for the agreement pass and #134's curator marks, so a wrong trait is
    # visible before the artifact is used.
    for secret_word, feature, morphology, count in forms.used.values():
        print(f"  « {secret_word} » : {count} mot(s) affiché(s) accordé(s) "
              f"à {describe_morphology(morphology)} (trait source {feature})")
    for secret_word, entries in forms.fallbacks.values():
        sample = ", ".join(f"*{w} (rang {r})" for r, w in entries[:5])
        more = f", … {len(entries)} au total" if len(entries) > 5 else ""
        print(f"  « {secret_word} » : {len(entries)} groupe(s) en repli* — "
              f"forme demandée absente ou intypable, forme nette gardée : "
              f"{sample}{more}")
    for secret_word, count in forms.collisions.values():
        print(f"  « {secret_word} » : {count} collision(s) de slug après accord "
              f"(le plus proche gagne, réécriture(s) déclinée(s))")
    # A --form naming another word is nearly always a typo in the WORD.
    if explicit_forms:
        if args.no_inflect:
            print("  attention : --form est ignoré sous --no-inflect.", file=sys.stderr)
        elif lang not in FORM_LANGS:
            print(f"  attention : --form est ignoré : pas de table de formes pour "
                  f"'{lang}'.", file=sys.stderr)
        else:
            for key in sorted(set(explicit_forms) - forms.answered):
                print(f"  attention : --form « {key} » ne concerne pas ce mot.",
                      file=sys.stderr)


if __name__ == "__main__":
    main()
