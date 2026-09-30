import { createContext, useContext } from 'react';

// The language an article is read in, for the few words its markup and figures say
// themselves (a hidden word's name, what a marked word is): set once by ArticleLevel.
export const ArticleLang = createContext('en');

export function useArticleLang(): string {
  return useContext(ArticleLang);
}
