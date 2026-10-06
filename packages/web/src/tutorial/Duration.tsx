import { t } from '../i18n';
import { formatDuration } from './levels';

// A lesson's length as the article's page prints it (4′50″), in the PIXEL face's 8px figures
// (`.level-duration`, on the cards and the article's credits), and in words for a screen
// reader, which reads the primes as "prime". The face has no ′ or ″ — a fallback glyph would
// land off its grid — so the primes are its own ' and ", which it draws as primes.
export default function Duration({ lang, seconds }: { lang: string; seconds: number }) {
  const spoken = t(lang, 'levelDurationSpoken')
    .replace('{m}', String(Math.floor(seconds / 60)))
    .replace('{s}', String(seconds % 60));
  return (
    <>
      <span className="level-duration" aria-hidden="true">
        {formatDuration(seconds).replace('′', "'").replace('″', '"')}
      </span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}
