import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';

const TYPE_MS = 18;
const CURSOR_HOLD_MS = 140;
const HIDDEN: CSSProperties = { visibility: 'hidden' };

// The citation types as ONE run of characters across its lines, so the deadline the solved
// stage holds behind the completion signal is derived from the same numbers the typewriter
// runs on (see SolvedScreen's timeline).
export function captionDurationMs(source: Source | undefined, lang: string): number {
  const chars = sourceLines(source, lang).reduce((n, line) => n + Array.from(line.text).length, 0);
  return chars * TYPE_MS + CURSOR_HOLD_MS;
}

// The source as a CREDIT BLOCK (user-decided 2026-08-15, third pass — the shape is the
// user's own): TWO lines, the work over one qualifying line that carries everything else.
//
//     Les Misérables            the WORK — the credit's headline: gold, the biggest
//                               type in the block
//     BOOK by Victor Hugo       what it IS and who made it: muted, small, one phrase
//
// The two earlier cuts stacked the three fields as three peer lines (and before them a
// `— Author, Work` run-on), which left the reader guessing which name was a person: a
// separator only ever says "these are two things", never which is which. Here the LINE
// ITSELF is the answer — one thing is named, and the line under it says what that thing is
// and who it is by, as a phrase you read rather than a list you decode. The function word
// (`sourceBy`) is what binds them, earning its place the way `OF` does in `RANK #5 OF 59`,
// and gold-over-muted ranks them so the eye lands on the title first.
//
// Every field is independently optional in the schema (#5), so the HEADLINE is simply the
// first of work / author / kind that exists and the qualifier is whatever is left: an
// author with no work takes the headline (a lone name is not a credit to anything, and
// `by Victor Hugo` under nothing is a sentence missing its subject), and a source with
// only a kind is just that word.
interface CaptionLine {
  className: string;
  text: string;
}

function sourceLines(source: Source | undefined, lang: string): CaptionLine[] {
  const kind = source?.kind ? source.kind.toLocaleUpperCase(lang) : '';
  const headline = source?.work || source?.author || kind;
  if (!headline) return [];

  // Whatever the headline did not take, as one phrase. The author joins it only when the
  // WORK is the headline — otherwise the author IS the headline.
  const byline =
    source?.work && source?.author ? `${t(lang, 'sourceBy')} ${source.author}` : '';
  const qualifier = [headline === kind ? '' : kind, byline].filter(Boolean).join(' ');

  return [
    { className: 'solved-work', text: headline },
    ...(qualifier ? [{ className: 'solved-by', text: qualifier }] : []),
  ];
}

function typedLine(chars: string[], shown: number, cursor: boolean) {
  return (
    <>
      {chars.map((char, index) => {
        const visible = index < shown;
        const cursorHere = cursor && index === shown;
        return (
          // Static display metadata: its character index is a stable identity.
          // eslint-disable-next-line react/no-array-index-key
          <span key={index} className={cursorHere ? 'source-type-slot' : undefined}>
            <span style={visible ? undefined : HIDDEN}>{char}</span>
            {cursorHere && <span className="source-type-cursor">_</span>}
          </span>
        );
      })}
      {cursor && shown >= chars.length && <span className="source-type-cursor">_</span>}
    </>
  );
}

