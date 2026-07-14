from __future__ import annotations

import socket

import pytest

from llm_orchestrator.models import Source
from llm_orchestrator.web import WebPageFetcher, _assert_public_http_url, _PinnedHTTPConnection


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1"])
def test_non_global_network_ranges_are_rejected(address: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 80))],
    )

    with pytest.raises(ValueError, match="전역 주소"):
        _assert_public_http_url("http://evidence.example/source")


def test_fetch_connection_is_pinned_to_the_validated_address(monkeypatch: pytest.MonkeyPatch) -> None:
    validated = "93.184.216.34"
    connected: list[tuple[str, int]] = []
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (validated, 80))],
    )

    def stop_after_capture(address, *args, **kwargs):
        connected.append(address)
        raise OSError("테스트 연결 중단")

    monkeypatch.setattr(socket, "create_connection", stop_after_capture)
    source = Source("S1", "근거", "http://evidence.example/source", snippet="검색 요약")

    with pytest.raises(OSError, match="테스트 연결 중단"):
        WebPageFetcher().fetch(source)

    assert connected == [(validated, 80)]


def test_pinned_connection_falls_back_across_validated_ipv6_and_ipv4(monkeypatch: pytest.MonkeyPatch) -> None:
    addresses = ["2606:4700:4700::1111", "93.184.216.34"]
    attempts: list[tuple[str, int]] = []
    connected_socket = object()

    def connect(address, *args, **kwargs):
        attempts.append(address)
        if address[0] == addresses[0]:
            raise OSError("IPv6 route 없음")
        return connected_socket

    monkeypatch.setattr(socket, "create_connection", connect)
    connection = _PinnedHTTPConnection("evidence.example", 80, addresses, 5.0)

    connection.connect()

    assert attempts == [(addresses[0], 80), (addresses[1], 80)]
    assert connection.sock is connected_socket
