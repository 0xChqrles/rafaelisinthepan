# AGENTS.md — @whippin/web (React + Vite front end)

> Package-scoped guidance. The root `AGENTS.md` applies here too and holds the
> engineering principles, the cross-package contracts this front CONSUMES — the
> slug()⇔fold() identity, the per-puzzle JSON schema, and the day-addressed routing
> protocol — plus the testing policy and the issue/PR workflow. Read it first.

## File map

```
  web/                        React + Vite + TS front (pkg @whippin/web)
    src/
      hooks/useVocab.ts       fetch+cache the per-language existence Set (once per session)
      hooks/usePuzzle.ts      fetch the client-computed day's puzzle from the backend
      api.ts                  backend client: puzzleUrl/todayUrl, 404->NO PUZZLE
      i18n.ts                 UI chrome strings (en+fr), t(lang, key); parity type-enforced
      tutorial/               onboarding (#51/#155): Tutorial.tsx + data scripts/<lang>.ts
                              (+ <lang>.word.json, the pruned #154 board it plays on)
      screens/Game.tsx        the guess loop, hole state (imports fold from @whippin/shared)
      screens/WordGame.tsx    Word mode's three phases: rules gate -> timed run -> post-mortem
      game/wordGame.ts        Word mode's rules + economy (CLAIM_ZONE, the rarity ladder, the clock)
      game/wordBoard.ts       Word mode's post-mortem board: the zone as stations on RARITY lanes
      components/rarity.ts    a rarity grade's pinned colour, and how many times a find is struck
      components/WordSlash.tsx    the slash a claim cuts the day's word with
      components/WordSubject.tsx  the day's word while the run is on: the word alone, centred
      hooks/useCountdown.ts   the run's deadline, as a ticking clock (HUD) and as one flip (screen)
      game/scoring.ts         s(rank), holeProgress, computeProgress
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
      components/routeDrawing.tsx  THE route drawing: geometry, lanes, frame vars + the row
                              parts (Junction/OffMapShelf/RouteTail/RouteLink/RouteRow).
                              WordBoard (#156) composes it (the #117 route map was its other
                              consumer until 2026-08-10). It owns the SHAPE of a lane; the
                              surface owns what a lane MEANS and passes the palette.
      game/history.ts         a hole's guess log ranked against its secret (buildHistory)
      components/HistoryModal.tsx  the hole tap's surface: your tries, closest first
      game/share.ts           what a RESULT says: both modes' share text + link (emoji row,
                              rarity bead row, the composed messages)
      hooks/useShare.ts       how a RESULT leaves the app (native sheet -> clipboard + COPIED)
    public/                   served at site root (web assets + generated data)
      vocab/<lang>.json       full slugged reduced vocab (existence set) — fetched by the SPA
```

---

## Stable invariants

These are decided and verified against the code. Treat them as load-bearing.

### Front game loop

- The front fetches `packages/web/public/vocab/<lang>.json` (served at `/vocab/<lang>.json`)
  **once**, builds an immutable `Set`,
  and caches it across puzzles/days (module-level cache in `useVocab`). **Existence
  is decided by this Set, never by a puzzle's rank map.**
- On Enter, `typed = fold(raw)`, then:
  1. **Not in `vocabSet`** → INVALID: red shake + "this word does not exist" under
     the input. No hole reacts.
  2. **In vocab** → **every UNSOLVED** hole (`rank !== 0`) reacts; look up
     `ranks[hole.secret][typed]`. A hole is **WARM** when the entry exists and **TOO
     FAR** otherwise. **Every impacted hole shows a floating indicator** (no
     exceptions — improving holes included):
     - **Warm** (entry exists) → a transient rank **distance number** floats on the
       hole, in the heat color of that distance.
     - **Too far** → the **same** floating + word-shake animation, but it reads
       **"MISS"** instead of a distance (no rank exists beyond top-K), in the coldest
       heat color.
     - **Warm + improves** (entry's rank beats the hole's current rank) → the hole
       **additionally** swaps to the entry's **accented `word`** and lower `rank`,
       but **only when its floating number begins to fade out** (`fadeDelayMs`), so
       the exponent-drop animation reads as the resolution of the number that landed.
  3. A single guess can advance/solve **several** holes. If `typed` is too far for
     **every** unsolved hole, **"MISS" plays on every hole**. Floating distance
     numbers and `"MISS"` feedback **start** consecutively in sentence order,
     `STAGGER_MS = 200ms` apart, but their fade-out phase is synchronized across the
     batch (they disappear together). The rank-improving word/rank replacements all
     fire **together** at that shared fade-out moment.
- **Solved holes (`rank === 0`) are locked:** excluded from the loop and rendered
  solved (accented secret, no exponent).
- **Feedback grammar:** under-the-input message = info about *what you typed* (only
  INVALID uses it now); on-hole floating number/"MISS" = info about *a hole*.

### Progress (`game/scoring.ts`)

For each unique secret slug, with `N = number of ranked GROUPS in ranks[secret]` —
the count of **distinct rank values** (alias keys share their group's rank, #104;
on an alias-free puzzle this equals the key count):

```
s(rank)   = 1 - ln(rank + 1) / ln(N + 1)              // s(0) = 1 (solved)
p_hole    = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
progress% = 100 * average(p_hole over unique secret slugs)
```

Rendered occurrences of the same secret slug share one logical progress target. They
remain separate runtime holes for positions, feedback, animation, and solved rendering,
but duplicate occurrences do not receive extra weight in the frontend percentage.

### Score

