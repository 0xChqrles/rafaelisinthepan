// The two builders every lesson script lays its boards out with, whatever its language.
import type { WordPuzzle } from '@whippin/shared';

// A hole at its start word, both READ OFF the map rather than restated here, so the board can
// never disagree with its own neighborhood.
export function hole(artifact: WordPuzzle, pos: number, start: string, suffix?: string) {
  const entry = artifact.ranks[start];
  return {
    pos,
    secret: artifact.word,
    start: { word: entry.word, slug: start },
    start_rank: entry.rank,
    ...(suffix ? { suffix } : {}),
  };
}

// A LESSON's boards, never a published daily: not served, not synced, never scored, so the
// version is a constant rather than a publish stamp (#203).
export function single(lang: string, artifact: WordPuzzle, start: string) {
  return {
    lang,
    revision: 'lesson',
    words: [artifact.word.word],
    holes: [hole(artifact, 0, start)],
    ranks: { [artifact.word.slug]: artifact.ranks },
  };
}
