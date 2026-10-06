import { useId, type PointerEvent } from 'react';
import Button from './Button';
// (For its side effect: the root's Bayer tiles the tray comes in through.)
import './bayerTiles';
import { t } from '../i18n';

// THE REVEAL TRAY (#301, user-decided 2026-10-02: "When a hidden word is selected, instead
// of having the keyboard with the 'enter' key only, we shouldn't have the keyboard at all,
// but a 'reveal' button with a caption saying that it will cost one try"): while a picked
// mask stands in the empty prompt — and while it decodes — the tray holds this in the
// keyboard's place: the price, REVEAL (the app's one big-action shape), and BACK under it
// as the quiet word, which un-picks the mask and brings the keyboard back. It fills the
// keyboard's own footprint from the bottom, so nothing above it moves.
//
// The buttons take no focus from a press (`preventDefault` on pointerdown, the keyboard's
// rule): the prompt keeps the caret, so the physical Enter and Backspace — the REVEAL's and
// BACK's twins — keep answering. A keyboard user who tabs here activates them as any button.
export default function RevealTray({
  lang,
  decoding,
  onReveal,
  onBack,
}: {
  lang: string;
  // The reveal is out and the prompt is uncyphering it: nothing left to press.
  decoding: boolean;
  onReveal: () => void;
  onBack: () => void;
}) {
  const costId = useId();
  const keepFocus = (e: PointerEvent<HTMLButtonElement>) => e.preventDefault();
  return (
    <div className="reveal-tray dissolve-in">
      <p id={costId} className="reveal-cost">
        {t(lang, 'revealCost')}
      </p>
      <button
        type="button"
        className="mix-btn"
        aria-describedby={costId}
        disabled={decoding}
        onPointerDown={keepFocus}
        onClick={onReveal}
      >
        {t(lang, 'revealButton')}
      </button>
      <Button variant="secondary" disabled={decoding} onPointerDown={keepFocus} onClick={onBack}>
        {t(lang, 'revealBack')}
      </Button>
    </div>
  );
}
