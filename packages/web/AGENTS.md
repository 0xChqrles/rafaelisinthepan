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
      game/scoring.ts         s(rank), holeProgress, computeProgress
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
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

- **Route modal (#117, Part 3 of #115):** tapping a HOLE opens its neighborhood drawn as a
  journey. `game/route.ts` is the pure model (`buildRoute`, contract-tested) and
  `components/RouteModal.tsx` renders it; `Game` owns the open state so the guess prompt can
  go inert behind it. **Entry point only where the geometry exists:** `hasRoute` gates on the
  secret's rank-1 entry carrying `dq`, so every day published before #115 renders exactly as
  before — no button, no degraded list view. (The onboarding tutorial used to fall on that
  side too; since #155 it plays on a REAL generated board precisely so its ending can open
  this map.) The hole
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
  content: what was wrong with the first version was the empty space, not the length.) The
  identity leap and the cold end above the first station stay broken traces: neither is a
  distance. **Both are cut to a WHOLE number of the dash unit** (`dashedRun`, fixed 2026-07-27):
  the unit is 5px of line + 8px of nothing, declared once in `RouteModal` and handed to the
  gradient as `--dash` / `--dash-period`, and a run is `n` units PLUS its closing dash. Any other
  height cuts the last unit wherever it falls and the stub lands exactly where the trace meets the
  solid rail — `TAIL_H` 34 ended on 3px of gap against the first station, which reads as a
  rendering slip rather than a broken line. So the heights are DERIVED (34 → 31, 56 → 57), never
  typed. `--route-band-h`,
  the old lane geometry (`stopX`/`labelSide`/`laneNameFont`) and the axis contours are all gone
  with it.
  **The line is TRAVELLED, so it runs departure → arrival DOWN the page** (decided 2026-07-26):
  the off-map words at the top past the torn break, every station reached farthest first, and
  the word itself at the bottom. It **opens with the CLOSEST word you have reached sitting at the
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
  torn break have no node, no lane and no distance, so nothing about them can be read off the
  drawing. The screen-reader mirror still names all four in prose (`srRouteStop`), which is why
  dropping them costs no information. Fixed-width `???` is the ONE token for "you have not found
  this word": the destination and every censored station wear it.
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
  Lane centres live in `RouteModal` (`LANE_X0`/`LANE_GAP`) because the node positions and the
  `--lane-lines` gradient that paints them must agree exactly. Each lane is **as vivid as the
  rest of the app** (decided 2026-07-26, superseding a first muted set — a metro line's whole
  point is telling it from the next one at a glance): `LANE_COLORS` (≤ 4 — `ROAD_KS` caps roads
  there) takes four far-apart hues from the **progress ramp's own stops**
  (`shared/progressColor.ts`) rather than inventing a palette, COPIED not imported, because that
  ramp means "progress" and these mean "identity". Copied means nothing catches drift, so
  `laneColors.test.ts` pins each hex to the stop it was taken from — pink 70, cyan 30, violet 90,
  green 40 (added 2026-07-27 on review; it immediately caught the violet as `#883beb` where its
  stop is `#883ceb`). If a stop is ever retuned the guard fails, and the choice gets made again
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
  The junction **bus is painted in the lanes' colours, split at the trunk** (`busGradient`), not
  in one neutral bar: a single grey bar at each end of a set of parallel lines reads as a frame
  drawn AROUND them.
  Caveat worth keeping in view: on a real fr puzzle 2 of 3 secrets fork into one big road
  plus a 1–2-group outlier, and an empty lane advertises that outlier as a whole road — honest to
  the data, but see the #115 distance-annotations note in `packages/generation/AGENTS.md` —
  a minimum road size is still an open question.
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
  the side facing that skipped ground gets **a torn separator — the same dashes the off-map break
  wears**, since both mean the map does not continue straight through there. Below when parked at
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
  Side effect on the shared input: `WordInput`'s window listener lets a focused BUTTON keep only
  `Enter`, and EVERY editing path in `Game` (`appendChar`, `deleteChar`, `replaceInput`) blurs a
  focused hole button through `releaseHoleFocus`. All three, not just typing: with Backspace and
  history recall leaving it focused, "close the map, fix a typo, press Enter" reopened the map
  instead of submitting (fixed 2026-07-27).
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
  ripples. A wave already in FLIGHT is cut when `ticking` drops, not merely when the hole's own
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
  the shared `TopBar` (decided 2026-07-11):** immediately right of the language flag it is
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
  closed by its header X or Escape, **never by a backdrop tap**, and focus returns to
  SEE MORE. This dialog is the planned home of the deeper result views (#82): per-row
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
  ringed — a solved sentence is something to read, not a prompt to act, and a keyboard user is
  one Tab away. The streak celebration also keeps its **tap-anywhere** dismissal: it is the
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
  prompt and DROPS the keyboard out of the tray (the game's own `kb-drop`), the coach nudges
  the tap **in the input device's own verb** — "tap" on a coarse pointer, "click" otherwise,
  the same `(pointer: coarse)` test as the streak hint (`tutTap`/`tutClick`) — and the word
  runs #129's ambient wave. **The tap REPLACES the word with its route line, INLINE — no
  modal** (decided on findings 2026-08-03, superseding the RouteModal ending built first):
  `RouteLine`, the drawing extracted from `RouteModal` (frame variables + decorative drawing +
  sr mirror, on a `.route-frame` wrapper that now owns the drawing's CSS variables), renders
  in the play area inside its OWN scroller (`.route-inline` — the page must not scroll, since
  the topbar and coach float with no background; `.route-frame` is positioned so the absolute
  sr-only list cannot escape the scroller and grow the page). It opens scrolled to the bottom
  — the word, solved, every road named — the coach box explains the roads (`tutRoutes`), and
  the tray offers **PLAY (`tutPlay`), which is the graduation**: `onDone`, no SolvedScreen (a
  lesson has no score to show, so `SolvedScreen`'s tutorial `action` prop and its null
  `dayNumber` are gone with it). The daily game's `RouteModal` wraps the same `RouteLine` and
  behaves exactly as before.
  **The board's ranks are a REAL generated neighborhood, and have to be:** the route line only
  opens where #115's geometry exists (`hasRoute` gates on the rank-1 group's `dq`), and the
  hand-authored ~22-entry map this replaced carried none. Each language embeds a #154
  single-word artifact (`pnpm gen:word`) PRUNED to the word + the road zone + the guided
  words, by `web/scripts/prune-word-map.mjs` — the exact command is recorded in each script's
  header, and `scripts.test.ts` fails if board and map ever drift. **en = OCEAN, fr = PHARE**,
  both chosen on ROUTE legibility (three well-populated senses each); LIGHTHOUSE was the first
  fr-symmetric en candidate and lost on a 135/15 split, because clarity beats en/fr symmetry.
  **The guided words obey two findings-decided rules (2026-08-03):** the far guess stays on a
  READABLE scale — same order of magnitude as the start word, ≤ 500, guarded by
  `scripts.test.ts` (fr `désert^1183` read as noise; it is `casquette^330` now) — and a mix
  stop's word should be an INTUITIVE neighbor (fr's second stop is `lampadaire^25`, not the
  figurative `pilier^10`). Coach copy must fit the 3-line box at 320px — the routes and
  closer-guess strings were cut to size for it.
  Copy is deliberately terse throughout, no under-the-hood talk. The tutorial is
  **data-driven**:
  the board, guesses and steps live in `web/src/tutorial/scripts/{en,fr}.ts`
  (copy keys in `i18n.ts`) and `tutorial/scripts.test.ts` guards the lesson arc.
  Gated steps use synthetic vocab/prefix sets (the keyboard's existing contract);
  free steps use the real sets. The tutorial writes NOTHING to `rounds`; the store
  `migrate` (v2) grandfathers any blob with prior play state so veterans never see it
  uninvited. Replay via the header `?`; `?tutorial=1` forces it; the dev-only `?streak=`
  preview suppresses the first-visit invitation.
- **App header (decided 2026-07-06; redesigned 2026-07-21 — this bullet was STALE and is
  corrected 2026-07-26 from the code, which is ground truth):** a fixed **topbar**
  (`components/TopBar.tsx`) of **two corner chips and NOTHING else — no band, no border, no
  background, no blur.** Boxes read as floating rectangles over the animated waves, so the
  groups sit DIRECTLY on the backdrop and the glyphs' own `text-shadow` carries legibility.
  Layout is one optical row: `.topbar-inner` = `min(900px, 100vw - 48px)`, 56px, centred.
  **LEFT is the status spot** — a screen's title in `.topbar-title` (ARCHIVE / TUTORIAL, plus
  any inline stat like the tutorial's counter); the game passes nothing there and floats its
  own progress **counter** (`.hud`, the arcade SCORE spot, painted in `progressColor(pct)`)
  instead — the full-width progress BAR is gone, the number and its colour say what the bar
  said. **RIGHT is the one action group** (`.topbar-right`): the language flag, then the
  screen's contextual controls — every one a `.home-btn` (a transparent `--hud-height` square)
  wrapping a `.pixel-icon` SVG, muted → `--fg` on hover/focus. The **streak stat is NOT in the
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
  puts "TUTORIAL" in the left chip and the skip fast-forward in the right group. The flag
  ALWAYS opens the language screen. The
  game header is rendered by **`GameRoute` (App), NOT inside `Game`** (decided
  2026-07-08): it wraps EVERY state of the route — loading / error / missing-puzzle /
  the loaded game — so navigating into a game (e.g. from the archive) never blinks the
  header away; only the body under the fixed header refreshes. `usePuzzle`'s **stable
  `dayNumber`** is still captured ONCE per request (`useMemo` on the requested date) and
  shared by the fetch, round key, and share, but is no longer rendered in the header. An
  undated tab held open across the 22:00 flip therefore still keeps its fetched puzzle/day;
  the puzzle itself does not silently swap. The topbar is the extension point for future
  chrome (streaks, stats, …).
- **Language screen (redesigned 2026-07-06):** headed by the **logo** (blue pixel
  glyph, 3×/2× its native 22px — language-neutral, and the app's ONE in-app branding
  spot), NOT a "select language" title (the cards self-explain, and a title would
  have to guess the user's language on the screen where it is unknown). One **card**
  per language — a full-opacity flag + the language's **native** name
  (`LANGS[].native`; never translated) — in a vertical list that scales to any number
  of languages, with the app's standard brighten-on-hover/press (no dimmed flags).
  The old NEW/%/✓ badges are gone: today's status is a thin **strip on the card's
  bottom edge** — absent = not started, partial = reconstruction % on the progress
  ramp, full **gold** = solved (the solved-word gold). The card's aria-label speaks
  the status.
- **UI chrome is localized + a11y'd (decided 2026-07-06):** `web/src/i18n.ts` holds every
  UI string in **en + fr** (`t(lang, key)`; the `satisfies` clause makes a missing
  translation a type error, so parity needs no test). Game screens resolve strings with
  the **puzzle's** language; the selector (no puzzle) uses the same resolution as the `/`
  redirect. `<html lang>` is kept in sync by App. Guess feedback is mirrored to a
  `.sr-only` polite live region (`srHoleResult`), animations honor
  `prefers-reduced-motion` (durations collapse to ~0 — never `animation: none`, several
  swaps advance on `animationend`; delays are kept so the floating numbers still show),
  and every control has a visible `:focus-visible` outline. **The missing-puzzle screen
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
  PLAY under the route line (#155) / skip (fast-forward or invite SKIP). Plus automatic
  pageviews.

