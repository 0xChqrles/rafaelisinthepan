import { RARITY_NAMES, type Rarity, type RarityTally } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';
import { srWordTally } from '../i18n';

// What is left out there, by grade (#163, decided 2026-08-09). One `found/total` per rarity
// under the prompt, commonest first — 12 of the 98 COMMON groups in today's zone, 2 of its
// 14 ARCANE ones — so the run has a shape beyond its own count: it says where the depth is
// and how much of it is still unclaimed.
//
// THE COLOUR IS THE ONLY LABEL. No grade names, no legend, no icons: the five colours are
// already the language the float speaks, and naming them here would put five words under the
// prompt on a screen whose whole point is that there is nothing on it. A player who has seen
// one ARCANE knows which number is the ARCANE one.
//
// A grade the day's zone does not contain is DROPPED rather than shown as `0/0`. That is not
// cosmetic: an English board often has no ARCANE group at all, and a permanent `0/0` would
// read as a goal the player is failing at rather than one the day never offered.
export default function WordTally({
  found,
  total,
  lang,
}: {
  found: RarityTally;
  total: RarityTally;
  lang: string;
}) {
  const grades = RARITY_NAMES.filter((name) => total[name] > 0);
  if (grades.length === 0) return null;
  return (
    <div className="word-tally">
      {/* Decorative: the colour carries the grade, and a colour carries nothing to a reader.
          The sr line below says the same thing in words. */}
      <span aria-hidden="true" className="tally-row">
        {grades.map((name: Rarity) => (
          <span key={name} className="tally-grade" style={{ color: RARITY_COLORS[name] }}>
            {`${found[name]}/${total[name]}`}
          </span>
        ))}
      </span>
      <span className="sr-only">
        {srWordTally(
          lang,
          grades.map((name) => ({ rarity: name, found: found[name], total: total[name] })),
        )}
      </span>
    </div>
  );
}
