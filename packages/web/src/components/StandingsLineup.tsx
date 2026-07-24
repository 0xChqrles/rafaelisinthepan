import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BenchmarkResults } from '@whippin/shared';
import type { LineupModel } from '../game/benchmark';
import { lineupModel, lineupEvents } from '../game/benchmark';
import { t } from '../i18n';
import playerIdleSheet from '../assets/characters/player-idle.png';
import gptIdleSheet from '../assets/characters/gpt-idle.png';
import fableSprite from '../assets/characters/fable.png';
import kimiSprite from '../assets/characters/kimi.png';
import gptSprite from '../assets/characters/gpt.png';
import {
  BOT_KEYS,
  CHARACTER_PALETTES,
  TELEPORT_FRAMES,
  TELEPORT_FRAME_W,
  preloadTeleportStrips,
  teleportSharedUrl,
  teleportStrip,
} from './teleportStrips';
import type { CharacterKey } from './teleportStrips';

// One pixel character per canonical display slot (same order as DISPLAY_MODEL_IDS): an
// opponent wears the sprite of its position in that fixed order, whatever subset is present.
// TEMPORARY art (assets/characters/*.png) — hand-drawn 22x32 drafts.
const BOT_SPRITES = [fableSprite, kimiSprite, gptSprite] as const;

// Identity colors, one per display slot (same order as BOT_SPRITES). The name under a
// character wears its color, echoing the colored accents drawn INTO that sprite's art
// (currently the eyes; the outlines are white) — the hexes live in CHARACTER_PALETTES
// (teleportStrips.ts, the base tones), the ONE palette source shared with the teleport
// recolor; keep THAT in sync with the art's accent pixels when the sprites change.
// SATURATED like the rest of the palette (electric accent/danger/gold/heat ramp), each
// offset from the semantic hues (heat crimson/orange/violet/cyan, hole gold, accent
// blue) so a name can't be misread as feedback. The player wears the game's accent blue
// (the prompt/progress "blue = you"; the CSS var equals the palette's player base).
const BOT_COLORS = BOT_KEYS.map((k) => CHARACTER_PALETTES[k].base);
const PLAYER_COLOR = 'var(--accent)';

// Teleport swap choreography (frames in teleportStrips.ts): one shared tick clock walks
// out (5) -> shared flash (2) -> in (2) at FRAME_MS per frame. The standings SWAP is
// VISIBLE (decided 2026-07-24): at the end of the dissolve — the characters collapsed
// into spheres — every slot takes its new position and slides across in exactly the
// shared-flash beat (SWAP_MS, fed to the CSS transition), so the exchange reads as the
// two orbs quickly trading places before they materialize.
const FRAME_MS = 90;
const SWAP_TICK = TELEPORT_FRAMES.out;
const SWAP_MS = TELEPORT_FRAMES.shared * FRAME_MS;
const IN_TICK = SWAP_TICK + TELEPORT_FRAMES.shared;
const TOTAL_TICKS = IN_TICK + TELEPORT_FRAMES.in;

interface TeleportState {
  tick: number;
  heldOrder: Map<string, number>; // pre-swap slot index per entrant key, until commit
  heldTries: Map<string, number | null>; // pre-swap counts, shown until the teleport ends
  moved: Set<string>; // the entrant keys that change position (they play the frames)
}

const characterKey = (entrant: { player: boolean; sprite: number }): CharacterKey =>
  entrant.player ? 'player' : BOT_KEYS[entrant.sprite];

// Idle spritesheets, per character: drawn frames CSS-stepped at 100ms each. The sheet
// URL lives here; the frame geometry/count lives in the matching `.lineup-idle.<key>`
// CSS class (player: 8 x 22x31; gpt: 4 x 32x32) — keep the two in sync when a sheet
// changes. A character without a sheet stands as its static <img> draft.
const IDLE_SHEETS: Partial<Record<CharacterKey, string>> = {
  player: playerIdleSheet,
  gpt: gptIdleSheet,
};

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A teleport only starts with every mover's recolored strips in hand (they preload on
// mount, so this only fails in the first instants or after a load error) — otherwise
// the swap keeps the plain slide.
function canTeleport(model: LineupModel, moved: Set<string>): boolean {
  return model.entrants.every(
    (e) =>
      !moved.has(e.key) ||
      (teleportStrip(characterKey(e), 'out') !== null &&
        teleportStrip(characterKey(e), 'in') !== null),
  );
}

// Frames of one slot's EXIT (#110): its own recolored dissolve, then the neutral flash —
// and nothing materializes after it. Slot i starts one tick after slot i-1 (left to
// right), so the finished field beams out as a quick wave, keyboard already gone below.
const EXIT_FRAMES = TELEPORT_FRAMES.out + TELEPORT_FRAMES.shared;

