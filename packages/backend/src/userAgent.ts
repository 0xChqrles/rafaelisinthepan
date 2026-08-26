// What a device IS, read from the `User-Agent` header (#216).
//
// SERVER-side on purpose: the client can lie about itself, and the server sees the header
// anyway. The result is stored as FIELDS (`DeviceAgent`), not a formatted string, so the
// sign-out screen can render icons and change its wording without a migration.
//
// It is DELIBERATELY COARSE. The label exists so a person recognises their own phone in a
// list — "iPhone / Safari" — not so anyone can tell a browser build apart, and no product
// rule reads it. A general UA parser is a large dependency in a Lambda bundle for three
// words, and it would still call Brave "Chrome"; what actually matters is the ORDER of the
// checks below, since every Chromium browser also claims Safari and most claim Chrome.
// An unrecognised field stays EMPTY rather than guessed at — the screen names an unlabelled
// device, this file never invents one.

import type { DeviceAgent } from './deviceStore';

// A hostile client can send a very long header. Nothing below is quadratic, but there is no
// reason to run a dozen regular expressions over a megabyte either.
const MAX_LENGTH = 512;

const UNKNOWN: DeviceAgent = { device: '', os: '', browser: '' };

// ORDERED: the first match wins, because Chromium browsers impersonate each other. Edge and
// Opera and Samsung Internet all carry `Chrome/`; Chrome carries `Safari/`; the iOS builds
// of Chrome, Firefox and Edge carry neither their desktop token nor `Chrome/`.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:iOS|A|)\//, 'Edge'],
  [/\b(?:OPR|OPiOS)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

function browserOf(ua: string): string {
  for (const [pattern, name] of BROWSERS) {
    if (pattern.test(ua)) return name;
  }
  return '';
}

// The hardware family a person would NAME, plus the OS when the UA carries a version worth
// showing. Ordered for the same reason: an Android UA also says "Linux".
function platformOf(ua: string): { device: string; os: string } {
  const iosVersion = /\bOS (\d+)[._]/.exec(ua)?.[1];
  const ios = iosVersion ? `iOS ${iosVersion}` : 'iOS';
  if (/\biPhone\b/.test(ua)) return { device: 'iPhone', os: ios };
  if (/\biPad\b/.test(ua)) return { device: 'iPad', os: ios };
  if (/\biPod\b/.test(ua)) return { device: 'iPod', os: ios };
  const android = /\bAndroid (\d+)/.exec(ua)?.[1];
  if (android) return { device: 'Android', os: `Android ${android}` };
  if (/\bAndroid\b/.test(ua)) return { device: 'Android', os: 'Android' };
  if (/\bCrOS\b/.test(ua)) return { device: 'Chromebook', os: 'ChromeOS' };
  if (/\bWindows NT\b/.test(ua)) return { device: 'Windows', os: 'Windows' };
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return { device: 'Mac', os: 'macOS' };
  if (/\bLinux\b/.test(ua)) return { device: 'Linux', os: 'Linux' };
  return { device: '', os: '' };
}

export function parseUserAgent(raw: string | undefined): DeviceAgent {
  if (typeof raw !== 'string' || raw.length === 0) return UNKNOWN;
  const ua = raw.slice(0, MAX_LENGTH);
  return { ...platformOf(ua), browser: browserOf(ua) };
}
