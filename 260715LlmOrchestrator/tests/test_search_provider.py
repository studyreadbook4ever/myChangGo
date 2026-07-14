from __future__ import annotations

from llm_orchestrator.providers import DDGSSearchProvider, SearXNGSearchProvider


class FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self):
        return {
            "results": [
                {
                    "title": "운영체제 공식 문서",
                    "url": "https://example.test/os",
                    "content": "운영체제 설명",
                }
            ]
        }


class FakeClient:
    def __init__(self) -> None:
        self.get_calls = 0

    def get(self, *args, **kwargs):
        self.get_calls += 1
        return FakeResponse()


def test_searxng_provider_reuses_injected_client() -> None:
    client = FakeClient()
    provider = SearXNGSearchProvider("https://search.example.test", client=client)

    assert provider.search("운영체제", 4)[0].title == "운영체제 공식 문서"
    assert provider.search("프로세스", 4)[0].title == "운영체제 공식 문서"
    assert client.get_calls == 2


def test_ddgs_provider_passes_configured_timeout(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeDDGS:
        def __init__(self, **kwargs) -> None:
            calls.append(kwargs)

        def text(self, query: str, **kwargs):
            return [
                {
                    "title": query,
                    "href": "https://example.test/result",
                    "body": "검색 결과",
                }
            ]

    monkeypatch.setattr("llm_orchestrator.providers.search.DDGS", FakeDDGS)

    sources = DDGSSearchProvider(timeout=12.25).search("운영체제", 3)

    assert calls == [{"timeout": 13}]
    assert sources[0].url == "https://example.test/result"
