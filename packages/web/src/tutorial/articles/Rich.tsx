import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';
import { t } from '../../i18n';
import { useArticleLang } from './lang';

// THE ARTICLES' INLINE MARKUP (types.ts): words quoted the way the game shows them — the pixel
// face, as the coach quotes its own — a rank wearing the sentence's heat exponent, a hidden
// word as an empty hole, and the terms a paragraph defines. Everything else is plain text.
// In an example SENTENCE (`mode="sentence"`, set whole in the pixel face like the game's
// own), a quoted word is the one the sentence is about: the held chip.
const TOKEN_RE = /`([^`]+)`|\*\*([^*]+)\*\*/g;

function word(payload: string, key: number, mode: 'prose' | 'sentence', lang: string) {
  if (/^_+$/.test(payload)) {
    return <span key={key} className="ar-blank" role="img" aria-label={t(lang, 'levelBlank')} />;
  }
  const at = payload.lastIndexOf('^');
  const rank = at > 0 ? Number(payload.slice(at + 1)) : NaN;
  if (Number.isInteger(rank) || mode === 'sentence') {
    const text = Number.isInteger(rank) ? payload.slice(0, at) : payload;
    return (
      <span key={key} className="ar-held">
        <span className="ar-held-text">{text}</span>
        {Number.isInteger(rank) && (
          <sup className="ar-rank" style={{ '--rank-color': rankHeatColor(rank) } as CSSProperties}>
            {rank}
          </sup>
        )}
      </span>
    );
  }
  return (
    <span key={key} className="ar-word">
      {payload}
    </span>
  );
}

export default function Rich({ text, mode = 'prose' }: { text: string; mode?: 'prose' | 'sentence' }) {
  const lang = useArticleLang();
  const out = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) out.push(word(m[1], key++, mode, lang));
    else
      out.push(
        <strong key={key++} className="ar-term">
          {m[2]}
        </strong>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

// The same text with the markup taken off — for labels and for counting.
export function plain(text: string): string {
  return text.replace(TOKEN_RE, (_m, w: string | undefined, b: string | undefined) =>
    w !== undefined ? w.replace(/\^\d+$/, '') : (b ?? ''),
  );
}
