import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AVATAR_SIZE,
  GROUP_MARKS_SHOWN,
  UI_ADVANCE_EM,
  anonName,
  defaultAvatar,
  orbitPlaces,
  orbitTrail,
  plusLabelSize,
  plusTile,
  type BoardPlayer,
} from '@whippin/shared';
import Avatar from './Avatar';
// The Bayer tiles on the root (`--dz-*`) the holds and the free seat stipple through.
import { SKELETON_WAIT_MS } from './bayerTiles';
import Strike from './Strike';
import { BURST_ART } from './strikeArt';
import { CELL_PX, DROP_MS, SHAKE, SHAKE_FRAME_MS, markAt } from './podium/scene';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';

// THE GROUP CARD, BROUGHT IN (the invite landing's scene, `screens/GroupInvite`): what the
// `/g/<id>` link unfurled into in the chat, continued on the screen it opens onto — the group's
// NAME in the white chip at the middle, its members' MARKS round it on ONE orbit in the slate
// Bayer trail, the rest folded into the card's `+N` checker tile. The placement, the trail and
// the tile are the card's own (`@whippin/shared` `orbitPlaces` / `orbitTrail` / `plusTile`),
// drawn at the screen's size on the house's 2px cell.
//
// THE ORBIT KEEPS A SEAT FOR THE READER: the last place, clockwise from the top — an empty
// mark's box in the floor's stipple. It breathes while their JOIN is out, and their own mark
// DROPS into it when the join lands: the podium's drop (`markAt`, whole cells under gravity),
// its whole-pixel shake, and the strike sheet's burst behind it in the accent. Nothing else on
// the orbit moves: every place is decided once, with the seat in it.
//
// While the group is read its shapes HOLD (`mode: 'wait'`): the chip's box and three marks'
// boxes in the breathing slate, shown only once the read has taken SKELETON_WAIT_MS; a read
// that FAILED leaves them standing still, at half their cells (`mode: 'failed'`).

export type OrbitPlace =
  | { kind: 'member'; member: BoardPlayer }
  | { kind: 'more'; count: number }
  | { kind: 'seat' };

// The places on the orbit, clockwise from the top: the members, then a `+N` tile when they do
// not all fit, then — joinable — the reader's SEAT. The card's own rule (`GROUP_MARKS_SHOWN`
// places), the seat taking one of them.
export function orbitPlacesFor(members: readonly BoardPlayer[], seat: boolean): OrbitPlace[] {
  const room = GROUP_MARKS_SHOWN - (seat ? 1 : 0);
  const more = members.length > room ? members.length - (room - 1) : 0;
  const shown = more > 0 ? members.slice(0, room - 1) : members;
  return [
    ...shown.map((member): OrbitPlace => ({ kind: 'member', member })),
    ...(more > 0 ? [{ kind: 'more', count: more } as const] : []),
    ...(seat ? [{ kind: 'seat' } as const] : []),
  ];
}

// The reader's seat: empty, filling (their JOIN is out, or their mark is not read yet), taken
// by their mark — or closed (a cap answered the JOIN): it goes, its place left empty.
export type SeatState = 'free' | 'filling' | 'taken' | 'closed';

// The scene's geometry off its box: a mark of ten whole pixels a cell (80 on a wide scene, 60
// on a phone, 50 on the narrowest), the orbit as wide as the box holds its tiles and at most a
// quarter taller than wide.
const EDGE = 4;
const HOLD_PLACES = 3;
const NAME_CLEAR = 12; // the least room between the name's chip and a mark
const CHIP_LINE = 32; // `.link-name`'s whole 32px box
const CHIP_PAD = 10; // …and its side padding
const CHIP_TRACKING = 0.03; // …and its tracking, in em
// The hero name's size is the root's `--name-hero-size` (a step down on the narrowest phones),
// read live, so the chip's box and the type set in it come off one number at every width.
function heroPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--name-hero-size')) || 17;
}
function geometry(width: number, height: number) {
  const mark = width >= 600 ? 80 : width < 340 ? 50 : 60;
  const rx = Math.max(0, Math.floor(width / 2 - mark / 2 - EDGE));
  const ry = Math.max(0, Math.min(Math.floor(height / 2 - mark / 2 - EDGE), Math.round(rx * 1.25)));
  return { mark, cx: Math.round(width / 2), cy: Math.round(height / 2), rx, ry };
}

