// THE PLAYER'S OWN FACE, as a key in the header (user-decided 2026-08-30).
//
// It is what the freed centre bought, and it closes the gap both reviews landed on: the
// account area had exactly ONE door — the leaderboard's identity strip, two taps behind a
// crown — and the player's mark rendered in six surfaces, none of them in the daily loop.
// The face in the header is a permanent daily presence for the identity AND a one-tap door
// to `/account`, in the same move — and, since the row is the same on every screen, it is
// LIT while the player is anywhere in the account area.
//
// It reveals nothing about server state, which is the invariant this must not break:
// `useOwnFace` answers the account's stored profile or the identical pair derived from the
// persisted local seed, and `localIdentityDeploy` stores exactly that pair as the account's
// first profile — so the face is the same before and after deployment (#216).
//
// It HOLDS ITS BOX until the face settles rather than drawing the assigned mark and
// correcting it a beat later: that is the leaderboard strip's own rule, and it matters more
// here, where the control is on screen every day.
//
// In the header the mark is drawn in the chrome's ONE INK — the traced shape in `--fg`, no
// ground — a glyph among the stroke icons rather than a colour swatch beside them (the CSS
// on `.account-key` holds the reasoning). Full colour is for where the face is content.
import { defaultAvatar } from '@whippin/shared';
import Avatar from './Avatar';
import { faceSettled, shownFace, useOwnFace } from './AccountFace';
import { t } from '../i18n';
import { ACCOUNT_PATH } from '../langs';
import { navigate } from '../routing';

export default function AccountKey({
  lang,
  lit,
  onLeave,
}: {
  lang: string;
  // Standing in the account area: the key lights and goes nowhere.
  lit: boolean;
  onLeave?: () => void;
}) {
  const state = useOwnFace();
  const face = shownFace(state);
  return (
    <button
      type="button"
      className={`home-btn account-key${lit ? ' on' : ''}`}
      aria-label={t(lang, 'accountTitle')}
      aria-current={lit ? 'page' : undefined}
      onClick={() => {
        if (lit) return;
        onLeave?.();
        navigate(ACCOUNT_PATH);
      }}
    >
      {face ? (
        // SHARP, and 20px — the size the CSS has forced since the framed portrait landed
        // (the 26 it was asked for was dead, and a prop that lies about the rendered size
        // is worse than no prop). A cell is 2px, and the corners are square: it is a
        // pixel tile among pixel marks.
        <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={20} sharp />
      ) : (
        // The box, always. It BREATHES only while the read is out: an account that came
        // back GONE (#204) has settled with nothing to draw, and a skeleton over it would
        // promise an arrival that is not coming — the archive cells' rule.
        <span
          className={`account-key-slot${faceSettled(state) ? '' : ' skeleton'}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