// The solved sentence's attribution (issue #8), typed under the words it belongs to — the
// optional literary metadata (#5) as a three-line credit block: the KIND tag over the
// AUTHOR over the WORK. Every final character is present but hidden from frame one so line
// wrapping is stable; the underscore occupies the next character's reserved slot.
// Rehydrated solves render the complete source immediately.
//
// (The `masked` veil died with the 2026-08-14 redesign: the caption used to be MOUNTED for
// the whole round to reserve the prompt zone's height, which is what put the author of an
// unsolved sentence one DevTools panel away. It now mounts only WITH the solved stage, so
// there is no unsolved DOM for the citation to leak into.)
export default function SolvedCaption({
  source,
  lang,
  animate = false,
  onComplete,
}: {
  source?: Source;
  lang: string; // the credit's one function word is chrome, so it is localized
  animate?: boolean;
  onComplete?: () => void;
}) {
  // One running character counter across the whole block: each line knows where it starts
  // in that run, so the cursor walks from line to line without any per-line scheduling.
  const lines = useMemo(() => {
    let start = 0;
    return sourceLines(source, lang).map((line) => {
      const chars = Array.from(line.text);
      const entry = { chars, start, className: line.className };
      start += chars.length;
      return entry;
    });
  }, [source, lang]);
  const total = lines.reduce((n, line) => n + line.chars.length, 0);
  const reduceMotion = prefersReducedMotion();
  const [shown, setShown] = useState(() => (animate && !reduceMotion ? 0 : total));

  // Rewind DURING render, not in the effect below: `animate` turns on in the same commit
  // that unhides the caption, and an effect runs after that commit has been painted — so
  // the whole citation would flash complete for a frame before the typewriter took it back
  // to zero (and its finished-typing timer would fire spuriously in between).
  const [wasAnimating, setWasAnimating] = useState(animate);
  if (animate !== wasAnimating) {
    setWasAnimating(animate);
    setShown(animate && !reduceMotion ? 0 : total);
  }

  useEffect(() => {
    if (!animate) {
      setShown(total);
      return undefined;
    }
    if (reduceMotion || total === 0) {
      setShown(total);
      // A TIMER, not a frame (2026-08-03). This branch is the WHOLE completion signal for a
      // source-less puzzle (`total === 0` — `source` is optional in the schema) and for every
      // reduced-motion player: no interval runs, so this one callback is what ends the source
      // beat. A frame is the weaker guarantee of the two — `requestAnimationFrame` does not run
      // while the document is HIDDEN (a hidden document gets no rendering opportunity), where a
      // timer is merely throttled. So a player who solves and immediately locks the phone or
      // switches apps leaves the beat unfinished for as long as they are away, and any path
      // that drops the pending frame outright leaves it unfinished for good — with the result
      // stack fully pressable and only the holes locked, which is the report this came from.
      // The deferral only has to leave this commit, never to land on a paint, so the frame was
      // buying nothing in exchange for that exposure. Whether a lost frame is what the reporter
      // actually hit was NOT reproduced; the solved stage's own deadline is what guarantees the
      // outcome either way. This just removes the one link in the chain that needed the page to
      // be on screen.
      const id = window.setTimeout(() => onComplete?.(), 0);
      return () => window.clearTimeout(id);
    }

    setShown(0);
    const id = window.setInterval(() => {
      setShown((current) => {
        if (current >= total - 1) {
          window.clearInterval(id);
          return total;
        }
        return current + 1;
      });
    }, TYPE_MS);
    return () => window.clearInterval(id);
  }, [animate, onComplete, reduceMotion, total]);

  useEffect(() => {
    if (!animate || reduceMotion || total === 0 || shown < total) return undefined;
    const id = window.setTimeout(() => onComplete?.(), CURSOR_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [animate, onComplete, reduceMotion, shown, total]);

  const visible = animate ? shown : total;
  const showCursor = animate && !reduceMotion && total > 0;
  // The cursor sits on the line being typed — and, once the run is over, at the end of the
  // last one, where it blinks out its hold.
  const typing = lines.findIndex((line) => visible < line.start + line.chars.length);
  const cursorLine = showCursor ? (typing === -1 ? lines.length - 1 : typing) : -1;
  const accessibleText = sourceLines(source, lang)
    .map((line) => line.text)
    .join('. ');

  return (
    <div className="solved-caption">
      {animate && accessibleText && <span className="sr-only">{accessibleText}</span>}
      {lines.map((line, index) => {
        const chars = line.chars;
        const lineShown = Math.min(Math.max(0, visible - line.start), chars.length);
        return (
          <p
            // The lines are static display metadata in a fixed order.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className={line.className}
            aria-hidden={animate || undefined}
          >
            {typedLine(chars, lineShown, cursorLine === index)}
          </p>
        );
      })}
    </div>
  );
}
