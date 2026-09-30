"""CONTRACT: the offline builders' downloads (build_wordlist.fetch / verify_digest, shared
by build_forms.py).

  - a download is cached only once it is WHOLE: the body goes to `<dest>.part` and is
    renamed at the end, so an interrupted transfer, or one shorter than the response's
    own Content-Length, is never the file the next run reads — and never replaces a
    good cached file on --refresh;
  - a pinned source must be the exact file its digest names, or the build stops before
    reading it. Lexique is pinned: it is the one wordlist source that travels over
    plain HTTP, and it decides the fr wordlist and the fr inventory's `dom` column.

No network: urlopen is replaced by canned responses.
"""

import gzip
import hashlib
import io

import pytest

import build_forms
import build_wordlist as bw

URL = "https://example.invalid/source.txt"


class _Response(io.BytesIO):
    """What fetch() reads of an HTTP response: a body, its headers, a context manager.
    `breaks_after` cuts the connection once that many bytes have been read."""

    def __init__(self, body, headers, breaks_after=None):
        super().__init__(body)
        self.headers = headers
        self._breaks_after = breaks_after

    def read(self, size=-1):
        if self._breaks_after is not None:
            if self.tell() >= self._breaks_after:
                raise ConnectionResetError("connection reset by peer")
            size = self._breaks_after - self.tell()
        return super().read(size)


@pytest.fixture
def network(monkeypatch):
    """`network(body, ...)` queues one response; the fixture value's `.requests` lists
    the URLs asked for. A request with nothing queued fails the test."""
    queue, requests = [], []

    def urlopen(req, timeout=None):
        requests.append(req.full_url)
        assert queue, "unexpected network request"
        return queue.pop(0)

    def serve(body, *, length="body", breaks_after=None):
        headers = {} if length is None else {
            "Content-Length": str(len(body) if length == "body" else length)}
        queue.append(_Response(body, headers, breaks_after))

    serve.requests = requests
    monkeypatch.setattr(bw.urllib.request, "urlopen", urlopen)
    return serve


# --- fetch: whole or nothing ---------------------------------------------------------

def test_fetch_downloads_once_then_serves_the_cache(network, tmp_path):
    dest = tmp_path / "cache" / "source.txt"
    network(b"un\ndeux\n")

    assert bw.fetch(URL, str(dest), False) == str(dest)
    assert dest.read_bytes() == b"un\ndeux\n"
    assert [p.name for p in dest.parent.iterdir()] == ["source.txt"]   # no .part left

    # cached: no second request (nothing is queued, so one would fail the test)...
    assert bw.fetch(URL, str(dest), False) == str(dest)
    assert network.requests == [URL]
    # ...until --refresh asks for it again
    network(b"trois\n")
    bw.fetch(URL, str(dest), True)
    assert dest.read_bytes() == b"trois\n"
    assert network.requests == [URL, URL]


def test_an_interrupted_download_is_not_the_cached_file(network, tmp_path):
    dest = tmp_path / "source.txt"
    network(b"un\ndeux\ntrois\n", breaks_after=4)
    with pytest.raises(ConnectionResetError):
        bw.fetch(URL, str(dest), False)
    assert not dest.exists()

    # the next run downloads again instead of reading the four bytes that arrived
    network(b"un\ndeux\ntrois\n")
    bw.fetch(URL, str(dest), False)
    assert dest.read_bytes() == b"un\ndeux\ntrois\n"
    assert network.requests == [URL, URL]


def test_a_body_shorter_than_its_content_length_is_refused(network, tmp_path, capsys):
    # A connection closed early ends the copy WITHOUT an exception: the response's own
    # length is what tells a truncated body from a whole one.
    dest = tmp_path / "source.txt"
    network(b"un\n", length=14)
    with pytest.raises(SystemExit):
        bw.fetch(URL, str(dest), False)
    err = capsys.readouterr().err
    assert "téléchargement incomplet" in err and URL in err
    assert "3 octet(s) reçu(s), 14 attendu(s)" in err
    assert not dest.exists()


def test_a_failed_refresh_keeps_the_file_already_cached(network, tmp_path):
    dest = tmp_path / "source.txt"
    dest.write_bytes(b"un\ndeux\ntrois\n")
    network(b"un\n", length=14)
    with pytest.raises(SystemExit):
        bw.fetch(URL, str(dest), True)
    assert dest.read_bytes() == b"un\ndeux\ntrois\n"


