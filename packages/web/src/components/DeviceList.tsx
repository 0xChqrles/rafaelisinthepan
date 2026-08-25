// The account's devices, and the way to sign one out (#216).
//
// This is the surface the whole issue exists for: **signing a device out has to be possible
// WITHOUT holding that device.** The server keeps one item per device keyed by the hash of
// its token, so deleting that item is the whole revocation — the device's next authenticated
// call gets `unknown_device` and shows its own screen.
//
// It lives on the profile editor because that screen IS the identity screen: it is where a
// player's name and mark are, it is reached from the leaderboard's EDIT chip, and an account
// with no devices list would leave #216 with no reachable flow at all.
//
// The list comes off a GSI and is eventually consistent, so the route corrects it from what
// the request itself knows — a device that was just created is listed, and one that was just
// revoked is not. Nothing here has to compensate for the lag.

import { useCallback, useEffect, useState } from 'react';
import {
  devicesUrl,
  parseDeviceIdentity,
  postDevicesBody,
  type DeviceListing,
  type DeviceRow,
} from '../api';
import {
  currentRequestIdentity,
  identityEpoch,
  markDeviceSignedOut,
} from '../identity';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { t } from '../i18n';
import LoadingWave from './LoadingWave';

type Phase = 'loading' | 'ready' | 'failed';

// "iPhone / Safari". Every field may be empty — the parser leaves what it cannot read blank
// rather than guessing — so the label is whatever the server DID recognise, and a device it
// recognised nothing about is named as such instead of rendering an empty row.
//
// It takes the three FIELDS rather than a `DeviceRow`, because the row is not the only
// thing carrying them: a word run's stamp names its device the same way (#217), and the one
// spelling of the label is what keeps the run's warning reading like the device list it
// refers to.
export function deviceLabel(row: { device: string; os: string; browser: string }, lang: string): string {
  const parts = [row.device || row.os, row.browser].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : t(lang, 'deviceUnknown');
}

function lastUsed(row: DeviceRow, lang: string): string | null {
  const at = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(at));
}

// The route's answer is authoritative: the top-level deviceId names the caller and the
// rows are the list after the write. Their conjunction is what distinguishes a confirmed
// self-revocation from signing out some other row (or a delete that removed nothing).
export function revokedCallingDevice(listing: DeviceListing, target: string): boolean {
  return (
    listing.deviceId === target && !listing.devices.some((row) => row.deviceId === target)
  );
}

export default function DeviceList({ lang }: { lang: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<DeviceRow[]>([]);
  // Which row's SIGN OUT is in flight, so the list can disable it without a spinner.
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // ONE call answers both the read and every write: the route always returns the list as it
  // now stands, so the screen never has to guess what a write did (the /friends house rule).
  const talk = useCallback(
    async (revoke?: DeviceRow): Promise<{ listing: DeviceListing; epoch: string } | null> => {
      // Never a bootstrap (#216 trigger rework): this list is mounted only when an account
      // exists (the profile editor gates it), and a device list is nothing an account
      // should be created FOR.
      const request = currentRequestIdentity();
      if (!request) return null;
      const { identity, epoch } = request;
      const response = await postDevicesBody(devicesUrl(), {
        token: identity.token,
        ...(revoke ? { revoke: revoke.deviceId, revokeKey: revoke.revokeKey } : {}),
      });
      if (identityEpoch() !== epoch) return null;
      if (!response.ok) {
        // A different device may have revoked this one before the call. The refusal's CODE
        // is authoritative (`adoptSignedOutVerdict` — the one spelling), but only for the
        // epoch that sent it.
        if (await adoptSignedOutVerdict(response, epoch)) return null;
        throw new Error(`devices answered ${response.status}`);
      }
      const listing = parseDeviceIdentity(await response.json());
      if (identityEpoch() !== epoch) return null;
      return { listing, epoch };
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    void talk()
      .then((answer) => {
        if (cancelled) return;
        if (answer) {
          setRows(answer.listing.devices);
          setPhase('ready');
        } else {
          // `talk` resolves null when the identity was dropped or replaced under the
          // call (a sibling tab's START FRESH in the same tick, a sign-out mid-flight).
          // Usually another surface takes over — the signed-out screen, a scope
          // remount — but a load left on its wave FOREVER is the one outcome worse than
          // a retry the player never needs: say FAILED, and keep the retry.
          setPhase('failed');
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [talk, attempt]);

  const signOut = (row: DeviceRow) => {
    setBusy(row.deviceId);
    void talk(row)
      .then((answer) => {
        if (!answer || identityEpoch() !== answer.epoch) return;
        // A successful self-delete cannot wait for "the next 401": there may be no next
        // private request, and the profile would remain open as a device the server has
        // already revoked. This successful response is the second authoritative sign-out
        // signal, alongside `unknown_device`.
        if (revokedCallingDevice(answer.listing, row.deviceId)) {
          markDeviceSignedOut(answer.epoch);
          return;
        }
        setRows(answer.listing.devices);
      })
      // A failed revocation leaves the list as it was; the row is still there to try again.
      .catch(() => {})
      .finally(() => setBusy(null));
  };

  return (
    <section className="device-list">
      <h2 className="device-list-title">{t(lang, 'devicesTitle')}</h2>
      {phase === 'loading' && (
        <p className="status">
          <LoadingWave text={t(lang, 'loading')} />
        </p>
      )}
      {phase === 'failed' && (
        <p className="status error">
          {t(lang, 'failedDevices')}{' '}
          <button type="button" className="device-retry" onClick={() => setAttempt((n) => n + 1)}>
            {t(lang, 'retry')}
          </button>
        </p>
      )}
      {phase === 'ready' &&
        rows.map((row) => {
          const used = lastUsed(row, lang);
          return (
            <div className={`device-row${row.current ? ' current' : ''}`} key={row.deviceId}>
              <span className="device-name">
                {deviceLabel(row, lang)}
                {row.current && <span className="device-here">{t(lang, 'deviceCurrent')}</span>}
              </span>
              {used !== null && <span className="device-seen">{used}</span>}
              <button
                type="button"
                className="device-signout"
                disabled={busy !== null}
                onClick={() => signOut(row)}
              >
                {t(lang, 'deviceSignOut')}
              </button>
            </div>
          );
        })}
    </section>
  );
}
