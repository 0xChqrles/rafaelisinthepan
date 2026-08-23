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
import { devicesUrl, parseDeviceIdentity, postDevicesBody, type DeviceRow } from '../api';
import { ensureDeviceIdentity, markDeviceSignedOut } from '../identity';
import { t } from '../i18n';
import LoadingWave from './LoadingWave';

type Phase = 'loading' | 'ready' | 'failed';

// "iPhone / Safari". Every field may be empty — the parser leaves what it cannot read blank
// rather than guessing — so the label is whatever the server DID recognise, and a device it
// recognised nothing about is named as such instead of rendering an empty row.
export function deviceLabel(row: DeviceRow, lang: string): string {
  const parts = [row.device || row.os, row.browser].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : t(lang, 'deviceUnknown');
}

function lastUsed(row: DeviceRow, lang: string): string | null {
  const at = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(at));
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
    async (revoke?: string) => {
      const identity = await ensureDeviceIdentity();
      const response = await postDevicesBody(devicesUrl(), { token: identity.token, revoke });
      if (!response.ok) {
        // Signing out the CALLING device is allowed, and its next call is the one that
        // learns so. The screen the app raises for that is the whole answer here too.
        if (response.status === 401) {
          const data = (await response.json().catch(() => ({}))) as { error?: unknown };
          if (data.error === 'unknown_device') markDeviceSignedOut();
        }
        throw new Error(`devices answered ${response.status}`);
      }
      return parseDeviceIdentity(await response.json()).devices;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    void talk()
      .then((devices) => {
        if (!cancelled) {
          setRows(devices);
          setPhase('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [talk, attempt]);

  const signOut = (deviceId: string) => {
    setBusy(deviceId);
    void talk(deviceId)
      .then((devices) => setRows(devices))
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
                onClick={() => signOut(row.deviceId)}
              >
                {t(lang, 'deviceSignOut')}
              </button>
            </div>
          );
        })}
    </section>
  );
}
