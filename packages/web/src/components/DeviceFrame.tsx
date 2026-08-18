// THE VIEWPORT AS AN INSTRUMENT (2026-08-18, from the /inspiration/modern board): the
// content floats in the void while the chrome clings to the edges — four corner
// brackets (the board's focused-card selection frame, drawn around the whole app), a
// vertical brand rail, a small sign-off in the bottom-left corner and the day's
// EDITION SERIAL in the bottom-right (`N.<dayNumber>` — the interfaces.dev card's
// numbering, and a real number: the game's own day index).
//
// The sign-off is `MADE WITH <3` (user-picked 2026-08-18, replacing the localized
// tagline — "a daily word game" read flat): universal, so it lives outside the STRINGS
// table like the rarity grades do.
//
// Purely decorative furniture: aria-hidden, pointer-events none, and DESKTOP ONLY (the
// CSS hides it under 641px — a phone's viewport has no room for a frame). It sits under
// the header's z-index, and full-screen dialogs (history, streak) paint over it.
export default function DeviceFrame({ serial }: { serial: number }) {
  return (
    <div className="device-frame" aria-hidden="true">
      <i className="df-bracket df-tl" />
      <i className="df-bracket df-tr" />
      <i className="df-bracket df-bl" />
      <i className="df-bracket df-br" />
      <span className="df-edge">WHIPPIN AI ©2026</span>
      <span className="df-cap df-cap-left">{'MADE WITH <3'}</span>
      <span className="df-cap df-cap-right">{`N.${serial}`}</span>
    </div>
  );
}
