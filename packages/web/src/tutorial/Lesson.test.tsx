// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import Lesson from './Lesson';
import { stashedLessonReturn } from './lessonReturn';

// CONTRACT: a lesson whose chunk is LOST holds its page and says so, with RETRY — it records
// nothing and goes nowhere on its own; on the FIRST VISIT (the onboarding question still open)
// it keeps the invitation's way on to the game beside RETRY, which is the SKIP it always was.
// RETRY reloads the page, and the way back the invitation gave the lesson outlives it.
const state = vi.hoisted(() => ({
  onboarded: false,
  markLessonDone: vi.fn(),
  setOnboarded: vi.fn(),
  navigate: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../state/gameStore', () => ({
  useGameStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('../routing', () => ({ navigate: state.navigate }));
vi.mock('../analytics', () => ({ track: state.track }));
vi.mock('./LevelOne', () => {
  throw new Error('Chunk download failed');
});

afterEach(() => {
  vi.clearAllMocks();
  state.onboarded = false;
});

async function renderLost(returnTo?: string): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Lesson lang="fr" level={1} returnTo={returnTo} />));
  await vi.waitFor(() => expect(host.textContent).toContain("Cette page n'a pas chargé."));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

it('holds a lost lesson in place with RETRY, recording nothing and going nowhere', async () => {
  state.onboarded = true;
  const { host, unmount } = await renderLost();
  try {
    expect(button(host, 'RÉESSAYER')).not.toBeNull();
    // An onboarded player has the header's keys: no way on is added.
    expect(button(host, 'PASSER')).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.setOnboarded).not.toHaveBeenCalled();
    expect(state.markLessonDone).not.toHaveBeenCalled();
    expect(state.track).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
});

it('keeps the first visit its way on to the game: the SKIP settles the question and plays', async () => {
  const { host, unmount } = await renderLost();
  try {
    const skip = button(host, 'PASSER');
    expect(skip).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => skip!.click());
    expect(state.setOnboarded).toHaveBeenCalledOnce();
    expect(state.track).toHaveBeenCalledWith('tutorial', { action: 'skip' });
    expect(state.navigate).toHaveBeenCalledWith('/fr');
    expect(state.markLessonDone).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
});

it('keeps the way back across RETRY: the reload a lost chunk asks for lands the lesson where it began', async () => {
  const { host, unmount } = await renderLost('/fr/bonus/1234567');
  try {
    await act(async () => button(host, 'RÉESSAYER')!.click());
    // Kept for the reloaded page, which reads it once and clears it.
    expect(sessionStorage.getItem('whippin-lesson-return')).toBe('/fr/bonus/1234567');
    expect(stashedLessonReturn()).toBe('/fr/bonus/1234567');
    expect(sessionStorage.getItem('whippin-lesson-return')).toBeNull();
    expect(stashedLessonReturn()).toBe('/fr/bonus/1234567');
    expect(state.navigate).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
});
