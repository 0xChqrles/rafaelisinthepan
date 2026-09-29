"""spaCy adapter: a sentence -> the plain `Token` list the rules operate on."""

import functools
import re

import _paths  # noqa: F401
from slug import slug

from rules import Token

# One parser per language (#317); its `is_stop` is the language's stopword list.
MODELS = {"fr": "fr_core_news_md", "en": "en_core_web_md"}
# A hyphenated compound is ONE word to the game (« post-it », « ice-cold »,
# « mother-in-law », « répondit-il »): gen_phrase finds a secret by its word-core, a
# maximal letter run with internal hyphens (its `core_re`), so a piece of a compound can
# never be holed. The parsers split some of them; `parse` merges each back into one token.
_COMPOUND = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)+")


@functools.lru_cache(maxsize=None)
def _nlp(lang: str):
    import spacy

    return spacy.load(MODELS[lang])


def compound_spans(sentence: str) -> list[tuple[int, int]]:
    """The character spans of the sentence's hyphenated compounds, in order."""
    return [m.span() for m in _COMPOUND.finditer(sentence)]


def parse(sentence: str, lang: str) -> list[Token]:
    doc = _nlp(lang)(sentence)
    with doc.retokenize() as retokenizer:
        for start, end in compound_spans(sentence):
            span = doc.char_span(start, end)
            if span is not None and len(span) > 1:
                # the compound's own lemma: « ice-cold » is no inflection of « cold »
                retokenizer.merge(span, attrs={"LEMMA": span.text.lower()})
    return _tokens(doc)


def _tokens(doc) -> list[Token]:
    return [
        Token(
            i=t.i,
            text=t.text,
            lemma=t.lemma_.lower(),
            pos=t.pos_,
            dep=t.dep_,
            head=t.head.i,
            slug=slug(t.text),
            stop=bool(t.is_stop),
            space=t.whitespace_,
        )
        for t in doc
    ]
