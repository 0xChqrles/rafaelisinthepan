// The account's devices, and the way to sign one out (#216).
//
// This is the surface the whole issue exists for: **signing a device out has to be possible
// WITHOUT holding that device.** The server keeps one item per device keyed by the hash of
// its token, so deleting that item is the whole revocation — the device's next authenticated
// call gets `unknown_device` and shows its own screen.
//
// It lives on `/account`, under the record, once the account is SAVED (an unsaved account can
// only ever hold the device reading the screen). It wears the boards' grammar: LINES on the
// bare ground, no title — each line a pixel GLYPH of the device (a phone, a tablet, a
// computer; in the accent for the one in your hand), its label, ONE quiet fact (THIS ONE, or
// the day it was last seen), and SIGN OUT as a word in the corner brackets of a thing to tap.
// The lines come in through the dither, one after the other, once the record has CALMED — its
// count landed and today's foil link cooled — never under its climax, and never before the
// record has its numbers at all.
//
// The list comes off a GSI and is eventually consistent, so the route corrects it from what
// the request itself knows — a device that was just created is listed, and one that was just
// revoked is not. Nothing here has to compensate for the lag.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { prefersReducedMotion } from '../hooks/useScramble';
import { clockNow, onClock } from './animationClock';
import { DISSOLVE_MS } from './bayerTiles';
import { refuseShake } from './refuseShake';
import { useRecordCalm } from './record/Record';
import PhoneIcon from '../assets/icons/phone.svg?react';
import TabletIcon from '../assets/icons/tablet.svg?react';
import LaptopIcon from '../assets/icons/laptop.svg?react';

type Phase = 'loading' | 'ready' | 'failed';

// "iPhone / Safari". Every field may be empty — the parser leaves what it cannot read blank
// rather than guessing — so the label is whatever the server DID recognise, and a device it
// recognised nothing about is named as such instead of rendering an empty row.
function deviceLabel(row: DeviceRow, lang: string): string {
  const parts = [row.device || row.os, row.browser].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : t(lang, 'deviceUnknown');
}

// The device's GLYPH, in the header's pixel icon family: a phone, a tablet or a computer —
// off what the server recognised (`backend/src/userAgent.ts`); a device it recognised nothing
// about is drawn as a computer, the commonest thing a browser runs on that names nothing.
function DeviceGlyph({ row }: { row: DeviceRow }) {
  const name = `${row.device} ${row.os}`;
  if (/iPad/.test(name)) return <TabletIcon className="ui-icon" aria-hidden />;
  if (/iPhone|iPod|Android/.test(name)) return <PhoneIcon className="ui-icon" aria-hidden />;
  return <LaptopIcon className="ui-icon" aria-hidden />;
}

// The lines' stagger as they dissolve in, one after the other (the boards' own beat).
const LINE_STAGGER_MS = 55;

function lastUsed(row: DeviceRow, lang: string): string | null {
  const at = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(at)) return null;
  // Day + month, no year: the sub-line answers "which one is my old phone?", and every
  // device a person still cares about was seen within months. The account screen's own
  // `began` formatter makes the same call.
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(new Date(at));
}

// The route's answer is authoritative: the top-level deviceId names the caller and the
// rows are the list after the write. Their conjunction is what distinguishes a confirmed
// self-revocation from signing out some other row (or a delete that removed nothing).
export function revokedCallingDevice(listing: DeviceListing, target: string): boolean {
  return (
    listing.deviceId === target && !listing.devices.some((row) => row.deviceId === target)
  );
}

