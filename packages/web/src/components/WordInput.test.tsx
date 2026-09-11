import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WordInput from './WordInput';

const noop = () => {};

// Lowercased: React writes an attribute it has no special handling for with the casing the
// JSX used, and the browser lowercases it on the way into the DOM either way. The assertions
// below are about the attribute being THERE, not about how React spells it.
function render(props: Partial<Parameters<typeof WordInput>[0]> = {}): string {
  return renderToStaticMarkup(
    <WordInput
      value="fore"
      history={[]}
      lang="fr"
      onType={noop}
      onBackspace={noop}
      onSubmit={noop}
      onReplace={noop}
      invalidSignal={0}
      {...props}
    />,
  ).toLowerCase();
}

// #267: the guess is a REAL focus target, so Tab can reach it and the keys belong to it
// rather than to the document. What a test can hold is the field's SHAPE — that it exists,
// that it carries the folded value, that it asks for no native keyboard, and that an
// inactive prompt is out of the tab order entirely.
describe('the guess prompt is a real field (#267)', () => {
  it('renders one input holding the folded guess', () => {
    const html = render();
    expect(html).toContain('class="wi-field"');
    expect(html).toContain('value="fore"');
  });

  it('asks the phone for NO keyboard — the on-screen one is this game’s', () => {
    expect(render()).toContain('inputmode="none"');
  });

  it('offers the browser nothing to complete, correct, capitalize or underline', () => {
    const html = render();
    for (const attribute of [
      'autocomplete="off"',
      'autocorrect="off"',
      'autocapitalize="off"',
      'spellcheck="false"',
    ]) {
      expect(html).toContain(attribute);
    }
  });

  it('DISABLES the field while the prompt is retired, so nothing focusable is left inside an aria-hidden box', () => {
    expect(render({ active: false })).toContain('disabled=""');
    expect(render()).not.toContain('disabled=""');
  });

  it('hides the DRAWN line from assistive tech — the field is what reads the guess', () => {
    const html = render();
    expect(html).toContain('aria-label="votre proposition"');
    expect(html).toContain('<span class="wi-text" aria-hidden="true">');
  });
});

// 2026-09-12: on Android, `inputmode="none"` keeps the phone's keyboard out of sight but still
// binds the keyboard APP to an editable field, and that app's edits fought the game's — letters
// doubled, backspace undone. On a touch screen the field is no text field at all.
describe('a touch screen binds no keyboard app to the guess field', () => {
  afterEach(() => vi.unstubAllGlobals());

  const primaryPointer = (coarse: boolean) =>
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({
        matches: coarse && query === '(pointer: coarse)',
        addEventListener() {},
        removeEventListener() {},
      }),
    });

  it('is READ-ONLY when the primary pointer is a finger', () => {
    primaryPointer(true);
    expect(render()).toContain('readonly=""');
  });

  it('stays editable for a mouse, so dictation and a desktop IME still land', () => {
    primaryPointer(false);
    expect(render()).not.toContain('readonly=""');
  });
});
