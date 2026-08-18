// The #188 player avatar: a 10×10 pixel grid the player draws, in exactly TWO colours —
// a background and a foreground (user-decided 2026-08-19, superseding the 3-ink first
// cut). A "palette" is a {bg, fg} pair, and the picker shows only the foreground: you
// pick a colour, and that colour IS the palette. Coherence on a board of strangers'
// drawings comes from the shared ground.
//
// This module lives in shared because the encoding is a cross-package contract: the WEB
// encodes what the editor drew (and renders every stored avatar), the BACKEND decodes it
// to validate a write and run the symbol check. Two implementations would accept
// different byte strings for one drawing.
//
// Encoding: 1 palette byte + 100 cells at 1 bit each (0 = background, 1 = foreground)
// = 14 bytes, base64url without padding = exactly 19 characters — a compact string on
// the player row, rendered client-side as SVG.

export const AVATAR_SIZE = 10;
export const AVATAR_CELLS = AVATAR_SIZE * AVATAR_SIZE;

export interface AvatarPalette {
  name: string;
  bg: string;
  fg: string;
}

// The predefined palettes. Order is load-bearing — the encoded byte is an INDEX into
// this list, so entries may be appended but never reordered or removed once avatars
// referencing them exist. One shared ground; the foregrounds are the app's own hues.
export const AVATAR_PALETTES: readonly AvatarPalette[] = [
  { name: 'COBALT', bg: '#16181f', fg: '#4a6aff' },
  { name: 'CYAN', bg: '#16181f', fg: '#4fd2e8' },
  { name: 'VIOLET', bg: '#16181f', fg: '#8f7bff' },
  { name: 'ORCHID', bg: '#16181f', fg: '#ff5ce0' },
  { name: 'EMBER', bg: '#16181f', fg: '#ff3d2e' },
  { name: 'AMBER', bg: '#16181f', fg: '#ffd23f' },
  { name: 'MOSS', bg: '#16181f', fg: '#3ddc84' },
  { name: 'PAPER', bg: '#16181f', fg: '#f4f1e8' },
];

const BYTES = 1 + Math.ceil(AVATAR_CELLS / 8); // 14
// 14 bytes -> 4 full base64 groups (16 chars) + one 2-byte tail (3 chars), no padding.
export const AVATAR_STRING_LENGTH = 19;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : null;
    const c = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== null) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== null) out += B64[c & 63];
  }
  return out;
}

function fromBase64Url(s: string): Uint8Array {
  const bits: number[] = [];
  for (const char of s) {
    const value = B64_INDEX.get(char);
    if (value === undefined) throw new Error('avatar: invalid character');
    bits.push(value);
  }
  const out = new Uint8Array(Math.floor((bits.length * 6) / 8));
  let acc = 0;
  let held = 0;
  let at = 0;
  for (const value of bits) {
    acc = (acc << 6) | value;
    held += 6;
    if (held >= 8) {
      out[at++] = (acc >> (held - 8)) & 255;
      held -= 8;
    }
  }
  // Spare bits past the last whole byte must be zero, or two strings would decode to
  // one avatar (the canonical-form rule the round-trip test pins).
  if ((acc & ((1 << held) - 1)) !== 0) throw new Error('avatar: non-canonical encoding');
  return out;
}

export interface DecodedAvatar {
  palette: number;
  // Row-major, AVATAR_CELLS entries of 0 (background) | 1 (foreground).
  cells: number[];
}

export function encodeAvatar(palette: number, cells: readonly number[]): string {
  if (!Number.isInteger(palette) || palette < 0 || palette >= AVATAR_PALETTES.length) {
    throw new Error('avatar: palette index out of range');
  }
  if (cells.length !== AVATAR_CELLS) throw new Error('avatar: expected 100 cells');
  const bytes = new Uint8Array(BYTES);
  bytes[0] = palette;
  for (let i = 0; i < AVATAR_CELLS; i++) {
    const value = cells[i];
    if (value !== 0 && value !== 1) throw new Error('avatar: cell value out of range');
    bytes[1 + (i >> 3)] |= value << (i & 7);
  }
  return toBase64Url(bytes);
}

export function decodeAvatar(encoded: string): DecodedAvatar {
  if (typeof encoded !== 'string' || encoded.length !== AVATAR_STRING_LENGTH) {
    throw new Error('avatar: wrong length');
  }
  const bytes = fromBase64Url(encoded);
  const palette = bytes[0];
  if (palette >= AVATAR_PALETTES.length) throw new Error('avatar: palette index out of range');
  // 100 bits fill 12 bytes + the low nibble of the 13th; the 4 bits past the last cell
  // must be zero (same canonical-form rule as the base64 spare bits).
  if (bytes[BYTES - 1] >> (AVATAR_CELLS & 7) !== 0) {
    throw new Error('avatar: non-canonical encoding');
  }
  const cells: number[] = new Array(AVATAR_CELLS);
  for (let i = 0; i < AVATAR_CELLS; i++) {
    cells[i] = (bytes[1 + (i >> 3)] >> (i & 7)) & 1;
  }
  return { palette, cells };
}

export function isValidAvatar(encoded: unknown): encoded is string {
  if (typeof encoded !== 'string') return false;
  try {
    decodeAvatar(encoded);
    return true;
  } catch {
    return false;
  }
}

// An empty drawing on the first palette — the editor's starting state.
export function blankAvatar(palette = 0): string {
  return encodeAvatar(palette, new Array<number>(AVATAR_CELLS).fill(0));
}
