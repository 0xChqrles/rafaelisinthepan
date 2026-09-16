// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ submit: (_: string) => {}, holes: [] as { rank: number }[] }));
vi.mock('../components/Phrase', () => ({
  default: (p: { holes: { rank: number }[] }) => {
    observed.holes = p.holes;
    return null;
  },
}));
vi.mock('../components/WordInput', () => ({
  default: (p: { onSubmit: (word: string) => void }) => {
    observed.submit = p.onSubmit;
    return null;
  },
}));
vi.mock('../components/Keyboard', () => ({ default: () => null }));
vi.mock('../components/CellDigits', () => ({ default: () => null }));
vi.mock('../components/HistoryWheel', () => ({ default: () => null }));
vi.mock('../components/HistoryModal', () => ({ default: () => null }));
vi.mock('../components/FloatingHit', () => ({ HIT_FADE_MS: 600 }));
vi.mock('../components/Hole', () => ({ RANK_MAX_MS: 400, rankTransitionDuration: () => 400 }));
vi.mock('../screens/Game', () => ({ FLOATING_HIT_INTRO_MS: 320, KB_EXIT_FALLBACK_MS: 500, STAGGER_MS: 200 }));
vi.mock('./CoachText', () => ({ default: () => null, richToPlain: (x: string) => x }));
import LessonBoard from './LessonBoard';
import script from './scripts/en';

afterEach(() => vi.useRealTimers());

it('offers CONTINUE after two fast solving guesses', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(
    <LessonBoard
      lang="en"
      script={script.stages[2]}
      step={3}
      totalSteps={4}
      vocab={{ vocabSet: new Set(['dog', 'moon']), prefixSet: new Set() }}
      vocabError={null}
      retryVocab={() => {}}
      final={false}
      onComplete={() => {}}
      onPlay={() => {}}
    />,
  ));
  await act(async () => observed.submit('dog'));
  await act(async () => { vi.advanceTimersByTime(100); });
  await act(async () => observed.submit('moon'));
  await act(async () => { vi.advanceTimersByTime(5000); });
  await act(async () => { vi.advanceTimersByTime(5000); });
  const ranks = observed.holes.map((h) => h.rank);
  const text = host.textContent;
  await act(async () => root.unmount());
  expect(ranks).toEqual([0, 0]);
  expect(text?.toLowerCase()).toContain('continue');
});
