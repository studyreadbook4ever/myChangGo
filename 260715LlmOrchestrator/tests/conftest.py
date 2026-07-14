from __future__ import annotations

import socket
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from llm_orchestrator.config import BuildConfig  # noqa: E402


class OfflineFetcher:
    """검색 mock이 돌려준 본문을 네트워크 요청 없이 그대로 사용한다."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, int]] = []

    def fetch_all(self, sources: list[Any], *, jobs: int = 4) -> list[Any]:
        self.calls.append((len(sources), jobs))
        return sources


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("테스트 중 실제 네트워크 접근이 발생했습니다.")

    monkeypatch.setattr(httpx, "get", blocked)
    monkeypatch.setattr(httpx, "post", blocked)
    monkeypatch.setattr(httpx, "stream", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


@pytest.fixture
def config_factory(tmp_path: Path):
    base = BuildConfig(
        concept="운영체제",
        depth=1,
        output_dir=tmp_path / "site",
        work_dir=tmp_path / "work",
        llm_provider="mock",
        search_provider="mock",
        review_mode="off",
        jobs=1,
    )

    def factory(**changes: Any) -> BuildConfig:
        return replace(base, **changes)

    return factory
