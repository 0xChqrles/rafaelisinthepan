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
      hooks/puzzleCache.ts    the last 3 PARSED artifacts kept across mounts, no longer than the
                              CDN's own 300s (2026-09-11): today <-> tomorrow without a reload
      api.ts                  backend client: puzzleUrl, 404->NO PUZZLE, and
                              `readProfile` — the ONE place `GET /profile`'s four answers
                              (shown / blank / GONE / failed) are told apart (#204)
      identity.ts             the #216 DEVICE identity: a localStorage token minted on the
                              first deliberate act, the server-assigned account it resolves
                              to, the signed-out flag and the identity epoch
      state/identityScope.ts  what an identity OWNS, cleared when it changes (wired in main)
      state/localIdentityDeploy.ts  the username decided LOCALLY, deployed with the account
                              (2026-08-26): acquiring an identity stores the seed's assigned
                              face through an atomic create-only profile write (the editor's
                              SAVE exempt)
      state/gamePersistence.ts  the atomic IndexedDB boundary for cross-tab game-state writes
      state/signedOutVerdict.ts  the ONE spelling of the sign-out resolution every private
                              route client shares (401 + `unknown_device` code)
      screens/SignedOut.tsx   the `unknown_device` screen: what is left behind, RECONNECT (#204)
                              onto the email step, and PLAY (start over on a new account)
      screens/Account.tsx     `/account` (#204): the identity masthead row, the save state
                              (button, or the address), and — once SAVED — #216's devices.
                              The area's one door
      screens/AccountEmail.tsx  `/account/email` (SAVE) and `/account/signin` (RETURN) — one
                              engine, two declared intentions: address -> code -> bind/adopt,
                              the two-face crossroads, six face-led endings
      components/AccountMark.tsx  the ghost grid the returning door waits on, and the
                              cell-by-cell arrival that hands off to Avatar
      components/TopBar.tsx   the header row itself, mounted ONCE by App: it holds the
                              places on the right and hosts the left slot screens publish
                              into (`HeaderLeft`, `HeaderBack`)
      components/PuzzleTitle.tsx  what the game surfaces put there: the app's MARK
                              (`public/logo.png`) in the accent + the language CODE (+ the
                              day on an archive route), over the selection that switches it
      components/PuzzleSelect.tsx  that selection: a flat full screen holding the language's
                              picker DRUM, the pick landing on the fold (the caller decides
                              what a pick means, `onLang`); a back chevron in the header's
                              left slot
      hooks/useDrum.ts        the picker-drum physics both wheels turn on (drag, fling,
                              wheel, keys, the slot row)
      components/HeaderKeys.tsx  the header's right group: the SAME five keys on every
                              game surface (home · archive · board · rules · face),
                              the current place lit
      components/AccountKey.tsx  the fifth of them — the account's door in the daily loop
      components/CodeInput.tsx  the six-digit prompt: six drawn cells over ONE real input,
                              auto-verifying on the sixth digit
      components/AccountFace.tsx  the ONE read of "who an account is" (mark + name), shared
                              by the account screen, the flow's ending and the sign-out screen
      state/account.ts        what `/account` shows — the `{token}` summary and the
                              group-departure drain behind it (#271)
      state/groups.ts         the player's GROUPS (#271): the ONE transient cache every group
                              surface reads (tabs, marks, the landing's "already in")
      hooks/useGroupStanding.ts  the solved screen's standing read: one request, the group last
                              opened else the best standing (`pickStanding`)
      components/GroupStanding.tsx  the "2ND OF 7" line beside the score, a tap onto the board
      components/DeviceList.tsx  the account's devices + SIGN OUT rows (#216), on the profile editor
      components/ErrorScreen.tsx  the app's error surface: a FULL-SCREEN modal led by the
                              user-drawn ERROR BOT (2026-08-27, replacing the popup/sheet);
                              ONE quiet way out since 2026-09-03 — no TRY AGAIN
      state/roundSync.ts      the #201 sync engine, reworked by #214: coalesced prefix writes,
                            the transient server snapshot it publishes for the screen, the
                            outbox it settles by identity, cap + freeze, #203's round-start
                            challenge (one module-level conversation per round)
      game/playLog.ts         #214's pure projection: (server log + outbox) -> the play log
                              every client derivation reads, and the outbox remainder
      game/earlyPlay.ts       #273's lock: when tomorrow's round, played tonight, stops taking
                              guesses (first progress, or EARLY_GUESS_CAP) — read off the play log
      components/FlipCountdown.tsx  the clock that takes the keyboard's place while it is locked:
                              HH:MM:SS to the 22:00-ET flip
      state/history.ts        #211's PRIVATE history: the in-memory month/solved-day cache,
                              its one-flight-per-key reads, the explicit-loading status and
                              the streak credit a fresh solve rides
      hooks/useRoundSync.ts   its React binding: registers the round's context on mount and
                              reports WHERE its authoritative state is (the load gate)
      screens/Profile.tsx     the #188 profile editor (/profile): name, tap-to-paint 10×10 grid,
                              ground-swatch palette picker (#190 wires the entry point)
      screens/Privacy.tsx     `/privacy` (#229): what the game keeps, why, and how to be rid
                              of it — the app's one DOCUMENT, its words in privacyDoc.ts
      components/LangTitle.tsx  the header's OTHER clickable title: a screen's own name, the
                              LANGUAGE beside it in the archive day's dress, and the
                              one-drum `PuzzleSelect` behind it
      hooks/useUiLang.ts      the chrome language of a screen the URL names none for: the
                              link's `?lang=`, then the stored preference, then the browser
      screens/GroupInvite.tsx  the #271 group invite link's landing (/join/g/<groupId>): JOIN
                              with this device's token, then the board or the game. The link
                              members SHARE is /g/<groupId>, served by the backend for its preview
      components/ScopePager.tsx  WHICH BOARD (#271): the pager of scopes — every group, then
                              GLOBAL, one neighbour peeking in at each edge — swiped on
                              native scroll-snap, brackets on the middle page, dots under it
      components/GroupScreen.tsx  a group's own screen (#271): members (the owner's ✕),
                              INVITE, LEAVE — everything there is to do with a group
      components/GroupCreate.tsx  naming a new group (#271): the GAME'S PROMPT alone on the
                              screen, the name inked in on CREATE (the solve's beat)
      components/ConfirmScreen.tsx  the app's CONFIRMATION surface (#271): the error screen's
                              shape in the plain voice, the act as the quiet danger control
                              over CANCEL; the leave's successor picker rides it
      screens/Leaderboard.tsx the #190/#271 leaderboard (/<lang>/board): the player's
                              groups first (day / week / month), global top 50; NEW GROUP,
                              INVITE, LEAVE, the creator's MANAGE
      components/Avatar.tsx   a stored avatar rendered as SVG (editor preview + #190 board rows);
                              the tracer + the assigned identity are @whippin/shared's since 2026-08-20
      versionCheck.ts         stale-tab reload: __BUILD_ID__ vs /version.json on visibility flips
      timeout.ts              a fetch deadline as an AbortSignal — the ONE spelling, because
                              `AbortSignal.timeout()` is above the browser floor and throws
                              BEFORE the fetch (it took the #216 bootstrap out on iOS 15)
      i18n.ts                 UI chrome strings (en+fr), t(lang, key); parity type-enforced
      tutorial/               the tutorial (#51/#155/#269): Learn.tsx (the levels), Lesson.tsx,
                              LevelOne.tsx over LessonBoard.tsx, coach.ts (the reactive coach),
                              levels.ts + data scripts/<lang>.ts (+ <lang>.<word>.json, the
                              pruned #154 boards it plays on)
      screens/Game.tsx        the guess loop, hole state (imports fold from @whippin/shared)
      components/strikeArt.ts the three strike sheets and their animation contract (#301: the
                              sentence's holes land them)
      components/Strike.tsx   one blow of one sheet on a game word (was WordSlash)
      components/Loot.tsx     what a hit knocks off a game word: the rank exponent popping up
                              and falling away
      game/charge.ts          #301's hole CHARGE METER: the rank -> charge function, the replay
                              of the play log onto every hole's meter, the ACTIVATION and the
                              ranks it GIVES (2026-09-22)
      components/ChargeLoot.tsx  the blood a charging guess knocks out of the hole, gathered
                              onto the meter
      components/MeterCanvas.tsx  the meter's drawing: the chip converting as an ordered
                              dither, tweened — and the SEA of an active hole (the same
                              dither driven by value noise, `components/noise.ts`)
      game/scoring.ts         the SCREEN's reading: applyGuessToHoles + replayHoles +
                              computeProgress over RuntimeHoles (the arithmetic itself is
                              @whippin/shared's since #203)
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
      hooks/useLetterWave.ts  #129's ambient ripple on the holes
      game/history.ts         a hole's guess log ranked against its secret (buildHistory)
      game/wordWheel.ts       the order those words scroll through the tapped hole in
                              (wheelOrder): farther above, closer below, behind-the-start apart
      components/HistoryWheel.tsx  an OPEN hole's tap: a picker drum (`useDrum`) through the
                              word's own place — the word the wheel folds on is the sentence's
      components/HistoryModal.tsx  a COMPLETED hole's tap: its words as a plain grid, full
                              screen, as many columns as the width holds
      game/share.ts           what a RESULT says: the share text + link (emoji row, the
                              composed message)
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
       **"MISS"** instead of a distance (no rank exists beyond top-K), in the ramp's
       weird red terminus. `MISS_COLOR` (#ff3d2e) lives with the ramp in
       `@whippin/shared`, and `heatColor(0)` IS it. A 100-away exponent therefore wears
       the same colour as a MISS (the fixed absolute cap collapses every farther rank
       onto the terminus); only the label distinguishes them. It is legible on `--bg`,
       pinned by the heat tests. **It is NO LONGER distinct from the
       invalid `--danger` red, and that is deliberate (user-decided 2026-08-27):**
       `--danger` moved to the ERROR BOT's own ink `#ff2e38`, which sits 7.7 dE from
       MISS_COLOR — the two are one red now, where they used to be held ~31 apart, and no
       test pins the two reds apart. Re-separating them means moving MISS_COLOR, which is
       the heat ramp's terminus and takes `heat.test.ts` and the share card with it.
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
- **THE SENTENCE IS DISPLAYED IN SENTENCE CASE (user-decided 2026-09-08).** `words[]`
  stays lowercased in the schema; `game/sentenceCase.ts` is the display rule, applied by
  `Phrase`, `DissolvePhrase` (the swap must stay pixel-identical), the solved page and
  the hole WHEEL's slot row (`HistoryWheel`'s `capital`, the fourth renderer of the word —
  PR-272 review):
  the first token and every token after a sentence-final mark (`. ! ? …`, closing quote
  or bracket allowed) take a capital on their first LETTER, past an opening quote; a
  hole's PREFIX takes it when the hole has one (« T'attends »), else the hole's displayed
  word (`Hole`'s `capital`, on the letters path alone — never on the word the round
  compares, never on a slug or a keystroke). Proper nouns stay as stored: only
  generation keeping the source's case could restore them, a schema decision not made.
- **Solved holes (`rank === 0`) are locked:** excluded from the loop and rendered
  solved (accented secret, no exponent).
- **Feedback grammar:** under-the-input message = info about *what you typed* (only
  INVALID uses it now); on-hole floating number/"MISS" = info about *a hole*.
- **NEAR GUESSES CHARGE THE HOLE (#301, user-decided 2026-09-15).** Every COUNTED guess
  charges every UNSOLVED hole by its rank in that secret's map, best word or not
  (`game/charge.ts`): a CONTINUOUS function of the rank, never a table of bands —
  `28 − 26.5 × ln(rank) / ln(1000)`: 28 for the nearest word, the same 2.66 less every time
  the distance doubles, 1.5 at rank 1000; past 1000 / absent 0; rank 0 is the solve and
  pays nothing. (User-decided 2026-09-15: "words from 0 to 1000 should give you points", a
  rank-999 word included, and "use a function and not a table". CALIBRATED ON REAL ROUNDS
  to the user's targets — "around 25/30 (good and bad) tries", then "reduce this a bit, by
  maybe ~20%": half the holes a player is stuck on reveal by try ~37. `charge.test.ts` pins
  the stuck-hole mix, so a retune restates it — from production logs, never an assumed mix
  (the last assumed one put 55% of tries inside 250 where real play puts 20%). Keep the top
  this gentle: a steeper one activates the hole just before solves that were coming anyway;
  the three nearest words pay 77 together.) ONE meter per
  logical secret (repeated occurrences share it), capped at `CHARGE_TARGET` = 100, and
  reaching it ACTIVATES THE HOLE (user-decided 2026-09-22, REPLACING the secret's first
  letter — "it goes against the game core logic which is to guess with meaning not
  letters"): **the `GIVEN` = 10 words just above the hole's BEST word (ranks best+1 …
  best+10) are GIVEN — MASKED HINTS in the hole's tries — and every later guess that
  improves the best gives `GIVEN_LATER` = 1 more, the one just above the new best
  (calibrated the same day: "10 words everytime is maybe too much… for the next words it
  should be one word only"); windows accumulate and nothing given is ever withdrawn** ("10
  words above your closest", over "everything between your closest and the start"; the
  user checked the play data: "10 more words actually always give a better idea of the
  concept"). A full meter takes no more charge. **THE HINTS ARE MASKED, AND REVEALING ONE
  IS A GUESS (user-decided 2026-09-22: "making the hint words masked, and you can just
  select them with the wheel, it counts as a guess, but this way users who don't want help
  don't get penalized, and those who need help just increase their score in return… you
  manage your own pace")**: a masked hint is a foil block of FIXED width (the wheel's
  `MASK`, `?????` — never the word's length; "????? instead of nothing", same day) wearing
  its EXPONENT, so the player
  chooses which distance to spend a try on. **A mask turns through the wheel and is PICKED
  like any row** — fold on it and the sentence shows `?????²` on the hole's foil, display
  only (user-decided 2026-09-22 on the first cut, where the fold could not pick a mask
  and the hole snapped back to its best word: "it feels weird to have the closest word
  being back") — and **while the slot holds a mask a REVEAL KEY stands beside it**
  (`.wheel-reveal`: the KEYBOARD'S ENTER KEY transplanted — a flat solve-cobalt square the
  CHIP'S OWN HEIGHT, sharp, FLUSH against the sealed card's left edge so card and lock
  are one object in two inks, carrying the OPEN LOCK, `assets/icons/unlock.svg`, a mark
  on the header icons' 10×10 grid at its exact 20px; the chrome button of the first cut
  was "ugly as hell", the pixel word REVEAL gave way to the icon, and a tile floating a
  gap to the right read as a stray button — all user-reviewed the same day; the price is
  its description, "REVEAL · 1 TRY"), the one act that spends a try: `HistoryWheel`'s `onReveal` SUBMITS the stop's
  key (`HistoryStop.slug`) through the game's own `submit`, so the word enters the play
  log like any typed guess, counts as a try, charges the other holes, syncs, can hit
  another hole (its floats land on the sentence under the dim, which is the point: "we
  could see the hits on other words") — and the wheel stays open with the word in the
  slot; the fold then picks it (a re-pick at the same rank, by word). The slot row's own
  tap, a tap outside and Escape close as ever. A given rank the player had ALREADY
  reached is never given (they knew the word). **THE HINTS TAKEN are
  derived from the log** (`GivenRank.consumed`: a given rank guessed after it was given —
  typed by hand counts the same, "it's on them"; `hintsTaken` sums them over the distinct
  secrets) and NAMED ON THE RESULT under the tries, zero included (`.solved-score-hints`,
  `N HINTS` / `N INDICES`); the share card and token carry no hint count (a v7 token is a
  separate decision). No separate try/time gate, no charge-specific dedup or farming rule:
  the play log's own canonical identity is what a counted guess is. **DERIVED from the
  play log, never persisted — THE SERVER STORES NOTHING FOR IT** (the user's "store the
  closest rank at activation" was declined as a second copy of a fact the log states):
  `replayCharge` over the same log the board replays, so a reload or another device
  reconstructs the same meter, the same masked hints and the same count; `buildHistory`
  takes the given ranks and names them (`HistoryStop.given` / `masked` / `taken`: masked
  = no word, its rank and key alone; taken = the player's typed stop wearing the foil; the
  solve unmasks the untaken, still given — on the words grid a hint TAKEN wears the foil,
  one left on the table stands plain). Presentation (user-decided 2026-09-15, the third cut: "try
  something else than a progress bar"): THE
  CHIP CONVERTS TO THE SOLVE INK EDGE TO EDGE ACROSS THE WORD — `.hole-meter`, the chip's
  own box and layer: the white ground turns cobalt from the left behind the dark letters,
  the chip's whole height, AS AN ORDERED DITHER (`components/MeterCanvas.tsx`: Bayer 8×8
  thresholds on 2px cells, the density ramping over about a chip's height ahead of the
  front, cells lighting in threshold order as the front advances — a canvas, tweened in JS
  on the meter's own delay and travel; user-decided 2026-09-15, replacing a hard-edged sweep
  with a checker fringe, "a basic animation"; **the front is the reading's exact share of
  the width and the ramp trails BEHIND it, so a chip short of 100 always ends in white —
  only 100 inks it solid** (user-reported 2026-09-22: a ramp running past the edge read as
  full at 95, "some users think that there's a bug")), a full chip all cobalt (the ink the word
  wears once found); and then **THE SEA — THE ACTIVE HOLE'S OWN DRESS (user-decided
  2026-09-22: "a new kind of hole design… something between the full blue hole and the
  empty white one, with moving waves maybe, some perlin noise")**: the full chip RECEDES
  into HOLOGRAPHIC FOIL (**user-decided 2026-09-22, the fourth pass of the day — a
  dithered sea in both colour orders was "still hard to read", a smooth cobalt wash with a
  glow "a bit lame": "something more holographic like a pokemon card… make something
  really beautiful this time"**): FOUR LAYERS on the chip's white, every frame, under the
  dark ink (`MeterCanvas`'s `foil`) — a PASTEL SPECTRUM OF THE APP'S OWN INKS (user-asked
  the same day, "a more whippin AI friendly palette", replacing the full rainbow:
  `HOLO_INKS`, the hole's cyan → the solve cobalt → the ramp's orchid → coral and back, one
  seamless loop, each lifted `HOLO_PASTEL` = 42% toward white so the ink reads on every
  one; `HOLO_CYCLES` loops across the diagonal, drifting `HOLO_DRIFT`), MASKED by one
  octave of value noise (`components/noise.ts`,
  shared with `AccountMark`) scrolled through the word so it pools and swirls instead of
  sliding flat (the shimmer, `SHIMMER_*`, never below `SHIMMER_FLOOR` of `HOLO_ALPHA`), a
  white SHEEN sweeping the diagonal every `SHEEN_PERIOD_S`, and pixel-art four-point
  SPARKLES at hashed cells, EACH ON ITS OWN CLOCK — rising over 160ms, HELD 300ms, faded
  out over 550ms with an ease, arms first, centre last, a quarter of them long-armed,
  about five on a chip at a time (user-asked the same day: "each star be independant, it
  should not be a batch of stars", then "the stars should stay a bit before fading out…
  it's supposed to be chill, you're on a word game not an FPS") — and the
  SENTENCE's chip alone wears an IRIDESCENT box-shadow turning through the same inks —
  cyan → cobalt → orchid → coral — over 7s (`.hole-meter.sea`, `sea-glow`; static cobalt
  under reduced motion): the
  one lit thing on the board, by the user's call over the rebrand's no-gradient/no-glow
  rule. A listed given word carries the foil without the light. STEPPED at
  `SEA_FRAME_MS` = 80, ONE clock on every surface and **EVERY HOLE ITS OWN
  FOIL** (`seed` — the hole's index, a listed word's rank; user-decided the same day:
  "each hole should have a different seed"); it stands until the hole is inked in. A hole
  MOUNTED active (a reload) is on the foil at once, no burst, no recede. (The CSS class
  and prop are still `sea`, the name of the first cut.) **THE GIVEN WORDS
  WEAR THE SAME SEA WHEREVER THEY ARE LISTED** (user-decided 2026-09-22, "the given words
  should have the same effect on the guess list"): a `.wheel-given` row and a `.hw-given`
  word stand on the chip's white with the foil over it, dark ink, no print — ON THE WORD
  ALONE, the exponent standing clear on the ground, nudged past the box's overhang ("the
  exponent should be out of the background"; "it touches it") — so three grounds say three
  things with no label: the surface (typed), the foil (given — a masked hint is the foil
  under `?????`), the plain word (named by the solve). **THE WHEEL'S SLOT ROW NEVER
  MOVES**: the word the wheel holds wears the regular white chip, active hole or given
  word ("when wheel focused, a word should not have a moving background, just the regular
  white for a better UX") — except a MASKED hint in the slot, which keeps its foil: it is
  the thing the REVEAL button beside it opens.
  RETIRED with it: `.hole-initial` (the first-cell tile), `initialOf`, `srHoleInitial`, the
  `.spent` fade. Retired the same day, each on the
  user's review: a line along the chip's bottom edge and the band the chip grew for it (a
  bar); a level rising inside the chip with a lit surface row ("barely moves… the top
  border feels weird"); a superscript mark before the chip and a 16px tag on its corner
  (both "a left exponent"). **The cut is WHITE, at the strike art's full size, with its
  full hit (user-decided 2026-09-15 across three passes on the first cut: "always white",
  then "x3 bigger", then the full slash size with its shake and exponent animation)**:
  `--fg` through the mask at `.strike`'s own 5x / 4x with NO `.phrase` geometry; the recoil
  is the BLOW (`STRUCK_MS`, `strikeArt.ts`, as `--shake-ms`) and for that blow the chip
  INVERTS — ground `--bg`, ink `--fg` (`hole-invert`); and on a cut the rank is the LOOT
  exponent (`Loot`) instead of the float, which stays for a miss, a repeat and the solve. The SENTENCE's exponent is 0.75em
  (`--rank-size` on `.phrase` and the wheel's slot row; 0.55 where `.hole-rank` is
  reused). The sequence is `cut → BLOOD: drops fly out on their own
  arcs and SPLAT around and below the word, lie there a pause, then are GATHERED at the
  conversion's front, each with a trail → the front sweeps on` — a drop per 2.5 points of the
  hit's gain ("proportional to the progression") — on the hit's own stagger beat
  (user-decided 2026-09-15 in three passes — "a bit shy", "particles around the hole then
  gathered", "it should feel like blood… something physical that dropped onto the screen…
  a trail following their trajectory" — replacing one arc into the bar; ONE colour, the
  meter's, no opacity or tone per drop): the width moves on the guess's RELEASE (the
  deferred-board beat, `shownCharge`) and the fill's transition WAITS for the landing
  (`--meter-delay`, `sparkLandMs`), the burst and the sea waiting with it; at 100 `meter
  fills → BURST → the sea`, timed off `METER_MS` in `Hole`. The exact hit wears the ULTRA star and takes
  no cut, loot or burst (the solve supersedes); a miss, a repeat and a rank past the table
  keep the float alone; a guess that also improves the hole keeps the word/rank swap
  choreography (charging is additive). The sheets are `components/strikeArt.ts` +
  `Strike.tsx` (`.strike`, its own integer scales under `.phrase`; see THE HIT ART) —
  never the heat. A11y: the meter and the
  given words are the hole button's DESCRIPTION (`srHoleCharge` / `srHoleGiven`, sr-only
  spans outside the sentence like the exploration hints, never words in the prose); words
  given by a guess are also announced with it. Reduced motion keeps the state and snaps:
  no sparks, no fill travel, the sea holds one frame. Not done, deliberately: a second
  payout (the letter as a second fill was proposed and not taken), a manual hint button,
  a hint currency, adaptive thresholds.
- **THE PALETTE IS THREE INDEPENDENT AXES (user-decided 2026-08-17): weird/calm +
  hole/solve + accent — in STAMP-INK tones** (retuned the same day against the user's
  /inspiration set — vintage offset stamps, riso posters — after the first calm cut went
  dusty-grey and read "almost creepy": real printed-ink chroma, cobalt/orange/salmon/
  orchid/amber, with the grain and halftone carrying the calm; never arcade neon, never
  dishwater. The bullet's own earlier drafts — iron thermal axis, electric hexes, dusty
  hexes — are all superseded).
  - **weird/calm** is the ONE gradient (`@whippin/shared` heat.ts): vivid RED (the weird
    terminus — and MISS, red again by the user's call once the scale grew one step past
    the yellow) through amber, coral and a strange rose-orchid, settling into the
    cobalt. The exponents, floats, run ruler and archive fills use it. Every rank renderer
    calls `rankHeatColor(rank)`, whose fixed logarithmic `HIT_HEAT_CAP = 100` lives in
    shared; a puzzle's start rank is never a colour denominator. No word ever wears a scale value (a live-heat held word was built
    and rejected on screen — the exponent drowned in a word wearing its own colour).
  - **hole/solve** is the WORD pair, one blue in two states: a HELD hole word is the
    PALE draft — `--hole` #aec1ff over its dashed OPEN-BLANK line
    (`.hole .hole-word-wrap::after` — anchored to the STATIC wrap, not the shaking word:
    the hit-shake rides `.hole-word` and a line anchored there shook with it,
    user-reported 2026-08-17; the wrap never moves, and a resolved hole never grows a
    blank. The app's "not yet" dash vocabulary;
    the unfound `???` terminus wears it too — the TUTORIAL deliberately not at all,
    user-decided 2026-08-17: MixWord's demo hole and the coach text's hint words are
    lesson props, not blanks to fill. It sits at the wrap's bottom edge) — and solving
    INKS IT IN: `--solve` #4a6aff cobalt, blank gone. The ink IS the gradient's calm terminus, so a
    solve lands exactly on the peace the scale runs toward. It paints everything
    reached: resolved holes (and the solved page's secrets), both termini found, the tutorial's `[[b:]]` secret (`.rt-target`) —
    and done-for-the-day strips/cells. The pale hole is strongly legible on `--bg`; the
    blank line and exponent carry the rest of the unresolved-state distinction.
  - **the ACCENT is POSTER VIOLET** — `--accent` #8f7bff (user-decided 2026-08-18,
    REMOVING the stamp orange outright — "keep the blue/violet palette for all accent
    and actions"; the hex is the ground's violet orb lifted to text contrast, chosen
    clear of the solve cobalt and the pale hole blue): the chrome (prompt caret, loading status, COPIED), the `+Ns` gain, the
    history "you are here" node, the streak, the source credit's headline, the
    standing's rank number. The keyboard's ENTER cap is the one exception, lit in a
    COBALT gradient (the macropad's "Publish" blue — submitting is the step toward the
    solve); the ground's old orange corner orb went cobalt with the accent. Never a
    scale value, never a word state.
  The palette tests pin the required legibility and reservations around MISS, solve and
  danger; retune those relationships deliberately, never by a
  copied stale hex.
  **The saturation level is the THIRD cut and it is the one that stuck** (user-iterated
  2026-08-17, same day): dusty print tones read "almost creepy", the mid-saturation inks
  still "dull/dead" — the /inspiration stamps are genuinely VIVID inks, so the palette
  is now fully saturated print colour, and the CALM comes from the textures, the paper
  fg and the static ground, never from muting the ink.
- **THE REBRAND (user-decided 2026-09-01, THE STANDING VISUAL RULE — it supersedes the
  2026-08-17 stamp-ink dressing and both grain cuts wherever older prose below describes
  textures, glows, auras, washes or corner tabs): SIMPLE, CLEAN, BASIC. Clean shapes,
  clear contrasts, saturated vivid colours only where they mean something.** Concretely:
  - **The GROUND is ONE FLAT near-black sheet** — `--bg` #050507, no texture, no
    gradients, no ambient anything (the halftone dots, the sky glow, the corner orbs and
    the grain are all gone; the grain shipped twice and was dropped as "ugly as hell").
  - **`--fg` is PLAIN WHITE** #ffffff (the warm stamp-paper #f4f1e8 is retired), `--muted`
    a neutral cool grey #a6adb8, the hairline/glass tokens white-based, the surfaces
    neutral dark (#14151c / #1f212a). `shared/src/cardSvg.ts` MIRRORS bg/fg/muted — a
    palette move edits both, and `heat.test.ts`'s BG_LUMINANCE + `AccountMark.test.ts`'s
    GROUND pin the shared value.
  - **ONE GAME ACCENT, and it is the SOLVE COBALT** (user-decided 2026-09-01, third
    pass: "the solved word color, which should be the game accent color"): `--accent` is
    #4a6aff = `--solve`, retiring the violet #8f7bff of 2026-08-18. The prompt's chevron
    and cursor, the statuses, COPIED, the +Ns gain, the streak, the credit headline, the
    rank number and every solved word/trophy/terminus/LED are the same blue — and it is
    still the heat ramp's calm terminus, so the ruler, the archive fills and the OG card
    agree with it. The history line's "you are here" square moved to `--hole` so the
    marker and the terminus it walks toward stay two colours.
  - **A HELD WORD IN THE SENTENCE IS AN INVERTED CHIP** (user-decided 2026-09-01, the pass
    after the colour walk below): `--fg` ground, `--bg` ink, 4px/6px of padding — the app's
    one emphasis gesture, spent on the thing the round is actually about, and a solve INKS
    IT IN (the chip goes, the cobalt word stands free). **THE PADDING IS DRAWN, NEVER LAID
    OUT**: the chip is an absolutely positioned pseudo on `.hole-word`, so it takes only
    space the phrase already holds — a Press Start 2P cell is a full 1em, so it eats a fifth
    of a word gap — and removing it at the solve cannot move one letter of any other word.
    *Verified by toggling the chip off and diffing every `offsetLeft/Top/Width` in the
    phrase: zero boxes move, at both breakpoints.* Three details are load-bearing and each
    was found on the screen:
    - **sized in `em`**, not px — a fixed 4px made the chip 23.75px inside the phone's
      23.6px line box, so two holes on consecutive lines fused into one white block;
    - **centred, not `inset`** — `.hole-word` is an inline box 1em tall at rest and an
      inline-BLOCK a full line-height tall while `.hit-shake` runs (a transform needs one),
      so an inset chip grew by the leading, 15px, on every hit. Both boxes share a centre;
    - **it rides the WORD, not the static `.hole-word-wrap`** (where the retired blank
      lived), so the shake carries it — the ink is `--bg`, and a letter outside the chip
      would be an invisible letter.
    **The TAIL clears it visually**: the exponent's box starts 1px past the word, so the
    overhang swallowed a third of the digit on desktop and over half on a phone — it and any
    trailing punctuation are `translate`d clear, a translate and never a margin, because a
    margin is layout. The tutorial's MixWord wears the chip too (same `.hole` markup, and
    the lesson should look like the board).
  - **`--hole` is VIVID CYAN #00e5ff, and after the chip it lives on the HISTORY LINE** —
    the ink of "the words you hold" there, and the `???` terminus (fourth pass the same day:
    pastel #aec1ff and azure #38b6ff were too close to the solve; green #3ddc84 was far
    enough but "means valid, the opposite of the hole's purpose"). Cyan is the game's own
    cool family and sits on no heat-ramp stop, so an exponent never matches its word: dE 96
    from the cobalt, 103 from the orchid exponents, 13.2:1 on the ground. **The dashed
    OPEN-BLANK underline is retired** — under the hole words AND the route terminus's `???`.
  - **The PROMPT wears the SENTENCE's size** (user-decided 2026-09-01, superseding the flat
    24px of 2026-08-06): `.word-input` carries `.phrase`'s exact clamp at both breakpoints
    — the two move together.
  - **DECORATIVE LIGHT IS GONE**: the game words' soft currentColor aura (the hard 2px
    print stays — it is legibility), the LED self-glows (mosaic cells, meter cells,
    button LEDs, the sheet tick, the code-cell ink glow, the danger-note LED), the ENTER
    key's lamp shadow, the keyboard plate's cobalt wash, the chooser/invite logo aura and
    the dialogs' cobalt CORNER TABS (a coach box is a plain hairline glass box now). An
    LED is a flat vivid square; a key is a flat vivid tile.
  - **HEADER ICONS SIT AT FULL `--fg` even when not selected**, and **THE LIT PLACE IS A
    DOT THAT TRAVELS** (user-decided 2026-09-01, replacing the held chip and the hover
    chip: "not a large square background but a small dot below them, and this dot should
    move with a translation animation rather than appearing or disappearing"; refined the
    same day: "the hover should have a secondary color dot while the selected page keeps
    its fg dot, and on click the fg dot lands above the secondary dot"). TWO dots under
    `HeaderKeys`' `.hk-row`, positioned by measurement and moved by `transform`
    transitions: the FG dot marks the lit place; the `--muted` dot answers a mouse hover
    and slides back UNDER the fg dot on leave (stacked at rest, so one shows), and it
    travels onto the secondary dot already waiting under the newly lit place. Two things
    changed with the 2026-09-02 hoist (below), both user-decided:
    **the fg dot's module-level last-x MEMORY IS GONE** — it existed because every
    navigation rebuilt this row, and the row is mounted once now, so the travel is simply
    what a changed `on` does to a component that never left; and **the hover dot is not
    RENDERED without a mouse** (`matchMedia('(hover: hover)')`, read once) — nothing on a
    touch device can ever move it, so it sat parked under the lit dot drawing a `--muted`
    square for no one.
    **The dot hangs a fixed 7px UNDER THE DRAWING, not off the key box**
    (user-reported: "a bit too close to the icons"). A key is `--hud-height` tall around a
    20px icon and that height steps down twice on narrow phones while the icon does not, so
    a fixed `bottom` measured the gap from the wrong edge and it shrank with the screen —
    measured 4px at 38, 1px at 32 and touching at 30. `.hk-dot` states the GAP and derives
    its offset (`--hk-icon` / `--hk-gap` / `--hk-size`); the 340px step-down now only makes
    the dot smaller, where it used to restate the position.
  - **THE BUTTONS ARE ONE SHAPE IN ONE COLOUR AT THREE STRENGTHS (user-specified
    2026-09-14, the FIFTH design, superseding the keycaps of the same day, the cobalt slab
    below and the device card before it: "something flat with a colored border, the same
    color in the background but with less opacity, and the text in the border color…
    derive the other buttons from it, and avoid heavy UI elements that complexify the
    screen, such as underline or box shadow").** `index.css` "BUTTONS, FIFTH DESIGN": a
    1px border in `--btn`, a wash of `--btn` at `--wash` (14%) behind it, the label in
    `--btn`, sharp (2px), 13px/700 mono tracked, 40px of air a side, 48px tall. PRIMARY
    `--btn` = the accent (`.btn-primary`, `.mix-btn` in the deploy geometry — full width,
    430 max, 52 tall); SECONDARY = `--fg` at a 45% border and a 6% wash; DANGER
    (`.btn-danger`) = the danger ink. Hover deepens the wash, a press deepens it more —
    a press is a STATE, nothing travels, no shadow, no underline. **THE WORD**: a
    secondary directly under a primary (`.btn-primary + .btn-secondary`, `.mix-btn +
    .btn-secondary`) and every quiet act (`.link-quiet-btn`, `.link-danger`) is the label
    alone at 0.7 strength, lifted to 1 on hover — nothing drawn that is not the word. The
    result row's TOMORROW beside SHARE (an equal, not an answer) and the COMPACT
    secondary (`.board-chip` EDIT, `.profile-clear`, `.device-signout`, `.device-retry`,
    40px tall) are the shape. SHARE is the primary on the result screen; the paired row
    narrows its air to 12px so both fit a phone. No other button dress remains.
    *(The two paragraphs below are the designs it replaced, kept for their reasoning.)*
  - **THE BUTTONS ARE KEYCAPS WITH A HARD PRINT (user-decided 2026-09-14: "we should
    completely update the buttons design, they're really ugly and boring" — the THIRD
    design, superseding the flat cobalt slab below and the device card before it;
    SUPERSEDED the same day by the fifth design above).** One
    geometry, three caps (`index.css`, "BUTTONS, THIRD DESIGN"): a sharp tile with a 4px
    hard print offset down-right — the 1-bit drop shadow the app's sprites already carry —
    and a press pushes the cap onto its print (the cap travels 4px, the print collapses:
    the one motion a hard print makes physical; it is the deliberate exception to "a press
    is a state, not travel"). PRIMARY = the held word as a button: `--fg` ground, `--bg`
    ink, the print in the accent (cobalt under the hole chip's ground — `.btn-primary`,
    `.mix-btn` in the deploy geometry). SECONDARY = the keyboard's letter tile: `--surface`
    ground, hairline, `--fg` ink, a grey print. DANGER (`.btn-danger`) = the secondary in
    the danger ink. The QUIET WORD (`.link-quiet-btn`, `.link-danger`) is a bare tracked
    word on a 2px print line — no cap. Sized to the word, 40px of side padding
    (user-reported 2026-09-14: CREATE "very narrow" at 28; the ≤380px 12px override is
    gone). **A SECONDARY DIRECTLY UNDER A PRIMARY IS THE QUIET WORD, everywhere the same**
    (user-decided 2026-09-14: "when a label button is below a bigger button it always has
    the same underline design" — `.btn-primary + .btn-secondary`, `.mix-btn +
    .btn-secondary`, restating `.link-quiet-btn`'s dress so the sibling rule wins over the
    cap's; the result row's TOMORROW beside SHARE is the one sibling that stays a cap, an
    equal, not an answer). SHARE is the PRIMARY cap on the result screen. The COMPACT CAP
    (`.board-chip` EDIT, `.profile-clear`, `.device-signout`, `.device-retry`) is the
    secondary tile at a row's size with a 3px print. No other button dress remains: the
    header keys, the calendar arrows and the game's own controls are not buttons of this
    system. `--accent-deep` and `polished` are no longer read by any button (the
    derivation stays for whatever next wants it).
    *(The paragraph below is the 2026-09-01 design it replaced.)*
  - **THE PRIMARY BUTTON IS THE ACCENT, FLAT, WITH A DISCREET DIAGONAL GRADIENT**
    (user-decided 2026-09-01, superseding the 2026-08-18 device card — glass, hairline,
    LED, all gone; SUPERSEDED 2026-09-14 by the keycaps above): `linear-gradient(135deg, --accent, --accent-deep)`, where
    `--accent-deep` is DERIVED at startup by **`polished.darken(0.07, --accent)`**
    (`src/theme.ts`, installed from `main.tsx`; `polished` joined the dependencies for
    it) — never a second typed hex, so retuning the accent moves the whole button. White
    bold label, no border, hover brightens, a press is a state. `.btn-primary` and
    `.mix-btn` share it.
- **THE TYPE SYSTEM IS TWO VOICES — PIXEL ONLY WHERE YOU PLAY (user-decided
  2026-08-18, closing the redesign's deferred fonts half; walked from three voices to
  two on the user's same-day reviews — Inter "no soul" → Space Grotesk, then the grotesk
  AND the Instrument Serif display face both retired for ONE mono).** All faces
  self-hosted (`assets/fonts/`, latin + latin-ext subsets so French accents never fall
  back).
  - **PIXEL (Press Start 2P)** is reserved for the PLAY surfaces: the sentence and its holes, the prompt/input and its hint, the keyboard (keys + its `.kb-icon` pixel
    enter/backspace), the floating hits, the loot, the strike sheets, the CellDigits
    watermark, MixWord — and, since the same day's later passes, the whole SOLVED STACK's data:
    the result count (`.solved-score-num`), the ENTIRE standing line (labels, the
    accent rank number AND the TOP badge — one face, so `standingUnits` is back to
    rank-digits-count-DOUBLE with one unit = one label glyph), the SOURCE CREDIT (both
    lines — the source is the puzzle's content, not chrome, and it is EXEMPT from the
    all-caps chrome rule: quoted content keeps its own casing, the code-uppercased KIND
    carrying the phrase contrast), the run ruler's tick numbers, and the streak
    celebration's digits (wheel slots at the pixel
    1em advance, the flame's HARD 6px indigo underprint restored — a soft glow clips
    square inside the overflow-hidden slots). **Every monospace layout assumption therefore still holds** — MixWord's ch
    reservations and CellDigits' grid sit on surfaces that stayed pixel. The coach text's inline `[[b:]]`/`[[w:]]` words are
    pixel at 0.82em INSIDE modern copy — game words quoted in chrome.
  - **MONO (Azeret Mono variable 100-900, `--ui`)** is EVERYTHING else — body default,
    header (title/date), buttons, coach copy, the standing line,
    calendar, streak, statuses, and every moment the retired serif
    used to headline (chooser names, the invite title — the credit, the result numbers
    and the streak digits all moved ON to the pixel face the same day, see above). A monospace is tabular by construction, so everything that ticks is stable
    for free. **The chrome is ALL-CAPS (user-decided 2026-08-18) — every mono surface wears
    `text-transform: uppercase` EXCEPT the coach/dialog copy**, which stays sentence
    case and quotes its in-game words — `[[b:]]`, `[[w:]]` AND `[[m:]]` (the MISS words
    joined the same day, `.rt-miss`) — in the pixel face at 0.82em; the `.solved-by`
    lowercase `sourceBy` word is uppercased by the same rule, the phrase reading
    surviving in the word order. **Hierarchy is said in WEIGHT, never in families: light
    (275-300) for the big
    numbers, medium (500-550) for names and labels, bold (600-700) for actions**; resting
    body weight 400; `font-synthesis: none` app-wide (the pixel face ships one weight — a
    faux bold smears like a fractional scale).
  - **The modern chrome KIT rides three token groups on `:root`** — radii
    (`--r-sm/md/lg` = 2/3/4px), hairlines (`--line`/`--line-strong`), glass (`--glass`) —
    worn by every non-game box: aura-gradient chooser cards (cobalt/violet/orange by
    nth-child), glass coach dialogs (both gates + the tutorial), gradient-and-bloom
    primary buttons, the outlined TOP badge, glass result actions, calendar cells and
    week tiles. **THE DESIGN STAYS SHARP (user-decided 2026-08-18): 4px is the absolute
    radius ceiling — no pills, no circles anywhere in the chrome** (the SHARE pill, the
    TOP-badge pill and the rounded scrollbar thumb of the first cut are all squared back
    off; the run ruler's filament rounds at 3px).
    **ONE INK (user-decided the same day): chrome text and ICONS are `--fg`** — `--muted`
    survives only on GAME surfaces (the route drawing's dresses, the keyboard's control
    keys, the watermark) — with hierarchy carried by weight and opacity, never by a
    second grey; `--accent` keeps exactly its recorded accent roles.
    **AMENDED 2026-08-20 (user-decided, on the leaderboard's review): SECONDARY text
    and icons wear plain `--muted`, never `--fg` + opacity** — the board's rank
    numbers, unit/section captions, pseudonyms, the empty-state ghost, the invite
    confirmation's status line. Opacity remains an INTERACTION treatment (hover lifts,
    resting tabs), not a colour; the one place still dimmed by opacity is ink on the
    INVERTED selection box, where no secondary token exists (`--muted` on paper
    ground is near-invisible).
    The HEADER's icons were the LUCIDE stroke set as `.ui-icon`s (user-picked 2026-08-18:
    calendar, circle-help, x, fast-forward, and LANGUAGES — the 文/A translation mark —
    for the language control, replacing the globe; 24-grid, 1.8px, currentColor, 28px
    in-file size; globe.png and the standalone `.pixel-icon`
    class are deleted) **until 2026-09-02, when the whole chrome set went PIXEL** (see the
    header-keys bullet: marks on the avatar's own 10×10 grid); the Whippin mark is the USER-DRAWN `assets/logo.svg` since
    2026-08-18: cobalt with the cobalt-core/violet-halo AURA on the chooser and invite
    hero spots (it sat in the header, glowing, until the same day's header finalization —
    the mode tabs took its job and the mark left the bar). The BODY's global hard 2px
    text-shadow is gone; pixel surfaces that relied on it (floating hits, loot) carry
    their own, and the topbar wears a soft bloom shadow instead.
  - **THE VIEWPORT IS AN INSTRUMENT (user-decided 2026-08-18, from the user's
    /inspiration/modern board — "fresh and deep update"):** the content floats in the
    middle while decorative furniture clings to the edges.
    - **`components/DeviceFrame`** (mounted once in App, under every screen): four
      corner BRACKETS — the board's focused-card selection frame drawn around the whole
      app — a vertical `WHIPPIN AI ©2026` brand rail on the left edge, the localized
      tagline (`frameTagline`, the STRINGS table) bottom-left, and the day's EDITION
      SERIAL bottom-right (`N.<dayNumber>` — the interfaces.dev card's numbering, fed
      the ACTIVE day via useToday). Decorative (aria-hidden, pointer-events none),
      z-index 40 under the header's 60, covered by opaque dialogs, and DESKTOP ONLY
      (hidden ≤640px — a phone's viewport is all content).
    - **The KEYBOARD is FLAT (user-decided 2026-08-18, superseding the bevelled
      macropad keycaps the same day — "old skeuomorphism"):** every key is one solid
      dark tile at the sharp radius, nothing modelled, and **a press is a STATE, not
      travel** — brightness, never translateY (the rule the primary buttons follow
      too). **ENTER is the pad's ONE coloured key**: flat solve cobalt with the faint
      light it throws — a lamp, not a bevel — lit exactly when the input is a real word
      (`.kb-enter` vs `.kb-enter.kb-greyed`), so the board itself says "publishable".
      The flat rule's line: surface GRADIENTS, inset bevels and elevation shadows are
      out everywhere; LUMINOUS glows (the LEDs, the ruler bloom, the logo aura, the
      plate's cobalt wash) stay — they are light, not depth. Chrome icon strokes sit at
      2 (up from 1.8) for the flatter, more confident weight.
      On desktop the keys sit on a flat DEVICE PLATE (hairline + translucent fill, its
      cobalt wash kept, its inner shadow gone) — drawn OUT OF FLOW (`.keyboard::before`,
      inset past the keys) so `--kb-h` and the tray's fixed height stay exactly the
      keys' own; the plate hides with the phone's full-bleed keyboard. The keys' pixel
      glyphs and all key LOGIC are untouched.
    - **The INVERTED SELECTION BOX is the one emphasis gesture** (the board's
      highlighted headline word / selected list row) — and in the HEADER it is the
      ACTIVE TAB'S ALONE (user-decided 2026-08-18, third pass: with the glass band up,
      the filled title/date chips read heavy, so `.topbar-title` and `.puzzle-date`
      are plain bold foreground type now — one left-corner treatment still, just
      unfilled; the date keeps its ▾ and a whisper-chip hover as the archive-button
      affordance). **REVERSED 2026-09-02 (user-decided): the header's TITLE wears the
      chip again — see the header bullet's LEFT slot** (the band that made it read heavy
      is gone, and the chip is now the sentence's held-word gesture, not a tab marker). **AMENDED 2026-08-20 (user-decided, on the leaderboard's second
      review): a LEADERBOARD row does not take it either** — in a column of glass rows
      a solid foreground block shouted, and it left nothing quieter for the friend
      marker beside it, so both wear the ACCENT instead (see the #190 bullet). The
      gesture keeps every other place it holds. Elsewhere it stands: the result action INVERTS on hover;
      the invite title's last word sits in an `.invite-mark` box (Invite splits the
      localized copy on the final space, pulling one more token in when the tail is
      bare punctuation — French's ` ?`). **The DIALOG BOXES wear COBALT CORNER TABS**
      (user-decided 2026-08-18): `.coach` and `.coach-rules` are dead-sharp (radius 0)
      with short 2px cobalt brackets on all four corners — the device frame's bracket
      language on the one surface that talks to the player — drawn as eight background
      strips over the border box, the glass fill as the stack's colour layer. **The PRIMARY BUTTONS are DEVICE CARDS**
      (user-decided 2026-08-18, fourth button pass — the orange slab was "goofy", the
      paper block "still off", the chooser cards "very nice"): the member card's own
      dress as the app's one big action — dark glass, `--line-strong` hairline, bold
      mono, and a lit COBALT LED square before the label (`::before`; a disabled MIX
      unlights it). Hover brightens and the rule sharpens; pressing depresses. The
      keyboard's lit cobalt ENTER cap is the one resting patch of colour. The frame's tagline is the universal
      `MADE WITH <3` (user-picked, replacing the localized "a daily word game" — the
      `frameTagline` key is gone), and `.app`'s desktop side padding is 52px so content
      clears the frame's vertical rail. Coach copy is 16px at weight 350 (14px on
      phones).
  - **The RUN RULER kept its PER-TRY STEPPED CELLS (settled 2026-08-18 after a round
    trip):** a gradient-filament version and then a colourless flat rule each lived for
    part of the day and both were rejected — "remove the gradient, put back the old
    step by step colors" — so the drawing is the original: one flat cell per counted
    try at that try's `progressHeatColor`, dead sharp, 16px, filled by the result's tally
    (see the solved-screen bullet). What SURVIVES from the detour is the ticks' sentence
    indices in the PIXEL face. The bar therefore still matches the share card's stepped
    cells exactly.
- **A RANK IS WRITTEN BARE — no leading minus, anywhere (user-decided 2026-08-16).** A rank
  is a DISTANCE, and a distance is not negative; `sailor^87`, not `sailor^-87`. This is the
  app's ONE way of writing a rank, so it holds on every surface that shows one: the hole's exponent, the floating hit, the loot, the hole wheel and the words modal,
  the tutorial's mix demo and its coach text — and the curation CLI's `^N` output in
  `generation`, which echoes the same notation. Two widths follow it rather than being
  restated: `rankGutterChars` reserves the digits alone (one cell narrower than before), and
  `MixWord` reserves the landing rank's digits in `ch`. The screen-reader strings never had
  the minus (« à 87 » / "87 away"), so nothing there moved.

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
(decided 2026-07-25). The share card/text always name the unit.

---

## Do NOT

- **Don't hardcode `TOP_K` / 2000 in the front** — test map membership instead.

(Cross-package Do-NOTs — slug/fold divergence, fold/display separation, lemma-merge
containment — live in the root `AGENTS.md`.)

---

## Commands

```bash
pnpm dev        # dev server (set VITE_API_BASE_URL=http://localhost:8787 for the local backend)
pnpm build      # production build -> packages/web/dist (requires VITE_TURNSTILE_SITE_KEY)
pnpm typecheck  # tsc --noEmit
```

Front-end dev harnesses: `/<lang>/learn/1` opens the tutorial's level 1, `?streak=N` previews the
streak celebration, `?error=<variant>` previews the error screen against a real backdrop
(`dev/errorPreview.ts` — every variant is a real call site's copy; bare `?error` takes the
account one, closing CYCLES the set). All dev only — EXCEPT **`?keylog=1`** (`keylog.ts`,
2026-09-12), which works in PRODUCTION on purpose: it draws every raw event the guess prompt
and the on-screen keyboard receive, and the prompt's text after each, in a corner overlay,
so a player whose phone we cannot hold can send a screenshot that says which handler fired
and how often. There is **no `?puzzle=` file override** — the front
always loads the day's puzzle from the backend (test a specific puzzle by publishing
it to the local store — see `packages/backend/AGENTS.md`).

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Devices: per-device tokens, revocation, and where an account is created (#216).** The
  product contract — the token's exact shape, why an account is created lazily, what
  `unknown_device` means, what local state an identity owns — lives in the root `AGENTS.md`.
  What is this package's:
  - **`identity.ts` is the whole client half**, and it is a zustand store rather than a
    function: the signed-out screen and the header's face key both re-render on it.
    `deviceIdentity()` is the SYNCHRONOUS "should I even ask the server?" test every private
    read makes; `ensureDeviceIdentity()` is the ONE bootstrap flight (the `activeScoreFlights`
    pattern — two deploy taps landing in one tick, a PLAY while an invite accept is still
    in flight, must not mint two accounts);
    `ensureRequestIdentity(expectedEpoch)` is the private-request boundary — if resolving
    identity adopts B while the closure owns A's inputs, it returns nothing and no POST is
    made; `identityEpoch()` also fences every answer after its request is sent.
  - **The token is PERSISTED before the bootstrap request, and a token with no ids is NOT an
    identity.** That intermediate state is what makes a lost answer recoverable: the retry
    sends the SAME token, which is what the server's idempotence is keyed by. It reads as
    tokenless for the no-private-fetch rule.
    **A pending token is assumed empty only while its emptiness is PROVABLE** (PR-219
    round-2 and round-3 reviews): a token THIS session minted, with no attempt yet failed
    out of this tab's hands. A bare `{token}` read back from storage may be the residue of
    a bootstrap whose answer arrived and whose acts ran (only the completed identity's
    write failing behind it) — and a bootstrap attempt that FAILS releases the Web Lock
    with the token persisted, so another tab or session can recover it, complete it and
    act before the retry. Either way the proof is gone (`pendingUnproven`), and the
    eventual bootstrap publishes as an ADOPTION: the scope owner re-reads the tokenless
    projections instead of trusting ready-and-empty answers over real state. A SAVE into
    an account the profile editor did not load is guarded the same way — see the profile
    bullet.
  - **localStorage is shared by every TAB, so this module's copy is a CACHE of it** (added on
    review): `ensureDeviceIdentity` re-reads before minting, a `storage` listener adopts what
    another tab wrote, a pending token found there is adopted rather than replaced (two tabs
    retrying a first bootstrap then converges on ONE account, since the server is idempotent by
    token hash), and the sign-out paths remove the entry only while it is still theirs. The
    empty/empty race happens earlier than any pending write, so **one origin-wide Web Lock wraps
    the whole re-read → mint → bootstrap → commit sequence**; a waiter re-reads after entering
    and adopts the winner, while a browser without Web Locks fails before minting.
    `readStored` distinguishes UNREADABLE storage from EMPTY storage — the first says nothing
    about this device's identity, and collapsing them dropped one the session was playing on.
    A failed completed-identity write marks that identity SESSION-ONLY: a later readable empty
    value (or its own pending token) cannot dislodge it, knowingly sacrificing cross-tab removal
    for that identity until this tab leaves it. A token this tab authoritatively leaves is
    fenced in memory as well: even if conditional `removeItem` throws, START FRESH cannot
    re-adopt the stale revoked value it can still read.
  - **`state/identityScope.ts` clears on LEAVING an identity, never on acquiring one**
    (corrected on review): a bootstrap is triggered BY an act, so clearing there destroyed the
    guess in the outbox that asked for it. The change carries its PREVIOUS value for exactly that test.
    `App` keys every routed surface on the identity's scope revision, so component-local
    profile fields, board rows, invite outcomes and device rows are remounted too. Every
    transition except the first-ever acquisition advances it: A → null clears the old mount,
    and a later null → B remounts B's private reads; first bootstrap leaves it unchanged for
    the same reason it leaves the stores intact.
  - **Persist v16 DROPS the outbox**: it is owed to #187's retired
    identity, and the tokenless branch would otherwise pump a surviving outbox on the first
    page load — bootstrapping a brand-new account and filing another identity's guesses
    against it. **Persist v17 adds `identityOwner`** and `main.tsx` reconciles it against the
    loaded device before rendering: an owner on the same account keeps the outbox, and no proof
    drops it. An ownerless first act is kept
    only when `whippin-device` holds its pending bootstrap token, then bound to the returned
    identity; a missing/corrupt device key never turns old state into a new account's first act.
    **Persist v18 moves the same state into IndexedDB**; the retired v17 localStorage blob
    is NOT read (the standing no-back-compat rule — the brief import shipped with the first
    cut was removed on the PR review as the compatibility layer it is), so an existing
    device starts from the initial state once. `main.tsx` awaits hydration
    and the initial ownership transaction before mounting any private reader, under a
    startup DEADLINE that turns a stalled IndexedDB open into the visible startup failure
    rather than a permanently blank page.
  - **The tokenless branch is an ANSWER, not a loading state.** `roundSync` publishes a
    ready-and-empty authoritative round and `state/history.ts` a ready empty month and
    collection, so nothing breathes behind a request nobody made — the same rule #211's
    explicit-loading bullet states for a month that has not arrived.
    **An ADOPTED first identity RE-ARMS those answers** (PR-219 review): the tokenless
    projections were about a device with no account, and an identity adopted from another
    tab (`IdentityChange.adopted` — a storage event, the pre-mint re-read, losing the
    bootstrap race, or a pending bootstrap RECOVERED from storage; never a token this
    session itself minted, whose account is empty by construction) may already own rounds
    and history — while a first acquisition bumps no scope revision, so nothing else would ever
    re-read them. `identityScope` calls `rearmRoundSync` (the open
    conversations start over with a read, the republish reset's shape) and
    `rearmPlayerHistory` (replays exactly the reads the tokenless branch answered). A
    RE-ARM, never a clear: the outbox holds what THIS device played, owed to the adopted
    account.
  - **THE USERNAME IS DEPLOYED, NOT SWAPPED (`state/localIdentityDeploy.ts`,
    user-decided 2026-08-26 — the root `AGENTS.md` #216 section holds the decision):**
    on ANY identity acquisition the module reads the account's profile and, only when it
    answers 404 (even an empty-looking stored row is somebody's deliberate avatar-only
    save), POSTs the seed's assigned face — `anonName(localSeed)` + `defaultAvatar(localSeed)`
    via `ensureLocalSeed`, so the exact values the strip showed while tokenless become
    the stored row. That POST carries `createOnly: true`: the backend's store condition,
    not the preceding GET, atomically prevents the background deploy from replacing a row
    the editor or another device created in between; 409 `profile_exists` is the settled
    lost-race answer. The read keeps one uniform rule across minted AND adopted
    acquisitions (a recovered pending token's account may be empty too), and other write
    failures are best-effort: bounded retries (2), then silent fallback to the
    derived-from-accountId face, never surfaced. A 401 `unknown_device` instead goes
    through the shared signed-out-verdict helper and is not retried. It listens to the
    same identity-change signal identityScope does, wired beside it in `main.tsx` — so a
    future deploy trigger cannot forget it. The ONE exemption is the profile editor's
    SAVE: its own deploy carries the player's typed fields, so it wraps its bootstrap in
    `withoutLocalIdentityDeploy` to keep the placeholder from racing (and possibly
    overwriting) the save. Contract-tested (`localIdentityDeploy.test.ts`).
  - **Persisted game state is TRANSACTIONAL across tabs** (PR-219 final review, replacing
    rounds 2–3's snapshot merge). Zustand is now only the synchronous UI cache. Every
    persisted action emits an explicit domain mutation — append/acknowledge/discard one
    outbox, change one preference, reconcile one owner —
    and `state/gamePersistence.ts` applies it to the latest committed state inside ONE
    IndexedDB readwrite transaction. Overlapping transactions serialize origin-wide, so
    there is no get/merge/set gap, no lifetime “touched key” guess, and no stale full-state
    snapshot to clobber a sibling. Acknowledgement removes only the request snapshot and
    preserves concurrently appended guesses; terminal discard is a separate mutation;
    retention and ownership clears run against the complete committed maps; every
    account-owned mutation carries its expected owner, so a delayed write from A
    cannot enter B. A permanently failed transaction moves
    the whole session to memory-only persistence: later writes are not allowed to commit a
    suffix past the missing mutation and then roll the live cache backward.
    `installGameStoreSync` uses BroadcastChannel (storage-event fallback)
    only to refresh each tab's cache after commit — correctness never depends on delivery,
    because the next mutation re-reads inside the transaction. The adversarial suite uses
    two independent database connections and pins same-key writes, owner transitions,
    acknowledgement races, eviction and first-write seed.
  - **`markDeviceSignedOut` requires the request's identity epoch.** Every refusal caller reads
    the body and acts only on `401 unknown_device`; a 5xx, a dropped connection or any other
    4xx must never take a player's account away, and a late verdict for A must never remove B.
    The second authoritative caller is `DeviceList`: a successful self-revocation answer whose
    post-write list omits the calling row signs this tab out immediately.
    **It leaves the persisted TOMBSTONE** (user-decided 2026-08-24 — the durable/broadcast
    contract is the root `AGENTS.md`'s): the stored identity is replaced with
    `{signedOut, accountId, deviceId}`, `readStored` reads it as the third stored state,
    `syncFromStorage` raises the screen from it (matching identity or none; a mismatched one
    stands), `bootstrap` throws while `signedOut` is true, and `startFreshDevice` removes it —
    with an in-memory `dismissedTombstone` fence for the unwritable-storage case, the
    `departedTokens` shape for the tombstone.
  - **`state/identityScope.ts` holds the whole list of what an identity owns**, wired once
    from `main.tsx` rather than as import-time side effects in five modules — so `identity.ts`
    keeps knowing nothing about the game, and the list is one readable block.
  - **`SignedOut`'s RECONNECT was a PROP #216 passed none for** — a button that does nothing
    is worse than a screen that only offers what it can do — until #204 landed the email flow
    and wired it as the screen's PRIMARY action onto `/account/signin` (the account bullet
    below holds the reasoning). It is the screen's own handler now, not a prop.
  - **`components/DeviceList.tsx` is the REACHABLE surface for signing any device out**,
    mounted on the PROFILE editor — the screen that already is the identity screen. Every
    call answers the list as it now stands (the live routes' house rule), so a revocation needs no
    optimistic update, and the route's own correction for the index's lag means the screen
    compensates for nothing. Each row returns an opaque `revokeKey` and sends it back with its
    `deviceId`, letting the backend address the base item directly; signing out the current row
    raises `SignedOut` from that same authoritative answer.
  - **`crypto.subtle` is still required by every live POST** (corrected on review): #216
    removes it from the paths that need NO identity — the global board's own-window `id` and
    the (since retired) identity strip, which each carried a try/catch for the LAN-IP mobile check — but
    `api.postSignedJson` still signs each body for the OAC contract, so an insecure context
    cannot bootstrap. That boundary is older than #216 and unchanged by it.

- **Email account linking (#204), reworked to ONE PURPOSE PER SCREEN on 2026-08-26.** The
  SERVER-side contract — the one flow and its endings, when the account being left is
  deleted, the confirmations the route demands, the transfers, the allowances and codes —
  lives in the root `AGENTS.md`. The ACCOUNT AREA's product decisions are recorded HERE,
  first (moved from the root on its 2026-09-05 compaction), then what is this package's
  implementation:
  - **ACCOUNT-AREA PRODUCT DECISIONS (each user-decided on the date given):**
    - **ONE PURPOSE PER SCREEN (2026-08-26):** `/account` — *is this account mine, and
      safe?* (mark, name, when it began, EDIT out to the editor; SAVED or not; where it is
      signed in) · `/profile` — *how do others see me?* (the editor, nothing else) ·
      `/account/email` — *save it* / `/account/signin` — *get another one back*, one input
      per step. All GLOBAL routes. A flat `/account` over a 3-card hub. The
      leaderboard's EDIT chip is gone. RECONNECT lands on `/account/signin` directly.
    - **TWO DOORS ONTO ONE ENGINE (2026-08-27):** the declaration shapes the JOURNEY · the
      server shapes the DESTINATION · the ending tells the TRUTH about what happened. Nothing
      is detected or routed, and a player who picks the "wrong" door is never blocked and never
      lied to (the one ending a door cannot reach is BIND from SIGN IN — below). `/account` keeps
      its lit SAVE. **Its second door is GONE** (user-decided 2026-09-05: "if you want to sign
      in again, just log out your session and sign in, everybody knows this flow") — the quiet
      row under SAVE that read *I ALREADY HAVE AN ACCOUNT* / *SIGN IN TO ANOTHER ACCOUNT*, its
      two strings and its skeleton box with it; `/account/signin` is reached through the
      signed-out screen's RECONNECT alone (revoke this device in the list to get there), and
      SAVE with a known address ADOPTS that account anyway. **The address step states NO
      COST** (2026-09-03): the stakes are said
      on the crossroads, which IS the decision.
    - **THE WORDLESS TELL IS THE FACE; there is NO SECOND INK.** Saving keeps the real face
      on screen from the first step (it is the OBJECT of the sentence). Returning opens on an
      EMPTY 10×10 tile that churns through `AVATAR_PALETTES` on a slow value-noise field —
      every frame inside the palette, none of them yours yet — stays up THROUGH the code step,
      and RESOLVES in place, cell by cell, when the code lands, then hands off to `Avatar`;
      reduced motion holds one frame. The ending's copy follows the face in on a short
      cascade. The vol. 2 research's second flow ink was NOT taken.
    - **THE CODE PROMPT:** six drawn cells over ONE real input (paste, `one-time-code`
      autofill, screen readers); the SIXTH DIGIT SUBMITS — no CONFIRM anywhere in the flow. A
      filled cell lights in one of six avatar-palette inks (`CODE_INKS`, addressed into
      `AVATAR_PALETTES`), the next cell previewed at half strength; a refusal takes the WHOLE
      row red. A wrong code stays at the input (shake, clear, one attempts-left line). RESEND
      is quiet and countdown-gated (~30s), alone under the cells — CHANGE ADDRESS is gone,
      the header's back goes code → address.
    - **THE CROSSROADS, NOT A WARNING:** both accounts drawn — the one being left dimmed,
      under DELETED (the area's one red) or under its own NAME when merely left — the one
      being joined lit and NAMED; one sentence carries what survives and what does not
      (*Today's game comes with you. Your groups and the rest are lost.* — #271); from the SAVE door it gains the lead *That
      address already has an account.* Skipped when nothing is at stake. `would_switch` is
      the same crossroads with the red taken out: no stakes, *Nothing is deleted — this
      account stays saved under its own address.*, an ordinary lit SWITCH ACCOUNT.
      **DESTRUCTION NEVER GLOWS:** the erase button is the quiet variant in the danger ink.
    - **BINDING IS A CONSENT the RETURN door does not give** (2026-08-28): `no_account` is a
      note at the address field. **`account_linked` is a fact at the field, not a modal**,
      worded per door — SAVE: *This account is already saved under another address.*; SIGN
      IN: *No account is saved at that address.*
    - **FIVE ENDINGS, not six** (2026-08-28, when binding became a consent): SAVE+bound
      *Account saved.* with the address under the face · SAVE+already_bound *Already saved to
      this address.* · RETURN+adopted *We found your account.* with the RECEIPT and PLAY ·
      RETURN+already_bound *You're already on this account.* · an adopt from either door
      composes the new face. **RETURN+bound does not exist**: `AccountEmail` sends
      `bind: !returning`, so the SIGN IN door never reaches the bind branch and an unknown
      address there is `no_account` at the field. **The recovery ending prints the same three
      numbers `/account` prints** (`AccountStats`). **Every successful ending is a DEAD
      STOP** — no TRY ANOTHER ADDRESS.
    - **THE ACCOUNT SCREEN STATES WHAT THE ACCOUNT IS (2026-08-28):** the live STREAK, the
      BEST it has held, its total DAYS — ACROSS EVERY LANGUAGE, by the
      ONE aggregation the root `AGENTS.md` records for `accountStakes` (streak = MAX of the
      live streaks, best = MAX of the best streaks, days = SUM of the collections; never a sum
      of streaks), computed here by `useAccountStats` from `bestStreak`/`currentStreak` in
      `shared/src/history.ts`, so the screen and the confirmations print one number. Zeros
      are DRAWN, never hidden; values are withheld only while collections are in flight; the
      DEVICES stay gated on SAVED. (The account's AGE line — `createdAt`, falling back to
      `gameStore.localSeedAt` — was DROPPED 2026-09-05, user-decided, and the saved ADDRESS
      took its place and dress under the name, `.account-id-mail`; `localSeedAt` left the
      store with it.) One word per
      number, shared with the confirmations (STREAK untranslated, `statDays`). The streak
      moved here FROM the archive, which now reads its month with `collection: false`.
    - **SMALL TYPE HAS THREE ROLES (2026-08-29):** INFO sentence case · muted · regular · no
      mark; ERROR sentence case · danger · medium · a danger LED before it; ACTION uppercase ·
      `--fg` · bold · a finger's target. `.btn-secondary` grew a button's padding and weight
      APP-WIDE for the same reason.
    - **A TITLED SCREEN GOES BACK FROM ITS TITLE (2026-08-29):** a `HeaderBack` in the LEFT
      slot, replacing the title. `/account` is a PLACE (plain name, lit on the row's face
      key); the steps inside it keep the back control, and in the flow it is a STEP, not an
      exit (code → address).
    - **A SECTION IS SPACE AND A TITLE (2026-08-29):** generous room between blocks, a real
      title at the chrome's own ink and size on a block that needs naming, no invented titles.
    - **THE COPY SAYS ONLY WHAT THE SCREEN DOES NOT SHOW:** `YOUR ACCOUNT`, `SAVED AS`,
      `6-DIGIT CODE` are cut; the ONE line kept is why a word game wants an address, said once
      where the decision is made (*Pour qu'un téléphone perdu ne perde pas tout.*). The privacy
      door on the address step was cut 2026-09-03; `/account`'s footnote is the notice's one
      door.
    - **NOT DONE, the user's call:** the erase confirmation is gated on `stakes.days > 0`
      (solved days), so a player with rounds but no solve is erased with no dialog.
  - **TWO DOORS ONTO ONE ENGINE (vol. 2, 2026-08-27).** `/account/email` and
    `/account/signin` mount the SAME `AccountEmail` with an `intent` the ROUTE declares
    (`langs.ts` `LinkIntent`); it never reaches the server, and every request the flow makes
    is byte-identical on both. The product contract is the root `AGENTS.md`'s. What is this
    package's: `components/AccountMark.tsx` is the wordless tell — ONE CANVAS that churns
    while nobody is known and RESOLVES into the real drawing when the code lands, then hands
    off to `Avatar`'s canonical traced path (so #188's union-outline decision is untouched;
    a canvas at exactly 10×10 backing pixels has no sub-pixel edges to seam in the first
    place). Its cell order is a DETERMINISTIC shuffle seeded by the drawing, the slash-flip
    rule, so a re-render mid-flight cannot re-scatter cells that have already landed, and a
    resolved cell is FINAL while the field churns around it. `image-rendering: pixelated` —
    the standing integer-scale rule — and a canvas rather than rects because a hundred
    React-managed rects would be a hundred style writes per frame on the one screen whose job
    is to stay out of an input's way. Its noise is ONE octave of integer-hashed 3D VALUE noise
    (x, y, time): a 10-cell tile cannot resolve more, and gradient noise would cost more code
    to be indistinguishable. Both fields are offset in TIME so they cannot beat into a visible
    period, and the clock starts at `T0` rather than 0 — an integer-hashed value noise is
    exactly its own hash at the lattice origin, so t=0 paints a degenerate frame, which is
    the one a REDUCED-MOTION tile would hold forever.
    **ITS FIELD IS MEASURED AGAINST A REAL MARK, and MIRRORED (2026-08-30).** "Every frame
    a plausible one" is a claim that can be checked, so it was: over six `defaultAvatar`
    marks, **23% of the cells carry ink, a horizontal run averages 3.0 cells, and they are
    100% SYMMETRIC about the vertical axis** — the mirroring is what makes ten squares read
    as a creature rather than as television static. The first cut was none of those things:
    at `INK_SCALE = 0.3` the field's period was three cells, so a frame was two or three
    enormous blobs at 62% coverage with no symmetry at all — a colour field, which is
    exactly the "the small squares are weird" reading the tile was written to replace. The
    ink is sampled about the tile's midline and the scale/threshold sit where the field's
    statistics land on the drawing's (~30% ink, ~2.5-cell runs). The PALETTE front is
    deliberately NOT mirrored: the SHAPE is what has to be plausible, and a colour
    transition folded about the same axis reads as a mechanism.
    The lead is rendered OUTSIDE
    `AccountEmail`'s step branches, so it is one element across address → code rather than a
    second one mounting in its place. `CODE_INKS` lives beside it and `CodeInput` wears it:
    the six cells' colours are `AVATAR_PALETTES` entries addressed rather than copied, so the
    prompt and the tile above it cannot drift. The CONFIRM step serves BOTH refusals —
    `would_erase` and `would_switch` — off `LinkErasePrompt.kind`, and `parseErasePrompt`
    takes that kind as an argument because a SWITCH carries no stakes: requiring the numbers
    there would refuse a confirmation the player has to be able to answer. `account_linked`
    lands as a NOTE under the address input rather than on the `ErrorScreen`, and the next
    keystroke clears it. The ending's copy follows the face in
    on a `--arrive-delay` cascade (the `--slash-ms` rule: the JS that ends the composition and
    the CSS that waits for it hold ONE number), every element keeping its layout box so
    nothing moves while it arrives. The address step's cost line reads the CACHED
    `useAccountSummary` — no new request, and a tokenless device says nothing at all. And the
    crossroads' two labels are different KINDS of word: `.link-cross-tag` is tracked all-caps
    chrome for the verdict, `.link-cross-name` an identity with its case kept; the row is
    equal-width sides around the arrow, because the two labels differ in length and a row that
    merely centres its content puts the pivot off by half that difference.
  - **THE AREA'S TYPE ROLES AND ITS BACK CONTROL (2026-08-29)** — the product contract is
    in the decisions list above. What is this package's: `.account-note` is INFO, `.account-note
    .danger` is an ERROR and carries an `::before` LED in the danger ink, `.link-quiet-btn`
    is an ACTION in `--fg` at a finger's size; the back control is `TopBar`'s exported
    `HeaderBack`, which a screen mounts inside its own `HeaderLeft` (a `back` PROP on
    `TopBar` until the 2026-09-02 hoist — the header bullet holds the reasoning; there is
    one left slot now, and what a screen puts in it is the screen's business).
    its glyph is `assets/icons/chevron-left.svg` — the title's own 7×7 pixel chevron
    turned to point out (user-decided 2026-09-02, "use a left chevron as a back icon on
    the header", replacing the 10×10 pixel arrow, which replaced the Lucide arrow on
    2026-09-02's icon rewrite) — NOT `back.svg`, which is the KEYBOARD's pixel backspace
    and belongs to the play surface's icon family.
  - **THREE routes, three screens** (a fourth, `/account/manage`, lived for one commit on
    2026-08-26 and was ROLLED BACK the same day, user-decided: the devices belong on the
    account screen — gated, below). `screens/Account.tsx` (`/account`) is the area's one
    door and reads top-down as a PAGE: the ACCOUNT'S THREE NUMBERS under the identity as a
    MASTHEAD ROW — mark, name, the
    account's age, EDIT at the trailing edge, the UX research's own strip, chosen over the
    centered hero the second polish pass tried (user-decided the same day: a page's
    identity is a masthead, not a monument) — over a hairline, then the save state, then
    the devices. `screens/AccountEmail.tsx` (`/account/email`) is the flow, one purpose
    per step. `screens/Profile.tsx` is the editor ALONE.
  - **THE STATS ROW (2026-08-28)** is `state/history.ts`'s `useAccountStats(activeDay)` — a
    hook rather than a `usePlayerHistory` per language, because the languages come from a
    module constant and a hook called once per entry of one is a rule waiting to be broken
    the day a third ships. It settles READY only when EVERY language's collection has
    landed: a total summed over one of two is a smaller number stated as a fact. Values
    withheld until then (the slot BREATHES only while a read is in flight — a failure rests
    still, the archive cells' rule), labels and layout always drawn, and ONE fixed value
    height so nothing moves when the collections land. The STREAK cell briefly wore the
    archive's flame sprite; it was pulled pending a drawing of its own, which leaves
    `assets/streak-small.png` unreferenced (the celebration's `streak-flamme`/`streak-glow`
    sheets are a separate pair and are untouched). The ROW ITSELF is
    `components/AccountStats.tsx`, drawn by three surfaces for three reasons — what this
    account IS, what a deletion is about to COST, and what a recovery just HANDED BACK —
    because a player who reads a streak of 12 on the account screen and is then offered a
    dialog saying 9 has been told the app does not know its own numbers.
  - **THE 2026-08-30 PASS, from the mobile navigation review.** Four corrections, each
    to something that had been shown to read as the wrong KIND of thing:
    - **`/account` FLOWS FROM THE TOP again.** Its action group had been given
      `margin: auto 0` to answer a finding that the primary sat in the upper third with
      the screen empty beneath it. Both ways of spending that space measured worse than
      not spending it: parked hard on the bottom edge (`margin-top: auto`) the screen
      read as two blocks with a rift, and splitting the free height put a **161px HOLE**
      in the middle of it — the same emptiness, now twice and on both sides. A
      five-element screen has no interior to distribute, and the trailing space is not a
      defect; it is what a short page looks like. The group is a real box held by a 44px
      SECTION seam, and the area's own start-high rule is what the screen obeys.
      **ONE WIDTH FOR THE APP'S BIG ACTION (user-decided 2026-09-02: "the max width of
      the primary button on the leaderboard and account page should also apply to the mix
      button")**: `.mix-btn` is capped at the board column's 430px (it was 680, the
      keyboard's footprint), the account column is 430 too (from 400, its side padding
      gone), and the rules gate's own 10px bottom pad — which stacked on the button's
      phone margin and put PLAY 10px higher than MIX on every screen — is deleted.
      Measured: MIX, both gates' PLAY, INVITE and SAVE are 430px at x 425 with a 24px
      inset on desktop, and 362px at x 14 with a 14px inset on a 390 phone — one button,
      one place. (The gates' rules box keeps its 680px over the now-narrower PLAY.)
      **PROPOSED 2026-09-02, awaiting the user's review** (on their finding: "a bunch of
      primary button, label, secondary button with a different width, with different gaps
      and sizings, all of it stuck near the stats — it looks weird and not finished"): the
      action group is GONE. Everything there is to do with the account is a full-width
      ROW in the device list's own dress (`.account-list` / `.account-link`): the saved
      address as a row that is a fact (no chevron), the door to another account as a row
      that leads somewhere (the title's 7×7 chevron, `chevron-right.svg`), the devices
      under them — one grammar, one width, one gap, a section's air under the numbers.
      And the ONE CALL, SAVE WITH EMAIL (unsaved only), is the `.mix-btn` itself, parked
      on a phone's BOTTOM EDGE at the exact 14px inset the tutorial's MIX and the board's
      INVITE sit at (`.account-cta`; measured equal at 320/375/390, same width, same x),
      its one caption over it. This REVERSES the bottom-edge verdict above, on purpose:
      the rift was a screen with nothing between the numbers and the call, and the rows
      now fill that middle. On desktop the call is simply the column's last item. The
      `.account-row`, `.account-door`, `.account-actions` and `.account-action-slot` rules
      are deleted with it; the column stops being its own scroller on `/account` (the
      flow's steps keep theirs for the soft keyboard) so the page scrolls a long device
      list instead.
    - **The DEVICES are the LAST section**, below everything there is to DO with the
      account. They sat BETWEEN the save state and the second door, which put a list of
      hardware in the middle of a pair of alternatives and stranded the door — the one
      control a returning player is looking for — under the longest block on the screen.
    - **The saved ADDRESS lost its LED.** The lit cobalt square before a label is the
      PRIMARY BUTTON's own mark (the device card's power light); the address is a fact
      that REPLACES that button when there is nothing left to do, and wearing its costume
      it read as a control that did not respond to being pressed.
    - **RESEND drops its box while it counts down.** It spends its first ~30s disabled,
      and a dimmed hairline box held that long reads as a broken button rather than as a
      wait — the same rule that holds the second door back until the summary settles: a
      control drawn before it can be pressed is a false offer. Counting it is a STATUS
      line; when the clock runs out the box arrives with the offer.
  - **DEVICES appear only once an email is SAVED** (user-decided 2026-08-26): an unlinked
    account can only ever hold the one device reading the screen — multi-device arrives
    through the email link and no other way — so the list would be a list of yourself.
    The unsaved account screen is exactly three things: the row, EDIT, and SAVE WITH
    EMAIL. The saved address joins the row on the same gate (in the age's former place,
    2026-09-05), for the indistinguishability rule below.
  - **NOTHING IN THE AREA REVEALS WHETHER THE ACCOUNT EXISTS ON THE SERVER YET**
    (user-decided 2026-08-26). The pseudonym and the mark are derived locally from the
    persisted seed before deployment and stored as the account's first profile AT it
    (`localIdentityDeploy`), so `useOwnFace` — the ONE hook every screen of the area leads
    with — answers the same face either way. What used to leak it is gone: the devices and
    the saved address appear only once SAVED, which a tokenless and a deployed-unsaved
    device equally are not; the email flow's address step led with the app MARK for a
    tokenless device and now leads with that same face — HELD across the deploy
    (`AccountEmail`'s `lead`), because CONTINUE swaps the id from the seed to the account
    mid-flight and re-reading would race the background profile write for a face that is
    the same by construction; and the account screen's action holds a SKELETON while the
    summary is out rather than offering SAVE before it knows (#211's explicit-loading
    rule — a guessed empty answer is a false claim, and it also stopped SAVE flashing
    before the address landed on every linked player's first visit).
  - **The saved address carries NO chip.** An account carries at most ONE address and the
    server refuses a second (`account_linked`), so a CHANGE chip promised something the
    route would break — and with the devices inline there is nothing left for a MANAGE
    chip to open. The address is a fact, stated plainly.
  - **`components/CodeInput.tsx` is the prompt**, and its own header holds the reasoning:
    ONE real input under six drawn cells (paste, `one-time-code` autofill and screen readers
    all need a single field), `onComplete` carrying the VALUE because state has not flushed
    on the sixth keystroke, and the invalid-word shake for a refusal. **Its CSS class is worn
    BESIDE `.account-screen`** — `.link-step` therefore sets the GAP alone, since a `padding`
    there wins the cascade and silently undoes the screen's header clearance (found in the
    browser, on the first run).
  - **`components/AccountFace.tsx` is the ONE read of who an account is.** Three surfaces
    draw a mark and a name — the account summary, the flow's ending, the sign-out screen —
    and each used to fetch it themselves. It resolves to NOTHING until settled and is TAGGED
    with the account it is about, the leaderboard strip's own rule: a component that is not
    remounted when its account changes would otherwise render the previous person's face.
  - **`GET /profile` HAS FOUR ANSWERS, AND `api.readProfile` IS WHERE THEY ARE TOLD APART**
    (PR-227 review, 2026-09-02): `shown` (200), `blank` (404 — LIVE, never customized, so the
    assigned identity IS this player's face), `gone` (410 `account_gone` — a DELETED account,
    which has no face at all, not even the assigned one), `failed` (a transport error, a 5xx,
    an unparseable body — NOT evidence of a deletion). Reading `response.ok` alone collapses
    them, and what it collapsed was a deleted account drawn with the pseudonym and mark that
    are still its own. **The 410 matters where the id came from SOMEBODY ELSE:**
    `GroupInvite`'s `readGroup` is the group-shaped twin (shown / gone / failed), and `SignedOut`
    SETTLES FACELESS (`faceFrom`) instead of holding a loading frame or drawing the erased
    account. Both keep `gone`, `loading` and `shown` as three states rather than two, and both
    export their mapping so it can be read and tested on its own.
    **`AccountFace` DOES TOO** (corrected 2026-09-02 on the PR-227 follow-up review; it
    dressed 404 and 410 alike, on the claim that every caller proves the account live — which
    was FALSE: the flow's crossroads draws `target`, an account this device does not own, and
    a locally cached token outlives another device's adoption). `useAccountFace` answers
    `Face | 'gone' | null`, with `shownFace` and `faceSettled` as the two questions a caller
    asks — so a deleted account draws NOTHING and the box that held its place stops breathing
    (a skeleton over an arrival that is not coming is #211's own false claim). The
    consumers that stay on the raw fetch are the WRITE paths whose caller genuinely holds the
    account: the profile editor's own read and `localIdentityDeploy`, which already treats
    anything but a 404 as a reason NOT to create a row.
  - **`api.parseBadCode` is the attempt ladder the code step shows.** Every counted mismatch
    is `bad_code`, the FIFTH included, and its `attemptsLeft: 0` is what puts "too many wrong
    codes" at the input; a missing or malformed count reads as NONE LEFT rather than offering
    a try the client cannot promise. (The server used to answer the fifth mismatch as a 409
    `code_spent`, which left this branch dead — PR-227 review.)
  - **`state/account.ts` holds the summary AND the departure drain (#271, the friend merge's
    successor).** Both screens need the same one fact (is this saved, and to what), so
    `/account` can state it without mounting the flow. The `{token}` read runs only with an
    account (the #216 no-private-fetch rule) and RETRIES the drain, bounded and backed off —
    a membership left pointing at a deleted account is a ghost on every one of its groups,
    so the job may not simply be abandoned, and it is durable either way. It is
    ACCOUNT-owned, so `identityScope` resets it. **A SUCCESSFUL LINK RESUMES THAT SAME
    DRAIN** (`resumeDepartureDrain`, PR-227 review): the verify answer's `departurePending`
    says the server could not finish, and `AccountEmail.finish` hands it over AFTER the
    adoption has published — so the drain runs as the account the link LANDED on.
  - **CONTINUE is a DEPLOY BUTTON**, the sixth (#216's five plus this one), and it has to
    be: an email link needs an account to bind, and "this device is empty" is exactly the
    reconnect case. It wears the shape that rule defines — one tap chaining the bootstrap,
    a loading state on the button, failures on the `ErrorScreen` — and TWO Turnstile tokens are
    prefetched while the address is typed, since a tokenless device spends one on the
    bootstrap and one on the send. Every other leg uses `currentRequestIdentity` and stands
    down when there is none.
  - **The account screens follow `.profile-screen`'s geometry, verbatim**: `.app` centres
    the column and the header floats over it, so the clearance is a LITERAL `48px` — never a
    `calc()` naming `--hud-height`, which is scoped to `.topbar` and voids the whole
    declaration out here (the trap `.word-input`'s zeroed padding already records; it bit
    again on the first run of this rework). Never `100dvh` either, for the reason
    `.profile-screen` states.
  - **`adoptLinkedAccount` (identity.ts) is how an ADOPT lands**: the TOKEN is unchanged — the
    server moves the one device item rather than minting a second — so what changes is the
    account it names, and `identityScope` clears every account-keyed cache on that transition,
    which is exactly right (none of it belongs to the account just adopted). Fenced on the
    epoch the flow started under, like every other authoritative answer, and persisted BEFORE
    it publishes so a sibling tab cannot keep authenticating as the account this device left.
  - **`SignedOut`'s RECONNECT is wired and PRIMARY** (PLAY became secondary): it lifts the
    verdict — the one gesture that removes the tombstone origin-wide — and lands on
    `/account/signin` DIRECTLY (vol. 2; it was `/account/email`, whose every word is about
    SAVING an account the reader no longer holds): a player who has just been signed out has
    exactly one intention, and every screen between them and the address field is one they have to read
    past. Abandoning the flow costs exactly what SKIP already cost.
  - **The centered 64px-mark + 20/650-name HERO survives only where the screen is ABOUT an
    account** — the flow's address-step lead, its endings, the erase confirmation, and the
    signed-out screen the dress came from. `/account` itself went back to the ROW
    (user-decided 2026-08-26, after one day as a hero): its identity is a page's masthead,
    and the hairline under the row is the screen's one explicit separation — everything
    below it is about the account it names.
  - **`publish`'s ACQUISITION rule is `minted || revision === 0`, not `revision === 0`
    alone** (`identity.ts`, fixed 2026-08-26 from a browser repro). A mint is triggered BY
    a deploy button, so the state on screen is the state that ASKED for it, and the minted
    account is empty by construction — remounting the routed surface there destroys the
    act. The `revision === 0` proxy recognised that only for a session's FIRST acquisition,
    so after any earlier scope transition the mint bumped the revision and App remounted:
    #204's email flow lost the address the player had typed and its in-flight send,
    SILENTLY, which is exactly what the RECONNECT path does (a sign-out has already bumped
    it). An ADOPTED acquisition still bumps — that account may already hold rounds and
    history.
  - **The area STARTS HIGH, on ONE line (third polish pass, user feedback 2026-08-26:
    the centred column "feels like the screen starts at the middle").** On a phone every
    screen of the area — the account page, the flow's steps, the endings — opens at the
    same `clamp(76px, 13vh, 128px)` start line, free space accumulating at the BOTTOM the
    way a page reads; desktop keeps `.app`'s centring. **`/profile` joined that line on
    2026-08-30** — the editor is one tap inside `/account` and opened 53px higher than
    it, two screens of one place disagreeing about where a page begins — **and LEFT it on
    2026-09-02** (user-decided: "a huge useless padding at the top of the screen, making
    the view scrollable on most mobile devices for no reason"): the editor is the area's
    one TALL screen, and the line's 76–128px pushed its stack past a phone's viewport. It
    keeps its 48px header clearance — measured, an iPhone 13 (390×664) no longer scrolls;
    an iPhone SE (375×553) still scrolls 87px, which is the editor's own height. The ADDRESS step leads with WHO is
    being saved — the account's face, or the chooser's glowing app mark on a device with
    none (the reconnect case) — because a bare input floating on a screen was the "does
    not use its space" finding. And the two flagged corner-affordances became DRAWN
    chevrons in the chrome icon dress (`assets/icons/chevron-right.svg` on the board's
    identity strip, `chevron-down.svg` in the date chip's tick, replacing an 8px `▾`);
    the 320px header budget was re-measured with the wider tick — the right group's last
    chip ends at 318 of 320. *(The date chip is gone with the 2026-08-30 header rework;
    that chevron is `PuzzleTitle`'s now, and the budget was re-measured again there.)*
  - **The 2026-08-26 POLISH pass, all current-state:** on a phone the flow steps sit in
    the UPPER THIRD (`.account-screen.link-step` gets `max(48px, 14vh)` top padding in the
    mobile block — mobile `.app` is start-aligned, so a lone input otherwise hugged the
    bar; full centring loses to the soft keyboard, and `vh` is the LAYOUT viewport so the
    step holds still when the keyboard resizes the visual one). The code cells rest QUIET
    (`--line`) and brighten as they fill (`.filled` → `--line-strong`, the next cell in the
    accent); a refusal is red only while the wrong code is on screen — once the cells clear
    for the retype the row returns to rest and the tries-left LINE carries the message.
    Device rows are TWO LINES (label over THIS ONE in the accent, or the last-seen
    day-month — the single line truncated its own current marker on a phone). The erase
    confirmation SHOWS the account being deleted (mark + name over the stakes, the
    signed-out screen's own move), and the two endings return differently: an ADOPT offers
    PLAY into the game, a BIND offers OK back to `/account` — a settings errand ends where
    it began, and `.link-stack` is the one centered face-stack all three moments wear.
  - **The invite landing has an EXPIRED state** (`GroupInvite` since #271; `unknown_group`):
    neither a hiccup nor the cap, so it takes the cap's own surface (a state with a way ONWARD
    rather than a retry) — retrying cannot bring a group back, and continuing silently would
    tell the clicker they joined a group they did not.
  - **`game/streak.ts` re-exports `currentStreak` from `@whippin/shared`** and keeps
    `streakTransition`/`weekView`: the server derives a streak for the erase confirmation, so
    the derivation itself moved.
- **The PRIVACY NOTICE (#229).** `/privacy` — a global route like the account area's, and a
  STEP of it: the header's row lights the FACE and the left slot carries the back control.
  Reached from TWO doors, which is the whole reason `routing.ts` grew `goBack(fallback)`: a
  row on `/account` and a quiet action under the email flow's ADDRESS field, where the address
  is actually typed — and sending that second reader to a fixed parent would drop somebody
  three taps into saving their account back at the start of it. `goBack` uses the browser's
  back only where it finds the app's own stamp (`history.state.app`); a pasted or bookmarked
  arrival falls back to `/account`, because what sits behind THAT entry is not ours to send
  anyone to.
  - **ONLY A PUSH MAY STAMP** (`writeEntry`, contract-tested in `routing.test.ts`). The stamp
    answers one question — is there a screen of OURS behind this entry — and that is a fact
    about the entry's PREDECESSOR, which only a push creates. Both replaces this app makes are
    on entries somebody else landed on: the `/` → `/<lang>` redirect, and `dropLangParam`. The
    first cut stamped all three, and it broke the exact journey `?lang=` exists for — a pasted
    `/privacy?lang=en`, a language picked from the wheel (which rewrites the URL), then back:
    off the site, or in a fresh tab nothing at all, since the entry was the tab's first.
  - **A SIGN-OUT DOES NOT CLOSE IT** (`App`'s `blocked`, which is `signedOut` everywhere
    else). The verdict takes the whole screen because every private read answers
    `unknown_device` from there on — and this route makes none: it is a static document about
    what the game stores, on the one URL that has to be openable by anybody. Answering "what
    do you keep about me?" with a sign-in screen is worst for the reader with the strongest
    reason to ask.
  - **It is a real ROUTE and not a dialog** because a legal notice has to be LINKABLE: the SES
    production-access review opens a URL, and « où est-ce écrit ? » deserves an answer that
    can be pasted into a message.
  - **The words live in `screens/privacyDoc.ts`**, per language, parity enforced by the type
    (the tutorial scripts' shape) — `i18n.ts` is a table of chrome strings, and this is twenty
    paragraphs whose structure is part of what they say. The chrome that IS chrome (the screen
    name, the two entry labels) stays in `i18n.ts`. `{mail}` is filled from ONE
    `PRIVACY_CONTACT` (`hello@whippin.ai`, the SES sender infra derives), so the two languages
    cannot name two inboxes, and the address renders as the app's ONE `<a>` — a `mailto:`,
    because "write to us" is the only instruction here a reader is meant to ACT on.
  - **It describes the CODE, so a change to what the server stores is a change to this file.**
    Every claim is checked against something: the account row's stored address, the device
    item's hashed token and coarse user-agent (#216), the round rows' folded guesses (#201),
    the HMAC-of-IP rows and their TTLs, the 10-minute code, the us-east-1 stacks, Turnstile
    and Plausible's three events. The TTLs are stated as an upper BOUND, never an instant —
    DynamoDB's sweep is best-effort and the two rows expire at different lengths.
  - **It is SET LIKE AN ARTICLE (user-decided 2026-09-03: "a bit more beautiful, like a blog
    post", and wider — at the account column's 430px "on desktop it feels like you're on a
    phone").** A 640px measure (~76 characters of the mono, a real reading line), a TITLE in
    sentence case that is the document's own first sentence (the header chip names the
    SCREEN; the title names the CLAIM the page substantiates — `privacyDoc.title`, split out
    of the lead), a DATELINE under it in the archive day's tag dress, a STANDFIRST, then
    sections each opened by a hairline; every named thing is a `<dl>` term on its own line
    over what is true of it, so a section skims like a run of small subheads. It does NOT
    wear `.account-screen`: that class centres its column and, on a phone, opens on the
    area's high start line — and this is by far the area's tallest screen, which is exactly
    what took `/profile` off that line on 2026-09-02. `.privacy-screen` states its own
    geometry (the literal 48px header clearance) and `align-self: stretch` pins it to the
    top; the column scrolls its own overflow, which is also what lights the header's band as
    the text passes under it.
  - **THE DOOR ON `/account` IS A FOOTNOTE ON THE BOTTOM EDGE, not a row** (user-decided
    2026-09-03, in two passes: "only 0.1% of the users will care and click on it… not
    hidden neither, just not in the middle of the screen with a big button", then — once it
    was the last line of the CONTENT — "it's still in the middle of the screen", because on
    a short screen the content ends there). `.account-foot` is the screen's LAST line, under
    the call: on a phone it parks on the edge by the auto margin (the call's own trick,
    handed down), and the call sits above it — which gives up the call's exact bottom-edge
    alignment with MIX and INVITE on this one screen, on purpose (measured 390×844: SAVE at
    709–767, the footnote at 793–830). Small, centred, in the secondary ink, with a finger's
    padding it does not show. It is the one place the area's ACTION-in-`--fg` rule yields:
    that rule keeps a control from hiding among help text, and there is none here to hide
    among; this one is meant to be exactly as visible as the interest in it.
  - **TWO VALUES ARE NOT PROSE.** `PRIVACY_CONTACT` is the SES sender infra already derives;
    `PRIVACY_HOST` names the site's host. It exists because the notice takes the LCEN's
    non-professional route (art. 6-III-2): a free site that sells nothing may keep its
    publisher's identity with the HOST and publish the host's details instead, which is what
    lets the page carry no personal name. The day the game earns money it stops qualifying.
    It shipped as a GUESS for one commit and is **read off the AWS billing mail** since
    2026-09-03, whose footer names the entity that produced it — same string, now a fact. It
    is a legal identification: if the account ever contracts with another AWS entity, this
    line is read off the invoice again, never adjusted from memory. (A `PRIVACY_HOST_CONFIRMED`
    flag failed the production build while it was a guess, and left with the guess: once true
    it could never fire again, and it protects nothing against a later edit.)
  - **NOT done, and both are the user's call:** there is no self-serve "delete my account"
    (#207 is filed and specified — when it lands, DELETING IT loses its "no button yet"
    paragraph and gains the purge delay #207's own scope requires, and ASKING shrinks to the
    rights a button cannot serve), and the notice states each category's PURPOSE in plain
    words without naming a legal basis under Art. 6 — the readable half of what Art. 13(1)(c)
    asks for, left that way deliberately rather than turned into boilerplate.

- **THE ERROR SCREEN HAS ONE WAY OUT (user-decided 2026-09-03: "get rid of the retry
  button… it's weird to retry from a fullscreen error page, just go back and retry if you
  want").** `ErrorScreen` carried a lit TRY AGAIN wherever asking again could help
  (2026-08-24), with GO BACK as its secondary; it carries a single SECONDARY that dismisses
  now. The act that failed belongs to the screen underneath — the typed address, the
  drawing, the gate are all still there — and the honest gesture is to go back to it and
  press the same button again. Gone with it: the `onRetry` prop and its seven wirings, the
  `retry` flag on `AccountEmail`'s refusals and `Profile`'s save error, the `tryAgain` string,
  `errorPreview`'s retry shape and its "both layouts" test, and the synchronous-in-tap rule
  the retry needed on WebKit (the act is re-run inside its own fresh tap now). `LoadError`'s
  RETRY is untouched: that is a screen that could not open, where this is an act that did
  not land.
- **EVERY PAGE CAN CHANGE LANGUAGE (user-decided 2026-09-03).** The game routes always
  could — `PuzzleTitle`'s selection is the language — and the ACCOUNT
  AREA could not: `/account` carried a plain name and its steps carried a back control, so a
  player who landed there in the wrong language had to go back to a game to get out of it.
  - **`components/LangTitle.tsx` is the other clickable title**: the screen's own name in the
    header chip, the LANGUAGE beside it in the ARCHIVE DAY's exact dress, the same chevron,
    and `PuzzleSelect` behind it. It wears `.puzzle-title`,
    which is the dress of BOTH titles rather than the puzzle one's alone — the row's phone
    step-downs are tuned on that class, and a second class beside it would be three more
    overrides nothing forces to agree. `.puzzle-title-day` became `.title-tag` for the same
    reason: the day and the language are one KIND of value (which of a thing), so they are
    one class.
  - **`PuzzleSelect` is the language drum alone, and the CALLER decides what a pick means**
    (`onLang`): on a game surface the language is in the URL, so the pick NAVIGATES; the
    account area's routes are global, so the pick is the PREFERENCE every screen there reads
    its chrome language from (`lastLang` → `resolveHomeLang`), and the page re-renders where
    it stands.
  - **`HeaderBack` IS THE ARROW ALONE now, and it is the SELECTION's way out too.** It
    carried the screen's NAME as one target (2026-08-29), which was right while the name said
    only which screen you were on; the name opens a wheel now, and one target cannot do
    both. The arrow takes the retired control's own geometry minus its word — 44px of height
    around the glyph, pulled back to the row's left edge — and it is deliberately NOT a
    `.home-btn`: that class sizes a key by `--hud-height`, which steps down with the phone
    breakpoints on `.topbar` and not on `.modal-bar`, so `PuzzleSelect`'s own back control
    (`.ps-back`, deleted) measured 40px where the header's measured 32 and its chevron sat
    4px to the right — "it feels like the back button is moving" (user-reported 2026-09-03).
    The selection mounts `HeaderBack` itself now; measured, the two chevrons land on the same
    pixel at 320/390/640/1280.
  - **THE ROW IS AT ITS LIMIT, and the LANGUAGE TAG is what gives.** A step's left slot holds
    FOUR things beside a five-key group that may never shrink, and French runs ~20% longer:
    measured, SAUVEGARDE and VIE PRIVÉE ran 7px into the keys at 360 and 18px at 320. Three
    things bought it back — the ≤340 title compressions moved up to ≤400 (that block was
    tuned for a game route, whose slot holds ONE control), `SAVE ACCOUNT` shortened to `SAVE`
    / `SAUVEGARDE` (`linkTitleReturn`'s own 2026-08-31 finding, one door over), and
    **`.lang-tag` hidden below 375px**: the honest order is the name, then the affordance,
    then which value it holds, and nothing is lost that the page is not already saying in
    that language. 374 is measured, not chosen — 375 is the iPhone SE/6/7/8 width and the
    longest French title still fits there. The archive DAY keeps its tag at every width (no
    back arrow beside it, and the day is the abnormal state a route must always label).
    Residue, accepted: at 341–359 — a band no shipping device sits in — the two longest
    French titles ellipsise by 6px.
  - **A LINK CAN CARRY ITS OWN LANGUAGE — `?lang=`, APP-WIDE** (user-decided the same day:
    "so you can send the privacy policy in a specific language… not only to the privacy
    page"). Three sources in order, and the whole precedence is one pure function
    (`resolveUiLang`, contract-tested): the LINK, then the stored preference, then the
    browser. `hooks/useUiLang` is the reactive binding — the store because the wheel writes
    it, `useLocation` because the URL is the other source — and it is what every screen the
    URL names no language for now calls (`/account`, `/profile`, both flow doors,
    `/privacy`, the chooser, and App's own `docLang` + `/` redirect, which carries the
    invite landing and the signed-out screen with it).
    - **It is NOT persisted, and a deliberate pick OUTRANKS it.** A support link in English
      must not take a French player's app away from them for good; and since the parameter
      is read AHEAD of the store, choosing FRANÇAIS while `?lang=en` stands would be
      answered by the URL rather than by the wheel. So `LangTitle`'s pick calls
      `dropLangParam()` BEFORE writing the preference — a `replaceState` that KEEPS the
      entry's own stamp (the privacy bullet's rule), because a suggestion the player just
      overruled is not a place to go back to.
      **IT DOES RIDE ALONG WHILE IT STANDS, and that is the shape of the decision, not an
      oversight:** `navigate` carries the whole query string across, and the header's keys
      take the RESOLVED language — so a French player following an English link and then
      tapping PLAY lands in the English game, with `?lang=en` still in the URL. Every screen
      they pass is then consistently the language the link was sent in, which is what the
      parameter promises; one pick from any wheel ends it for good, and `lastLang` is
      untouched, so the next visit to `/` is French again.
    - **A route that NAMES a language ignores it** (`/fr?lang=en` is French): the path is
      the more specific statement, and `?lang=` is the fallback for the routes that name
      none. An unsupported code says nothing at all rather than falling to English, so a
      typo cannot take a stored French away.
    - **`useLocation` now TRACKS the search string** (and still returns only the path, which
      is what every caller routes on). The two used to be one, and a query-only change
      re-rendered NOTHING — React bails out when a state write lands on the value already
      held — so `dropLangParam` notified every listener and moved no screen: the player
      picked FRANÇAIS, the URL stopped saying English, and the page stayed English until a
      reload. Found in a browser, not in a test.
  - **THE TUTORIAL SWITCHES TOO** (user-decided: "even on the tutorial"). Its left slot was a
    plain name; it is a `LangTitle` whose pick NAVIGATES — the lesson sits on `/fr` or `/en`,
    and `App` keys it on that language, so it restarts in the one it lands in. The pick is
    `PuzzleSelect`'s `onLang` like every caller's: the account area has no URL to move to
    and stores a preference, the tutorial travels.
  - **A PICK KEEPS YOU ON THE KIND OF SCREEN YOU WERE ON** (user-reported: changing the
    language on the leaderboard dropped the player onto the puzzle). `PuzzleTitle` takes
    `surface: 'game' | 'archive' | 'board'`, and `PATH_FOR` maps it to `pathForGame` /
    `pathForArchive` / `pathForBoard`. A selection answers "which language am I looking at",
    never "take me somewhere else" — the rule the archive already followed, said once for
    all three.
  - **THREE SURFACES STILL CANNOT SWITCH FROM WITHIN, each by an older decision**: the
    invite landing, the onboarding invitation and the signed-out screen — all three wear no
    header at all, being surfaces "with nowhere else to be". They do honour `?lang=`, so a
    link sent in a language renders them in it. (The missing-puzzle screen, headerless too,
    opens the SAME drums from its CHANGE LANGUAGE button — `NoPuzzle`, since 2026-09-05.)

- **THE CARD (user-decided 2026-09-11, from the three references in `inspiration/card/`:
  on a phone "it's hard to understand what's on screen quickly").** `.card` is ONE panel for
  a VIEW in those references' language: a LARGE, SOFTLY ROUNDED panel lifted a shade off the
  ground (`--fg` at 4.5%, a 9% stroke, 24px radius — 22 on a phone), and inside it a darker
  inset WELL (`.card-well`: back into the ground at 75% `--bg`, a 6% stroke, 16px radius)
  holding the thing the card is about, with a caption row under the well. Depth by two
  steps of value, never a shadow or a glow (the flat rule stands). **It is THE ONE
  EXCEPTION to the 4px radius ceiling**, by the user's own references; nothing else in the
  chrome rounds past 4px, and the references' PILL buttons were not taken (the app's
  buttons stay its own). A CLASS, not a wrapper component. The solved screen is its first
  consumer and only the SCORE block wears it — the well holds the number and its run
  ruler, SHARE/TOMORROW are the caption row — while the sentence's PAGE stays on the bare
  ground (user-decided the same day, after both were tried as cards: the page is a page,
  not a tile). Two earlier cuts the same day — a `--surface` + `--line` 4px tile on both
  blocks, then a square 3%/6% tile — were reviewed as not it.
  **WHERE IT LIVES (user-decided 2026-09-11: "everywhere in the app where it makes sense —
  view separation, these informations are together, those are separate — but not
  everything needs a card").** Three consumers: the RESULT (score + ruler in the well, SHARE/TOMORROW the
  caption row);
  the ACCOUNT's three numbers (`AccountStats`, a panel
  with no well — a simple group takes the panel alone); the archive CALENDAR (`.cal` —
  nav, weekdays, grid and the failure note in one panel). Deliberately NOT: the sentence's
  page (prose is not a tile), the leaderboard (its rows are already tiles — a panel round
  them is a box in a box), the coach/rules boxes (a dialog's own dress), the account's
  device rows (the same row grammar).
  **THE REVEAL RUNS SCORE FIRST, THEN THE PAGE (user-decided 2026-09-11, reversing the
  2026-08-15 page-first order):** the stage rises with the card, the tally counts while the
  ruler colors, the standing lands with SHARE, closing the card — and only then the credit
  types, and only once it has printed does the SENTENCE appear, its secrets popping in
  ("score view → source → sentence", the user's second pass the same day: the text used
  to stand from the first frame). The 2026-08-15 rule survives inverted: nothing prints
  while the numbers move. `.solved-text` holds its box from frame one and fades in on
  `sentenceIn` (the citation's completion, with its visible-time deadline); the pops ride
  the same flag, and their end is the reveal's END, which disarms the fast-forward.
- **Early play: tomorrow's sentence tonight (#273, user-decided 2026-09-08).** The
  product contract — TOMORROW beside SHARE as the result's one onward action, the first
  progress / `EARLY_GUESS_CAP` stop, the server's `early_locked` — lives in the root
  `AGENTS.md`. What is this package's:
  - **The dated route reaches `activeDate + 1`** (`langs.ts` `ROUTE_FUTURE_DAYS`, ONE
    `dateOf` for both grammars). `GameRoute` reads the day LIVE off `useToday` — `isActiveDay`
    and `early` both — so a tab open across the flip sees tomorrow become today: the lock
    lifts, the streak read starts, without a reload. **Tomorrow LIVES AS AN ARCHIVE PLAY
    in the header (user-decided 2026-09-11, the last of three passes on the way back):**
    the calendar key lights, HOME is a live key, and the title keeps the `12/09` day tag —
    so before the night's lock the house is the way back to today's result, exactly as on
    any dated route. After the lock the round carries its own labelled way back: a
    ‹ TODAY / AUJOURD'HUI secondary button under the countdown (`FlipCountdown`'s
    `onToday`, `.flip-today`), because a locked screen with nothing left to do must say
    where to go. RETIRED the same day: a bare back arrow in the left slot ("a few white
    pixels appearing in the header might not be very obvious, many might get stuck"), a
    lit-but-leaving HOME (a lit key that led OUT of the place it lit), and a TODAY under the
    prompt for the whole round (one commit; the house covers the unlocked round). TOMORROW
    wears the title's pixel chevron after its word and TODAY the same one turned back
    (`.btn-arrow`), the two ends of one trip.
  - **`Game` locks LOCALLY** (`locked` = `early && !finished && earlyLocked(...)`, over the
    FULL play log rather than the board's deferred view, so the lock lands on the guess that
    made progress while its floating hit still plays): `submit` refuses, the prompt retires
    like the gate's, and the TRAY renders `FlipCountdown` where the keyboard stood — the
    whole statement, no caption (show, don't tell). Holes stay tappable (the wheel is a
    reading aid).
  - **The engine (`roundSync.ts`) treats `early_locked` like `round_solved`** — adopt,
    discard the outbox, close — but remembers WHY (`lockedEarly`): the re-registration that
    reports `early: false` re-opens the conversation with a READ (another device may have
    moved the log) and the outbox then flushes. A client whose clock has already flipped
    (`early` false) that still gets `early_locked` KEEPS the guess and retries behind the
    backoff — clock skew is not a verdict.
  - **`SolvedScreen` takes `onTomorrow`** (today's result only; `Game` passes nothing on an
    archive day), a second secondary button on SHARE's own beat; `.result-actions.paired`
    gives the pair half the row each (`flex: 1 1 0`, capped 240px) so they share ONE line on
    a phone. TOMORROW navigates to `pathForDay(lang, tomorrow)`. A capped round offers it too:
    it is the same result screen.
- **Local storage is an OUTBOX; a capped round ends at ∞ (#214).** The product contract —
  the three values, the load order, what the cap means, the share token, what was removed —
  lives in the root `AGENTS.md`. What is this package's:
  - **`game/playLog.ts` is the projection**, and `Round` derives EVERYTHING from it: the
    board (`replayHoles`), the score (its length), the prompt's recall history, the run
    ruler's trajectory and the solve moments. There is no persisted holes/count/progress
    mirror left to keep in step with it.
  - **An outbox exists ONLY while this device owes something.** `ensureOutbox` never
    creates one — it drops a mismatched revision, prunes legacy keys and caps the map —
    and `appendOutbox` MINTS it, taking the revision from the caller playing it. That is
    load-bearing rather than tidy: an accepted write REMOVES the outbox it emptied, so
    most guesses of a round arrive with nothing to append into. Refusing there (the first
    cut did) silently dropped every guess after the first — the board reverted on the next
    replay and the server never heard about them again, which is exactly what a browser
    run caught and no seeded unit test could.
  - **`useRoundSync` returns WHERE the round's state is** (`RoundLoad`), and `Round` renders
    the game body only once it is `ready`: `loading` shows the wave, `failed` shows
    `failedRound` + RETRY (`retryRoundSync`). A load can only ever FAIL before it has
    succeeded once — the engine tracks that as its own `settled` flag rather than reusing
    `readDone`, which `resync` clears — so a recovery read failing behind a live board is a
    sync hiccup, never a played round taken away mid-guess.
  - **The animated hole swap survived the board becoming a REPLAY.** The play log is
    authoritative the instant a guess lands, so the visible board replays it MINUS the
    guesses still in the air (`deferred`), and ONE timer per guess releases it at its
    floating hit's `fadeDelayMs`. That is strictly simpler than the `improveHole` it
    replaced: the replay decides which holes move, so there is nothing per-hole to schedule
    and nothing to keep monotonic — two guesses released out of order still land on the same
    board, which is what the old monotonic guard existed to guarantee.
  - **`publish` skips an UNCHANGED state.** The common answer is the server echoing back
    what we just sent; writing a new object for it would hand the round fresh state about
    once a second while a player types and recompute every derivation downstream. (The old
    engine avoided the same churn for a sharper reason — a rewrite applied every pending hole
    improvement on the spot — which the `deferred` split now prevents by construction.)
  - **The capped round's `∞` is `@whippin/shared`'s path data**, drawn in place of
    `.solved-score-num` (`.solved-score-inf`, `crispEdges`, sized in `em` off the number it
    replaces) with an `sr-only` `∞` beside it; the unit stays PLURAL, since there is no count
    for a "1" to agree with. `SolvedScreen` takes `capped` and shares a v6 capped token.
  - **`statusOf` takes a SERVER summary** (`{progress, solved}`), and #211 is its producer —
    the two shipped together, as the Ordering note on both issues required.

- **Server-backed player history (#211).** The product contract — why the summary surfaces
  have no local source after #214, the explicit-loading rule, the streak window, the metering
  stance — lives in the root `AGENTS.md`. What is this package's:
  - **`state/history.ts` is the whole client half**: a transient zustand store of months
    (keyed `lang:month`) and per-language solved-day collections, ONE flight per request
    key (the `activeScoreFlights` pattern — the chooser mounts two languages at once and
    React's development effect replay fires every effect twice), and `usePlayerHistory`, whose
    effect REVALIDATES whenever a (language, month) becomes the view on screen. Nothing
    is persisted: an archive day is playable, so a past month is not immutable and an earlier
    visit's answer is not evidence.
  - **A month that has not arrived is `days: null`, never an empty Map** — an empty Map is the
    claim "none of these days was started". `daySummaryStatus` is the ONE place the difference
    is turned into something a surface can draw: a missing DAY is `{kind:'none'}`, a missing
    MONTH is `{kind:'unknown', loading}` — the third `Status` kind, whose `loading` half only
    decides whether the placeholder BREATHES. **It is read off the phase being `loading`, never
    off "not failed"** (corrected on review): breathing PROMISES an answer is coming, so a read
    that failed and a surface that never asked both rest still. An idle read (`enabled: false`)
    rests too: a placeholder breathing forever with no request behind it is the same false
    claim the explicit-loading rule exists to prevent. The calendar draws unknown as a muted, unfilled, un-rippled cell
    that keeps its number
    and its tap (the day is playable whether or not we know what happened on it); the chooser
    draws the app's skeleton strip; `srStatus` says `srStatusUnknown`, because silence there
    reads as "not started".
  - **The ARCHIVE holds its streak hero's BOX while an answer is still COMING**
    (`.archive-streak-pending`, `visibility: hidden`). The returning player this screen is for
    almost always has a streak, so reserving keeps the calendar still for them; drawing
    nothing pulled it up and pushed it back down on every visit. A zero streak collapses the
    box once the answer lands — and so does a read that FAILED (corrected on review), for the
    cells' own reason: reserving is a promise, and after a failure nothing is coming to keep
    it. The failure is not swallowed by that, because the block under the grid says it in
    words and its RETRY reloads the collection with the month.
  - **A FAILED read speaks whether or not a month is already drawn** (corrected on review).
    A revalidation deliberately keeps its cached month on screen, so gating the block on
    there being nothing to show made every failure after the first good visit SILENT — an
    offline player reading a stale calendar as the truth. What changes with cached data is
    the CLAIM, not the presence: nothing loaded is `failedHistory` in the danger ink, an
    older answer still on screen is `staleHistory` in the plain status ink, and both carry
    the same RETRY. Loud either way, for the round load's reason: there is no local history
    left to fall back to.
  - **`noteSolvedDay` replaced the store's `recordSolve`**, and since the PR-218 review it
    reads the SERVER's own verdict rather than re-making the on-time comparison on the
    device clock: the solving append's answer carries `credited` (root `AGENTS.md`), and
    `Game` passes it through on the play-solve transition. A day already held is still not
    counted twice, and a collection that has NOT ARRIVED credits nothing and celebrates
    nothing. **`Game`'s own `isActiveDay` gate on the streak went with the old tolerance**
    (it has NO such gate any more), along with the freshness re-check in the
    word-animations effect: both existed to arbitrate a flip-edge that is now simply late,
    and `streakAdvanced` — `noteSolvedDay`'s own answer — settles the celebration alone.
    **A landing answer MERGES into the collection rather than replacing it** (corrected on
    review): a read issued before the solving append can resolve after the credit, and
    replacing would take the day straight back out from under a mounted `StreakDialog`, which
    counts its transition off exactly that array. The union is honest as well as safe — the
    collection is monotonic within a language, and the only day this client ever adds is one
    the server is recording anyway. **A merge that changes nothing keeps the held array's
    IDENTITY** (PR-218 review): `StreakDialog`'s master sequence effect depends on arrays
    derived from it, and a fresh identity landing mid-celebration restarted the whole show.
    `loadPlayerHistory` is exported for the contract test that drives a real answer through
    the commit path.
  - **The GAME screen loads the collection with NO month** (`usePlayerHistory({lang, enabled:
    isActiveDay})`): the celebration counts the PREVIOUS streak off it, so it has to be in
    hand before the solve — and asking for a month there would spend a whole calendar's Query
    on every game load. **A FAILED collection read is retried quietly and BOUNDED**
    (PR-218 review): nothing else re-asks within a mount, so one blip at load used to
    silently suppress the streak celebration of a solve made twenty minutes later while
    the server credited the day. `StreakDialog` only READS it (`useSolvedDays`), since the
    screen it mounts inside has already loaded it.
  - **Reads gate on the DEVICE IDENTITY (`deviceIdentity()`) and skip what they don't
    draw** (PR-218 review; the gate read `hasPlayerIdentity` until #216 replaced the
    player secret with the device token): a visitor with no token cannot own server rows,
    so `loadPlayerHistory` publishes a ready-and-EMPTY history without a request — and
    without MINTING one, keeping identity.ts's "a visit that performs none of the
    deliberate acts creates nothing". The language
    chooser passes `collection: false` (the body says so), so its month strip does not
    spend the solved-day collection's consistent GetItem on an answer it never renders.
    And `solved[lang]`'s PHASE is driven only by the most recently started collection
    read (`solvedReads`): a stale month's failure landing last fails its own month, never
    the collection another read owns.
  - **Persist v15 DROPS `solvedDays`** — the last device-local half of a player's history, and
    the one that could not follow them to a second device.
- **Round guess-log sync (#201).** *(RESHAPED by #214, above: the persisted `tried` log,
  `mergeLogs`, the `pendingFrom`/`serverCount` watermarks, `adoptRound`, the persisted
  `capped`/`recorded` flags and `holesMatchPuzzle` are all GONE — what this bullet describes
  as "the local log" is now the play-log PROJECTION, and what is persisted is only the
  outbox. Everything it records about pacing, batching, the cap's two 409s, verdicts and the
  unknown-outcome re-read still holds, and is why they read the way they do.)*
  `Game`'s Round registers its context with
  `state/roundSync.ts` (`useRoundSync`) and reports each COUNTED guess to it
  (a guess is deduped against the play log before it enters the outbox — a repeat owes
  the server nothing). The engine is one module-level conversation per round key (the
  `activeScoreFlights` pattern, so remounts and StrictMode rejoin it): the mount READ
  adopts whatever the local device is missing — that is the cross-device payoff, archive
  rounds included — merging SERVER-first under the local log by canonical identity
  (`mergeLogs`, `game/scoring.ts`'s `guessKey`), replaying the merged board with
  `replayHoles` over the ONE improvement rule (`applyGuessToHoles`, extracted from
  `share.ts`'s `replayRun`, which now calls it too), and handing all of it to the store in
  one `adoptRound` write — the merged log, the replayed holes AND their `progress`, since
  `syncProgress` can only ever repair the ACTIVE round and an adoption routinely lands
  after the player has navigated away (that day's archive cell would keep painting a stale
  fill until they reopened exactly it). Every call also carries the puzzle's published
  `revision` — a content hash that covers its rank maps, not a tag derived from the holes —
  which is what lets any real republish restart the server's log instead of inheriting it
  (root `AGENTS.md`). **Every ANSWER is checked back against the revision that asked for
  it.** A flight is MUTATED in place on re-registration, so a
  republish landing while a request is in the air would otherwise apply the retired
  puzzle's log using the corrected puzzle's ranks and holes: the tag's purpose defeated
  from the inside. A superseded answer writes nothing — not its log, not its cap, not its
  failure count — and the flight has already been reset to read again. **Adopting an UNCHANGED log writes
  nothing** — the common answer is the server echoing back what we just sent, and
  rewriting the round there would re-serialize the persist blob AND apply every pending
  hole improvement on the spot, out from under `Game.submit`'s deferral of each swap to its
  floating hit's fade-out (on a fast connection, every guess).
  Counted guesses flush COALESCED behind `ROUND_WRITE_MIN_MS` pacing — measured from the
  previous write's **ANSWER**, the zero-margin reason in `shared/AGENTS.md` — with capped
  exponential backoff, and each batch CLAMPED to what still fits under the cap. Every
  answer, both refusals included, carries the full stored log and becomes the round's
  truth. Durability lives in the persisted `tried`, so a killed tab catches up on the next
  visit's read — and a write whose outcome is UNKNOWN re-READS before writing again rather
  than re-sending a batch the server may already hold. A 4xx VERDICT closes the
  conversation instead of spinning on it; a 429 is pacing, not failure. The conversation
  map is BOUNDED (`MAX_FLIGHTS`): every flight pins its puzzle's whole rank map, and
  evicting an idle one is safe by construction, because the next mount reads.
  A 409 marks the round CAPPED — but only when the log it CARRIED is really at the cap
  (`serverCount`, the RAW stored count rather than the merged one, which is also what the
  batch clamp is sized against): a batch correctly clamped when it was built still
  overshoots once another device pushes the stored log forward, and there the round has
  room and just needs a smaller batch. Capping on the status alone would suppress the
  leaderboard entry of a round that was never full. When it IS full the conversation closes
  and the ROUND ENDS at `∞` (#214) — the capped state is re-derived on every mount from the
  log the read carries, so a reload never re-opens a settled round for a guaranteed 409.
  There is no client score submission since
  #203: `useScoreHistogram` launches its population READ only on the SERVER's own `solved`,
  so capped/offline-only play has no row to claim and asks for no standing.
  **An ADOPTED solve is not a fresh solve** — the beats belong to a solve the server
  confirmed on a batch THIS device sent (`solvedByAppend`, #214, replacing the submit-time
  `solvedByPlay` guess), so a second tab finishing the board under this one replays no
  celebration and fires no second `solve` event.
  A changed revision resets the local board too, while an unstamped pre-deploy round with
  matching holes is adopted and stamped in place. The reset deliberately leaves the streak's
  solved-day collection alone (the server's since #211, held transiently): a republish is
  the publisher's error, streak credit rewards showing up, and both the server's set insert
  and `noteSolvedDay` decline a day already held, so the corrected version cannot claim the
  day twice.

- **Derived scores (#203):** the sync engine gained two jobs. (1) ROUND CREATION carries a
  Turnstile challenge — the sentence round has no START message, so the token rides the
  append whose read found nothing (`RoundFlight.created`), and every later append carries
  none. A failure there is an ordinary failed write, retried with the rest: the round keeps
  playing locally, which is why nothing is said on screen. (2) The SERVER's `solved` is adopted as a
  FACT (`markRoundRecorded`) — it says the day's score row exists, and it says the round is
  FROZEN, so the conversation closes — and its log is adopted SERVER-ONLY, where every other
  answer merges the local one under it: a frozen round's stored log is final, so keeping the
  guesses it refused would leave the screen counting tries the recorded score does not. It is
  still DEDUPED (`mergeLogs` against an empty local log), because the stored log is RAW and
  two devices can each have sent a surface of one group — the same disagreement from the
  other side.
  **The `round_solved` 409 must do BOTH**: a plain 4xx
  closes WITHOUT adopting, leaving this tab rendering an unsolved board with its guesses
  still on screen — the exact symptom the freeze exists to prevent — and a plain 409 adopts
  WITHOUT closing, so `pump` resends immediately with `failures` reset, at no backoff at all.
  The persisted flag is read on every mount for the cap's own reason: a reload must not
  re-open a settled round for a guaranteed refusal. **`created` only flips on an answer that
  DEMONSTRATES a record** (its `createdAt`): a rate-refused RESTART carries the EMPTY state,
  and taking that as creation makes the retry omit the challenge — a 403, which is a verdict,
  closing the conversation on a round that was never created.

- **Profile editor (#188; two-colour rework + key-UI removal user-decided
  2026-08-19):** `/profile` (`screens/Profile.tsx`), a global route (an identity is not
  language-scoped; chrome language = the `/` redirect's resolution).
  Name input — the charset rule is the SHARED one the server enforces too
  (`@whippin/shared` `sanitizeName`, root `AGENTS.md`), applied on every path that
  writes the value: the initial read, keystrokes, a composition's commit and the save
  body, so the editor can never hold or send something the route would refuse. Three
  details are this screen's own. Sanitizing a CONTROLLED input's value makes React
  reassign `node.value`, which collapses the text cursor to the END (its own
  save/restore is gated on the focused element having CHANGED, and it never does
  here), so the caret is placed by hand — from the sanitized PREFIX up to the cursor,
  since folding `é` and expanding `œ` both change the length before it — in a layout
  effect, plus a microtask for the one case that renders nothing (a keystroke that
  sanitizes back onto the name already held; React restores a controlled value after
  the event even with no re-render). A COMPOSITION is left alone while open — an
  AZERTY dead key rewritten mid-composition commits as `_` and never builds its
  `î` — with the raw value mirrored into state so the input stays controlled, and
  the rule landing on `compositionend`. And the field suppresses
  autocomplete/autocorrect/autocapitalize/spellcheck, so nothing is suggested into it.
  Then the 10×10 tap/drag-to-paint grid (one STROKE value per gesture —
  starting on a painted cell erases, so tap toggles; a painted cell plays a small
  one-shot BUMP, replayed by remounting the cell keyed on its paint count, so loading a
  stored drawing bumps nothing; an EMPTY cell wears the palette's background itself
  while the canvas behind the tiles wears a DARKER version of it, derived in CSS with
  `color-mix` from the one `--cell-bg` variable — never a second hardcoded shade per
  palette), the tool row — the palette swatches (each the palette's BACKGROUND colour
  since the same day's later pass; picking a ground picks the palette and its ink,
  and the drawing survives a switch) with the CLEAR chip on its right edge (empties
  the grid; disabled when already empty) — and SAVE (`.mix-btn`). No brush row (two colours need none) and NO key
  block: the copyable-key/paste-to-link UI was removed with `adoptPlayerSecret` (the
  backup affordance's future surface is an open decision — root `AGENTS.md`). Saving
  POSTs `{token, name, avatar}` via the OAC-hashed body (`api.postProfileBody`);
  server refusals surface on the app's `ErrorScreen` (#216 trigger rework — title +
  explanatory note; the moderation refusals offer no retry, a transport failure and a
  failed deploy carry TRY AGAIN, which re-runs the whole single-tap save).
  **OPENING THE EDITOR DEPLOYS NOTHING and SAVING deploys (user-decided 2026-08-24):**
  a tokenless editor opens WITHOUT any request, prefilled from the LOCAL placeholder
  identity (the persisted `gameStore.localSeed`, the leaderboard strip's own face) with
  those values as the baseline — so SAVE stays dark until something actually changes —
  and the SAVE tap bootstraps the account first, then saves into it: one tap, the
  button's own dots for both legs, a prefetched challenge so the deploy is fast. The
  name rule's WRITE half compares against the pseudonym the player was actually SHOWN
  (`assignedFrom`: the account's, or the seed's on a tokenless open).
  **A save into an account the editor did NOT load is GUARDED** (PR-219 round-3 review):
  the resolved account can be a RECOVERED or ADOPTED one that already holds a profile,
  and the editor's baseline there was a placeholder — a whole-profile upsert built from
  it would wipe the stored name or mark through the '' an untouched field sends. So when
  `loadedFor` mismatches, the save FETCHES the account's stored profile first and carries
  every untouched field forward verbatim (`guardedSaveBody`, contract-tested); only a
  field the player actually changed from the placeholder speaks, a fetch that fails
  refuses the save rather than risk the wipe, and a successful guarded save re-binds the
  editor to the account's merged truth. The load effect is
  deliberately keyed on [attempt] alone: an identity arriving under an OPEN editor (a
  deploy elsewhere, another tab) must not reload the fields out from under an edit in
  progress — the save path resolves the identity live. The devices list renders only
  when an account EXISTS (a tokenless device has no rows to list) and appears the
  moment SAVE's deploy lands, since the identity is read reactively.
  **The editor is GATED on the initial read** (the game
  route's own loading / error / content shape): an editable blank shown while the GET
  is in flight would be edited into and then overwritten by the response, and a FAILED
  read leaves the stored profile unknown — an editor started from that guess would save
  a blank over a real profile — so a failure shows `failedProfile` + RETRY instead of
  an editor. Unlike a score submission's silent failure, this read's is loud for that
  reason. A **404 is not a failure**: it is the answer "never customized", and since
  2026-08-20 it opens the editor PREFILLED with the player's ASSIGNED identity
  (`anonName` + `defaultAvatar` — the exact fallback every board row already shows; an
  editor opening blank while the board wears a name and a mark read as broken), with
  those values as the BASELINE too, so SAVE stays dark until something actually
  changes. **The assigned NAME is a DISPLAY value in both directions, never a stored
  one** (corrected 2026-08-20 on review; AMENDED 2026-08-26, user-decided — the
  locally-decided identity IS stored now, by acquiring an account itself:
  `state/localIdentityDeploy.ts` deploys the seed's assigned face as a new account's
  first profile. What stands here is the EDITOR half: an EMPTY stored name opens the
  field on the pseudonym — so a 404 and a name-less stored profile open identically —
  and a name still equal to that pseudonym SAVES as the empty name). The first cut
  stored it, on
  the reasoning that "storing it changes nothing anyone sees", which is false: every
  board gates its placeholder ink on the name being EMPTY, so storing the pseudonym
  flips that row from the muted placeholder to full primary, makes the player
  indistinguishable from someone who deliberately chose that handle, and freezes their
  name against every later generator change. The BASELINE therefore lives in DISPLAY
  space and the save BODY in STORAGE space; a player who types their own pseudonym
  verbatim stores empty and renders the same text in the placeholder ink — the one
  accepted cost of the rule (for the deployment half, that cost is the point: the
  promoted handle is the one the player has been wearing). The wired entry point is
  the ACCOUNT screen's EDIT chip (#204's split; it was the leaderboard's until then), and
  the header carries a BACK control — its title, per 2026-08-29 — to what opened it (user
  feedback 2026-08-20: the screen was unleavable) — **to the surface that
  actually opened it** (corrected 2026-08-20 on review): `/profile` is a GLOBAL route,
  so that board's language is not in the URL, and rebuilding it from
  `lastLang` describes the last loaded GAME instead — a board opened before ever playing
  could return in another language. The opener states its own route in the transient
  store (`profileReturn`, a transient store flag — set by the EDIT chip, cleared on
  use, never persisted); only an editor reached with nothing set (a deep link, a
  reload) falls back to the old guess, which still lands on a board.
  **The avatar RENDERER is `components/Avatar.tsx` over `components/avatarOutline.ts`,
  and the tracer STAYS** (user-decided 2026-08-19 — the alternatives do not render the
  same on every browser; see the root `AGENTS.md`). Decoding and tracing are ONE
  guarded memo, so a malformed stored string fails as "no mark" rather than taking a
  board of #190 rows down with it, and the tracer REFUSES a wrong-length grid instead
  of reading across rows into a plausible wrong picture.
  Editor VISUALS carry no tests per policy; what is
  contract-tested is the codec, the `parseProfile` shape check, the shared name rule —
  and the tracer, which is geometry rather than a visual: its suite asserts what the
  path FILLS (winding numbers read back off the emitted path, over every 3×3 mask and
  a spread of full grids), never the command syntax, since the property it exists for
  — no seam at a fractional DPR — is one jsdom cannot rasterize.

- **Group invite link (#271, replacing #189's player invite):** the link a member SHARES is
  `/g/<groupId>` (`pathForGroupInvite`, `@whippin/shared`'s `groupInvitePath`), served by
  the BACKEND so it unfurls in a chat as the group's name and its members' marks — see the
  root `AGENTS.md` for the preview's rules. What the SPA routes is the LANDING it bounces to,
  `/join/g/<groupId>` (`screens/GroupInvite.tsx`) — global like `/profile`. The preview
  cannot touch the group, because the membership needs the CLICKER's key and the clicker's
  device is the only place it exists. **THE DEV SERVER PROXIES `/g/*` (with `/s/*` and
  `/og/*`) to the local backend** — `vite.config.ts`, the CDN's own behavior list restated
  (the reasoning, and the pinned-OFF `changeOrigin`/`xfwd`, are #189's, unchanged).
  **A RESULT SHARE IS SIGNED AND OPENS THE DAY** (root `AGENTS.md`, Player profile):
  `SolvedScreen` signs every link with the device's account, with no
  control beside SHARE; a share carries NO group (the 2026-09-10 decision stands over the
  issue's earlier AS drum), so `/join/` carries the group landing alone.
  **JOINING IS A BUTTON, for everyone** (#216's trigger rule): the landing draws the group
  (a bounded `readGroup` — `api.readGroup` tells shown / gone / failed apart, the
  `readProfile` rule; gone ends the landing on EXPIRED, while failed offers RETRY of the
  bounded read) over ONE primary JOIN; the tap
  POSTs `{token, join}` — minted by that same tap for a brand-new visitor — with a loading
  wave in the button and the `ErrorScreen` for a transport/5xx failure. **A member already
  skips the landing** onto the group's board (the cached groups list says so; tokenless it
  is known-empty). **A SUCCESSFUL join is CONFIRMED on screen** — the group over `JOINED`,
  the BOARD as the primary way on and PLAY under it — and the answered list is published
  through `adoptGroups`, so the board opens on the group without a second read. The
  landing replaces itself in history. A NON-CAP 4xx is a VERDICT and continues into the
  game silently; **the two CAPS (409 `group_full` / `group_limit`, each read off its CODE:
  the group's room and the clicker's own `GROUPS_MAX` are different acts) and an EXPIRED
  link (404 `unknown_group`) speak** on the `LoadError` surface with PLAY as the way onward
  (`groupFull`, `groupLimit`, `inviteExpired`). Contract-tested (`GroupInvite.test.ts`).

- **Leaderboard screen (#190; drawn over GROUPS since #271, user-decided 2026-09-07):**
  `/<lang>/board` (`pathForBoard`; a board is per (day, lang), always the ACTIVE day), `screens/Leaderboard.tsx`, entered from the header's CROWN
  KEY (lit while the board is up; the way out is any other key, HOME above all). The
  HEAD is a PAGER (`ScopePager`, user-decided 2026-09-14 — the THIRD design of this
  control, after a strip of named tabs and a chip opening a wheel under the header's own
  wheel: "come up with a totally new leaderboard control design"): the SCOPES — every
  group, then GLOBAL (the untrusted top 50); with no group at all, ONE page that says so
  (`boardEmptyGroups`, a state, its body carrying CREATE GROUP) — are pages on one
  horizontal line on
  native scroll-snap, EACH PAGE THE LINE LESS A 44px PEEK AT EACH END, ONE PAGE A SWIPE
  (`scroll-snap-stop`), a neighbour's name LEANING against its page's inner edge (`--lean`,
  written off the scroll position, so a swipe carries it from the edge into the middle): the
  middle name stands alone and exactly ONE neighbour peeks in per side at half strength, its
  nearest letters showing, the outer part fading, whatever the names' lengths (user-reported
  2026-09-14, twice: a short neighbour centred in a 60% page never showed — "it might not be
  obvious that you can swipe" — and pages cut to their names' widths packed the neighbours
  against the brackets — "they should only be on the side, and you should see part of one
  neighbour per side maximum"); only the middle page shows its caption. The middle page wears the app's
  CORNER BRACKETS and a row of DOTS sits under it (the active one long). A swipe, a tap on
  a neighbour or a dot, and the arrow keys turn it (a dot or a key GLIDES, a cut under
  reduced motion); the dress follows the nearest page LIVE, the caller is told once the
  scroll SETTLES (90ms quiet), so a glide across three groups fetches one board. A tap on
  the middle page goes INTO it —
  the group's own screen; GLOBAL and the no-group page open nothing. **CREATING is the
  PLUS after the last dot** (`.scope-add`, `assets/icons/plus.svg`; user-decided
  2026-09-14 — a NEW GROUP page "is the design of the group title, but it's a button to
  create a group, feels like bad UX"), and CREATE GROUP is said in full (`groupCreate`). A group
  has THREE boards under the pager as ONE FRAMED SWITCH of three EQUAL cells (`.period-tabs`;
  user-reported: bare labels "float in the screen with no purpose, no affordance"): TODAY
  (the live one: finished, IN PROGRESS, NOT PLAYED YET — TODAY, not DAY, user-decided
  2026-09-14), WEEK and MONTH (the shared period rule, `PeriodList`: podium POINTS under
  the caption, the days and the total as a quiet detail). THE BOARD CARRIES NO STANDING
  BUTTON (user-reported: "3 huge thick buttons always on screen even if we use them 1% of
  the time"): a group of one shows INVITE in its empty state, and every other act is on the
  group's screen.
  **WHICH TAB belongs to a VISIT** (user feedback 2026-08-20; `boardTab` is `'group' |
  'global'` since persist **v19**, App resets it on any non-board route); **WHICH GROUP
  outlives it** — `gameStore.lastGroupId` (v19, account-owned: `reconcileIdentity` drops it
  with the account), set by every group tab opened and by the standing line's tap, the
  first listed group standing in for a stale or missing one. The period is the screen's own
  state. The groups themselves are `state/groups.ts` — ONE transient cache (`loadGroups`,
  `adoptGroups` after every write, `resetGroups` in `identityScope`), tokenless
  known-empty without a request. The list refreshes on board/invite entry and on opening
  group management, retaining a cached answer during refresh. Older reads cannot overwrite
  a newer membership write or identity. **THE DAY IS A LIVE VALUE** and **EVERY CACHE IS
  IDENTITY-SCOPED** exactly as before (a new day or a new epoch drops every board during
  render); one fetch per board ACTIVATION with the outcome per board key
  (`<group>:<period>` / `global`), stale-but-good over a failed refresh. A group's read is
  `POST /board {token, group[, period]}`; a 403 `not_member` (left elsewhere, removed)
  re-reads the groups list, since the list is what is stale. **OPENING THIS SCREEN IS NOT
  A TRIGGER (user-decided 2026-08-24)**: the deliberate acts are NEW GROUP (an inline form
  — one text field in the player name's charset via `sanitizeName`, never empty, CREATE)
  and INVITE (shares `boardInviteText` + `/g/<id>` via `useShare`, `tracked: false`);
  both are ONE TAP for a tokenless device (the mint, then the act, the button holding a
  LoadingWave; failures on the `ErrorScreen` — `failedAccount`, `failedShare`,
  `groupLimit`, `failedGroup`). **THE GROUP'S OWN SCREEN (`GroupScreen`, user-decided
  2026-09-14: "managing the group should have its own screen")** is a full-screen dialog
  in the selection's shell — the way back and the name in the header, the MEMBERS as the
  board's plain rows (`.board-row.member`: no rank column, never the WAITING row's dashes —
  user-reported 2026-09-14; the successor picker wears the same rows), dressed by
  `readGroup`, the owner tagged, the owner's `✕` at every
  other row's end (`.board-remove`), INVITE as the primary cap, LEAVE as the quiet danger
  word — there is no MANAGE toggle, the screen is the management. **NAMING A GROUP is
  THE GAME'S PROMPT (`GroupCreate`, user-decided 2026-09-14: "an act of creation that
  should be satisfying — reuse the game prompt input")**: `WordInput`'s dress — the
  cobalt `>`, the name in the pixel face, the blinking cursor — alone in the middle of
  its own screen over CREATE GROUP, on an EDITABLE field of its own (a name takes digits
  and underscores the on-screen keyboard has no keys for, so the phone's keyboard opens;
  every keystroke lands through `sanitizeGroupName`, cap 20). On CREATE the line gives
  way to the name INKED IN — the solve's cobalt pixel word with the hit's shake, held
  `INKED_MS` (1100ms) — and the screen folds itself onto the board already on the new
  group; an empty name shakes the line, the invalid guess's own answer. BOTH DESTRUCTIVE ACTS CONFIRM ON A FULL-SCREEN
  MODAL (`ConfirmScreen`, user-decided 2026-09-14 — "for such an important action, we
  actually need a fullscreen modal", replacing the two-tap word swap `LEAVE?` / `REMOVE?`):
  the member's face or the group's name over the act's title, one sentence, the act as the
  DANGER cap, CANCEL as the quiet word. The leave's note follows the SUCCESSION RULE (root
  `AGENTS.md`, Groups) off the list on screen: last member → "the group will be deleted";
  owner of two → "the other member takes it over"; owner of three or more → a PICKER of the
  others (the board's rows as radios, dressed by `readGroup`), LEAVE held back until one is
  picked, sent as `successor`; a stale list's 409 `successor_required` re-reads the list.
  A WEEK/MONTH row
  stacks its tiebreakers under the name (`.board-ident`) — beside it they ate the name on
  a phone. **A member already skips the landing onto the board, but never one this tab
  just joined** (`GroupInvite`'s module-level `joinedHere`): the tap that joins can also
  MINT the identity, and an acquired identity remounts the routed surface, so a remounted
  landing would otherwise read "member already" and skip the confirmation it just earned. Rows CONNECTED to
  the reader wear the ACCENT: on the GLOBAL list a member of any of your groups takes the
  2px inset left edge (`.board-row.mate`, the union of the cached groups' member ids — no
  extra read), your own row that edge plus the tint. An EMPTY board is the sad pixel ghost
  over one terse line, per view: `NO GROUP` (the tab strip holds only `+` and GLOBAL, the
  big action is NEW GROUP), `JUST YOU` (a group of one — counted WITHOUT the caller's own
  row, the 2026-08-20 rule), `NOBODY YET` (a period nobody recorded in; the global board).
  The rest of the 2026-08-20 board dress — pixel ranks and scores, mono names, the unit
  caption, the WAITING dashed rows under one caption, the no-rank tick, the ghost's
  integer-scale mask, the assigned identity for an unnamed player — is unchanged.
  Board VISUALS carry no tests per policy; the contract-y parts are the shared ranking and
  period rules, `parseBoard`/`parsePeriodBoard`/`parseGroups`/`parseStandings`, and the
  route grammar (`langs.test.ts`).
  **THE IDENTITY STRIP IS GONE (2026-08-30, with the header rework).** *(Historical — the
  INVITE paragraph below describes the #189 friends button; the shape is the group INVITE's
  now, per the bullet above.)* The board opened on
  the player's own mark + name as a row (from 2026-08-20; the door to `/account` from
  2026-08-26), and the header's right group now ends in the player's own face on every
  game surface — the same drawing, the same door, 40px above where the strip sat. Two
  identical faces stacked at the top of one screen read as a rendering fault, so the strip
  went, its duplicate profile read with it (`useOwnFace` is the ONE read now). Its rules
  OUTLIVE it and moved to the face key: it shows NOTHING until its read settles — a
  SKELETON, never a name (user feedback 2026-08-20: the first cut published the id the
  moment the bootstrap resolved it, rendered the ASSIGNED identity and swapped it for the
  real profile a beat later, so every named player watched a stranger's face flash on
  every visit); a read that FAILS still settles on the assigned identity; a 404 is the
  answer "never customized", whose display IS that identity; and **a device with NO
  account shows the LOCAL placeholder at once** (#216 trigger rework, user-decided
  2026-08-24): the persisted seed (`gameStore.localSeed`) derives the mark exactly as a
  board row would — an ANSWER, not a pending read. Nothing on this screen mints an account
  (opening the leaderboard is no longer a trigger; the tokenless friends board is the
  honest empty one without a request). The INVITE device-card button on the bottom edge —
  **at the tutorial's MIX's own 14px phone inset since 2026-09-02** (user-reported: it sat
  at 38, `.app`'s 28px pad plus the `.mix-btn` margin, "a weird feeling of the same button
  being moved around" between the two screens; `.board-invite` gives the pad back) — is
  always live: with an account it shares at once; without one the tap IS the deploy button — it
  bootstraps (loading wave in the button, `ErrorScreen` on failure, a prefetched challenge
  so the tap is fast) and then shares. The single tap accepts one degradation:
  `navigator.share` wants a fresh gesture, so a browser refusing the native sheet after
  the bootstrap round trip falls back to useShare's clipboard path (COPIED).
  Both are the #188/#189 wiring; both work before ever playing — and the invite
  share is the ONE `useShare` caller that passes `tracked: false`, because the pinned
  `share` analytics event means "a RESULT left the app" (the three-event invariant) and
  counting invite links into it would silently redefine what the number measures. Rows rise on
  the `rung-in` gesture staggered by index (delays survive reduced motion, the rise
  collapses). Board VISUALS carry no tests per policy; the contract-y parts are the
  shared ranking rules, `parseBoard`, and the route grammar (langs.test.ts).

- **THE HIT ART (decided 2026-08-09 to 2026-08-11; the sentence's holes land it since #301).**
  `components/strikeArt.ts` + `Strike.tsx` + `Loot.tsx`; every measured number lives in
  `index.css` beside the rule it sizes.
  - **Three sheets in `assets/hits/`, one frame rate** (`SLASH_FRAME_MS` 50): the CUT
    (`slash.png`), the BURST (`burst.png`) and the ULTRA star (`ultra-slash.png`). A strike is
    ONE BLOW of one sheet; the plain slash lands randomly MIRRORED, rolled once per hit.
  - **Two are MASKS, one is an IMAGE, which is a property of the art**: the white slash and
    burst are painted through a CSS mask in the strike's colour; the ultra is authored in
    colour and drawn as a background image (a mask would flatten its palette).
  - **An exact integer scale AND `image-rendering: pixelated`** (5x desktop, 4x at ≤640px):
    bilinear softens every edge that misses a texel centre, whole multiples included. Offsets
    are whole pixels, each MEASURED off its sheet's ink (the slash drops, the burst drops
    less, the ultra is centred). The size is fixed, never sized off the word.
  - **Invisible unless animating**: base `opacity: 0`, lifted by a fill-less `slash-show` for
    exactly the frame walk (`steps(n, jump-none)`). Under reduced motion each sheet holds ONE
    frame (the masks their second, the ultra its third, since frame 1 is a white flash), and
    the ultra needs its own `animation: none`.
  - **The word answers the blow for `STRUCK_MS`**: four frames, one short of the shortest
    sheet, so the sheet's last frame dissipates over a word already at rest; JS and CSS share
    it through `--shake-ms`.
  - **The LOOT is ballistics, never a float**: an outer box drifts linearly while the inner
    one rises ease-out and falls ease-in. The side and bounded jitter factors on distance,
    height, drop and tilt are ROLLED per hit (`--loot-j*`, factors on the CSS geometry so the
    ≤640px step-down still reaches them); the timing is handed to CSS as variables.
  - **Two rules learned on it, for wherever type lands on type again: NOTHING IN THIS APP
    OUTLINES TYPE, and `scale` IS NEVER ANIMATED ON THE PIXEL FONT** (blurry frames for the
    whole transition, the integer-scale rule).
- **The score WATERMARK is `CellDigits`**: sized from the VIEWPORT alone, in whole device
  pixels, and for at least TWO digits whatever it reads (`MIN_SIZED_DIGITS`, decided
  2026-08-09), so 9 → 10 never halves it mid-round; past two digits it moves. A PLAIN FILL in
  `--fg` at 20% (`INK_ALPHA`, user-decided 2026-09-01), every lit cell collected into ONE path
  filled ONCE (a `fillRect` per block seams at a fractional dpr); no halo, no opaque base.
- **A long guess CROPS ITS OWN HEAD** (decided 2026-08-06): `.wi-text` is a
  `justify-content: flex-end` window with `overflow: hidden` around `.wi-text-run`, so the
  letters just typed and the caret hold their place and the beginning slides off the left; the
  value stays whole in the DOM. Two `min-width: 0`s are load-bearing: on `.wi-text`, and on
  `.input-area` (a grid item that otherwise inflates to its content and pushes the page
  sideways).
- **Hole WHEEL (user-decided 2026-09-01, REPLACING the history modal below):** tapping a
  HOLE no longer opens a screen — its place in the sentence becomes a fixed SLOT, and the
  words already found for it stand in ONE column that SCROLLS THROUGH that slot with
  mandatory snap, item by item, a picker drum: **farther words above, closer below; the word
  in the slot wears the hole's own chip at the sentence's own size, the others stand plain
  at 0.8× of it; and the word in the slot when the wheel FOLDS is the pick** (`Game`'s
  `picked`, DISPLAY-ONLY: the round's state, score, progress and history all read the real
  holes; never persisted; it lasts until the hole next IMPROVES). Tap a row and it glides
  into the slot; tap the slot, outside the column, or Escape, and it folds — ONE door
  (the dialog's `close`) for all three, and **the pick lands on that fold, never while the
  wheel is open** (user-reported 2026-09-01: a live pick swapped the real hole beneath, its
  scramble played under the overlay and a word of another length reflowed the sentence,
  moving the hole to another line under a slot that stays put). The sentence under the
  wheel is FROZEN; the slot row stands in for the word at its measured place; the hole
  swaps with its usual choreography once the overlay is gone. **It is the day's FIFTH approach**, the
  brief for it being "item-by-item scrolling, beautiful, works well on all devices and
  especially on mobile": a radial NET on rings with curved strokes (the user's
  `inspiration/words net.png`) was built first and revised twice (random scored layouts,
  heat-coloured trimmed strokes, floating tiles; then deterministic, gapless, uncoloured),
  then a plain STACK — left-aligned tiles above and below the word, the dialog scrolling —
  whose scroll revealed the redrawn hub over the real word beneath. The wheel has NO
  separate hub: the slot row IS the row of the current word, drawn on the measured line of
  the tapped word with the hole's own markup (`data-hole-explore` → `.hole-word-wrap`, the
  font size and line height copied; one correction measured on open), so nothing sits
  behind it. Geometry is all the sentence's: a row is one line box tall, rows one `GAP`
  apart, the leading spacer is the slot's own height off the scroller's top and
  `scroll-padding-top` the same, so row i sits in the slot at `scrollTop = i × pitch` and
  the current row is read straight off the scroll position. **EVERY stop is a row, and every row is a pick** (user-decided 2026-09-01, in two
  passes: "let the wheel reach all the words, or else some might never be seen", then
  "you should be able to select far words, so remove the dashed line and the different
  look") — the words behind the start included, first by rank; the model's `behind` flag
  is not read by this surface at all. **THE VEIL:** while the wheel is open the tapped hole's own word and exponent are
  `visibility: hidden` in place (`Hole`/`SolvedWord` `veiled`, from `Game`'s
  `historyHole`) — the box stays, nothing reflows — so a shorter word in the slot never
  shows the longer word's tail through the dim (a `--bg` band over the word was tried
  first and covered the watermark, user-reported). **THE DRUM MOVES LIKE THE iOS DATE PICKER** (user-decided 2026-09-01, the fifth pass on
  the feel — "pixel by pixel" → a one-row stepper → "sticky" → native snap with momentum →
  "snapped inertia" → a hop-by-hop ratchet → "unstoppable, a small swipe keeps scrolling
  for seconds" → this): no native scrolling (`overflow: hidden`, `touch-action: none`);
  the drum writes the scroll position itself — **since 2026-09-02 that drum is
  `hooks/useDrum`, shared with the title's `PuzzleSelect`**, `HistoryWheel` supplying only
  its `write` (a scrollTop). A DRAG follows the finger pixel for
  pixel (rubber past the ends); on release the drum travels its velocity × `FLING_S`
  (0.16s) rows, capped at `FLING_MAX_ROWS` (8), snapped to a row, in ONE eased-out glide of
  `GLIDE_BASE_MS` + `GLIDE_ROW_MS` a row (≤ `GLIDE_MAX_MS`) — a small swipe moves a row or
  two, a strong one a handful, never for seconds. A mouse wheel or trackpad moves the drum
  directly (`WHEEL_GAIN` of its pixels) and it snaps to the nearest row `WHEEL_IDLE_MS`
  after the last delta; ArrowUp/Down glide one row; a tap on a row glides to it. A press
  that travelled `DRAG_PX` is a drag, and the click it ends on is not a tap (on a row, or
  on the column, which would otherwise fold). Pointer capture is deliberately NOT used: it
  retargets the click that follows a tap onto the column, which the dialog reads as a tap
  on nothing. **A COMPLETED hole opens the WORDS MODAL instead** (same day, superseding a pass that
  merely disabled the tap at rank 0): whether or not the rest of the sentence is done, a
  hole at rank 0 has nothing to swap in, so its tap opens `components/HistoryModal.tsx` —
  the old history modal's full screen with the ROAD TAKEN OUT: no rail, no nodes, no
  distances; the found word as the headline in the solved ink, then every word found for
  it as a plain GRID, closest first, each with its exponent, every word in `--fg` and the
  ones the player actually TYPED wearing the held word's inverted CHIP (user-decided the
  same day, superseding a 0.55 dim on the never-typed ones — the app's one emphasis
  gesture, so a chipped word reads as yours exactly as it does in the sentence), "like on
  a synonyms website". **ONE type size** (user-decided the
  same day: "avoid reducing the font size, even if it leads to less columns"): the column
  is as wide as the LONGEST word needs at 15px (`repeat(auto-fill, minmax(<that>px, 1fr))`,
  set inline), so a wide screen fills its width with as many such columns as fit and a
  phone gets one or two; only a word wider than the whole frame shrinks, alone. The list FADES into the
  ground as it scrolls up under the header (a 40px top mask on `.hw-scroll`, padded so
  nothing fades at rest — the game header's own fade, which a dialog's scroll never
  lights). The
  shared `ModalHeader` + Escape are the ways out (a fade, `hw-out`). The solved stage's
  word buttons open it too. `Game` picks the surface off the hole's rank (`wheelOpen`),
  and only the wheel veils the word beneath it.
  Exponents are the hole's own superscript (`.hole-rank` in the slot, `.wheel-rank` on
  plain rows — a flex row had flattened `<sup>`, user-reported). What it keeps: the pure
  model (`buildHistory`, which gained `display`, the canonical form the slot shows), the
  `revealed` dress (0.55), the `given` dress — THE SEA, see the #301 bullet — and the hole's TRUE position wearing an LED in `--hole` when the
  slot holds a pick, `holeTitle` as the dialog's name, `srRouteStop` per row; on the solved
  stage the secret is appended as the last row (rank 0 is never a stop) and nothing picks.
  A word too near the right edge of a phone (`MIN_COLUMN`) stands the column on its RIGHT
  edge. The scroller hides its scrollbar and fades both ends (a mask). **A PLAIN ROW
  STANDS ON ITS OWN GROUND** (user-decided 2026-09-02: at the quarter dim the rows printed
  over the sentence's words — "you don't have wheel items over sentence text"): `.wheel-plain`
  boxes the WORD on the `--surface` tone, drawn as the chip is drawn (an absolutely
  positioned em-sized pseudo, no layout, so the letters keep the slot's x), a little
  taller than the chip — 1.5em against 1.267 (user-asked the same day, "a few more pixels
  of vertical padding") — and since 2026-09-22 the EXPONENT stands OUTSIDE it on the
  ground, a clear gap past the box's overhang, on every plain row, given or typed
  (user-decided in three passes: "out of the background", "it touches it", "a few pixel
  more detached… the same for non holo words"). Buttons carry `font-variant-ligatures:
  none` app-wide since the same day: the UA's `font` shorthand on a button reset the body's
  rule, and the plain rows' one-text-node words grew `fi`/`fl` back (user-reported). **The
  column is INSET by the chip's overhang on the word's own side** (`OVERHANG_EM`, 0.2em of
  the sentence plus a pixel, as padding inside the scroller's box — user-reported the same
  day: "when you click on a hole word, the left padding disappears"; the scroller began
  exactly on the word's x with `overflow: hidden`, so the slot chip's and the grounds' left
  overhang were clipped; the rows' text still starts on the word's x, measured at both
  breakpoints). **AND THE FOLD LEAVES THE SLOT ROW STANDING** (user-reported the same day, "the hole word
  blinking on wheel close"): `wheel-out` fades the DIM (background-color) and
  `wheel-row-out` the plain rows, while the slot row — the hole's own markup at the hole's
  own place — holds at full strength until the dialog leaves; and the fold itself (the
  pick and the unveil) is `flushSync`ed from the exit animation's END handler, before the
  hook closes the dialog in that same handler: `dialog.close()` fires `close` on a LATER
  task, and `animationend` is not a discrete event, so a fold riding either was committed a
  frame after the slot row had gone — one frame with no word at all, measured. For a PICK, `Hole`
  starts its scramble in a LAYOUT effect, so the churn's first frame paints in place of the
  old word instead of one frame after it. The title's selection wears its own whole-screen
  fade (`select-out`), since the dim-only exit is the wheel's. It stays a native
  `<dialog>` on `useModalDismiss` (`wheel-out`) — the sentence and the keyboard under it
  must be inert — but it is the PuzzleSelect's KIND, so a tap OUTSIDE closes it. What is
  GONE with the modal (no-back-compat): the MISSED shelf (a miss is not a found word and
  cannot be picked), the `dq`-spaced line and the `???` terminus, `Game.openHistory`'s
  measuring, the zoom/retract keyframes, `.history-*` CSS, `ModalHeader` on this surface
  and `srRouteDestination`.
  *(The paragraph below describes the modal it replaced, kept for the decisions that
  survive in the wheel.)*
- **Hole HISTORY modal (user-decided 2026-08-10, REPLACING the #117 route map; ITSELF
  REPLACED by the wheel above, 2026-09-01):** tapping a
  HOLE opened the round's own journey toward that hole's secret — the player's guesses as
  stops on ONE line walking down to the hidden word. What the user retired is everything
  that made the map unreadable and never helped anyone: the censored census of every
  unfound group, and the sticky "you are here" machinery. What
  SURVIVED it — restored on review the same day, after a first cut as a flat sorted list
  proved legible but empty ("no starting word, you had to read the exponents to infer the
  order, no notion of reaching an unknown target") — is the map's SPINE: the journey
  reading is the value. `game/history.ts` is the pure model (`buildHistory`,
  contract-tested) and `components/HistoryModal.tsx` composes it out of the shared
  `routeDrawing` parts.
  **The line, top to bottom:** the MISSED shelf (off-map guesses, try order), the broken
  tail out of the void, every ranked try as a stop FARTHEST FIRST with connector lengths
  carrying the real `dq` distances (uniform `LINK_MIN` fallback on pre-#115 data — the
  modal degrades instead of refusing, so the old `hasRoute` gate stays dead), then the
  solid leap into the terminus: the fixed-width `???` — wearing the holes' own dashed
  open-blank line — while the hole is open, the accented secret (blank gone) once found.
  "You are here" keeps its gold node — read off the
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
  (`HistoryStop.behind`, model-derived — the journey runs departure → word, so anything
  farther than the start is behind you) and goes GREY — word at the census's own 0.55, small muted
  node — with the CONNECTORS entering it (and entering the departure from behind
  territory) staying the broken trace (`RouteLink broken`, heights `dashedRun`-snapped by
  the caller). **From the departure down — the START WORD INCLUDED — the WORDS wear the
  pale hole blue** (2026-08-17 final palette: they are words the player HOLDS, in the
  held-word colour; a live-gradient word per stop was built between the uniform accent and
  this, and rejected with the sentence's — the gradient stays in the gutter exponents;
  `route-ahead`/`route-you` — the zone classes are EXCLUSIVE per stop, HistoryModal
  picks one, so each zone owns its dress outright), the nodes staying the found stop's
  plain `--fg`. **The DEPARTURE has NO station state of its own** (user-decided 2026-08-10,
  superseding its muted node + 0.62 dim, and `route-departure` is deleted with the rule):
  it renders EXACTLY as a valid guess does, because it is a word the player holds like any
  other, and singling it out made the line's quietest stop out of the one it begins at.
  What still says "the walk starts here" is structural and needs no per-stop dress — the
  broken trace ends AT it, and everything above it is grey — so `HistoryStop.start`
  survives in the MODEL alone, where the sr mirror and the dashed-connector boundary read
  it. The CURRENT word alone gets the BIG orange square — the `--accent` "you" marker —
  while its word stays in the pale hole colour like the rest of the walk: the hole as it looks in the sentence,
  transplanted onto the line. **The RAIL keeps its own `--rail` everywhere** (a green
  journey stretch was tried and walked back the same day — the type and the nodes carry
  the zones, the dashes still say where the walk begins, and the line stays the app's one
  quiet rail). **The terminus node is the SOLVE cobalt from the first frame**
  (the point to reach is a square in the solved-word colour — what the secret wears once
  won, so the `???` square says what it is before it is), and the word beside it joins
  it, blank line gone, at the solve. The MISSED shelf's words wear the same weird-red
  `MISS_COLOR` as its heading (see the front-loop MISS bullet), dimmed to the same 0.55 (`.route-miss`), and the
  shelf holds 48px off the line
  (SHARED `.route-misses` since 2026-08-11, superseding the history-only override — on a
  one-trunk line the shelf is the drawing's top neighbour and read as the first stop's
  label at 26). So: red
  and shelved = never on the map, grey on the dashes = behind where you started, pale
  hole blue from the start word down = the words you hold, the orange square = where you
  stand, the solve-blue square = the target (blank-lined until it is). The rail-to-word gap is likewise the SHARED drawing's since 2026-08-11
  (`--word-gap` 14px on `.route-frame`, paid by `.route-body` and subtracted from both
  frames' `--wordw` — it started as this modal's own fix for words sitting on the trunk).
  The sr mirror says the third
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
  button (`game/route.ts`, `RouteModal.tsx` and their tests are deleted).
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
  with it; `.hole-word` keeps its own flat `color: var(--hole)`. The shared gradient lives
  on the exponent alone.
  The wave needs per-letter boxes, which did NOT exist — the scramble renders a plain
  string — so `Hole` now splits the word ONCE (`.hole-letter`, used by the resting word and
  the scramble's frames alike; measured against plain text: same height, +0.06px over 5
  letters, and `.hole`'s `nowrap` means the boxes add no wrap opportunity).
  **EVERY hole owns its clock** (decided 2026-07-27, replacing a round-level scheduler that
  picked ONE hole at a time): each waits a fresh random `WAVE_MIN_MS`–`WAVE_MAX_MS` (3–10s,
  re-rolled per wave and whenever the sentence goes quiet again), so several words can stir at
  once and the holes scatter on their own instead of being kept apart.
  **That clock is `hooks/useLetterWave`**: pure scheduling — two timers and a random band,
  knowing nothing about holes — while the hole keeps `active`, its own answer to "is this
  word free to ripple right now?" (`ticking`). `WAVE_VARS` hands CSS the same two numbers the
  hook ends a wave on. A lone ripple travelling
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
  404→`noPuzzle` path is reused as-is. The calendar reads each SENTENCE day's status
  from the **private server summary** (#211's month read, `state/history.ts`) through
  `state/status.ts` `statusOf`. It was the persisted rounds
  until #214 removed them. **Cell coloring (decided 2026-07-08):** a day with
  any reconstruction (>0%) is FILLED with its `progressHeatColor(pct)` (solved counts as
  **100%** — the calm cobalt ramp top), and its number is drawn in `--bg`
  so it reads on the fill; disabled and not-started/0% days keep the neutral surface +
  number color. **A SOLVED day also RIPPLES (decided 2026-07-08):** a shading wave, so a
  validated day is distinguishable from an in-progress one by MOTION, not only color. It
  plays `web/src/assets/ultracode.png` — a **12-frame horizontal sprite sheet** (144×12,
  12 square 12×12 frames) — as a CSS background on `.cal-ripple`: `background-size:
  1200% 100%` fits one frame to the square cell and `steps(12)` walks `background-position-x`
  (end value `100%×12/11` so frame 11 lands on 100% and loops cleanly), `image-rendering:
  pixelated` keeps it crisp. (Superseded the earlier hand-computed SVG-path ripple.)
  Reduced-motion hides it; the static fill + aria-label carry the status, and the solved
  day number switches from `--fg` to `--bg` so its small text keeps normal-text contrast
  against the exposed cobalt fill.
  **The grid is a FIXED SIX WEEKS (user-decided 2026-08-18): `monthGrid` pads to 42
  cells, so a 4-week February and a 6-week month stand the same height and paging never
  moves the calendar.**
  The calendar itself is **vertically centered** (`.archive` flex column, top padding
  clears the fixed header). **The live streak stat moved out of the archive body and into
  the shared `TopBar` (decided 2026-07-11):** immediately right of the language control it is
  only `assets/streak-small.png` (the 8×10 pixel-art source displayed at an exact 3× =
  24×30) plus a larger bare streak amount; a zero/broken streak remains hidden. Entry: the header's DATE CHIP
  (since 2026-08-18; a calendar icon in the right group before that); `dateForDayNumber` (`shared/day.ts`) is the `dayNumber`
  inverse. The **OG share page** (`backend/ogCard.ts` `renderShareHtml`) now click-throughs
  to the **shared day's** date-addressed URL (`/<lang>/<dateForDayNumber(dayNumber)>`),
  not bare `/<lang>` — so a shared archive result opens that archived date, not today (the
  card/title named the right day all along, as `#<dayNumber>` then and as that same date
  since 2026-08-03 — see the share-card bullet). The archive **must not touch streaks**
  (separate issue).
- **The solved SCREEN — THE SCORE ON TOP, THE SENTENCE'S PAGE UNDER IT (user-decided
  2026-09-08, on #266's second review). It supersedes the same morning's "keep the
  sentence and RISE it, the result grows around it", which put SHARE below the fold on
  most phones, and it RESTORES the 2026-08-14 hand-over: the sentence DISSOLVES and the
  result takes the whole column.** The rule: the score block is the same height on every
  round and sits at the TOP, on screen AT REST on every phone — SHARE is the reveal's
  closing beat and the liked-indicator; the sentence's PAGE is the round's
  variable-height content. **THE WHOLE STAGE SCROLLS AS ONE, AND THE CREDIT STICKS**
  (user-decided 2026-09-08, third pass: "the whole page scrollable, and the title sticky
  below the header, so you can scroll and remove the score/share view, but you always
  have the source somewhere on the screen"): once the reader reads, the score and SHARE
  scroll away with the page, the credit sticks at the scroller's top edge on its own
  ground, and a tap on it returns to the top. The earlier "the page is the one thing that
  scrolls" (the same morning's second pass) is superseded by this.
  - **The sentence's EXIT is the DISSOLVE** (`components/DissolvePhrase.tsx`, the
    2026-08-14 decision unchanged): once the keyboard has dropped, the live `Phrase`
    hands its exact pixels to a letter-boxed copy that erodes them through the
    scramble's own churn, scattered, in a fixed window (`SPREAD_TICKS`) so a long sentence
    goes out in the time a short one does; a dissolved letter keeps its box
    (`.hole-letter.gone`), never a space. The tray stays mounted and EMPTY under it, so
    `.play`'s centring never moves the sentence while it erodes; `dissolved` is the flag
    the swap hangs on (false through a live round, true from the first frame of a
    rehydrated solve), and `finishDissolve` is the DOM's own report.
  - **The result is a STAGE** (`components/SolvedScreen` → `.solved-stage`, `flex: 1 1 0`
    + `min-height: 0` so its height is DEFINITE inside `.game`'s auto-with-a-min box — a
    `1 1 auto` item sized by its content grows the page instead), centred, rising in the
    way the tray results always have (`RESULTS_IN_MS`), stacking TWO parts with ONE gap:
    - **SCORE** (`.solved-numbers`) — the named `<tries> TRIES` headline (the #170 TOP
      badge beside the number since 2026-09-05) over the run ruler, **then SHARE**, which
      belongs to this block (user-decided 2026-08-14, third pass: sharing is
      what you do with a RESULT). Centred and capped at the keyboard's 680px. Measured on a
      375×667 phone: 197px tall, SHARE landing at y 226–273, where the block ends, with
      the whole page still below it.
    - **PAGE** (`.solved-page`) — the sentence's page, read TOP-DOWN the way a page is
      (user-decided 2026-09-08: "with the source above the text, we can start by a few
      sentences before the puzzle" — no auto-scroll onto the line): the **SOURCE credit**
      first, left-aligned, then the **TEXT** in the READING face (`--ui`, 16px, 1.6), where
      the puzzle's line is in the ink (`.solved-line`) and — with #270 — the raw sentences
      before and after it are the MUTED text around it. That contrast IS the highlight:
      never a marker band, never the pixel face inside a paragraph. **The STAGE is the
      scroller** (`overflow-y: auto`, `overscroll-behavior: contain`, `pixel-scroll`,
      `position: relative` so the sr-only hints under a long page are contained rather
      than growing the document — measured 523px of page scroll before), fading its
      BOTTOM edge over its own 24px padding (on a phone plus the home-indicator inset);
      its top has no fade, because what passes there passes under the credit. **The
      credit is `position: sticky; top: 0`** inside the page (its containing block, so it
      sticks while the page is in view and leaves with it) on flat `--bg` with a 24px
      `--bg`→transparent gradient hanging under it (`::after`), so the text disappears
      under the credit rather than through it, and **a tap on it scrolls the stage back to
      the top** (`backToTop`, smooth unless reduced motion): the running head is the way
      back to the score and SHARE. On a phone that fits, nothing overflows and nothing
      moves. **A FINISHED round's secrets open the words MODAL, found or not** (PR-272
      review): a capped round's unfound holes keep a rank, but the wheel measures the
      board's own `[data-hole-explore] .hole-word-wrap`, which the page's secrets do not
      wear, and a pick has nothing to swap into a page that already shows the answer —
      `wheelOpen` is false once `finished`.
    - **The SECRETS are BUTTONS inside the line** (`.solved-secret`: the solve blue, font
      and line inherited, no box, `inline-block` for the pop), one per OCCURRENCE (a slug
      appearing twice yields two, sharing one distinct-secret `number` — the ruler ticks'
      own — so they pop on one beat and open ONE history line), with the affixes in a
      nowrap group (Phrase's rule). The tap opens the words modal (a completed hole's own
      surface since 2026-09-01); `Game`'s `solvedHoles` memo is the result's view of
      `puzzleHoles`. They carry no number chip and no wave: prose is not a board.
    - **The SOURCE is the credit block it has always been.** **It is a CREDIT
      BLOCK of TWO lines, and the second one is a PHRASE** (user's own shape, 2026-08-15,
      superseding three stacked fields the same day and the `— Author, Work` run-on before
      them):

      ```
         Les Misérables         the WORK — the credit's headline: the accent, `clamp(14px,
                                1.9vw, 18px)`, the biggest type in the block
         BOOK by Victor Hugo    what it IS and who it is by — muted, 10px, ONE phrase
      ```

      The earlier cuts stacked the fields as peers, which left the reader guessing which
      name was a person: a separator only ever says "these are two things", never which is
      which. Here ONE thing is named and the line under it says what that thing is and who
      made it — read, not decoded. The function word (`sourceBy`, en `by` / fr `de`) binds
      them, earning its place the way `OF` does in `RANK #5 OF 59`; it is the app's ONE
      lowercase string, because it is part of a phrase rather than a label, and the KIND
      beside it is uppercased in code to keep that contrast. **The KIND is LOCALIZED**
      (user-decided 2026-08-15, `sourceKind` in `i18n.ts`): it is the one part of a source
      that is a CATEGORY rather than a name, so it translates where the work and the author
      never could — `LIVRE de Victor Hugo`. It lives OUTSIDE the `STRINGS` table because it
      is not a UI key: `kind` is puzzle DATA and an explicitly OPEN set (#5), so the lookup
      PASSES THROUGH anything unlisted, uppercased, exactly as the puzzle wrote it (one
      published fr puzzle already carries a free-form `discours`). The five documented
      kinds are the whole table — adding an invented one would claim generation emits it.
      Every field is independently optional in the schema (#5), so the HEADLINE is the
      first of work / author / kind that exists and the qualifier is whatever is left: an
      author with no work takes the headline (a lone name is not a credit to anything, and
      `by Victor Hugo` under nothing is a sentence missing its subject) with its kind alone
      beneath it, and a source carrying only a kind is just that word. The typewriter is
      one character run across whatever lines exist.
    - **The EXCERPT and the track link (#270) live HERE and nowhere else**:
      `source.excerpt.before`/`after` are joined into the muted text around
      `.solved-line` — one paragraph, read top-down from the credit, no auto-scroll onto
      the line — and `source.url` is LISTEN (`.solved-listen`, i18n `listen`): an
      ordinary link under the text, new tab, `rel="noopener noreferrer"`, no embed and no
      third-party script. A puzzle carrying neither shows credit + sentence, and nothing
      looks missing. `parsePuzzle` REFUSES a malformed excerpt (two string arrays or
      nothing) and a non-`http(s)` url (it becomes an href). Songs get NO lyrics (the
      #270 decision stands, reaffirmed 2026-09-08: a verse or chorus is still reproduced
      lyrics). Not here: excerpts on the archive calendar, the share page or the card.
  - **The reveal reads dissolve → score → standing + SHARE → page since 2026-09-11 (see
    the card bullet above; the paragraph below describes the 2026-09-08 page-first order
    it replaced, and its beats still hold in their new places).** The stage rises in;
    the CREDIT types (`SolvedCaption`, hidden with `visibility` until its beat so the text
    never moves when it speaks) while the SECRETS POP into the line one by one
    (`solved-word-pop`, `WORD_STEP_MS` 200 apart, `WORD_POP_MS` 300 — the 2026-08-14 pop,
    back in the gaps the words were taken from; only `opacity`/`transform` move, so the
    line's layout is final from its first frame); then the SCORE block follows once the
    citation has **FINISHED PRINTING** (user-decided 2026-08-15: numbers arriving over a
    half-typed credit read as two things happening at once, where waiting reads as one
    thing after another). That is the screen's ONE signal-driven beat — it rides
    `SolvedCaption`'s completion callback — so it carries a DEADLINE behind it
    (`captionDurationMs(source)` + slack, the `KB_EXIT_FALLBACK_MS` rule: a lost signal
    must never be able to stall the solved sequence), derived from the typewriter's own
    numbers and counting **VISIBLE time only** (the interval is throttled on a hidden tab,
    so a wall-clock deadline could reveal the numbers over a half-printed credit on
    return). A source-less puzzle's numbers follow the pops. **Inside the block the reveal
    runs score → standing → SHARE (user-decided 2026-08-16):** the card lands reading 0
    over the whole bar, every cell there and none coloured (user-decided 2026-09-11); then
    the tally counts its `SCORE_COUNT_MS` WHILE the bar colours in try by try, each tick
    standing as its try is reached — `RunRuler` fills off the count itself (`filled`), so
    the number always says how many tries are coloured — one beat saying "here is your
    run"; then the STANDING and SHARE land TOGETHER (`shareIn`), a breath after the count
    LANDS (the eased, rounded number shows its final value well before the tween's own
    end, so a timer off `SCORE_COUNT_MS` held a dead beat). SHARE also waiting out the
    standing's own rung-in was "way too long" (user-reported 2026-09-11). The standing's
    slot is always mounted; SHARE hides IN PLACE with its footprint kept, so neither
    arrival moves anything.
  - **Nothing that has landed ever moves:** the score block holds its footprint from frame
    one and arrives at `opacity: 0`, the credit holds its box hidden, the secrets' boxes
    are open before they pop. Rehydrated solves render `.settled` and replay nothing.
  - **The score WATERMARK goes with the round** (`.play-finished`): it fades the moment the
    board is solved — the count's next appearance is the result's own headline — so it is
    already gone when the sentence dissolves.
  - **ANY TAP OR KEY DURING THE REVEAL FAST-FORWARDS IT — AND STILL LANDS ON WHAT IT HIT**
    (user-decided 2026-08-16, #179). The scope is the whole hand-over: from the moment the
    solving beats give the screen back (the keyboard's drop, then the dissolve) through
    SHARE's arrival. **The settled end state is EXACTLY what a rehydrated solve renders**,
    reused rather than reimplemented — `Game.settleReveal` writes the three terminal values
    in one batch (`keyboardLeaving` false, `dissolved` true, `animateResults` false), and
    every beat in `SolvedScreen` already answers `animate: false` with its own final value,
    so there is no parallel fast path to keep in step with the choreography. One CSS
    consequence, because the settled frame is reached from HALFWAY THROUGH rather than at
    mount: `.solved-stage.settled` kills the transitions and the pop the rehydrated path
    never starts (a half-popped word killed mid-animation is otherwise stranded at full
    size). The ruler needs nothing of its own: it fills off the count, which snaps with
    the rest.
    **The gesture is never swallowed:** the listener is CAPTURE-phase on `window` and
    neither cancels nor stops the event, so a tap on a found word settles the result AND
    opens that word's history, and Enter/Space on a focused control settles AND activates
    it natively. It listens for `click`, not `pointerdown`, for two reasons — a click's
    target is fixed before the listener runs, so settling can never pull a control out
    from under the finger between press and release, and a SCROLL (a real gesture on the
    page) produces no click and must not read as a skip.
    **It is armed for the reveal's own span only** (`revealPlaying`): from the hand-over
    (`showResults`, which is also when the drop starts) until the result reports its LAST
    BEAT (`onRevealEnd`, on SHARE's arrival — `revealEnded`, reset with the round; PR-272
    review: `animateResults` stays true after the reveal, so the listener never stood
    down), never while the streak
    celebration stands — that screen keeps its OWN fast-forward → dismiss handling, and
    the tap that dismisses it must not spend the reveal it is handing over to (its
    dismissal lands 200ms later, past its exit fade, so the arming cannot catch that same
    gesture either) — and never under the dev `?streak=N` preview, which holds the result
    at frame zero behind a modal this round never sees. The standing slot snaps to
    whatever is true right now: `ScoreTop` renders nothing while the population read is
    out and appears settled when it lands, so the skip never blocks on, or fakes, the
    network. Reduced motion is unchanged (already near-instant). **Skipping the SOLVING
    choreography is deliberately out of scope.**
  - **REMOVED with the 2026-08-14 redesign** (no-back-compat rule, all were left without a
    consumer): the caption's `masked` veil and its prompt-zone overlay (the caption mounts
    only WITH the result, so an unsolved round's DOM never carries the author hint at all —
    the leak the veil existed to plug), the SOURCE-reveal beat machinery and its 6s
    visible-time fallback (`sourceReveal*`, `SOURCE_REVEAL_FALLBACK_MS`, `solvedSettled` —
    nothing downstream waits on the typewriter any more), and the tray's sentence-results
    state (`.tray.tray-results`).
  - **REMOVED with #266's second cut** (same rule): the RISE — `PHRASE_RISE_MS`, the FLIP
    measurement in `Game`, `SolvedScreen`'s `RISE_MS`/fragment return — and `.play-result`
    (the play area as a scroller, its top fade, the auto-margin seam); the 2026-08-14
    trophy ROW (`.solved-words`, `.solved-word*`, the numbering chip, the letter wave on
    the result's words) is gone with the first cut and stays gone.

- **Solved-result content (decided 2026-07-10; the LLM benchmark display — standings
  lineup, leaderboard dialog, SEE MORE — was REMOVED on 2026-08-12, user-decided: the
  comparison story will be other players' scores, not recorded model runs; the tray-stack
  LAYOUT this bullet used to open with was superseded 2026-08-14 by the solved-screen
  bullet above — the ruler/share-card/emoji-row rules below still stand):** the named
  `<tries> TRIES` headline, the PLAYER's full-width **run ruler**, then SHARE. **The run RULER replaced the bucketed
  trajectory squares (decided 2026-07-25):** one continuous bar per run
  (`components/RunRuler.tsx`), one cell per counted try — the RAW `replayRun` trajectory,
  no on-screen bucketing — with a white tick at each try that solved a secret and the
  hole's sentence index (1..3) under it; one guess dropping several secrets stacks its
  indices under ONE shared tick (`replayRun` in `web/src/game/share.ts` walks the run
  once and returns the trajectory and the solve moments together).
  **The cells use the app's ONE weird→calm gradient:** a try's reconstruction percentage
  reads linearly through `progressHeatColor`, from the red MISS/weird terminus through
  amber, coral and orchid to the cobalt solve/calm terminus. Rank surfaces share the same
  stops but map distance logarithmically through `rankHeatColor(rank)`, whose absolute
  `HIT_HEAT_CAP = 100` is internal; progress callers never use the rank curve, and rank
  callers never choose a denominator. Both mappings live in `shared/src/heat.ts`.
  The % ITSELF is no longer displayed anywhere during the round — the
  header names the day instead (see the app-header bullet) — so this bar, the emoji row and
  the archive/chooser badges are the only things it now speaks through. It is still computed
  every guess. *(It is no longer CACHED anywhere: #214 dropped the persisted round, so it
  is derived from the play log like everything else, and the archive/chooser read the
  SERVER's summary instead — #211.)* **The SHARE CARD draws the SAME
  ruler (decided 2026-07-25, superseding the bucketed-squares card):** the share token
  was bumped to **v2** — and to **v6** by #214, which added the CAPPED flag and skipped the retired Word mode's ids 3–5 — carrying the RAW per-try
  trajectory plus the solve moments instead of the `bucketMeans` squares, so `renderCardSvg` renders the on-screen ruler
  scaled to the OG image — same `progressHeatColor` cells, same ticks, same sentence
  indices. v1 tokens (bucketed squares) no longer decode: `decodeResult` rejects them
  on the version check, so a pre-bump link can never mis-draw. It is not a dead end
  though — **every version shares the opening header** (`version | lang | day`), so
  `decodeLegacyShareTarget` recovers a SUPERSEDED token's lang + day and
  `/s/<v1token>` **301s to `/<lang>/<date>`**, the archived day it named. That fallback is
  restricted to a NAMED LIST of retired SENTENCE versions — **1 and 2** — rather than to
  "strictly older than the current one" (#214, when the version passed the retired Word mode's ids): a corrupted or
  hand-crafted CURRENT-version token still gets the flat 404, and so does a retired Word
  token, so a forgery can never earn a redirect. `/og/<v1token>.png` stays a 404 (there is
  no ruler to draw). Cell count is
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
  **The plain-text EMOJI row is the SAME palette:** `progressEmoji` lives with the colour
  mappings in `shared/src/heat.ts`, so the row and ruler cannot drift. It uses four coarse
  bands, 🟥 → 🟨 → 🟪 → 🟦 (weirdest, weird, strange, calm), cut at
  15/45/75 and pinned by tests. **The row is BOUNDED to 3–18 cells (decided
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
  ORDER the sentence was cracked — `🟨🟨1️⃣🟪🟪🟪🟦🟦🟦2️⃣3️⃣`. The bar puts a mark between two
  cells and numbers it underneath; a single line has neither, so the number takes the cell.
  Three consequences, all accepted: the solve cells lose their color; several secrets falling
  inside ONE cell show every keycap (in sentence order — the same order the ruler stacks them
  under a shared tick), so the row can reach `MAX_ROW_CELLS + 2`; and since the final try
  always solves, a finished run ALWAYS ends on a keycap (a 3-try perfect game is exactly
  `1️⃣2️⃣3️⃣`, no color at all). `solvedAt` is optional — without it the row is the plain ramp.
  The ruler has no delays of its own since 2026-09-11 — it fills off the tally's count
  (`RunRuler`'s `filled`) — so under reduced motion, where the count lands at once, so
  does the bar. The keyboard's exit beat
  releases the RESULT through a signal the DOM has to produce (its own
  `animationend`) — so it carries a **deadline** (`KB_EXIT_FALLBACK_MS`
  in `Game.tsx`), a generous multiple of the real duration, cancelled by the genuine
  signal. A lost signal must never be able to stall the solved sequence. (The SOURCE
  reveal's own 6s visible-time fallback died with the source-gating on 2026-08-14 —
  nothing downstream waits on the typewriter any more, so there is nothing left for a
  lost report to strand.) On a
  streak solve the exit beat does NOT play hidden behind the celebration — the keyboard
  holds still under the modal and the drop starts at its dismissal (decided 2026-07-24).
  **The sentence must NOT move between the solved beats (decided 2026-07-24):** through
  the streak and the drop the tray keeps the keyboard's fixed height and the retired prompt
  keeps its layout, so `.play`'s centering never shifts the phrase — the sentence holds
  perfectly still right up until it dissolves in place (the 2026-08-14 exit, restored
  2026-09-08). **Fresh-solve
  sequence (decided 2026-07-10):** the
  solving submit immediately sends the prompt left while fading it out, in the same render
  that launches the final hole-hit feedback. The next stage waits until EVERY `Hole` reports
  its final secret rendered after its final settle animation completes — never a
  guessed timeout — so multi-word or throttled animation cannot be covered mid-resolution.
  A fresh active-day solve then holds the fully resolved sentence for 300ms before mounting
  the streak modal. **The solved beats run STREAK → keyboard-drop → the RESULT
  (2026-09-08, superseding the 2026-08-14 "drop → DISSOLVE → the stage" order, which itself
  superseded the 2026-07-24 "results rise → SOURCE" tray order):** once the modal has
  completely dismissed (including its exit fade) — or immediately after the final holes
  settle on archive / no-streak play — the drop plays, the tray leaves with it, and the
  result grows around the sentence with its layered reveal (see the solved-screen bullet
  above). There is nothing between the drop and the result any more: the sentence stays, so
  it has no exit to play. Rehydrated solves render the full result immediately without
  replaying the sequence — EXCEPT under the dev `?streak=N` preview, which deliberately
  opts one back into the choreography so the post-streak sequence can be watched. **That
  replay is held at frame zero until the preview dismisses** (`SolvedScreen`'s `start`,
  restored 2026-08-16): App owns the preview dialog, so this round never sees it in
  `showStreakDialog`, and without the gate the whole reveal — citation, tally, standing —
  plays under a full-screen modal and dismissal lands on a finished frame, spending unseen
  the exact beats the harness exists to show. Player progression is separate:
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
  tap-anywhere), or Escape. **A touch BEFORE that FAST-FORWARDS the celebration to its
  final frame instantly** (user-decided 2026-08-14, replacing "every dismissal input is
  ignored until the hint lands"): the same click/key/Escape aborts the staged sequence the
  way the effect teardown does (pending waits forced, springs stopped — the async chain
  falls through its own `stopped()` checks) and snaps every controller to the exact final
  values the reduced-motion branch writes, hint armed included — so an early touch skips
  the show and the touch after it leaves. The skip lives on a ref the effect reassigns
  per run (it needs the run's own closure), and a touch always means something now, which
  is why the sequence content no longer shields clicks with stopPropagation. Every
  dismissal then fades the whole modal opacity over
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
- **Solved-screen STANDING — DROPPED 2026-09-14 (user-decided: "just drop this part for
  now at least"): neither result screen shows a standing; `GroupStanding`,
  `useGroupStanding`, `tStanding`/`ordinal`, `parseStandings` and `.standing-line` are
  deleted, the `.solved-score-line` slot stays empty, and the server's `standing: true`
  read still answers with no consumer. The paragraph below is what it was.**
- **Solved-screen STANDING — the GROUP line (#271, user-decided 2026-09-07; it REPLACED
  the #170 TOP-% badge below; DROPPED 2026-09-14):** the result stack showed `2ND OF 7` beside the score (no
  "today": the result screen is today's, and the word clipped at a 375px card's edge)
  (`components/GroupStanding`, in the badge's exact `.standing-line` slot, a BUTTON onto the
  group's board that sets `lastGroupId` first), read by `hooks/useGroupStanding` — ONE
  request, `POST /board {token, standing: true}`, once the SERVER holds the round (the #203
  gate below, unchanged) — and `pickStanding` chooses the group last opened when the player
  stands in it, else the best (lowest rank, then the larger field). `of` is the members who
  RECORDED a score today. Nothing is drawn for a player in no group, with no row (late,
  capped), with no identity, or on a silent failure; the ordinal is `i18n.ordinal`
  (`1ST`/`2ND`… and `1ER`/`2E`…), the line `tStanding`. **REMOVED** (no-back-compat):
  `ScoreTop`, `game/scores.ts` (`scoreStanding`, the three gates, `formatTopPct`),
  `hooks/useScoreHistogram`, `api.scoresUrl`/`parseScoreHistogram`, the `scoreTop` string —
  the backend's `/scores` route still answers with no consumer (the user's call).
  *(The paragraphs below describe the #170 badge this replaced; what survives of them is the
  SERVER-holds-the-round gate, the one-conversation-per-round flight and the silent failure.)*
  The result stack used to show where the finished score sits
  in the day's anonymous population (#169), above its own metrics and SHARE — the
  comparison story that replaced the removed LLM benchmark.
  ONE rule (`hooks/useScoreHistogram`), and since #203 it is a plain READ: a round the
  SERVER holds — its transient `solved` since #214 dropped the
  persisted `recorded` mirror —
  GETs the day's bands and locates itself in them by its own score. Both ends read the same
  log — and the read NAMES the caller (`id`, the PUBLIC id, the /board rule) so the band it
  gets back is THEIRS, not whoever else recorded the same number (corrected on review:
  matching by value gave a round the IP cap refused an unrelated player's rank). A population holding no row for the caller
  answers `bucket: null` and no standing is drawn; `bucketIndexOf` retired with the guess.
  **What #203 RETIRED here** (no-back-compat): the score POST, the invisible Turnstile token
  it carried (`turnstile.ts` serves ROUND START instead, and gained
  `prefetchTurnstileTokens` — asked for while the puzzle loads, so the challenges are in hand before the player acts; a device with no identity
  fills TWO slots (bootstrap then round creation), while an existing identity fills one, and
  each prefetched token is consumed EXACTLY ONCE), the OAC-hashed `api.postScoreBody`, the
  persisted `scoreRecorded` VALUE and the whole ask-until-recorded state machine of
  2026-08-20, plus `game/scores.ts`'s `shouldSubmitScore`/`shouldAskPopulation` and the
  `canSubmit` cap gate. The server derives the score from the log it already holds and
  records the row itself, so there is nothing to claim, nothing to validate and nothing to
  retry — and the #201 cap needs no client rule either, since a capped round's appends were
  refused and its solve never reached the server.
  **The gate is the SERVER's fact, not the local board's**: `solved` flips a beat before the
  solving append lands, and reading the population then would find nothing and — with no
  retry left — leave the standing blank for good. That fact is the SERVER state the
  sync engine publishes off any round answer that says `solved`, and since #214 it is
  TRANSIENT (store **v14** drops the sentence rounds map outright, taking the persisted
  `recorded` with it, exactly as **v12** stripped `scoreRecorded` and **v13** dropped the
  pre-revision rounds — the standing no-back-compat rule, the v7/v11 precedent). A reload
  therefore learns the standing from the round it re-reads, which is also what makes it
  correct on a device that never played the day.
  The completion is keyed to the round that launched it (never whichever round navigation
  made active later), and an in-flight read is shared across real component remounts so
  leaving for the archive/tutorial and returning cannot mint a second request. EVERY
  failure is silent by decision: the solved screen simply shows no standing, never an
  error. **An ARCHIVE solve now shows none either** (user-decided 2026-08-23): a leaderboard
  is a DAY's competition and a late finish is not competing in it, so the server records no
  row and answers `bucket: null`, which this slot already draws as nothing. The read still
  fires — the client does not second-guess which days have a population, and that guess is
  exactly the kind of local rule the same decision removed from the streak. **What it shows is ONE BADGE — `TOP 25%` — BESIDE THE SCORE** (`components/ScoreTop`,
  user-decided 2026-09-05: "the rank # line should be dropped, we could keep the TOP% only,
  displayed next to the score, above the score bar" — superseding the `RANK #16 OF 100`
  line of 2026-08-15, which itself replaced the brick histogram):

  - **The rank is still COMPUTED, never drawn** (`game/scores.ts` `scoreStanding`,
    contract-tested): competition ranking — everyone strictly ahead, plus one — (the bands BEFORE mine),
    clamped to the population. It exists because the second gate below reads it.
  - **TOP uses the MIDPOINT of the shared bucket** (user-decided 2026-08-16):
    `(strictly ahead + bucket count / 2) / total`, the standard percentile-rank treatment
    for ties; an empty bucket carries no badge, and an inconsistent stale snapshot is
    capped at 100% and silenced by the median gate.
  - **The badge is gated THREE times, and every gate only ever silences it**: above
    `PERCENT_MIN_TOTAL` (10) recorded scores (a percentage of a handful is arithmetic, not
    a standing); from `PERCENT_MIN_RANK` (10) on (a single-digit standing is too small a
    field to blur into a percentage); at or above the MEDIAN — `PERCENT_MAX` (50) is the
    largest number it prints (#176: TOP is a claim, and `TOP 99%` is that claim turned
    against the player wearing it; the boundary is inclusive). The population floor is
    implied by the other two and stays because it states its own claim.
  - `formatTopPct` prints at most ONE decimal with the trailing zero stripped (`8.5`, `50`).
  - **It is an OUTLINED stamp — a hairline `--line-strong` rule around `--fg` pixel type,
    no ground** (user-decided 2026-08-17 over the filled chip), ABSOLUTELY placed off the
    number's right edge (`.solved-score-line` is the box, `.score-top` the badge): the
    number stays centred over its unit and the ruler, and the badge arriving — on the
    `rung-in` gesture, at the reveal's standing beat — or never arriving (a silent failure,
    a pending read, a gated standing) moves NOTHING. A rehydrated result renders `.settled`
    and replays nothing. There is no RANKING... placeholder any more: a badge that may not
    come is not announced. **REMOVED with the line** (no-back-compat): `ScoreRank`, the
    `.score-slot`/`.score-rank-*` CSS and its three size tiers, `standingUnits` /
    `TIGHT_STANDING_UNITS`, `LoadingWave`'s `letterClass`, and the `scoreRank` / `scoreOf`
    / `scoreRanking` strings.
  **REMOVED with it** (no-back-compat): the whole chart — `ScoreChart`, `chartField`,
  `chartUnits`, `MAX_CHART_BANDS`, `MAX_COLUMN_UNITS`, the band-merging and its `+N`
  legend, the `.score-field`/`.score-col`/`.score-brick`/`.score-stub`/`.score-plot`/
  `.score-legend` CSS — and the N-adaptive copy line with it (`histogramCopy`,
  `beatenCount`, `scoreFirst`/`scoreOther`/`scoreOthers`/`scoreBeat`): `TOP x%` and "you
  beat x%" are the same claim inverted, and the rank says it once.
- **The game's pre-round GATE is an INVITATION into the tutorial (2026-08-11's rules gate;
  DEPLOY duty added by the #216 trigger rework, user-decided 2026-08-24; remade by #269,
  user-decided 2026-09-16).** It states NO rules: the lesson teaches by playing, and a player
  who has played has learned them. Until the tutorial's LEVEL 1 is done on this device
  (`lessonsDone`, store **v20**, which retired `sentenceRulesSeen`), the tray holds **PLAY**
  (the tutorial's own full-width `.mix-btn`) and **LEARN** under it as THE WORD
  (`gateLearn`, `navigate(pathForLesson(lang, PLAY_LEVEL))`); it invites, never blocks — ONE
  entry, never a gate plus a nag. Level 1 is INFERRED FROM PLAY: `Game` marks it done the
  moment the round holds a guess (`guessCount > 0`), so a veteran's badge clears on their
  first guess and the gate never returns. Derived, not state:
  `identity === null || (!learned && !played && !finished && guessCount === 0)` — `played` is
  this visit's PLAY (nothing is recorded until a guess lands), so a round already in progress
  never shows it for the lesson alone. On the gate the PHRASE is on screen but the round holds
  back: the prompt lays out `retired`, the holes are untappable and waveless (`gateOpen` feeds
  `exploreDisabled` and vetoes `quiet`), and the TRAY holds the buttons in the keyboard's own
  footprint (`.rules-gate`, anchored to the tray's bottom by `.tray-gate`). No analytics event.
  **Since the #216 trigger rework the gate is also the sentence game's DEPLOY BUTTON**: a
  device with NO account shows it on every sentence day (archive days and post-sign-out
  included), whatever is done, because its PLAY is the only trigger on the screen — the tap
  bootstraps the account (loading wave in the button, `ErrorScreen` with TRY AGAIN on failure,
  nothing created on a failure) and then opens the round. The round engine's append NEVER
  mints an identity (`currentRequestIdentity`): a tokenless outbox — the pending-bootstrap
  recovery — waits behind the gate, and the deploy's identity listener kicks every
  conversation loose (`kickRoundSync`).
- **The tutorial is a LIST OF LEVELS, and level 1 is the game PLAYED (#51 → #155 → #269,
  user-decided 2026-09-16).** Watching newcomers showed the old lesson's flaw: they pressed
  MIX because they were told to, typed the words they were told to type, read nothing, and
  asked "what do I do?" on the game. Reading works only for someone who decided to learn.
  **The rule that replaced it: every beat is a real decision the player can get wrong, and
  the feedback is the only teacher; the coach speaks on a mistake or a stall, never on
  success.** The MIX demo, the gated keyboard and the prescribed guesses are gone.
  **Routes, not a flag** (`langs.ts`): `/<lang>/learn` is the list (`tutorial/Learn.tsx`),
  `/<lang>/learn/<n>` a BUILT level's lesson (`tutorial/Lesson.tsx`; an unbuilt or unknown `n`
  lands on the list). `tutorialOpen` and `?tutorial=1` are gone — the route is the harness.
  Both are the RULES' place (BOOK lit); on a lesson the lit book still LEADS to the list
  (`HeaderKeys`' `litLeads`, the calendar-over-an-archive-play rule generalized), and any
  other key leaves the lesson as a SKIP (`App`'s `leaveLesson`: tracked, `setOnboarded`).
  **The LEVELS** (`tutorial/levels.ts`): 1 THE GAME (built) · 2 THE DISTANCE · 3 MANY MEANINGS
  · 4 UNDER THE HOOD — each one layer deeper into the core concept (the user's four levels of
  understanding: the UI and the distance; how the distance is computed; 300 dimensions, a
  word holding several meanings; the vectors and what AIs do with them). Unbuilt rows are
  greyed, not tappable, and say SOON; only a BUILT level counts toward the header's badge
  (`.hk-badge`, `undoneLevels`) — a badge for something nobody can do is a nag. Completion is
  DEVICE-LOCAL (`lessonsDone`, never on the account) and, for level 1, INFERRED FROM PLAY
  (see the gate bullet). Replaying a done level is allowed. The row dress is the device
  list's; the done mark is a small accent SQUARE where the chevron of a level still to do sits.
  **Stage progress (user-decided 2026-09-17):** the coach dialog shows `n/4` beside it,
  driven by the current stage and `stages.length` in `LevelOne`.
  **LEVEL 1 (`tutorial/LevelOne.tsx` over `LessonBoard.tsx`, one screen, the script's
  STAGES in order — `scripts/<lang>.ts` `stages[]`, each `{kind, puzzle, hints}`; a
  sentence-shaped stage ends on a button, a single word rolls on by itself):**
  - **THE REVEAL (user-decided 2026-09-16, fifth pass — "you land on a page with mer¹ and
    it tells you to guess the secret word: where is the secret word?")** — NOTHING IS SAID
    THAT THE PLAYER HAS NOT JUST SEEN. The secret word is SHOWN on the board (rank 0, the
    solved look: "Here is a secret word: océan."), STANDS UNTIL THE PLAYER ACTS on ONE
    BUTTON in the tray, where the keyboard will land — **CONTINUE** / **CONTINUER**
    (`tutContinue`, `.mix-btn`; user-decided 2026-09-16 over HIDE THE WORD / MASQUER LE MOT; the prompt is retired meanwhile, so it is the one action).
    **The coach never skips a line without an interaction, and the interaction is always an
    obvious control with a clear action — never "tap anywhere"** (user-decided 2026-09-16,
    the tap-anywhere cue rejected the same day). Pressing it is the hiding: the word is
    HIDDEN in front of them: its closest word takes its place wearing a 1, on the Hole's OWN word-change
    choreography — the letters scramble from one word into the other while the exponent
    arrives, the same beat every improving guess gets, never a remount (user-decided
    2026-09-16: "the word transition animation should be played") — under "I mixed the word up: in its place, the closest word, sea¹. Find the secret word."
    (fr « J'ai mélangé le mot : à sa place, le mot le plus proche, mer¹. Retrouve le mot
    secret. »,
    user-decided 2026-09-16 — the bot says what IT did; « son plus proche » and « Trouve »
    rejected the same day). The player types it back — the loop, lived once. en OCEAN behind `sea^1`, fr
    OCÉAN behind `mer^1`; `scripts.test.ts` pins the clue at rank 1; the ladder is early
    (`STUCK.reveal` = 2/4/6 — the answer was just on screen). It replaced four single-word
    openings that each read as too hard or too abstract (TROPIQUES, `île^12`, `plage^28`,
    `atlantique^7`, then `mer^1` under an ordinal line).
  - **THE WORD** — another secret, never shown, its stand-in a dozen ranks out (en MOUNTAIN
    behind `snow^13`, fr MONTAGNE behind `ski^14`; the test wants 2–20): a real search that
    stays easy, the coach reacting to the guesses ("Now find another secret word. I give you
    its 13th closest word, snow¹³." — user-decided 2026-09-16). The real keyboard
    and the real vocabulary from the first frame. **A LONE WORD IS NOT TAPPABLE** (same day):
    the wheel is the sentences' own. NO CAPITAL on a lone word (`Phrase`'s `capital={false}`: a word is not
    a sentence), and the PROMPT sits just above the keyboard on the LEFT (`.tutorial--word
    .input-area`, `margin-top: auto`), off the word — and at ONE X on every stage: its own
    680px box centred in the column (`.tutorial .input-area`), where stretching it to a 680px
    word column and a 1200px sentence column put it at two edges — and at ONE Y, parked on
    the play area's bottom edge on every stage, the sentence's included (user-reported
    2026-09-16). Finding it ends the stage wordless and
    rolls into the sentence.
  - **THE SENTENCE** — two holes, start words in the game's own 50–150 band (en "a dog barks
    at the moon." from `coyote^55` / `stars^62`; fr « un chien aboie à la lune. » from
    `loup^52` / `pénombre^63`), the try count printed behind it as the day does, CENTRED on
    the game's full column so a wide screen shows it on one line (the word stages keep the
    680px cap), and in the MIDDLE of the room between the coach and the prompt (two auto
    margins; hard against the box the watermark rode into it, user-reported 2026-09-16). One new
    thing at a time: one guess lands on every hole (the two floats say so), a tap opens the
    tries (wheel / grid, picking included), fewer tries is the score. Solving it drops the
    keyboard (`kb-drop`, `KB_EXIT_FALLBACK_MS`) and offers **PLAY** in its place, the
    graduation: `markLessonDone(1)`, `setOnboarded`, `track finish`, and BACK WHERE THE
    INVITATION STOOD (`App`'s `lessonReturn`, the path TUTORIAL was pressed on — a dated
    link's day — cleared by any non-lesson route; the plain game otherwise, a reload
    included; user-fixed 2026-09-17).
  - **THE METER (#301 TAUGHT; user-decided 2026-09-16 — "after saying that real sentences
    are harder, the onboarding should continue and explain the first letter concept",
    SCRIPTED the same day; the letter became the ACTIVATION on 2026-09-22 and the stage's
    lines with it)** — CONTINUE from the sentence's solved line (the line stands
    until it is pressed) into a harder sentence THE BOT HAS ALREADY HALF PLAYED: en "the cat
    dreams of liberty." (fr « le chat suit le sentier. »), CAT found, with the #301 meters
    SHOWN for the first time. **THE SECRET IS THE CLOSE SYNONYM OF THE OBVIOUS WORD** (user-
    decided 2026-09-16 after solving it in one try: "if you type the word 0 it should become
    the word -1"): the sentence begs for FREEDOM / CHEMIN, and that word is the secret's
    rank-1 neighbour (`pair.alt`) — typing it earns a 1 and fills the chip, never the solve;
    both words read in the sentence ("both words relevant, e.g. mer/océan"). **AND THE TWO
    SWAP ROLES if the secret is typed first, before the hole is active** (user-decided
    2026-09-16 after typing « sentier » in one try): the secret reads 1 and `alt` becomes the
    secret the bot lands. ONE map serves both readings — swapped, every rank-0 entry reads 1
    and every rank-1 entry reads 0 (`ranks` view in `LessonBoard`), and the board, the
    meters, the wheel and every later guess replay against it. Once the hole is active there
    is no swap: the goal is only that the activation is seen before the solve. `played` is the
    bot's log — FEW tries, five, the best one an EASY SYNONYM of the obvious word (en: cat,
    independence, respect, happiness, justice, truth; fr: chat, parcours, randonneur, détour,
    hameau, tunnel — masculine so « le » holds; « belvédère » "was way too hard: the goal is
    easy guesses that teach the other mechanics", user-decided 2026-09-16) — replayed onto the board, the meters and the tries wheel exactly as a
    round's log would be, chosen so the open word's meter stands at ABOUT THREE QUARTERS
    (~74 en / ~74 fr, the day's own `replayCharge` — no lesson boost; "almost full, we don't
    see it getting filled") with a best try that is no giveaway AND LONG ENOUGH for the fill
    to read on its chip (`independence^9` / `parcours^8` — `col` "was too short to understand
    the notion of progression", 2026-09-16;
    the test wants rank ≥ 5 and ≥ 6 letters, 65–80, ≤ 6 tries, `alt` at rank 1, untried, and
    filling it alone). THE WATERMARK COUNTS THE WHOLE LOG, the bot's tries included.
    THE KEYBOARD IS HELD BACK UNTIL THE TAP (user-decided 2026-09-16): the stage opens with
    the prompt retired and the tray empty, so the bot's tries are the first thing to look
    at; the keys arrive with the line that hands the turn over — which types only once the
    WHEEL IS CLOSED (`tapped` lands on close, same day).
    that a rank-200 guess still fills it). The beats, each on the player's act: "I already
    made some progress on this sentence, but I cannot find the last word. Click
    independence⁹ to see my tries." (ONE box, no beat between — user-decided 2026-09-16; TAP
    on a coarse pointer — every tap line has its click twin) → tapped: "The 1000 closest words to the
    secret fill its meter. Once full, you earn a clue." → a guess that does not fill:
    `tutNear` → the obvious guess FILLS IT — no progress needed — and the hole ACTIVATES:
    "The meter is full! 10 words close to the secret are masked in its tries. Click
    freedom¹, choose a masked word and reveal it — it costs a try." (`tutActivatedTap`/
    `Click`, 2026-09-22; the tap teaches the wheel a second time and the price once) → a
    hint REVEALED with the button: "equality² is revealed, for one try. Now find the secret word."
    (`tutRevealed`, off the event's `revealed` flag) → a FAILED TRY typed after it earns the HINT
    (`hints[]`, or `pair.hint` once swapped), NEVER THE WORD (user-decided 2026-09-16,
    retiring the bot's own closing guess) → found: "You found it! You are ready for the real
    game." → PLAY. `STUCK.meter` is unused
    (the stage is its own script). Not taught: the exact rate.
  **A WHEEL ROW'S HIT AREA IS ITS WORD** (`.wheel-row` `width: fit-content`, user-reported
  2026-09-16 from the lesson: "when we click next to a word it scrolls to it instead of
  leaving the wheel"): the room beside a word is the scroller's own, and a click there folds
  the wheel — on the day's wheel too.
  **THE COACH IS THE PLAYER (user-decided 2026-09-16, "people would want to read it more if
  it's something telling it"):** the old lineup's PLAYER idle sheet (`player-idle.png`, 8
  frames of 22x31, restored from the benchmark display's removal — the error bot stood in
  first, replaced the same day on the user's ask) at 2x stands on the coach box's top-left
  edge (`.coach--bot` / `.coach-bot`, drawn ABOVE the box so the text budget stands; the box
  and the board's `padding-top` drop by the sprite's 56px).
  **THE REACTIVE COACH (`tutorial/coach.ts`, pure; `coach.test.ts` replays sequences):**
  the one line the board's state calls for — and when a beat has nothing new to say THE BOX
  KEEPS THE LAST LINE UP, it never disappears (user-decided 2026-09-16). **Every line
  is written for someone who knows NOTHING yet (user-decided 2026-09-16, three passes): the
  opening says what the game IS — guess a SECRET word — and explains the number on the clue
  itself; closeness is counted in ORDINALS (`ordinal`, en/fr), never an abstract distance.**
  The reveal's two lines (`tutReveal`, `tutHidden`) above; before the first guess of the
  word (`tutIntro`) and of the sentence (`tutSentenceIntro`: "Now a sentence, with two secret
  words." — no mechanics explained, the floats show them; user-decided
  2026-09-16). Single-word stages: the FIRST ranked guess
  that moves nothing → `tutAway` ("water²⁹ is the 29th closest word to the secret." — the comparison to the clue
  dropped as noise, user-decided 2026-09-16), once;
  the FIRST MISS → `tutMiss` ("violin has nothing to do with the secret word: a MISS", the
  MISS in its red), once; a
  moving guess → SILENCE. Both stages: a
  hole resisting `STUCK[stage]` guesses climbs near → the board's HINT (`hints[]`, per hole,
  `tutHint*` — a full sentence announced as one: "A hint: the secret word is very high,
  with a peak and snow on top.", user-decided 2026-09-16) → the ANSWER (`[2,2,9]` on the word — TWO failed tries in a row earn a REALLY
  EASY hint outright, "montagne is a bit hard", user-decided 2026-09-16; `[4,8,12]` on the
  sentence, the hole resisting longest chosen); the sentence teaches NO tap (dropped 2026-09-16: "this concept
  will be taught on the next sentence"); SOLVED, the bot counts the tries and sets up what comes next (`tutSolved`, "You found both
  in 7 tries. This one was easy: the daily sentences are harder." — the score, said once,
  and the hook the METER stage hangs from, user-decided 2026-09-16; a found single word
  still says nothing). The `{braces}` are filled from the board itself, so a line can never
  name a word the map does not rank. THE COACH BOX IS THREE LINES, FIVE AT MOST (user-decided 2026-09-16, lifting the
  exact-three rule of 2026-08-04: the box is fixed-positioned and moves nothing beneath, and
  the bot's briefing on the last sentence runs to five at 320px — `.coach-text`
  `max-height: 8.5em`, the board's `padding-top` grown to match); copy past five lines is a
  copy bug.
  **The invitation is unchanged** (`tutorial/Invite.tsx`, no header): a first visit (no
  `onboarded`) lands on it; TUTORIAL navigates to level 1 (the lesson's PLAY or a header exit
  settles the flag), SKIP settles it there. Its preload warms the level-1 chunk
  (`LazyLevelOne`, the LazyStreakDialog pattern; a failed chunk exits without completing the lesson). Analytics
  keep the three events (`start` / `skip` / `finish`). The boards are pruned #154 artifacts
  (`scripts/<lang>.<word>.json`, `prune-word-map.mjs --top 150`; the exact commands in each
  script's header), never published or served; a lesson board touches no `rounds`, no outbox,
  no server. **Not done, deliberately: levels 2–4** (their rows show the road).
- **App header — TWO SLOTS (user-decided 2026-08-30, superseding the 2026-08-18
  three-slot finalization recorded below).** The BAND is unchanged — `--glass` +
  hairline + backdrop blur (`components/TopBar.tsx`), full-bleed with one bottom
  hairline on a phone, floating capped-and-rounded just inside the device frame's
  brackets on desktop (`min(900px, 100vw - 48px)`, 50px, 8px off the top). What changed
  is what it holds, and why.
  **THE BAND WAITS FOR SCROLL (user-decided 2026-09-01, amending 2026-08-18's
  always-on glass) — AND WHAT ARRIVES IS THE GROUND, NOT A BOX (same day, later:
  "do not add a border, just a `--bg` background on the whole width of the screen and a
  vertical gradient from `--bg` to transparent below to fade content behind it").** At
  REST the header is TRANSPARENT, sitting directly on the ground; once the screen under
  it has actually scrolled (`.topbar.scrolled`, set by TopBar's own capture-phase scroll
  listener — one listener hears every scroller in the app and the phone's page scroll; a
  dialog's scroll never lights it, a horizontal-only scroller says nothing, and a
  scroller that unmounts drops its state on the next render) the whole screen width
  behind the row fills with flat `--bg` and a 36px gradient from `--bg` to transparent
  hangs under it, so content fades into the ground before it reaches the controls. No
  border, no blur, no glass, no rounded float: both layers are pseudo-elements of
  `.topbar` (the full-width fixed layer), faded in on opacity so nothing shifts, and
  `.topbar-inner` keeps only its geometry. ModalHeader, which reuses the classes with no
  `.topbar` ancestor, is therefore BANDLESS on its flat-`--bg` dialogs.
  **THE ROW IS APP CHROME, AND IT IS MOUNTED ONCE (user-decided 2026-09-02).** Every
  screen used to render its own `TopBar`, so tapping a header key unmounted the whole row
  and mounted a different screen's copy of it — and the player's own FACE paid for it:
  `useAccountFace` holds its answer in component state, so every navigation put the key
  back to its skeleton and re-read `/profile` over the network, which reads as the page
  reloading (user-reported). `App` mounts the row now, above the routed surface, and it
  outlives the screens under it: `TopBar` takes only `right`, and a screen publishes its
  LEFT slot through the exported `HeaderLeft` — a portal into the row's own left track, so
  the slot still belongs to the screen (it owns what it says there, and the state its
  controls close over comes with it) without the screen owning the row. The portal's target
  is a module-level `display: contents` node rather than a ref: it has to EXIST before the
  screens' first render, and holding it in state would re-render the whole tree every time
  the header mounts. **Which surface is up became App's question with it**, since whether a
  surface wears the row is the router's business — `headerPlace()` reads the route, and
  `GameSurface` (tutorial / invite / game) is picked in App and rendered by `GameRoute`, the
  onboarding INVITATION being the one game surface with no header. The dev harnesses
  (`?streak=`, `?error=`) moved up with that decision, because they are part
  of the answer. Verified in the browser: the `header`, `.hk-row` and `.account-key` DOM
  nodes are the SAME elements across every key, and a deployed account's face never
  skeletons and issues no second profile read. (Not fixed by this, and worth naming: the
  ACCOUNT SCREEN's own `useOwnFace` still re-reads on each visit — a shared read cache is
  the remedy there, not the row.)

  **THE PROBLEM IT SOLVES.** The row carried WHICH PUZZLE in three places — the day as a
  left chip, the daily as a centred segmented switcher, the language as a right chip —
  and the row had nothing left. Measured at 320px the grid was `98.6 | 118.8 | 98.6`
  with the centre's right edge at 219 and the right group starting at 218: **a one-pixel
  collision.** Its consequences were all over the app. The leaderboard could not carry
  both its own NAME and a back control (~140px of side track against the ~150px an arrow
  plus `CLASSEMENT` needs), so it kept a ✕. The account area could have no header door at
  all — the root `AGENTS.md`'s "no new header icon: the header is already at its measured
  width budget" — so the one way in was the leaderboard's identity strip, two taps behind
  a crown, in an app whose whole identity model is that the account is already there.
  **THE TWO SLOTS, and each has ONE meaning:**
  - **LEFT — WHAT YOU ARE LOOKING AT.** On a play surface that is `PuzzleTitle`: the
    APP'S MARK in the accent with the language CODE and a chevron (`▲ FR ⌄`, user-decided
    2026-09-16 — the daily's name held this slot until Word mode was retired). The mark is
    `public/logo.png`, the favicon's 22×22 white pixel logo, painted through a CSS mask in
    `--accent` at its exact 1x with nearest sampling (`.app-title-mark`), 3px more air after
    it than the title's own gap, and the text beside it set 2px down onto the bottom-heavy
    mark's weight (a translate, measured at 4x), opening the
    drum below; the drum and the `aria-label` name the language in full. It routes by the SURFACE
    it was opened from: from the archive, the other language means that language's
    CALENDAR. On a screen you navigated INTO
    it is `back` — the arrow and the screen's own name as one target (2026-08-29).
    **THE TITLE IS A HELD WORD, AND ITS MENU IS A FULLSCREEN SELECTION IN THE HOLE
    WHEEL'S DRESS (user-decided 2026-09-02, in two passes: "add a `--fg` background, like
    on the hole words" and "on clickable titles, the popover should look more like a hole
    wheel"; then, on the first cut, "maybe a fullscreen selection could work better").**
    Every screen NAME in the header's left slot — a `back` control's screen name,
    `/account`'s plain name, `LangTitle`'s — wears the sentence chip (the game surfaces'
    title is the app's mark instead since 2026-09-16, the code beside it in plain title
    type: the mark is its one emphasis): `--fg` ground, `--bg` ink,
    square, 12px at 600, laid out rather than drawn (`.topbar .topbar-title`;
    ModalHeader's flat dialogs keep the plain type). The day and the chevron stand OUTSIDE
    the chip the way a hole's exponent does; hover and press DIM the chip by the hole's
    own mixes, since white cannot brighten. The day states its own 12px now that it sits
    outside the chip's rule (it inherited the body's 16px for one measurement), and the
    320px budget was re-measured with the chip: SENTENCE AUG 29 beside the five keys ended
    at 153 of 158, the chip's padding stepping to 5px at ≤340. (The mark's title is
    narrower: `▲ FR 10/09 ⌄` ends at 111 of the 158 at 320px, measured 2026-09-16.)
    What hangs off it is `PuzzleSelect`, replacing the `PuzzleSheet` dropdown (rows,
    hairline, LED tick — deleted with its CSS), and it took FOUR passes in one day to
    land, each on the user's review:
    1. **A WHEEL ON THE TITLE** — two picker drums standing on the title's own measured
       chip, the daily's slot row drawn as the title itself and the language's drum
       unfolding beside it, ordered current-first because a slot at the top of the screen
       has no rows above it. Built and verified pixel-identical at 320/390/1280, retired
       within the hour: at the screen's top edge a drum's rows "just get clipped" instead
       of turning, and a two-item drum made a switch cost THREE taps.
    2. **A ONE-TAP MENU**, fullscreen ("maybe a fullscreen selection could work better"):
       the wheel's dress with the drum taken out, a tap on a plain option navigating.
    3. **THE GROUND WENT FLAT** ("make just the veil go all black"): the hole wheel's 74%
       and then a 96% veil both left the sentence and the rules printing behind the
       options — the wheel's dim is a quarter because the sentence under it is what that
       wheel is ABOUT, and nothing under this selection is. With nothing showing through
       it became a full-screen dialog and took the app's header row.
    4. **THE DRUMS CAME BACK, ON THE FLAT SCREEN** ("use the wheel scrolling, and bring
       back the 3 tap logic, so users can change the mode and lang without having to
       reopen the menu"): open, turn as many drums as you like, fold once — where the
       one-tap menu made switching both axes two openings. **And the way back is a LEFT
       CHEVRON in the header's left slot** ("use a left chevron as a back icon on the
       header"): the title's own 7×7 pixel chevron turned to point out
       (`assets/icons/chevron-left.svg`), where the modals' ✕ sits top-right.
    **What stands:** the hole wheel's fade in and out (`.wheel-dialog`, `wheel-out`) on
    flat `--bg`; the app's header row with the back chevron; and in the middle of the
    screen ONE DRUM, the LANGUAGE's (the DAILY's stood beside it until Word mode was
    retired), scrolling through a slot (five rows' room, the slot in
    the middle, both ends fading over 44px, every number set inline from ONE measured chip
    — `.ps-probe`). The row in a slot wears the header chip's dress at 22px (18 ≤640, 16 ≤360),
    the others stand plain at the same size, and the chip hands itself from row to row
    on a 120ms cross-fade as the drum turns; rows arrive on the wheel's stagger counted out
    from the slot. **The drum IS the hole wheel's** — its physics moved out of
    `HistoryWheel` into `hooks/useDrum` (`current`/`peek`/`jump`/`glideTo`/`glideBy`/
    `tap`/`endedDrag`; the caller supplies only `write`, a scrollTop there and a translate
    here), so a drag, a fling, a wheel delta, an arrow key and a tap on a row all feel the
    same on both surfaces. ArrowUp/Down turn the drum. **THE PICK LANDS AS THE FOLD BEGINS, under
    the veil** (user-reported the same day, fifth pass): the back chevron, a slot row's
    tap, a tap outside the drum, or Escape sets `closing`, and an effect on it hands the
    caller (`onLang`) whatever the slot holds at once — or nothing when it did not move —
    so the NEW screen's loading state is what stands under the veil as it lifts. Navigating on the
    dialog's `close` (the hole wheel's rule, kept for one pass) showed the old
    screen for the fade, then a beat of loading, then the new one — "a sensation of rapid
    blinking between multiple screens". Measured: 22ms after the tap the old screen is
    gone and the loading line is up under the closing veil, which lifts at 170ms. The
    hole wheel keeps its rule for its own reason (a pick reflows the sentence it stands
    on). A tap on a plain row only TURNS the drum.
  - **RIGHT — WHERE YOU ARE AND WHERE YOU CAN GO: the app's PLACES, the current one
    LIT — and it is THE SAME ROW ON EVERY SCREEN THAT HAS A HEADER** (user-decided
    2026-08-31: "the header is supposed to be something stable", then extended the same
    day to the account area and the tutorial on the question "keep the right icons always
    in place?"; `components/HeaderKeys.tsx`):
    **home · archive · board · rules · face**, fixed order. The lit state is the header's
    own whisper chip held permanently — the hover, answered — plus a hairline. **Leaving
    a place is tapping another one**, a tab bar's grammar, which needs no exit control:
    the board is left by HOME. Two exits were built and rejected the same day — pressing
    the lit key again ("not intuitive at all") and a ✕ that appeared only on the board and
    the archive ("moving the header icons around on a click is not a great solution").
    A lit key still answers a press (it goes nowhere), so nothing on the row is dead.
    **The one lit key that goes somewhere is the CALENDAR over an archive PLAY** (a past
    day, or tomorrow's; user-decided 2026-09-11): the day is the archive's, which is why
    the key is lit, but the calendar is not on screen, and getting back to it took another
    key and then the calendar. It leads to the calendar (`HeaderKeys`' `archivePlay`, set
    by App); on the calendar itself it goes nowhere.
  **THE KEYS, per surface — identical, only the LIT one moves.** Live daily: HOME lit.
  Past day: ARCHIVE lit (a past day is the archive's). Calendar: ARCHIVE lit. Board:
  BOARD lit. Account area — `/account`, `/profile`, both email doors: FACE lit (the
  account is a place; the steps inside it keep their `back` on the LEFT while the face
  stays lit on the right). Tutorial — its list of levels and a lesson alike (#269): BOOK lit
  (the rules' place; on a lesson the lit book still leads to the list, and any other key
  leaves the lesson, which is a SKIP — the fast-forward control that slot held, `skip.svg`
  and `ariaSkipTutorial`, are retired). The book wears a BADGE with the count of built levels
  this device has not done. **`profileReturn` is GONE from the store**: every
  place is one tap away, so nothing has to remember where it was opened from, and
  `/account`'s left slot is its plain NAME rather than a back control. **This OVERTURNS #190's ACTIVE-DAY-ONLY crown** (2026-08-20): that rule hid
  the crown on an archive day so a key could not silently swap the day under the player,
  but a key that vanishes is exactly the instability the fixed row exists to end — the
  crown always leads to the LIVE board, and the lit calendar already says the day on
  screen is a past one. The RULES key (an open book) lights while the tutorial is open;
  from anywhere but the game it goes home with it, where the tutorial mounts.
  - **THE ARCHIVE IS A KEY, not the date chip.** "Tap the day to change the day" made one
    control answer two questions and put the calendar behind the one label that changes
    every day. A calendar is a place; places are keys. The day did not lose its slot —
    it was PROMOTED to where it means something: absent on today (today is the default
    and the screen IS the day's game), joined to the title on an ARCHIVE route, so the
    abnormal state is the one that is always labelled. The old chip spent the slot
    stating the normal case.
  - **THE FACE is the account's door in the daily loop** (`components/AccountKey.tsx`),
    the row's last key. It reveals nothing about server state, which is the invariant it
    must not break: `useOwnFace` answers the account's stored profile or the identical
    pair derived from the persisted local seed, and `localIdentityDeploy` stores exactly
    that pair at deployment — the same face before and after (#216). It HOLDS ITS BOX
    until the face settles (the leaderboard strip's rule, and it matters more here, where
    the control is on screen every day), and it sets `profileReturn` so `/account`'s back
    lands where it was opened from. **It is A BARE PIXEL TILE, IN COLOUR — the fifth cell
    drawing in a row of five** (user-decided 2026-09-02, in two steps: square corners, then
    "remove the box shadow"; it kept its COLOUR from 2026-08-31, "actually quite cool", and
    is still the one full-colour chrome control, because that colour is the one thing on the
    row that is THEIRS). It ends a year of dressing — a 26px square almost filling its key,
    then that square inside a 1px `--line-strong` ring on a 3px radius. Every layer answered
    the same worry, that a drawing among LINE icons needs an edge to belong; the pixel-icon
    rewrite settled it the other way round, because the row is cell drawings now and the
    face belongs by being one. **Measured, the cell sizes were already identical** — every
    key is a 10-cell grid at 20px, so 2px a cell, the icons and the face alike — and what
    the ring actually did was make the face's FOOTPRINT 22 against their 20, which is the
    difference the eye was reading. There is no scale step between them either: 3px a cell
    is a 30px tile, which does not fit the row, and anything between puts the mark on
    fractional cells.
    **The corners are square for the same reason, and BOTH roundings had to go**: the CSS
    one, which is also what the ring followed, and the tile's OWN — cut by a clipPath INSIDE
    the SVG, so `Avatar` gained a `sharp` prop rather than being fought with CSS. That inner
    arc is only 0.72px at 20px but ~1.4 antialiased device pixels at 2×, exactly the
    softening this row's grammar refuses; `sharp` skips the clip entirely, since with nothing
    to round it only ever clipped the tile to itself. Rounding is a property of the SURFACE,
    not of the drawing — the board rows and the account masthead keep theirs, sitting among
    glass rows that all carry a radius — and the skeleton squared with the tile, or the
    placeholder would change shape on arrival. `overflow: visible` went with the ring (it
    existed so a box-shadow could paint outside the key), and the `size={26}` the key asked
    for was dead — CSS has forced 20 since the frame landed — so it says 20.
    **ONE CONSEQUENCE, accepted:** COBALT is the only palette with a dark ground (#222431 on
    the #050507 header, ~1.3:1), so its tile has no boundary any more and reads as blue cells
    floating on the band — which is how the four white marks beside it read.
  - **THE ICONS ARE PIXEL MARKS ON THE AVATAR'S OWN 10×10 GRID** (user-decided 2026-09-02,
    superseding the Lucide-shaped strokes of 2026-08-31: "they don't express the artistic
    direction of the game, and you cannot recognize them at all. The icons should be part of
    the branding too"). Every drawn thing in the app is chunky pixel art — the bot, the
    ghost, the flame, the digits, the players' 10×10 marks — and the header was the one
    row still wearing a borrowed stroke set beside a pixel face. The four places are now
    `assets/icons/{home,calendar,board,rules}.svg`: 10-unit viewBoxes of `<rect>` cells,
    `currentColor` fill, `crispEdges`, sized 20px IN-FILE — one cell = 2px, the face's
    exact size, crisp on a 1× screen. **One-cell lines, solid only where it means
    something:** an outlined HOUSE with a solid door; a CALENDAR with a solid header band
    and ONE marked day; a solid CROWN (the row's one mass — a prize is the only thing there
    worth its weight); and the RULES as a PAGE with a folded corner and three lines — the
    open book was kept as the object through several drafts and abandoned because every
    open book collapsed into a "U" at 20px, where the sheet reads at once. Drafts set
    aside on the same test (each judged at REAL size, not zoomed): a solid house (front-
    heavy beside the crown), a flat-topped crown (a castle wall), an outlined crown (a
    basket), a jewelled crown (too busy), three open books, a hairline-header calendar.
    **The rest of the chrome follows the same grammar:** the title's chevron (7×7 at 2px,
    14px), the back control's LEFT CHEVRON (the same 7×7 mark turned to point out —
    user-decided 2026-09-02, replacing a plain 10×10 pixel arrow that had itself replaced
    the keyboard's `back.svg`, whose backspace glyph carries an ✕ inside it and read as
    "delete") and the dialogs' ✕ (10×10). `.topbar-back .ui-icon` no longer forces a square: each file's
    in-file size is the cell grid, and forcing one off it blurs it. `book.svg` is deleted.
    **THEY SHARE A BASELINE, AND THAT IS A PROPERTY OF THE INK** (user-reported 2026-09-02:
    "the icons should be aligned to the baseline"). Every key is the same box around the
    same 20px viewBox, so alignment is decided INSIDE each file by which row its drawing
    ends on: the house, the calendar and the page all reach row 9, and the CROWN stopped at
    row 8 — one cell, 2px, of float. It was dropped a row (its ink is rows 1..9 now).
    Measured on the rendered header, the four ink bottoms land on one line at every width.
    The FACE is the deliberate exception: its 1px `--line-strong` ring is drawn outside the
    20px tile, so the frame hangs a pixel below that line while the drawing itself sits on
    it — the mark cannot shrink to 18px without leaving the integer 2px-a-cell scale.
  - **A CHEVRON, NOT A CHIP OF ITS OWN.** The title carries the current language's code,
    and switching it is a rare act, so the selection costs one tap for a choice nobody makes
    twice in a session. `components/LangButton.tsx` is deleted with the chip it drew.
  **THE BUDGET, re-measured.** Worst case (320px, a PAST day — the title carries
  the day — and the fixed five-key group; measured with the retired SENTENCE name — the mark's title is 105px dated at 320, so the tightest row is now the account area's): title 147px + keys 165px = 312 of the row's 316px content
  box, against the 336–359px the three-slot row wanted; the live daily has
  60px to spare. **The title has ONE size on every screen — 12px, the chrome's own
  small-caps size — and never steps down** (user-decided 2026-08-31: a viewport clamp
  plus two phone overrides had COMPTE at 14px over PROFIL at 11, one tap apart); what
  gives on a phone is the KEYS — gap 3px at ≤400, 30px boxes and 2px gaps at ≤340 — and,
  last, the puzzle title's own padding and its day's tracking. The flow's French return
  door is titled CONNEXION rather than SE CONNECTER for the same row. The grid is
  `minmax(0, 1fr) auto`: the keys are icons and may never shrink, so the TITLE is the
  track that gives ground and ellipsises rather than pushing a control off a phone.
  The ≤400px step-down (32px controls) and the ≤340 one (30px, tighter gaps) are what
  hold the five-key row; the arithmetic is commented at the step-downs under "THE
  NARROW-PHONE HEADER BUDGET" — re-measure before a SIXTH key.
  The archive's top reserve is 70px, clearing the band.
  **What this DELETED** (the standing no-back-compat rule): `components/ModeTabs.tsx`,
  `components/PuzzleDate.tsx`, `components/LangButton.tsx`, the leaderboard's IDENTITY
  STRIP (`.board-me`, its own profile read, `chevron-right.svg` — see the leaderboard
  bullet), `TopBar`'s `center` and
  `lang` props, and the whole HEADER-LEFT REPORTING CHANNEL — `App`'s keyed
  `headerLeft` state and the `onHeaderLeftChange` prop both games filled with a layout
  effect. Which puzzle is a fact of the ROUTE, so the header no longer waits on a loaded
  game to report it, and its content is identical through loading, error and
  missing-puzzle. The board's in-screen FRIENDS/GLOBAL tabs wore `.mode-tab` by sharing
  the switcher's class; the dress moved onto `.board-tab`, its last consumer.
  *(The paragraphs below predate the band and stand only where they don't contradict
  it.)*
  Historical: a fixed **topbar**
  of **two corner chips and NOTHING else — no band, no border, no
  background, no blur** over the then-animated waves.
  Layout was one optical row: `.topbar-inner` = `min(900px, 100vw - 48px)`, 56px, centred.
  **LEFT is the status spot** (`.topbar-left`) — a screen's title in `.topbar-title`
  (ARCHIVE / TUTORIAL, plus any inline stat like the tutorial's counter), or a loaded game's
  own left chip: **the sentence game's is the DAY'S DATE** (`components/PuzzleDate`,
  user-decided 2026-08-16, replacing the reconstruction-% counter that held this corner —
  the percentage now speaks only through the run ruler's colours at the end of the round).
  The date is `dateForDayNumber(dayNumber)`, the same
  `2026-08-16` spelling the card, the OG title, the shared text and the archive URL use, so
  an archived day reads as the day it is from the moment it loads. CHROME, not a stat:
  `.topbar-title`'s muted weight and none of the counter's live colour, and sized against
  the corner's REAL budget, which four glyphs never tested — ten glyphs plus the group's
  padding have to clear the four 38px controls opposite, which is what the 10px/no-tracking
  step at ≤640px is for (measured 320/360/390/430). Both left and right groups are children of
  the actual `<header>`; game bodies never render a separate fixed header half. The
  full-width progress BAR is gone — and since 2026-08-16 so is the number that replaced
  it. **RIGHT is the one action
  group** (`.topbar-right`), in two halves: the CHOOSERS the bar itself owns — the
  **Whippin mark** (which daily) then the **globe** (which language),
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
  flag (switching language out from under a modal would navigate the screen away). The
  history modal wears it (as the route map and the leaderboard dialog did before their
  removals).
  **A modal adopting it owes it the structure that lets it paint nothing**: the header sits IN
  FLOW above a scroller that owns the overflow, so no content
  can pass beneath it and no band is needed — the DIALOG must not scroll.
  The **StreakDialog deliberately does NOT take this header** — the
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
    **ONE exception, the title's SELECTION and the hole WHEEL (`PuzzleSheet` from
    2026-08-30; `PuzzleSelect` since 2026-09-02):** a thing hanging off a control that
    stays on screen has no chrome
    to hold a close chip and no Escape on a phone, so a tap OUTSIDE it closes it — without
    that, the only way to leave without choosing was to re-pick the current row. The rule
    above is about full-SCREEN modals, and a wheel is not one.
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
  **Which exit each wears:** the hole wheel FOLDS in place (a fade, since 2026-09-01; the
  history modal it replaced RETRACTED INTO ITS WORD, because it belonged to that word — the
  wheel never leaves the word, so there is nothing to retract). (The retired leaderboard
  dialog's SHEET exit — up from the bottom edge, back down on the way out, at every width —
  went with it on 2026-08-12; a future full-screen result surface should take that shape
  back up.)
  The game's right group holds help `?` (#55; the archive entry is the date chip since
  2026-08-18); the tutorial
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
- **The CHOOSER screens are RETIRED — both of them.** The MODE chooser (`/mode`) went
  2026-08-18 for the header's tabs; the LANGUAGE chooser (`/select`, `screens/LanguageSelect`
  + `components/Chooser` and their CSS) went 2026-09-05 (user-decided: "get rid of the
  /select page; change lang should open the select modal") — every header title already
  opens the selection drums (`PuzzleSelect`), so a page of its own answered a question every
  page answers. Both paths parse as `home`. The one headerless surface that offered CHANGE
  LANGUAGE, the missing-puzzle screen, opens those drums itself (`NoPuzzle`).
- **UI chrome is localized + a11y'd (decided 2026-07-06):** `web/src/i18n.ts` holds every
  UI string in **en + fr** (`t(lang, key)`; the `satisfies` clause makes a missing
  translation a type error, so parity needs no test). Game screens resolve strings with
  the **puzzle's** language; the selector (no puzzle) uses the same resolution as the `/`
  redirect. `<html lang>` is kept in sync by App. Guess feedback is mirrored to a
  `.sr-only` polite live region (`srHoleResult`), animations honor
  `prefers-reduced-motion` (durations collapse to ~0 — never `animation: none`, several
  swaps advance on `animationend`; delays are kept so the floating numbers still show).
  **EVERY BUTTON IS AN ORDINARY BUTTON, AND FOCUS IS THE TRAVELLING BRACKETS** (#267,
  user-decided 2026-09-07 for the guard and 2026-09-09 for the indicator — the third
  cut: a box ringing every control ("is it actually a good UI?"), then a colour or dim per
  control ("don't play too much with the colors… maybe white corner brackets") — and
  superseding the 2026-08-06 "every button is pointer-only and may NEVER retain focus").
  `buttonFocus.ts` — which held every current, future, lazy and portaled button out of
  the tab order and blurred any focus it took — is DELETED: it existed to avoid the ring
  a tap leaves stuck on a control in a touch browser, and `:focus-visible` is the
  browser's own answer to that without shutting keyboard players out.
  **ONE indicator, and it is the app's own selection frame:** the device frame's corner
  brackets, drawn small and sharp in `--fg` (2px, 8px arms, 3px outside the box) around
  whatever the keyboard is on — `components/FocusBrackets.tsx`, mounted ONCE by App, one
  element that TRAVELS from control to control (the header dot's rule: translations,
  never appearances). No control changes for the focus: no ring, no colour, no dim —
  hover stays the mouse's, and the CSS paints nothing on `:focus` or `:focus-visible`
  anywhere (`:where(button, a, input, [tabindex])` resets the browser's). The rules:
  - It answers **`:focus-visible` alone**, asked at focus time — a tap moves no brackets,
    nor does the focus a click leaves on a button.
  - It frames the control's **VISIBLE box**: `[data-focus-box]` inside a control that is
    stretched wider than what it shows — a drum row frames its chip (`PuzzleSelect`, the
    wheel's slot `.hole-word-wrap`); the code row is `fit-content` so the
    field's box is its six cells. It never frames the guess field (its caret is its
    focus), a dialog focused as a whole, or a `tabindex="-1"` container.
  - It **follows a focus that moves** — a drum turning under it, a scroll, a resize — one
    measurement a frame while it shows, and only while it shows; it mounts INSIDE an open
    dialog when the focus is there (the top layer paints above the document).
  - **The framed box DIMS a touch** (`data-bracketed`, set by the component on the box it
    frames): `brightness(0.8)` where the control has contrast to spare, `0.9` on the dark
    tiles that have little (a key, a calendar day) — brightness rather than opacity, the
    same thing on the flat near-black ground and composable with a control's own opacity.
    (User-decided 2026-09-09, with the header dot's keyboard travel REMOVED the same
    review: the dot answers the mouse alone; the brackets are the focus on the row too.)
  - **A hole still greets the keyboard with motion**, the way it answers a mouse: one
    wave on arrival (`Hole`'s `greeting`, never under reduced motion).
  - **The drums are ONE tab stop each** — the slot row carries the `tabIndex`, the focus
    follows the pick when the arrows turn the drum — so Tab lands on the pick and the
    brackets stand on it.
  The verify pass Tabs through every stop of every screen and reports any where the
  brackets do not sit on the control's box or a browser ring paints (settled 260ms after
  the Tab: the travel is a 140ms transition). `useModalDismiss` still lands on the
  `<dialog>` itself, so nothing arrives already framed.
  **AND NO ZOOM ON A PHONE (user-reported 2026-09-09: "when you click on a button or
  select an input… the page gets zoomed in").** Two causes, two rules in `index.css`:
  `button, a, input { touch-action: manipulation }` — two quick taps on a control are a
  double-tap to the browser, which zooms the page; `manipulation` keeps pan and pinch and
  drops only that (the keys carried it already) — and **every text field is 16px or more**
  (`.account-input` was 15), because iOS zooms the page to a focused field set smaller.
  Never `maximum-scale=1` in the viewport: it would take pinch zoom away on Android. The
  verify pass reports any field under 16px and any control without `manipulation`; the
  only fields under 16 are Turnstile's `type=hidden` ones, which cannot be focused.
  **AND NO BROWSER TAP FLASH, APP-WIDE** (user-reported 2026-09-02: tapping a header key
  "makes a blue square appear for a short moment"). It is not focus — measured, a tap leaves
  `activeElement` on `<body>` — it is Chrome's default `-webkit-tap-highlight-color`,
  `rgba(51, 181, 229, 0.4)`, a translucent cyan box the shape of the control. A UI that
  draws its own press states, and its own focus outline, wants it on no surface at all, so
  `button` carries `transparent` once beside the global `text-shadow: none`; the hole, the
  solved word and the wheel row each held a private copy of the same line and are gone. **The missing-puzzle screen
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
  - **Icons paint with `currentColor`** (`fill` for the pixel glyphs, `stroke` for the
    chrome set) and carry **no hardcoded color** — the SVG root declares it once and every
    child inherits it. Color/greyed/theme states then come **only** from the consuming
    element's CSS `color` (e.g. the control keys' `.kb-control` / `.kb-enter` /
    `.kb-greyed`). Never bake a hex into an icon meant to tint with its surroundings.
  - **Strip the editor cruft.** Keep only `xmlns`, `viewBox`, the `width`/`height` size (see
    below), `fill="currentColor"`, and the shape elements. **Remove** the `<?xml …?>` prolog
    and `id`/`data-name` (Illustrator layer junk). This is what "remove the useless
    attributes" means for any new icon.
  - **TWO icon families since 2026-08-18, one per type voice.** CHROME icons (header +
    modal controls: calendar, x, fast-forward; circle-help was replaced 2026-08-18 by a
    bare `?` TEXT glyph — `.help-chip`, retired in turn 2026-08-31 for the drawn `help.svg` below — and question.svg is
    deleted; languages.svg left with the FR chip) are **LUCIDE
    icons** (ISC; user-picked the same day) restated in the repo's own dress as the
    **`.ui-icon` stroke set** — `viewBox="0 0 24 24"`, `fill="none"`,
    `stroke="currentColor"`, `stroke-width="1.8"` (Lucide's 2 thinned to match the
    hairline chrome), **SQUARE caps and MITER joins** (user-decided 2026-08-18 — the
    round defaults read "goofy" against the sharp chrome; the calendar's rect lost its
    rx, the circled ? became a bare sharp ?, fast-forward became double chevrons),
    in-file `width`/`height` — **22px since 2026-08-31** (28 before, sized against a
    32px pixel mark that has since left the header; at 28 in a 38px key four of them
    read as a toolbar jammed against itself). A new chrome icon starts from the Lucide
    glyph of that name, squared off the same way. The help control is `help.svg` — a
    bare stroke `?` on the same grid, its dot a small square, no circle (the 2026-08-18
    verdict on circle-help stands); it replaced the `.help-chip` TEXT glyph the same day,
    which was a letterform among drawings. PIXEL icons
    survive only on the PLAY surface: the on-screen keyboard's enter/back glyphs —
    orthogonal pixel art (integer grid, no diagonals, the 2026-07-08 rules), sized by
    `.kb-icon` in CSS (`height: 30%`) because the keys shrink on narrow phones. The
    standalone `.pixel-icon` class and the 3×-viewBox sizing rule left with their last
    chrome consumer; an icon's size stays IN its `.svg`, one source of truth.
  - **Accessibility:** the SVG is **decorative** — pass `aria-hidden` on the component and
    let the surrounding `<button>`'s `aria-label` name the control.
  The type for `?react` imports comes from the `vite-plugin-svgr/client` reference in
  `web/src/vite-env.d.ts`; the plugin is registered **before** `react()` in `vite.config.ts`.
- **On-screen keyboard (#36), and the guess PROMPT'S OWN FIELD (#267).** `WordInput` is the
  drawn terminal prompt over a **visually hidden `<input>`** — the guess's real focus target
  since #267, after two months with none. It had a field before #36, kept focused
  by a blur→refocus dance that opened the mobile soft keyboard and flickered the viewport;
  that was replaced by a **window `keydown`/`paste` listener**, which worked and left the
  guess belonging to nothing a keyboard user could reach. Neither problem comes back with
  the field: on a TOUCH SCREEN (primary pointer coarse, watched live) it is **`readOnly`**
  (the on-screen `components/Keyboard.tsx` IS this game's keyboard there), and nothing
  refocuses in a loop. **`inputmode="none"` alone is NOT enough** (2026-09-12, reported on a
  Samsung phone in Chrome): it hides the phone's keyboard, but Android still binds the
  keyboard APP to an editable field, and its composition fought the game's rewrites —
  letters doubled and tripled, backspace undone. A read-only field binds no keyboard app and
  still takes the focus and a hardware keyboard's keys; #268's NATIVE switch lifts it.
  Four rules hold it together:
  - **The keys are read ON THE FIELD**, not on the document, so a control the player tabbed
    to keeps its own Enter. Every key the prompt answers is `preventDefault`ed and the value
    is the folded state — `onChange` exists for text the browser inserts on its own
    (dictation, a desktop IME's commit — never on a touch screen) and for React's
    controlled-field contract, and only ever reads text ADDED at the end.
  - **The field takes the focus when the prompt becomes the surface that answers the
    keyboard**: on mount, and again whenever `active` flips back true (a modal closing hands
    focus to the control that opened it — the hole, never the prompt). Each screen also
    refocuses it from its own `submit`, which moves anything only when the on-screen ENTER
    was reached by Tab.
  - **It TAKES THE FOCUS BACK when a click lands on nothing** (`relatedTarget: null`, a turn
    later, and only if `document.activeElement` is `<body>`): the on-screen keys deliberately
    take no focus, so one stray click on the sentence's margin would otherwise leave physical
    typing silently dead with nothing on screen to click back into. Focus that left for
    another CONTROL is the player navigating and is never taken back.
  - **An INACTIVE prompt's field is `disabled`** — out of the tab order, holding no focus —
    which is also what keeps a focusable control from standing inside the `aria-hidden` box a
    retired prompt renders in. `Game`'s `active` therefore includes `!promptExiting`.
  The prompt's drawn line is `aria-hidden`; the field carries the value and `ariaGuess`
  names it. The on-screen keys answer a POINTER on `pointerdown` (instant, and
  `preventDefault` keeps the caret in the field) and a KEYBOARD on the `click` that Enter or
  Space makes, told apart by `detail === 0` AND by no pointerdown on the keyboard within the
  last `POINTER_CLICK_MS` (1s; 2026-09-12 — a synthesized tap click with `detail` 0, iOS
  Safari's documented first-tap double click, must not type twice) so a tap never fires twice.
  Both input sources drive one **folded-slug** `input` state in `Game` via three shared
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
  PLAY / skip (fast-forward or invite SKIP). Plus automatic
  pageviews.
- **Stale-tab auto-reload (user-decided 2026-08-16):** a deployed release must reach tabs
  already open — an SPA loads its JS once, and the deploy's `prune: false` deliberately
  keeps old chunks alive, so nothing ever forces a stale tab to refresh (and under the
  no-back-compat rule a stale client can genuinely break on a schema change).
  `vite.config.ts` stamps a PER-BUILD id into the bundle (`__BUILD_ID__` via `define`:
  git commit + build timestamp — the commit alone under-identifies a bundle, since a
  same-SHA redeploy with a rotated `VITE_` variable differs; a byte-identical redeploy
  reloading tabs once is the accepted cost) and emits the same value as
  `dist/version.json`, which lands in the infra `DeployRoot` no-cache set — published
  LAST by an explicit dependency (`web-stack.ts`), so a reloading tab can never fetch an
  index whose chunks are not uploaded yet. `src/versionCheck.ts` (prod-only, installed
  from `main.tsx`) refetches it (`cache: 'no-store'`, 10s abort — a stalled request must
  not pin the in-flight promise and kill the checker for the session) at FOUR moments —
  the page's own STARTUP, both `visibilitychange` flips, a `persisted` pageshow, and an
  hourly backstop interval — and calls `location.reload()` on mismatch, but only where
  nothing is at stake: startup, a return to a page that was left, or while the tab is
  hidden. Never mid-play in a visible tab: a mismatch the interval finds while visible
  waits for the next return. Every failure is silent (offline
  just retries on the next trigger). A reload is lossless: round state is persisted,
  index.html is no-cache, and deploys invalidate `/*`. The choreography is
  contract-tested (`versionCheck.test.ts`).
  **STARTUP and the bfcache restore were added 2026-08-20** (user-decided, after players
  kept landing on an older build): every other trigger is a RETURN, so a tab that came UP
  stale had nothing to catch it — and tabs do come up stale, because `no-cache` means
  "revalidate before reusing", not "never reuse". A history navigation and a session
  restore both serve a stored index.html without asking, and a revalidation that FAILS
  (offline, a captive portal) may serve it too; the old chunks that index names are still
  in the bucket by construction (`prune: false`), so the stale build runs perfectly and
  silently. Without a check at load, such a visit spent its WHOLE session on it. The load
  is also the CHEAPEST reload the module can spend — nothing typed, nothing in flight —
  which is why it is the one trigger that reloads a VISIBLE tab. **That cheapness is
  WATCHED, not assumed** (corrected 2026-08-20 on review): the check is a network round
  trip that can land up to the 10s abort later, by which time React has mounted and the
  app is playable, so the startup reload is gated on the page still being PRISTINE — one
  `pointerdown` or `keydown` (capture, `once`) ends it, since a guess, a name and a drawing
  are typed or tapped in. A touched page KEEPS the
  mismatch and spends it on the next return like every other trigger, and it does not
  claim the once-per-build budget below, which the next load may still need. Gating the
  first RENDER on the check was the alternative and is rejected: it would delay every cold
  start by a round trip — up to those 10 seconds on a bad connection — to serve the rare
  visit whose answer lands late. The `persisted` pageshow
  is the other half: a bfcache restore hands the LIVE page back with no network at all,
  so the old bundle simply resumes, and WebKit does not reliably flip visibility for it.
  **The startup reload is budgeted ONCE per build, per tab** (`whippin-version-reload` in
  sessionStorage): a reload revalidates the document, so a stale load resolves in ONE
  swap — but a `version.json` briefly AHEAD of the index it names (a deploy's own upload
  window) would otherwise reload the same build over and over with no player action to
  break the spin. Storage that cannot be written cannot bound it, so there the startup
  reload is not spent at all and the returns carry the mismatch exactly as before.