The score is simply the **number of unique tries**. A try is a submitted word that
exists in the per-language vocabulary set, including cold misses and non-improving
warm hits. Repeated guesses are deduped by **canonical identity** (`guessKey`,
#104): a guess is identified by its **whole outcome** — its rank in EVERY secret's
map (JSON key order), with the absent maps marked — so two guesses count once only
when they are indistinguishable, which is exactly what accent variants and
inflections of an already-tried word are; a guess in no map (a cold miss
everywhere) falls back to its folded slug (`fold(raw)`). The uncounted variant
plays its feedback but never enters the persisted `tried` history — and because a
deduped guess resolves identically everywhere, it provably cannot improve or solve
a hole, so **replaying `tried` always reproduces the board**. Invalid non-words are
rejected before counting.
**The identity was the FIRST map's entry until 2026-08-03** (`secret:rank`), on the
reasoning that aliasing is consistent across maps. It is not: a slug collision is
resolved PER MAP, closest-wins, so one map can fuse two surfaces another map ranks
far apart. On fr day 20667 `maniere`/`manieres` were one group in the first map
(both folding onto `maniérés`) while the `manieres` hole ranked them 2 and 0 — the
guess that SOLVED the sentence was discarded as a repeat, never entered `tried`,
and every view replayed from it (run ruler, share card, emoji row, and the score)
lost that solve: the card drew no tick for the middle word and a run that stopped
at 93.5%. Comparing whole outcomes makes that unrepresentable. Already-persisted
rounds keep the log they recorded (a token is a snapshot; nothing is back-filled).
**`llm_play.py`'s `_guess_key` is the parity twin and moved with it** — there, a
deduped guess also receives no feedback and changes no state, which the outcome
identity finally makes sound. The score is displayed as the large background number during the round and
as `<tries> TRIES` at game end (the unit is NAMED — on the solved screen, the share
card, and the share text — because "SCORE" alone reads as points to maximize when
lower is better; singular `TRY` at 1). Like the rest of the UI chrome the label is
localized (fr: `ESSAIS`/`ESSAI`, decided 2026-07-06); the unit stays named in every
language. The solved tray shows the named `<tries> TRIES` headline on EVERY surface
(decided 2026-07-25, superseding #110's headline-omitted-next-to-the-table exception:
the leaderboard moved behind SEE MORE into its own full-screen dialog, whose player row
also carries the count). The share card/text always name the unit.

---

## Do NOT

- **Don't hardcode `TOP_K` / 2000 in the front** — test map membership instead.

(Cross-package Do-NOTs — slug/fold divergence, fold/display separation, lemma-merge
containment — live in the root `AGENTS.md`.)

---

## Commands

```bash
pnpm dev        # dev server (set VITE_API_BASE_URL=http://localhost:8787 for the local backend)
pnpm build      # production build -> packages/web/dist
pnpm typecheck  # tsc --noEmit
```

Front-end dev harnesses: `?tutorial=1` forces the tutorial, `?streak=N` previews the
streak celebration (dev only). There is **no `?puzzle=` file override** — the front
always loads the day's puzzle from the backend (test a specific puzzle by publishing
it to the local store — see `packages/backend/AGENTS.md`).

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Word mode (#156, the second daily; RETIMED by #163 on 2026-08-08):** one app, two faces
  — `/<lang>/word` (plus `/word/<date>` and `/word/archive`, same date rules) plays the day's
  #154 artifact: the word is PUBLIC and the player claims its top-`CLAIM_ZONE` (**1000**
  since 2026-08-11; 250 before it, 150 before that) groups **against a COUNTDOWN**; the score
  is the claim count. **Since 2026-08-11 the number is also TOLD to the player**, on the
  gate's first rule — see the gate bullet.
  **`CLAIM_ZONE` IS this package's own tuning knob since 2026-08-10** — freely movable, with
  no republish and no regeneration. Its only real ceiling is generation's `TOP_K` (10 000),
  past which a rank has no entry to claim. **Two things SCALE with it**, neither a blocker
  but both worth knowing before it moves again: the post-mortem board draws every zone group
  as a station, so this is also the board's ROW COUNT (1000 rows since the widening — the
  reveal's scrambles were already disabled, so the cost is DOM, not animation); and
  `wordStatusOf` reads progress as claimed/zone, so the archive's and chooser's percentages
  are proportionally smaller (a 25-claim run reads 3% where it read 10% — honest, since the
  field is deliberately unclearable and is now four times more so). It used to be the one constant here that was NOT ours to
  pick alone: it restated generation's `ROAD_TOP` (`distances.py`) and `wordGame.test.ts`
  read the Python literal to pin them, because the field the board drew was exactly the set
  of groups carrying a `road` — move one and the board grew lane-less stations, or drew
  stations it would not let you claim. The board now draws one trunk and paints its station
  words by RARITY (see the board bullet below), generation stamps a word artifact with no roads at all, and `dq` — what the drawing
  actually spaces its stations by — runs to the map's own `TOP_K` edge. The pin is deleted
  with the coupling.
  **The CLOCK replaced the strike system (#163).** Two dailies should be two games:
  Sentence mode is think slowly and beat the AI, Word mode is think fast and beat the clock.
  Everything the strikes legislated, the timer legislates for free — a repeat, an invalid
  word or a far miss punishes itself in the seconds it cost to type — so `STRIKES_TO_END`,
  the consecutive rule, end-by-strikes, `WordFailures`, the crosses row, `assets/cross-button.png`
  and the `--strike-gap` responsive override are all GONE, along with `srWordFailures` /
  `srWordStrike`. Word mode has **no bots and never will**: an LLM cannot play a timed game
  honestly and we never miseducate what a model did, so this mode's comparison story is
  friends (a leaderboard, later), not AIs. That is a feature of the split, not a gap.
  **The economy is `game/wordGame.ts`, and every constant in it is a declared TUNING KNOB**
  (the way `STRIKES_TO_END` was): `START_SECONDS` (**60**) and the `RARITY_LADDER`. Nothing
  restates them — the HUD reads them and the tests DERIVE their expectations from them — so
  retuning after a play session stays a one-line change. **The values are placeholders until
  played** (solo, then beta testers); the margin question is whether an average claim's bonus
  roughly covers the typing cost of the next guess on MOBILE, the slower device. Mis-tuned
  low, runs end in 90 seconds and feel unwinnable; high, every run exhausts the zone.
  **That claim has been EXERCISED and it held** (2026-08-11): the start went to 120 and every
  rung doubled, then both were rolled back the same day — exactly the round trip
  `STRIKES_TO_END` made at 5-and-back-to-3. Nothing moved in either direction: no test, no
  component, no artifact, because the tests assert the ladder's SHAPE (ratios and ordering)
  and a scalar leaves that alone. Two findings worth keeping for the next attempt: the
  START value is a **width** decision as well as an economic one — at 120 the HUD reads three
  digits from the very first frame where 60 reads two — and a scalar on the ladder cannot
  change the balance BETWEEN grades, only how fast the whole run breathes. The open question
  is what a claim is worth against its own typing cost, and only play answers it.
  **FIVE NAMED RARITY GRADES, and they are the game's visible vocabulary** (decided
  2026-08-08): `COMMON` / `UNCOMMON` / `RARE` / `OBSCURE` / `ARCANE`, **UNTRANSLATED in every
  language** like MISS / YOU / DNF — one word per grade, identical everywhere. A claim's
  grade is what floats on the word, and it is what pays the clock: **4 / 6 / 9 / 14 / 21
  seconds, a geometric ×1.5 ladder**. EXPONENTIAL and not linear on purpose — rarity should
  PAY OFF rather than tick up, and an ARCANE worth five COMMONs is what makes hunting depth a
  real strategy against spamming short frequent words. (The ladder also roughly DOUBLES what
  a claim used to be worth: measured over 1750 real zone groups, the retired 2/3/4/5 tiers
  averaged 3.34s a claim against this ladder's 6.82s.)
  **A grade is a FRACTION OF THE CORPUS, never an absolute frequency rank** (decided
  2026-08-08, and the one part of this that is not a free knob): `rarityOf(freq, corpusSize)`
  divides the shipped `freq` by `vocabSet.size` — the existence set the round already loads
  before it can accept a guess — and the ladder's cuts are the commonest **10% / 22% / 50% /
  85%** of the language. Absolute cutoffs were tried FIRST and measured on real generated
  artifacts: en's vocabulary is 75k words and fr's 128k, so the same rank means very
  different things in them, and on the SAME artifacts with the SAME seconds ladder an
  average claim paid **5.26s in en against 10.12s in fr — fr runs lasting 1.93× longer for
  no reason but the size of its dictionary**. Dividing by the corpus brings that to
  **1.47×**. Both halves count the same population, which is why generation ranks `freq`
  over DISTINCT SLUGS rather than raw forms (#163 fix): V and the existence set differ by
  exactly the accent collisions, 4.1% in fr against 0.0% in en — a language-dependent skew in
  the one number that exists to make rarity language-independent.
  **The 1.47× that REMAINS is a product call, not a bug, and no cut set removes it:** en's
  250-word neighborhoods do not reach as far down their corpus as fr's (zone p98 at 0.43 of
  the vocabulary against fr's 0.94), so with these cuts an en board grades **59/29/12/1/0**
  across the five where an fr board grades **36/28/15/15/5** — English players top out at
  RARE in practice. Cuts low enough to give en a real ARCANE hand fr ~19% of every board as
  ARCANE, so the shipped cuts favour fr's pyramid and the doubling target; the measured
  alternative is **0.08/0.18/0.34/0.55**, which makes all five reachable in en (52/28/16/4/1)
  at the cost of fr's shape. It is a true statement about the two embeddings (GloVe 6B vs
  fastText cc.fr) and the tuning sessions are where it gets decided.
  An ENTRY with no `freq` (a borrowed-vector group) grades COMMON — the floor, never a
  windfall for missing data — but an artifact with no `freq` ANYWHERE is a stale pre-#163
  map that would silently halve the economy, and `parseWordPuzzle` refuses it at load (the
  no-back-compat rule: a stale artifact is republished, never limped on).
  Rarity feeds the CLOCK only, never the score — one resource, one number. Total time is
  bounded by construction (`START_SECONDS` + the zone's summed bonuses), so no run is
  infinite and the zone stays unclearable in practice.
  A claim is a valid vocab word, not already tried, ranked inside the zone. **Anything the
  run cannot claim floats `MISS`, in red — a near miss (ranked, just outside the zone) and an
  off-map guess alike** (decided 2026-08-08, superseding the near miss's rank float). The
  rank was justified as the zone's teaching signal, and it was the right call on a
  contemplative board; on a clock it is a number the player can do nothing with, and the two
  outcomes are identical in every way that matters to them — no time gained, no time lost but
  the seconds spent typing. It survives where it still teaches: the post-mortem draws that
  guess on the trunk at its real rank, showing the form the player TYPED (per the naming rule
  in the route-map bullet below). `srWordMiss` says the same thing the screen does.
  Not-in-vocab, group-level repeats (#104) and the day's word itself stay free non-events.
  The pure rules live in `game/wordGame.ts` (`judgeWordGuess` / `wordGuessKey` /
  `replayWordRun` / `bonusSeconds` / `runMs` — a round replays from its counted-guess log
  exactly like the sentence game), the board model in `game/wordBoard.ts` (a SIBLING of
  `buildRoute`: no departure, no "you are here"), and the surface in `screens/WordGame.tsx`
  + `components/WordBoard.tsx` + `components/WordTimer.tsx`.
  **The clock is a wall-clock DEADLINE, not a ticking counter, and there is NO PAUSE**
  (decided 2026-08-08). The round persists `startedAt` and a `deadline` = `startedAt +
  runMs(Σ bonuses)`, re-derived from the WHOLE log on every write, so the clock can never
  drift from the guesses that bought it; the run is over when `now > deadline`, whatever
  happened to the tab in between. Backgrounding, reloading or closing it does not stop the
  clock — an interrupted run is a ruined run ("it is what it is") — and that shape is also
  what makes the rule enforceable: there is no remaining-seconds value to freeze, so there
  is nothing to cheese by closing the tab mid-bad-run. A submit is judged against the
  deadline at the moment Enter lands, in the STORE, so a guess in flight when the clock dies
  is dead; past the deadline the round is FROZEN, re-pricing included (re-pricing a finished
  run could hand it a later deadline and revive it). A reload rehydrates from the log +
  deadline: time left resumes with the real remaining time, none renders ended. The daily is
  one-shot — `startWordRun` stamps `startedAt` once and is idempotent, so no render path can
  reopen a finished day. Verified end to end at 320/430: reload mid-run resumes, a
  ten-minute background jump lands on the finished screen, and a guess typed before the
  deadline but entered after it never enters the log.
  **Two hooks, one deadline, for a REASON** (`hooks/useCountdown.ts`): `useCountdown`
  returns the remaining ms and re-renders ~10×/s, and is used ONLY inside `WordTimer`;
  the SCREEN uses `useDeadlinePassed`, which schedules ONE timeout for the deadline itself
  and re-renders once. Subscribing the screen to the fine clock re-rendered the prompt and
  the whole keyboard at 10 Hz for the entire run — during exactly the phase where a fast
  game must not make the player wait on a keystroke. Both DERIVE from `Date.now()` at render
  rather than storing a countdown: the deadline appears in the same commit that starts the
  run, so a value only an effect could refresh would paint one frame reading zero — which is
  the run's own end condition, and the whole ending would fire on the PLAY tap.
  **`replayWordRun` is the ONE walk of a word round** (2026-08-06): it returns the ordered
  `counted` guesses with their judgements plus the seconds they bought, and `buildWordBoard`
  sorts THOSE into claims / trunk stops / the misses shelf rather than re-deriving the dedup
  a second time — the score, the clock and the drawing cannot disagree about what one log
  means. What it does NOT return is `ended`: that is the deadline's, and a log cannot see a
  wall clock (`WordBoardModel` lost its `ended` field with it).
  **The screen runs in THREE phases** (#163), each putting one thing in front of the player.
  **GATE** — the day's word, and the sentence gate's EXACT stack (user-decided
  2026-08-11): two bulleted rules in the shared `.coach-rules` dialog over a full-width
  PLAY (the sentence gate's own label, user-decided 2026-08-11 — one shared `gatePlay`
  key), in `.rules-gate` on the tray's bottom edge (see the sentence gate bullet). A
  timer needs a start
  control anyway, and the control is where the rules live, so this screen is Word mode's
  whole onboarding and no tutorial change was needed. The clock previews `START_SECONDS`
  greyed beside it, so the number teaches what it is before it starts moving; the copy
  states no duration (the HUD is already saying it, and stating it twice would be
  restating a tuning knob).
  **The rules state EXACTLY ONE number, and it is the ZONE** (user-decided 2026-08-11,
  superseding "neither rule states a number"): the goal line names how many words count.
  "Find words close to it" gave the player nothing to aim at, where a count is a target
  they can hold. **It is never SPELLED into the copy** — `wordRulesGoal` carries a `{n}`
  placeholder that the screen fills from `CLAIM_ZONE` via `tn()`, so the rule and the
  sentence announcing it cannot drift; a hardcoded "1000" would start lying the first time
  the zone moved, and a gate that lies about the field is worse than one that says nothing.
  `{n}` is the STRINGS table's only placeholder, which is what keeps the line in the
  type-checked en+fr table (parity by compiler) rather than in a hand-written bilingual
  function like the `sr*` helpers. `wordGame.test.ts` pins both halves: the placeholder
  survives in both languages, and the gate's whole copy contains exactly one number. **RUN** — the word, the prompt, the
  keyboard, the timer and the score, and **NO BOARD**: this is a fast game, and a live map
  to read is a contemplative surface pulling against the clock. **OVER** — the board
  arrives, revealed, as the post-mortem the run earned.
  **During the GATE and the RUN the day's word is JUST THE WORD — centred, in the solved
  blue, no node, no rail, no rank gutter** (`components/WordSubject`, decided 2026-08-08).
  It is deliberately NOT the route drawing's terminus row: that row carries a square node and
  a rail stub because it is the END OF A LINE, and none of that means anything while there is
  no line. `WordTerminus` still mounts at the bottom of the revealed board, so the word is
  the same word in two registers — a subject during the run, a station in the post-mortem —
  and it is the reveal beat that swaps them. Two consequences worth knowing: the run's word
  brings its own `--wordw` (the WHOLE page column, where the route frame's is what survives
  the gutter and rail) so the shared `fitWord` still guarantees no mid-word break; and it
  carries the word as REAL sr text (`srWordBoardWord`), which fixed a live accessibility hole
  — the board's sr mirror is post-mortem-only and `WordTerminus` is `aria-hidden`, so before
  this the day's word was spoken NOWHERE for the whole game. `WordTerminus` lost its hit
  plumbing with the move: no guess can land while it is on screen.
  **The word is HELD, like a hand of playing cards** (decided 2026-08-09): the first letter
  leans left, the last leans right and everything between follows the same arc, with the
  outer letters falling away from the middle — the drop is what makes it a HAND rather than
  skewed type, since cards splay from a pivot below and their outer ends dip. `WordSubject`
  splits the word into `.hole-letter` boxes for this — the pixel font is monospace, so the
  word measures exactly as plain text and `fitWord` is untouched.
  **And the hand BREATHES: it rises and, in the same breath, spreads.** Two elements, one
  rhythm — the rise on the WRAP so the word and any grade label on it move as one object, the
  spread (`letter-spacing`) on the TEXT, since spacing is inherited and would otherwise reach
  the label too. Same duration, same easing, both started at mount, so they stay in phase
  with nothing synchronising them. The spread is the one thing here that changes the word's
  WIDTH, which is why `.word-subject`'s `--wordw` reserves 5% for it — the same kind of
  allowance the route frame's `--wordw` makes for a scrollbar it cannot see. Verified on the
  worst case, a 25-letter French word at the top of its breath: 290px of the 292 a 320px
  screen holds.
  **Now and then the letters RIPPLE** — #129's wave, the sentence holes' own, on the same
  random 3–10s clock (2026-08-09, replacing a single letter that rose every 750ms as though
  about to be drawn). Its four numbers are restated in `WordSubject` rather than reached for
  inside `Hole`: importing half a component's internals is not sharing it, and the
  alternative was coupling to a hole's `ticking` state, which this surface has no equivalent
  of.
  **The lean and the drop go on the INDEPENDENT transform properties** (`rotate` /
  `translate`), never into one `transform` string, and that is load-bearing rather than tidy:
  it leaves `transform` free, which is exactly what lets the wave — an ordinary transform
  animation — ride ON TOP of the fan instead of flattening it for the length of a ripple.
  Under reduced motion the float, the breath and the ripple are all switched OFF (infinite
  decorations, the rule the timer's warning pulse follows) — but **the fan itself stays**,
  because it is a POSTURE and not motion. All of this is the screen being alive while the
  player THINKS; it is deliberately separate from the guess FEEDBACK, which is what the
  screen says back when they ACT (the slash, below).
  **The TIMER is the HUD and the SCORE is the watermark.** The clock takes the header's
  status corner (where the sentence game puts its progress counter) at 34px — the one live
  number on the screen — and the count becomes the big `CellDigits` watermark behind the
  word (`.word-anchor`, the standing watermark rule: what is displayed better later, since
  the count is this mode's end-screen headline). **That watermark is sized for at least TWO
  digits whatever it currently reads** (`MIN_SIZED_DIGITS`, decided 2026-08-09) — a rule of
  the SHARED component, so the sentence game's try count gets it too. Both numbers count
  play, so both cross 10 in the first minute, and the width budget is what bites on a phone:
  measured at 320/375/430px, the count rendered 252px tall for claims 1–9 and **halved to
  126 on the tenth**, mid-round. A watermark is the screen's fixed furniture; it must not
  resize because the game went well. So `k` is computed from the widest 2-digit value the
  number could become while the BOX stays the real number's width (it still centres on its
  own ink) — which costs the 1–9 window some size and buys a count that never moves again.
  Past two digits it does move, because there is no honest way to reserve for a number with
  no bound; 99 → 100 is a milestone where 9 → 10 is the tenth guess of every single round.
  Verified a no-op at 900px, where the width cap never bit in the first place. That split IS the mode's feedback grammar:
  **a float on the WORD is about the guess** (its GRADE, or MISS), **a gain on the TIMER is
  about your clock** — `+4s` in the solved-word gold, keyed by a monotonic id so two claims
  in a row replay it. The clock reads **`seconds.decisecond`** and goes `--danger` red for
  the **last 20 seconds** (`WARN_SECONDS`); the tenth renders smaller than the seconds,
  which is width before it is taste — the header corner holds ~104px at 320px before the
  icon group, and a three-digit clock plus a full-size `.0` does not fit it (measured: it
  pushed the help icon off the screen). `useCountdown` ticks at 50ms so the last digit does
  not stutter.
  **A CLAIM SLASHES THE WORD; A MISS DOES NOT TOUCH IT** (decided 2026-08-09). The two
  outcomes are different EVENTS and look nothing alike, which is the point: before reading
  anything you know which one happened.
  A claim HITS the word with one of three sheets in `assets/hits/` (see the ladder below) —
  the default being `slash.png`, a 5-frame 36x46 stroke landing and dissipating, 50ms a frame
  — in the claimed grade's COLOUR wherever the sheet is a mask, **and while a stroke is on
  the word the word RECOILS and takes that colour too**, returning to the solved blue when it
  goes. **A strike is ONE BLOW of one sheet** (user-decided 2026-08-11, retiring the RARE
  cross and the whole multi-blow machinery — `blows`, `blowDelayMs`, `useStrikeBlow`'s
  per-blow choreography and its measured cross timings are gone), **and the blow is the
  stroke's first FOUR frames of five** (`STRUCK_FRAMES`/`STRUCK_MS`, decided 2026-08-09):
  stopping a frame SHORT is what makes a sheet's remaining frames read as dissipation over a
  word already back at rest. It is stated in the ART's own frames rather than as a duration,
  because it is a claim about which frames of the stroke the word is answering.
  `WordSubject.useStruck` owns it — struck for `STRUCK_MS` from the hit's mount, keyed per
  hit so a claim landing on another restarts the recoil. A MISS lands no blow. **The plain
  slash lands RANDOMLY MIRRORED** (user-decided 2026-08-11, repurposing the cross's flip):
  rolled once per hit in `WordSlash` — a state initializer, so a re-render cannot flip a
  stroke mid-swing — and ONLY for `slash.png`: the burst and the ultra are near-symmetric
  art with nothing to say backwards. There
  is no text that PARKS: a name has to be read, and a run against a clock has no time for
  that. The grade is carried by the strike's COLOUR, by the word taking that colour under
  it — and, since 2026-08-10 (user-decided, superseding "colour alone"), by the hit's LOOT:
  the claim knocks the guess's rank exponent and the grade's NAME off the word
  (`components/WordLoot.tsx` + `.word-loot` in index.css), popping up and apart off the
  impact like drops off a struck enemy, hanging, then falling away — in the air for 840ms,
  never parked. The exponent wears the heat colour every other exponent wears (the shared
  `rankHeatColor` at `HIT_HEAT_CAP`), the grade its `RARITY_COLORS` colour. The flight is
  the parabola trick — an outer box drifting sideways linearly, an inner one rising
  ease-out and falling ease-in — with NO `scale` (the pixel-font rule) and a fixed
  `rotate` tilt. **The throw is ROLLED per hit** (user-decided 2026-08-10): which side
  each piece takes (sometimes the exponent flies left, sometimes the grade does — always
  opposite sides), which launches first, and a bounded jitter on each piece's distance,
  height, drop and tilt (`--loot-j*` factors from `WordLoot`, multiplied into the CSS
  geometry — never pixel values, so the ≤640px step-down keeps working; the jitter ceiling
  is part of the 320px overflow sum commented in index.css). The pieces are EDGE-anchored
  (a piece's whole box stays on its own side of its anchor), so they cannot overlap
  whichever way the dice land — centred anchors measurably put `-5` on top of `ARCANE`
  for the first half of the flight. Timing is handed from `WordLoot` to CSS as variables
  (the `--slash-ms` rule); base geometry is per piece in CSS with a ≤640px step-down. The loot always outlives every sheet, so ITS
  timer is what reports a claim's hit done (`hitDurationMs` = max of strike and loot, and
  the ending's hold covers it); under reduced motion the global collapse leaves each piece
  resting at its apex for the fall's kept delay — shown, held, gone, the floating numbers'
  own degradation, no dedicated rule. **The strike ESCALATES IN THREE GESTURES across the
  five grades** (user-decided 2026-08-11, retiring the RARE cross — RARE now takes the same
  single cut as COMMON/UNCOMMON), all three sheets in `assets/hits/`, all walked at one 50ms
  frame rate: a CUT (`slash.png` — COMMON, UNCOMMON, RARE), a BURST (`burst.png` — OBSCURE)
  and the ULTRA star (`ultra-slash.png` — ARCANE). The same escalation the seconds ladder
  makes, said in gestures instead of five sizes.
  **The ladder is a TABLE indexed by grade** (`STRIKES`, `components/rarity.ts`, now mapping
  a grade straight to its sheet) — the shape `RARITY_COLORS` already has, complete by type.
  **What escalates is the EVENT, not the duration.** The burst is a step UP from the cut and
  the ultra a step up again. Reading intensity off a clock would rank the ladder backwards,
  so `rarity.test.ts` weighs a strike by its sheet's place in `STRIKE_ARTS`, whose ORDER is
  what says which sheet is bigger.
  **Two sheets are masks and one is an image, which is a property of the ART, not a
  preference.** `slash.png` and `burst.png` are pure white, so they are painted through a CSS
  mask in the grade's colour — the header globe's technique, and the reason one sheet serves
  several grades. `ultra-slash.png` is authored IN COLOUR (seven fully opaque palette entries),
  so it is drawn as an ordinary background image and ignores the grade: masking it would
  flatten all seven into one flat colour, which is most of what the art is. It therefore also
  needs its own frame-walk keyframes (`ultra-frames`, over `background-position`, where the
  masked pair walk `mask-position`).
  **Each sheet's geometry is MEASURED off its own ink**, at the app's exact integer scales
  (5x, 4x at ≤640px), and the numbers differ because the art does:
  - stroke 36x46 → 180x230 / 144x184, dropped 44px / 35px (its ink is top-weighted);
  - burst 53x66 → 265x330 / 212x264, dropped 20px / 16px (its impact ink — frames 1–3, 90% of
    it — centres at 44% of the frame's height, so a box centred on the word sits a touch high);
  - ultra 71x66 → 355x330 / 284x264, NOT dropped at all (centroid y=33 of 66, dead centre).
  Every offset is a whole pixel at both scales, for the reason the stroke's is: half a pixel of
  offset is half a pixel of resampling on a sprite whose whole point is hard edges. Verified no
  page overflow at 320px, where the widest of them spans x 18..302.
  **Under reduced motion each sheet holds ONE frame**, and the ultra needs **its own
  `animation: none`** rather than the stroke's: the base `.word-slash.ultra` declares the walk
  at a higher specificity, so it won, the global rule collapsed its duration to nothing, and
  the sheet landed on its LAST, near-empty frame with a `both` fill (measured:
  `background-position: 100% 0%`, an ARCANE find showing almost nothing). It holds its THIRD
  frame — frame 1 is the impact flash, a solid white disc that covers the word completely,
  right for 50ms and wrong to park on. The masked pair hold their second, which is the fullest
  frame of both.
  A miss shows the SENTENCE game's `FloatingHit`, unparameterised — the same MISS, the same
  red, the same pop and rise it has everywhere else — and **the word does not move**, because
  nothing was struck, so nothing recoils.
  **Three things about how the strike is drawn**, each of which was a decision:
  it is a MASK, not an image — the sheet is pure white, so painting `currentColor` through it
  gives one sheet in five grade colours (the header globe's technique, for the same reason);
  it is at an EXACT INTEGER SCALE (the stroke 5x = 180x230 desktop, 4x at ≤640px), the app's
  standing pixel-art rule, **and it takes `image-rendering: pixelated` WITH it** — an earlier note here
  claimed the integer scale made nearest sampling unnecessary, which is wrong: bilinear blends
  neighbouring texels wherever a destination pixel misses a texel CENTRE, which at 5x is four
  pixels in five. Measured on the rendered output, 51.5% of the ink was partial (a soft ring
  round every edge) against 7.5% with `pixelated`. The whole-pixel `translate` is the other
  half of the same point: a percentage drop resolved to -71.3px, and half a pixel of offset is
  half a pixel of resampling on a sprite whose entire point is hard edges. That also makes the
  SCALE the one dimension this can be tuned in, in whole steps and no others, and it is why
  the size is FIXED rather than sized off the word (whose own type is a `clamp()` landing on
  fractions, and a strike is an impact, not a property of what it hits);
  and it is DROPPED 19% of its own height below the word's centre, which is a property of the
  ART and was measured — the sheet's ink is top-weighted and only the first two frames carry
  real ink, so a box centred on the word puts the strike above it.
  Two smaller mechanics worth keeping: the frame walk is `steps(<the sheet's frames>,
  jump-none)` over `mask-position` (or `background-position`) 0→100%, which lands exactly on the five frames with no sixth position past
  the end (where the LOOPING `.cal-ripple` needs its `n/(n-1)` overshoot instead); and the strike is
  INVISIBLE unless an animation is actively running on it — base `opacity: 0`, lifted for
  exactly the frame walk's length by a `slash-show` animation carrying NO fill. That one rule
  buys both ends: a waiting second blow is not sitting on frame 1 in plain sight, and the
  FIFTH frame gets its own 50ms and leaves like every other one instead of holding until
  React unmounts the element (which, for the first of two blows, meant it hung on screen
  through the whole of the second). Under reduced motion the walk would collapse to nothing, which for a sprite sheet
  means the strike never appears at all, so a dedicated rule holds ONE frame instead.
  The shake is the shared `word-shake` — the sentence hole's, this word's AND the standings
  sprite's, at one amplitude — and this surface hands down only its LENGTH (`--shake-ms` =
  `STRUCK_MS`), so the JS that ends the recoil and the CSS that draws it cannot disagree.
  **What the strike REPLACED, and what that cost, is worth keeping**: a RARITY LABEL, the
  grade's name stamped onto the word (`RarityHit`, deleted with it). Several choreographies
  were built on that label and every one was rejected — a pop, a stamp falling onto the word,
  a shockwave through the letters — and two rules were learned expensively enough to record
  wherever type lands on type again: NOTHING IN THIS APP OUTLINES TYPE (a knockout ring to
  separate the label from the word read as a cheap sticker), and ANIMATING `scale` ON THE
  PIXEL FONT renders blurry intermediate frames for the whole transition, the same reason
  every sprite here takes an exact integer scale.
  Three things learned on the way, kept because they cost real iterations and the next attempt
  should not pay for them again:
  - **NOTHING IN THIS APP OUTLINES TYPE.** A hard knockout ring was added to separate the
    label from the word beneath it and rejected on sight — it is not the artistic direction,
    and it read as a cheap sticker.
  - **ANIMATING `scale` ON THE PIXEL FONT is not available.** It renders blurry intermediate
    frames for the whole transition, the same reason every sprite here takes an exact integer
    scale. Rotation is nearly as bad past a few degrees.
  - **The word must step back for the label to be readable at all.** They occupy the same
    place, and two words of the same size superimposed are mud whatever their hue — a cyan
    RARE over the blue day's word measures 77 dE apart and is illegible. `word-dim` (0.2,
    measured against 0.45 and 0.32, both mud) is therefore load-bearing rather than
    decorative, and it is a plain STATE with no transition on it.
  What is left of the intensity table is what a grade IS on screen rather than how it moves:
  `scale` and `holdMs`, both monotonic across the ladder and both pinned by `rarity.test.ts`.
  **The ladder is tuned AGAINST THE WORD**: the label sits on a word `fitWord` draws at up to
  40px and is a badge on it, so it stays clearly smaller — desktop 18→30px, mobile 14→24px.
  Two earlier cuts overshot in both directions: one so small the grades barely differed, one
  where ARCANE matched the word and swallowed it.
  Everything the animations borrowed has been handed back: `word-shake`, `hole-wave` and
  `FloatingHit` are byte-identical to what they were before #163, so the sentence board, the
  tutorial and the standings sprite are untouched by any of it.
  **The run's screen carries NO READOUTS AT ALL** (decided 2026-08-10, removing the last of
  them). It briefly had two, bracketing the prompt — a guess HISTORY above it and a per-grade
  `found/total` TALLY below — and both are gone, along with `WordHistory`, `WordTally`,
  `srWordTally`, `tallyRarity`, `zoneGroups`, `RarityTally` and their CSS: nothing else
  consumed any of it, and the standing rule is to remove an obsolete path rather than keep it
  for a use nobody has asked for. What is left during a run is the word, its score watermark,
  the clock, the prompt and the keys.
  **Know the one thing that went with them.** The history was where the RANK lived: the float
  carries a claim's GRADE and not its distance, on the reasoning that a timed run cannot act on
  a number, and the log was the answer to "how close was that one?" a moment later. Since
  2026-08-10 the LOOT answers it in the moment itself — the rank and the grade's name fly off
  the word for under a second (see the strike bullet above) — and the post-mortem board is
  still the only place it can be READ BACK later, drawing every claim at its real rank once
  the clock dies. The screen stays bare between guesses, which was the point of the removal.
  Two of the tally's findings are worth keeping in case a census ever returns: it counted a
  group by its RANK, once, however many aliases key it (the identity `wordGuessKey` uses), and
  it DROPPED a grade the day's zone does not contain rather than showing `0/0`, because an
  English board often has no ARCANE group at all and a permanent `0/0` reads as a goal being
  failed rather than one the day never offered.
  **The PROMPT is exactly as wide as the KEYBOARD's row of keys and sits on its left edge**
  (`--play-w` on `.word-footer-play`, decided 2026-08-09). It used to take the BOARD's column
  instead (430 + the scroller's side + its scrollbar = 456), which on a desktop left it a few
  dozen pixels narrower than the keys under it — ALMOST aligned, which reads worse than either
  aligned or plainly not. The row is not the keyboard's BOX either: `.keyboard` is capped at
  680px but its keys are capped at 46px each, so ten of them plus nine gaps come to 514px and
  centre inside that box. The column therefore recomputes the row from `--kb-gap`/`--kb-key-max`,
  which live on `:root` for exactly this reason — the row width is not only the keyboard's
  business — and it follows the keyboard's full-bleed shift on a phone, or the prompt sits 10px
  inboard of the Q key it answers. Verified equal to the real key extents at
  320/430/700/900/1200/1400. The board's own window keeps the 456 column: it draws a 430px
  line, and it is never on screen at the same time as the prompt.
  **All three of the prompt's seams are now the WIDE one** (`.word-footer-play`'s gap widened
  2026-08-10 from `clamp(6px, 1vh, 12px)`, which measured 7–9px, to the
  `clamp(16px, 2.4vh, 24px)` it already had above and inside it — measured 17/19/21px at
  320/430/1280). The tight seam was chosen when this footer stacked FOUR things and had to keep
  them from sprawling; it stacks two, and the prompt is what the player acts through, so it
  takes the room. It opens the GATE's rules→PLAY seam by the same amount, which that screen
  wants for the same reason.
  **The word stays centred in what is left between the HEADER and the PROMPT**, with its score
  watermark, and lands within 9px of that centre at every width (measured 6/7/9 at
  320/430/1280). That survived both removals because the history hung OUT OF FLOW to begin
  with — `.word-readouts` was absolute, so it never took height off the window above it. The
  reason it hung there is worth keeping for the next thing that wants a place on this screen:
  everything the player ACTS THROUGH is in flow and owns its space, and a log of what has
  already happened is not a control. Both extremes were built and rejected on sight — in flow
  the history pushed the window's centre up with it and the word read as TOP-ALIGNED (measured
  126px high); given the whole band down to the KEYBOARD the word read as TOO LOW.
  **The rarity COLOURS are copies of existing ramp stops, measured, and pinned**
  (`components/rarity.ts` + `rarity.test.ts`, mirroring `LANE_COLORS`/`laneColors.test.ts`):
  `--muted` / progress-green / progress-cyan / heat-electric-violet / progress-pink, minimum
  pairwise 36.99 dE. **RED IS RESERVED FOR MISS** — every grade clears 37+ dE from `--danger`,
  wider than the lane set's own shipped 36.9, and the two can never co-occur anyway. Three
  candidates were measured and REJECTED, and the reasons are worth keeping: progress-violet
  is the intuitive "deep" pick for OBSCURE and FAILS legibility at 3.64:1 on `--bg` (indigo
  at 3.00:1), gold-for-ARCANE IS `--hole` — which is the `+Ns` gain firing in the same beat —
  and progress-blue for RARE sits 14.75 dE from `--accent`, the colour of the word the label
  is drawn on top of.
  **The `WORD_END_HOLD_MS` beat is a FLOOR, not a length** (2026-08-08): a rarer grade holds
  longer, so an ARCANE landing on the buzzer outlives the old static 840ms by nearly a
  second. The screen tracks when the live float actually ends and waits for the later of the
  two, or the run's best moment gets cut off mid-air to make room for the board. The gain sits UNDER the clock,
  not beside it: measured at 320px, a `+5s` to the right of a two-digit number runs 15px
  into the header's icon group, where below it has the empty top of the play area to itself
  at every width (and a gain only ever plays during a run, where the word is centred far
  below). The clock is `--fg`, goes `--danger` + a 1s pulse under
  `WARN_SECONDS` (**20**, not the 10 this line claimed until 2026-08-11 — the code is
  ground truth and `WordTimer` has read 20 throughout), and
  at ZERO goes `.spent` — red but STILL, because an alarm about time running out has nothing
  left to say once it has, and it would otherwise beat under the whole result screen. No
  heat/progress ramp is borrowed for it: those two mean DISTANCE and PROGRESS, and a clock
  is neither. `role="timer"` is a live region defaulting to OFF, which is the point — the
  number must be readable on demand and never announced every second; the run's END is
  announced once (`srWordTimeUp`), on the transition only.
  **The board is the END SCREEN's reward, and the word never moves to get there.** The
  `.word-window` is `justify-content: center`, which puts the word in the middle of the
  screen while it is alone there and needs no phase class to stop doing so: once
  `.word-cut` mounts it is `flex: 1 1 0` and eats every spare pixel, leaving the word
  pinned to the window's bottom edge with the line running down into it. So the reveal moves
  the FIELD in around a word that stays put. Nothing was rebuilt for this — `WordBoard` /
  `routeDrawing` / the censored census / the torn edges / the MISSED shelf are the same
  components, mounted at a different moment — and the whole claim-scroll animation the
  screen used to run (`SCROLL_MIN_MS`/`SCROLL_MAX_MS`/`SCROLL_PX_PER_MS`, the focused rank,
  the rAF loop) is GONE with the live board: there is no station to scroll onto during a run
  any more. The ending keeps its BEAT structure, adapted to "the clock hits zero": the
  killing moment plays out on the surface the player was looking at (`WORD_END_HOLD_MS` =
  the hit's own intro + fade), then the field arrives and the prompt leaves
  (`WORD_END_SETTLE_MS`), then the keyboard drops and the result rises. A rehydrated ended
  round seeds every beat settled, and reduced motion zeroes the JS-timer holds.
  **The drawing itself is `components/routeDrawing`** (extracted 2026-08-06, superseding
  "the board imports RouteModal's exported geometry helpers"): the geometry, the frame
  variables, the shelf, the tail, the connector rule, the junctions and the station ROW are
  one module belonging to neither surface. Importing half a component's internals is not
  sharing it — the modal ended up owning a vocabulary it only half-uses while the board
  re-implemented everything it had not imported, which is how the two came to hold separate
  copies of the same shelf, tail, row markup and CSS-variable block. A detail of the line
  changed in that module now changes it on EVERY route the app draws, which is the rule:
  there is ONE routes component, never a second version of it. What each surface keeps is
  what is genuinely its own — the modal's sticky "you are here" plumbing, the board's
  censored field, claim reveal and pinned terminus footer, and their two screen-reader
  mirrors. (The ONE CSS
  difference stays: `.word-frame` re-derives `--wordw` minus the app's page inset, since the
  board lives in the page rather than a full-bleed dialog.)
  **The TERMINUS is the board's PINNED FOOTER, not a sticky row** (decided 2026-08-06). Its
  other half — "and every counted guess lands its hit ON it", and "never leaves the screen" —
  was retired by #163: the board is the post-mortem, so this row is only ever on screen when
  no guess can land, and the run's word is `WordSubject`'s instead. The day's word is
  the whole game, so its row (`WordBoard.WordTerminus`) lives OUTSIDE the scroller, pinned
  under the window as the board's own footer: nothing ever scrolls behind it, so it needs no
  masking background at all. A sticky in-scroller row wearing the route map's "you are here"
  mechanics was BUILT FIRST the same day and rejected on sight ("remove this ugly black
  background"): the parked row needs an opaque `--bg` box to float over the line, which the
  modal gets away with only because its dialog is flat `--bg` — on this page it stamps a
  black patch over the animated-waves backdrop, which no CSS background can reproduce (it is
  a canvas). The footer re-derives the same `routeFrameVars` from the same model and pads for
  the scroller's right side + its 6px pixel scrollbar (`.word-terminus`), so its grid lands on
  the line's columns to the pixel; `.word-frame .route` dropped its bottom padding so, scrolled
  to the bottom, the merge's last link runs out of the scroller straight into the terminus's
  own rail. The TORN EDGES moved onto a new `.word-cut` box between the window and the
  scroller: the footer is the window's last child, and a tear on the window's own bottom edge
  would draw UNDER it — on the cut, the bottom rule lands exactly on the footer's top edge,
  where the terminus's rail stub runs into it, so a line severed mid-field wears the modal's
  parked-separator reading for free. **While torn, the content stops 8px SHORT of that rule**
  (decided 2026-08-07): the modal's separator sits in a `--stick-inset` clearance, so this one
  does too — via a MASK on the scroller (`.word-cut.more-down .word-scroll`), never a painted
  strip (a strip is a box over the waves again), and only while torn, since at the true bottom
  the merge link must run flush into the terminus's rail.
  The HIT is the sentence game's own feedback grammar on the word that is always visible —
  but since #163 it lands on `WordSubject`'s bare centred word, NOT on this row, which by
  then is not on screen: a guess and the post-mortem board never coexist. Every counted
  guess floats its rarity GRADE (or MISS) plus the word's shake; free guesses (repeats,
  invalid words, the day's word itself) land nothing, exactly as they float nothing in the
  sentence game. A single target means a single hit: no stagger, and the lone-hit fade delay
  (`FLOATING_HIT_INTRO_MS`) plus whatever hold the grade buys. The hit state is `WordGame`'s.
  **Only a CLAIM scrambles its station** (decided 2026-08-06): the slot-machine reveal is the
  beat that says "you found this", and the run's END reveals the whole ~150-row field at once
  — 150 scrambles starting in one frame, each its own 40ms interval writing state for 650ms —
  for a moment that is not a find at all but the post-mortem naming what was always there.
  Those land outright (`StationWord`'s `animate`); the initial
  target is likewise seeded settled, so a rehydrated round replays nothing.
  The reveal beat rides `buildWordBoard`'s optional `reveal` — presentation pacing only,
  which is why it is a parameter and not something the model derives: since #163 the run's
  END is the deadline's fact, and the board is not on screen at all until this beat says so
  (see the three-phase bullet above for the beat order).
  **RARITY IS SAID IN THE WORD'S COLOUR, ON ONE TRUNK — the sentence route's exact drawing**
  (user-decided 2026-08-11, superseding 2026-08-10's grade-per-lane fork; the grades had
  replaced the artifact's semantic roads that day). Every zone station's word is painted in
  its grade's own `RARITY_COLORS` colour (`--rarity-c`, set per station by WordBoard) — the
  same colour the strike and the loot wore when the claim landed — where the sentence line
  paints its stops gold; the drawing itself is the history line's: `routeFrameVars(1, …)`,
  no junctions, no lane rails, the same `LEAP_H` (56) solid run into the terminus (the old
  junction-aware `TEASER_MERGE_RUN`/`JX_STUB` arithmetic went with the fork), the same
  shared `--word-gap` and 48px shelf air (both promoted to the shared drawing on user
  review — "the gaps and sizings are not the same" — 2026-08-11), the terminus as
  `RouteWord` in `route-found`'s solved BLUE (the colour rule is keyed on the `graded`
  class per zone station, not on every station, exactly so the arrival's blue survives —
  an unkeyed first cut painted the day's word `--fg`). The
  post-mortem still answers *where were the expensive words?* — in the type now, the way
  the sentence map says its zones. A station is NEVER colourless (COMMON is `rarityOf`'s
  floor); what stays `--fg` on the trunk is the near misses, which belong to no grade.
  `WordBoardModel` is UNCHANGED — it still grades every station and ships `grades` (ladder
  order, only the grades the field holds), whose consumer is now the sr census:
  `srWordRarities` states the field per grade and a named stop carries its grade
  (`srRouteStop`'s `rarity`), the word's colour said in words; grade names stay
  untranslated there as everywhere else. NOTE: this leaves `routeDrawing`'s whole lane
  machinery (`Junction`, `laneX`, `laneColor`, `RouteRow`'s `onLane`, `RouteLink`'s
  `lanes`, `LANE_COLORS` + `laneColors.test.ts`, the junction CSS) with NO consumer
  anywhere — kept only because root `AGENTS.md` Discrepancy #4 (whether sentence roads
  ever return) is still the user's open call.
  **The whole FIELD is drawn, censored until it is claimed** (decided 2026-08-05, restoring
  the `???` census after a day without it — the sparse variant that drew only found words
  and dashed the ground between them is gone, `.route-link.dashed` with it): every group of
  the claimable zone is a station wearing the route map's fixed-width `???`, so the line
  shows its real length and population — the one thing a list of your own words can never
  say — and a claim lands ON a stop that was already there rather than appearing out of
  nothing. The run's end reveals every word and turns the board into the post-mortem, where
  a group merely NAMED keeps the small node and the dimmed word that tell it from one you
  found (`route-unknown route-revealed`, the map's own distinction).
  **The TAIL is the board's only broken run** (same decision): dashes mean "the line
  continues into words with no distance at all", which is true at the cold top end and
  nowhere else here — every rank between two stations is itself a station, so no connector
  hides ground. Consecutive ranks are one row apart (`LINK_MIN`) and only the sparse trunk
  between far strikes keeps a proportional length, exactly as on the map. The line's final
  run into the word is SOLID at the sentence line's own `LEAP_H` (2026-08-11, superseding
  the teaser-distance arithmetic the forked board needed — with the lanes gone the two
  drawings share their arrival too). The rank gutter fits the farthest row drawn,
  which with the whole field on the line is the field's own outer edge until a near strike
  lands beyond it.
  **The window wears the teaser's TORN EDGES** (decided 2026-08-05): the line outruns the
  screen as soon as a few claims land, and an edge that simply ends reads as the end of the
  map, so whichever side still has line beyond it gets the 9px-on/9px-off rule — the same
  vocabulary as the route map's parked separator. That needs the
  board to be TWO boxes (`.word-window` around `.word-scroll`), because a pseudo-element
  inside a scroller scrolls away with the content, and — since a rule spans its WINDOW —
  that window is capped at the line's own width (`430 + 20 + 6`: the drawing, the scroller's
  ONE side, the pixel scrollbar) and centred, with the PROMPT sharing the column. Uncapped it
  was the whole 1200px page column on a desktop while the line inside it was 430, so the
  tears ran nearly three times the width of what they were tearing and the prompt answered
  from a third of a screen away. Both caps are no-ops on a phone.
  **The scroller's LEFT side is 0** (decided 2026-08-06, superseding a symmetric `0 20px`):
  the drawing is a left-aligned block — the rank gutter opens it and the words run off to the
  right — so an inset there only held the whole board 20px in from the prompt beneath it and
  from the torn rules that bracket it, and it read as a box floating inside the page instead
  of as the page's own content. The board's left edge, the prompt's and the window's are now
  one line at every width. The RIGHT side keeps its 20px — that is the clearance the pixel
  scrollbar needs off the words. Three numbers move together with it and are the thing to
  re-check if it changes again: the window/prompt cap above, `.word-frame`'s `--wordw`, and
  `--promptw` (456, not 476). Verified after the change: all 156 words of a fully revealed
  field fit on one line at 320/360/390/430/900, none wrapping mid-word. **In HEIGHT it is the
  opposite — the window takes everything left over** (decided 2026-08-05): on the end screen
  the board IS this screen, and every row of the line the player can see is a road's length
  made visible, where the space around it says nothing. So `.game.word-game` cuts its own
  chrome — the HUD's row reserved with 48px rather than 76 (clearing the fixed header while
  balancing its screen-top inset against the gap before the board), and the seams below it:
  the PROMPT is what the player acts through, so it takes the room on BOTH of its sides
  (`.game.word-game` above it, `.input-area.word-prompt` below) rather than reading as one
  more band in a stack. (The third seam this rule used to describe was the cross row's tight
  gap against the keyboard; that row went with the strikes in #163, and the prompt now sits
  directly on the tray.) Measured with the earlier even seams: 53% of the viewport → 59% at
  1440×900, and 45% → 52% on a 700px-tall one, which is where it mattered — the prompt bought
  its room from the board, on purpose.
  **ONE prompt for BOTH games, at a flat 24px, and a long guess CROPS ITS OWN HEAD**
  (decided 2026-08-06). `WordInput` is a single control doing the same job on both screens, so
  it has one size and one behaviour: `.word-input` is 24px everywhere, and the sentence game's
  own smaller `clamp(13px, 4.2vw, 19px)` — which it shared with `.phrase` on mobile so the
  input MIRRORED the sentence — no longer applies to it (that rule is `.phrase` alone now).
  24px was walked DOWN to: 40 dominated the screen the BOARD is supposed to own, 28 was still
  a touch heavy. Note the consequence on the sentence screen — the prompt is now LARGER than
  the phrase it answers, inverting the old "input is a footnote to the phrase" hierarchy.
  **When a guess outruns its column the TEXT crops at the head**, not the size: the letters
  just typed and the caret hold their place at full size and the beginning slides off the
  left, a terminal's behaviour. `.wi-text` is a `justify-content: flex-end` flex window with
  `overflow: hidden` around a `.wi-text-run` holding the whole string — pinning the run to the
  window's right edge is what puts the spill on the LEFT. The nesting is required: one element
  cannot both clip and overflow its own start. The value stays whole in the DOM, so a reader
  still gets the real guess.
  Two `min-width: 0`s are load-bearing and were each found by a real overflow: on `.wi-text`
  (a flex item will not shrink below its content without it, so the window grows instead of
  cropping) and on `.input-area` (a GRID item of `.prompt-zone`, whose default `min-width:
  auto` let it inflate to its content — so `max-width: 100%` on the input resolved against the
  grown width, never bit, and the sentence prompt pushed the whole page sideways).
  This replaced a shrink-to-fit (`promptFontSize` / `--promptw`, both deleted) that divided
  the column by the glyph count: it kept every letter, but rendered fr's longest word
  (`anticonstitutionnellement`) at ~10px and resized the whole line on almost every keystroke.
  Both approaches fixed the same original bug — at the old fixed size the prompt simply ran
  off the page from about 16 letters on, pushing the document to 508px on a 320px screen.
  (Unrelated latent bug found while measuring, deliberately NOT fixed: `.word-input`'s
  `padding` shorthand computes to 0 because `calc(4px + var(--text-shift))` adds a UNITLESS
  zero, which is invalid in calc and voids the whole shorthand. It has always been 0;
  restoring it would push the prompt 8px off the page's left edge, which is exactly the
  alignment the board was just given.) The sentence screen keeps its generous rhythm untouched — there the phrase is the
  content and the air around it is what makes it legible — which is why every one of these is
  scoped to `.word-game`. The rules live on the shared
  `.scroll-torn` utility (beside `.pixel-scroll`) with `hooks/useScrollEdges` behind them —
  BOTH shared with the onboarding teaser, which was refactored onto them rather than
  leaving two copies of the slack/bail-out/resize details to drift. `WordGame` re-reads the
  edges when the MODEL changes too: a claim adds rows and the run's end reveals the whole
  field, neither of which fires a scroll event.
  **The board no longer SCROLLS ITSELF at all** (#163, 2026-08-08). It arrives already
  parked at its bottom, on the terminus, and stays where the player puts it. The two
  decisions that used to govern the live board are RETIRED with the board's live phase, not
  reversed — recorded because the reasoning still applies to any future live route surface:
  *only a CLAIM moved the board* (2026-08-06; a miss scrolling out to its own trunk row
  carried the player AWAY from the field they were working on, as the answer to a FAILURE,
  and the floating rank already reported it without moving the ground — verified by measuring
  a LANDMARK ROW's on-screen position rather than `scrollTop`, since inserting a row above
  the view makes the browser's scroll anchoring bump `scrollTop` by that row's height
  precisely IN ORDER TO hold the content still), and *the move ran on the APP's clock*
  (2026-08-05; `scrollIntoView({ behavior: 'smooth' })` times itself by the DISTANCE
  travelled, so a claim at the far edge of a ~150-row field crawled for the better part of a
  second while the next guess was already typeable). `SCROLL_MIN_MS`/`SCROLL_MAX_MS`/
  `SCROLL_PX_PER_MS`, the focused rank and the rAF loop are all gone. The end screen
  (`components/WordEndScreen.tsx`) is the named `<n> WORDS/MOTS` count + SHARE via the
  v5 word token — which carries the claims PER RARITY GRADE, ladder order; the screen
  takes that breakdown (`counts`, computed by `WordGame` from the one replay) and DERIVES
  the count as its sum, so the tally, the text, the token and the card speak one set of
  numbers (decided 2026-08-11, superseding the v4 single-score token); **the score OG card
  draws the accented display word ALONE in solved blue — centred, NO node square
  (user-decided 2026-08-11, superseding the 2026-08-08 terminus lockup: the in-game square
  marks the end of a LINE and this card draws none, so it was a station badge with nothing
  to be a station of; the colour already says the word is the target, and the freed column
  sets a 25-letter word at 40px where the lockup left it 36) — above the count, the rarity
  CHIP ROW (one grade-coloured square + count per claimed grade, commonest first, zero
  grades omitted) and the date** (chip row 2026-08-11; the token carries the display word
  and the breakdown so the preview is self-contained).
  **The plain share text stacks the localized headline, a blank line, the RESULT BLOCK —
  `<DISPLAY WORD IN LOCALE-AWARE UPPERCASE>` on its own line with the rarity BEAD ROW
  directly under it, `⚪7 🟢3 🔵1 🟣1 🩷1` — a blank line, then the URL** (word line
  2026-08-08, bead row 2026-08-11; accents stay display accents, never a slug). **The word
  carries NO leading emoji** (user-decided 2026-08-11, dropping the 🟦 with the card's
  square): uppercase on its own line already sets it apart, and a bullet on the one line
  that is not a list reads as a stray. The beads are ONE SHAPE — circles — so the row reads
  as five steps of one thing; the pink heart is the lone exception, since Unicode has no
  pink circle and red stays MISS's. **The composition lives in `game/share.ts`
  (`wordShareText`/`wordShareUrl`/`rarityRow`/`RARITY_EMOJI`), NOT in the component**: this
  module is where a result becomes the text and link it travels as, for BOTH modes, and the
  bead row is the exact analogue of the sentence `emojiRow` beside it. The screen owns only
  the localized headline. That is also what lets `share.test.ts` assert the visit card's
  exact string, and what lets preview tooling render the REAL message instead of a copy that
  can drift (it did, the first time). A grade's SCREEN presentation stays in
  `components/rarity.ts`; `game/` must not import from `components/` (the dependency runs
  the other way).
  Its tally ends on a one-shot scale pop (`score-land`, 2026-08-07) — the
  count is this screen's LAST beat, with no ruler colorize following it as in the sentence
  tray, so the number marks its own landing (never at 0, never on rehydration, collapsed
  under reduced motion). Identity is mode-addressed everywhere: `roundKeyForDay(day, lang,
  'word')` = `w:` keys into the store's own `wordRounds` map (persist **v8** since the
  sentence gate flag, 2026-08-11; the word rounds' own shape is v7's, #163;
  `ensureWordRound` resets on a republished different word), `lastMode` decides where `/` lands (like
  `lastLang`; the header's Whippin mark opening the mode CHOOSER is the deliberate switch —
  see the chooser bullet) — but **only a LOADED artifact records it** (2026-08-06): unlike a
  language, a mode can be genuinely absent, since word artifacts are published per day and
  past days are not backfilled. Written on arrival instead, one tap of the toggle on a day
  with no word artifact pinned every later visit to a route showing NO PUZZLE TODAY and
  nothing else. Arrival lands where you last PLAYED, and a 404 is not play.
  **The store's v6 → v7 migration DROPS every pre-clock word round** (#163, the standing
  no-back-compat rule): a v6 round recorded a strike run — three consecutive misses, no
  clock — and there is no honest clock to invent for it. Nothing else moves: sentence
  rounds, solved days and the mode preference all survive, because the retiming touched
  none of them.
  The archive/selector read word statuses via `wordStatusOf`, which takes `now` and reads
  the round's own DEADLINE — never a stored flag, so a tab closed mid-run comes back to a
  finished day (past deadline = done-for-the-day gold; live = claimed/zone %; not yet
  started = nothing, since a fetched day still at its rules gate has not been played).
  **A finished word run is DONE, not SOLVED** (decided 2026-08-08): `Status` carries both
  kinds, they render as the SAME gold, and only the spoken status distinguishes them
  (`srWordDone`, en "done" / fr « terminé ») — a timed-out run is finished, and calling it
  solved would claim an achievement this mode does not have. The visual surfaces read
  `isComplete(status)` so the strip (`Chooser`) and the calendar cell (`Archive`) do not
  each restate the pair. Word runs never touch the streak, fire no new analytics events,
  and have no benchmark opponents — and since #163 they never will, by decision (see the
  no-bots note in the Word mode bullet).
- **Hole HISTORY modal (user-decided 2026-08-10, REPLACING the #117 route map):** tapping a
  HOLE opens the round's own journey toward that hole's secret — the player's guesses as
  stops on ONE line walking down to the hidden word. What the user retired is everything
  that made the map unreadable and never helped anyone: the semantic road LANES, the
  censored census of every unfound group, and the sticky "you are here" machinery. What
  SURVIVED it — restored on review the same day, after a first cut as a flat sorted list
  proved legible but empty ("no starting word, you had to read the exponents to infer the
  order, no notion of reaching an unknown target") — is the map's SPINE: the journey
  reading is the value, the roads were the noise. `game/history.ts` is the pure model
  (`buildHistory`, contract-tested) and `components/HistoryModal.tsx` composes it out of
  the shared `routeDrawing` parts, trunk only (`routeFrameVars(1, …)` — no junctions, no
  lane colours).
  **The line, top to bottom:** the MISSED shelf (off-map guesses, try order), the broken
  tail out of the void, every ranked try as a stop FARTHEST FIRST with connector lengths
  carrying the real `dq` distances (uniform `LINK_MIN` fallback on pre-#115 data — the
  modal degrades instead of refusing, so the old `hasRoute` gate stays dead), then the
  solid leap into the terminus: the fixed-width `???` while the hole is open, the accented
  secret in solved blue once found. "You are here" keeps its gold node — read off the
  HOLE's rank, never inferred from the log (the map's rule, kept for the map's reason: a
  deduped guess can improve a hole without entering `tried`) — but the row no longer
  sticks: the line is one screen in the common case, and the whole WebKit sticky-subgrid
  workaround died with the map. Stops
  show the form the player TYPED wherever a typed form reached them (canonical only for
  the departure and an untyped "you are here"); rank 0 is never a stop — the solving guess
  IS the terminus. It opens scrolled to the line's END; a line shorter than the screen
  centres via auto margins on `.history-frame` inside the flex scroller (never
  `justify-content: center`, which would clip a long line's head). An untouched hole is
  already a meaningful view: the departure, the line, the `???` — the journey laid out
  before anything is played, so there is no empty-state copy at all.
  **SOLVING turns the line into the real POST-MORTEM: it NAMES the whole walked stretch**
  (user-decided 2026-08-10) — every group from the secret out to the departure, including
  the ones the player never reached (`HistoryStop.revealed`). Only that stretch: what lies
  BEHIND the departure was never on the way, so nothing there is named that they did not
  type themselves. A named group takes the app's own "named, not found" dress — the word
  board's own distinction — dimmed word (the census's 0.55) and a small muted node, and it
  keeps the walk's GOLD, so what the player actually HELD reads at full strength straight
  out of a field that was there all along. They are named with the group's CANONICAL form:
  nobody typed them, so there is no typed form to prefer. This is what the retired route
  map's censored census was for, kept only where it earns its keep — the round is over, so
  there is nothing left to leak — and it costs one walk of the alias-expanded map, cached
  per rank map in `nearField` (which the departure and "you" now read from too, so an
  unsolved open pays ONE pass where it used to pay two partial scans).
  **THREE KINDS OF GUESS, told apart by the LINE itself — in COLOUR, never by reading
  numbers** (user-asked polish, 2026-08-10, colour-coded on a second pass the same day:
  brightness alone was "still not very obvious at first sight"; the final palette is the
  user's own third pass): a stop FARTHER than the departure is `behind`
  (`HistoryStop.behind`, model-derived — the journey runs departure → word, the doctrine
  the road zone was cut by) and goes GREY — word at the census's own 0.55, small muted
  node — with the CONNECTORS entering it (and entering the departure from behind
  territory) staying the broken trace (`RouteLink broken`, heights `dashedRun`-snapped by
  the caller). **From the departure down — the START WORD INCLUDED — the WORDS are GOLD**
  (`--hole` — the sentence game's own grammar carried over: gold is the colour of the
  words the player HOLDS, and every stop from the departure on is one of them;
  `route-ahead`/`route-you` — the zone classes are EXCLUSIVE per stop, HistoryModal picks
  one, so each zone owns its colour outright), the nodes staying the found stop's plain
  `--fg`. **The DEPARTURE has NO station state of its own** (user-decided 2026-08-10,
  superseding its muted node + 0.62 dim, and `route-departure` is deleted with the rule):
  it renders EXACTLY as a valid guess does, because it is a word the player holds like any
  other, and singling it out made the line's quietest stop out of the one it begins at.
  What still says "the walk starts here" is structural and needs no per-stop dress — the
  broken trace ends AT it, and everything above it is grey — so `HistoryStop.start`
  survives in the MODEL alone, where the sr mirror and the dashed-connector boundary read
  it. The CURRENT word alone gets the big gold square, its word in the same gold — the
  hole as it looks in the sentence, transplanted onto the line. **The RAIL keeps its own `--rail` everywhere** (a green
  journey stretch was tried and walked back the same day — the type and the nodes carry
  the zones, the dashes still say where the walk begins, and the line stays the app's one
  quiet rail). **The terminus node is the solved-word BLUE from the first frame**
  (user-decided: the point to reach is a blue square — blue is what the secret wears once
  won, so the `???` square says what it is before it is), and the word beside it joins it
  in blue at the solve. The MISSED shelf's words wear the same computed `heatColor(0)` as
  its heading, dimmed to the same 0.55 (`.route-miss` — a SHARED shelf, so Word mode's
  post-mortem gets the one-voice red block too), and the shelf holds 48px off the line
  (SHARED `.route-misses` since 2026-08-11, superseding the history-only override — on a
  one-trunk line the shelf is the drawing's top neighbour and read as the first stop's
  label at the retired lane-map's 26, and both drawings are one trunk now). So: red
  and shelved = never on the map, grey on the dashes = behind where you started, gold from
  the start word down = the words you hold, the gold square = where you stand, blue square
  = the target. The rail-to-word gap is likewise the SHARED drawing's since 2026-08-11
  (`--word-gap` 14px on `.route-frame`, paid by `.route-body` and subtracted from both
  frames' `--wordw` — it started as this modal's own fix for words sitting on the trunk,
  back when the shared drawing packed them for the word board's six-lane case). The sr mirror says the third
  state in prose (`srRouteStop`'s `behind` — « derrière le départ » / "behind the
  start"); "you" can never be behind, since a hole's rank only improves from its
  `start_rank`.
  **What survived as MODAL chrome:** the zoom out of the tapped word and the retraction
  back into it (`history-zoom`/`history-zoom-out`, same measured-origin plumbing in
  `Game.openHistory`), `useModalDismiss` + the shared `ModalHeader` above a `.pixel-scroll`
  scroller, close chip + Escape as the only ways out, the solving-beats gating
  (`exploreDisabled`, including the settled-solved-screen re-enable), and "the LINE has no
  motion" — the only animation is the modal arriving and leaving. The title is `MOT n` /
  `WORD n` (`holeTitle`, the ruler's numbering); the game's button hint is
  `ariaHoleHistory` ("Your tries on word n") while the tutorial keeps `ariaExploreHole`
  for its themes tap. The drawing is decorative with the sr-only prose mirror the map had
  (`srRouteDestination`, `srRouteStop` with départ / vous êtes ici, `srRouteOffMap`).
  **The entry point is UNGATED:** a history exists on every puzzle, so every hole is a
  button (`game/route.ts`, `RouteModal.tsx` and their tests are deleted; `routeDrawing`
  serves both this modal and Word mode's board, `DQ_MAX` moved into it).
- **Route discoverability (#129, decided 2026-07-27):** #117 made every hole a button and
  nothing said so. Two fixes, both in the show-don't-tell grammar — no permanent chrome, no
  tooltip, no message band (all three considered and rejected the same day).
  **The ambient affordance is the letter WAVE and nothing else** (decided 2026-07-27): a hole
  ripples its letters (`hole-wave`), quick and transform-only. The
  issue's second motion — a continuous idle brightness/color pulse on every unsolved hole —
  was built, seen, and **dropped on the user's call**; don't reintroduce it. What it cost is
  worth recording, because it is why the surrounding code looks the way it does: to pulse the
  word WITHOUT pulsing the heat-ramp exponent the animation had to ride on
  `.hole-word-wrap` and animate COLOR, which meant `.hole-word` giving up its own `color` for
  `inherit` and a `.hole.tappable` class existing purely as that rule's hook. Both are gone
  with it; `.hole-word` keeps `color: var(--hole)` as before.
  The wave needs per-letter boxes, which did NOT exist — the scramble renders a plain
  string — so `Hole` now splits the word ONCE (`.hole-letter`, used by the resting word and
  the scramble's frames alike; measured against plain text: same height, +0.06px over 5
  letters, and `.hole`'s `nowrap` means the boxes add no wrap opportunity).
  **EVERY hole owns its clock** (decided 2026-07-27, replacing a round-level scheduler that
  picked ONE hole at a time): each waits a fresh random `WAVE_MIN_MS`–`WAVE_MAX_MS` (3–10s,
  re-rolled per wave and whenever the sentence goes quiet again), so several words can stir at
  once and the holes scatter on their own instead of being kept apart. A lone ripple travelling
  around the sentence reads as a cursor pointing somewhere; several words breathing on separate
  rhythms read as the words being alive, which is the claim the affordance makes. The round
  contributes exactly ONE fact — `quiet`, the thing a hole cannot see for itself: no guess
  feedback in flight, no history modal over the sentence, `promptExiting` false, not solved.
  Everything else is the hole's own (`ticking`): its rank, its scramble, its hit. (The wave
  used to also gate on the hole HAVING a map — #115 geometry — because the map was what the
  tap opened; since the history modal, 2026-08-10, every hole opens one, so that gate is
  gone.) A hole locked at rank 0 never ripples (the tutorial's `waveSolved` exception was
  deleted 2026-08-11 with the themes ending — no tap ends the lesson any more, so nothing
  waves a solved word). A wave already in FLIGHT is cut when `ticking` drops, not merely when the hole's own
  `busy` does: `quiet` also falls when the modal opens over the sentence, and a wave left running
  behind it shows its tail if the player closes quickly (both modal beats are 120ms, a wave up
  to 460ms). Reduced motion: the clock never starts.
  **The one-time auto-open is GONE (#155, decided 2026-08-03).** It was #129's guaranteed
  half — the first hole a player EVER solves opened its own finished journey, explaining the
  feature by being it — and it existed because nothing TAUGHT the tap. The reworked onboarding
  now ends on exactly that gesture, so the map no longer has to interrupt a round to introduce
  itself, and #129's remaining half (the wave, plus the hole button) is a pure invitation
  again. Removed with it: `shouldAutoOpenRoute` in `game/route.ts`, the arming/firing wiring
  and `AUTO_ROUTE_AFTER_SOLVE_MS` in `Game`, and the persisted `routeSeen` flag it gated on
  (store **v5** drops the field, the way v1's retired keyboard `layout` was dropped —
  `markRouteSeen` had no other consumer). No back-compat, and no analytics change: the
  three-event invariant stands.
- **Archive routing (#55, decided 2026-07-07):** the client now also fetches **explicit
  past dates** — pairing with #53's server-side "serve any past day". `parseRoute`
  (`web/src/langs.ts`) grew two language-scoped routes beyond `/<lang>`:
  `/<lang>/archive` → the calendar screen (`screens/Archive.tsx`), and
  `/<lang>/<YYYY-MM-DD>` → that past day's game (deep-linkable/shareable). A date is
  honored only when it is a **real calendar date within `[FIRST_PUZZLE_DATE, activeDate]`**
  (`web/src/config.ts`, a launch placeholder the user pins); a malformed or out-of-range
  date-shaped segment → `home` redirect, while a **non-date** second segment keeps the old
  tolerance (`/<lang>/xyz` → today's game). `parseRoute` takes the range bounds as an
  injected arg (App passes the client `activeDate`) so parsing stays pure/testable.
  `usePuzzle(lang, date?)` fetches the given date, else the active day (unchanged); the
  404→`noPuzzle` path is reused as-is. The calendar reads each day's status from the
  **persisted rounds** (device-local) via the extracted `state/status.ts` `statusOf`
  (shared with the language selector). **Cell coloring (decided 2026-07-08):** a day with
  any reconstruction (>0%) is FILLED with its `progressColor(pct)` (solved counts as
  **100%** — the ramp top, NOT the language-card gold), and its number is drawn in `--bg`
  so it reads on the fill; disabled and not-started/0% days keep the neutral surface +
  number color. **A SOLVED day also RIPPLES (decided 2026-07-08):** a shading wave, so a
  validated day is distinguishable from an in-progress one by MOTION, not only color. It
  plays `web/src/assets/ultracode.png` — a **12-frame horizontal sprite sheet** (144×12,
  12 square 12×12 frames) — as a CSS background on `.cal-ripple`: `background-size:
  1200% 100%` fits one frame to the square cell and `steps(12)` walks `background-position-x`
  (end value `100%×12/11` so frame 11 lands on 100% and loops cleanly), `image-rendering:
  pixelated` keeps it crisp. (Superseded the earlier hand-computed SVG-path ripple.)
  Reduced-motion hides it → the static fill + aria-label carry the status.
  The calendar itself is **vertically centered** (`.archive` flex column, top padding
  clears the fixed header). **The live streak stat moved out of the archive body and into
  the shared `TopBar` (decided 2026-07-11):** immediately right of the language control it is
  only `assets/streak-small.png` (the 8×10 pixel-art source displayed at an exact 3× =
  24×30) plus a larger bare streak amount; a zero/broken streak remains hidden. Entry: a
  calendar icon in the
  game TopBar's right group; `dateForDayNumber` (`shared/day.ts`) is the `dayNumber`
  inverse. The **OG share page** (`backend/ogCard.ts` `renderShareHtml`) now click-throughs
  to the **shared day's** date-addressed URL (`/<lang>/<dateForDayNumber(dayNumber)>`),
  not bare `/<lang>` — so a shared archive result opens that archived date, not today (the
  card/title named the right day all along, as `#<dayNumber>` then and as that same date
  since 2026-08-03 — see the share-card bullet). The archive **must not touch streaks**
  (separate issue).
- **Solved-result hierarchy (decided 2026-07-10; leaderboard variant 2026-07-24, #110;
  SEE-MORE dialog 2026-07-25):** the solved tray is sentence-specific and the SAME
  compact stack at every breakpoint and on every surface: the named `<tries> TRIES`
  headline, the PLAYER's full-width **run ruler**, then the actions — SHARE plus, when
  displayed opponents exist, **SEE MORE** (i18n `seeMore`, fr `VOIR PLUS`). **The
  leaderboard no longer renders inline in the tray (decided 2026-07-25, superseding
  #110's inline table — too much information in the tray on mobile):** SEE MORE opens
  `LeaderboardDialog`, a borderless full-screen native dialog on the SOLID app
  background (the animated noise never plays under it) with generous row rhythm. It
  wears the shared `ModalHeader` and rises as a **SHEET** from the bottom edge
  (`sheet-up` / `sheet-down`, 2026-07-27 — see the modal-behaviour bullet); it is
  closed by its header X or Escape, **never by a backdrop tap**, and closing leaves focus
  unset. This dialog is the planned home of the deeper result views (#82): per-row
  runs, tested words, per-hole word lists. **The run RULER replaced the bucketed
  trajectory squares (decided 2026-07-25):** one continuous bar per run on the
  PROGRESS ramp (`components/RunRuler.tsx`), one cell per counted try colored
  `progressColor` at that try's reconstruction % — the RAW `progressTrajectory`, no
  on-screen bucketing — with a white tick at each try that solved a secret and the
  hole's sentence index (1..3) under it; one guess dropping several secrets stacks its
  indices under ONE shared tick (`solveTicks` in `web/src/game/share.ts` replays the
  moments with the same rules as the trajectory). **The SHARE CARD draws the SAME
  ruler (decided 2026-07-25, superseding the bucketed-squares card):** the share token
  was bumped to **v2**, carrying the RAW per-try trajectory plus the solve moments
  instead of the `bucketMeans` squares, so `renderCardSvg` renders the on-screen ruler
  scaled to the OG image — same `progressColor` cells, same ticks, same sentence
  indices. v1 tokens (bucketed squares) no longer decode: `decodeResult` rejects them
  on the version check, so a pre-bump link can never mis-draw. It is not a dead end
  though — **every version shares the opening header** (`version | lang | day | scoreLen
  | score`), so `decodeLegacyShareTarget` recovers a SUPERSEDED token's lang + day and
  `/s/<v1token>` **301s to `/<lang>/<date>`**, the archived day it named. That fallback is
  deliberately restricted to versions **strictly older** than the current one: a
  corrupted or hand-crafted CURRENT-version token still gets the flat 404, so a forgery
  can never earn a redirect. `/og/<v1token>.png` stays a 404 (there is no ruler to
  draw). Cell count is
  still DERIVED from the score (one cell per counted try, never stored), and a try that
  did not improve costs ONE bit, which is what keeps a long game's link short. The card
  itself draws at most ONE rect per pixel column: the score field is 15 bits, so a
  hand-built token can declare ~32k tries, and below a pixel per cell the extras only
  stack — collapsing them bounds the rasterizer's work by the CARD instead of by the token.
  **The day is named by its CALENDAR DATE, not the day index (decided 2026-08-03,
  superseding `#<dayNumber>`):** `2026-08-02` in all three places a reader sees it — the
  card image (`renderCardSvg`), the OG/Twitter title (`ogCard.renderShareHtml`) and the
  shared plain text (`SolvedScreen`'s headline) — so a stranger can date the sentence,
  where the internal index says nothing to anyone but the game, and so the card, the title
  and the archive URL the link resolves to all spell the same day the same way. The TOKEN
  is unchanged (it has always carried the day index, and no version bump is involved):
  every surface formats it with `dateForDayNumber`, `dayNumber`'s exact inverse, so this is
  still the SERVER-owned game day — never the reader's local date, which is what the old
  "never a date" note was guarding against.
  **The plain-text EMOJI row moved onto the PROGRESS ramp too (decided 2026-07-25):**
  `progressEmoji` lives with the ramp stops in `shared/src/progressColor.ts` so the row
  and the ruler can't drift — `<35 🟦` (blue→cyan), `<45 🟩`, `<55 🟨`, `<65 🟧`,
  `<75 🟥`, `>=75 🟪` (magenta→violet→indigo), each band the emoji nearest the stop(s)
  it covers, cut at their midpoints. The indigo tail deliberately stays 🟪 rather than
  the nearer-in-RGB 🟦: the ramp closes near its own start, and a row that returns to
  its opening color would read backwards. **The row is BOUNDED to 3–18 cells (decided
  2026-07-25, superseding the cell-for-cell row taken earlier the same day):** pasting 62
  emoji into a message is a wall, not a result, so the row is a SUMMARY of the bar where
  the ruler and the card draw every try. It restores the pre-#113 curve — `ROW_BREAKPOINTS`
  / `MIN_ROW_CELLS` 3 / `MAX_ROW_CELLS` 18 / `rowCellCount` / `rowMeans`, now in
  `web/src/game/share.ts` and NOT in the codec (the v2 token carries the raw run, so the
  decoder no longer derives a count) — with each cell the MEAN progress of its contiguous
  bucket; progress is monotonic and the buckets are contiguous, so the row still reads
  cold→hot. **The LAST cell is PINNED to the solving try**, never its bucket's mean: that
  tail average is what made a 61-try grind plateauing at 70 and solving on its last guess
  close on 🟥 — a finished game reading as unfinished — and it is the one cell that means
  something exact ("this is where you ended") — though on a SOLVED run the last cell is a
  keycap, so the pin is what a row WITHOUT solve moments ends on. **The row carries the
  ruler's TICKS as KEYCAPS (decided 2026-07-25, superseding "the ticks are the one thing the
  row drops"):** a cell holding a try that dropped a secret renders as that hole's
  sentence-position keycap (`1️⃣`/`2️⃣`/`3️⃣`) INSTEAD of its ramp color, so the row shows the
  ORDER the sentence was cracked — `🟦🟩1️⃣🟧🟧🟧🟧🟧🟧2️⃣3️⃣`. The bar puts a mark between two
  cells and numbers it underneath; a single line has neither, so the number takes the cell.
  Three consequences, all accepted: the solve cells lose their color; several secrets falling
  inside ONE cell show every keycap (in sentence order — the same order the ruler stacks them
  under a shared tick), so the row can reach `MAX_ROW_CELLS + 2`; and since the final try
  always solves, a finished run ALWAYS ends on a keycap (a 3-try perfect game is exactly
  `1️⃣2️⃣3️⃣`, no color at all). `solvedAt` is optional — without it the row is the plain ramp.
  In the DIALOG's table:
  one row per entrant sorted by score (player ahead on a tie, DNF last, `lineupModel`
  order) — medal, tag, the entrant's run replayed into its ruler, count (DNF muted).
  **Leaderboard rulers share ONE scale (decided 2026-07-25):** each bar's width is
  proportional to its tries over the longest **SOLVED** run on the table, so lengths and
  solve moments compare straight down the column. Solved, not longest: a DNF's run is not
  a score — it ends at the harness's counted-try cap (`DEFAULT_CAP` 300) — so scaling to it
  would squeeze every real bar, the player's included, into a few pixels. A DNF simply
  overflows the scale and the ruler's own `min(…, 1)` fills its row, which reads right: it
  ran the longest and still didn't finish. The colorize wave is paced separately, by the
  longest run of ALL, since it has to sweep every cell ON SCREEN within its span: its
  per-cell delay comes from
  `rulerStagger(maxN, reduceMotion)`, which returns **0 under reduced motion** — the
  global CSS rule collapses animation/transition DURATIONS but not DELAYS, so the ramp
  would otherwise still crawl across the bar for over a second for someone who asked for
  no motion. **On mobile the tag stacks ABOVE its bar's
  left edge (decided 2026-07-25)** — `.lb-main`, `display: contents` on desktop — so
  the table tightens to medal | tag-over-ruler | count and the bars get the width.
  **The table is MONOCHROME except the run rulers** (decided 2026-07-24): tags are
  muted (the player's alone in fg), counts neutral — identity colors belong to the
  characters, and the rulers are the single color voice — **plus the placement-medal
  column (decided 2026-07-25):** each row leads with its 15×15 pixel-art medal sprite
  (`assets/medals/1-4.png`, rendered at an exact 2×), drawn on the HEAT ramp's four
  anchor stops — 1 hot cyan → 4 cold crimson — not classic podium metals. **The
  PLAYER's tag alone is the solved-word gold** (decided 2026-07-24, replacing a
  tried-and-dropped accent row border), and it reads **"YOU" in EVERY language** — the
  `you` i18n key is deliberately untranslated (fr included; decided 2026-07-24), one
  universal tag across lineup + leaderboard. Rows are **NOT interactive** — an inline
  tap-to-unfold run viewer was tried and removed (too noisy); the run viewer arrives
  with #82, on this dialog. The table is decorative (aria-hidden) with an sr-only
  ranking line carrying the accessible result (also present in the tray, so the
  ranking needs no modal). The lineup does NOT persist past the
  solve: after the keyboard drops, its characters teleport OUT one tick apart (their
  dissolve + shared-flash strips), and only once the last is gone do the results rise
  into the tray (reduced motion or missing strips skip straight there). Both exit beats
  hand the tray back through a signal the DOM has to produce (the keyboard's own
  `animationend`, the lineup's tick clock), and the tray renders NOTHING until they
  arrive — so each carries a **deadline** (`KB_EXIT_FALLBACK_MS` / `LINEUP_EXIT_FALLBACK_MS`
  in `Game.tsx`), a generous multiple of the real duration, cancelled by the genuine
  signal. A lost signal must never be able to strand the player on an empty tray. **The
  SOURCE reveal is the third such signal and now carries the same deadline**
  (`SOURCE_REVEAL_FALLBACK_MS`, 6s, added 2026-08-03): it gates `solvedSettled`, whose one
  consumer is `exploreDisabled`, so a report that never lands used to leave every hole
  untappable for the rest of the screen — the post-mortem reachable only by RELOADING, with
  SHARE working the whole time (which is what located it: SHARE renders on the same four
  conjuncts minus this one). The trigger was never reproduced, so the deadline is a backstop,
  not a proven cure; alongside it `SolvedCaption` stopped ending the beat on a
  `requestAnimationFrame` — which does not run while the document is hidden — on the path a
  source-less puzzle and every reduced-motion player take. That was the chain's only link
  requiring the page to be on screen. **That deadline counts VISIBLE time only** (restarted on
  `visibilitychange`): the beat it backstops is paced by a frame and an interval, both of which
  the browser suspends or throttles while the tab is hidden, where a plain timer would keep full
  speed — so a wall-clock deadline could outrun a beat that had barely started and hand the holes
  back over a citation still typing. The other two deadlines are still wall-clock; they gate the
  tray rather than the sentence, and were left as they are. On a
  streak solve these exit beats do NOT play hidden behind the celebration — keyboard and lineup
  hold still under the modal and the drop + teleport-out start at its dismissal; the
  source types only after the leaderboard has risen (decided 2026-07-24). **The sentence
  must NOT move between the solved beats (decided 2026-07-24):** the lineup renders
  inside a `.lineup-zone` band that keeps its height for the whole round — through the
  exit and on rehydrated solves — and the tray's height is FIXED to the keyboard's
  (taller solved content overflows into the empty band, never grows the tray), so
  .play's centering never shifts the phrase. **Fresh-solve sequence (decided 2026-07-10):** the
  solving submit immediately sends the prompt left while fading it out, in the same render
  that launches the final hole-hit feedback. The next stage waits until EVERY `Hole` reports
  its final secret rendered after its final settle animation completes — never a
  guessed timeout — so multi-word or throttled animation cannot be covered mid-resolution.
  A fresh active-day solve then holds the fully resolved sentence for 300ms before mounting
  the streak modal. **The solved beats run STREAK → keyboard-drop + teleport-out →
  results rise → SOURCE (decided 2026-07-24, #110 — reversing the 2026-07-10
  source-before-results order):** once the modal has completely dismissed (including its
  exit fade) — or immediately after the final holes settle on archive / no-streak play —
  the exit beats play, the results rise into the tray, and only once the risen stack
  reports itself in place does the optional sentence source type quickly, letter by
  letter, with a trailing `_` (tally/colorize choreography continues beneath it; no
  metadata skips the typewriter). **The citation is MOUNTED for the whole round but
  MASKED until that beat:** the prompt and the caption overlay in one `.prompt-zone` grid
  cell and the zone sizes to the taller of the two, so the caption has to lay its full
  citation out from frame one — but the sentence's author/work is a HINT, and rendering it
  for real would leave it readable in an unsolved round's DOM. `SolvedCaption`'s `masked`
  replaces every non-space glyph (the pixel font is monospace and the spaces — its only
  wrap opportunities — are kept, so the mask occupies exactly the real box) and empties the
  sr-only mirror. Rehydrated solves render the full source/results immediately without
  replaying the sequence. Player progression is separate:
  `StreakDialog` is a
  **borderless full-screen** native modal, opened only by a FRESH active-day
  unsolved→solved transition. Its staged animation uses `@react-spring/web` (v9 for React
  18): 200ms empty-screen fade → previous streak (derived without the solved day; 0 when
  broken) 200ms fade → 500ms hold → changed digits wheel down/in from above, staggered
  90ms right-to-left with a slower, subtly bouncing incoming spring → whole new number
  foreground → flame → week with the solved day still empty → that tile lifts toward the
  player, flips onto its completed face, and falls back to the screen plane → its impact
  sends the prior completed-day scale pulse nearest-first across the week at 65ms intervals
  → the ending hint. Unchanged streak digits never move, and the previous value stays
  horizontally centered when the new streak adds a digit. It
  never opens for archive solves, the tutorial, a reload, or an
  already-solved revisit. **Dismissal (decided 2026-07-10, replacing the CONTINUE button):**
  the ending beat is a pulsing arcade-style hint — pure "what to do", never a why (the
  game is done; CONTINUE/CLOSE would beg "continue to what?") — reading TAP ANYWHERE on
  coarse pointers / CLICK ANYWHERE otherwise (localized). **The celebration has NOTHING
  focusable (decided 2026-07-10):** the hint is a plain non-interactive element, not a
  button, and nothing is auto-focused — so no focus ring ever appears and a stray Tab has
  nowhere to land (the modal traps focus; Tab is also swallowed). Once the hint appears the
  WHOLE modal dismisses — click/tap anywhere, ANY key (the "press any key" twin of
  tap-anywhere), or Escape — but dismissal is completely disabled until the hint's entrance
  finishes and it is fully visible. Every dismissal then fades the whole modal opacity over
  200ms before unmounting. **The solved screen then focuses NOTHING** (decided 2026-07-27,
  dropping the focus this dismissal used to hand to the result action): the celebration has no
  trigger to restore focus to, so the tray was taking it by default and SHARE arrived already
  ringed — a solved sentence is something to read, not a prompt to act. The streak celebration
  also keeps its **tap-anywhere** dismissal: it is the
  documented exception to the close-button-only rule the other modals now follow.
  While any streak screen is open, the source and solved-result timers stay at their
  initial frame. **Dev-only preview:**
  `?streak=N` (integer `0..99999`)
  opens the sequence immediately with `N` as the PREVIOUS value (`?streak=9` → `9→10`),
  suppresses the first-visit invitation, and synthesizes its visual week without mutating
  persisted rounds/solved days; production builds ignore the parameter.
- **The sentence game's one-time PLAY gate (user-decided 2026-08-11):** each mode explains
  ITS OWN rules before the first round, once — the tutorial teaches only the shared core
  concepts (semantic distance, word rarity). Word mode already had this by construction:
  its GATE is mandatory because PLAY starts the clock (the button wears the sentence
  gate's own PLAY label — one shared `gatePlay` key, user-decided 2026-08-11). The sentence game's gate exists
  only for the instructions, so it is shown **ONCE ever** — a persisted global flag,
  `sentenceRulesSeen` (store **v8**; older blobs get false, deliberately NOT grandfathered
  the way `onboarded` is: the gate teaches the history tap, which is newer than any
  existing play state, so every player sees it exactly once) — and PLAY
  (`markSentenceRulesSeen`) is its whole job. On the gate the PHRASE is on screen but the
  round holds back: the prompt lays out `retired` (invisible, inert, height reserved), the
  lineup ZONE keeps its band with no characters in it, the holes are untappable and waveless
  (`gateOpen` feeds `exploreDisabled` and vetoes `quiet`), and the TRAY holds the rules +
  PLAY in the keyboard's own footprint (`.rules-gate` — renamed from `.sentence-gate`
  when Word mode adopted the exact same stack the same day), so PLAY swaps what the tray
  holds and moves nothing else. **The rules wear the app's ONE rules dress (user-decided
  2026-08-11, second pass): `.coach-rules` — the tutorial's coach dialog, in flow and
  sized to its copy (680px cap, the keyboard's own footprint, after "narrow for no reason"
  desktop feedback) — typewritten by `CoachText`, as BULLETED lines, with an sr-only
  plain-text mirror (the visible box is aria-hidden like every coach box). Both gates wear
  it, so anything in this box reads as "here to help"; and PLAY is the tutorial's own
  full-width `.mix-btn`, so the gate and the graduation speak one button.** TWO rules, one
  idea each (`sentenceRulesGoal` / `sentenceRulesHistoryTap|Click`, the tap line in the
  input device's own verb — the streak hint's coarse-pointer test): the goal and the
  history tap. The famous-AI line was CUT on the same user review — the lineup on screen
  already says it. The gate is DERIVED, not state: `!sentenceRulesSeen && !solved &&
  guessCount === 0`, so a round already in progress (or solved, or rehydrated mid-play)
  never shows it, and an unset flag re-offers it until PLAY is actually tapped. No
  analytics event — the three-event invariant stands.
- **Onboarding tutorial (#51, redesigned 2026-07-06):** the tutorial **never starts
  without an action**. A first visit (persisted `onboarded` unset) lands on an
  **invitation** (`tutorial/Invite.tsx`, standing in for the loading screen: "New to
  the game? …" + TUTORIAL / SKIP — either sets the flag, so a veteran on a new
  device is one SKIP from playing). The header's `?` re-opens it as a **replay**.
  The tutorial **keeps the app header** (decided 2026-07-06, superseding the earlier
  header-less design): the flag (left) opens the **language screen — the ONE
  language-switching gesture everywhere** (no per-context flag behavior; decided
  2026-07-06 superseding a brief direct-toggle). The open-tutorial state is
  **transient store state** (`tutorialOpen: 'first' | 'replay' | null`, NOT
  persisted), so it survives the /select round-trip: picking a language returns INTO
  the tutorial in that language. Centre reads **"TUTORIAL"**, and the right control
  is a **fast-forward that SKIPS the whole tutorial** (`assets/icons/skip.svg`, →
  `onDone`) — a header affordance, NOT a coach-box `×` (which read as "close this
  box only"). Skip is available on both the first run and replays. The tutorial
  itself is **ONE board**, in the REAL game components. **Screen contract:**
  explanations in a TOP box (typewritten like a game dialog — `tutorial/CoachText.tsx`,
  app-bg + surface border — with inline markup so words look like what they are
  in-game: `[[b:]]` blue secret, `[[w:word^rank]]` gold + heat exponent, `[[m:]]`
  coldest heat, `[[n:]]` heat number); INTERACTIONS at the bottom (mix button, then
  keyboard), no modals until the last beat, no NEXT. The board is a single word,
  concept-first: the secret is SHOWN (blue); **MIX** shakes it
  to −1, **MIX AGAIN** fast-rolls to −10, **MIX EVEN MORE** rolls to the START word —
  the demo explains where start words come from — where the
  button gives way to the keyboard (`tutorial/MixWord.tsx` is the display-only
  widget; Tutorial owns the animation); three gated guesses then show distance
  (farther, no move), MISS, and improvement, each rolling straight into the next
  prompt (no after-panels); finally the player types back to the secret with the
  REAL vocabulary (`useVocab` loads in the tutorial), nudged with the answer after 3
  straight MISSes.
  **It ENDS on word RARITY (user-decided 2026-08-11, superseding the #155 THEMES/routes
  ending):** the tutorial teaches the CORE CONCEPTS the modes share — semantic distance
  (the mix demo and the guided guesses) and word rarity — and nothing mode-specific: each
  mode's own rules live on that mode's pre-game gate (Word mode's gate screen; the
  sentence game's one-time PLAY gate, below). The themes/clouds/routes-teaser ending this
  replaces taught the semantic road clusters, which the game no longer draws anywhere —
  `tutorial/ThemeCloud.tsx`, `tutorial/RoutesTeaser.tsx`, the `tutTheme*`/`tutTap`/
  `tutClick`/`tutThemes` copy, `themeHeading`, `ariaExploreHole`, CoachText's `[[t:]]` tag
  and `Hole.waveSolved` (the solved-word wave existed only for that tap) are all deleted.
  Finding the word retires the prompt and DROPS the keyboard out of the tray (the game's
  own `kb-drop`, same `KB_EXIT_FALLBACK_MS` deadline behind its `animationend`). **The
  ending then runs TWO beats, one idea each** (the tutorial's own grammar): the CLAIM —
  « Une dernière chose : chaque mot a une rareté. » (`tutRarityIntro`) — over the found
  word, with the tray's NEXT as its only control; then the word gives way to the **RARITY
  LADDER** (`tutorial/RarityLadder.tsx`): the five grade names from `RARITY_NAMES`,
  commonest at the top, each in its own `RARITY_COLORS` colour — the exact colour the
  grade wears on the Word board's lanes, the strike and the loot — stepping UP in size as
  they step down the ladder (static sizes, never an animated scale: the pixel font rule),
  each rung rising in on its own delay (reduced motion collapses durations, keeps delays).
  **Each rung carries one OBVIOUS example word** (user-decided 2026-08-11, second pass):
  the ladder teaches by evidence — en house / twilight / obelisk / reliquary / apricity,
  fr maison / crépuscule / alambic / cénotaphe / zinzolin (`tutRarityEx*`, hand-authored
  per language for intuition, not measured against the corpus; palimpsest(e) was the
  first OBSCURE pick both times and was swapped for LENGTH — see next) — in VT323 at ONE
  size beside the ramping names, in the grade's colour. **The ladder is TWO ALIGNED
  COLUMNS around one centred seam** (user-decided 2026-08-11, third pass): each rung is a
  full-width 1fr/1fr grid — names right-aligned against the centre line, examples
  left-aligned from it — so the gap's middle sits exactly on the centre of the (already
  centred) tutorial column and the ladder reads as a table. The widest rung (OBSCURE + its
  example) measures ~285px against a 320px screen's 292 budget (VT323 advances exactly
  1em/glyph, so the mobile step-down in index.css is arithmetic — an example longer than
  ~9 glyphs breaks the page inset there, which is what unseated palimpseste at 315px). The coach line states the CONCEPT and no
  value — « Des mots de tous les jours aux mots presque oubliés. » (`tutRarity`; a first
  cut said "the rarer, the more precious", which the user rejected as Word mode's framing:
  a grade is only WORTH something where it pays the clock, and the tutorial teaches core
  principles only) — and deliberately NOT what a grade pays: the seconds are Word mode's
  rule, stated on its gate (`wordRulesBonus`). The grade names are the game's untranslated
  vocabulary and come from `RARITY_NAMES`, never from a string; the ladder is decorative
  (`role="img"`) with `srRarityLadder` + the names and examples as its accessible line.
  The tray then offers **PLAY (`tutPlay`), which is the graduation**: `onDone`, no
  SolvedScreen (a lesson has no score to show).
  **The ACTION BUTTON keeps ONE place for the whole lesson** (decided 2026-08-04): MIX, the
  ending's NEXT and PLAY are the same control in the same spot — parked against the tray's
  BOTTOM edge (`.mix-btn`'s `margin-top: auto`, which beats the tray's own centring), so the
  page's frame inset is its whole margin below and it sits the same distance from the bottom as
  from the left and right. That has to be stated as a rule because the tray's HEIGHT changes
  under it — the keyboard's full footprint while the word is on screen, the button's own height
  once the ladder replaces it — so a button centred in the tray drifted: measured 87px above the
  bottom on the earlier beats against 24px on the final one (desktop), 54.5 against 14 on a
  phone, and the only control on screen jumped the moment the lesson moved on. On a phone the
  button carries its own +10px back to the 14px page inset (the same rule as
  `.tray.tray-results`, and the reason that offset lives on the BUTTON rather than on the
  ending tray's padding: the earlier beats need it inside a tray whose height must stay the
  keyboard's). The keyboard and the tray's transient loading/error lines keep the tray's
  centring — the auto margin moves the button only.
  **From the ladder on, the TRAY stops reserving the keyboard's footprint** (`tutorial--ending`
  on the root, decided 2026-08-04 as `tutorial--themes`, renamed with the re-arc): the
  keyboard has dropped for good and the tray holds one
  button, so it shrinks to that button — which does NOT move it (it was already on the tray's
  bottom edge); only the space ABOVE it changes. The ~120px that
  empty footprint held goes to the ladder's breathing room. It cannot start any EARLIER:
  while the word is still on screen
  the tray's fixed height is exactly what keeps the word from moving between beats, so the
  claim beat keeps the full tray.
  **The board's ranks are a REAL generated neighborhood:** the mix ladder walks real ranks
  and the free find lands on real groups. Each language embeds a #154
  single-word artifact (`pnpm gen:word`) PRUNED to the word + the top-150 near field + the
  guided words, by `web/scripts/prune-word-map.mjs` (`--top` cuts the zone by RANK since
  2026-08-11 — it used to select by `road !== undefined`, and the committed maps had their
  now-unread `road` fields stripped the same day) — the exact command is recorded in each
  script's header, and `scripts.test.ts` fails if board and map ever drift. **en = OCEAN,
  fr = TROPIQUES** — both picked back when the ending taught the map's roads; nothing in
  the current arc depends on how a neighborhood forks, so the words simply stay (en/fr
  symmetry a standing non-goal).
  **The guided words obey two findings-decided rules (2026-08-03/04):** the far guess stays
  on a READABLE scale — same order of magnitude as the start word, ≤ 500, guarded by
  `scripts.test.ts` (fr `désert^1183` read as noise) — AND must make intuitive sense as a
  somehow-close word (`casquette^330` did not; fr's is `neige^353` — snow is
  climate-adjacent and intuitively the anti-tropics, so "farther" feels right); a mix stop's
  word should likewise be an INTUITIVE neighbor (fr's second stop is `soleil^12`; the fr
  board is agreed SINGULAR — `--form tropiques=n:s` — because plural-agreed neighbors read
  oddly on a word board, findings 2026-08-04). Coach
  copy must fit the coach box's THREE lines at 320px — split an idea into two beats before
  growing the box (learned 2026-08-04, when the box briefly went to four lines and went
  back the same day).
  Copy is deliberately terse throughout, no under-the-hood talk. The tutorial is
  **data-driven**:
  the board, guesses and steps live in `web/src/tutorial/scripts/{en,fr}.ts`
  (copy keys in `i18n.ts`) and `tutorial/scripts.test.ts` guards the lesson arc.
  Gated steps use synthetic vocab/prefix sets (the keyboard's existing contract);
  free steps use the real sets. The tutorial writes NOTHING to `rounds`; the store
  `migrate` (v2) grandfathers any blob with prior play state so veterans never see it
  uninvited. Replay via the header `?`; `?tutorial=1` forces it; the dev-only `?streak=`
  preview suppresses the first-visit invitation. The tutorial ships in its OWN chunk
  (`LazyTutorial`, the LazyStreakDialog pattern, 2026-08-04): most sessions never render it,
  so the components and the two embedded word maps stay out of the startup bundle — the
  invitation preloads it while the player reads the question, a replay lazy-loads it behind
  the plain loading line, and a failed chunk calls `onDone` (into the game) rather than
  stranding a blank screen.
- **App header (decided 2026-07-06; redesigned 2026-07-21 — this bullet was STALE and is
  corrected 2026-07-26 from the code, which is ground truth):** a fixed **topbar**
  (`components/TopBar.tsx`) of **two corner chips and NOTHING else — no band, no border, no
  background, no blur.** Boxes read as floating rectangles over the animated waves, so the
  groups sit DIRECTLY on the backdrop and the glyphs' own `text-shadow` carries legibility.
  Layout is one optical row: `.topbar-inner` = `min(900px, 100vw - 48px)`, 56px, centred.
  **LEFT is the status spot** (`.topbar-left`) — a screen's title in `.topbar-title`
  (ARCHIVE / TUTORIAL, plus any inline stat like the tutorial's counter), or a loaded game's
  live arcade status: the sentence's progress **counter** (painted in `progressColor(pct)`),
  or Word mode's score. Word mode's cross failure row stays with its play controls,
  directly above the keyboard. Both left and right groups are children of the actual
  `<header>`; game bodies never render a separate fixed header half. The full-width progress
  BAR is gone — the number and its colour say what the bar said. **RIGHT is the one action
  group** (`.topbar-right`), in two halves: the CHOOSERS the bar itself owns — the
  **Whippin mark** (which daily, `/mode`) then the **globe** (which language, `/select`),
  in that order because which GAME you are playing is the larger choice and the mark is the
  app's own logo — then the
  screen's contextual controls — every one a `.home-btn` (a transparent `--hud-height` square)
  wrapping a `.pixel-icon` SVG, muted → `--fg` on hover.
  **The language control is a GLOBE, not the loaded language's flag** (decided 2026-08-06,
  `components/LangButton.tsx`, which replaced `FlagButton`): the button's job is *change
  language*, and a flag answered a different question — which language is loaded — that the
  screen under it already answers in every other way. One glyph in every language also makes
  it read as fixed chrome rather than as a status that happens to be tappable. Flags survive
  where the choice is actually MADE: the language screen's cards (`Flag.tsx`, now their only
  consumer). `globe.png` is a single-colour 15×15 sprite drawn at an exact 2× and **MASKED**
  (`.globe-icon`, `background-color: currentColor` — a single-colour sprite painted through a
  CSS mask, the same technique the `.cal-ripple` sheet uses), so it takes
  the group's muted → `--fg` hover with the inline SVGs instead of being the one control that
  cannot. The **streak stat is NOT in the
  header** (moved back to the archive page 2026-07-21). **Any full-screen surface follows this
  same row** rather than inventing chrome, and since 2026-07-27 there is ONE component for it:
  **`components/ModalHeader.tsx`** — the app's row (`.topbar-inner` / `.topbar-left` /
  `.topbar-title` / `.topbar-right` / `.home-btn`) with a title and one close chip, minus the
  flag (switching language out from under a modal would navigate the screen away). The route
  map (#117) and the leaderboard (#110) both wear it; the leaderboard's own X floated in the
  corner until then, so the app had two full-screen modals with two different dismissal chromes.
  **A modal adopting it owes it the structure that lets it paint nothing**: the header sits IN
  FLOW above a scroller that owns the overflow (`.lb-scroll` / `.route-scroll`), so no content
  can pass beneath it and no band is needed — the DIALOG must not scroll. Two consequences for
  the leaderboard: its padding moved from the dialog to the scroller (padding on the dialog sits
  outside the scroll and clips the table on a short viewport), and its backdrop-dismiss test
  gained the scroller, which is now most of the backdrop. The dialog is named by a new i18n key
  `leaderboard` (en LEADERBOARD / fr CLASSEMENT) rather than `seeMore`, which names the button's
  ACTION, not the surface. The **StreakDialog deliberately does NOT take this header** — the
  celebration has nothing focusable by decision, and a close chip would be the first thing on it.
- **How a modal opens and closes — `hooks/useModalDismiss.ts` (decided 2026-07-27).** Three
  rules, shared so two modals cannot drift, and the StreakDialog is the standing exception to
  all of them (it is a tap-anywhere celebration with nothing focusable, by its own decision):
  - **Opening focuses the DIALOG, not the first control inside it.** `showModal()` otherwise
    focuses the first focusable descendant — which, now that every modal leads with the shared
    header, is the close chip: the modal would appear with its dismiss button already lit.
    Focus still lands INSIDE the dialog (the element itself, `tabIndex: -1`, `outline: 0`), so
    the focus trap and Escape are untouched.
  - **A backdrop tap is NOT a dismissal.** The close chip is the way out; Escape stays, being a
    keyboard affordance rather than a mis-tap. Both modals' click handlers are gone with it.
  - **Closing is a BEAT, not an event.** `beginClose()` only starts the exit; the real
    `dialog.close()` — which fires `onClose` and lets the owner unmount — waits on the exit
    animation's `animationend`, with `EXIT_FALLBACK_MS` behind it. Escape goes through the same
    door: its `cancel` event is `preventDefault`ed, or a native dialog vanishes on the spot.
    The exit's name is a **string contract with a real `@keyframes` rule** that nothing
    type-checks and no test can (jsdom runs no animations), so the hook VERIFIES it instead of
    trusting it: on `closing` it reads the computed `animation-name` and, if the expected one
    is not there, closes immediately. Renaming a keyframe then costs the animation and nothing
    else — where before it left `animationend` unfired and the modal INVISIBLE over an inert
    page for the whole fallback, which reads as a freeze. Measured: 193ms to close normally,
    53ms with the name broken, never 800.
  The hook must be the caller's FIRST hook, because it owns `showModal()` and a closed
  `<dialog>` is `display: none` — anything a modal measures on open would read a tree with no
  boxes (the retired route map's opening scroll was exactly that hazard).
  **Which exit each wears:** the history modal RETRACTS INTO ITS WORD, because it belongs to
  that word (the rule the route map it replaced established); the leaderboard is a **SHEET** —
  up from the bottom edge to full screen, back down on
  the way out — because a result screen belongs to nothing on the page. The sheet plays at
  EVERY width, not just phones: this dialog is full-screen on the desktop too, and a
  media-query-scoped exit would leave `animationend` unfired on desktop, where the close waits
  on it.
  The game's right group holds the **archive calendar icon** and help `?` (#55); the tutorial
  puts "TUTORIAL" in the left chip and the skip fast-forward in the right group. The globe
  ALWAYS opens the language screen; the Whippin mark is opt-in (`TopBar`'s `modeChooser`)
  and appears on GAME routes only — the archive and the tutorial show the globe alone, since
  only a game route is IN a mode. The
  game header is owned by **`GameRoute` (App)** (decided 2026-07-08): it constructs the
  same `TopBar` for EVERY state of the route — loading / error / missing-puzzle / the loaded
  game — while the loaded screen supplies its live status through the header's `left` slot.
  That keeps the status inside `<header>` and outside `.game`, and navigating into a game
  (e.g. from the archive) never changes the header structure; only its contents and the body
  under it refresh. `usePuzzle`'s **stable
  `dayNumber`** is still captured ONCE per request (`useMemo` on the requested date) and
  shared by the fetch, round key, and share, but is no longer rendered in the header. An
  undated tab held open across the 22:00 flip therefore still keeps its fetched puzzle/day;
  the puzzle itself does not silently swap. The topbar is the extension point for future
  chrome (streaks, stats, …).
- **The CHOOSER screens (language 2026-07-06, mode 2026-08-06):** the app asks "which one
  do you want to play?" twice — about the LANGUAGE (`/select`, the header globe) and about
  the DAILY (`/mode`, the header Whippin mark) — and both are the SAME screen, so there is
  ONE of it: `components/Chooser.tsx` holds the shell, the card and the status strip;
  `screens/LanguageSelect.tsx` and `screens/ModeSelect.tsx` supply only what the options
  are, what each is called, which art it wears and where a tap lands (`.chooser-*` in CSS,
  renamed from `.lang-*` when the second one arrived). Both are ROUTES, never modals, and
  both sit ABOVE `/<lang>` since neither is language- or mode-scoped.
  Headed by the **logo** (blue pixel
  glyph, 3×/2× its native 22px — language-neutral, and the app's ONE in-app branding
  spot), NOT a "select language" title (the cards self-explain, and a title would
  have to guess the user's language on the screen where it is unknown). One **card**
  per option — full-opacity art + its name — in a vertical list that scales to any number
  of them, with the app's standard brighten-on-hover/press (no dimmed art). Languages show
  a flag + the language's **native** name (`LANGS[].native`; never translated); modes show
  the 7×7 sprite + a localized name (`modeSentence`/`modeWord`). Card art takes an exact
  INTEGER scale — 2× for the 16×16 flags, 4× (`.mode-sprite`) for the 7×7 mode icons —
  because a fractional one leaves some source pixels a row wider than others, which
  `image-rendering: pixelated` cannot fix.
  The old NEW/%/✓ badges are gone: today's status is a thin **strip on the card's
  bottom edge** — absent = not started, partial = progress on the progress
  ramp, full **gold** = solved / done for the day (the solved-word gold). The card's
  aria-label speaks the status.
  **Each chooser holds the OTHER's axis fixed**, so neither can strand you: a language card
  lands in the last-played MODE and reads that mode's status, and a mode card lands in the
  last-played LANGUAGE and reads that language's. **The mode chooser replaced a header
  TOGGLE** (decided 2026-08-06): a toggle had to show the mode you were NOT in — a thing to
  decode rather than read — and could only ever flip between exactly two, where a chooser
  shows both dailies side by side with today's progress on each and stays right when a
  third arrives.
- **UI chrome is localized + a11y'd (decided 2026-07-06):** `web/src/i18n.ts` holds every
  UI string in **en + fr** (`t(lang, key)`; the `satisfies` clause makes a missing
  translation a type error, so parity needs no test). Game screens resolve strings with
  the **puzzle's** language; the selector (no puzzle) uses the same resolution as the `/`
  redirect. `<html lang>` is kept in sync by App. Guess feedback is mirrored to a
  `.sr-only` polite live region (`srHoleResult`), animations honor
  `prefers-reduced-motion` (durations collapse to ~0 — never `animation: none`, several
  swaps advance on `animationend`; delays are kept so the floating numbers still show).
  **Every BUTTON is pointer-only and may NEVER retain focus** (decided 2026-08-06):
  `buttonFocus.ts`, installed before React renders, gives current/future/lazy/portaled buttons
  `tabIndex = -1`, prevents mouse-down focus without suppressing click, and immediately blurs
  any browser or programmatic button focus. There are no `:focus-visible` button treatments and
  modal close paths never restore focus to their triggers. Native modal focus may stay on the
  non-button `<dialog>` itself so its focus trap and Escape behavior survive. **The missing-puzzle screen
  has TWO wordings, told apart by the ROUTE (#77, decided 2026-07-27)** — the backend's
  404 is undifferentiated, and which route asked is the only signal needed: on the
  **undated** route (today) it owns that the state is **abnormal** (a publish that did not
  happen), unchanged; on a **dated** archive route (#55) it is usually NORMAL — a
  pre-launch date, or a language backfilled later, simply was never published — so it says
  that plainly (no "not supposed to happen", no "check back"), names the day, and offers
  BACK TO ARCHIVE above the existing CHANGE LANGUAGE, both the same `secondary` weight.
  The pixel font is **self-hosted** (`web/src/assets/fonts/PressStart2P.woff2`, `@font-face` in
  `index.css` — no Google Fonts request).
- **SVG icons (pattern to follow):** monochrome UI icons live as `.svg` files under
  `web/src/assets/icons/` and are imported as **inline React components** via
  `vite-plugin-svgr` — `import Icon from '../assets/icons/name.svg?react'` (the `?react`
  query is what returns a component; a plain import would return a URL string). Rendering the
  SVG **into the DOM** (not via `<img src>`) is what lets it inherit color, so:
  - **Icons paint with `fill="currentColor"`** and carry **no hardcoded color** — the SVG
    root sets `fill="currentColor"` once and every child inherits it. Color/greyed/theme
    states then come **only** from the consuming element's CSS `color` (e.g. the control
    keys' `.kb-control` / `.kb-enter` / `.kb-greyed`). Never bake a hex/`fill` into an icon
    meant to tint with its surroundings.
  - **Strip the editor cruft.** Keep only `xmlns`, `viewBox`, the `width`/`height` size (see
    below), `fill="currentColor"`, and the shape elements. **Remove** the `<?xml …?>` prolog
    and `id`/`data-name` (Illustrator layer junk). This is what "remove the useless
    attributes" means for any new icon.
  - **Every icon is orthogonal PIXEL ART** (decided 2026-07-08) — shapes on an integer grid
    with only horizontal/vertical edges (rects, or a path of `v`/`h` moves), NO diagonals —
    so it renders crisp at integer scale. Rendered with `shape-rendering: crispEdges`
    (shared in the `.pixel-icon` CSS class, not per icon).
  - **Size lives in the SVG, at EXACTLY 3× the viewBox** (decided 2026-07-08, revised from
    "size in CSS"). The `.svg` sets its own `width`/`height` = `3N × 3M` **px** for a
    `viewBox="0 0 N M"`, **right next to the viewBox** — so an icon's size is a single source
    of truth in one file, not split into a CSS rule in another folder. CSS (`.pixel-icon`)
    only sets shared rendering (`display: block; shape-rendering: crispEdges`), never a size,
    so a new icon needs **no** CSS: author the `.svg` with its px `width`/`height` and give
    the element `className="pixel-icon"`. Every icon's "pixel" is then 3 screen px — crisp,
    uniform in weight, integer-scaled (×3 vs ×2 is purely a size choice; both are crisp — ×3
    suits the small header viewBoxes, giving ~18–27px). **The ONE exception is the on-screen
    keyboard's control glyphs** (`.kb-icon`, enter/back): their `.svg`s carry NO `width`/
    `height` and `.kb-icon` sizes them in CSS (`height: 30%; width: auto`), because the keys
    shrink on narrow phones and a fixed 3× would overflow.
  - **Accessibility:** the SVG is **decorative** — pass `aria-hidden` on the component and
    let the surrounding `<button>`'s `aria-label` name the control.
  The type for `?react` imports comes from the `vite-plugin-svgr/client` reference in
  `web/src/vite-env.d.ts`; the plugin is registered **before** `react()` in `vite.config.ts`.
- **On-screen keyboard (#36):** the guess input has **no native `<input>`** — the old
  focus/refocus dance is gone, so the mobile soft keyboard never opens. `WordInput` is
  now just the visual prompt + a **window `keydown`/`paste` listener** for the physical
  keyboard (desktop); the `components/Keyboard.tsx` on-screen keyboard feeds the **same**
  input actions. Both drive one **folded-slug** `input` state in `Game` via three shared
  actions — `appendChar` (validated), `deleteChar`, `replaceInput` (Up/Down history
  recall, sourced from the round's **persisted** `tried` list so recall survives reload) —
  plus `submit`. Keys are `[a-z]` + dash + backspace + Enter (no accent keys; physical
  accents/ligatures are `fold()`-ed to slug chars, dash special-cased since `fold('-')==''`).
  **Live validation:** `useVocab` now also builds a **prefix `Set`** (`game/keyboard.ts`
  `buildPrefixSet` — every prefix of every vocab word; a flat Set, not a trie, per the
  issue) cached beside `vocabSet`; a letter/dash is greyed when
  `canExtend(prefixSet, input, char)` is false, Enter is greyed unless `vocabSet.has(input)`,
  and a greyed-key tap shakes (no input change). Backspace is always active. **Layout** is
  the ONE fixed **QWERTY** (`game/keyboard.ts` `KEYBOARD_ROWS`): the AZERTY alternative and
  the persisted `layout` preference were **removed** (explicit decision, 2026-07-05); the
  store's `migrate` silently drops the retired `layout` key from older persisted blobs.
  Keys are a uniform fixed size (not flex-grown), each row centered; the last row is
  the **enter icon** + letters + dash + the **backspace icon** sized like letters so it fits
  the keyboard width exactly. The two control keys render `assets/icons/{enter,back}.svg` as
  inline SVG components (see **SVG icons** below), not text; the button `aria-label`
  (`enter` / `backspace`) is what names them.
- **Analytics (#60, decided 2026-07-07):** privacy-first, cookieless **Plausible** — no
  cookies, no consent banner (the developer is in France, GDPR-relevant).
  An explicit, **user-approved EXCEPTION** to the no-third-party-origin stance (same
  rationale that self-hosts the pixel font); proxying the endpoint through our own domain
  is a possible later step. **`web/src/analytics.ts` is the ONLY module that knows
  Plausible exists:** it uses the official `@plausible-analytics/tracker` package
  (follow-up decision 2026-07-07, replacing manual `script.js` injection) and
  `initAnalytics()` (called once from `main.tsx`) loads/initializes the tracker **only
  when `VITE_PLAUSIBLE_DOMAIN` is set** (else nothing). `track(event, props)` initializes
  the same tracker if needed, stringifies low-cardinality props at the Plausible boundary,
  and is a **silent, never-throwing no-op** when unconfigured. **Env-gated:**
  `VITE_PLAUSIBLE_DOMAIN` is a GitHub **repo variable**
  (like `VITE_API_BASE_URL`) set ONLY on the CI prod deploy (`deploy.yml` web build) and
  deliberately **NOT** in `.env.production`, so dev/preview/local `pnpm build` stay fully
  inert. The web CloudFront CSP (`infra/lib/web-stack.ts`) allows `https://plausible.io`
  in `connect-src` for the tracker endpoint; `script-src` stays `'self'` because the
  tracker is bundled. **Exactly three events** (low-cardinality props only — **NEVER** a typed
  word/guess): `solve {lang, tries, day, archive}` — the play-solve transition in
  `Game.tsx` (NOT rehydration; `archive` is `'yes'`
  when replaying a past archive day (#55), `'no'` for the live daily puzzle);
  `share {method:'native'|'clipboard'}` — `SolvedScreen`
  success paths; `tutorial {action:'start'|'finish'|'skip'}` — invite accept / the ending's
  PLAY under the routes teaser (#155) / skip (fast-forward or invite SKIP). Plus automatic
  pageviews.
