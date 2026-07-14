from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urlunsplit

from .models import Source


class _ReadableTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "canvas"}:
            self._ignored_depth += 1
        elif not self._ignored_depth and tag in {"p", "br", "li", "h1", "h2", "h3", "h4", "tr", "blockquote"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "canvas"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif not self._ignored_depth and tag in {"p", "li", "h1", "h2", "h3", "h4", "tr", "blockquote"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            cleaned = " ".join(data.split())
            if cleaned:
                self.parts.append(cleaned + " ")

    def text(self) -> str:
        lines = [" ".join(line.split()) for line in "".join(self.parts).splitlines()]
        return "\n".join(line for line in lines if line)


def _resolve_public_http_url(url: str) -> tuple[str, int, list[str]]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("http/https 공개 URL만 가져올 수 있습니다.")
    try:
        default_port = 443 if parsed.scheme == "https" else 80
        port = parsed.port or default_port
        addresses = list(
            dict.fromkeys(item[4][0] for item in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM))
        )
    except (socket.gaierror, ValueError) as exc:
        raise ValueError("호스트 이름을 확인할 수 없습니다.") from exc
    if not addresses:
        raise ValueError("호스트 이름에서 IP 주소를 찾지 못했습니다.")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ValueError("공개 인터넷의 전역 주소만 웹 근거로 가져옵니다.")
    return parsed.hostname, port, addresses


def _assert_public_http_url(url: str) -> None:
    _resolve_public_http_url(url)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, addresses: list[str], timeout: float) -> None:
        self._pinned_addresses = addresses
        super().__init__(host, port=port, timeout=timeout)

    def connect(self) -> None:
        last_error: OSError | None = None
        for address in self._pinned_addresses:
            try:
                self.sock = socket.create_connection(
                    (address, self.port),
                    self.timeout,
                    self.source_address,
                )
                return
            except OSError as exc:
                last_error = exc
        raise last_error or OSError("검증된 IP 주소에 연결할 수 없습니다.")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, addresses: list[str], timeout: float) -> None:
        self._pinned_addresses = addresses
        super().__init__(host, port=port, timeout=timeout, context=ssl.create_default_context())

    def connect(self) -> None:
        last_error: OSError | None = None
        for address in self._pinned_addresses:
            raw_socket = None
            try:
                raw_socket = socket.create_connection(
                    (address, self.port),
                    self.timeout,
                    self.source_address,
                )
                self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)
                return
            except OSError as exc:
                last_error = exc
                if raw_socket is not None:
                    raw_socket.close()
        raise last_error or OSError("검증된 IP 주소에 TLS로 연결할 수 없습니다.")


class WebPageFetcher:
    def __init__(self, *, timeout: float = 20.0, max_bytes: int = 1_500_000, source_chars: int = 6_000) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.source_chars = source_chars

    def fetch(self, source: Source) -> Source:
        current_url = source.url
        source.public_url_validated = False
        for _ in range(4):
            parsed = urlparse(current_url)
            host, port, addresses = _resolve_public_http_url(current_url)
            source.public_url_validated = True
            connection_class = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
            connection = connection_class(host, port, addresses, self.timeout)
            path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
            try:
                connection.request(
                    "GET",
                    path,
                    headers={
                        "User-Agent": "llm-concept-orchestrator/0.1 (+educational-grounding)",
                        "Accept-Encoding": "identity",
                        "Connection": "close",
                    },
                )
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader("Location")
                    if not location:
                        break
                    source.public_url_validated = False
                    current_url = urljoin(current_url, location)
                    continue
                if response.status >= 400:
                    raise ValueError(f"웹 근거 요청이 HTTP {response.status}로 실패했습니다.")
                source.url = current_url
                content_type = (response.getheader("Content-Type") or "").lower()
                if not any(item in content_type for item in ("text/html", "text/plain", "application/xhtml+xml")):
                    return source
                chunks: list[bytes] = []
                total = 0
                while total < self.max_bytes:
                    chunk = response.read(min(65_536, self.max_bytes - total + 1))
                    if not chunk:
                        break
                    remaining = self.max_bytes - total
                    chunks.append(chunk[:remaining])
                    total += min(len(chunk), remaining)
                    if len(chunk) > remaining:
                        break
                raw = b"".join(chunks)
                encoding = response.headers.get_content_charset() or "utf-8"
                text = raw.decode(encoding, errors="replace")
                if "html" in content_type or "xhtml" in content_type:
                    parser = _ReadableTextParser()
                    parser.feed(text)
                    text = parser.text()
                source.content = text[: self.source_chars]
                return source
            finally:
                connection.close()
        return source

    def fetch_all(self, sources: list[Source], *, jobs: int = 4) -> list[Source]:
        def safe_fetch(source: Source) -> Source:
            try:
                return self.fetch(source)
            except (OSError, http.client.HTTPException, ssl.SSLError, ValueError, UnicodeError, LookupError):
                return source

        with ThreadPoolExecutor(max_workers=max(1, min(jobs, len(sources) or 1))) as pool:
            return list(pool.map(safe_fetch, sources))
