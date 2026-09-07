"""spaCy adapter: a sentence -> the plain `Token` list the rules operate on."""

import functools

import _paths  # noqa: F401
from slug import slug

from rules import Token

MODELS = {"fr": "fr_core_news_md"}


@functools.lru_cache(maxsize=None)
def _nlp(lang: str):
    import spacy

    return spacy.load(MODELS[lang])


def parse(sentence: str, lang: str = "fr") -> list[Token]:
    doc = _nlp(lang)(sentence)
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
        )
        for t in doc
    ]
