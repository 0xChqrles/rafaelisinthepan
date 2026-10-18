import { describe, expect, it } from 'vitest';
import { REPLY_MAX_CHARS, linkKey, replyText, urlsIn, withoutUnseenLinks } from './format';

describe('a reply as WhatsApp shows it (v22)', () => {
  it('never touches a link: underscores, anchors, tildes and brackets survive', () => {
    const links = [
      'https://fr.wikipedia.org/wiki/Le_Petit_Prince',
      'https://example.com/page#history',
      'https://example.com/~user/a_b?utm_source=x&b=2',
      'https://en.wikipedia.org/wiki/Paris_(France)',
    ];
    for (const url of links) expect(replyText(`Regarde ${url}.`)).toBe(`Regarde ${url}.`);
  });

  it("keeps WhatsApp's own marks and turns Markdown into them", () => {
    expect(replyText('*Personne* n’a _encore_ joué ~hier~')).toBe('*Personne* n’a _encore_ joué ~hier~');
    expect(replyText('## Le film\n**Gros** titre, ~~barré~~\n* un\n* deux\n---\nfin')).toBe('*Le film*\n*Gros* titre, ~barré~\n- un\n- deux\n\nfin');
  });

  it('writes a Markdown link as its text and the link', () => {
    expect(replyText('Lis [cet article](https://ex.com/a_b) avant.')).toBe('Lis cet article https://ex.com/a_b avant.');
    expect(replyText('[https://ex.com/a](https://ex.com/a)')).toBe('https://ex.com/a');
  });

  it('keeps one blank line between paragraphs, and French spacing as typed', () => {
    expect(replyText('Ça va ?\n\n\n\nOui : très.   Et toi ?')).toBe('Ça va ?\n\nOui : très. Et toi ?');
    expect(replyText('   ')).toBeNull();
    expect(replyText(null)).toBeNull();
  });

  it('bounds a reply, cutting at a paragraph or a sentence and never inside a link', () => {
    const long = replyText('Phrase courte. '.repeat(400))!;
    expect(long.length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    expect(long.endsWith('.')).toBe(true);
    const url = `https://ex.com/${'a'.repeat(200)}`;
    const linked = replyText(`${'mot '.repeat(700)}${url} fin`)!;
    expect(linked.length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    expect(urlsIn(linked).every((u) => u === url)).toBe(true);
  });

  it('reads a closing *bold*, ~strike~ or _italic_ mark as the sentence\'s, never the link\'s', () => {
    expect(urlsIn('lis *https://ex.com/a* et _https://ex.com/b_ et ~https://ex.com/c~')).toEqual(['https://ex.com/a', 'https://ex.com/b', 'https://ex.com/c']);
    expect(urlsIn('https://ex.com/a_b_ (pas en italique)')).toEqual(['https://ex.com/a_b_']);
    expect(urlsIn('_voir https://fr.wikipedia.org/wiki/Le_Petit_Prince_')).toEqual(['https://fr.wikipedia.org/wiki/Le_Petit_Prince']);
    expect(urlsIn('Lis _Le Petit Prince_ : https://ex.com/a_')).toEqual(['https://ex.com/a_']);
    expect(replyText('**https://ex.com/a_b** et https://ex.com/c…')).toBe('*https://ex.com/a_b* et https://ex.com/c…');
    expect(replyText('https://ex.com/a[https://ex.com/b](https://ex.com/b)')).not.toMatch(/\u0000/);
  });

  it('reads links as they would be clicked, and keys a page however it was spelled', () => {
    expect(urlsIn('voir https://ex.com/a, puis (https://ex.com/b).')).toEqual(['https://ex.com/a', 'https://ex.com/b']);
    expect(linkKey('https://WWW.Ex.com:443/a/#top')).toBe(linkKey('https://ex.com/a'));
    expect(linkKey('https://ex.com/a?x=1')).not.toBe(linkKey('https://ex.com/a'));
    expect(linkKey('https://ex.com/a?x=1', false)).toBe(linkKey('https://ex.com/a', false));
    expect(linkKey('ftp://ex.com/a')).toBeNull();
  });

  it('takes out a link it was never shown, and tidies only the line it left', () => {
    const allowed = (url: string) => url.startsWith('https://seen.com');
    expect(withoutUnseenLinks('Tiens : https://made.up/x\nÇa va ?', allowed)).toBe('Tiens\nÇa va ?');
    expect(withoutUnseenLinks('Lis https://made.up/x, puis https://seen.com/a.', allowed)).toBe('Lis, puis https://seen.com/a.');
    expect(withoutUnseenLinks('Deux :\n- https://made.up/x\n- https://seen.com/a', allowed)).toBe('Deux :\n- https://seen.com/a');
    // Nothing to take out: the text as written, French spaces and all.
    expect(withoutUnseenLinks('Tout est là : https://seen.com/a ?', allowed)).toBe('Tout est là : https://seen.com/a ?');
  });
});
