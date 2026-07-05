import type { Source } from '@whippin/shared';

// The solved sentence's attribution (issue #8), shown under the reconstructed phrase in
// place of the input — a quote-style citation from the optional literary metadata (#5):
// a kind tag and "— Author, Work". Every field is optional, so the citation degrades
// gracefully (nothing rendered when there is no source). The wrapper keeps the input
// row's reserved height either way, so the sentence never shifts when the round ends.
export default function SolvedCaption({ source }: { source?: Source }) {
  const attribution = [source?.author, source?.work].filter(Boolean).join(', ');

  return (
    <div className="solved-caption">
      {source?.kind && <span className="solved-kind">{source.kind}</span>}
      {attribution && <p className="solved-attribution">— {attribution}</p>}
    </div>
  );
}
