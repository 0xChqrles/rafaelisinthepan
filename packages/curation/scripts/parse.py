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
    return _tokens(_nlp(lang)(sentence))


def parse_many(sentences: list[str], lang: str = "fr") -> list[list[Token]]:
    """Every sentence parsed in one batched pass (`nlp.pipe`) — the whole mined text goes
    through `rich_enough` before the shortlist, and one call per sentence there is a
    novel's worth of single-document calls (PR-274 review)."""
    return [_tokens(doc) for doc in _nlp(lang).pipe(sentences, batch_size=64)]


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
        )
        for t in doc
    ]
