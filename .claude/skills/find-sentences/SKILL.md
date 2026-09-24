---
name: find-sentences
description: Source French puzzle material for Whippin. Two requests — (1) pick books for the shelf (a list of N works matching the taste profile, for the user to download into packages/curation/shelf/), and (2) find candidate puzzle sentences from a source (epub, .srt subtitles, lyrics, or a proposed author/artist), returning 3–5 candidates with recommended secret trios. Use when the user asks for books to source, new puzzle sentences, sentence ideas, or to mine a book/film/album.
---

# Find puzzle sentences

You are sourcing material for the daily sentence-reconstruction game. A puzzle = one
short text + 3 secret words the player rediscovers via embedding-neighbor feedback. "A
sentence" here means the puzzle's text: one sentence, or a few short consecutive ones
read as one (a micro-story, ≤ ~33 words) — what matters is a short run of words with a
meaning. It must survive having its three best words removed WITHOUT the remaining
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
   - context-forced: the context leaves a reader ONE or TWO possible words — « [arrêt]
     cardiaque » (arrêt or crise, nothing else), the May-68 tear-gas anecdote handing
     you _grenade_. A word the context merely HELPS toward, with several possible
     fillers — « il prenait tant de [cocaïne] qu'il avait hérité d'un prénom
     sud-américain » — is not a fault, it is the game (the user's rule, 2026-09-10:
     the goal is to guess WITH the context);
   - given away by a visible sibling: same-lemma twin visible in the sentence
     (_appartenaient_/_appartiendraient_), or a near-synonym visible (_amour_ visible →
     _amoureux_ secret is warm on try one).
   Good example: "un monde de fausses places, de fausses rues, d'avenues _fantômes_" —
   dozens of nouns fit each slot.

## Stands alone (user rule 2026-09-18)

**The sentence must make complete sense on its own, SOLVED, to a reader who has only
the sentence.** The page is shown after the solve, never during play, so a line that
leans on it is a riddle with no answer. Reject a sentence when, read alone:
- a phrase means nothing without the page: « c'étaient donc des nerfs parfaits et ils
  présentaient l'unique inconvénient… » (Svevo) — whose nerves, perfect at what? The
  solved line still says nothing;
- it concludes or contradicts an argument the reader cannot see (« donc », « pourtant »,
  « mais » carrying the weight of the previous paragraph);
- a pronoun or demonstrative has no referent inside the sentence and the sentence needs
  it (« ils », « cela », « cette femme ») — « il » for an unnamed narrator is fine when
  the line is complete without knowing who he is.
- it is a REPLY: it quotes, answers or corrects a sentence the player cannot see — an
  opening quotation, a « cependant » or a « donc » that continues an argument, a colon
  that completes one (« “Il sait qu'il meurt” est une pensée profonde ; je crois
  cependant que la mienne est plus profonde » is wit about Pascal, not a line).
A sentence passes when a reader can say in one line what it is about, from the sentence
alone. The automated curator asks the model exactly that and strikes on a refusal.

## The trio rules

Which words are worth hiding — the punch, the image, the exact word, the chain, how hard
a hole plays in its line — is TASTE, and taste lives in the `taste` skill: read it. The
practical rules:

- Exactly three distinct words. A word repeated in the sentence makes one hole per
  occurrence sharing one rank map: a feature (the Marx *vermine* day), not a bug.
- In a fixed pair, hide the specific word, not the head: « arrêt [cardiaque] » has many
  fillers, « [arrêt] cardiaque » two.
- The start words must leave the displayed sentence valid French (below).
- No trio worth playing → next sentence. Never bend the taste to save a sentence you like.

## The start word

Each hole shows a START word, ranked 100–200 from the secret (lower rank = closer =
easier), and the three are chosen TOGETHER, by playing the day out — the craft is in the
`taste` skill. The practical rules:

