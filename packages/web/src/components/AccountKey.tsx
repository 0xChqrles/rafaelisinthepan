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
import { useOwnFace } from './AccountFace';
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
  const face = useOwnFace();
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
        <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={26} />
      ) : (
        <span className="account-key-slot skeleton" aria-hidden="true" />
      )}
    </button>
  );
}