def test_a_response_that_states_no_length_is_taken_whole(network, tmp_path):
    dest = tmp_path / "source.txt"
    network(b"un\ndeux\n", length=None)
    bw.fetch(URL, str(dest), False)
    assert dest.read_bytes() == b"un\ndeux\n"


# --- verify_digest: a pinned source is the exact file ---------------------------------

def test_verify_digest_hands_back_the_pinned_file_and_stops_on_any_other(tmp_path, capsys):
    path = tmp_path / "source.txt"
    path.write_bytes(b"un\ndeux\n")
    pinned = hashlib.sha256(b"un\ndeux\n").hexdigest()
    assert bw.verify_digest(str(path), pinned, "source.txt") == str(path)

    path.write_bytes(b"un\ndeux\ntrois\n")
    other = hashlib.sha256(b"un\ndeux\ntrois\n").hexdigest()
    with pytest.raises(SystemExit):
        bw.verify_digest(str(path), pinned, "source.txt")
    err = capsys.readouterr().err
    assert "empreinte inattendue pour source.txt" in err
    assert f"attendu {pinned}" in err
    assert f"obtenu  {other}" in err


# --- Lexique: plain HTTP, so pinned by digest -----------------------------------------

LEXIQUE = "ortho\tcgram\tfreqlivres\nForêt\tNOM\t1.0\nchevaux\tNOM\t2.0\nl'animal\tNOM\t3.0\n"


@pytest.fixture
def lexique(monkeypatch, tmp_path):
    """A small Lexique TSV standing in for the download, with the wordlist directory
    both builders write into redirected to tmp_path (a run that wrongly went on must
    not reach the committed artifacts). Returns the TSV's path."""
    source = tmp_path / "fr.lexique.tsv"
    source.write_text(LEXIQUE, encoding="utf-8")
    monkeypatch.setattr(bw.red, "WORDLIST_DIR", str(tmp_path))
    monkeypatch.setattr(bw, "fetch", lambda url, dest, refresh: str(source))
    return source


def test_the_wordlist_build_refuses_a_lexique_that_is_not_the_pinned_file(
        lexique, tmp_path, capsys):
    with pytest.raises(SystemExit):
        bw.build("fr", skip_hunspell=True, refresh=False)
    err = capsys.readouterr().err
    assert "empreinte inattendue pour Lexique383.tsv" in err
    assert f"attendu {bw.LEXIQUE_SHA256}" in err
    assert [p.name for p in tmp_path.iterdir()] == ["fr.lexique.tsv"]   # nothing built


def test_the_wordlist_build_reads_the_lexique_its_digest_names(
        lexique, monkeypatch, tmp_path):
    monkeypatch.setattr(bw, "LEXIQUE_SHA256",
                        hashlib.sha256(lexique.read_bytes()).hexdigest())
    bw.build("fr", skip_hunspell=True, refresh=False)
    with gzip.open(tmp_path / "fr.txt.gz", "rt", encoding="utf-8") as f:
        # lowercased, accents kept, token rule applied, sorted
        assert f.read().split() == ["chevaux", "forêt"]


def test_the_forms_build_refuses_a_lexique_that_is_not_the_pinned_file(
        lexique, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(build_forms, "fetch_morphalou", lambda refresh: ("", "licence"))

    def build_rows_fr(csv_text, lexique_path):
        raise AssertionError("an unverified Lexique reached the build")

    monkeypatch.setattr(build_forms, "build_rows_fr", build_rows_fr)
    with pytest.raises(SystemExit):
        build_forms.build("fr", refresh=False)
    err = capsys.readouterr().err
    assert "empreinte inattendue pour Lexique383.tsv" in err
    assert f"attendu {bw.LEXIQUE_SHA256}" in err
    assert [p.name for p in tmp_path.iterdir()] == ["fr.lexique.tsv"]   # nothing built


def test_only_the_pinned_lexique_travels_over_plain_http():
    urls = []
    for sources in bw.SOURCES.values():
        for name, source in sources.items():
            if name == "hunspell":
                urls.extend(url for pair in source.values() for url in pair)
            else:
                urls.append(source)
    assert [url for url in urls if not url.startswith("https://")] == [
        bw.SOURCES["fr"]["lexique"]]
