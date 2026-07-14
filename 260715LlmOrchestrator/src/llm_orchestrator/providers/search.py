from __future__ import annotations

import os
from dataclasses import dataclass, field
from math import ceil
from typing import Any
from urllib.parse import urlparse

import httpx
from ddgs import DDGS

from ..models import Source


def _sources_from_rows(rows: list[dict[str, Any]], limit: int) -> list[Source]:
    sources: list[Source] = []
    seen_urls: set[str] = set()
    for row in rows:
        url = str(row.get("url") or row.get("href") or "").strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or url in seen_urls:
            continue
        seen_urls.add(url)
        sources.append(
            Source(
                source_id=f"S{len(sources) + 1}",
                title=str(row.get("title") or url).strip(),
                url=url,
                snippet=str(row.get("description") or row.get("body") or row.get("content") or "").strip(),
            )
        )
        if len(sources) >= limit:
            break
    return sources


@dataclass(slots=True)
class DDGSSearchProvider:
    timeout: float = 30.0

    def preflight(self) -> None:
        return None

    def search(self, query: str, limit: int) -> list[Source]:
        rows = list(
            DDGS(timeout=max(1, ceil(self.timeout))).text(
                query,
                region="kr-kr",
                safesearch="moderate",
                max_results=limit,
            )
        )
        return _sources_from_rows(rows, limit)


@dataclass(slots=True)
class SearXNGSearchProvider:
    base_url: str
    timeout: float = 30.0
    client: httpx.Client | None = field(default=None, repr=False)
    _owns_client: bool = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._owns_client = self.client is None
        if self.client is None:
            self.client = httpx.Client(timeout=self.timeout, follow_redirects=True)

    def close(self) -> None:
        if self._owns_client and self.client is not None:
            self.client.close()

    def preflight(self) -> None:
        if not self.base_url:
            raise ValueError("SearXNG URL이 설정되지 않았습니다.")

    def search(self, query: str, limit: int) -> list[Source]:
        endpoint = self.base_url.rstrip("/") + "/search"
        assert self.client is not None
        response = self.client.get(
            endpoint,
            params={"q": query, "format": "json", "language": "ko-KR", "safesearch": 1},
        )
        response.raise_for_status()
        rows = response.json().get("results", [])
        return _sources_from_rows(rows, limit)


@dataclass(slots=True)
class BraveSearchProvider:
    api_key_env: str = "BRAVE_SEARCH_API_KEY"
    timeout: float = 30.0
    client: httpx.Client | None = field(default=None, repr=False)
    _owns_client: bool = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._owns_client = self.client is None
        if self.client is None:
            self.client = httpx.Client(timeout=self.timeout, follow_redirects=True)

    def close(self) -> None:
        if self._owns_client and self.client is not None:
            self.client.close()

    def preflight(self) -> None:
        if not os.environ.get(self.api_key_env):
            raise ValueError(f"환경 변수 {self.api_key_env}에 Brave Search API 키가 없습니다.")

    def search(self, query: str, limit: int) -> list[Source]:
        api_key = os.environ.get(self.api_key_env, "")
        assert self.client is not None
        response = self.client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": limit, "search_lang": "ko", "country": "KR"},
            headers={"Accept": "application/json", "X-Subscription-Token": api_key},
        )
        response.raise_for_status()
        rows = response.json().get("web", {}).get("results", [])
        return _sources_from_rows(rows, limit)


class MockSearchProvider:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def preflight(self) -> None:
        return None

    def search(self, query: str, limit: int) -> list[Source]:
        self.queries.append(query)
        return [
            Source(
                source_id="S1",
                title=f"{query} 데모 근거",
                url="https://example.com/demo-source",
                snippet=f"{query}에 관한 오프라인 파이프라인 검증용 근거입니다.",
                content=f"{query}에 관한 오프라인 파이프라인 검증용 근거입니다.",
                public_url_validated=True,
            )
        ][:limit]