// Standings lineup (#81/#110): the player and the present display opponents (1..3 of
// FABLE / KIMI K3 / GPT-5.6) standing side by side above the keyboard, sorted by tries
// ascending (best far left), name + score
// under each. Purely derived UI: everything is a
// function of (guessCount, benchmark), so a reloaded round reconstructs it with no state.
// On solve the lineup does NOT persist (#110, decided 2026-07-24): once the keyboard has
// dropped, `exiting` beams every character out (a one-tick stagger apart), `onExited`
// fires, and Game replaces the whole thing with the leaderboard table in the results.
// A tie shows as a human win: lineupModel stands the player ahead of an equal-score model.
//
// DOM order is stable (React keys move the same nodes on a reorder), and each slot's
// position is its sorted index driving a translateX — so a standings change is a slide
// exchange, not a remount. Decorative throughout (aria-hidden): the meaningful events are
// mirrored into the game's polite live region by Round.
export default function StandingsLineup({
  benchmark,
  guessCount,
  solved,
  lang,
  exiting = false,
  onExited,
}: {
  benchmark: BenchmarkResults;
  guessCount: number;
  solved: boolean;
  lang: string;
  // The solved exit (#110), owned by Game: `exiting` starts the staggered teleport-out;
  // onExited reports the last character gone (immediately under reduced motion or with
  // strips missing), after which Game unmounts the lineup for good.
  exiting?: boolean;
  onExited?: () => void;
}) {
  const model = useMemo(
    () => lineupModel(benchmark, guessCount, t(lang, 'you')),
    [benchmark, guessCount, lang],
  );

  // The mid-game loss beat: when the player loses first place, shake the player sprite
  // (the game's existing hit vocabulary). Detected by diffing consecutive lineup
  // states; the counter keys the animated node so the animation replays on each beat
  // (the lead can only be lost once per round, but a dev-tools time traveler is safe).
  const [lossBeat, setLossBeat] = useState(0);
  const [teleport, setTeleport] = useState<TeleportState | null>(null);
  const [prevModel, setPrevModel] = useState(model);
  useEffect(() => {
    preloadTeleportStrips();
  }, []);
  // Diffed DURING render (React's derived-state pattern), NOT in an effect: setState
  // here makes React re-render before committing, so the reordered positions NEVER
  // reach the DOM pre-teleport. Any effect — even a layout one — runs after the commit,
  // and a style recalc forced between the two commits (the submit path measures layout)
  // would seed the slot transition from the NEW order and visibly slide it back.
  if (model !== prevModel) {
    setPrevModel(model);
    const events = lineupEvents(prevModel, model);
    // A standings change teleports the movers instead of sliding them. Reduced motion
    // (or missing strips) skips it — the slide plays, itself collapsed to an instant
    // jump by the global reduced-motion rule. A reorder landing mid-teleport restarts
    // the clock from the newest committed order (rare: it takes two counted tries
    // within ~a second).
    const prevIndex = new Map(prevModel.entrants.map((e, i) => [e.key, i]));
    const moved = new Set(
      model.entrants
        .filter((e, i) => prevIndex.has(e.key) && prevIndex.get(e.key) !== i)
        .map((e) => e.key),
    );
    const teleports =
      moved.size > 0 && !prefersReducedMotion() && canTeleport(model, moved);
    if (teleports) {
      setTeleport({
        tick: 0,
        heldOrder: prevIndex,
        heldTries: new Map(prevModel.entrants.map((e) => [e.key, e.tries])),
        moved,
      });
    }
    // The loss-beat shake only plays on the slide FALLBACK — a teleport IS the beat,
    // and shaking a dematerializing character would fight its frames.
    if (events.lostLead && !teleports) setLossBeat(lossBeat + 1);
  }
  // The tick clock: one timeout chain, FRAME_MS per frame, cleared on unmount/restart.
  useEffect(() => {
    if (!teleport) return;
    const id = setTimeout(
      () =>
        setTeleport((cur) =>
          cur && cur.tick + 1 < TOTAL_TICKS ? { ...cur, tick: cur.tick + 1 } : null,
        ),
      FRAME_MS,
    );
    return () => clearTimeout(id);
  }, [teleport]);

  // ---- Solved exit (#110): one shared tick clock, slot i entering the wave at tick i.
  const [exitTick, setExitTick] = useState<number | null>(null);
  const onExitedRef = useRef(onExited);
  useEffect(() => {
    onExitedRef.current = onExited;
  });
  const exitTotalTicks = model.entrants.length - 1 + EXIT_FRAMES;
  useEffect(() => {
    if (!exiting) {
      setExitTick(null);
      return;
    }
    // No motion (or a strip missing): the characters simply go with the unmount.
    if (
      prefersReducedMotion() ||
      !model.entrants.every((e) => teleportStrip(characterKey(e), 'out') !== null)
    ) {
      onExitedRef.current?.();
      return;
    }
    setTeleport(null); // the exit preempts any in-flight swap clock
    setExitTick(0);
    // model is frozen once solved (the exit only starts after the final reorder), so
    // `exiting` alone drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting]);
  useEffect(() => {
    if (exitTick === null) return undefined;
    if (exitTick >= exitTotalTicks) {
      onExitedRef.current?.();
      return undefined;
    }
    const id = setTimeout(
      () => setExitTick((cur) => (cur === null ? null : cur + 1)),
      FRAME_MS,
    );
    return () => clearTimeout(id);
  }, [exitTick, exitTotalTicks]);

  return (
    <div className="lineup" aria-hidden="true">
      {/* --n = total entrants (player + present display opponents, 2..4): slot widths
          divide the track by it, so the row stays edge-to-edge for any subset. */}
      <div
        className={`lineup-track${teleport ? ' lineup-teleporting' : ''}`}
        style={
          { '--n': model.entrants.length, '--swap-ms': `${SWAP_MS}ms` } as CSSProperties
        }
      >
        {model.entrants.map((entrant, index) => {
          // A character with an idle sheet stands ANIMATED (CSS-stepped frames); the
          // others keep their static draft <img>s until their own sheets exist.
          const idleSheet = IDLE_SHEETS[characterKey(entrant)];
          // Until the swap tick, a mid-teleport lineup keeps rendering the PRE-swap
          // positions; at the swap every slot takes its new index and the fast
          // teleporting transition (SWAP_MS) slides it across during the shared flash.
          const slotIndex =
            teleport && teleport.tick < SWAP_TICK
              ? (teleport.heldOrder.get(entrant.key) ?? index)
              : index;
          // Solved exit (#110): this slot's position in the departure wave. Before its
          // turn it stands idle; through EXIT_FRAMES it dissolves + flashes; past them
          // it is gone (nothing renders, tag and score hidden via the slot class).
          const exitLocal = exitTick === null ? null : exitTick - index;
          const exitStarted = exitLocal !== null && exitLocal >= 0;
          const exitDone = exitLocal !== null && exitLocal >= EXIT_FRAMES;
          // A moving entrant swaps its idle sprite for the strip frame of the current
          // tick: its own recolored out/in frames around the neutral shared flash. An
          // exit in progress owns the frames instead (its start cleared the swap clock).
          let effect: { src: string | null; frame: number } | null = null;
          if (exitStarted && !exitDone) {
            effect =
              exitLocal < TELEPORT_FRAMES.out
                ? { src: teleportStrip(characterKey(entrant), 'out'), frame: exitLocal }
                : { src: teleportSharedUrl, frame: exitLocal - TELEPORT_FRAMES.out };
          } else if (!exitStarted && teleport?.moved.has(entrant.key)) {
            const { tick } = teleport;
            effect =
              tick < SWAP_TICK
                ? { src: teleportStrip(characterKey(entrant), 'out'), frame: tick }
                : tick < IN_TICK
                  ? { src: teleportSharedUrl, frame: tick - SWAP_TICK }
                  : { src: teleportStrip(characterKey(entrant), 'in'), frame: tick - IN_TICK };
          }
          // The count that triggered the teleport lands only AFTER it: every slot keeps
          // its pre-swap tries for the whole animation, and the release replays the
          // score pop (the span is keyed by value) as the landing beat.
          const shownTries = teleport
            ? (teleport.heldTries.get(entrant.key) ?? entrant.tries)
            : entrant.tries;
          return (
            <div
              key={entrant.key}
              className={`lineup-slot${exitStarted ? ' exiting' : ''}`}
              style={
                {
                  '--i': slotIndex,
                  // The slot's identity color: the name below wears it, matching the
                  // outline baked into the character's hand-drawn art.
                  '--slot-color': entrant.player ? PLAYER_COLOR : BOT_COLORS[entrant.sprite],
                } as CSSProperties
              }
            >
              {/* Identity-colored name ABOVE the character;
                  the live try count keeps its own line below the sprite (mobile-first: a
                  slot is only a quarter of the row, so they never fight for width). A
                  teleporting character travels NAMELESS: its tag vanishes with the first
                  dissolve frame and snaps back — no animation — when the trip ends. */}
              <span className={`lineup-tag${effect ? ' teleporting' : ''}`}>
                {entrant.tag}
              </span>
              <span
                key={entrant.player ? `sprite-${lossBeat}` : 'sprite'}
                className={`lineup-sprite${
                  entrant.player && lossBeat > 0 && !solved ? ' hit' : ''
                }`}
              >
                {effect ? (
                  <span
                    className="lineup-effect"
                    style={{
                      backgroundImage: `url(${effect.src})`,
                      backgroundPositionX: `${-effect.frame * TELEPORT_FRAME_W}px`,
                    }}
                  />
                ) : exitDone ? null : idleSheet ? (
                  <span
                    className={`lineup-idle ${characterKey(entrant)}`}
                    style={{ backgroundImage: `url(${idleSheet})` }}
                  />
                ) : (
                  <img src={BOT_SPRITES[entrant.sprite]} alt="" aria-hidden />
                )}
              </span>
              {/* Keyed by value: a changed count (the player's, on each counted try)
                  remounts the span and replays the landing pop. */}
              <span
                key={`score-${shownTries}`}
                className={`lineup-score${shownTries === null ? ' dnf' : ''}`}
              >
                {shownTries ?? t(lang, 'dnf')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