// A set held in state, changed by copy.
function withId(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export default function DeviceList({ lang }: { lang: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [attempt, setAttempt] = useState(0);
  // A SIGN OUT, LINE BY LINE. Only the line being signed out is busy — every other line's
  // SIGN OUT stays live — and it says so in its own material: its ink THINS through the dither
  // (the glyph a `.ghost-mark`, the words to half their cells) while the request is out. Once
  // the answer says it is gone it LEAVES (`going`): out through the board's dissolve, then
  // dropped, the lines under it closing up in one whole-line step. A sign-out that did not
  // land RE-INKS its line with the refusal's shake, and its one fact gives way to one muted
  // line saying so (`refused`) until the next try.
  const [signing, setSigning] = useState<ReadonlySet<string>>(new Set());
  const [going, setGoing] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  // What a screen reader hears of the last refusal (the line's label and the note).
  const [spoken, setSpoken] = useState('');
  // The lines confirmed gone in this mount: every answer is the list as it stood after ITS
  // write, so one landing after a later one must not bring a line back.
  const removed = useRef(new Set<string>());
  const latest = useRef<DeviceRow[]>([]);
  const lines = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLElement>(null);

  // ONE call answers both the read and every write: the route always returns the list as it
  // now stands, so the screen never has to guess what a write did (the live routes' house rule).
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
    const id = row.deviceId;
    if (signing.has(id) || going.has(id)) return;
    setSigning((set) => withId(set, id, true));
    setRefused((set) => withId(set, id, false));
    const refuse = () => {
      setRefused((set) => withId(set, id, true));
      setSpoken(`${deviceLabel(row, lang)}: ${t(lang, 'deviceSignOutFailed')}`);
      refuseShake(lines.current.get(id));
    };
    void talk(row)
      .then((answer) => {
        // No answer: the identity was dropped or replaced under the call, and the surface
        // that takes over (the signed-out screen, a scope remount) says what happened.
        if (!answer || identityEpoch() !== answer.epoch) return;
        // A successful self-delete cannot wait for "the next 401": there may be no next
        // private request, and the profile would remain open as a device the server has
        // already revoked. This successful response is the second authoritative sign-out
        // signal, alongside `unknown_device`.
        if (revokedCallingDevice(answer.listing, id)) {
          markDeviceSignedOut(answer.epoch);
          return;
        }
        latest.current = answer.listing.devices;
        // The list the server answered still holds the line: nothing was signed out.
        if (answer.listing.devices.some((device) => device.deviceId === id)) {
          refuse();
          return;
        }
        removed.current.add(id);
        const settle = () => {
          setGoing((set) => withId(set, id, false));
          setRows(latest.current.filter((device) => !removed.current.has(device.deviceId)));
        };
        if (prefersReducedMotion()) {
          settle();
          return;
        }
        setGoing((set) => withId(set, id, true));
        onClock(listRef.current, DISSOLVE_MS, settle);
      })
      .catch(refuse)
      .finally(() => setSigning((set) => withId(set, id, false)));
  };

  // The lines arrive AFTER the record has calmed (`useRecordCalm`): held while it has not
  // begun, then in at the moment it says — at once when it already stands. The wait is
  // worked out as the lines MOUNT (the moment their CSS delay counts from, the skeleton's
  // too), never when the record's calm was announced — a slow read would otherwise make the
  // lines wait the whole delay again. And once in, they STAY in: a RETRY on the record puts
  // its calm back to "not yet", which says nothing about lines already standing.
  const calm = useRecordCalm();
  const [after, setAfter] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (after === null && phase === 'ready' && calm !== null) {
      setAfter(Math.max(0, Math.round(calm - clockNow())));
    }
  }, [after, phase, calm]);
  const shown = phase === 'ready' && after !== null;

  return (
    <section ref={listRef} className="device-list" aria-label={t(lang, 'devicesTitle')}>
      <p className="sr-only" role="status">
        {spoken}
      </p>
      {/* While the read is out: one line's boxes as the stippled slate — the glyph's checker and
          the label's rail — at the lines' own pitch, so nothing moves when the list lands. */}
      {/* (Once the lines are in, the skeleton stands over them until their dissolve starts.) */}
      {(phase === 'loading' || phase === 'ready') && (
        <div
          className={`device-row device-skeleton${shown ? ' leaving' : ''}`}
          style={shown ? ({ '--at': `${after ?? 0}ms` } as React.CSSProperties) : undefined}
          aria-hidden="true"
        >
          <span className="device-glyph" />
          <span className="device-info">
            <span className="device-skeleton-rail" />
          </span>
        </div>
      )}
      {/* A failed read: what failed, said quietly, and the quiet word that asks again. */}
      {phase === 'failed' && (
        <div className="device-error">
          <p className="device-error-line" role="status">
            {t(lang, 'failedDevices')}
          </p>
          <button type="button" className="quiet-btn" onClick={() => setAttempt((n) => n + 1)}>
            {t(lang, 'retry')}
          </button>
        </div>
      )}
      {shown && (
        <ul className="device-lines">
          {rows.map((row, i) => {
            const id = row.deviceId;
            const used = lastUsed(row, lang);
            const busy = signing.has(id) || going.has(id);
            return (
              <li
                ref={(el) => {
                  if (el) lines.current.set(id, el);
                  else lines.current.delete(id);
                }}
                className={`device-row${row.current ? ' current' : ''}${signing.has(id) ? ' signing' : ''}${
                  going.has(id) ? ' going' : ''
                }`}
                key={id}
                style={{ '--delay': `${(after ?? 0) + i * LINE_STAGGER_MS}ms` } as React.CSSProperties}
              >
                <span className={`device-glyph${busy ? ' ghost-mark' : ''}`}>
                  <DeviceGlyph row={row} />
                </span>
                {/* TWO LINES (#204's polish pass): the label, then ONE quiet fact under it —
                    THIS ONE for the row the reader is on, the last-seen day for the rest — or,
                    after a sign-out that did not land, the muted line that says so. */}
                <span className="device-info">
                  <span className="device-name">{deviceLabel(row, lang)}</span>
                  {refused.has(id) ? (
                    <span className="device-sub">{t(lang, 'deviceSignOutFailed')}</span>
                  ) : row.current ? (
                    <span className="device-sub current">{t(lang, 'deviceCurrent')}</span>
                  ) : (
                    used !== null && <span className="device-sub">{used}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="quiet-btn device-signout"
                  // Busy, it keeps its place and the keyboard's focus; a press does nothing.
                  aria-disabled={busy || undefined}
                  onClick={() => signOut(row)}
                >
                  {t(lang, 'deviceSignOut')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
