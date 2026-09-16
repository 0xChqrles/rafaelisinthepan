import io
import zipfile

from epub import epub_metadata, epub_text, html_to_text

CONTAINER = """<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
OPF = """<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Mes amis</dc:title><dc:creator>Emmanuel Bove</dc:creator></metadata><manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="css" href="s.css" media-type="text/css"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>"""


def make_epub(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF)
        zf.writestr("OEBPS/a.xhtml", "<html><head><title>x</title></head><body><p>Premier <i>chapitre</i>.</p><p>Deux.</p></body></html>")
        zf.writestr("OEBPS/b.xhtml", "<html><body><div>Second&nbsp;chapitre.</div></body></html>")


def test_metadata_and_spine_order(tmp_path):
    path = tmp_path / "b.epub"
    make_epub(path)
    assert epub_metadata(path) == {"title": "Mes amis", "author": "Emmanuel Bove"}
    assert epub_text(path) == "Premier chapitre.\n\nDeux.\n\nSecond chapitre."


def test_html_to_text_skips_head_and_keeps_blocks():
    assert html_to_text("<head><style>p{}</style></head><p>a</p><p>b<br/>c</p>") == "a\n\nb\n\nc"


def test_html_to_text_reads_a_hard_wrapped_paragraph_as_one_line():
    # A newline inside a text node is whitespace, as in a browser; <br> and blocks break.
    assert html_to_text("<p>une ligne\ncoupée en\n   deux</p><p>puis<br/>autre</p>") == \
        "une ligne coupée en deux\n\npuis\n\nautre"


def test_a_document_the_archive_cannot_produce_is_skipped(tmp_path):
    # Calibre rewrites an epub and leaves a central directory pointing at the wrong
    # offsets: zipfile raises BadZipFile on that document. The book keeps what reads.
    path = tmp_path / "mangled.epub"
    make_epub(path)
    with zipfile.ZipFile(path) as zf:
        offset = zf.getinfo("OEBPS/b.xhtml").header_offset
    raw = bytearray(path.read_bytes())
    raw[offset:offset + 4] = b"XXXX"  # no local file header there any more
    path.write_bytes(raw)
    assert epub_metadata(path) == {"title": "Mes amis", "author": "Emmanuel Bove"}
    assert epub_text(path) == "Premier chapitre.\n\nDeux."
