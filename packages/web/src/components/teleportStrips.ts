import teleportOutUrl from '../assets/characters/teleport-out.png';
import teleportSharedUrl from '../assets/characters/teleport-shared.png';
import teleportInUrl from '../assets/characters/teleport-in.png';

// Teleport swap frames (#81): when two lineup entrants exchange positions, each plays
// dissolve (out) -> flash (shared) -> materialize (in) instead of sliding. The art is
// ONE hand-drawn set of strips shared by every character — the out/in strips are drawn
// in an exact 3-color placeholder palette and recolored at runtime per character, so
// the animation can never drift between characters and a future character is a palette
// entry, not new art. The shared middle strip is neutral (white) and used as-is.
//
// Asset contract (assets/characters/teleport-*.png): horizontal strips of 42x53 cells
// (.lineup-effect mirrors the cell height — keep the two in sync),
// art bottom-anchored (same baseline as the idle sprites), 1x pixel scale. Placeholder
// mapping: #ff0000 -> base, #0000ff -> shadow, #00ff00 -> light; black/white pass
// through untouched. The swap is an EXACT RGB match — the strips are hard-edged pixel
// art with no anti-aliased blends.
export const TELEPORT_FRAME_W = 42;
export const TELEPORT_FRAMES = { out: 5, shared: 2, in: 2 } as const;

// Identity palette per character: base is the label color (the player's equals the
// game's --accent blue), shadow/light are the darker/lighter tones drawn into the art.
export const CHARACTER_PALETTES = {
  player: { base: '#2f7bff', shadow: '#1854ec', light: '#94c8ff' },
  fable: { base: '#ff6b3d', shadow: '#ed4331', light: '#ffb18a' },
  kimi: { base: '#9a5bff', shadow: '#6c33f0', light: '#d8b8ff' },
  gpt: { base: '#00e08f', shadow: '#10b25b', light: '#99ffda' },
} as const;
export type CharacterKey = keyof typeof CHARACTER_PALETTES;

// Canonical sprite order — index-aligned with benchmark's DISPLAY_MODEL_IDS.
export const BOT_KEYS = ['fable', 'kimi', 'gpt'] as const;

export { teleportSharedUrl };

type Rgb = readonly [number, number, number];

const PLACEHOLDERS: Record<keyof (typeof CHARACTER_PALETTES)['player'], Rgb> = {
  base: [255, 0, 0],
  shadow: [0, 0, 255],
  light: [0, 255, 0],
};

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// `${character}:${phase}` -> recolored strip data URL.
const cache = new Map<string, string>();
let started = false;

export function teleportStrip(character: CharacterKey, phase: 'out' | 'in'): string | null {
  return cache.get(`${character}:${phase}`) ?? null;
}

// Kick the (tiny) load+recolor of every character's strips once; StandingsLineup calls
// it on mount so the frames are ready long before a swap can happen. Best-effort: if it
// hasn't finished (or failed), a swap just keeps the slide fallback.
export function preloadTeleportStrips(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  void (async () => {
    try {
      for (const [phase, url] of [
        ['out', teleportOutUrl],
        ['in', teleportInUrl],
      ] as const) {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (const character of Object.keys(CHARACTER_PALETTES) as CharacterKey[]) {
          const palette = CHARACTER_PALETTES[character];
          const data = new Uint8ClampedArray(src.data);
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue;
            for (const tone of Object.keys(PLACEHOLDERS) as (keyof typeof PLACEHOLDERS)[]) {
              const [pr, pg, pb] = PLACEHOLDERS[tone];
              if (data[i] === pr && data[i + 1] === pg && data[i + 2] === pb) {
                const [r, g, b] = hexToRgb(palette[tone]);
                data[i] = r;
                data[i + 1] = g;
                data[i + 2] = b;
                break;
              }
            }
          }
          ctx.putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
          cache.set(`${character}:${phase}`, canvas.toDataURL());
        }
      }
    } catch {
      // Strips stay unavailable; swaps fall back to the slide.
    }
  })();
}