- First strike every candidate that does not fit the slot; choose only among what is
  left. The displayed sentence must stay valid French: elision (« l'effet », never « le
  effet »), gender, number, verb form, and the CONSTRUCTION — a verb must accept the
  complement that follows it (« hérité d'un prénom » cannot become « affublé d'un
  prénom »).
- A plain word a player knows, never an obscure term or a proper noun.
- A start that breaks the grammar is replaced by another band word, never kept.

## The page (recorded 2026-09-08)

A book day shows the sentence on its PAGE: the raw sentences around it, muted, the
puzzle's line in the ink. The curator offers up to eight sentences each side and the
model says how many to keep on each; the cut is the model's, the text is the book's,
verbatim.

- Enough to situate the line — who speaks, what is going on — and no more: a page, not
  a wall. Two to four sentences a side is typical; zero is right when the line opens a
  chapter, or a paragraph that stands alone.
- Cut on a natural boundary: stop before a scene change, a heading, a change of speaker,
  a roll call of names, a footnote or an editor's note; never mid-thought, never on a
  sentence that only makes sense with the one after it.
- What comes AFTER the line weighs more than a third sentence before it: the page is read
  by someone who just rebuilt the line and wants to know where it led.
- Never rewrite, never summarise: the two counts are the whole answer.

## Taste

What makes a day worth playing — the voice, the line, the hidden words, the start words,
difficulty — lives in the `taste` skill, its one home. Read it before choosing anything.

## Sources

Use the SOURCE as a lever: the solved screen reveals it, so an unexpected provenance is
itself a turn. Aim for one day in seven or so from outside literature — a naturalist, an
economist, a speech, a documentary, a manual, a court record — chosen for a line that
reads like fiction.

Names that fit, beyond the three references: Carver, Tabucchi, Perec, Pessoa, Izzo,
Mouawad, Dubois, Bove, Simenon, Márai; translated kin (Zweig, Dazai, Pavese, Ogawa,
Ishiguro) when the line has its turn; witty non-fiction with a scene (Darwin, Marx's
rats, the *Hagakure*). French rap deep cuts (Népal, Alpha Wann, Josman, Rounhaa, Laylow,
Stupeflip, Hugo TSR, Jazzy Bazz, Lucio Bukowski lane — never the famous single), poems
(Darwich, Thiago de Mello lane), films and documentaries via subtitles. Length ~10–30
words (>33 is too long).

**Variety across the archive.** Never the same book or album twice. Several books from
one author are fine when each earns its place and they are not redundant (a second
Houellebecq for a different decade and mood, yes; three Bove novels in one month, no).
Vary eras, countries and registers over the run.

**Music (decided 2026-09-06).** A song has forty lines built for rhyme, so per-artist
yield is low and the writers are few: the rule for artists is a COOLDOWN, not "never
twice" — the same artist at most once a month, never the same song. The famous single
is out, and for the shelf that rule is mechanical: Genius pageviews, the top quarter of
an artist's songs dropped before reading (`pnpm shelf:lyrics`, #262). The artist list is
the user's, by hand, and the fetch never asks the model for names; when the user asks
for artist IDEAS, the lane is wider than rap — writers in rap beyond the current names
(Lucio Bukowski, Sameer Ahmad, Swift Guad, Anton Serra, Fuzati, Rocé, Casey, Georgio,
Dinos, Ichon, Prince Waly, Zamdane, Luv Resval, Lala &ce) and the prose-like lane outside
it (Odezenne, Mendelson, Diabologum, Programme, Arm, Dominique A, Bashung, Miossec,
Brigitte Fontaine, Daniel Darc, Flavien Berger, Bonnie Banane, Feu! Chatterton). A lyric
candidate is one to four adjacent lines of one stanza read as one sentence. Music is a
minority stream, one or two days a week. Movies are out of scope.

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
  `packages/generation/output/word/fr/`, the record of every generated puzzle; the
  backend's local store is a test bed, never a reference) and already on the shelf.
  Check both before delivering.
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
     `packages/generation/output/word/fr/**/*.json`.
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