// The `+N` tile on the screen: the card's own (`plusTile`), its count at the card's size for the
// tile (`plusLabelSize`) stepped down to one of the pixel face's whole sizes, on a cut-out set on
// the tile's own cells — the fewest whole cells round the count with a font pixel of air round
// its ink, centred on the tile, and a cell of the checker left either side.
const PIXEL_SIZES = [24, 16, 8];
export function moreTile(count: number, mark: number): string {
  const cell = mark / AVATAR_SIZE;
  const onCells = (length: number) => {
    const cells = Math.ceil(length / cell);
    return (cells + ((AVATAR_SIZE - cells) % 2)) * cell;
  };
  // Across, the count's advance already leaves a font pixel either side of its ink (the `+`
  // opens on one, the last digit closes on one); down, its seven rows of ink take one more.
  const across = (size: number) => `+${count}`.length * size;
  const down = (size: number) => size + size / 8;
  const want = plusLabelSize(count, mark);
  const size = PIXEL_SIZES.find((px) => px <= want && onCells(across(px)) <= mark - 2 * cell) ?? 8;
  return plusTile(0, 0, mark, count, {
    size,
    padX: (onCells(across(size)) - across(size)) / 2,
    padY: (onCells(down(size)) - size) / 2,
    radius: 0,
  });
}

// The drop as keyframes on the podium's own clock (`markAt`): each whole-cell step held to the
// next, nothing eased between them.
function dropFrames(): { frames: Keyframe[]; duration: number } {
  const duration = DROP_MS + SHAKE.length * SHAKE_FRAME_MS;
  const frames: Keyframe[] = [];
  let last = '';
  for (let at = 0; at <= duration; at += 4) {
    const { dx, dy } = markAt({ land: DROP_MS, fall: true }, at);
    const value = `translate(${dx * CELL_PX}px, ${dy * CELL_PX}px)`;
    if (value === last) continue;
    frames.push({ offset: at / duration, transform: value, easing: 'step-end' });
    last = value;
  }
  frames.push({ offset: 1, transform: 'translate(0px, 0px)' });
  return { frames, duration };
}

