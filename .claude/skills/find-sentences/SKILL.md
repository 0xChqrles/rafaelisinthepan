---
name: find-sentences
description: Source French puzzle material for Whippin. Two requests — (1) pick books for the shelf (a list of N works matching the taste profile, for the user to download into packages/curation/shelf/), and (2) find candidate puzzle sentences from a source (epub, .srt subtitles, lyrics, or a proposed author/artist), returning 3–5 candidates with recommended secret trios. Use when the user asks for books to source, new puzzle sentences, sentence ideas, or to mine a book/film/album.
---

# Find puzzle sentences

You are sourcing material for the daily sentence-reconstruction game. A puzzle = one
sentence + 3 secret words the player rediscovers via embedding-neighbor feedback, so a
good sentence must survive having its three best words removed WITHOUT the remaining
context giving them back, to a human or to an LLM. The automated curator (#260) applies
the same rules headlessly; this skill is the interactive version.

## The two laws

1. **Only the widely quoted LINE is out; the book is never out.** A sentence an LLM
   has memorized is dead (it lands the secrets in ~3 tries): the lines readers copy
   onto Babelio, quote sites, essays and bac anthologies. Famous authors and famous
   books are fine, *L'Étranger* included; *Aujourd'hui, maman est morte* is not. Decide
   per sentence: a mid-narrative line from a canonical novel is as good as one from a
   mid-list novel. Always source from the primary text (epub, .srt, lyrics page) and
   verify there: quote sites carry misattributions (a Babelio "Perec" line did not exist
   in the book), so they serve as discovery leads only.

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

## The trio rules (learned from months of player feedback)

The target is a median of 10–20 tries, with the struggle spread over the SENTENCE, never
concentrated on one word.

- No very easy and no very hard hole. Difficulty should be comparable across the three.
- A secret the context gives away is replaced. When the context helps only a little, a
  harder start word is acceptable (not too tricky); when it helps too much, another word.
- Two secrets too similar in meaning → replace one. Three secrets from three unrelated
  semantic fields (three weather words or three anatomy words warm each other).
- Three secrets in the same part of the sentence, or describing the same thing (a verb
  and its subject) → replace one. Spread them across the sentence.
- At most one verb.
- No trio possible under these rules → next sentence. Never bend a rule to save a
  sentence you like.
- A slug repeated in the sentence makes one hole per occurrence sharing one rank map: a
  feature the user likes (their Marx *vermine* day), not a bug.

## Taste profile

The canonical references are **Houellebecq, Murakami, and Kundera**. The editorial
line: cynicism toward the modern Western world, disenchantment, melancholy, the
unbearable lightness of living, quiet sadness, perhaps a touch of anhedonia — but also
contemplation, and sometimes love and empathy for people, held against a real contempt
for human nature. The register is double-sided and BOTH sides must be present: lucidity
without bile, tenderness without lyricism. Reject anything one-sided, and anything that
lectures. This is the game's voice and it does not move.

### What players love inside that voice (measured)

Share rate = unique shares / unique solves per day, 58 days (2026-07-08 → 09-05), mean
0.63, noise about ±0.15 on one day. Each line was coded by hand on a few features:

| Feature of the line | Share rate with | without |
| --- | --- | --- |
| **Unexpected source** (Darwin, Marx, a documentary, a president, the *Hagakure*) | **0.77** | 0.61 |
| **Wit** — irony, a dry joke, a cruel-precise comparison | **0.70** | 0.59 |
| **A turn** — the line lands on a reversal or a punch | **0.69** | 0.59 |
| An image carrying a thought | 0.68 | — |
| An image and nothing else (pure description) | **0.55** | 0.65 |
| Despair with no wit and no tenderness | **0.54** | 0.65 |
| Abstract nouns without wit (*néant, âme, ineffable, réalité*) | **0.51** | 0.65 |
| A verdict on the reader ("tu t'accoutumes à la médiocrité") | **0.25** | 0.64 |

What does NOT matter: the kind (book 0.61, music 0.66, movie 0.67 — rap is never
penalized), the length (28+ words scored highest), and difficulty inside the 10–20 band.
The one difficulty effect is the outlier: the day with a median of 42 tries was the
least-shared day of the run (0.31) — the trio rules exist for that reason.

The rule that follows, and it keeps the voice: **a sentence must DO something.** The
disenchantment is welcome when it arrives with a joke, a tenderness, or a concrete scene
that turns; alone, it is the game's weakest material. So, when choosing between two
sentences of equal register:

- prefer the line that lands — a reversal, a punch, a comparison that bites ("comme la
  lèpre fait tomber la chair", "mammifères intelligents, qui auraient pu s'aimer");
- prefer a scene where something happens (the match thrown at the swan, the dog that
  could be killed as easily as caressed) over a landscape, however beautiful;
- reject the meditation made of abstract nouns, and the line whose only content is
  despair or a verdict on people — the top of the archive is never one-sided;
- and use the SOURCE as a lever: the solved screen reveals it, so an unexpected
  provenance is itself the turn. Aim for one day in seven or so from outside literature —
  a naturalist, an economist, a speech, a documentary, a manual, a court record — chosen
  for a line that reads like fiction.

Names that fit, beyond the three references: Carver, Tabucchi, Perec, Pessoa, Izzo,
Mouawad, Dubois, Bove, Simenon, Márai; translated kin (Zweig, Dazai, Pavese, Ogawa,
Ishiguro) when the line has its turn; witty non-fiction with a scene (Darwin, Marx's
rats, the *Hagakure*). French rap deep cuts (Népal, Alpha Wann, Josman, Rounhaa, Laylow,
Stupeflip, Hugo TSR, Jazzy Bazz, Lucio Bukowski lane — never the famous single), poems
(Darwich, Thiago de Mello lane), films and documentaries via subtitles. Length ~15–30
words (14 ok if dense; >33 is too long).

**Variety across the archive.** Never the same book or album twice. Several books from
one author are fine when each earns its place and they are not redundant (a second
Houellebecq for a different decade and mood, yes; three Bove novels in one month, no).
Vary eras, countries and registers over the run.

## Request 1 — pick books for the shelf

The user asks for N works (typically 100) to download into `packages/curation/shelf/`
(gitignored; the user obtains the files, you only name them). Deliver a list the user
can act on:

- **One line per work**: author · French edition title (the game is French; for a
  translated work give the original title too, and the translator when a translation is
  the reference one) · year · one clause on why it fits the profile.
- **Grouped by author**, a few works per author at most; ~60–70% of the list on distinct
  authors so the archive stays varied.
- **Mix**: French-language originals and translations; classics and mid-list; novels
  first, with a few short-story collections, diaries and essays if the register fits,
  and about one in seven from OUTSIDE literature (natural history, economics, speeches,
  manuals, documentaries) — the unexpected-source lever above. Fame does not exclude a
  book (see law 1); what excludes is a wrong register, poetry the vocab cannot carry, or
  a text so short it holds no sentence.
- **Exclude** works already in the archive (`source.work` across
  `packages/backend/.local-store/*.fr.json` and `packages/generation/output/`) and
  already on the shelf. Check both before delivering.
- Prefer works that exist as a French epub; no self-published or out-of-print
  obscurities the user cannot find.

## Request 2 — find sentences from a source

1. **Get the primary text.** Ask the user for the file if needed (the shelf is
   `packages/curation/shelf/`; subtitles in `~/Desktop/movies`).
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
   under the trio rules above, each secret passing the substitutability test.
4. **Screen the LINE for memorization** (WebSearch, exact quoted phrase):
   - zero hits, or hits only on full-text scans → clean;
   - hits on quote pages, essays, bac/anthology PDFs, song samples → REJECT the line
     (not the book: keep mining it);
   - subtler: if the search result summary *recognizes the source from the phrase
     alone*, an LLM knows it → reject (this killed "se pâmaient devant les soldats").
5. **Check the game data** (never skip):
   - every secret's slug ∈ `packages/web/public/vocab/fr.json` (slug = lowercase,
     ligatures expanded, accents stripped, keep `[a-z-]`);
   - secret not already used: inspect `holes[].secret.slug` across
     `packages/backend/.local-store/*.fr.json`.
6. **Deliver 3–5 candidates**, each with: the exact sentence (accents/punctuation
   kept), recommended trio + alternates, source metadata (`kind` book/music/poem/movie
   + author + work), memorization-risk flag, and a ready command:
   `pnpm gen:phrase "<sentence>" --lang fr --words a b c --kind K --author "A" --work "W"`
   (no `--` separator; exactly 3 distinct words). For .srt sources suggest an ear-check
   against the scene.

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
