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
      components/rarity.ts    how a rarity grade LOOKS and how hard it lands (pinned colours + intensity)
      components/WordSubject.tsx  the day's word while the run is on: the word alone, centred
      components/WordHistory.tsx  the last few claims, above the prompt, fading with age
      components/WordTally.tsx    found/total per grade under the prompt, colour as the only label
      hooks/useCountdown.ts   the run's deadline, as a ticking clock (HUD) and as one flip (screen)
      game/scoring.ts         s(rank), holeProgress, computeProgress
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
      components/routeDrawing.tsx  THE route drawing: geometry, lanes, frame vars + the row
                              parts (Junction/OffMapShelf/RouteTail/RouteLink/RouteRow/RouteWord).
                              Owned by neither surface — RouteModal (#117) and WordBoard (#156)
                              both compose it, so a change to the line changes every route.
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
  #154 artifact: the word is PUBLIC and the player claims its top-`CLAIM_ZONE` (**250** since
  2026-08-07, was 150) groups **against a COUNTDOWN**; the score is the claim count.
  **`CLAIM_ZONE` is the one constant here that is NOT this package's to pick alone:**
  it restates generation's `ROAD_TOP` (`distances.py`), because the field the board draws is
  the set of groups that carry a road — move one and the board grows lane-less stations, or
  draws stations it will not let you claim. `wordGame.test.ts` reads the Python literal and
  pins them together, and widening it means republishing every word artifact (one generated
  at the old ceiling has roads only that far).
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
  An artifact with no `freq` at all grades COMMON — the floor, never a windfall for missing
  data.
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
  the run's own end condition, and the whole ending would fire on the START tap.
  **`replayWordRun` is the ONE walk of a word round** (2026-08-06): it returns the ordered
  `counted` guesses with their judgements plus the seconds they bought, and `buildWordBoard`
  sorts THOSE into claims / trunk stops / the misses shelf rather than re-deriving the dedup
  a second time — the score, the clock and the drawing cannot disagree about what one log
  means. What it does NOT return is `ended`: that is the deadline's, and a log cannot see a
  wall clock (`WordBoardModel` lost its `ended` field with it).
  **The screen runs in THREE phases** (#163), each putting one thing in front of the player.
  **GATE** — the day's word, the rules in two sentences, and START. A timer needs a start
  control anyway, and the control is where the rules live, so this screen is Word mode's
  whole onboarding and no tutorial change was needed. The clock previews `START_SECONDS`
  greyed beside it, so the number teaches what it is before it starts moving; the copy
  states no duration (that would restate a tuning knob). **RUN** — the word, the prompt, the
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
  **The TIMER is the HUD and the SCORE is the watermark.** The clock takes the header's
  status corner (where the sentence game puts its progress counter) at 34px — the one live
  number on the screen — and the count becomes the big `CellDigits` watermark behind the
  word (`.word-anchor`, the standing watermark rule: what is displayed better later, since
  the count is this mode's end-screen headline). That split IS the mode's feedback grammar:
  **a float on the WORD is about the guess** (its GRADE, or MISS), **a gain on the TIMER is
  about your clock** — `+4s` in the solved-word gold, keyed by a monotonic id so two claims
  in a row replay it. The clock reads **`seconds.decisecond`** and goes `--danger` red for
  the **last 20 seconds** (`WARN_SECONDS`); the tenth renders smaller than the seconds,
  which is width before it is taste — the header corner holds ~104px at 320px before the
  icon group, and a three-digit clock plus a full-size `.0` does not fit it (measured: it
  pushed the help icon off the screen). `useCountdown` ticks at 50ms so the last digit does
  not stutter.
  **The float is the GRADE, and it lands harder the rarer it is** (decided 2026-08-08,
  superseding the rank exponent). It is still ONE `FloatingHit` with one animation — the
  sentence game must not acquire a rarity concept it does not have — so every new knob
  (`label`, `scale`, `lift`, `rise`, `punch`, `--hit-len`) is optional and **defaults to
  exactly what the float did before**, which is stated as named constants in the component
  rather than left implicit in the CSS. Word mode's values live in ONE table indexed by
  `rarityStep` (`components/rarity.ts` `RARITY_HIT`), so "ARCANE feels bigger than COMMON"
  is a data row, not six rules. **Two of the channels are load-bearing for a reason**: the
  global reduced-motion rule collapses DURATIONS but KEEPS DELAYS, so a ladder built only
  out of movement would not exist at all for a player who asked for none — `scale` is static
  and `holdMs` is a delay, and between them the escalation always lands (`rarity.test.ts`
  pins that). `lift` (where the label rests above the word) grows with the grade because
  these labels are WORDS: at the sentence game's fixed 14px an ARCANE sat squarely ON the
  word and hid it.
  **From RARE up the day's word RIPPLES** (decided 2026-08-08): the #129 letter wave, at an
  amplitude the grade sets (`--wave-lift`, 3/5/8px). It is a THRESHOLD channel, absent below
  RARE rather than merely quiet, so the top half of the ladder does something the bottom half
  does not — a different KIND of event, not a louder one. It is also the only channel that
  costs NO WIDTH, which is what lets the sizes keep climbing on a phone. `WordSubject` splits
  the word into `.hole-letter` boxes for it, exactly as `Hole` does.
  **The grade's SIZE is capped by what the column holds**, the same arithmetic `fitWord`
  applies to the route drawing: `min(base × scale, room / (glyphs × punch))`. A grade name is
  a WORD — `UNCOMMON` is 8 characters — and at a 2.6× ARCANE the widest would run clean off a
  320px screen at the peak of its pop. The cap only bites at the narrowest width and only on
  the top two grades (measured at 320px: OBSCURE 35.7→29.8, ARCANE 44.2→33.6), and the ladder
  is tuned so the ORDER survives it — a capped OBSCURE must never render smaller than an
  uncapped RARE, which `rarity.test.ts` pins because it is exactly what a future size bump
  would break silently.
  Both the shake and the wave ride variables that **default to the sentence game's values**
  (`--shake-amp` 1, `--wave-lift` 3px) — `word-shake` is shared by the sentence hole, this
  word AND the standings sprite, and `hole-wave` by the hole's ambient ripple, so only Word
  mode's own rules set them.
  **The label sits ABOVE the word, at a random TILT** (decided 2026-08-09): every grade's
  `lift` clears the word entirely — reading one word through another is reading neither —
  and the label leans a coin-flip's worth of `HIT_TILT_MIN/MAX_DEG` (3–8°) each time, so a
  run of guesses reads as hand-thrown notes rather than one stamp printed over and over.
  Every rotation in the keyframes is RELATIVE to `--hit-tilt`, which defaults to 0 and keeps
  the sentence game's label dead straight. **The lift pays for the tilt as well as the type,
  and that is not obvious**: a rotated box is taller than an upright one by half its WIDTH
  times the sine of the angle, and these labels are wide — an 8-character UNCOMMON at 8°
  swings its corners ~13px lower than its height suggests, which was exactly enough to land
  it back on the word (measured, then fixed).
  **Two ambient readouts bracket the prompt during a run** (decided 2026-08-09), and both
  RESERVE their full footprint from the first frame — the word sits in the flexible space
  above them, and a column that grew as the run filled it would walk the word up the screen
  guess by guess. Above it, `components/WordHistory`: the last five CLAIMS, newest against
  the prompt, older ones riding up, fading, and gone — a chat, not a list, which is what
  `justify-content: flex-end` + `overflow: hidden` buys. It is where the RANK went: the float
  carries the grade now, but "how close was that one?" is a question a moment later, and a
  log is where a moment later belongs, so each line is the word in its grade's colour with
  its exponent. Below it, `components/WordTally`: `found/total` per grade, commonest first,
  with **the COLOUR as the only label** — no names, no legend, since the five colours are
  already the language the float speaks. A grade the day's zone does not contain is DROPPED
  rather than shown as `0/0`: an English board often has no ARCANE group at all, and a
  permanent `0/0` reads as a goal being failed rather than one the day never offered. Both
  totals come from `zoneGroups`/`tallyRarity` (`game/wordGame.ts`), so the numerator and the
  denominator are counted by ONE rule — a group is its RANK, once, however many aliases key
  it. The history is decorative (every line was announced when it landed); the tally carries
  an sr line, because a colour says nothing to a reader.
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
  below). The clock is `--fg`, goes `--danger` + a 1s pulse under `WARN_SECONDS` (10), and
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
  **The whole FIELD is drawn, censored until it is claimed** (decided 2026-08-05, restoring
  the `???` census after a day without it — the sparse variant that drew only found words
  and dashed the ground between them is gone, `.route-link.dashed` with it): every group of
  the claimable zone is a station wearing the route map's fixed-width `???`, so each road
  shows its real length and population — the one thing a list of your own words can never
  say — and a claim lands ON a stop that was already there rather than appearing out of
  nothing. The run's end reveals every word and turns the board into the post-mortem, where
  a group merely NAMED keeps the small node and the dimmed word that tell it from one you
  found (`route-unknown route-revealed`, the map's own distinction).
  **The TAIL is the board's only broken run** (same decision): dashes mean "the line
  continues into words with no distance at all", which is true at the cold top end and
  nowhere else here — every rank between two stations is itself a station, so no connector
  hides ground. Consecutive ranks are one row apart (`LINK_MIN`) and only the sparse trunk
  between far strikes keeps a proportional length, exactly as on the map. The merge→word
  leap stays SOLID (the 2026-08-04 decision) **and runs the ONBOARDING TEASER's distance,
  not the modal's**
  (decided 2026-08-05): the map spends `LEAP_H` (56) there, which with the junction's own
  stub and the arrival's half-row puts 90px between the bus and the word — 2.5× the
  teaser's 36 — and on a board that is mostly unknown ground that stretch read as the line
  trailing off rather than arriving. The teaser is the shape the routes were TAUGHT in, so
  it is the one to match; the connector contributes only what the junction and the arrival
  row do not already spend (`TEASER_MERGE_RUN`/`JX_STUB`/`ARRIVAL_HALF_HEAD` in
  `WordBoard`, measured at 36px bus→node). The rank gutter fits the farthest row drawn,
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
  v4 word token; **the score OG card repeats the in-game terminus — the accented display
  word in solved blue with its large blue square on the left — above the count and date**
  (decided 2026-08-08; the token carries that display word so the preview is self-contained).
  **The plain share text puts `🟦 <DISPLAY WORD IN LOCALE-AWARE UPPERCASE>` on its own
  line, with one blank line between it and both the named score headline and URL**
  (decided 2026-08-08; accents stay display accents, never a slug).
  Its tally ends on a one-shot scale pop (`score-land`, 2026-08-07) — the
  count is this screen's LAST beat, with no ruler colorize following it as in the sentence
  tray, so the number marks its own landing (never at 0, never on rehydration, collapsed
  under reduced motion). Identity is mode-addressed everywhere: `roundKeyForDay(day, lang,
  'word')` = `w:` keys into the store's own `wordRounds` map (persist **v7** since #163;
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
- **Route modal (#117, Part 3 of #115):** tapping a HOLE opens its neighborhood drawn as a
  journey. `game/route.ts` is the pure model (`buildRoute`, contract-tested) and
  `components/RouteModal.tsx` renders it; `Game` owns the open state so the guess prompt can
  go inert behind it. **Entry point only where the geometry exists:** `hasRoute` gates on the
  secret's rank-1 entry carrying `dq`, so every day published before #115 renders exactly as
  before — no button, no degraded list view. (The onboarding tutorial plays on a REAL
  generated board since #155; its ending shows that board's roads as THEME clouds in this
  map's own lane colors — see the onboarding bullet.) The hole
  becomes a `<button>` wrapping its existing spans; it is present for the WHOLE round or not
  at all and the solved choreography only `disabled`s it, because unwrapping mid-round would
  remount the word while its scramble is running. **That disabling covers the solving BEATS
  only — a settled solved screen keeps every hole tappable** (fixed 2026-07-27), which is what
  makes the reveal below reachable at all. `exploreDisabled` is therefore
  `!solvedSettled && (promptExiting || solved)`: `promptExiting` catches the start of the beats
  (the prompt leaves on the solving submit, while `solved` still trails the last word's settle)
  but is NEVER reset on a fresh solve — it doubles as "the input is retired" — so reading it as
  a plain veto left every hole dead for the rest of the screen, and the post-mortem was
  reachable only by RELOADING (the rehydrated branch does reset it).
  **Geometry — a LINE, not a to-scale map (redesigned 2026-07-26 on the user's call: the first
  version was "impossible to understand"; the reference is an SNCF trip).** That version put
  `dq` straight onto absolute positions over a 340svh band, which is faithful and unreadable:
  dq's real shape is a steep near field and a very long cold tail (rank 1 = 255, the start word
  ≈ 120, rank 10 000 = 0), so a linear map spends most of its height on emptiness — the
  departure landed two screens below the destination with nothing between them, and you had to
  scroll to find out where you were. The distance now lives in the **LENGTH OF THE CONNECTOR
  between two stations** — but only where the line SKIPS ranks. **Consecutive ranks are one row
  apart whatever their dq** (decided 2026-07-26): with every near-field group drawn, the rank
  ladder already says they are adjacent, so a proportional connector there buys nothing and costs
  one glaring outlier — dq pins rank 1 at the top of its scale, so 1 and 2 are always further apart
  than any other pair of neighbours. Out on the trunk, where the player's guesses are sparse, the
  length is the only thing carrying the distance and stays proportional
  (`linkHeight`: `LINK_SPAN` px per full dq scale, floored at `LINK_MIN`
  so neighbours never collide, capped at `LINK_MAX` so the cold tail cannot push the
  destination off screen). That is the SAME information — dq differences are all dq means — and
  on a real fr puzzle it took the map from **3.9 screens of mostly emptiness to ~1.0**. (It runs
  ~5 screens again now that the full roads are drawn — see the near field below — but every row is
  content: what was wrong with the first version was the empty space, not the length.)
  **The run from the merge into the terminus is SOLID** (decided 2026-08-04, superseding the
  dashed "identity leap"): the lanes JOIN at the converge junction and one solid line leads to
  the word — the routes should visibly LEAD to it, and a broken trace read as the line not
  quite reaching it. The cold end above the first station stays a broken trace (it is not a
  distance), and is **cut to a WHOLE number of the dash unit** (`dashedRun`, fixed 2026-07-27):
  the unit is 5px of line + 8px of nothing, declared once in `RouteModal` and handed to the
  gradient as `--dash` / `--dash-period`, and a run is `n` units PLUS its closing dash. Any other
  height cuts the last unit wherever it falls and the stub lands exactly where the trace meets the
  solid rail — `TAIL_H` 34 ended on 3px of gap against the first station, which reads as a
  rendering slip rather than a broken line. So its height is DERIVED (34 → 31), never typed
  (`LEAP_H`, now solid, is a plain 56). `--route-band-h`,
  the old lane geometry (`stopX`/`labelSide`/`laneNameFont`) and the axis contours are all gone
  with it.
  **The line is TRAVELLED, so it runs departure → arrival DOWN the page** (decided 2026-07-26):
  the off-map words at the top, then the broken tail, every station reached farthest first, and
  the word itself at the bottom. **The off-map shelf carries NO rule under it** (decided
  2026-08-05, dropping `.route-break` from both surfaces): the tail's own broken trace begins
  immediately below it, so a horizontal tear as well only fenced those words off from the
  distance they are already outside of. It **opens with the CLOSEST word you have reached sitting at the
  bottom edge**, a few pixels short of it (decided 2026-07-26): the ground you have covered fills the screen above it, and
  what is still ahead — the words closer than yours, and the destination — waits just below the
  fold. A solved hole has no "here", so it opens on the terminus instead. Measuring that row is
  the subtle part and the reason it is done with an inline `position: static`: it is the STICKY
  one, and a sticky box reports its PARKED position (offsetTop and its rect alike), so at
  scrollTop 0 it has already pinned itself to the bottom and measuring it there just hands back
  the viewport height. Suspending the stickiness for the read is safe because this is a layout
  effect — a synchronous write-read-write before paint, none of which reaches the screen.
  **`showModal()` is its OWN layout effect, and the FIRST one** (fixed 2026-07-27): a closed
  `<dialog>` is `display: none`, so until it opens there are no boxes to measure and the row's
  offsetTop/offsetHeight and the scrollport's clientHeight all read **0** — not a small error but
  a total one. A natural position of 0 makes EVERY scroll offset test as "parked at the top", so
  the torn separator sat under the row for the modal's whole life, and the opening scroll clamped
  to the top of the line. **Dev could not show it:** StrictMode re-runs layout effects after
  mount, by which point the dialog is open, so it only ever appeared in a build — check this one
  with `pnpm build` + `vite preview`, not `pnpm dev`. The parked test also carries a
  **1px `STICK_SLACK`**, because the opening view lands the row EXACTLY on the bottom threshold by
  design and sub-pixel scrollTop would otherwise decide the separator by coin toss.
  Every row lays out on the same three
  columns — the rank in a right-aligned gutter (the "time"), the rail, then the word — which is
  what makes the rail read as one unbroken line; each cell **names its grid column**, because an
  item with a definite ROW span is auto-placed BEFORE the fully-auto ones and leaving them
  implicit silently reorders the columns.
  **The map carries NO labels** (decided 2026-07-26, superseding the `ARRIVÉE` / `VOUS ÊTES ICI` /
  `DÉPART` / `ROUTES` tags tried the same day): every one of those is said by a node's size,
  fill and lane instead, and the only string left on it is `routeOffMap` — the words above the
  line have no node, no lane and no distance, so nothing about them can be read off the
  drawing. It reads **MISSED, untranslated in both languages** (decided 2026-08-05,
  superseding OFF THE MAP / HORS CARTE): those words are precisely the ones the round answered
  with the floating `MISS`, which is itself untranslated wherever it appears (the tutorial's fr
  copy included), so the shelf names them in vocabulary the player has already met instead of
  describing where they sit — one label in every language, like `you` and `dnf`. Its
  screen-reader mirror stays PROSE in the reader's own language (`srRouteOffMap`: "missed:" /
  « manqués : »), the rule every sr helper here follows. The screen-reader mirror still names
  all four in prose (`srRouteStop`), which is why dropping them costs no information. Fixed-width `???` is the ONE token for "you have not found
  this word": the destination and every censored station wear it.
  **What NAMES a stop depends on whether it is ON a road (decided 2026-08-06, and the rule for
  EVERY mode that draws a route):** on a road, its group's canonical accented form — that station
  was already drawn there, censored, before the player got near it, so naming it is the map naming
  its own census, which is the whole point of showing the roads' real length and population. OFF
  every road — out on the trunk — it is **the form the player TYPED**. Nothing was drawn there
  before the guess landed, so the stop IS the guess, and answering `portes` with the group's
  `porter` puts a word on the map that was never played, at a distance the player cannot account
  for; the inflection being the closer one is exactly what makes it read as a correction rather
  than as their own stop. It is the same rule the MISSED shelf has always followed, one step
  closer in, and no more a "displayed slug" than the shelf is — on this game the input produces
  folded slug characters only, so the typed form IS a display form (see `RouteModel.misses`).
  A trunk stop nobody typed falls back to the canonical form, which is what the departure and a
  `--no-roads` "you are here" take. Both surfaces obey it in their MODEL — `RouteStop.word`
  (`game/route.ts`) and `WordOutsideStop.word` (`game/wordBoard.ts`) — so the drawing, the sr
  mirror and any later view get it for free.
  **The censored near field is the WHOLE of it** (decided 2026-07-26, superseding the top-5 band):
  every group of it renders as a station with its word withheld, so each road shows its real
  **length and population** — the one thing a list of your own guesses can never say. Its extent
  is **entirely the DATA's**: the near field IS the road zone, and generation ends that at the
  **DEPARTURE** — the line is a journey and it begins where the puzzle put you down, so anything
  farther than the start word is behind you rather than ahead. That alone took a real fr map from
  ~8 screens to ~5. The bound has **ONE owner** (decided 2026-07-26, superseding the same day's
  first cut, where generation shipped a flat top-150 and `buildRoute` clipped it back here): the
  side that stops SHIPPING the roads is the side that decides where they end, so this module just
  reads `geometry.nearTop` and the clip is gone. The departure is **inside** the zone — you are
  put down on a road, so the fork is drawn just before it and its station sits on a lane (muted
  node, word dimmed to 62% in that lane's colour). The player's own guesses past it are still
  stops — they simply ride the trunk. The censored list ends one rank inside the departure for
  free, because the departure is itself a STOP and a stop is never listed twice. `APPROACH_TOP = 5` survives only as the FLOOR, for a
  `--no-roads` map that has no near field to bound and would otherwise draw none at all.
  **Solving REVEALS the whole neighborhood** (decided 2026-07-26): while the round is live a
  censored station is a position and a lane and nothing else (`RouteHidden.word` is `null`); once
  the hole is solved every one of them gives up its canonical form and the map becomes the
  post-mortem — each word in its ROAD's colour, so a secret's distinct senses finally read off the
  page, dimmed and on the small node so what you FOUND still stands apart from what was merely
  there. **The sr mirror enumerates what has a WORD and counts what does not**: the player's stops
  always, the revealed neighborhood once solved, and `srRouteRoads` ("100 stops across 3 roads
  (56 / 25 / 19), 4 found") standing in for the censored ones — ~100 items of "rank 87, hidden"
  would bury the words the player actually knows, and the count is what they say collectively.
  **Every node is a FILLED square** — outline-only stops were removed the same day. What a stop
  IS comes from size + fill: found `--fg` 15px, the handed-out departure `--muted` 15px with its
  word at 62% opacity (the map's quietest station — you were GIVEN it), "you are here" `--hole`
  gold 21px, an unfound approach station its own lane's colour at 11px, the terminus 23px
  (`--accent` once solved).
  **Roads are LANES of the rail, not a badge** (decided 2026-07-26, superseding the RER letters
  tried the same day — a small letter beside the word was too weak to read): the rail is as wide
  as the neighborhood has roads, a station sits on ITS road's lane, and the trunk forks into them
  (`Junction`) coming in from the far field and merges back out of them into the word. That is
  structural — you read a road off the shape of the line — and it makes the one fact a list
  cannot state visible for free: **a road nobody has reached is a lane with NO stations on it.**
  Both junctions keep the SAME fixed height, and the distance preceding the fork rides in front of
  it as an ordinary trunk link rather than being folded into it: absorbed, it made the junction as
  tall as whatever gap came before, leaving the first lane station far below the bus while the
  merge at the other end hugged its last one. The two ends of the fork have to mirror each other —
  15px from bus to station at both.
  Lane centres live in `routeDrawing` (`LANE_X0`/`laneGap`) because the node positions and the
  `--lane-lines` gradient that paints them must agree exactly — which is why EVERY consumer of a
  lane position goes through `laneX(road, lanes)` / `trunkX(lanes)` rather than doing the
  arithmetic itself. **Past `LANE_BUNDLE_FULL` (4) roads the bundle TIGHTENS instead of widening**
  (decided 2026-08-07, when `ROAD_KS` went to 6): the rail takes its width from the WORD column,
  and below ~360px there is none to give — at six lanes the rail ran 141px against 97, leaving
  ~67px of word column on a 320px screen, where a 9-letter station wrapped mid-word
  (`boisemen`/`t`). `fitWord` floors at `WORD_MIN_PX`, so past that floor the overflow has
  nowhere to go, and mid-word breaks are the one thing that module exists to prevent. So the
  lanes give way instead of the type: the bundle spans a constant `LANE_SPAN` whatever the road
  count and only the gap closes (22px at ≤ 4, 16.5 at five, 13.2 at six — still 8px between 5px
  lines). Verified at 320/430 with a synthetic 6-road board: six distinguishable lanes, no
  mid-word wrap, no horizontal overflow.
  Each lane is **as vivid as the
  rest of the app** (decided 2026-07-26, superseding a first muted set — a metro line's whole
  point is telling it from the next one at a glance): `LANE_COLORS` (one per road `ROAD_KS` can
  emit — **6 since 2026-08-07**, and `laneColors.test.ts` reads `ROAD_KS` out of `distances.py`
  to keep it that way, because a road past the last colour wraps around to lane 0's and draws
  two roads identically) takes far-apart hues from the **progress ramp's own stops**
  (`shared/progressColor.ts`) rather than inventing a palette, COPIED not imported, because that
  ramp means "progress" and these mean "identity". Copied means nothing catches drift, so
  `laneColors.test.ts` pins each hex to the stop it was taken from — pink 70, cyan 30, violet 90,
  green 40 (added 2026-07-27 on review; it immediately caught the violet as `#883beb` where its
  stop is `#883ceb`), then coral 60 and magenta 80. **The first four did not move**, so every map
  that forks 4 ways or fewer renders exactly as before; only three ramp stops were left to choose
  the new pair from, and it was MEASURED rather than eyeballed — coral + magenta hold a minimum
  CIE76 ΔE of 36.9 across the whole set, where either pairing with indigo collapses to 15.3
  (indigo sits on top of violet). That ΔE is also why magenta is admissible despite reading
  "pinkish" in the abstract: against pink it is 40+. If a stop is ever retuned the guard fails,
  and the choice gets made again
  on purpose rather than the map quietly speaking a stale palette.
  Pink leads, never cyan: lane A always holds
  rank 1 and cyan is what the heat ramp paints a rank-1 number, so leading with it would imply a
  rule that isn't one. Gold is "you" and blue is solved, so no lane may borrow either — and
  `--rail` stays the ONE unsaturated line on the map, because the trunk is exactly the stretch
  where no road has been identified. **A lane station's WORD is painted in its lane's colour too**
  (`--lane-c`, set per station; `.on-lane`) — the road then reads off the type as well as off the
  line, with nothing added — while a trunk word stays `--fg`, because above the fork there is no
  road to name. An UNFOUND station's node takes the same colour: a dark node on a vivid lane reads
  as the line being BROKEN, where the lane's own colour reads as a stop with no name on it yet.
  **Being ON a road and the line FORKING are different questions** (decided 2026-08-07): `onLane`
  is `road !== null` and nothing else, on BOTH surfaces. A neighborhood with a single honest facet
  ships ONE road, and gating the colour on `forked` drew that entire board in the colourless trunk
  treatment — a route rendered as if no route had been found. It is only the COLOUR at stake, since
  `laneX(0, 1)` and `trunkX(1)` are the same point. `forked` still gates the JUNCTIONS, where it
  belongs: one road has nothing to fork into, and drawing a fork would claim a structure the data
  does not have — so a one-road board is a single coloured line with no junction at either end.
  The real other side of the rule is `--no-roads`, where `road` is null: no road, so no colour.
  `WordBoard.test.tsx` pins both directions, because "always colour it" is the tempting
  simplification that breaks the second one. (The stricter road rules made single-road maps
  common — `pain` and `vie` both fall to one.)
  The junction **bus is painted in the lanes' colours, split at the trunk** (`busGradient`), not
  in one neutral bar: a single grey bar at each end of a set of parallel lines reads as a frame
  drawn AROUND them.
  The caveat this bullet used to carry — a real fr puzzle forking into one big road plus a
  1–2-group outlier, with the empty lane advertising that outlier as a whole road — is
  **ANSWERED as of 2026-08-07 and no longer an open question**: generation now folds an
  undersized cluster into its nearest neighbour before scoring the split
  (`ROAD_MIN_FRACTION` + `ROAD_MIN_GROUPS`, rules in the root `AGENTS.md`), so a lane the
  drawing paints always has a route's worth of stations on it. Nothing changed on this side —
  the fix belongs to the side that decides what a road IS.
  **Word sizes are computed, not measured:** Press Start 2P advances exactly **1em** per glyph
  (measured — the retired `GLYPH_EM = 1.37` was wrong), so `fitWord` shrinks a long word to
  `--wordw / length` rather than letting it break mid-word (`incontestableme/nt` reads as a
  different word). `--wordw` is the one number the CSS has to guess at: it subtracts an **18px
  allowance for a classic scrollbar**, which `100vw` cannot see and which would otherwise make the
  real column narrower than the size fitWord picked. **The rank gutter, by contrast, is MEASURED,
  not computed** (decided 2026-07-26): `.route` is ONE grid and every row a `subgrid` of it, so the
  gutter track is a true `max-content` sized by the widest exponent actually rendered, across all
  rows at once. Per-row grids cannot do that — each would fit its own rank and the rail would
  zigzag — which is why the rows must be subgrid rather than repeat the template. `--gutter`
  (`--rank-size × <widest exponent> + 10px`, set per-modal by RouteModal) survives for the two jobs
  a measured track cannot do: it is the **fallback template** declared before `subgrid`, so a
  browser without it degrades to a computed width instead of collapsing to one column, and it is
  the NUMBER `--wordw` and the parked row's backgrounds need. It also keeps the responsive trick —
  the char count is baked in as a literal while the cell size stays `--rank-size`, so the media
  query shrinks both together (10px → 9px below 360px) without the component knowing: a 17-letter
  word plus four wide roads genuinely does not fit a 320px screen otherwise. Verified no mid-word
  break at 320/360/390/430/900.
  **That `<widest exponent>` is the MAP's, never the LINE's** (decided 2026-08-06,
  `rankGutterChars` in `routeDrawing`, fed by `RouteModel.maxRank` / `WordBoardModel.maxRank`).
  It used to be the farthest station DRAWN, which is stable only until a guess lands farther
  out than anything on the line: the track is `minmax(var(--gutter), max-content)`, so a
  4-digit rank arriving on a word board whose field ends at 150 widened it and shoved the whole
  drawing — rail, lanes and words — one glyph right, mid-round. An exponent is a REPORT on a
  guess; it must not move the map the player is reading. Both geometries already walk every
  entry, so the farthest rank costs nothing to carry, and being a property of the PUZZLE it
  cannot change during a round. **Know the price:** generation caps every map at rank 10000, so
  the reservation is in practice a constant **6 glyphs (70px)** — where a word board at rest
  shows `-150` and would fit in 4 (50px). That is ~20px of gutter standing empty to hold one
  rank value (10000 is the ONLY 5-digit rank; 9000 ranks have 4). Reserving 5 glyphs instead
  would need the track to stop negotiating at all (a fixed `var(--gutter)`, letting a too-wide
  exponent hang left into the margin rather than push the line) — considered and NOT done,
  since it trades away the measured track's font-fallback safety.
  **"You are here" is STICKY on both edges** (decided 2026-07-26): the line can run several
  screens, and the one thing you always need while reading any part of it is where you stand, so
  the `best` row carries `position: sticky` on BOTH offsets — scroll below it and it parks at the
  top, scroll above it and it parks at the bottom, always at the edge it left by. It parks
  `STICK_INSET` px SHORT of that edge rather than flush against it (flush reads as clipped), which
  is one number in three places — the CSS offsets, the opening scroll and the parked test — so it
  lives in `RouteModal` and reaches CSS as `--stick-inset`. A strip fills that margin on the edge
  side: background, so no sliver of the rows sliding past shows through, carrying the lanes SOLID
  so the line still runs all the way out to the edge instead of stopping short of it.
  Its containing block is `.route`, i.e. the whole line, so it travels the entire map. Two things
  follow: it needs an opaque `--bg` to stay legible over the rows it floats above (free
  visually — the station draws its own cross-section of the rail, so the line still runs unbroken
  through it), and **`.route-scroll` may carry no VERTICAL padding**, because a sticky offset
  resolves against the scrollport's padding box and would park the row that far inside the real
  edge; the line's breathing room lives on `.route` as content instead. A solved hole has no
  `best`, so nothing sticks.
  **A parked row shows the GAP it is hiding** (decided 2026-07-26): pinned, the row is drawn hard
  against one it is nowhere near, with an unseen stretch of the line squeezed out between them, so
  the side facing that skipped ground gets **a torn separator — the same dashes a scrolling
  window's cut-off edge wears** (`.scroll-torn`), since both mean the map does not continue
  straight through there. Below when parked at
  the top, above when parked at the bottom, nothing when the row is simply where it lives (which
  includes the opening view). **`--stick-inset` is the row's ONE margin, used on both of its
  sides**: the same distance holds it off the screen edge and off the separator, so a parked row
  sits centred in its own clearance instead of leaning toward one side; beyond the separator that
  same margin again is what masks the rows really passing behind. The margin on the ROW's side
  still carries the lanes, so the roads run out of the station and INTO the separator: cut short
  they read as a second `--bg` margin, and the separator looks framed on both sides rather than
  ending the line. Two more details that are not decoration — the dashes' gaps are `--bg` rather
  than transparent (over scrolling content, transparent gaps show 3px slivers of what is
  underneath), and the pseudo-element states
  `box-sizing: content-box`, because the global `* { box-sizing: border-box }` does NOT match
  pseudo-elements: `height` there is the SEPARATOR and the borders are the margins, and assuming
  otherwise renders the whole band as one solid block.
  Knowing it is parked needs a scroll listener — the map's ONE piece of scroll JS, and still not
  motion: `readStuck` is arithmetic against `scrollTop` (asking the DOM would be circular, since a
  sticky box reports the parked position either way), and `setStuck` bails out on an unchanged
  value so the ~100-row list re-renders only on a transition. Its natural offset is re-measured
  whenever the model changes, because a guess landing while the map is open can add rows above it
  or make a different station the closest one.
  **The header is the APP's, not a modal's** (decided 2026-07-26) — and since 2026-07-27 it is
  the SHARED `ModalHeader` (see the app-header bullet below), which this map's own bar was
  extracted into when the leaderboard adopted it. It reuses
  `.topbar-inner` / `.topbar-left` / `.topbar-title` / `.topbar-right` / `.home-btn` wholesale,
  so it cannot drift from the corner-chip policy — no band, no border, no background, the
  hole's name top-left and one close control top-right. It sits **in flow** above an inner
  `.route-scroll`, which is precisely what lets it paint nothing: with the scroller (not the
  dialog) owning the overflow, no content can ever pass beneath the header, so none has to be
  hidden behind a band. Tapping the space AROUND the line does nothing since 2026-07-27 (see
  the modal-behaviour bullet): the close chip is the way out.
  **The LINE has no motion; the OPENING does** (decided 2026-07-27, superseding "no motion at
  all"): the map **zooms out of the word you tapped**, the way a desktop window opens out of its
  icon — the whole dialog, opaque background included, scales from ~0 with its
  `transform-origin` on that word's centre (`route-zoom`, 120ms — a tap opening a screen, not a
  transition worth watching; 200ms was tried first). It is the transition INTO the
  map, not part of the drawing: the screen that lands reads as that word opened rather than as a
  new screen that replaced it, which is also part of what makes the entry point legible (#129).
  `Game.openRoute` measures `.hole-word-wrap` inside the hole button at open time — the word,
  exponent excluded — and passes the viewport point, which is the fixed full-screen dialog's own
  coordinate space, so the CSS needs no arithmetic; a missing button falls back to dead centre.
  **A transform cannot disturb what this modal measures on open** — the sticky row's natural
  place and the opening scroll are read from `offsetTop`/`offsetHeight`/`clientHeight` in layout
  effects before it ever paints — and that was verified rather than assumed: on a 4.2-screen map
  the opening view is identical with the animation on and forced off.
  **Closing RETRACTS into the same word** (decided 2026-07-27, superseding the unanimated close):
  the map goes back where it came from, so the sentence underneath is somewhere you RETURNED to
  rather than somewhere you were dropped. That means the dialog has to outlive the dismissal —
  every route to a close (the X and **Escape**, whose `cancel` event is `preventDefault`ed
  precisely because a native dialog would otherwise vanish on the spot — a backdrop tap is NOT
  one of them since 2026-07-27, see the modal-behaviour bullet) only STARTS the exit; the real
  `dialog.close()` waits on the animation's `animationend`, with a deadline behind it
  (`EXIT_FALLBACK_MS`, in the shared `useModalDismiss` since both modals grew an animated
  dismissal) so a lost event can never lock the player inside a modal. `route-zoom-out` is written out as its OWN keyframes rather than
  `animation-direction: reverse` on the opening one: with the same `animation-name` a direction
  change UPDATES the running animation instead of starting one, and the opening run has long
  since finished — it would snap to its end state rather than play. It carries `forwards`, or the
  dialog flashes back to full size for the frame between the animation ending and React
  unmounting it. Reduced motion collapses both durations; the opening lands on the natural scale
  and the close still completes. Still **no new analytics event** — the three-event invariant
  stands.
  **"You are here" is read off the HOLE, never off the guess log** (fixed 2026-07-27): a guess
  deduped as a canonical duplicate never enters `tried` (`gameStore.recordGuess`) and can still
  IMPROVE another hole, so the current group can be one the history does not mention. `buildRoute`
  therefore looks the hole's own rank up and visits it as a stop; inferring it from the log and
  falling back to the closest logged one put the marker on a word the player had moved past — a
  rank-5 hole reading as its rank-104 departure, its current word censored `???` on the map while
  the sentence showed it.
  **The DEPARTURE is read off its stated RANK, never off the start word's slug** (fixed
  2026-07-28, the same shape as the note above — `buildRoute` takes `startRank`, and
  `hole.start.slug` now has no consumer at all). A slug is not an identity: `fold` drops accents,
  so `côté` and `coté` share the key `cote`, and a shared key belongs to the CLOSER group. When a
  hole prints an agreed form (#119) whose slug a closer group already owns, `alias_start_display`
  deliberately DECLINES to re-key it — typing it really is the closer distance, and that call is
  right and stays — so the shipped `start.slug` resolves to a group the player was never put down
  on. Looking the departure up that way drew it at that group's rank AND, because a stop renders
  with its word, NAMED it: on a board where nothing had been guessed, the map printed a rank-4
  word and lifted it out of the censored near field. That is the one thing the censored field
  exists to prevent, and the sentence's own exponent was right the whole time — `start_rank` is
  stated, unambiguous, and already what the sentence, the score and the progress all use.
  **The hole button is DESCRIBED, not LABELLED** (fixed 2026-07-27): an `aria-label` REPLACES the
  content it wraps, and that content — the word and its exponent — IS the clue, so labelling the
  button deleted it from the button and from the sentence a screen reader reads. The hint moved to
  `aria-describedby`, pointing at an sr-only note `Phrase` renders OUTSIDE the `<p>` (inside it,
  "Explore word 2" would interleave into the prose).
  **A road id may never BE an array length** (fixed 2026-07-27): ids come off the network, so
  `routeGeometry` allocates one lane per DISTINCT road present (`lanes`, ascending → generation's
  contiguous ids are unchanged) instead of sizing by `max id + 1`, where a well-formed
  `road: 4294967295` threw `RangeError`. `api.ts` caps the value too (`MAX_ROAD` 63) — generous on
  purpose, since a rejected puzzle costs the whole day.
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
  feedback in flight, no map over the sentence, `promptExiting` false, not solved. Everything
  else is the hole's own (`ticking`): its rank, its scramble, its hit, and whether it has a map
  to open at all — the wave is an affordance for the TAP, so a hole with no #115 geometry never
  ripples, and a hole locked at rank 0 never ripples in the game (`Hole.waveSolved`, default
  false, is the ONE exception: the tutorial's ending waves its solved word, because there the
  tap on that word IS the lesson — #155). A wave already in FLIGHT is cut when `ticking` drops, not merely when the hole's own
  `busy` does: `quiet` also falls when the map opens over the sentence, and a wave left running
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
  **It ENDS on the found word, teaching ROUTES (#155, decided 2026-08-03, superseding the
  stage-2 bakery sentence; ending refined the same day on findings):** analytics and feedback
  said the unguided second stage was widely skipped and the game is intuitive enough without
  it — its one lesson (a guess filling several holes) is discoverable in play — so cutting it
  freed the ending for the one concept nothing else teaches. Finding the word retires the
  prompt and DROPS the keyboard out of the tray (the game's own `kb-drop`). **The ending then
  opens on TWO beats, one idea each** (decided 2026-08-04): the CLAIM — "Plusieurs thèmes
  peuvent exister à travers le même mot." (`tutThemesIntro`) — with the tray's NEXT as its
  only control, and only once that is acknowledged the GESTURE — "Tu peux cliquer sur un mot
  pour découvrir ses thèmes.", **in the input device's own verb** ("tap" on a coarse pointer,
  "click" otherwise, the same `(pointer: coarse)` test as the streak hint,
  `tutTap`/`tutClick`) — which is where the word starts running #129's ambient wave and
  accepts a tap, the beat's only control. The claim is made before the evidence, and the
  clouds are the evidence. **The tap REPLACES the word with its THEMES, shown as CLOUDS of
  words ONE AT A TIME** (findings 2026-08-04, superseding first the inline route line and
  then its one-road-at-a-time variant — the line was too much information at once, where a
  cloud of themed words says "these belong together, this close" with nothing to decode):
  `tutorial/ThemeCloud.tsx` renders one theme — the map's road — as a cloud of its closest
  groups (capped at 12), words painted in that route's LANE color (imported from
  `RouteModal.LANE_COLORS`, so the lesson speaks the identity the game's map uses later),
  heat-ramp exponents on the board's own scale, type size falling with distance,
  width-capped by fitWord-style arithmetic (VT323 advances exactly 1em/glyph — measured) and
  HEIGHT-scaled to the viewport (the whole ramp shrinks on short screens so the view never
  scrolls — findings 2026-08-04). **A cloud CONDENSES and disperses**: every word scales up
  from nothing on its OWN random delay and scales back down the same way, so the cloud reads
  as a handful of things belonging together rather than a paragraph swapped for another
  (the delays are rolled once per cloud and are deliberately NOT index-derived — a
  left-to-right sweep reads as a list being filled in). The leaving cloud keeps the stage
  until it reports its last word gone (`onExited`, with `CLOUD_EXIT_FALLBACK_MS` as the
  deadline behind a lost report — the winner cancels the loser), so two clouds never overlap
  and the coach's next line arrives WITH its cloud; NEXT THEME is inert for that beat. Reduced motion
  collapses the durations and keeps the delays, so the words still arrive one by one. Never two clouds at once: the coach names each from the
  script's `themeCopyKeys` (`tutTheme1..4` — en names OCEAN's themes, fr TROPIQUES's;
  scripts.test.ts pins the list's length to the map's real road count), each headed
  **« Thème n/N : <name> »** (`themeHeading`, so the total comes from the board's real road
  count and no string restates it) with **the theme's NAME wearing the cloud's color**
  (CoachText's `[[t:]]` tag reads `--coach-theme-c`, set on the box by the Tutorial), a
  NEXT/SUIVANT press (`tutNext`, the one "go on" label the whole ending uses)
  swaps to the next — and each swap WAITS for the leaving cloud to report its last word gone
  (`ThemeCloud.onExited`, an `animationend` count with a deadline behind it, never a guessed
  duration, so nothing lands over a word still on screen). After the last theme the close
  shows **the ROUTES TEASER**
  (`tutorial/RoutesTeaser.tsx`: the themes' colored lines at the map's own lane rhythm,
  carrying EVERY near-field group out to rank 100 as a station — heat-colored rank exponent
  in a left gutter like the real map's, node on its lane, word beside it in the lane's
  colour. It reads the way the real map reads: DOWN the page from the far field to the word,
  so **`-1` sits at the BOTTOM**, and past the lanes' MERGE the WORD ITSELF closes the line —
  the lanes elbow onto a bus and ONE SOLID trunk leads down into the word's node (the real
  map's converge junction at the miniature's scale; solid since 2026-08-04, superseding the
  dashed identity leap, same decision as the modal's), the terminus in solved blue on the
  biggest node — so the routes visibly JOIN and LEAD to the word rather than running out
  (added 2026-08-04). It opens parked at
  that bottom, on the destination. It **SCROLLS** by drag/wheel; the chevrons that used to
  flank it were removed 2026-08-04 (one affordance per gesture, and their column was width the
  words needed at 320px), which also leaves the whole drawing decorative with nothing
  focusable in it. Two things say the line goes on: the squared-off scrollbar, and **the
  frame's own EDGES — whichever side still has line beyond it wears a TORN dashed rule**
  (decided 2026-08-04), the route map's 9px-on/9px-off break meaning the same thing here, so
  parked at the destination the top edge reads as cut off rather than as the end of the map
  (bottom edge scrolled to the far field; both in between). The rules sit just **OUTSIDE the
  window's edges**, never over it — inside, the tear covered the outermost station's row
  instead of marking where the window cuts. That is why the teaser is TWO
  boxes — a non-scrolling `.routes-teaser` frame around the `.teaser-scroll` scroller: a
  background paints beneath the stations and a pseudo-element inside a scroller scrolls away
  with them, so the rules can only live on a parent that stays put. **Both halves are SHARED
  since 2026-08-05** — the rules are the `.scroll-torn` utility and the scroll state is
  `hooks/useScrollEdges` — because Word mode's board (#156) needed the same edges and the
  parts worth keeping in one place are the details (the sub-pixel slack, the bail-out on an
  unchanged value, the resize listener). It **FILLS the play
  area's free height** — flex-basis 0 + min-height 0 so it can never grow the page, and
  deliberately NO max-height (a cap only opened a dead gap under the coach on tall screens,
  findings 2026-08-04) — and its
  width is DEFINITE, never
  fit-content, because `.teaser-map` is an inline-size container whose `cqw` word sizing
  would otherwise be circular. Its SCROLLBAR is the app's shared **`.pixel-scroll`** (defined
  beside `.sr-only`, and worn by the route map's own `.route-scroll` too since 2026-08-04):
  a flat rectangle in a flat channel, drawn with `::-webkit-scrollbar` — the standard
  `scrollbar-width` / `scrollbar-color` are confined to a Firefox-only `@supports` block,
  because since Chrome 121 either of them DISABLES those pseudo-elements and the standard bar
  cannot be squared off. Any scroller that wants the app's bar opts in with the class; one
  that does not is untouched. **VT323 advances exactly 1em per glyph** (measured; a 0.95
  guess clipped the longest words) and the floor is the route map's own 8px)
  under the general principle (`tutThemes` — "Chaque thème est un chemin sémantique
  différent à suivre.") while the tray offers
  **PLAY (`tutPlay`), which is the graduation**: `onDone`, no SolvedScreen (a lesson has no
  score to show, so `SolvedScreen`'s tutorial `action` prop and its null `dayNumber` are gone
  with it).
  **The ACTION BUTTON keeps ONE place for the whole lesson** (decided 2026-08-04): MIX, the
  ending's NEXT and PLAY are the same control in the same spot — parked against the tray's
  BOTTOM edge (`.mix-btn`'s `margin-top: auto`, which beats the tray's own centring), so the
  page's frame inset is its whole margin below and it sits the same distance from the bottom as
  from the left and right. That has to be stated as a rule because the tray's HEIGHT changes
  under it — the keyboard's full footprint while the word is on screen, the button's own height
  once the clouds replace it — so a button centred in the tray drifted: measured 87px above the
  bottom on the mix and claim beats against 24px on the themes (desktop), 54.5 against 14 on a
  phone, and the only control on screen jumped the moment the lesson moved on. On a phone the
  button carries its own +10px back to the 14px page inset (the same rule as
  `.tray.tray-results`, and the reason that offset lives on the BUTTON rather than on the themes
  tray's padding: the earlier beats need it inside a tray whose height must stay the
  keyboard's). The keyboard and the tray's transient loading/error lines keep the tray's
  centring — the auto margin moves the button only.
  **From the clouds on, the TRAY stops reserving the keyboard's footprint** (`tutorial--themes`
  on the root, decided 2026-08-04): the keyboard has dropped for good and the tray holds one
  button, so it shrinks to that button — which does NOT move it (it was already on the tray's
  bottom edge); only the space ABOVE it changes. The ~120px that
  empty footprint held goes to the clouds and the routes map, which are
  the screens short of height. It cannot start any EARLIER: while the word is still on screen
  the tray's fixed height is exactly what keeps the word from moving between beats, so the
  claim and gesture beats keep the full tray.
  The daily game's `RouteModal` is untouched (its drawing lives in an internal
  `RouteLine` on a `.route-frame` wrapper that owns the drawing's CSS variables — a #155
  refactor kept for its cleanliness; nothing outside the modal renders it).
  **The board's ranks are a REAL generated neighborhood, and have to be:** the themes ARE the
  map's #115 roads — the hand-authored ~22-entry map this replaced carried none — and the
  clouds step through them by road id. Each language embeds a #154
  single-word artifact (`pnpm gen:word`) PRUNED to the word + the road zone + the guided
  words, by `web/scripts/prune-word-map.mjs` — the exact command is recorded in each script's
  header, and `scripts.test.ts` fails if board and map ever drift. **en = OCEAN, fr =
  TROPIQUES**, both chosen on ROUTE legibility, and both a SINGLE definition (decided
  2026-08-04): the routes lesson is about FACETS of one idea, so the board's word must not be
  a homonym — PHARE (lighthouse / headlight) was replaced because its routes read as two
  definitions, and LIGHTHOUSE had already lost to ocean on a 135/15 road split. Tropiques'
  four roads — the climate, the islands, the globe, the holiday feel — are each nameable at a
  glance; en/fr symmetry stays a non-goal.
  **The guided words obey two findings-decided rules (2026-08-03/04):** the far guess stays
  on a READABLE scale — same order of magnitude as the start word, ≤ 500, guarded by
  `scripts.test.ts` (fr `désert^1183` read as noise) — AND must make intuitive sense as a
  somehow-close word (`casquette^330` did not; fr's is `neige^353` — snow is
  climate-adjacent and intuitively the anti-tropics, so "farther" feels right); a mix stop's
  word should likewise be an INTUITIVE neighbor (fr's second stop is `soleil^12`; the fr
  board is agreed SINGULAR — `--form tropiques=n:s` — because plural-agreed neighbors read
  oddly on a word board, findings 2026-08-04). Coach
  copy must fit the coach box's THREE lines at 320px — the routes and closer-guess strings
  were cut to size for it, and the ending's claim + instruction were SPLIT into two beats
  rather than trimmed into one (the box briefly went to four lines to hold the combined
  sentence, 2026-08-04, and went back the same day once it was split: splitting the idea beat
  growing the box).
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
  boxes (the route map's opening scroll is exactly that hazard).
  **Which exit each wears:** the route map RETRACTS INTO ITS WORD, because it belongs to that
  word; the leaderboard is a **SHEET** — up from the bottom edge to full screen, back down on
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