export default function GroupOrbit({
  lang,
  mode,
  name = '',
  places = [],
  seat = 'free',
  own = null,
  drop = false,
}: {
  lang: string;
  mode: 'wait' | 'failed' | 'shown';
  name?: string;
  places?: readonly OrbitPlace[];
  seat?: SeatState;
  // The reader's own face, for the taken seat.
  own?: BoardPlayer | null;
  // The taken seat was taken on this screen: the mark drops in.
  drop?: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{
    width: number;
    height: number;
    snapX: number;
    snapY: number;
    hero: number;
  } | null>(null);
  // The holds wait out SKELETON_WAIT_MS on the FIRST read only: once they have stood (a read
  // that failed), a retry finds them already there.
  const [read, setRead] = useState(mode !== 'wait');
  if (mode !== 'wait' && !read) setRead(true);

  // The box, and the fraction of a pixel it stands off the screen's grid: the scene is drawn
  // back onto whole pixels, so every mark and every trail cell lands on one.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = {
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
        snapX: Math.round(rect.left) - rect.left,
        snapY: Math.round(rect.top) - rect.top,
        hero: heroPx(),
      };
      setSize((prev) =>
        prev &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.hero === next.hero &&
        Math.abs(prev.snapX - next.snapX) < 0.01 &&
        Math.abs(prev.snapY - next.snapY) < 0.01
          ? prev
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const geo = size ? geometry(size.width, size.height) : null;
  const count = mode === 'shown' ? places.length : HOLD_PLACES;
  const spots = useMemo(
    () => (geo ? orbitPlaces(count, geo.cx, geo.cy, geo.rx, geo.ry, geo.mark) : []),
    [geo?.cx, geo?.cy, geo?.rx, geo?.ry, geo?.mark, count],
  );

  // The name's chip, one line always, its size stepped down a whole pixel at a time from the
  // hero size until it keeps clear of every mark beside it (the card's own rule); its width off
  // the mono's fixed advance at that size, which is set inline, so it stands on whole pixels
  // with nothing measured.
  const chip = useMemo(() => {
    if (!geo || !size) return null;
    const glyphs = Math.max(1, Array.from(name).length);
    let half = geo.cx - EDGE;
    for (const { x, y } of spots) {
      const overlaps = y < geo.cy + CHIP_LINE / 2 + NAME_CLEAR && y + geo.mark > geo.cy - CHIP_LINE / 2 - NAME_CLEAR;
      if (!overlaps) continue;
      const centre = x + geo.mark / 2;
      half = Math.min(half, Math.abs(centre - geo.cx) - geo.mark / 2 - NAME_CLEAR);
    }
    const perGlyph = UI_ADVANCE_EM + CHIP_TRACKING;
    const font = Math.max(10, Math.min(size.hero, Math.floor((2 * half - 2 * CHIP_PAD) / (glyphs * perGlyph))));
    const width = Math.ceil(glyphs * perGlyph * font) + 2 * CHIP_PAD;
    return {
      font,
      width,
      x: Math.round(geo.cx - width / 2),
      y: geo.cy - CHIP_LINE / 2,
    };
  }, [geo?.cx, geo?.cy, geo?.mark, size?.hero, spots, name]);

  const trail = useMemo(() => {
    if (!geo || !size || !chip || mode !== 'shown') return '';
    return orbitTrail({
      width: size.width,
      height: size.height,
      cx: geo.cx,
      cy: geo.cy,
      rx: geo.rx,
      ry: geo.ry,
      cell: 2,
      clear: [
        ...spots.map(({ x, y }) => ({ x, y, w: geo.mark, h: geo.mark })),
        { x: chip.x, y: chip.y, w: chip.width, h: CHIP_LINE },
      ],
    });
  }, [size?.width, size?.height, geo?.cx, geo?.cy, geo?.rx, geo?.ry, geo?.mark, spots, chip, mode]);

  const stage: CSSProperties | undefined = size
    ? { transform: `translate(${size.snapX}px, ${size.snapY}px)` }
    : undefined;

  return (
    <div
      ref={box}
      className="invite-scene"
      aria-busy={mode === 'wait' || undefined}
      style={{ '--hold-wait': `${SKELETON_WAIT_MS}ms` } as CSSProperties}
    >
      {mode === 'wait' && <span className="sr-only">{t(lang, 'loading')}</span>}
      {geo && chip && mode !== 'shown' && (
        <div className={`invite-stage invite-holds${read ? '' : ' first'}`} style={stage} aria-hidden="true">
          <span
            className={`link-name link-hold ${mode === 'wait' ? 'waiting' : 'failed'}`}
            style={{ left: Math.round(geo.cx - 68), top: chip.y, width: 136 }}
          >
            &nbsp;
          </span>
          {spots.map(({ x, y }, k) => (
            <span
              key={k}
              className={`invite-seat link-hold ${mode === 'wait' ? 'waiting' : 'failed'}`}
              style={{ left: x, top: y, width: geo.mark, height: geo.mark }}
            />
          ))}
        </div>
      )}
      {geo && chip && mode === 'shown' && (
        <div className="invite-stage in" style={stage}>
          <svg
            className="invite-trail"
            width={size!.width}
            height={size!.height}
            viewBox={`0 0 ${size!.width} ${size!.height}`}
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            <path d={trail} />
          </svg>
          <h1
            className="link-name invite-name"
            style={{
              left: chip.x,
              top: chip.y,
              width: chip.width,
              fontSize: chip.font,
            }}
          >
            {name}
          </h1>
          <ul className="invite-places" aria-label={t(lang, 'groupMembers')}>
            {places.map((place, k) => {
              const at = spots[k];
              if (!at) return null;
              const style = { left: at.x, top: at.y, width: geo.mark, height: geo.mark };
              if (place.kind === 'member') {
                const { member } = place;
                return (
                  <li key={member.publicId} className="invite-seat" style={style}>
                    <Avatar avatar={member.avatar ?? defaultAvatar(member.publicId)} size={geo.mark} sharp />
                    <span className="sr-only">{member.name || anonName(member.publicId)}</span>
                  </li>
                );
              }
              if (place.kind === 'more') {
                return (
                  <li key="more" className="invite-seat" style={style}>
                    <svg
                      width={geo.mark}
                      height={geo.mark}
                      viewBox={`0 0 ${geo.mark} ${geo.mark}`}
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{ __html: moreTile(place.count, geo.mark) }}
                    />
                    <span className="sr-only">{`+${place.count}`}</span>
                  </li>
                );
              }
              return (
                <li key="seat" className="invite-seat" style={style} aria-hidden={seat !== 'taken' || undefined}>
                  <Seat state={seat} own={own} mark={geo.mark} drop={drop} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// The reader's seat: the empty mark's box in the floor's stipple — breathing while it fills —
// and their mark in it, dropping in when it was taken on this screen.
function Seat({ state, own, mark, drop }: { state: SeatState; own: BoardPlayer | null; mark: number; drop: boolean }) {
  const markRef = useRef<HTMLSpanElement | null>(null);
  const falls = drop && state === 'taken' && own !== null && !prefersReducedMotion();
  useLayoutEffect(() => {
    if (!falls || !markRef.current) return undefined;
    const { frames, duration } = dropFrames();
    const animation = markRef.current.animate(frames, { duration, fill: 'backwards' });
    return () => animation.cancel();
  }, [falls]);

  const free = (
    <span
      className={`invite-free${state === 'filling' || state === 'closed' ? ` ${state}` : ''}${falls ? ' landing' : ''}`}
      style={{ '--land': `${DROP_MS}ms` } as CSSProperties}
    />
  );
  if (state !== 'taken' || own === null) return free;
  const burst = mark >= 80 ? ' x4' : mark < 60 ? ' x2' : '';
  return (
    <>
      {falls && free}
      {falls && (
        <span className={`invite-burst${burst}`} style={{ left: mark / 2, top: mark / 2 }}>
          <Strike id={1} art={BURST_ART} color="var(--accent)" delayMs={DROP_MS} />
        </span>
      )}
      <span ref={markRef} className="invite-own">
        <Avatar avatar={own.avatar ?? defaultAvatar(own.publicId)} size={mark} sharp />
        <span className="sr-only">{own.name || anonName(own.publicId)}</span>
      </span>
    </>
  );
}
