"""EPUB -> plain text and metadata. Stdlib only (zipfile + xml + html.parser)."""

from html.parser import HTMLParser
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

_NS = {
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}
_BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "blockquote"}
_SKIP_TAGS = {"script", "style", "head", "title"}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip += 1
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = "".join(parser.parts)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def _opf_path(zf: zipfile.ZipFile) -> str:
    root = ET.fromstring(zf.read("META-INF/container.xml"))
    rootfile = root.find(".//container:rootfile", _NS)
    if rootfile is None or not rootfile.get("full-path"):
        raise ValueError("container.xml names no rootfile")
    return rootfile.get("full-path")


def epub_metadata(path) -> dict:
    """{title, author} from the OPF's Dublin Core, empty strings when absent."""
    with zipfile.ZipFile(path) as zf:
        opf = ET.fromstring(zf.read(_opf_path(zf)))
    title = opf.findtext(".//dc:title", default="", namespaces=_NS) or ""
    author = opf.findtext(".//dc:creator", default="", namespaces=_NS) or ""
    return {"title": title.strip(), "author": author.strip()}


def epub_text(path) -> str:
    """The book's text in spine order (every document the manifest declares as HTML
    when the spine is unusable), block elements separated by blank lines."""
    with zipfile.ZipFile(path) as zf:
        opf_path = _opf_path(zf)
        opf = ET.fromstring(zf.read(opf_path))
        base = posixpath.dirname(opf_path)
        items = {}
        for item in opf.findall(".//opf:manifest/opf:item", _NS):
            href = item.get("href", "")
            media = item.get("media-type", "")
            if "html" in media and href:
                items[item.get("id")] = posixpath.normpath(posixpath.join(base, href))
        ordered = [items[ref.get("idref")] for ref in opf.findall(".//opf:spine/opf:itemref", _NS)
                   if ref.get("idref") in items]
        if not ordered:
            ordered = sorted(items.values())
        chunks = []
        for name in ordered:
            try:
                raw = zf.read(name)
            except KeyError:
                continue
            chunks.append(html_to_text(raw.decode("utf-8", errors="replace")))
    return "\n\n".join(chunks)
