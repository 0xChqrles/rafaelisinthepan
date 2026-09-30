// Unpadded base64url over bytes (env-agnostic: no Buffer/atob) — the alphabet and the
// ENCODER the package's two wire codecs share: the share token (`shareCard.ts`) and the
// avatar (`avatar.ts`). Internal to the package. Each codec keeps its own DECODER, because
// they refuse differently on purpose: the avatar throws and demands canonical spare bits,
// the share token returns null and leaves the trailing bits to its bit reader.

export const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const b2 = rem > 2 ? bytes[i + 2] : 0;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (rem > 1) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (rem > 2) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}
