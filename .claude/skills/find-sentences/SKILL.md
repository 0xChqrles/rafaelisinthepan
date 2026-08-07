---
name: find-sentences
description: Find candidate French puzzle sentences for Whippin from a source (epub, .srt subtitles, lyrics, or a proposed author/artist). Mines the text, screens against LLM memorization, checks the vocab and past secrets, and returns 3–5 candidates with recommended secret trios. Use when the user asks for new puzzle sentences, sentence ideas, or to mine a book/film/album.
---

# Find puzzle sentences

You are sourcing sentences for the daily sentence-reconstruction game. A puzzle = one
sentence + 3 secret words the player rediscovers via embedding-neighbor feedback, so a
good sentence must survive having its three best words removed WITHOUT the remaining
context giving them back — to a human or to an LLM (puzzles are benchmarked against
frontier models with `pnpm bench:puzzle`; a sentence they solve in ~3 tries is dead).

## The two laws (learned the hard way)

1. **Fame is fatal, and quote sites are fame detectors in reverse.** The sentences
   readers transcribe to Babelio/quote sites/essays/bac anthologies are exactly the
   ones LLMs memorized. NEVER pick a final candidate from a quote site; source from the
   primary text (epub, .srt, lyrics page) and use quote sites only for discovery leads.
   Quote sites also contain outright misattributions — one "Perec" Babelio quote did
   not exist in the book at all. Verify against the primary text, always.
   Corollary: cult works are the enemy. *La Maman et la Putain* (3.5 h of monologue)
   yielded exactly ONE usable sentence — everything piercing had been written down by
   someone it pierced. Prefer beautiful-but-unfetishized sources: mid-list novels,
   Sautet/Pialat scripts, album cuts, mid-narrative paragraphs of known books.

2. **Every secret must pass the substitutability test.** In the holed sentence, each
   blank must admit many plausible fillers. Reject a secret when it is:
   - collocation-forced: "un dernier _verre_ au comptoir", "faire l'_amour_", "tuer le
     _temps_", "l'_horloge_ parlante", "avoir _envie_";
   - antithesis/parallel-forced: "belle comme le jour … belles comme la _nuit_"; mirror
     structures complete themselves;
   - context-inferable: the May-68 tear-gas anecdote hands you _pleurait_ and _grenade_
     once the scene is recognizable;
   - given away by a visible sibling: same-lemma twin visible in the sentence
     (_appartenaient_/_appartiendraient_), or a near-synonym visible (_amour_ visible →
     _amoureux_ secret is warm on try one).
   Good example: "un monde de fausses places, de fausses rues, d'avenues _fantômes_" —
   dozens of nouns fit each slot.

## Taste profile

The canonical references are **Houellebecq, Murakami, and Kundera**. The editorial
line: cynicism toward the modern Western world, disenchantment, melancholy, the
unbearable lightness of living, quiet sadness, perhaps a touch of anhedonia — but also
contemplation, and sometimes love and empathy for people, held against a real contempt
for human nature. The register is double-sided and BOTH sides must be present: lucidity
without bile, tenderness without lyricism. The best sentences carry the tension
(Pessoa's empty matchbox "comme si elle signifiait quelque chose" is the exact
register). Reject anything one-sided, and anything that lectures.

Same tone in other clothes: translated kin (Zweig, Pessoa, Dazai, Márai, Pavese…),
French rap deep cuts (Hugo TSR, Alpha Wann, Jazzy Bazz, Népal, Lucio Bukowski lane —
never the famous single), poems (Darwich, Thiago de Mello lane), films via subtitles.
Terse, concrete imagery beats abstraction. Length ~15–30 words (14 ok if dense; >33 is
too long). Never reuse the same book or album twice across the archive; vary authors.

## Pipeline

1. **Get the primary text.** Ask the user for the file if needed (they drop epubs in
   `~/Desktop/books`, subtitles in `~/Desktop/movies`).
   - epub: `unzip` to the job tmp dir, strip tags from `**/*.*html`, join whitespace.
   - .srt/.vtt: drop indices/timestamps/`<tags>`, join; try utf-8 then cp1252/latin-1.
   - Rap lyrics: `curl` paroles.net/genius raw HTML and extract around keywords —
     WebFetch's sub-model refuses lyrics; quote only 1–2 line excerpts and verify the
     lines are actually ADJACENT in the song.
2. **Mine in TWO passes.** (a) keyword pass: split sentences (90–230 chars), filter by
   imagery/disillusion lexicon; (b) READING pass: dump ALL substantial sentences and
   read them — the sentence-splitter butchers monologues, and multi-sentence
   micro-stories (2–4 short sentences, ≤ ~30 words total) are often the best
   candidates. Grepping alone missed every winner at least once.
3. **Select candidates**: right length, self-contained, felt; then pick a secret trio
   from THREE unrelated semantic fields (three weather words or three anatomy words
   warm each other — bad), each passing the substitutability test. A slug repeated in
   the sentence makes one hole per occurrence sharing one rank map — a feature the
   user likes (their Marx *vermine* day), not a bug.
4. **Screen for memorization** (WebSearch, exact quoted phrase):
   - zero hits → clean;
   - hits on quote pages, essays, bac/anthology PDFs, song samples → REJECT;
   - subtler: if the search result summary *recognizes the source from the phrase
     alone*, an LLM knows it → reject (this killed "se pâmaient devant les soldats").
5. **Check the game data** (never skip):
   - every secret's slug ∈ `packages/web/public/vocab/fr.json` (slug = lowercase,
     ligatures expanded, accents stripped, keep `[a-z-]`);
   - secret not already used: inspect `holes[].secret.slug` across
     `packages/backend/.local-store/*.fr.json` (past secrets incl. déçu, rien, main,
     souffrance, sexe, art, gestes, corps, vérité, travail, mots, visage, amer, mer,
     heureux, jaloux, néant, âme, réalité, privé, vermine…).
6. **Deliver 3–5 candidates**, each with: the exact sentence (accents/punctuation
   kept), recommended trio + alternates, source metadata (`kind` book/music/poem/movie
   + author + work), fame-risk flag, and a ready command:
   `pnpm gen:phrase "<sentence>" --lang fr --words a b c --kind K --author "A" --work "W"`
   (no `--` separator; exactly 3 distinct words). Remind that `pnpm bench:puzzle` is
   the final arbiter, and for .srt sources suggest an ear-check against the scene.

## Reference wins (calibration)

- Pessoa: "Nettement, comme si elle signifiait quelque chose, la boîte d'allumettes
  vide résonne sur la chaussée qui s'annonce ainsi déserte." (allumettes · résonne ·
  déserte)
- Perec (epub-mined, zero hits): "Des suites de rues se coupant à angle droit, des
  rideaux de fer, des palissades, un monde de fausses places, de fausses rues,
  d'avenues fantômes." (rideaux · palissades · fantômes)
- Eustache: "Tu crois que tu te relèves, alors que tu t'accoutumes tout doucement à la
  médiocrité." (relèves · accoutumes · médiocrité)
- Mathieu: "Il existait comme ça toute sorte de ruses pour surmonter le désert, cette
  étendue uniforme de temps qui vous attendait au saut du lit, et pour de bon, jusqu'à
  la retraite." (ruses · désert · retraite)
