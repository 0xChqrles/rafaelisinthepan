// What each language's existence set IS (#200) — the facts a consumer needs about a
// vocabulary it never loads. The backend bounds a sentence score by `vocabSize` and
// takes the languages it serves from this record's keys; the set itself is a 1.6 MB web
// asset only the SPA fetches.
//
// `vocab.generated.json` is written by GENERATION, in the same call that writes the set
// (`slug.write_vocab`), from the same slugs — so the two describe one vocabulary by
// construction. That is why these numbers are generated rather than pinned by hand: a
// constant plus a failing test still needs a human to read the failure and copy a number
// across, and until they do, the server is enforcing a bound the game no longer has.
// It lands in this package because deploy.yml's paths-filter already fans `shared` out to
// both stacks, so a regenerated vocabulary carries its new numbers into the backend
// through a mapping that exists. NEVER hand-edit the JSON — re-run `pnpm vocab:<lang>`
// (or the reduce that produced the set) and commit what it wrote.
import builds from './vocab.generated.json';

export interface VocabBuild {
  // The corpus build the vocabulary was reduced from, named without the `_reduced`
  // suffix or extension ("cc.fr.300", "glove.6B.300d"): both sides of the reduction
  // name the same build, so whichever command refreshed the set recorded the same one.
  // Worth keeping because so much of the design is calibrated against corpus properties
  // (Word mode's rarity cuts, the measured en-vs-fr gap) — a retune reads as evidence
  // only if you know which corpus it was measured on.
  embedding: string;
  // UTC date (YYYY-MM-DD) of the run that first produced THIS vocabulary. An unchanged
  // rebuild keeps it, so it dates the corpus build and not the last time someone
  // generated a puzzle.
  builtAt: string;
  // Distinct slugs in the existence set. A sentence score counts distinct
  // vocabulary-valid tries, so this is that score's ceiling.
  vocabSize: number;
  // The longest key in it — no valid guess can be longer, so it is the length cap for a
  // stored guess. EMITTED AHEAD OF ITS CONSUMER: nothing reads it yet, because nothing
  // stores guesses yet (#199). The same pass measures it either way, so recording it now
  // costs nothing — but it is not a bound anything currently enforces.
  maxSlugLength: number;
}

// Keyed by language. Its keys are the languages the pipeline has actually built a
// vocabulary for, which is what makes it the honest answer to "is this a language we
// serve?" — read it with `Object.hasOwn`, never a bare index (a prototype key like
// `constructor` would pass).
export const VOCAB_BUILDS: Readonly<Record<string, VocabBuild>> = builds;
