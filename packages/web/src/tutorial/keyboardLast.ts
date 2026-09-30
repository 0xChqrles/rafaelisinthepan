// Whether the player's last act was a KEY. An article takes the focus on opening only then
// (ArticleLevel): a tap or a pasted link leaves it alone, since the brackets frame a focus the
// keyboard did not ask for all the same. Installed at startup (LazyArticle imports it), not in
// the lazy article chunk, which loads only AFTER the key that opens it.
let last = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (last = true), true);
  window.addEventListener('pointerdown', () => (last = false), true);
}

export function keyboardLast(): boolean {
  return last;
}
