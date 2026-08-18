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
      api.ts                  backend client: puzzleUrl/wordPuzzleUrl, 404->NO PUZZLE
      identity.ts             the #187 player key: localStorage secret, generated on first need
      versionCheck.ts         stale-tab reload: __BUILD_ID__ vs /version.json on visibility flips
      i18n.ts                 UI chrome strings (en+fr), t(lang, key); parity type-enforced
      tutorial/               onboarding (#51/#155): Tutorial.tsx + data scripts/<lang>.ts
                              (+ <lang>.word.json, the pruned #154 board it plays on)
      screens/Game.tsx        the guess loop, hole state (imports fold from @whippin/shared)
      screens/WordGame.tsx    Word mode's three phases: rules gate -> timed run -> post-mortem
      game/wordGame.ts        Word mode's rules + economy (shared WORD_CLAIM_ZONE re-export, rarity ladder, clock)
      game/wordBoard.ts       Word mode's post-mortem board: the zone as RARITY-graded stations
      components/rarity.ts    a rarity grade's pinned colour, and how many times a find is struck
      components/WordSlash.tsx    the slash a claim cuts the day's word with
      components/WordSubject.tsx  the day's word while the run is on: the word alone, centred
      hooks/useCountdown.ts   the run's deadline, as a ticking clock (HUD) and as one flip (screen)
      game/scoring.ts         s(rank), holeProgress, computeProgress
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
      hooks/useLetterWave.ts  #129's ambient ripple, shared by every surface that waves
      components/routeDrawing.tsx  THE route drawing: geometry, frame vars + the row parts
                              (OffMapShelf/RouteTail/RouteLink/RouteRow). Composed by
                              WordBoard (#156) and HistoryModal; both draw one trunk.
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
       **"MISS"** instead of a distance (no rank exists beyond top-K), in the ramp's
       weird red terminus. `MISS_COLOR` (#ff3d2e) lives with the ramp in
       `@whippin/shared`, and `heatColor(0)` IS it. A 100-away exponent therefore wears
       the same colour as a MISS (the fixed absolute cap collapses every farther rank
       onto the terminus); only the label distinguishes them. The red remains distinct
       from the timer/invalid `--danger` red and is legible on `--bg`, pinned by the heat
       and rarity tests.
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
    user-reported 2026-08-17; the wrap never moves, and the solved screen's words, which
    reuse it outside `.hole`, never grow a blank. The app's "not yet" dash vocabulary;
    the unfound `???` terminus wears it too — the TUTORIAL deliberately not at all,
    user-decided 2026-08-17: MixWord's demo hole and the coach text's hint words are
    lesson props, not blanks to fill. It sits at the wrap's bottom edge) — and solving
    INKS IT IN: `--solve` #4a6aff cobalt, blank gone. The ink IS the gradient's calm terminus, so a
    solve lands exactly on the peace the scale runs toward. It paints everything
    reached: resolved holes, the solved screen's trophies, both termini found, Word
    mode's day word, the OG card's word, the tutorial's `[[b:]]` secret (`.rt-target`) —
    and done-for-the-day strips/cells. The pale hole is strongly legible on `--bg`; the
    blank line and exponent carry the rest of the unresolved-state distinction.
  - **the ACCENT is POSTER VIOLET** — `--accent` #8f7bff (user-decided 2026-08-18,
    REMOVING the stamp orange outright — "keep the blue/violet palette for all accent
    and actions"; the hex is the ground's violet orb lifted to text contrast, chosen
    clear of the solve cobalt, the pale hole blue, RARE's cyan and OBSCURE's pinker
    #b164f2): the chrome (prompt caret, loading status, COPIED), the `+Ns` gain, the
    history "you are here" node, the streak, the source credit's headline, the
    standing's rank number. The keyboard's ENTER cap is the one exception, lit in a
    COBALT gradient (the macropad's "Publish" blue — submitting is the step toward the
    solve); the ground's old orange corner orb went cobalt with the accent. Never a
    scale value, never a word state.
  The palette tests pin the required legibility and reservations around MISS, solve,
  danger and the rarity ladder; retune those relationships deliberately, never by a
  copied stale hex.
  **The saturation level is the THIRD cut and it is the one that stuck** (user-iterated
  2026-08-17, same day): dusty print tones read "almost creepy", the mid-saturation inks
  still "dull/dead" — the /inspiration stamps are genuinely VIVID inks, so the palette
  is now fully saturated print colour, and the CALM comes from the textures, the paper
  fg and the static ground, never from muting the ink.
- **THE POSTER GROUND (iterated to its final form 2026-08-17, sampled off the Séance
  sheet in the user's /inspiration set).** The ambient Perlin canvas (`BackgroundWaves`)
  is DELETED — a field breathing under everything is the opposite of calm — and the
  ground is `--bg` #08090f, the poster's near-black (its sheet is #000; a whisper of
  navy keeps the glows breathing), wearing FOUR static layers:
  - the fine HALFTONE DOT matrix (one soft paper dot per `--cell`, replacing the
    graph-paper grid lines);
  - a COBALT SKY GLOW washing down from the top edge plus two faint corner ORBS (violet
    lower-right, cobalt lower-left — the orange orb left with the orange accent,
    2026-08-18): #184cf4 cobalt, #8b45ea violet. The raw poster cobalt is deliberately a
    GLOW-only colour (3.2:1 — too dim for text; `--solve` is its text-safe sibling);
  That is the WHOLE ambiance: ONE halftone texture plus the radial glows (user-tuned
  2026-08-17 — a film-grain overlay and then an edge halftone dot-vignette each shipped
  and were both removed on review; the single dither and the gradients are the look, and
  nothing sits above the content).
  `--fg` is stamp paper #f4f1e8, `--muted` warm grey, `--danger` an ink red; Word mode's
  rarity ladder is authored as a VIVID INK set (`components/rarity.ts` — same hue walk,
  thresholds re-measured in `rarity.test.ts`). Still ELECTRIC, pending an art repaint: the
  remaining baked pixel art (the streak flame sheets, ultracode.png, the hit sheets —
  logo-blue.png and the whippin.png mode sprite were DELETED 2026-08-18 for the
  user-drawn `assets/logo.svg`).
- **THE TYPE SYSTEM IS TWO VOICES — PIXEL ONLY WHERE YOU PLAY (user-decided
  2026-08-18, closing the redesign's deferred fonts half; walked from three voices to
  two on the user's same-day reviews — Inter "no soul" → Space Grotesk, then the grotesk
  AND the Instrument Serif display face both retired for ONE mono).** All faces
  self-hosted (`assets/fonts/`, latin + latin-ext subsets so French accents never fall
  back).
  - **PIXEL (Press Start 2P)** is reserved for the PLAY surfaces: the sentence and its
    holes, Word mode's day word, the route drawings entire (words, rank gutters, MISSED
    shelf), the prompt/input and its hint, the keyboard (keys + its `.kb-icon` pixel
    enter/backspace), the floating hits, the loot, the strike sheets, the CellDigits
    watermark, the solved screen's word trophies, the rarity ladder's EXAMPLE words,
    MixWord — and, since the same day's later passes, the whole SOLVED STACK's data:
    both result counts (`.solved-score-num`), the ENTIRE standing line (labels, the
    accent rank number AND the TOP badge — one face, so `standingUnits` is back to
    rank-digits-count-DOUBLE with one unit = one label glyph), the SOURCE CREDIT (both
    lines — the source is the puzzle's content, not chrome, and it is EXEMPT from the
    all-caps chrome rule: quoted content keeps its own casing, the code-uppercased KIND
    carrying the phrase contrast), the run ruler's tick numbers, the trophies'
    superscript numbers, and the streak celebration's digits (wheel slots at the pixel
    1em advance, the flame's HARD 6px indigo underprint restored — a soft glow clips
    square inside the overflow-hidden slots). **Every monospace layout assumption therefore still holds** — fitWord, the
    route `--gutter` arithmetic, MixWord's ch reservations and CellDigits' grid all sit
    on surfaces that stayed pixel. The coach text's inline `[[b:]]`/`[[w:]]` words are
    pixel at 0.82em INSIDE modern copy — game words quoted in chrome.
  - **MONO (Azeret Mono variable 100-900, `--ui`)** is EVERYTHING else — body default,
    header (title/date and Word mode's clock), buttons, coach copy, the standing line,
    calendar, streak, rarity chip counts, statuses, and every moment the retired serif
    used to headline (chooser names, the invite title — the credit, the result numbers
    and the streak digits all moved ON to the pixel face the same day, see above). A monospace is tabular by construction, so everything that ticks is stable
    for free, and `ScoreRank.standingUnits`'s glyphs-as-width estimate is literally true
    again. **The chrome is ALL-CAPS (user-decided 2026-08-18) — every mono surface wears
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
    TOP-badge pill, the rounded scrollbar thumb and the round rarity bead of the first
    cut are all squared back off; the run ruler's filament rounds at 3px).
    **ONE INK (user-decided the same day): chrome text and ICONS are `--fg`** — `--muted`
    survives only on GAME surfaces (the route drawing's dresses, the keyboard's control
    keys, the watermark) — with hierarchy carried by weight and opacity, never by a
    second grey; `--accent` keeps exactly its recorded accent roles.
    The HEADER's icons are the LUCIDE stroke set as `.ui-icon`s (user-picked 2026-08-18:
    calendar, circle-help, x, fast-forward, and LANGUAGES — the 文/A translation mark —
    for the language control, replacing the globe; 24-grid, 1.8px, currentColor, 28px
    in-file size; globe.png and the standalone `.pixel-icon`
    class are deleted); the Whippin mark is the USER-DRAWN `assets/logo.svg` since
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
      affordance). Elsewhere it stands: the result action INVERTS on hover;
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
    - **The CHOOSER cards are MEMBER CARDS** (superseding the aura tiles the same day):
      name bold left with an index TAG under it (a language's code EN/FR, a daily's
      01/02 — the `tag` prop each screen passes), and a deterministic LED-CELL MOSAIC
      on the right (`Chooser.cellsFor`, an FNV hash of the name; 8×3 cells lit in the
      card's ink — cobalt/violet/orange by nth-child). Decorative; the aria-label
      carries everything.
  - **The RUN RULER kept its PER-TRY STEPPED CELLS (settled 2026-08-18 after a round
    trip):** a gradient-filament version and then a colourless flat rule each lived for
    part of the day and both were rejected — "remove the gradient, put back the old
    step by step colors" — so the drawing is the original: one flat cell per counted
    try at that try's `progressHeatColor`, dead sharp, 16px, revealed by the per-cell
    show/colorize delays. What SURVIVES from the detour is the ticks' sentence indices
    in the PIXEL face. The bar therefore still matches the share card's stepped cells
    exactly.
- **A RANK IS WRITTEN BARE — no leading minus, anywhere (user-decided 2026-08-16).** A rank
  is a DISTANCE, and a distance is not negative; `sailor^87`, not `sailor^-87`. This is the
  app's ONE way of writing a rank, so it holds on every surface that shows one: the hole's
  exponent, the floating hit, Word mode's loot, every route row (history line + Word board),
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
  **`CLAIM_ZONE` remains the WEB's product tuning knob since 2026-08-10**, freely movable
  with no republish and no regeneration, but #169 made its numeric value a CLIENT/SERVER
  contract: `shared/src/scores.ts` now owns `WORD_CLAIM_ZONE`, `wordGame.ts` re-exports it
  under the existing name, and the backend uses the same value to reject impossible Word
  scores. Moving it therefore requires a backend deploy, not an artifact regeneration. Its
  only real ceiling is generation's `TOP_K` (10 000),
  past which a rank has no entry to claim. **Two things SCALE with it**, neither a blocker
  but both worth knowing before it moves again: the post-mortem board draws every zone group
  as a station, so this is also the board's ROW COUNT (1000 rows since the widening — the
  reveal's scrambles were already disabled, so the cost is DOM, not animation); and
  `wordStatusOf` reads progress as claimed/zone, so the archive's and chooser's percentages
  are proportionally smaller (a 25-claim run reads 3% where it read 10% — honest, since the
  field is deliberately unclearable and is now four times more so). It is pinned to nothing in generation: the board
  paints its station words by RARITY (see the board bullet below) off `freq`, and `dq` —
  what the drawing spaces its stations by — runs to the map's own `TOP_K` edge.
  **The CLOCK replaced the strike system (#163).** Two dailies should be two games:
  Sentence mode is think slowly, Word mode is think fast and beat the clock.
  Everything the strikes legislated, the timer legislates for free — a repeat, an invalid
  word or a far miss punishes itself in the seconds it cost to type — so `STRIKES_TO_END`,
  the consecutive rule, end-by-strikes, `WordFailures`, the crosses row, `assets/cross-button.png`
  and the `--strike-gap` responsive override are all GONE, along with `srWordFailures` /
  `srWordStrike`. Neither mode shows bots (the sentence game's LLM benchmark display was
  removed 2026-08-12 — see the solved-result bullet): the comparison story is other
  players (a score percentile, later), not AIs.
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
  run cannot claim floats `MISS`, in the ramp's weird red terminus (`MISS_COLOR` — see
  the sentence loop's MISS bullet) — a near miss (ranked, just outside the
  zone) and an off-map guess alike** (decided 2026-08-08, superseding the near miss's rank
  float). The
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
  about to be drawn). Its scheduling is `hooks/useLetterWave`'s, shared with the holes and
  the solved stage since 2026-08-16 (it was restated here while there were two copies —
  importing half a component's internals is not sharing it — but the third copy tipped it;
  see the #129 bullet). What stays this surface's own is the `active` gate it passes:
  never a one-letter word, since there is nothing to ripple.
  **The lean and the drop go on the INDEPENDENT transform properties** (`rotate` /
  `translate`), never into one `transform` string, and that is load-bearing rather than tidy:
  it leaves `transform` free, which is exactly what lets the wave — an ordinary transform
  animation — ride ON TOP of the fan instead of flattening it for the length of a ripple.
  Under reduced motion the float, the breath and the ripple are all switched OFF (infinite
  decorations, the rule the timer's warning pulse follows) — but **the fan itself stays**,
  because it is a POSTURE and not motion. All of this is the screen being alive while the
  player THINKS; it is deliberately separate from the guess FEEDBACK, which is what the
  screen says back when they ACT (the slash, below).
  **The TIMER sits UNDER THE WORD and the SCORE is the watermark (clock placement
  user-decided 2026-08-18, superseding the header corner: the header's left slot went to
  the date chip / archive entry, and the clock — in the PIXEL face now, like every number
  the game produces — lives in `.word-clock` right under the day's word, where the
  playing eye already is; the gate previews it there, and the post-mortem mounts no clock
  at all).** And the count becomes the big `CellDigits` watermark behind the
  word (`.word-anchor`, the standing watermark rule: what is displayed better later, since
  the count is this mode's end-screen headline). **That watermark is sized for at least TWO
  digits whatever it currently reads** (`MIN_SIZED_DIGITS`, decided 2026-08-09) — a rule of
  the SHARED component, so the sentence game's try count gets it too. Both numbers count
  play, so both cross 10 in the first minute, and the width budget is what bites on a phone:
  measured at 320/375/430px, the count rendered 252px tall for claims 1–9 and **halved to
  126 on the tenth**, mid-round. A watermark is the screen's fixed furniture; it must not
  resize because the game went well. So the glyph-pixel size is computed from the widest
  2-digit value the number could become while the BOX stays the real number's width (it
  still centres on its own ink) — which costs the 1–9 window some size and buys a count
  that never moves again. Past two digits it does move, because there is no honest way to
  reserve for a number with no bound; 99 → 100 is a milestone where 9 → 10 is the tenth
  guess of every single round.
  **The watermark sizes from the VIEWPORT ALONE and carries its own HALO (user-decided
  2026-08-17):** the old implementation quantized the glyph-pixel to whole `--cell` grid
  squares and snapped the number to the graph-paper grid — that alignment served the
  deleted Perlin field, so `CellDigits` now takes a continuous whole-pixel size straight
  from the same height/width budgets (`cellSize.ts` retired; `--cell` tunes only the
  ground's dot matrix now), and paints a radial pool of the ground colour under the
  digits — opaque at the number, fading to nothing — that erases the halftone dither
  around the score, as if the number cleared its own zone. The halo's reach scales with
  the digit height, and the horizontal clamp covers the halo margin too (verified: no
  scroll overflow at 320–1440px). That split IS the mode's feedback grammar:
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
  the word the word RECOILS and takes that colour too**, returning to the accent when it
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
  `rankHeatColor(rank)`, whose absolute cap is internal), the grade its `RARITY_COLORS` colour. The flight is
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
    RARE over the day's word (then blue) measures 77 dE apart and is illegible. `word-dim` (0.2,
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
  **The rarity COLOURS are the authored AURA LADDER, measured and pinned**
  (`components/rarity.ts` + `rarity.test.ts`; user-decided 2026-08-18, superseding the
  stamp inks — "the dull grey, the ugly green, the weird blue"): five steps of EMITTED
  LIGHT sweeping the app's own aura cool→hot — slate `#97a3c9`, LED cyan `#4fd2e8`,
  azure `#64a0ff`, violet `#bd68ff`, laser magenta `#ff5ce0` — ALL five authored now
  (COMMON no longer tracks `--muted`). They are not copies of heat-ramp stops. **THE MISS COLOUR IS NO GRADE'S:** every grade stays perceptually clear
  of `MISS_COLOR`, `--danger` and the cobalt `--solve` word it can be rendered beside;
  the grades also remain mutually distinguishable. Those relationships and the exact
  authored hexes are contract-tested, including the shared OG-card copy.
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
  ramp colour is borrowed for it: the heat ramp means DISTANCE (and, since 2026-08-16,
  progress read as the distance still to go), and a clock is neither. `role="timer"` is a live region defaulting to OFF, which is the point — the
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
  variables, the shelf, the tail, the connector rule and the station ROW are
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
  (decided 2026-08-07): the old modal's parked separator kept the same 8px clearance, so this
  one does too — via a MASK on the scroller (`.word-cut.more-down .word-scroll`), never a painted
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
  (user-decided 2026-08-11). Every zone station's word is painted in
  its grade's own `RARITY_COLORS` colour (`--rarity-c`, set per station by WordBoard) — the
  same colour the strike and the loot wore when the claim landed — where the sentence line
  paints its stops gold; the drawing itself is the history line's: the same
  `routeFrameVars`, the same `LEAP_H` (56) solid run into the terminus, the same
  shared `--word-gap` and 48px shelf air (both promoted to the shared drawing on user
  review — "the gaps and sizings are not the same" — 2026-08-11), the terminus as
  `RouteWord` in `route-found`'s accent (the colour rule is keyed on the `graded`
  class per zone station, not on every station, exactly so the arrival's own colour survives —
  an unkeyed first cut painted the day's word `--fg`). The
  post-mortem still answers *where were the expensive words?* — in the type now, the way
  the sentence map says its zones. A station is NEVER colourless (COMMON is `rarityOf`'s
  floor); what stays `--fg` on the trunk is the near misses, which belong to no grade.
  `WordBoardModel` is UNCHANGED — it still grades every station and ships `grades` (ladder
  order, only the grades the field holds), whose consumer is now the sr census:
  `srWordRarities` states the field per grade and a named stop carries its grade
  (`srRouteStop`'s `rarity`), the word's colour said in words; grade names stay
  untranslated there as everywhere else.
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
  run into the word is SOLID at the sentence line's own `LEAP_H` (2026-08-11 — the two
  drawings share their arrival). The rank gutter fits the farthest row drawn,
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
  the board IS this screen, and every row of the line the player can see is more of the
  journey made visible, where the space around it says nothing. So `.game.word-game` cuts its own
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
  `SCROLL_PX_PER_MS`, the focused rank and the rAF loop are all gone.
  **The end screen is the SENTENCE result's stack, exactly** (user-decided 2026-08-15, "the
  exact same layout and sizing"): the day's STANDING first, then the run's own number, then
  SHARE on the tray's bottom edge — the shared `.solved-score` sizing and `.solved-numbers`'s
  spacing, which is now stated ONCE on `.solved-results` and worn by both. The standing
  arrives WITH the block (`chartStart = resultsIn`) for the sentence screen's reason: a line
  sitting above the tally must not land after it. What this replaced: the count at
  `clamp(52px, 10vh, 88px)` in a `flex: 1` region that centred it in whatever the tray had
  spare, with the standing UNDER it — arcade weight, and a stack sharing only its action
  baseline with the screen it was meant to rhyme with. The only word-specific thing left in
  the stack is the rarity CHIP ROW, which the sentence result has no equivalent of (its
  ruler is likewise the sentence's alone). The end screen
  (`components/WordEndScreen.tsx`) is the named `<n> WORDS/MOTS` count + SHARE via the
  v5 word token — which carries the claims PER RARITY GRADE, ladder order; the screen
  takes that breakdown (`counts`, computed by `WordGame` from the one replay) and DERIVES
  the count as its sum, so the tally, the text, the token and the card speak one set of
  numbers (decided 2026-08-11, superseding the v4 single-score token); **the score OG card
  draws the accented display word ALONE in the global accent — centred, NO node square
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
  bead row is the exact analogue of the sentence `emojiRow` beside it. **The headline's SHAPE
  moved there too** (`shareHeadline`, 2026-08-16): it is one message format for both dailies,
  and it was a template literal hand-copied into both result screens, where one mode's message
  could quietly drift from the other's. Each screen still owns the only part that is genuinely
  its own — its localized UNIT (tries against words). That is also what lets `share.test.ts` assert the visit card's
  exact string, and what lets preview tooling render the REAL message instead of a copy that
  can drift (it did, the first time). A grade's SCREEN presentation stays in
  `components/rarity.ts`; `game/` must not import from `components/` (the dependency runs
  the other way).
  Its tally lands on a one-shot scale pop (`score-land`, 2026-08-07 — never at 0, never on
  rehydration, collapsed under reduced motion), and **the BREAKDOWN is the result's LAST
  beat since 2026-08-11** (superseding "the count is the last beat"): the screen draws the
  claims per grade under the unit — the OG card's chip row on screen (`.word-rarities`, a
  coloured square + count per grade CLAIMED, commonest first, zeroes absent, each chip in
  its `RARITY_COLORS` colour) — and once the count settles (the pop's own moment) each chip
  rises in on its own delay via the tutorial ladder's `rung-in`, unpacking the number that
  just landed. The row holds its layout space while invisible, so its arrival moves
  nothing; a rehydrated result wears `.settled` and replays nothing; reduced motion
  collapses the rise and keeps the delays (the floating numbers' degradation). It is
  decorative (`role="img"`) with `srWordBreakdown` as its accessible line — grade names
  untranslated, as everywhere. Identity is mode-addressed everywhere: `roundKeyForDay(day, lang,
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
  each restate the pair. Word runs never touch the streak and fire no new analytics
  events.
- **Hole HISTORY modal (user-decided 2026-08-10, REPLACING the #117 route map):** tapping a
  HOLE opens the round's own journey toward that hole's secret — the player's guesses as
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
  `MISS_COLOR` as its heading (see the front-loop MISS bullet), dimmed to the same 0.55 (`.route-miss` —
  a SHARED shelf, so Word mode's post-mortem gets the one-voice frozen block too), and the
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
  **That clock is `hooks/useLetterWave` since 2026-08-16, shared by all THREE surfaces that
  wave** — the holes, Word mode's day word (`WordSubject`) and the solved stage's guessed
  words (`SolvedScreen`). Two copies were a recorded decision; at three, retuning the band
  or the stagger took three coordinated edits that nothing forced to agree, and the
  scheduling itself is pure — two timers and a random band, knowing nothing about holes or
  strikes. What each surface keeps is the one part they genuinely disagree on: `active`,
  its own answer to "is this word free to ripple right now?" (a hole's `ticking`, a word's
  letter count, a solved word's arrival). `WAVE_VARS` hands CSS the same two numbers the
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
  404→`noPuzzle` path is reused as-is. The calendar reads each day's status from the
  **persisted rounds** (device-local) via the extracted `state/status.ts` `statusOf`
  (shared with the language selector). **Cell coloring (decided 2026-07-08):** a day with
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
- **The solved SCREEN (user-decided 2026-08-14, superseding the tray-stack layout — "the
  sentence takes way too much space on mobile"): the sentence DISSOLVES and the result
  takes the whole column.**
  - **The sentence's exit is the game's own word-transition run to absence**
    (`components/DissolvePhrase`): once the solving beats have handed the screen back
    (streak dismissed, keyboard dropped — `resultsUp`), the live Phrase swaps for a
    pixel-identical letter-boxed copy (same `.phrase`/`.word`/`.hole-group`/`.hole
    .resolved`/`.hole-letter` structure, so frame 0 matches to the pixel and the wrap
    points are the same wrap points), and every letter churns random glyphs on the
    scramble's OWN 40ms tick, each for 2–5 frames, then goes OUT. **The erosion is
    SCATTERED, and its length is a CONSTANT** (user-decided on review the same day,
    superseding the first cut's 20ms left-to-right sweep, which read as a cursor deleting
    the sentence): each letter draws its start uniformly from ONE fixed window
    (`SPREAD_TICKS`, 720ms), so the order is random every time, "batches" fall out of the
    uniform draw with no batching machinery, and a long sentence dissolves in exactly the
    time a short one does — more letters simply go out per tick. Both dice are rolled
    ONCE at mount (a re-render can never re-roll a letter — the slash-flip rule). A dissolved letter keeps its box `visibility: hidden`
    (`.hole-letter.gone`) — never an actual space, never removed — so the monospace
    advance holds every surviving letter exactly where it was: the sentence burns down IN
    PLACE, and nothing reflows until the whole area unmounts. The score watermark fades
    with it (`.phrase-anchor.dissolving`); the prompt zone stays laid out (retired,
    invisible) through the erosion so the centered sentence never moves. A 180ms breath
    after the last letter, then `onDone` swaps the screen. Reduced motion skips the churn
    entirely; a rehydrated solve mounts `dissolved` and replays nothing.
    **The reduced-motion preference is read ONCE at mount, like the letter dice** (fixed
    2026-08-16): two effects branch on it, and read live they could disagree — a setting
    flipped mid-erosion (an OS toggle, battery saver) left the interval running while the
    completion effect skipped `onDone` believing the other had already reported, stranding
    the player on a fully eroded, invisible sentence. This is the one solved beat with no
    deadline behind it, so its two halves have to agree by construction.
  - **The solved STAGE then owns the full column** (`components/SolvedScreen`, rebuilt;
    the `.play`+`.tray` split does not render at all — nothing is left to reserve the
    keyboard's footprint for), **in TWO BLOCKS around one SEAM** (user-decided
    2026-08-14, second pass — they answer different questions and ran together as one
    undifferentiated column):
    - **PUZZLE** (`.solved-puzzle`) — the DISTINCT GUESSED WORDS in the solve blue
      (VT323 at `clamp(26px, 6vw, 36px)`, numbered 1..3 by the ruler-tick/modal-title
      numbering, each still a BUTTON onto its history line — same `data-hole-explore` +
      `.hole-word-wrap` zoom origin, never disabled since they only exist after every
      beat that owned the sentence, and each rippling the hole-wave on its own 3–10s
      clock as the tap affordance, numbers restated per the WordSubject rule) — and the
      SOURCE **under them, at its own caption size** — it briefly led the stage typed big,
      and reads as what it has always been, the credit line beneath the puzzle's content;
      only its ALIGNMENT follows the centred stage. **It is a CREDIT BLOCK of TWO lines,
      and the second one is a PHRASE** (user's own shape, 2026-08-15, superseding three
      stacked fields the same day and the `— Author, Work` run-on before them):

      ```
         Les Misérables         the WORK — the credit's headline: gold, `clamp(13px,
                                1.8vw, 17px)`, the biggest type in the block
         BOOK by Victor Hugo    what it IS and who it is by — `--muted`, 10px, ONE phrase
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
      kinds are the whole table — adding an invented one would claim generation emits it. Gold over muted ranks the two,
      so the eye lands on the title first. The qualifier sits tight under its headline —
      the caption's gap opens between the credit and the words above, never inside it.
      Every field is independently optional in the schema (#5), so the HEADLINE is the
      first of work / author / kind that exists and the qualifier is whatever is left: an
      author with no work takes the headline (a lone name is not a credit to anything, and
      `by Victor Hugo` under nothing is a sentence missing its subject) with its kind alone
      beneath it, and a source carrying only a kind is just that word. The typewriter is
      unchanged: one character run across whatever lines exist.
    - **SCORE** (`.solved-numbers`) — the #170 STANDING line, then the named
      `<tries> TRIES` headline over the run ruler, **then SHARE**, which belongs to this
      block (user-decided 2026-08-14, third pass: sharing is what you do with a RESULT).
      **The standing leads and the score follows** (user-decided 2026-08-15): where you
      placed, then YOUR number and the run that made it, which puts SHARE directly under
      exactly what the card it shares draws.
    - **The SEAM is SPACE, not a measured gap** (same decision): the SCORE block sits on
      the screen's BOTTOM EDGE and the PUZZLE block's `margin: auto 0` eats all the
      leftover height, centring it in what is left above. The taller the screen, the more
      the two read as two — measured 33 / 99 / 175 / 202px at 320×568 / 375×667 / 390×844
      / 1440×900, where the fixed gap it replaces gave the same ~43px everywhere. The
      stage's own `gap` (`clamp(28px, 5vh, 48px)`) is only the FLOOR, for a screen too
      short to have leftover height to hand out. The score block carries the page inset
      off the bottom (+safe-area+10px on a phone — the retired `.tray.tray-results` rule,
      now on the block that owns that edge).
  - **The reveal reads the way the stage is laid out**, top to bottom: the WORDS **pop in
    one by one, 200ms apart** (`solved-word-pop`, a 300ms overshoot-and-settle — a scale
    on the pixel font is allowed exactly here, ONE SHOT and fast, the
    `rank-pop`/`score-land` precedent; what the standing rule forbids is a long scale
    TRANSITION holding blurry frames for its whole length), the SOURCE types once the last
    word lands, and the SCORE block follows once that citation has **FINISHED PRINTING**
    (user-decided 2026-08-15, superseding the fixed `CAPTION_LEAD_MS` 420ms lead off the
    source's FIRST line): numbers arriving over a half-typed credit read as two things
    happening at once, where waiting reads as one thing after another. That is the
    screen's ONE signal-driven beat — it rides `SolvedCaption`'s own completion callback —
    so it carries a DEADLINE behind it (`captionDurationMs(source)` + slack, the
    `KB_EXIT_FALLBACK_MS` rule: a lost signal must never be able to stall the solved
    sequence), and the deadline is derived from the typewriter's own numbers rather than
    guessed. That backstop counts **VISIBLE time only**: the typewriter interval is
    throttled/suspended with a hidden tab, so a wall-clock deadline could otherwise reveal
    the numbers over a half-printed credit on return. A source-less puzzle has no printing
    to wait for and its numbers follow the words. Every other beat is still an absolute
    offset from the beat before it. **Inside the block the reveal runs score → standing →
    SHARE (user-decided 2026-08-16, superseding "the standing arrives with the block it
    heads"):** the tally counts its `SCORE_COUNT_MS` WHILE the ruler sweeps in and
    colorizes (the color wave one `NEUTRAL_HOLD_MS` behind the neutral cells) — one beat
    saying "here is your run" — then the STANDING lands (`rankIn`, after the longer of the
    two plus a breath), and SHARE closes the reveal once the standing's own rung-in has
    played (`shareIn`): the screen ends on its action. The standing's slot was always
    mounted; SHARE now also hides IN PLACE with its footprint kept
    (`.solved-stage .result-actions`), so neither arrival moves anything.
  - **Nothing that has landed ever moves:** both later blocks hold their layout box from
    frame one (the source `visibility: hidden` — the retired prompt's own trick — the
    score block at `opacity: 0`), so the words keep the exact position they popped into
    while everything else arrives under them (verified pixel-identical across the whole
    beat, SHARE included). Rehydrated solves render `.settled` and replay nothing.
  - **REMOVED with the redesign** (no-back-compat rule, all were left without a
    consumer): the caption's `masked` veil and its prompt-zone overlay (the caption now
    mounts only WITH the stage, so an unsolved round's DOM never carries the author
    hint at all — the leak the veil existed to plug), the SOURCE-reveal beat machinery
    and its 6s visible-time fallback (`sourceReveal*`, `SOURCE_REVEAL_FALLBACK_MS`,
    `solvedSettled` — nothing downstream waits on the typewriter any more), and the
    tray's sentence-results state (`.tray.tray-results`; the tray now only ever holds
    the gate or the keyboard). Holes are tappable during PLAY only; the stage's word
    buttons take over after.
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
  every guess and still cached on the round by `syncProgress`. **The SHARE CARD draws the SAME
  ruler (decided 2026-07-25, superseding the bucketed-squares card):** the share token
  was bumped to **v2**, carrying the RAW per-try trajectory plus the solve moments
  instead of the `bucketMeans` squares, so `renderCardSvg` renders the on-screen ruler
  scaled to the OG image — same `progressHeatColor` cells, same ticks, same sentence
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
  The ruler's colorize wave paces its
  per-cell delay with
  `rulerStagger(n, reduceMotion)`, which returns **0 under reduced motion** — the
  global CSS rule collapses animation/transition DURATIONS but not DELAYS, so the ramp
  would otherwise still crawl across the bar for over a second for someone who asked for
  no motion. The keyboard's exit beat
  releases the dissolve through a signal the DOM has to produce (its own
  `animationend`) — so it carries a **deadline** (`KB_EXIT_FALLBACK_MS`
  in `Game.tsx`), a generous multiple of the real duration, cancelled by the genuine
  signal. A lost signal must never be able to stall the solved sequence. (The SOURCE
  reveal's own 6s visible-time fallback died with the source-gating on 2026-08-14 —
  nothing downstream waits on the typewriter any more, so there is nothing left for a
  lost report to strand.) On a
  streak solve the exit beat does NOT play hidden behind the celebration — the keyboard
  holds still under the modal and the drop starts at its dismissal (decided 2026-07-24).
  **The sentence must NOT move between the solved beats (decided 2026-07-24):** through
  the streak, the drop and the dissolve, the tray keeps the keyboard's fixed height and
  the retired prompt keeps its layout, so .play's centering never shifts the phrase — the
  sentence holds perfectly still right up until it erodes in place. **Fresh-solve
  sequence (decided 2026-07-10):** the
  solving submit immediately sends the prompt left while fading it out, in the same render
  that launches the final hole-hit feedback. The next stage waits until EVERY `Hole` reports
  its final secret rendered after its final settle animation completes — never a
  guessed timeout — so multi-word or throttled animation cannot be covered mid-resolution.
  A fresh active-day solve then holds the fully resolved sentence for 300ms before mounting
  the streak modal. **The solved beats run STREAK → keyboard-drop → DISSOLVE → the stage
  (2026-08-14, superseding the 2026-07-24 "results rise → SOURCE" tray order):** once the
  modal has completely dismissed (including its exit fade) — or immediately after the
  final holes settle on archive / no-streak play — the drop plays, the sentence dissolves,
  and the solved stage rises with its layered reveal (see the solved-screen bullet
  above). Rehydrated solves render the full stage immediately without
  replaying the sequence — EXCEPT under the dev `?streak=N` preview, which deliberately
  opts one back into the choreography so the post-streak sequence can be watched. **That
  replay is held at frame zero until the preview dismisses** (`SolvedScreen`'s `start`,
  restored 2026-08-16): App owns the preview dialog, so this round never sees it in
  `showStreakDialog`, and without the gate the whole reveal — words, citation, tally,
  standing — plays under a full-screen modal and dismissal lands on a finished frame,
  spending unseen the exact beats the harness exists to show. Player progression is separate:
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
- **Solved-screen STANDING (#170, 2026-08-14; the histogram it started as was retired
  2026-08-15 — see below):** both modes' result stacks show where the finished score sits
  in the day's anonymous population (#169), above the mode's own metrics and SHARE — the
  comparison story that replaced the removed LLM benchmark.
  ONE rule for the round trip (`hooks/useScoreHistogram`): a FINISHED round that has not
  submitted POSTs its score once — carrying an invisible Turnstile token (`turnstile.ts`,
  the only module that knows Turnstile exists, the analytics.ts pattern; site key
  `VITE_TURNSTILE_SITE_KEY`, .env.example ships Cloudflare's always-passing invisible TEST
  key for local play, while production's required GitHub repo variable is injected by
  `deploy.yml` and `vite.config.ts` rejects an unset production build; **the production key
  must be provisioned as an INVISIBLE widget, never Cloudflare's default "Managed"** — the
  client renders into a hidden container, so a Managed key that escalates to an interactive
  challenge can never be completed and silently drops the score of exactly the players
  Cloudflare doubts. Nothing in code can detect the widget type, so it is a provisioning
  rule, stated in `.env.example` and the workflows README. A failed or stalled script load
  NEVER sticks: load/error are joined by a 20-second script timeout, and every rejection
  clears the cached module promise, since a rejected promise left in it would disable
  submission for the whole session) and the
  `x-amz-content-sha256`
  hash of the exact body bytes it sends (`api.postScoreBody` — the root AGENTS.md's OAC
  contract), plus the PLAYER KEY (#187, `src/identity.ts`): the localStorage secret
  generated on this first need, sent in the body as the round's identity — the server
  keys the day's one first-write-wins row by the publicId it derives from it — and the
  POST's response IS the histogram (one round trip on the happy path);
  a round already submitted GETs the read-only twin on revisits — locating the standing by
  the persisted `scoreRecorded` (#187) and by it ALONE: the population is first-write-wins
  per player, so a duplicate submission (another device/tab under one key) is answered
  with the STORED row's score, which a 2xx persists beside the flag. A submitted round
  WITHOUT a recorded score is one the server refused (or a pre-#187 round, whose old
  population is gone), and its revisit shows no standing at all — never a local-count
  fallback, which could place the refused player in a band another player recorded. The `scoreSubmitted` flag
  persists ON the round (both round shapes, optional field — no store version bump), and is
  marked when the server reaches a **VERDICT** — accepted (2xx) or refused (4xx) alike,
  either way the conversation is over. Anything that is merely the backend FAILING leaves it
  unset so a later visit may retry: a transport/Turnstile error that throws, and **a 5xx
  (corrected 2026-08-16 — the flag used to be set on any answer at all)**. That distinction
  is load-bearing rather than pedantic: a round has ONE submission, the visit that spends it
  cannot be repeated, and burning it on a cold start or a throttled write drops that score
  from the day's population for good. It is also what lets a Word
  run whose clock died with the tab closed submit on the revisit that finds it over. The
  completion is keyed to the round that launched it (never whichever round navigation made
  active later), and an in-flight conversation is shared across real component remounts so
  leaving for the archive/tutorial and returning cannot mint a second POST. EVERY
  failure is silent by decision: the solved screen simply shows no standing, never an
  error. **What it shows is ONE LINE — the player's RANK** (`components/ScoreRank`,
  user-decided 2026-08-15, replacing the brick histogram that replaced the first cut's
  bars: "the histogram is actually ugly" — a field of bars asks to be decoded, where the
  rank is the answer already given):

  ```
  RANK #16 OF 100   [ TOP 25% ]
  ```

  - **RANK is COMPETITION RANKING — everyone strictly ahead, plus one** (`game/scores.ts`
    `scoreStanding`, contract-tested), so a whole band shares its rank. That is the only
    honest number at bucket granularity — the API reports BANDS and never an order inside
    one — and it is the convention every scoreboard already uses for a tie. Which
    direction is "ahead" is the mode's: sentence counts tries (the bands BEFORE mine),
    Word counts claims (the bands AFTER mine). The rank is clamped to the population, so
    a stale read racing a write can never rank anyone past the field they stand in.
  - **TOP uses the MIDPOINT of the shared bucket** (user-decided 2026-08-16):
    `(strictly ahead + bucket count / 2) / total`, the standard percentile-rank treatment
    for ties. It deliberately does NOT derive from the competition rank: with 15 ahead and
    20 in the player's bucket out of 100, the honest claims are `RANK #16 OF 100` and
    `TOP 25%`. An empty bucket carries no badge, and a stale inconsistent snapshot is
    capped at 100%. (The midpoint's own all-tied answer, 50%, is no longer reachable on
    screen: an all-tied field ranks everyone #1, which the rank gate below silences.)
  - **The RANK NUMBER is the headline**: 24px against the 12px words around it, in the
    global ACCENT — the game's own word colour. The words are `--muted`, and
    the whole phrase hangs off ONE baseline (`.score-rank-text`), since centring the small
    type against the number left it floating. **A shared baseline is not yet a shared
    LINE** (user-decided 2026-08-15): the pixel font reserves a gap under its glyphs and
    that gap scales with the type, so the big number rides visually high off a baseline it
    shares — it takes `translate: 0 2px` to put the ink back on one line, and the badge
    `translate: 0 4px` for the same reason, more of it (its box is centred on the smallest
    type on the line). Whole pixels, and a `translate` rather than a margin, so nothing
    moves because of it.
  - **TOP is an OUTLINED BADGE — a 1px `--fg` rule around `--fg` type, no ground at all**
    (user-decided 2026-08-17, superseding the filled chip: a solid block of foreground
    beside the line shouted louder than the rank it qualifies, where an outline still
    frames the claim as a stamp). The foreground on both the rule and the type is the kept
    half of the earlier decision (2026-08-15, superseding the gold: gold is the colour of
    what the round REACHED, and a percentile is not one of its words). **Nothing else in
    the badge moved** — the padding, the explicit height, the drop and the type sizes are
    all the filled version's, and `box-sizing: border-box` is what keeps them that way:
    the rule is drawn INSIDE the same `--top-h` box rather than growing it. It has an
    EXPLICIT height with its ink centred by flex: the pixel font overruns its own line
    box, so padding alone left the glyph tops and tails outside the box. (And never
    `calc(<length> + var(--text-shift))` — that variable is a UNITLESS zero, which voids
    the whole declaration; the same trap that silently zeroed `.word-input`'s padding.)
    Three details make it a stamp rather than a clipped box (user-decided 2026-08-15,
    "very ugly"): the page's global `text-shadow` is OFF on it — a drop shadow is
    legibility for type sitting on the page itself, and inside a framed chip it only
    smears small type against its own frame; the height is generous (30px around 10px
    type) rather than the tightest box that fits; and the right inset is ONE PIXEL SHORT
    of the left, because `letter-spacing` applies after the LAST glyph too and equal
    padding leaves the box reading off-centre around its own word.
  - **The line is sized from ONE set of custom properties, in three tiers plus a trigger
    that is not a width at all.** Pixel type does not reflow and `body` is
    `overflow: hidden`, so a line that outruns its column is CUT OFF rather than scrolled
    to — and the sizes the line is TUNED at (12px words, 24px number, 30px badge; the
    user's own numbers, given for "the smallest devices") land within a few pixels of what
    a 390px phone holds. So:
    - **base** — the tuned set scaled up (14 / 28 / 36px), for real desktop room;
    - **≤600px** — the tuned set itself. It reaches that high because a 430px handset only
      leaves 402px of column and the scaled-up line wants ~430;
    - **`.tight`** — the same step down, asked for by the CONTENT: `ScoreRank` estimates
      the line's length in LABEL GLYPHS (`standingUnits` — the font is monospace, so a
      glyph count IS a width, and the number counts double at twice the label size) and
      marks it tight past `TIGHT_STANDING_UNITS`. `RANG #12 SUR 599` + `TOP 20.3%`
      measures exactly the 362px a 390px screen leaves, and one more glyph would clip, so
      the LONG line steps down and the common one keeps the big type (the measurement was
      taken on the two-decimal badge, which is a glyph longer against a shorter
      population — it calibrates UNITS to pixels, so it survives the one-decimal cut);
    - **≤380px** — every line steps down (9 / 16 / 24px): a 320px screen holds 292px,
      which not even the short line fits at the tuned sizes.
    The slot's reserved HEIGHT is the width tier's alone and never `.tight`'s — the empty
    slot is reserved before the population has answered, so it cannot know whether the line
    it holds space for will be a long one. A four-digit population (`SUR 1024`) still
    outruns a 320px screen even stepped down; that is a day this game has not had yet, and
    the answer then is the line's copy, not another pixel of type.
  - **The number and the badge each ride a WHOLE PIXEL BAND below the shared baseline**
    (user-decided 2026-08-15; 2px and 4px at the tuned sizes, scaled per tier). The pixel
    font reserves descender room under every glyph and that band grows with the type, so
    type sharing a baseline with much smaller type sits visibly HIGH against it. Whole
    pixels only, via `translate` rather than a margin: a fractional offset resamples pixel
    type (the sprites' integer-scale rule), and nothing may MOVE because of it.
  - **The badge is gated TWICE, and both gates only ever silence it** — the rank line
    itself is honest at every size and always drawn, so the only player of the day reads
    `RANK #1 OF 1` and nothing more. The line is SHORTER without the badge, which the
    length estimate above reads off the badge actually drawn rather than assuming one.
    - **above `PERCENT_MIN_TOTAL` (10) recorded scores** (user-decided 2026-08-15,
      reinstating a floor after a day without one — the first cut of the line had gated it
      at 25): below that, `TOP 33.33%` of three players is arithmetic on a handful rather
      than a standing;
    - **from `PERCENT_MIN_RANK` (10) on — a SINGLE-DIGIT rank carries no percentage**
      (user-decided 2026-08-17): `RANK #6 OF 60` names an exact position a reader takes in
      at a glance, and a percentage beside it restates in blur what the number already
      said outright. From two digits on the rank stops being that legible and the
      percentage is what carries the standing. The two floors overlap (rank 10 already
      implies nine players ahead) but gate different claims: one asks whether there is a
      field, the other whether the percentage adds anything to the rank beside it.
  - `formatTopPct` prints at most ONE decimal with the trailing zero stripped (`8.5`,
    `12.5`, `50`) — user-decided 2026-08-17, from two. On a real population the first
    decimal still carries a claim; the second is precision nobody reads, and `50.0` reads
    as a machine talking.
  - **The slot is fixed-height and ALWAYS mounted** (the `.word-rarities` rule): the line
    arriving — or never arriving — moves nothing under it, SHARE included. It arrives on
    the app's one `rung-in` gesture; a rehydrated result renders `.settled` and replays
    nothing.
  **REMOVED with it** (no-back-compat): the whole chart — `ScoreChart`, `chartField`,
  `chartUnits`, `MAX_CHART_BANDS`, `MAX_COLUMN_UNITS`, the band-merging and its `+N`
  legend, the `.score-field`/`.score-col`/`.score-brick`/`.score-stub`/`.score-plot`/
  `.score-legend` CSS — and the N-adaptive copy line with it (`histogramCopy`,
  `beatenCount`, `scoreFirst`/`scoreOther`/`scoreOthers`/`scoreBeat`): `TOP x%` and "you
  beat x%" are the same claim inverted, and the rank says it once.
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
  holes are untappable and waveless
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
  history tap. The famous-AI line was CUT on the same user review (and the standings
  lineup it referred to was removed outright on 2026-08-12 with the benchmark display).
  The gate is DERIVED, not state: `!sentenceRulesSeen && !solved &&
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
  MISS red, `[[n:]]` heat number); INTERACTIONS at the bottom (mix button, then
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
  sentence game's one-time PLAY gate, below). Finding the word retires the prompt and
  DROPS the keyboard out of the tray (the game's own `kb-drop`, same `KB_EXIT_FALLBACK_MS`
  deadline behind its `animationend`). **The ending then runs TWO beats, one idea each**
  (the tutorial's own grammar): the CLAIM — « Une dernière chose : chaque mot a une
  rareté. » (`tutRarityIntro`) — over the found word, with the tray's NEXT as its only
  control; then the word gives way to the **RARITY LADDER**
  (`tutorial/RarityLadder.tsx`), a **SIGNAL METER since 2026-08-18** (user-decided,
  superseding the size-ramped two-column rungs — "the difference in font size are
  terrible", and the two same-size fonts competed): five rows, commonest first, each
  carrying a five-cell LED METER with one more cell lit per grade — rarity as signal
  strength, the member cards' own cell vocabulary — the grade's name as a small quiet
  mono label (11px, `--fg`), and **one OBVIOUS example word per grade** (user-decided
  2026-08-11: the ladder teaches by evidence — en house / twilight / obelisk /
  reliquary / apricity, fr maison / crépuscule / alambic / cénotaphe / zinzolin,
  `tutRarityEx*`, hand-authored per language for intuition) in the PIXEL face at ONE
  size (15px, 13px ≤640px), right-aligned, wearing the grade's aura colour with the
  game words' soft glow. Fits by arithmetic at 320px (label 9ch + meter + crépuscule at
  13px ≈ 263 of 292). Each row rises on its own `rung-in` delay (reduced motion
  collapses durations, keeps delays). The coach line states the CONCEPT and no value —
  « Des mots de tous les jours aux mots presque oubliés. » (`tutRarity`) — and
  deliberately NOT what a grade pays: the seconds are Word mode's rule, stated on its
  gate (`wordRulesBonus`). The grade names are the game's untranslated vocabulary from
  `RARITY_NAMES`; the ladder is decorative (`role="img"`) with `srRarityLadder` + the
  names and examples as its accessible line.
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
  guided words, by `web/scripts/prune-word-map.mjs` (`--top` cuts the zone by RANK) — the
  exact command is recorded in each script's header, and `scripts.test.ts` fails if board
  and map ever drift. **en = OCEAN, fr = TROPIQUES** (en/fr symmetry a standing non-goal).
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
- **App header — FINALIZED 2026-08-18 (user-decided, mobile-first; supersedes the
  2026-07-21 "no band, corner chips" design below — that rule guarded against boxes
  over the old ANIMATED waves, and over the static ground the dialogs' own glass is
  what keeps the controls legible without simplifying the backdrop):** ONE **GLASS
  BAND** (`components/TopBar.tsx`): `--glass` + hairline + backdrop blur, full-bleed
  with a single bottom hairline on a phone, FLOATING capped-and-rounded just inside the
  device frame's brackets on desktop (`min(900px, 100vw - 48px)`, 50px, 8px off the
  top). THREE explicit grid slots (`1fr auto 1fr`, columns assigned by class so a
  missing slot never shifts its neighbours; ModalHeader reuses the classes with no
  centre):
  - **LEFT, the status spot**: the DATE CHIP in BOTH games — which **IS the ARCHIVE
    ENTRY** since the finalization (`PuzzleDate` is a button to `pathForArchive`; "tap
    the day to change the day", the ▾ tick carries the affordance; the standalone
    calendar icon is deleted; Word mode joined the same day its clock moved down under
    the word) — or a screen's title chip.
  - **CENTER, the SEGMENTED MODE SWITCHER** (`components/ModeTabs`): both dailies,
    active one in the inverted selection box — and WEIGHT is the state (430 resting,
    700 in the box; the mono's fixed advance means the swap moves nothing). The band's
    whole hierarchy is weight: titles/date 500, tabs 430/700, the FR + `?` pair one
    quiet 480 at one 12px size — retiring the /mode chooser round-trip
    for the app's most frequent navigation (and fixing what killed the 2026-08-06
    toggle: these tabs show BOTH modes and mark the current one). The route builds it
    so it owns where a tap lands: the game routes to the other mode's today, the
    ARCHIVE to the other mode's calendar. A third daily is one more segment.
  - **RIGHT**: the language CODE chip (`FR`/`EN`, `LangButton` — two mono letters, no
    fill, replacing the languages glyph; still the one gesture onto /select) then the
    screen's contextual controls (help `?`, skip, close). **The logo LEFT the header**
    with the /mode chooser it opened — brand lives on the frame rail and the hero
    screens. **The LEADERBOARD, when it lands, enters from the solved screen's standing
    line, NOT from here** (recorded so the bar stays this small).
  Word mode's top reserve is 66px and the archive's 70px, clearing the band.
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
  the percentage now speaks only through the run ruler's colours at the end of the round),
  Word mode's is its live score. The date is `dateForDayNumber(dayNumber)`, the same
  `2026-08-16` spelling the card, the OG title, the shared text and the archive URL use, so
  an archived day reads as the day it is from the moment it loads. CHROME, not a stat:
  `.topbar-title`'s muted weight and none of the counter's live colour, and sized against
  the corner's REAL budget, which four glyphs never tested — ten glyphs plus the group's
  padding have to clear the four 38px controls opposite, which is what the 10px/no-tracking
  step at ≤640px is for (measured 320/360/390/430). Word mode's cross failure row stays with
  its play controls, directly above the keyboard. Both left and right groups are children of
  the actual `<header>`; game bodies never render a separate fixed header half. The
  full-width progress BAR is gone — and since 2026-08-16 so is the number that replaced
  it. **RIGHT is the one action
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
  that word (the rule the route map it replaced established). (The retired leaderboard
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
- **The CHOOSER screen (language, 2026-07-06; the MODE chooser was RETIRED 2026-08-18
  for the header's segmented tabs — `/mode` parses as an unknown path now, and
  `screens/ModeSelect` + `components/ModeButton` are deleted):** the app asks "which
  language do you want to play?" at `/select`, reached from the header's language chip —
  a ROUTE, never a modal, sitting ABOVE `/<lang>` since it is not language-scoped.
  `components/Chooser.tsx` holds the shell, the member card and the status strip;
  `screens/LanguageSelect.tsx` supplies the options (built as ONE reusable pair when two
  choosers existed, and kept that shape — a future chooser screen reuses it rather than
  copying it).
  Headed by the **logo** (the user-drawn SVG mark since 2026-08-18, cobalt with its aura
  glow — language-neutral, and the app's ONE in-app branding spot), NOT a "select
  language" title (the cards self-explain, and a title would have to guess the user's
  language on the one screen where it is unknown). One MEMBER CARD per language (see the
  instrument bullet above): the language's **native** name (`LANGS[].native`; never
  translated) bold left, its code tag under it, the LED mosaic right. Today's status is
  the thin **strip on the card's bottom edge** — absent = not started, partial =
  progress on the ramp, full = solved / done for the day (the solve cobalt); the card's
  aria-label speaks it. **A language card lands in the last-played MODE** and reads that
  mode's status — the day the tap actually opens.
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
    bare `?` TEXT glyph — `.help-chip`, the lang chip's sibling — and question.svg is
    deleted; languages.svg left with the FR chip) are **LUCIDE
    icons** (ISC; user-picked the same day) restated in the repo's own dress as the
    **`.ui-icon` stroke set** — `viewBox="0 0 24 24"`, `fill="none"`,
    `stroke="currentColor"`, `stroke-width="1.8"` (Lucide's 2 thinned to match the
    hairline chrome), **SQUARE caps and MITER joins** (user-decided 2026-08-18 — the
    round defaults read "goofy" against the sharp chrome; the calendar's rect lost its
    rx, the circled ? became a bare sharp ?, fast-forward became double chevrons),
    in-file `width`/`height` (28px, sized against the 32px pixel mark beside them). A
    new chrome icon starts from the Lucide glyph of that name, squared off the same
    way. PIXEL icons
    survive only on the PLAY surface: the on-screen keyboard's enter/back glyphs —
    orthogonal pixel art (integer grid, no diagonals, the 2026-07-08 rules), sized by
    `.kb-icon` in CSS (`height: 30%`) because the keys shrink on narrow phones. The
    standalone `.pixel-icon` class and the 3×-viewBox sizing rule left with their last
    chrome consumer; an icon's size stays IN its `.svg`, one source of truth.
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
  not pin the in-flight promise and kill the checker for the session) on BOTH
  `visibilitychange` flips plus an hourly backstop interval and calls `location.reload()`
  on mismatch — but ONLY at a flip or while hidden, never mid-play in a visible tab: a
  mismatch found while visible waits for the next flip. Every failure is silent (offline
  just retries on the next trigger). A reload is lossless: round state is persisted,
  index.html is no-cache, and deploys invalidate `/*`. The choreography is
  contract-tested (`versionCheck.test.ts`).
