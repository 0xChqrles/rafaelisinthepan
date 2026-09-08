// THE SENTENCE IS DISPLAYED IN SENTENCE CASE (user-decided 2026-09-08). The schema stores
// `words[]` lowercased (the root AGENTS.md contract), so a capital is a DISPLAY rule,
// applied where the sentence is drawn — `Phrase`, the dissolve, the solved page — and
// never to a slug, a rank-map key or a keystroke. Two rules: the first token takes a
// capital, and so does every token after a sentence-final mark (a unit can be two or
// three sentences); the capital lands on the first LETTER, past an opening quote or
// bracket, so « ils » reads « Ils » and "famille" keeps its quote. A hole's PREFIX takes
// it when the hole has one (« T'attends »), else the hole's displayed word.
// Proper nouns stay as stored: only generation keeping the source's case could restore
// them, which is a schema decision this rule does not make.

// A sentence ends on . ! ? or …, possibly followed by a closing quote or bracket.
const TERMINAL = /[.!?…]["»”’')\]]*$/;
const LETTER = /\p{L}/u;

/** Which tokens open a sentence: the first, and every one after a terminal mark. A
 *  token with no letter in it (a lone « or », a dash) cannot wear the capital, so it
 *  passes the opening on to the next token. */
export function sentenceStarts(words: string[]): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < words.length; i++) {
    const prev = words[i - 1];
    out.push(i === 0 || TERMINAL.test(prev) || (out[i - 1] && !LETTER.test(prev)));
  }
  return out;
}

/** The first LETTER of `text` upper-cased, whatever punctuation precedes it. */
export function capitalize(text: string): string {
  const m = /\p{L}/u.exec(text);
  if (!m) return text;
  const at = m.index;
  // Locale-independent: neither language the game ships has a special-cased capital
  // (Turkish's dotted i is the one case the locale forms exist for).
  return text.slice(0, at) + m[0].toUpperCase() + text.slice(at + m[0].length);
}
