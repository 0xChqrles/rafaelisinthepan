// Flags are imported (not referenced from public/) so Vite bundles them. At well under
// 1 KB each they fall under Vite's default 4 KB inline limit, so they ship as base64 data
// URIs inside the hashed, immutable JS — no separate request, no origin revalidation.
// Hand-drawn 16x16 pixel art (assets/flags/) — displayed ONLY at integer multiples
// (2x, see .lang-card-flag) so the grid stays crisp. Its ONE consumer is the language
// SCREEN's cards: the header stopped showing the loaded language's flag on 2026-08-06
// (see LangButton), so a flag now appears only where a language is actually being chosen.
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

// `className` picks the size context (`lang-card-flag` on the language screen's cards).
// Always passed explicitly.
export default function Flag({ code, className }: { code: string; className: string }) {
  const flag = FLAGS[code];
  if (!flag) return null;

  return <img className={className} src={flag.src} alt={flag.alt} draggable="false" />;
}
