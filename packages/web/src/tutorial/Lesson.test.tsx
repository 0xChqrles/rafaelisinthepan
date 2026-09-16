// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Lesson from './Lesson';

const actions = vi.hoisted(() => ({
  markLessonDone: vi.fn(),
  setOnboarded: vi.fn(),
  navigate: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../state/gameStore', () => ({
  useGameStore: (select: (state: typeof actions) => unknown) => select(actions),
}));
vi.mock('../routing', () => ({ navigate: actions.navigate }));
vi.mock('../analytics', () => ({ track: actions.track }));
vi.mock('./LevelOne', () => { throw new Error('Chunk download failed'); });

it('leaves a failed lesson download without recording completion', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Lesson lang="fr" level={1} />));
    await vi.waitFor(() => expect(actions.navigate).toHaveBeenCalledWith('/fr'));
    expect(actions.setOnboarded).toHaveBeenCalledOnce();
    expect(actions.markLessonDone).not.toHaveBeenCalled();
    expect(actions.track).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
