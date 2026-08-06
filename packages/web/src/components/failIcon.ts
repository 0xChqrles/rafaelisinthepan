import failPng from '../assets/fail.png';

export type FailIconState = 'filled' | 'empty';

type Rgb = readonly [number, number, number];

const FAIL_STATES: readonly FailIconState[] = ['filled', 'empty'];
const PLACEHOLDER: Rgb = [255, 0, 0];
const FALLBACK_COLORS: Record<FailIconState, string> = {
  filled: '#ff1f54',
  empty: '#2c3358',
};

const cache = new Map<FailIconState, string>();
let preload: Promise<void> | null = null;

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function cssColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function failIconUrl(state: FailIconState): string | null {
  return cache.get(state) ?? null;
}

// Recolor the exact red placeholder pixels in fail.png, following the same canvas
// replacement used by teleportStrips.ts. Transparent pixels are left untouched.
export function preloadFailIcons(): Promise<void> {
  if (preload) return preload;
  if (typeof document === 'undefined') return Promise.resolve();

  preload = (async () => {
    try {
      const img = new Image();
      img.src = failPng;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(img, 0, 0);
      const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const colors: Record<FailIconState, Rgb> = {
        filled: hexToRgb(cssColor('--danger', FALLBACK_COLORS.filled)),
        empty: hexToRgb(cssColor('--surface-hover', FALLBACK_COLORS.empty)),
      };

      for (const state of FAIL_STATES) {
        const data = new Uint8ClampedArray(source.data);
        const [r, g, b] = colors[state];
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          if (
            data[i] === PLACEHOLDER[0] &&
            data[i + 1] === PLACEHOLDER[1] &&
            data[i + 2] === PLACEHOLDER[2]
          ) {
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
          }
        }
        ctx.putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
        cache.set(state, canvas.toDataURL('image/png'));
      }
    } catch {
      // The bar stays blank rather than showing a wrongly colored raw sprite.
    }
  })();

  return preload;
}
