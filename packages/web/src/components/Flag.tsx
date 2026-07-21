// Flags are imported (not referenced from public/) so Vite bundles them. At well under
// 1 KB each they fall under Vite's default 4 KB inline limit, so they ship as base64 data
// URIs inside the hashed, immutable JS — no separate request, no origin revalidation.
// Hand-drawn 16x16 pixel art (assets/flags/) — displayed ONLY at integer multiples
// (2x/3x, see .hud-flag / .lang-card-flag) so the grid stays crisp.
import flagFr from '../assets/flags/fr.png';
import flagUk from '../assets/flags/en.png';

interface FlagInfo {
  src: string;
  alt: string;
}

const FLAGS: Partial<Record<string, FlagInfo>> = {
  en: { src: flagUk, alt: 'English flag' },
  fr: { src: flagFr, alt: 'French flag' },
};

// `className` picks the size context — `lang-card-flag` on the language screen's
// cards, `hud-flag` for the small in-header flag. Always passed explicitly.
export default function Flag({ code, className }: { code: string; className: string }) {
  const flag = FLAGS[code];
  if (!flag) return null;

  return <img className={className} src={flag.src} alt={flag.alt} draggable="false" />;
}
