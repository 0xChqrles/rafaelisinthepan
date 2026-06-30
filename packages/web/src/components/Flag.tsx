// Flags are imported (not referenced from public/) so Vite bundles them. At ~1–1.5 KB
// each they fall under Vite's default 4 KB inline limit, so they ship as base64 data
// URIs inside the hashed, immutable JS — no separate request, no origin revalidation.
import flagFr from '../assets/flag-fr.png';
import flagUk from '../assets/flag-uk.png';

interface FlagInfo {
  src: string;
  alt: string;
}

const FLAGS: Partial<Record<string, FlagInfo>> = {
  en: { src: flagUk, alt: 'English flag' },
  fr: { src: flagFr, alt: 'French flag' },
};

export default function Flag({ code }: { code: string }) {
  const flag = FLAGS[code];
  if (!flag) return null;

  return (
    <img
      className="flag-img"
      src={flag.src}
      alt={flag.alt}
      draggable="false"
    />
  );
}
