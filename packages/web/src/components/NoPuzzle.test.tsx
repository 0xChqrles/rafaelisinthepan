import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NoPuzzle from './NoPuzzle';

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  clicks: [] as Array<() => void>,
}));

vi.mock('../routing', () => ({ navigate: harness.navigate }));
vi.mock('./Button', () => ({
  default: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    if (onClick) harness.clicks.push(onClick);
    return <button type="button">{children}</button>;
  },
}));

beforeEach(() => {
  harness.navigate.mockClear();
  harness.clicks.length = 0;
});

describe('NoPuzzle archive navigation', () => {
  it('returns a missing Word day to the Word archive', () => {
    renderToStaticMarkup(<NoPuzzle lang="fr" mode="word" date="2026-08-01" />);

    harness.clicks[0]();
    expect(harness.navigate).toHaveBeenCalledWith('/fr/word/archive');
  });
});
